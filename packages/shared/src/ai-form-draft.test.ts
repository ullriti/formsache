import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AI_DRAFT_CONDITION_TARGET,
  AI_DRAFT_INVALID_LEAD,
  AI_DRAFT_QUESTION_VARIANTS,
  adoptAiFormDraft,
  aiDraftAcceptsQuestionType,
  aiFormDraftSchema,
} from './ai-form-draft.ts';
import {
  allQuestions,
  formDefinitionSchema,
  questionTypeSchema,
  type FormDefinition,
} from './form-schema.ts';

/**
 * **The model's output is parsed, not believed**
 * (ADR-0015 no. 3 and no. 11).
 *
 * Every case below feeds a value that a language model could plausibly produce
 * and asks one question: *what comes out, and if it is a
 * refusal, does the refusal say what was wrong?* A test that only fed a good
 * document would measure nothing — the four „fast passend" answers are the
 * point, and each of them is one that reads perfectly reasonable until it is
 * parsed.
 *
 * **What is deliberately not here:** everything that needs a database or a
 * route. „Ohne Nacharbeit veröffentlichbar" is proven against the *real*
 * publish endpoint in `apps/api/test/ai/draft-publish.spec.ts`, because a
 * rebuilt check would only prove that two copies of one rule agree.
 */

/** A minter with a memory — so a test can say „diese ID war die zweite". */
function countingIds(): () => string {
  let minted = 0;
  return () => {
    minted += 1;
    return `019ff900-0000-7000-8000-${String(minted).padStart(12, '0')}`;
  };
}

const textQuestion = {
  type: 'text',
  label: 'Name',
  hint: null,
  required: true,
  width: 'full',
  minLength: null,
  maxLength: null,
  pattern: null,
};

const selectQuestion = {
  type: 'select',
  label: 'Anreise',
  hint: null,
  required: false,
  width: 'full',
  options: [
    { value: 'bahn', label: 'Bahn' },
    { value: 'auto', label: 'Auto' },
  ],
  allowOther: false,
  otherLabel: null,
};

const checkboxQuestion = {
  type: 'checkbox',
  label: 'Verpflegung',
  hint: null,
  required: false,
  width: 'full',
  options: [
    { value: 'vegetarisch', label: 'Vegetarisch' },
    { value: 'vegan', label: 'Vegan' },
  ],
  allowOther: false,
  otherLabel: null,
  minSelected: null,
  maxSelected: null,
};

const eventQuestion = {
  type: 'event',
  label: 'Programmpunkte',
  hint: null,
  required: false,
  width: 'full',
  events: [
    {
      key: 'abendessen',
      label: 'Abendessen',
      when: null,
      capacity: null,
      showRemaining: false,
    },
  ],
};

/** One page holding the given questions — the shape a model is asked for. */
function draftWith(questions: readonly unknown[]): unknown {
  return { pages: [{ title: 'Anmeldung', description: null, questions }] };
}

/**
 * The same object **minus** the named keys — a model that says nothing about a
 * setting rather than saying „nicht gesetzt".
 *
 * Built by subtraction from a complete fixture on purpose: a hand-written
 * partial object would be a second description of a question, and the case
 * would go on passing after the field it is about was renamed.
 */
function without(
  value: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !keys.includes(name)),
  );
}

function adopt(draft: unknown, newId: () => string = countingIds()) {
  return adoptAiFormDraft(draft, newId);
}

/** The definition of a successful adoption, or a failure naming the refusal. */
function accepted(draft: unknown, newId?: () => string): FormDefinition {
  const result = newId === undefined ? adopt(draft) : adopt(draft, newId);
  if (!result.ok) {
    throw new Error(
      `Expected this draft to be adopted, got ${result.refusal}: ${result.message}`,
    );
  }
  return result.definition;
}

