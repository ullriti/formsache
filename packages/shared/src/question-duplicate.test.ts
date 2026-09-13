import { describe, expect, it } from 'vitest';

import type { FormDefinition, Question } from './form-schema.ts';
import {
  detachFormDefinition,
  detachQuestions,
  duplicateFormDefinition,
  duplicateQuestion,
  duplicateQuestions,
} from './question-duplicate.ts';

const base = {
  hint: null,
  required: false,
  width: 'full',
  minLength: null,
  maxLength: null,
  pattern: null,
} as const;

/** The fields every question type shares that these tests actually vary. */
interface QuestionExtras {
  readonly hint?: string | null;
  readonly replaces?: Question['replaces'];
  readonly visibleIf?: Question['visibleIf'];
}

function textQuestion(id: string, extra: QuestionExtras = {}): Question {
  return {
    ...base,
    id,
    type: 'text',
    label: `Frage ${id}`,
    ...extra,
  };
}

/**
 * A table, „ergänzbar" or not — „nicht ergänzbar" is spelled by leaving the
 * key out, never by writing `undefined` into it (`form-schema.ts`).
 */
function tableQuestion(id: string, addRows?: { maxRows: number }): Question {
  return {
    id,
    type: 'table',
    label: 'Begleitpersonen',
    hint: null,
    required: false,
    width: 'full',
    columns: [{ key: 'spalte-1', label: 'Name', type: 'text' }],
    rows: 1,
    ...(addRows === undefined ? {} : { addRows }),
  };
}

describe('duplicateQuestion', () => {
  it('gives the copy a new id and otherwise the same content', () => {
    const original = textQuestion('q-1', { hint: 'Hinweis' });
    const copy = duplicateQuestion(original, 'q-1-copy');

    expect(copy.id).toBe('q-1-copy');
    expect(copy).toStrictEqual({ ...original, id: 'q-1-copy' });
  });

  it('drops `replaces` — a duplicate did not retire anything', () => {
    const original = textQuestion('q-1', { replaces: 'q-0' });
    const copy = duplicateQuestion(original, 'q-1-copy');

    expect(copy).not.toHaveProperty('replaces');
  });

  /**
   * **The copy shares no nested array with the original** (a
   * review finding).
   *
   * *Measured on 2026-08-05:* `{ ...question, id }` delivered
   * `copy.options === original.options` as `true` — the same array, not
   * the same values. Without consequence as long as both callers write the copy straight into a
   * document and let go of it; the third one this function's docblock
   * names (inserting a template) sends it through a different
   * store, and there it becomes „I changed the copy and the original changed
   * with it" — reported as data loss, found nowhere near it.
   *
   * Identity **and** value are checked: `not.toBe` alone would let a copy
   * through that loses the array, `toStrictEqual` alone the shared one.
   */
  it('copies nested values instead of sharing them with the original', () => {
    const original = {
      id: 'q-3',
      type: 'select',
      label: 'Tracht',
      hint: null,
      required: false,
      width: 'full',
      allowOther: false,
      otherLabel: null,
      options: [
        { value: 'festlich', label: 'Festlich' },
        { value: 'zivil', label: 'Zivil' },
      ],
    } satisfies Question;

    const copy = duplicateQuestion(original, 'q-3-copy');

    if (copy.type !== 'select') {
      throw new Error('a duplicate keeps its type');
    }
    expect(copy.options).toStrictEqual(original.options);
    expect(copy.options).not.toBe(original.options);
    expect(copy.options[0]).not.toBe(original.options[0]);

    // And the check on what that means in practice: a change to the
    // copy does not reach the original.
    copy.options[0] = { value: 'frack', label: 'Frack' };
    expect(original.options[0]).toStrictEqual({
      value: 'festlich',
      label: 'Festlich',
    });
  });

  it('leaves a `visibleIf` pointing at an untouched source exactly as written', () => {
    const original = textQuestion('q-2', {
      visibleIf: { questionId: 'q-1', operator: 'filled' },
    });
    const copy = duplicateQuestion(original, 'q-2-copy');

    expect(copy.visibleIf).toStrictEqual({
      questionId: 'q-1',
      operator: 'filled',
    });
  });

  /**
   * „Zeilen ergänzbar" is copied, and its **absence** is copied too.
   *
   * `structuredClone` carries whatever the question holds, so the interesting
   * half is the second one: a copy that grew an `addRows` of its own would
   * hand every duplicate of a fixed table a „+ Zeile" its original never
   * offered, and `toStrictEqual` alone would not notice — it is
   * `Object.hasOwn` that tells „absent" from „present and undefined".
   */
  it('copies „Zeilen ergänzbar", and copies its absence', () => {
    const growing = tableQuestion('q-4', { maxRows: 6 });

    const copy = duplicateQuestion(growing, 'q-4-copy');
    if (copy.type !== 'table') {
      throw new Error('a duplicate keeps its type');
    }
    expect(copy.addRows).toStrictEqual({ maxRows: 6 });
    // A fresh object, like every other nested value above: lowering the
    // Obergrenze on the copy must not lower it on the original.
    expect(copy.addRows).not.toBe(
      growing.type === 'table' ? growing.addRows : undefined,
    );

    const fixedCopy = duplicateQuestion(tableQuestion('q-5'), 'q-5-copy');

    expect(Object.hasOwn(fixedCopy, 'addRows')).toBe(false);
  });
});