/** The refusal of a rejected adoption, or a failure showing what got through. */
function refused(draft: unknown, newId?: () => string) {
  const result = newId === undefined ? adopt(draft) : adopt(draft, newId);
  if (result.ok) {
    throw new Error(
      `Expected this draft to be refused, got a form with ${String(
        allQuestions(result.definition).length,
      )} questions.`,
    );
  }
  return result;
}

describe('the derivation is guarded, not merely intended (ADR-0015 Nr. 3(c))', () => {
  /**
   * **The equality of no. 3(c).** A seventeenth question type that never
   * reached the derived form would leave the model unable to produce it, and a
   * superset check would stay green while it happened.
   */
  it('carries exactly as many variants as the shared question union', () => {
    expect(AI_DRAFT_QUESTION_VARIANTS).toBe(questionTypeSchema.options.length);
  });

  it('accepts every shared question type as a discriminator', () => {
    const accepted = questionTypeSchema.options.filter(
      aiDraftAcceptsQuestionType,
    );
    expect(accepted).toEqual([...questionTypeSchema.options]);
  });

  /**
   * The control for the case above: without it, a probe that answered `true`
   * for everything would satisfy the equality and prove nothing.
   */
  it('refuses a question type this application does not have', () => {
    expect(aiDraftAcceptsQuestionType('signature')).toBe(false);
    expect(aiDraftAcceptsQuestionType('')).toBe(false);
  });
});

describe('a model answer becomes a form', () => {
  it('adopts a plain two-question draft and mints every id itself', () => {
    const definition = accepted(draftWith([textQuestion, selectQuestion]));

    expect(definition.pages).toHaveLength(1);
    const questions = allQuestions(definition);
    expect(questions.map((question) => question.type)).toEqual([
      'text',
      'select',
    ]);
    // Every id is one of ours: the minter above hands out this prefix and the
    // draft carried none at all.
    const ids = [
      ...definition.pages.map((page) => page.id),
      ...questions.map((question) => question.id),
    ];
    expect(ids.every((id) => id.startsWith('019ff900-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * **„Modelle wiederholen sich"** — run the
   * other way round: the *same* answer is adopted twice and the two forms share
   * no id at all. Taking the model's ids over would make this list identical
   * rather than disjoint.
   */
  it('gives two adoptions of one answer disjoint ids', () => {
    const answer = draftWith([textQuestion, selectQuestion]);
    const first = accepted(answer, countingIds());
    const second = accepted(
      answer,
      (): string =>
        // A second, distinguishable minter — a real one is `randomUUID`.
        `019ffa00-0000-7000-8000-${String(Math.random()).slice(2, 14)}`,
    );

    const idsOf = (definition: FormDefinition): string[] => [
      ...definition.pages.map((page) => page.id),
      ...allQuestions(definition).map((question) => question.id),
    ];
    const overlap = idsOf(first).filter((id) => idsOf(second).includes(id));
    expect(overlap).toEqual([]);
  });

  /**
   * The disobedient model: it sends `id` anyway, and sends the **same** id
   * twice. Nothing collides, because the derived form has no `id` field and Zod
   * drops what it does not know — the „Filter, der es hinterher entfernt" of
   * ADR-0015 no. 3(a), for free.
   */
  it('drops ids the model sent, even when it repeated one', () => {
    const repeated = '019ffb00-0000-7000-8000-000000000001';
    const definition = accepted(
      draftWith([
        { ...textQuestion, id: repeated },
        { ...selectQuestion, id: repeated },
      ]),
    );

    const ids = allQuestions(definition).map((question) => question.id);
    expect(ids).not.toContain(repeated);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('an answer that almost fits is refused, and the refusal says why', () => {
  it('refuses an unknown question type and names the field', () => {
    const result = refused(
      draftWith([
        { ...textQuestion, type: 'signature', label: 'Unterschrift' },
      ]),
    );

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain(AI_DRAFT_INVALID_LEAD);
    expect(result.message).toContain('pages.0.questions.0.type');
  });

  it('refuses a choice question without options and names the list', () => {
    const result = refused(draftWith([{ ...selectQuestion, options: [] }]));

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('pages.0.questions.0.options');
    expect(result.message).toContain('Mindestens eine Option.');
  });

  /**
   * **The id collision, measured where it can still happen.** The model cannot
   * cause one (the case above), so this feeds a *defective minter* — and that
   * is what the case is worth: it shows the judge is actually run over the
   * document we assembled, rather than the assembly being trusted because we
   * did it ourselves.
   */
  it('refuses a document whose id assignment collided', () => {
    const result = refused(
      draftWith([textQuestion, selectQuestion]),
      () =>
        // Every call the same id — the shape a broken `newId` has.
        '019ffc00-0000-7000-8000-000000000001',
    );

    expect(result.refusal).toBe('definition');
    expect(result.message).toContain('Doppelte Frage-ID.');
  });

  /**
   * **A condition on a question that comes later.** The refusal is
   * `unresolvableConditionMessage` — the very sentence *Veröffentlichen*
   * answers with — so the editor reads one wording, not two.
   */
  it('refuses a condition pointing at a later question and names it', () => {
    const result = refused(
      draftWith([
        {
          ...textQuestion,
          label: 'Mitfahrgelegenheit',
          visibleIf: {
            operator: 'equals',
            value: 'bahn',
            [AI_DRAFT_CONDITION_TARGET]: 1,
          },
        },
        selectQuestion,
      ]),
    );

    expect(result.refusal).toBe('condition');
    expect(result.message).toContain('Mitfahrgelegenheit');
    expect(result.message).toContain('steht erst nach dieser Frage');
  });

  /**
   * **`visibleIf: null` means „keine Bedingung" and is accepted** — the most
   * expensive finding of the reliability measurement of 2026-08-12.
   *
   * The derived schema carried `visibleIf` as `.optional()`, that is *leave it
   * out or an object*. A model that writes a question without a condition as
   * `"visibleIf": null` got a shape-error refusal — and that is no hypothetical
   * spelling: measured over nine drafts of three models, **four out of five
   * failures were exactly this one**. For one of the three models it was *all*
   * attempts.
   *
   * The adoption run below it was prepared for that the whole time
   * (`if (!isRecord(visibleIf))` discards everything that is not an object) —
   * only the schema before it was not. So what was refused was something the
   * code would have handled correctly one line later anyway.
   *
   * *Counter-check:* make `.nullish()` an `.optional()` again → this case turns
   * red, and the measurement stood at 4 out of 9 instead of at 8 out of 9.
   */
  it.each([null, undefined])(
    'nimmt visibleIf %p als „keine Bedingung" an',
    (visibleIf) => {
      const definition = accepted(
        draftWith([{ ...textQuestion, visibleIf }, selectQuestion]),
      );
      const [first] = allQuestions(definition);
      expect(first?.label).toBe('Name');
      // Not passed through as `null`, but **gone** — in the form schema
      // `visibleIf` is the absence of a condition, not an empty value.
      expect(first).not.toHaveProperty('visibleIf');
    },
  );

  /** A position naming no question at all — reported as the missing source. */
  it('refuses a condition whose position names no question', () => {
    const result = refused(
      draftWith([
        selectQuestion,
        {
          ...textQuestion,
          label: 'Mitfahrgelegenheit',
          visibleIf: {
            operator: 'equals',
            value: 'bahn',
            [AI_DRAFT_CONDITION_TARGET]: 7,
          },
        },
      ]),
    );

    expect(result.refusal).toBe('condition');
    expect(result.message).toContain('Mitfahrgelegenheit');
    expect(result.message).toContain('fehlt in der neuen Fassung');
  });

  /**
   * **A refinement the derived form had to drop, caught by the judge.** This is
   * the class ADR-0015 no. 3(b) predicts will fire regularly, because the JSON
   * schema handed to the provider cannot carry it at all.
   */
  it('refuses a range whose ends cross', () => {
    const result = refused(
      draftWith([{ ...textQuestion, minLength: 40, maxLength: 5 }]),
    );

    expect(result.refusal).toBe('definition');
    expect(result.message).toContain('maxLength');
  });

  it('refuses an answer that is not a document at all', () => {
    expect(refused('Gerne! Hier ist dein Formular:').refusal).toBe('shape');
    expect(refused({ pages: [] }).refusal).toBe('shape');
    expect(refused(null).refusal).toBe('shape');
  });

  /**
   * **The one rule only step 1 owns** — and the reason this case exists at all.
   *
   * Measured while reproducing a review finding (2026-08-10): skipping
   * `aiFormDraftSchema` and handing the raw answer straight to the judge left
   * every other refusal in this file **still a refusal** — `formDefinitionSchema`
   * catches them a second time, and only the *kind* changes (`definition` where
   * `shape` was expected). Defence in depth, and good news.
   *
   * The title is the one thing that got **through**. It lives on the form
   * **record**, not in `formDefinitionSchema`, so the judge never sees it:
   * without step 1 a model's 5 000-character name would travel on to the create
   * route as a suggestion. `formTitleSchema` — the same rule that route applies
   * — bounds it in step 1, and this is what pins that.
   */
  it('refuses a title longer than the create route would accept', () => {
    const result = refused({
      ...(draftWith([textQuestion]) as Record<string, unknown>),
      title: 'K'.repeat(5_000),
    });

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('title');
  });
});

/**
 * **A missing key means „nicht gesetzt", not „ungültig"** — the second finding
 * of the same kind as `visibleIf` above, reported on 2026-08-14 with Mistral
 * Large.
 *
 * The editor read: *„Die Antwort des Modells ist kein gültiges Formular —
 * pages.0.questions.0.pattern: expected string, received undefined ·
 * pages.1.questions.0.allowOther: expected boolean, received undefined ·
 * minSelected … maxSelected …"* Every one of these fields is optional as a
 * matter of substance: `pattern: null` means „kein Muster", `allowOther: false`
 * means „kein Sonstiges". Only the spelling was not — `.nullable()` leaves the
 * *key* mandatory, and the JSON schema sent along is a hint and not a
 * constraint (`ai-form-json-schema.ts` deliberately switches `strict` off).
 *
 * One case per field named, and each of them leaves the key **out** instead of
 * setting it to `null`. *Counter-check:* remove `tolerantField` → every one of
 * these cases turns red, with exactly the message from the finding.
 */
describe('ein fehlender Schlüssel wird aufgefüllt, nicht abgelehnt', () => {
  it.each<[string, unknown]>([
    ['pattern', null],
    ['minLength', null],
    ['maxLength', null],
    ['hint', null],
    ['required', false],
  ])('nimmt eine Textfrage ohne „%s" an', (key, filled) => {
    const definition = accepted(draftWith([without(textQuestion, key)]));

    const [question] = allQuestions(definition);
    expect(question?.label).toBe('Name');
    expect(question).toHaveProperty(key, filled);
  });

  it.each<[string, unknown]>([
    ['allowOther', false],
    ['otherLabel', null],
  ])('nimmt eine Auswahlfrage ohne „%s" an', (key, filled) => {
    const definition = accepted(draftWith([without(selectQuestion, key)]));

    expect(allQuestions(definition)[0]).toHaveProperty(key, filled);
  });

  it.each<[string, unknown]>([
    ['minSelected', null],
    ['maxSelected', null],
  ])('nimmt eine Mehrfachauswahl ohne „%s" an', (key, filled) => {
    const definition = accepted(draftWith([without(checkboxQuestion, key)]));

    expect(allQuestions(definition)[0]).toHaveProperty(key, filled);
  });

  /** All at once — that is what the answer looked like that triggered the finding. */
  it('nimmt eine Frage an, die keines ihrer Feinstellungsfelder nennt', () => {
    const definition = accepted(
      draftWith([
        without(
          textQuestion,
          'pattern',
          'minLength',
          'maxLength',
          'hint',
          'required',
        ),
        without(
          checkboxQuestion,
          'allowOther',
          'otherLabel',
          'minSelected',
          'maxSelected',
          'hint',
          'required',
        ),
      ]),
    );

    expect(allQuestions(definition).map((question) => question.type)).toEqual([
      'text',
      'checkbox',
    ]);
  });

  /**
   * **One level deeper, and precisely for that reason the rule is a rule.** An
   * event carries `when` and `capacity` as `.nullable()` and `showRemaining` as
   * a switch; a model that writes only key and name would have lost the form
   * for the same reason. The case guards the descent of {@link tolerantField}
   * through lists and objects.
   */
  it('nimmt eine Veranstaltung an, die nur Kennung und Namen nennt', () => {
    const definition = accepted(
      draftWith([
        {
          ...eventQuestion,
          events: [{ key: 'abendessen', label: 'Abendessen' }],
        },
      ]),
    );

    expect(allQuestions(definition)[0]).toMatchObject({
      events: [
        {
          key: 'abendessen',
          label: 'Abendessen',
          when: null,
          capacity: null,
          showRemaining: false,
        },
      ],
    });
  });

  it('nimmt eine Seite ohne „description" an', () => {
    const definition = accepted({
      pages: [{ title: 'Anmeldung', questions: [textQuestion] }],
    });

    expect(definition.pages[0]?.description).toBeNull();
  });
});

/**
 * **The acceptance has become more tolerant, the result has not.**
 *
 * The counter-check to the block above, and without it that block proved
 * nothing: a derivation that forgives every missing field would also be one
 * that lets every piece of nonsense through. The third stage
 * (`formDefinitionSchema` and `findUnresolvableConditions`) judges the
 * **filled-in** document and judges as sharply as ever.
 */
describe('was auch nach dem Auffüllen kein Formular ist, wird abgelehnt', () => {
  /**
   * `label` has no spelling for „nicht gesetzt" — neither `null` nor `false` —
   * and therefore gets no default: an invented label would be invented
   * content.
   */
  it('refuses a question without a label', () => {
    const result = refused(draftWith([without(textQuestion, 'label')]));

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('pages.0.questions.0.label');
  });

  it('refuses a page without a title', () => {
    const result = refused({
      pages: [{ description: null, questions: [textQuestion] }],
    });

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('pages.0.title');
  });

  /**
   * **The filled-in default is judged along with it.** `allowOther` is
   * missing, becomes `false` — and precisely this `false` makes the question
   * unsatisfiable: five mandatory ticks over two options, without „Sonstiges"
   * as a third. The rule lives in stage 3, where it always lived.
   */
  it('refuses a checkbox demanding more ticks than it offers', () => {
    const result = refused(
      draftWith([
        {
          ...without(checkboxQuestion, 'allowOther', 'maxSelected'),
          minSelected: 5,
        },
      ]),
    );

    expect(result.refusal).toBe('definition');
    expect(result.message).toContain('Mehr Pflichtangaben als Optionen.');
  });

  /**
   * **A list's bounds have survived the rebuild.** {@link
   * tolerantField} does not build a list anew but clones it with one element
   * replaced — without that, `min(1)` and the check for duplicate keys would
   * have fallen out of the schema the model gets to see.
   */
  it('refuses an event question with an empty Veranstaltungsliste', () => {
    const result = refused(draftWith([{ ...eventQuestion, events: [] }]));

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('Mindestens eine Veranstaltung.');
  });

  it('refuses two Veranstaltungen sharing one key', () => {
    const result = refused(
      draftWith([
        {
          ...eventQuestion,
          events: [
            { key: 'abendessen', label: 'Abendessen' },
            { key: 'abendessen', label: 'Abendessen (zweiter Termin)' },
          ],
        },
      ]),
    );

    expect(result.refusal).toBe('shape');
    expect(result.message).toContain('Doppelte Veranstaltung.');
  });
});

/**
 * **The tolerance is a rule, not a maintained list of exceptions** — and that
 * is measured here rather than claimed.
 *
 * The finding came about because individual fields would have had to be
 * considered individually. This case asks the question from the other side: is
 * there still, in the **whole** shipped JSON schema, a *mandatory* field that
 * could express „nicht gesetzt" at all — that is, one that permits `null` or is
 * a switch? A seventeenth question type, one more `.nullable()` in a nested
 * list, a new switch: all of that turns red here, instead of turning up in
 * front of an editor as a refusal.
 */
describe('die Toleranz gilt dem ganzen Baum', () => {
  /** A node that could say „nicht gesetzt": `null` or a switch. */
  function couldSayNothing(node: unknown): boolean {
    if (typeof node !== 'object' || node === null) {
      return false;
    }
    const record = node as Record<string, unknown>;
    if (record.type === 'null' || record.type === 'boolean') {
      return true;
    }
    const branches = record.anyOf;
    return Array.isArray(branches) && branches.some(couldSayNothing);
  }

  function requiredFieldsThatCouldSayNothing(schema: unknown): string[] {
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object' || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      const required = record.required;
      const properties = record.properties;
      if (
        Array.isArray(required) &&
        typeof properties === 'object' &&
        properties !== null
      ) {
        const shape = properties as Record<string, unknown>;
        for (const name of required) {
          if (typeof name === 'string' && couldSayNothing(shape[name])) {
            found.add(name);
          }
        }
      }
      Object.values(record).forEach(walk);
    };
    walk(schema);
    return [...found];
  }

  /**
   * **The derivation must not tear apart the identity of shared sub-schemas**
   * — a finding from the review of this change, and it costs tokens on *every*
   * call.
   *
   * `z.toJSONSchema(…, { reused: 'ref' })` lifts a sub-schema into `$defs` when
   * it is **the same object** in several places. `optionsSchema` is a single
   * one that `select`, `radio` and `checkbox` share — a derivation that
   * rebuilds every field per call site makes three different ones out of it and
   * writes the 500-entry list out three times. Measured: 12 171 →
   * 13 115 bytes without the memoisation in `tolerantField`, 12 142 with it.
   */
  it('lässt die drei Auswahlfragen eine Optionsliste teilen', () => {
    const schema = z.toJSONSchema(aiFormDraftSchema, {
      io: 'input',
      reused: 'ref',
    });
    const lists = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== 'object' || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      const properties = record.properties as
        Record<string, unknown> | undefined;
      const type = properties?.type as { const?: unknown } | undefined;
      // `width` tells a **question** from a Tabellenspalte, which is a second
      // object carrying `type: 'select'` and an option list of its own.
      if (
        properties?.width !== undefined &&
        properties.options !== undefined &&
        typeof type?.const === 'string'
      ) {
        lists.add(JSON.stringify(properties.options));
      }
      Object.values(record).forEach(walk);
    };
    walk(schema);

    expect(lists.size).toBe(1);
    expect([...lists][0]).toContain('$ref');
  });

  it('verlangt kein Feld, das „nicht gesetzt" ausdrücken könnte', () => {
    // Rendered without `reused: 'ref'`, so that the walk below really sees
    // every node instead of stopping at a `$ref`. The assertion below it is
    // this case's precondition, not decoration.
    const schema = z.toJSONSchema(aiFormDraftSchema, { io: 'input' });
    expect(JSON.stringify(schema)).not.toContain('$ref');

    expect(requiredFieldsThatCouldSayNothing(schema)).toEqual([]);
  });

  /**
   * The control for it: the same walk over the **internal** form schema finds
   * exactly the fields of the finding. Without it the case above could be green
   * because the walk finds nothing — instead of because there is nothing to
   * find.
   */
  it('findet dieselben Felder im internen Schema, das sie verlangt', () => {
    const strict = z.toJSONSchema(formDefinitionSchema, { io: 'input' });

    expect(requiredFieldsThatCouldSayNothing(strict)).toEqual(
      expect.arrayContaining([
        'pattern',
        'allowOther',
        'minSelected',
        'maxSelected',
      ]),
    );
  });
});

describe('a condition on an earlier question survives', () => {
  it('resolves the position to the id that question was minted', () => {
    const definition = accepted(
      draftWith([
        selectQuestion,
        {
          ...textQuestion,
          label: 'Mitfahrgelegenheit',
          visibleIf: {
            operator: 'equals',
            value: 'bahn',
            [AI_DRAFT_CONDITION_TARGET]: 0,
          },
        },
      ]),
    );

    const [source, dependant] = allQuestions(definition);
    expect(source).toBeDefined();
    expect(dependant?.visibleIf).toEqual({
      operator: 'equals',
      value: 'bahn',
      questionId: source?.id,
    });
    // The position itself does not travel into the stored document.
    expect(JSON.stringify(definition).includes(AI_DRAFT_CONDITION_TARGET)).toBe(
      false,
    );
  });
});

describe('a model value stays a value (server half)', () => {
  /**
   * The web half of this check measures the **rendered** DOM. What is
   * provable here is the half that decides it: the label travels as a *string*
   * through the parse, byte for byte, and nothing in this path treats it as
   * markup or as a template.
   */
  it('carries a <script> in a question title through as text', () => {
    const hostile = '<script>alert("x")</script>';
    const definition = accepted(
      draftWith([{ ...textQuestion, label: hostile }]),
    );

    const [question] = allQuestions(definition);
    expect(question?.label).toBe(hostile);
    expect(typeof question?.label).toBe('string');
  });
});

describe('__proto__ does not survive the parse', () => {
  /**
   * ⚠️ **The check point a review of prototype-pollution safety left behind.** `model-json.ts` measured
   * that `"__proto__"` survives `JSON.parse` as an **own, enumerable** property
   * while the prototype stays clean; the open question was what the
   * `formSchema` parse does with it, because this application has an
   * inheritance merge (Tenant-Vorgabe ↔ `settings_override`) and a draft is the
   * first foreign object travelling towards one.
   *
   * **The answer has two halves, and the second one is the finding:** Zod
   * *drops* the key (it builds a fresh result out of the keys it knows), but
   * Zod's own strict mode does **not** report it as an unrecognised key. So
   * „abgeworfen" here means *not copied*, not *refused* — and anything that
   * ever wants a document refused for carrying it has to say so itself.
   */
  it('leaves no own __proto__ on the parsed draft, and no polluted prototype', () => {
    const answer: unknown = JSON.parse(
      `{"__proto__":{"polluted":"yes"},"pages":[{"title":"Seite 1","description":null,"questions":[]}]}`,
    );
    // The premise, measured rather than assumed.
    expect(Object.prototype.hasOwnProperty.call(answer, '__proto__')).toBe(
      true,
    );

    const parsed = aiFormDraftSchema.parse(answer);

    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(
      false,
    );
    expect(Object.keys(parsed)).toEqual(['pages']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).polluted).toBe(
      undefined,
    );
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });

  it('carries none of it into an adopted definition either', () => {
    const answer: unknown = JSON.parse(
      `{"pages":[{"title":"Seite 1","description":null,"questions":[{"__proto__":{"polluted":"yes"},"type":"text","label":"Name","hint":null,"required":true,"width":"full","minLength":null,"maxLength":null,"pattern":null}]}]}`,
    );

    const definition = accepted(answer);

    const [question] = allQuestions(definition);
    expect(question).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(question, '__proto__')).toBe(
      false,
    );
    expect(JSON.stringify(definition)).not.toContain('polluted');
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
  });
});