describe('duplicateQuestions', () => {
  it('maps every original id to a fresh one, in order', () => {
    const ids = ['a', 'b', 'c'];
    let counter = 0;
    const { questions, idMap } = duplicateQuestions(
      ids.map((id) => textQuestion(id)),
      () => `fresh-${String((counter += 1))}`,
    );

    expect(questions.map((question) => question.id)).toStrictEqual([
      'fresh-1',
      'fresh-2',
      'fresh-3',
    ]);
    expect(idMap.get('a')).toBe('fresh-1');
    expect(idMap.get('b')).toBe('fresh-2');
    expect(idMap.get('c')).toBe('fresh-3');
  });

  it('rewrites a condition whose source is duplicated in the same call', () => {
    const source = textQuestion('src');
    const dependant = textQuestion('dep', {
      visibleIf: { questionId: 'src', operator: 'filled' },
    });
    let counter = 0;
    const { questions } = duplicateQuestions(
      [source, dependant],
      () => `new-${String((counter += 1))}`,
    );

    const [newSource, newDependant] = questions;
    expect(newSource?.id).toBe('new-1');
    expect(newDependant?.visibleIf).toStrictEqual({
      questionId: 'new-1',
      operator: 'filled',
    });
  });

  it('leaves a condition pointing outside the duplicated set untouched — the id it names is not being renamed', () => {
    const dependant = textQuestion('dep', {
      visibleIf: { questionId: 'elsewhere', operator: 'filled' },
    });
    const { questions } = duplicateQuestions([dependant], () => 'new-dep');

    expect(questions[0]?.visibleIf).toStrictEqual({
      questionId: 'elsewhere',
      operator: 'filled',
    });
  });
});

describe('detachQuestions', () => {
  it('keeps a condition whose source travels with the block', () => {
    const source = textQuestion('src');
    const dependant = textQuestion('dep', {
      visibleIf: { questionId: 'src', operator: 'filled' },
    });

    const detached = detachQuestions([source, dependant]);

    expect(detached.map((question) => question.id)).toStrictEqual([
      'src',
      'dep',
    ]);
    expect(detached[1]?.visibleIf).toStrictEqual({
      questionId: 'src',
      operator: 'filled',
    });
  });

  it('drops a condition whose source stayed behind — it would be a dangling id in any other form', () => {
    const dependant = textQuestion('dep', {
      visibleIf: { questionId: 'on-another-page', operator: 'filled' },
    });

    const [detached] = detachQuestions([dependant]);

    expect(detached?.visibleIf).toBeUndefined();
  });

  it('leaves a single question without a condition, since a set of one has no source but itself', () => {
    const alone = textQuestion('alone', {
      visibleIf: { questionId: 'alone', operator: 'filled' },
    });

    const [detached] = detachQuestions([alone]);

    // Its own id *is* in the set, so this one is kept — a self-reference is a
    // defect of the source document, not something this function invents an
    // opinion about.
    expect(detached?.visibleIf).toStrictEqual({
      questionId: 'alone',
      operator: 'filled',
    });
  });

  it('keeps the ids — the fresh ones are minted when the Vorlage is inserted', () => {
    const [detached] = detachQuestions([textQuestion('q-1')]);

    expect(detached?.id).toBe('q-1');
  });

  /**
   * Follow-up to a review finding. `replaces` names a question of the **source
   * form** that a type change retired there; a stored template carrying it holds
   * a foreign id into a document it has no connection to, and `publishDiff`
   * would pair it with a question this block never touched.
   *
   * *Reproduction:* remove the `delete copy.replaces` in `detachQuestions` —
   * then the foreign id stands in the row again and this assertion turns red.
   * Before the fix it was: measured, `replaces` stood in the stored
   * page template, because only `duplicateQuestion` (the *insertion* side) dropped
   * the field.
   */
  it('drops `replaces` — a Vorlage holds no id of the form it was cut out of', () => {
    const retired = textQuestion('successor', { replaces: 'predecessor' });
    const alsoRetired = textQuestion('second', { replaces: 'older' });

    const detached = detachQuestions([retired, alsoRetired]);

    expect(detached.map((question) => question.replaces)).toStrictEqual([
      undefined,
      undefined,
    ]);
    // …and the key is **absent**, not occupied by `undefined`: JSONB
    // would otherwise store `{"replaces": null}` as a present key.
    expect(detached.every((question) => !('replaces' in question))).toBe(true);
  });

  it('copies nested values instead of sharing them with the original', () => {
    const original: Question = {
      id: 'choice',
      type: 'radio',
      label: 'Wahl',
      hint: null,
      required: false,
      width: 'full',
      options: [{ value: 'a', label: 'A' }],
      allowOther: false,
      otherLabel: null,
    };

    const [detached] = detachQuestions([original]);

    expect(detached).toStrictEqual(original);
    if (detached?.type !== 'radio') {
      throw new Error('expected a radio question');
    }
    expect(detached.options).not.toBe(original.options);
  });
});

/**
 * Follow-up to a review finding. `detachQuestions` ran only for `page` and
 * `question`; the `form` branch passed the definition through **unchanged**, and
 * so the one kind that carries a whole document was the one kind that kept the
 * foreign id.
 */
describe('detachFormDefinition', () => {
  const definition: FormDefinition = {
    pages: [
      {
        id: 'page-1',
        title: 'Seite 1',
        description: null,
        questions: [
          textQuestion('q-1'),
          textQuestion('q-2', {
            replaces: 'retired',
            visibleIf: { questionId: 'q-1', operator: 'filled' },
          }),
        ],
      },
      {
        id: 'page-2',
        title: 'Seite 2',
        description: null,
        questions: [
          textQuestion('q-3', {
            // The source is on page **one** — with a whole form it travels
            // along, so the condition stays standing.
            visibleIf: { questionId: 'q-1', operator: 'filled' },
          }),
        ],
      },
    ],
  };

  /**
   * *Reproduction:* replace `detachFormDefinition` with `definition` (the
   * state before the follow-up) → both assertions turn red.
   */
  it('drops `replaces` everywhere — a form Vorlage holds no id of its source either', () => {
    const detached = detachFormDefinition(definition);

    const questions = detached.pages.flatMap((page) => page.questions);
    expect(questions.map((question) => question.replaces)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(JSON.stringify(detached)).not.toContain('retired');
  });

  /**
   * The reason this function exists at all: calling `detachQuestions` per
   * page would judge every page on its own and would drop the
   * cross-page condition although its source travels along.
   *
   * *Reproduction:* `definition.pages.map((page) => detachQuestions(page.questions))`
   * → the first assertion turns red.
   */
  it('keeps a cross-page condition — in a whole form no source stays behind', () => {
    const detached = detachFormDefinition(definition);

    expect(detached.pages[1]?.questions[0]?.visibleIf).toStrictEqual({
      questionId: 'q-1',
      operator: 'filled',
    });
    expect(detached.pages[0]?.questions[1]?.visibleIf).toStrictEqual({
      questionId: 'q-1',
      operator: 'filled',
    });
  });

  it('keeps pages, order and ids — the fresh ids are minted when a form is made from it', () => {
    const detached = detachFormDefinition(definition);

    expect(detached.pages.map((page) => page.id)).toStrictEqual([
      'page-1',
      'page-2',
    ]);
    expect(
      detached.pages.map((page) => page.questions.map((q) => q.id)),
    ).toStrictEqual([['q-1', 'q-2'], ['q-3']]);
    // A copy, not a reference: the original keeps its `replaces`.
    expect(definition.pages[0]?.questions[1]?.replaces).toBe('retired');
  });
});

describe('duplicateFormDefinition', () => {
  const definition: FormDefinition = {
    pages: [
      {
        id: 'page-1',
        title: 'Seite 1',
        description: null,
        questions: [
          textQuestion('q-1'),
          textQuestion('q-2', {
            visibleIf: { questionId: 'q-1', operator: 'filled' },
          }),
        ],
      },
      {
        id: 'page-2',
        title: 'Seite 2',
        description: null,
        questions: [
          textQuestion('q-3', {
            // Points at a question of the *other* page — still inside this
            // same duplication, so it has to move too.
            visibleIf: { questionId: 'q-1', operator: 'filled' },
          }),
        ],
      },
    ],
  };

  it('gives every page and every question a fresh id, keeping page order and each page’s own questions', () => {
    let counter = 0;
    const { definition: copy, idMap } = duplicateFormDefinition(
      definition,
      () => `id-${String((counter += 1))}`,
    );

    expect(copy.pages).toHaveLength(2);
    expect(copy.pages[0]?.id).not.toBe('page-1');
    expect(copy.pages[1]?.id).not.toBe('page-2');
    expect(copy.pages[0]?.questions.map((q) => q.label)).toStrictEqual([
      'Frage q-1',
      'Frage q-2',
    ]);
    expect(copy.pages[1]?.questions.map((q) => q.label)).toStrictEqual([
      'Frage q-3',
    ]);

    const newIds = copy.pages.flatMap((page) =>
      page.questions.map((question) => question.id),
    );
    expect(new Set(newIds).size).toBe(3);
    expect(idMap.size).toBe(3);
  });

  it('rewrites a condition across page boundaries to the copy’s new id', () => {
    const { definition: copy, idMap } = duplicateFormDefinition(
      definition,
      (() => {
        let counter = 0;
        return () => `id-${String((counter += 1))}`;
      })(),
    );

    const newQ1Id = idMap.get('q-1');
    const q2 = copy.pages[0]?.questions[1];
    const q3 = copy.pages[1]?.questions[0];

    expect(q2?.visibleIf).toStrictEqual({
      questionId: newQ1Id,
      operator: 'filled',
    });
    expect(q3?.visibleIf).toStrictEqual({
      questionId: newQ1Id,
      operator: 'filled',
    });
  });

  it('never reuses an id the original document already had', () => {
    let counter = 0;
    const { definition: copy } = duplicateFormDefinition(
      definition,
      () => `id-${String((counter += 1))}`,
    );

    const originalIds = new Set(['page-1', 'page-2', 'q-1', 'q-2', 'q-3']);
    const copyIds = [
      ...copy.pages.map((page) => page.id),
      ...copy.pages.flatMap((page) =>
        page.questions.map((question) => question.id),
      ),
    ];
    for (const id of copyIds) {
      expect(originalIds.has(id)).toBe(false);
    }
  });
});
