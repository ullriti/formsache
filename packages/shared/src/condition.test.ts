import { describe, expect, it } from 'vitest';

import {
  findUnresolvableConditions,
  unresolvableConditionMessage,
  unresolvableConditionText,
  visibleQuestionIds,
  UNRESOLVABLE_CONDITION_LEAD,
  type UnresolvableCondition,
} from './condition.ts';
import {
  canBeConditionSource,
  conditionOperatorsFor,
  parseFormDefinition,
  questionTypeSchema,
  type ConditionOperator,
  type FormDefinition,
  type QuestionType,
} from './form-schema.ts';
import { publishDiff } from './form-history.ts';
import { safeParseAnswers } from './response-validation.ts';

/**
 * **Conditional display — the model and its evaluation** .
 *
 * The requirement „Unit-Tests über alle Operator/Typ-Paare" is meant literally
 * here: {@link CASES} is the complete table,
 * and the first test below holds it against {@link conditionOperatorsFor} — a
 * pair without a case makes the suite fail, a case without a pair likewise. A
 * seventeenth question type or an eighth operator thus does not get through
 * unchecked, and it does so at the place where a human has to decide.
 *
 * Measuring runs throughout via {@link visibleQuestionIds} instead of via
 * `evaluateCondition` — that is the function both surfaces call, and it
 * contains the three cases that are *no* evaluation (source missing, source
 * stands behind it, source itself hidden).
 */

const PAGE = '019ff500-0000-7000-8000-0000000000a0';
const SOURCE = '019ff500-0000-7000-8000-000000000001';
const DEPENDENT = '019ff500-0000-7000-8000-000000000002';
const THIRD = '019ff500-0000-7000-8000-000000000003';

function base(id: string, type: QuestionType) {
  return {
    id,
    type,
    label: `Frage ${type}`,
    hint: null,
    required: false,
    width: 'full',
  };
}

/**
 * One valid question per type — the source the table below measures against.
 *
 * `satisfies Record<QuestionType, …>`: a new question type goes missing here at
 * `pnpm typecheck`, not only on reading.
 */
const SOURCE_QUESTIONS = {
  text: {
    ...base(SOURCE, 'text'),
    minLength: null,
    maxLength: null,
    pattern: null,
  },
  textarea: { ...base(SOURCE, 'textarea'), minLength: null, maxLength: null },
  number: { ...base(SOURCE, 'number'), min: null, max: null, integer: false },
  date: { ...base(SOURCE, 'date'), minDate: null, maxDate: null },
  email: base(SOURCE, 'email'),
  phone: base(SOURCE, 'phone'),
  select: {
    ...base(SOURCE, 'select'),
    options: [
      { value: 'bahn', label: 'Bahn' },
      { value: 'auto', label: 'Auto' },
    ],
    allowOther: false,
    otherLabel: null,
  },
  radio: {
    ...base(SOURCE, 'radio'),
    options: [
      { value: 'bahn', label: 'Bahn' },
      { value: 'auto', label: 'Auto' },
    ],
    allowOther: false,
    otherLabel: null,
  },
  checkbox: {
    ...base(SOURCE, 'checkbox'),
    options: [
      { value: 'bahn', label: 'Bahn' },
      { value: 'auto', label: 'Auto' },
    ],
    allowOther: false,
    otherLabel: null,
    minSelected: null,
    maxSelected: null,
  },
  rating: { ...base(SOURCE, 'rating'), max: 5 },
  event: {
    ...base(SOURCE, 'event'),
    events: [
      {
        key: 'stadtfest',
        label: 'Stadtfest',
        when: null,
        capacity: null,
        showRemaining: false,
      },
      {
        key: 'umzug',
        label: 'Umzug',
        when: null,
        capacity: null,
        showRemaining: false,
      },
    ],
  },
  info: base(SOURCE, 'info'),
  file: { ...base(SOURCE, 'file'), maxFiles: 1 },
  table: {
    ...base(SOURCE, 'table'),
    columns: [{ key: 'name', label: 'Name', type: 'text' }],
    rows: 2,
  },
  matrix: {
    ...base(SOURCE, 'matrix'),
    rows: [{ value: 'organisation', label: 'Organisation' }],
    columns: [{ value: 'gut', label: 'Gut' }],
    multiple: false,
  },
  address: base(SOURCE, 'address'),
  // `object` and not a narrower shape: what is to be checked here is the
  // **completeness** of the keys (a new question type is missing), not the
  // shape of the questions — `parseFormDefinition` below checks that more
  // sharply than a type annotation could.
} as const satisfies Record<QuestionType, object>;

/** The dependent question — plain, so that only the condition is measured. */
function dependent(condition: unknown, required = false) {
  return {
    ...base(DEPENDENT, 'text'),
    required,
    minLength: null,
    maxLength: null,
    pattern: null,
    visibleIf: condition,
  };
}

function conditionOn(
  questionId: string,
  operator: ConditionOperator,
  value?: string | number,
): Record<string, unknown> {
  return operator === 'filled' || operator === 'empty'
    ? { questionId, operator }
    : { questionId, operator, value };
}

function formWith(
  type: QuestionType,
  operator: ConditionOperator,
  value?: string | number,
  required = false,
): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Seite',
        questions: [
          SOURCE_QUESTIONS[type],
          dependent(conditionOn(SOURCE, operator, value), required),
        ],
      },
    ],
  });
}

interface Sample {
  /** The condition's comparison value; `filled`/`empty` have none. */
  readonly value?: string | number;
  /** An answer under which the question **appears**. */
  readonly hit: unknown;
  /** An answer under which it **disappears**. */
  readonly miss: unknown;
}

const CHOICE_CASES: Partial<Record<ConditionOperator, Sample>> = {
  equals: {
    value: 'bahn',
    hit: { values: ['bahn'], other: null },
    miss: { values: ['auto'], other: null },
  },
  notEquals: {
    value: 'bahn',
    hit: { values: ['auto'], other: null },
    miss: { values: ['bahn'], other: null },
  },
  filled: {
    hit: { values: ['bahn'], other: null },
    miss: { values: [], other: null },
  },
  empty: {
    hit: { values: [], other: null },
    miss: { values: ['bahn'], other: null },
  },
};

const TEXT_CASES: Partial<Record<ConditionOperator, Sample>> = {
  equals: { value: 'Bahn', hit: 'Bahn', miss: 'Auto' },
  notEquals: { value: 'Bahn', hit: 'Auto', miss: 'Bahn' },
  filled: { hit: 'Bahn', miss: '   ' },
  empty: { hit: '', miss: 'Bahn' },
  contains: { value: 'bahn', hit: 'Mit der Bahn', miss: 'Mit dem Auto' },
};

const NUMBER_CASES: Partial<Record<ConditionOperator, Sample>> = {
  equals: { value: '3', hit: 3, miss: 4 },
  notEquals: { value: '3', hit: 4, miss: 3 },
  filled: { hit: 3, miss: null },
  empty: { hit: null, miss: 3 },
  greaterThan: { value: 3, hit: 4, miss: 3 },
  lessThan: { value: 3, hit: 2, miss: 3 },
};

/**
 * **The table** — per question type and operator one hit and one non-hit.
 *
 * The five excluded types carry an empty entry; that they *have to be* empty is
 * checked by the first test against {@link conditionOperatorsFor}.
 */
const CASES = {
  text: TEXT_CASES,
  textarea: TEXT_CASES,
  /**
   * **Condition value and answer in different casing** — and deliberately
   * so: the answer schema of an e-mail question is
   * `z.string().trim().toLowerCase()`, so the column carries the lower-case
   * spelling, no matter what was typed. As long as everything here stood
   * consistently in lower case, the difference between „roher Wert" and
   * „gespeicherter Wert" was invisible in the whole table — and exactly that
   * one cost an answer on unchanged editing (see `normalisedAnswer`).
   */
  email: {
    equals: {
      value: 'kanzlei@example.org',
      hit: 'Kanzlei@Example.org',
      miss: 'sonst@example.org',
    },
    notEquals: {
      value: 'kanzlei@example.org',
      hit: 'Sonst@Example.org',
      miss: 'Kanzlei@Example.org',
    },
    filled: { hit: 'kanzlei@example.org', miss: '' },
    empty: { hit: '', miss: 'kanzlei@example.org' },
    contains: {
      value: 'example.org',
      hit: 'Kanzlei@Example.org',
      miss: 'kanzlei@example.com',
    },
  },
  phone: {
    equals: { value: '030 123456', hit: '030 123456', miss: '030 654321' },
    notEquals: { value: '030 123456', hit: '030 654321', miss: '030 123456' },
    filled: { hit: '030 123456', miss: '' },
    empty: { hit: '', miss: '030 123456' },
    contains: { value: '030', hit: '030 123456', miss: '040 123456' },
  },
  date: {
    equals: { value: '2026-05-01', hit: '2026-05-01', miss: '2026-05-02' },
    notEquals: { value: '2026-05-01', hit: '2026-05-02', miss: '2026-05-01' },
    filled: { hit: '2026-05-01', miss: '' },
    empty: { hit: '', miss: '2026-05-01' },
  },
  number: NUMBER_CASES,
  rating: {
    equals: { value: '3', hit: 3, miss: 4 },
    notEquals: { value: '3', hit: 4, miss: 3 },
    filled: { hit: 3, miss: null },
    empty: { hit: null, miss: 3 },
    greaterThan: { value: 3, hit: 5, miss: 2 },
    lessThan: { value: 3, hit: 2, miss: 5 },
  },
  select: CHOICE_CASES,
  radio: CHOICE_CASES,
  checkbox: {
    ...CHOICE_CASES,
    // The case a single choice cannot pose: „ist gleich Bahn" also hits when
    // Auto is ticked **in addition**. A participant reads their own list that
    // way, and „nur Bahn und sonst nichts" would be an unusable operator on
    // the one type that can carry several things.
    equals: {
      value: 'bahn',
      hit: { values: ['bahn', 'auto'], other: null },
      miss: { values: ['auto'], other: null },
    },
  },
  event: {
    equals: {
      value: 'stadtfest',
      hit: { seats: { stadtfest: 2 } },
      miss: { seats: { umzug: 1 } },
    },
    notEquals: {
      value: 'stadtfest',
      hit: { seats: { umzug: 1 } },
      miss: { seats: { stadtfest: 2 } },
    },
    filled: { hit: { seats: { stadtfest: 2 } }, miss: { seats: {} } },
    empty: { hit: { seats: {} }, miss: { seats: { stadtfest: 2 } } },
  },
  info: {},
  file: {},
  table: {},
  matrix: {},
  address: {},
} as const satisfies Record<
  QuestionType,
  Partial<Record<ConditionOperator, Sample>>
>;

/** The visibility of the dependent question under exactly this answer. */
function dependentVisible(
  definition: FormDefinition,
  answer: unknown,
): boolean {
  return visibleQuestionIds(definition, { [SOURCE]: answer }).has(DEPENDENT);
}

describe('Welche Operatoren ein Quelltyp anbietet ', () => {
  /**
   * The exclusion list **word for word with the requirement**: `info`,
   * `file`, `table`, `matrix`, `address` are no sources. It stands here and
   * not in production code, because there it would be a second list beside the
   * operator table — and the one nobody maintains is the one that decides.
   */
  it('schließt genau die fünf Typen des Handoffs als Quelle aus', () => {
    const excluded = questionTypeSchema.options.filter(
      (type) => !canBeConditionSource(type),
    );

    expect([...excluded].sort()).toStrictEqual(
      ['address', 'file', 'info', 'matrix', 'table'].sort(),
    );
  });

  it('bietet „größer/kleiner als" nur bei Zahl- und Bewertungsquellen', () => {
    const withOrder = questionTypeSchema.options.filter((type) =>
      conditionOperatorsFor(type).includes('greaterThan'),
    );

    expect([...withOrder].sort()).toStrictEqual(['number', 'rating']);
    // „kleiner als" never runs separately from „größer als".
    expect(
      questionTypeSchema.options.filter((type) =>
        conditionOperatorsFor(type).includes('lessThan'),
      ),
    ).toStrictEqual(withOrder);
  });

  it('bietet „enthält" nur bei Freitext ohne Optionen', () => {
    const withContains = questionTypeSchema.options.filter((type) =>
      conditionOperatorsFor(type).includes('contains'),
    );

    expect([...withContains].sort()).toStrictEqual(
      ['email', 'phone', 'text', 'textarea'].sort(),
    );
  });

  it('bietet die vier Grundoperatoren bei jeder zulässigen Quelle', () => {
    for (const type of questionTypeSchema.options) {
      if (!canBeConditionSource(type)) {
        continue;
      }
      expect(conditionOperatorsFor(type)).toEqual(
        expect.arrayContaining(['equals', 'notEquals', 'filled', 'empty']),
      );
    }
  });

  /**
   * **The guard over the table below.** Without it „alle Paare" only proves
   * that the cases somebody wrote down are correct.
   */
  it('hat für jedes angebotene Paar einen Fall — und keinen Fall zu viel', () => {
    for (const type of questionTypeSchema.options) {
      const offered = [...conditionOperatorsFor(type)].sort();
      const covered = Object.keys(CASES[type]).sort();
      expect(covered, `Fälle für ${type}`).toStrictEqual(offered);
    }
  });
});

describe('Die Auswertung über alle Operator/Typ-Paare ', () => {
  for (const type of questionTypeSchema.options) {
    for (const [operator, sample] of Object.entries(CASES[type]) as [
      ConditionOperator,
      Sample,
    ][]) {
      it(`${type} · ${operator}: zeigt bei Treffer, verbirgt sonst`, () => {
        const definition = formWith(type, operator, sample.value);

        expect(dependentVisible(definition, sample.hit)).toBe(true);
        expect(dependentVisible(definition, sample.miss)).toBe(false);
      });
    }
  }

  it('vergleicht Zahlen als Zahlen, nicht als Zeichenketten', () => {
    // `'3.0'` from the builder's number field and the answer `3` are the same
    // number; a character comparison would say „ungleich" here.
    const definition = formWith('number', 'equals', '3.0');

    expect(dependentVisible(definition, 3)).toBe(true);
  });

  it('trifft mit „ist gleich" auch bei umgebenden Leerzeichen der Antwort', () => {
    const definition = formWith('text', 'equals', 'Bahn');

    expect(dependentVisible(definition, '  Bahn ')).toBe(true);
    expect(dependentVisible(definition, 'Bahnhof')).toBe(false);
  });

  it('achtet bei „ist gleich" auf Groß- und Kleinschreibung, bei „enthält" nicht', () => {
    expect(dependentVisible(formWith('text', 'equals', 'Bahn'), 'bahn')).toBe(
      false,
    );
    expect(
      dependentVisible(formWith('text', 'contains', 'BAHN'), 'mit der bahn'),
    ).toBe(true);
  });

  /**
   * „ist nicht" is the **strict** negation: as long as nothing is chosen, the
   * answer is not „Auto", and the dependent question is there.
   */
  it('zeigt „ist nicht" auch bei noch unbeantworteter Quelle', () => {
    const definition = formWith('select', 'notEquals', 'auto');

    expect(visibleQuestionIds(definition, {}).has(DEPENDENT)).toBe(true);
  });

  /**
   * „ist ausgefüllt" reads the same definition of „leer" as the required
   * check — including the case a separate check here would lose: a choice that
   * carries **only** a typed „Sonstiges".
   */
  it('zählt ein getipptes „Sonstiges" als ausgefüllt', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [
            {
              ...SOURCE_QUESTIONS.select,
              allowOther: true,
              otherLabel: 'Anders',
            },
            dependent(conditionOn(SOURCE, 'filled')),
          ],
        },
      ],
    });

    expect(
      dependentVisible(definition, { values: [], other: 'Mit dem Rad' }),
    ).toBe(true);
    expect(dependentVisible(definition, { values: [], other: '   ' })).toBe(
      false,
    );
  });

  it('bleibt über einer Antwort, die niemand aus dieser Anwendung geschrieben hat, ruhig', () => {
    const definition = formWith('number', 'greaterThan', 3);

    // Raw request body: number as a string, object instead of scalar, list.
    expect(dependentVisible(definition, '4')).toBe(false);
    expect(dependentVisible(definition, { seats: 4 })).toBe(false);
    expect(dependentVisible(definition, [4])).toBe(false);
  });
});

/**
 * **The visibility decides the value that lands in the column.**
 *
 * The write path normalises twice — `canonicalAnswerValue` and after that the
 * question's **field schema** —, and the evaluation read the raw value. That
 * made the same row give two answers: one on submitting, a different one on
 * sending the same row back unchanged, because the edit view prefills from the
 * *stored* value. The difference cost the dependent
 * answer.
 */
describe('Die Auswertung liest den gespeicherten Wert ', () => {
  it('blendet über die kleingeschriebene Fassung einer E-Mail ein', () => {
    // Answer schema of an e-mail question: `trim().toLowerCase()`. The value
    // the condition means is the one that gets stored.
    const definition = formWith('email', 'equals', 'kanzlei@example.org');

    const parsed = safeParseAnswers(definition, {
      [SOURCE]: 'Kanzlei@Example.org',
      [DEPENDENT]: 'Abholung 14:30',
    });

    expect(parsed.data).toStrictEqual({
      [SOURCE]: 'kanzlei@example.org',
      [DEPENDENT]: 'Abholung 14:30',
    });
  });

  /**
   * **An upper-case comparison value hits, instead of never hitting.**
   * The opposite direction of the finding: the stored side is *always* lower
   * case, so an editor typing „Kanzlei@Example.org" built a condition that
   * never fires — and nothing told them. `comparableValue` sends the
   * comparison value through the same normalisation as the answer.
   */
  it('vergleicht gleiches mit gleichem, auch wenn der Bearbeiter groß schreibt', () => {
    const definition = formWith('email', 'equals', 'Kanzlei@Example.org');

    const hit = safeParseAnswers(definition, {
      [SOURCE]: 'kanzlei@example.org',
      [DEPENDENT]: 'Abholung 14:30',
    });
    expect(hit.data).toStrictEqual({
      [SOURCE]: 'kanzlei@example.org',
      [DEPENDENT]: 'Abholung 14:30',
    });

    // And the counter-check stays a counter-check: a different address still
    // hides, the dependent question's value is discarded.
    const miss = safeParseAnswers(definition, {
      [SOURCE]: 'sonst@example.org',
      [DEPENDENT]: 'Abholung 14:30',
    });
    expect(miss.data).toStrictEqual({ [SOURCE]: 'sonst@example.org' });
  });

  /**
   * **Editing without any change loses nothing** — the property the fault was
   * measured against, and it holds regardless of how the editor wrote the
   * comparison value. The second round of the loop is the case from the
   * review: `equals 'Kanzlei@Example.org'` hit on submitting and no longer the
   * second time.
   */
  it('bewertet dieselbe Zeile beim zweiten Mal genauso', () => {
    for (const value of ['kanzlei@example.org', 'Kanzlei@Example.org']) {
      const definition = formWith('email', 'equals', value);

      const first = safeParseAnswers(definition, {
        [SOURCE]: 'Kanzlei@Example.org',
        [DEPENDENT]: 'Abholung 14:30',
      });
      expect(first.success).toBe(true);
      const again = safeParseAnswers(definition, first.data);

      expect(again.data, `Bedingungswert „${value}"`).toStrictEqual(first.data);
    }
  });

  /**
   * „ist ausgefüllt" went past the canonicalisation until then: it asked
   * `isBlankAnswer` over the raw value, and `{seats: {stadtfest: 0}}` — the
   * state of a fill-in form in which somebody leaves the 0 standing — is a
   * second spelling of „nicht angemeldet". Visible over the draft state,
   * hidden over the checked one: the same contradiction, one question
   * further on.
   */
  it('liest „ausgefüllt"/„leer" über die kanonische Fassung der Antwort', () => {
    const zero = { seats: { stadtfest: 0 } };

    expect(dependentVisible(formWith('event', 'filled'), zero)).toBe(false);
    expect(dependentVisible(formWith('event', 'empty'), zero)).toBe(true);
    // The counter-check: a real registration stays „ausgefüllt".
    expect(
      dependentVisible(formWith('event', 'filled'), {
        seats: { stadtfest: 2 },
      }),
    ).toBe(true);
  });

  it('bleibt auch hier über einem unparsbaren Wert ruhig', () => {
    // The half-finished state of the fill-in view and the foreign body: none
    // of it parses against the field schema, and none of it may throw.
    const definition = formWith('email', 'filled');

    expect(dependentVisible(definition, 'kanzlei@')).toBe(true);
    expect(dependentVisible(definition, 42)).toBe(true);
    expect(dependentVisible(definition, '')).toBe(false);
  });
});

describe('Was keine Auswertung ist ', () => {
  function twoConditions(first: unknown, second: unknown): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [
            SOURCE_QUESTIONS.select,
            dependent(first),
            {
              ...base(THIRD, 'text'),
              minLength: null,
              maxLength: null,
              pattern: null,
              visibleIf: second,
            },
          ],
        },
      ],
    });
  }

  it('zeigt eine Frage ohne Bedingung', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [SOURCE_QUESTIONS.select, dependent(undefined)],
        },
      ],
    });

    expect(visibleQuestionIds(definition, {}).has(DEPENDENT)).toBe(true);
  });

  /**
   * **Fail open**, and in both directions of these three cases: a condition
   * that is not evaluable hides **nothing**. Hiding would remove a — possibly
   * required — question from a running form, without anything about it
   * standing anywhere.
   */
  it.each([
    [
      'auf eine Frage, die es nicht gibt',
      '019ff500-0000-7000-8000-0000000000ff',
    ],
    ['auf sich selbst', DEPENDENT],
    ['auf eine spätere Frage', THIRD],
  ])('zeigt eine Bedingung, die %s zeigt', (_name, questionId) => {
    const definition = twoConditions(
      conditionOn(questionId, 'equals', 'bahn'),
      undefined,
    );

    expect(visibleQuestionIds(definition, {}).has(DEPENDENT)).toBe(true);
  });

  it('zeigt eine Bedingung, deren Operator es für diesen Quelltyp nicht gibt', () => {
    // „enthält" on a choice question: structurally possible, not offered by
    // the domain — and therefore no evaluation, but the open case.
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [
            SOURCE_QUESTIONS.select,
            dependent(conditionOn(SOURCE, 'contains', 'bahn')),
          ],
        },
      ],
    });

    expect(
      dependentVisible(definition, { values: ['auto'], other: null }),
    ).toBe(true);
  });

  /**
   * The chain: if the source is itself hidden, the dependent question is too
   * — **regardless of the operator**. „ist leer" over a question that was put
   * to nobody is true and says nothing.
   */
  it('verbirgt eine Frage, deren Quelle selbst ausgeblendet ist', () => {
    const definition = twoConditions(
      conditionOn(SOURCE, 'equals', 'bahn'),
      conditionOn(DEPENDENT, 'empty'),
    );

    const visible = visibleQuestionIds(definition, {
      [SOURCE]: { values: ['auto'], other: null },
    });

    expect(visible.has(DEPENDENT)).toBe(false);
    expect(visible.has(THIRD)).toBe(false);
  });

  it('zeigt die Kette wieder, sobald die Quelle erscheint', () => {
    const definition = twoConditions(
      conditionOn(SOURCE, 'equals', 'bahn'),
      conditionOn(DEPENDENT, 'empty'),
    );

    const visible = visibleQuestionIds(definition, {
      [SOURCE]: { values: ['bahn'], other: null },
    });

    expect(visible.has(DEPENDENT)).toBe(true);
    expect(visible.has(THIRD)).toBe(true);
  });

  it('löst eine Quelle auf einer früheren Seite auf', () => {
    const definition = parseFormDefinition({
      pages: [
        { id: PAGE, title: 'Seite 1', questions: [SOURCE_QUESTIONS.select] },
        {
          id: '019ff500-0000-7000-8000-0000000000a1',
          title: 'Seite 2',
          questions: [dependent(conditionOn(SOURCE, 'equals', 'bahn'))],
        },
      ],
    });

    expect(
      dependentVisible(definition, { values: ['bahn'], other: null }),
    ).toBe(true);
    expect(
      dependentVisible(definition, { values: ['auto'], other: null }),
    ).toBe(false);
  });
});

describe('Das Bedingungs-Dokument selbst ', () => {
  function parses(condition: unknown): boolean {
    try {
      parseFormDefinition({
        pages: [
          {
            id: PAGE,
            title: 'Seite',
            questions: [SOURCE_QUESTIONS.text, dependent(condition)],
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  it('nimmt „ist ausgefüllt" ohne Wert an', () => {
    expect(parses({ questionId: SOURCE, operator: 'filled' })).toBe(true);
  });

  it('weist „ist gleich" ohne Wert und mit leerem Wert ab', () => {
    expect(parses({ questionId: SOURCE, operator: 'equals' })).toBe(false);
    expect(parses({ questionId: SOURCE, operator: 'equals', value: '' })).toBe(
      false,
    );
  });

  /**
   * **The second spelling of „leer".** `' '` passes a bare
   * `min(1)`, and the condition that comes out of it is „ist leer" under
   * another name: over a text source it hits the answer `''` (both
   * sides are compared after they have been trimmed), over a
   * number source the answer `0` (`Number(' ')` is `0`).
   */
  it('weist „ist gleich" mit reinem Leerraum ab', () => {
    expect(parses({ questionId: SOURCE, operator: 'equals', value: ' ' })).toBe(
      false,
    );
    expect(
      parses({ questionId: SOURCE, operator: 'contains', value: '   ' }),
    ).toBe(false);
  });

  it('speichert den Vergleichswert getrimmt, statt zwei Bedingungen daraus zu machen', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [
            SOURCE_QUESTIONS.text,
            dependent(conditionOn(SOURCE, 'equals', ' Bahn ')),
          ],
        },
      ],
    });

    expect(definition.pages[0]?.questions[1]?.visibleIf).toStrictEqual({
      questionId: SOURCE,
      operator: 'equals',
      value: 'Bahn',
    });
  });

  it('weist „größer als" mit einem Text ab', () => {
    expect(
      parses({ questionId: SOURCE, operator: 'greaterThan', value: 'drei' }),
    ).toBe(false);
    expect(
      parses({ questionId: SOURCE, operator: 'greaterThan', value: 3 }),
    ).toBe(true);
  });

  it('weist einen unbekannten Operator ab', () => {
    expect(
      parses({ questionId: SOURCE, operator: 'startsWith', value: 'B' }),
    ).toBe(false);
  });

  it('lässt eine Frage ohne Bedingung wie bisher parsen', () => {
    expect(parses(undefined)).toBe(true);
  });
});

/**
 * **The place at which conditional logic gets dangerous.**
 *
 * Both directions, each its own case: without the condition checked, a form
 * with a hidden required field cannot be submitted; checked the wrong way
 * round, every requirement can be evaded by hiding. The third case measures the
 * **content** of the result, not the message.
 */
describe('Pflicht und Sichtbarkeit ', () => {
  const hiddenRequired = () => formWith('select', 'equals', 'bahn', true);

  it('lässt eine ausgeblendete Pflichtfrage durch', () => {
    const result = safeParseAnswers(hiddenRequired(), {
      [SOURCE]: { values: ['auto'], other: null },
    });

    expect(result.success).toBe(true);
  });

  it('besteht auf einer eingeblendeten Pflichtfrage', () => {
    const result = safeParseAnswers(hiddenRequired(), {
      [SOURCE]: { values: ['bahn'], other: null },
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => issue.path.join('.')),
    ).toStrictEqual([DEPENDENT]);
  });

  it('verwirft den Wert einer ausgeblendeten Frage, statt ihn zu übernehmen', () => {
    const result = safeParseAnswers(hiddenRequired(), {
      [SOURCE]: { values: ['auto'], other: null },
      [DEPENDENT]: 'Diese Frage stand nie auf dem Bildschirm',
    });

    expect(result.success).toBe(true);
    // The content, not the message: **no key** for the hidden question —
    // otherwise the answers table would hold a value in a column this
    // participant never saw.
    expect(result.data).toStrictEqual({
      [SOURCE]: { values: ['auto'], other: null },
    });
  });

  it('behält den Wert, sobald die Frage eingeblendet ist', () => {
    const result = safeParseAnswers(hiddenRequired(), {
      [SOURCE]: { values: ['bahn'], other: null },
      [DEPENDENT]: 'Sichtbar beantwortet',
    });

    expect(result.data).toStrictEqual({
      [SOURCE]: { values: ['bahn'], other: null },
      [DEPENDENT]: 'Sichtbar beantwortet',
    });
  });

  /**
   * „Frage gibt es nicht" and „Frage war ausgeblendet" stay two different
   * answers — otherwise the discarding would be a hole through which any key
   * whatsoever quietly disappears.
   */
  it('weist einen Schlüssel ab, den dieses Formular gar nicht kennt', () => {
    const result = safeParseAnswers(hiddenRequired(), {
      [SOURCE]: { values: ['auto'], other: null },
      '019ff500-0000-7000-8000-0000000000fe': 'fremd',
    });

    expect(result.success).toBe(false);
  });

  it('weist einen Wert für einen ausgeblendeten Infotext ab, statt ihn zu verwerfen', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite',
          questions: [
            SOURCE_QUESTIONS.select,
            {
              ...base(DEPENDENT, 'info'),
              visibleIf: conditionOn(SOURCE, 'equals', 'bahn'),
            },
          ],
        },
      ],
    });

    const result = safeParseAnswers(definition, {
      [SOURCE]: { values: ['auto'], other: null },
      [DEPENDENT]: 'gelesen',
    });

    expect(result.success).toBe(false);
  });
});

/**
 * **A condition that points into the void blocks
 * publishing.**
 *
 * What is measured here is the *finding*; that it actually refuses publishing
 * is measured by `apps/api/test/forms/condition-publish-lock.spec.ts`
 * at the endpoint.
 *
 * The pitfall stands in it as a case of its own: on a
 * **type change** the builder hands out a new id, and `publishDiff()` *pairs*
 * the two into one row — the predecessor id **never** appears there under
 * `removed`. The case does not claim that, it measures it, right next to the
 * finding the same version produces.
 */
describe('Eine Bedingung, die ins Leere zeigt ', () => {
  /** The successor of a type-changed source — new id, no. 24. */
  const RETYPED = '019ff500-0000-7000-8000-0000000000b1';

  function anreise(overrides: object = {}) {
    return { ...SOURCE_QUESTIONS.select, label: 'Anreise', ...overrides };
  }

  /** The dependent question, with a name a message can name. */
  function mitfahren(condition: unknown) {
    return { ...dependent(condition), label: 'Mitfahrgelegenheit' };
  }

  function form(questions: readonly unknown[]): FormDefinition {
    return parseFormDefinition({
      pages: [{ id: PAGE, title: 'Seite', questions }],
    });
  }

  /** The version in force: source first, dependent question behind it. */
  const published = form([
    anreise(),
    mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
  ]);

  function findings(draft: FormDefinition): UnresolvableCondition[] {
    return findUnresolvableConditions({ draft, published });
  }

  it('findet nichts, solange die Quelle vor der abhängigen Frage steht', () => {
    // The control: without it every finding below would be green even if the
    // lock simply refused every form with a condition.
    expect(findings(published)).toStrictEqual([]);
  });

  it('nennt die abhängige Frage, wenn die Quelle entfernt wird ', () => {
    const draft = form([mitfahren(conditionOn(SOURCE, 'equals', 'bahn'))]);

    expect(findings(draft)).toStrictEqual([
      {
        questionId: DEPENDENT,
        questionLabel: 'Mitfahrgelegenheit',
        sourceId: SOURCE,
        // From the version in force — the draft no longer knows the question,
        // and a bare id is exact, but not readable.
        sourceLabel: 'Anreise',
        defect: 'missing',
      },
    ]);
  });

  /**
   * **The pitfall, in two assertions.** The first is the trap: the diff does
   * *not* report the predecessor id as removed. The second is the finding
   * there is nevertheless. A lock on `publishDiff().removed` would be quietly
   * green here.
   */
  it('findet den Typwechsel, den der Diff als eine Zeile paart ', () => {
    const draft = form([
      {
        ...base(RETYPED, 'text'),
        label: 'Anreise',
        minLength: null,
        maxLength: null,
        pattern: null,
        replaces: SOURCE,
      },
      mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
    ]);

    const diff = publishDiff(published, draft);
    expect(diff.removed.map((question) => question.id)).toStrictEqual([]);
    // Paired into **one** row, and that one carries the *successor's* id: the
    // predecessor id the condition points at does not occur in the whole diff.
    // A lock that asks it cannot find this case.
    expect(diff.typeChanged.map((change) => change.id)).toStrictEqual([
      RETYPED,
    ]);
    expect(JSON.stringify(diff)).not.toContain(SOURCE);

    expect(findings(draft)).toStrictEqual([
      {
        questionId: DEPENDENT,
        questionLabel: 'Mitfahrgelegenheit',
        sourceId: SOURCE,
        sourceLabel: 'Anreise',
        defect: 'missing',
      },
    ]);
  });

  it('findet die Quelle, die hinter die abhängige Frage rutscht ', () => {
    const draft = form([
      mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
      anreise(),
    ]);

    expect(findings(draft)).toStrictEqual([
      {
        questionId: DEPENDENT,
        questionLabel: 'Mitfahrgelegenheit',
        sourceId: SOURCE,
        sourceLabel: 'Anreise',
        defect: 'later',
      },
    ]);
  });

  it('findet die Quelle auch dann, wenn sie eine Seite weiter hinten steht', () => {
    // The same rule across page boundaries: „vorherige Frage" is the order of
    // the document, not the one within a page.
    const draft = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite 1',
          questions: [mitfahren(conditionOn(SOURCE, 'equals', 'bahn'))],
        },
        {
          id: '019ff500-0000-7000-8000-0000000000a1',
          title: 'Seite 2',
          questions: [anreise()],
        },
      ],
    });

    expect(findings(draft).map((finding) => finding.defect)).toStrictEqual([
      'later',
    ]);
  });

  it('findet eine Bedingung, die auf ihre eigene Frage zeigt', () => {
    const draft = form([
      anreise(),
      mitfahren(conditionOn(DEPENDENT, 'equals', 'bahn')),
    ]);

    expect(findings(draft).map((finding) => finding.defect)).toStrictEqual([
      'self',
    ]);
  });

  it('findet einen Operator, den der Quelltyp nicht anbietet', () => {
    // „enthält" on a choice question. The draft parses — the operator/type
    // mapping does not stand in the document schema, but here.
    const draft = form([
      anreise(),
      mitfahren(conditionOn(SOURCE, 'contains', 'bahn')),
    ]);

    expect(findings(draft).map((finding) => finding.defect)).toStrictEqual([
      'operator',
    ]);
  });

  it('lässt das Umbenennen der Quelle frei', () => {
    // What is bound is the id, not the label — otherwise every rewording in
    // the builder would be a ban on publishing.
    const draft = form([
      anreise({ label: 'Wie reisen Sie an?' }),
      mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
    ]);

    expect(findings(draft)).toStrictEqual([]);
  });

  it('lässt eine Frage verschwinden, auf die keine Bedingung zeigt', () => {
    // The counter-check to the first one: a lock that strikes here is a lock
    // on publishing and not on conditions that point into the
    // void.
    const draft = form([
      anreise(),
      mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
      {
        ...base(THIRD, 'text'),
        minLength: null,
        maxLength: null,
        pattern: null,
      },
    ]);

    expect(findings(draft)).toStrictEqual([]);
  });

  it('meldet jede betroffene Frage, nicht nur die erste', () => {
    const draft = form([
      mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
      {
        ...base(THIRD, 'text'),
        label: 'Anzahl Plätze',
        minLength: null,
        maxLength: null,
        pattern: null,
        visibleIf: conditionOn(SOURCE, 'filled'),
      },
    ]);

    expect(findings(draft).map((finding) => finding.questionId)).toStrictEqual([
      DEPENDENT,
      THIRD,
    ]);
  });

  it('kennt die Quelle nicht, wenn auch die Fassung in Kraft sie nicht kennt', () => {
    // The first publishing: there is no version a label could come from. The
    // finding remains, only unnamed — it must not fail on a missing
    // name.
    const draft = form([mitfahren(conditionOn(SOURCE, 'equals', 'bahn'))]);

    expect(
      findUnresolvableConditions({ draft, published: null }),
    ).toStrictEqual([
      {
        questionId: DEPENDENT,
        questionLabel: 'Mitfahrgelegenheit',
        sourceId: SOURCE,
        sourceLabel: null,
        defect: 'missing',
      },
    ]);
  });

  describe('Die Meldung', () => {
    it('benennt die betroffene Frage und die Quelle', () => {
      const draft = form([mitfahren(conditionOn(SOURCE, 'equals', 'bahn'))]);
      const message = unresolvableConditionMessage(findings(draft));

      expect(message).toContain('Mitfahrgelegenheit');
      expect(message).toContain('Anreise');
      // The type change stands in it expressly: afterwards the source lies on
      // the surface under its old label, and the message would read
      // as plainly wrong without that half-sentence.
      expect(message).toContain('Typwechsel');
    });

    it('sagt bei der verschobenen Quelle, dass sie zu spät steht', () => {
      const draft = form([
        mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
        anreise(),
      ]);
      const message = unresolvableConditionMessage(findings(draft));

      expect(message).toContain('Mitfahrgelegenheit');
      expect(message).toContain('steht erst nach dieser Frage');
      // …and **not** the reason of the other case: a message that carried
      // both sentences does not tell the editor what to do.
      expect(message).not.toContain('Typwechsel');
    });

    it('nennt jede betroffene Frage einzeln', () => {
      const draft = form([
        mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
        {
          ...base(THIRD, 'text'),
          label: 'Anzahl Plätze',
          minLength: null,
          maxLength: null,
          pattern: null,
          visibleIf: conditionOn(SOURCE, 'filled'),
        },
      ]);
      const message = unresolvableConditionMessage(findings(draft));

      expect(message).toContain('Mitfahrgelegenheit');
      expect(message).toContain('Anzahl Plätze');
    });

    /**
     * **The sentence per finding is the same one the message carries.**
     *
     * By now the preview dialog reads {@link unresolvableConditionText}
     * individually, while the 422 sends {@link unresolvableConditionMessage}.
     * That is exactly the assurance „derselbe Text, den die 422 nennt", and
     * here it is mechanical: the message **contains** every single sentence
     * verbatim.
     *
     * What the application would have to get wrong for these lines to turn red:
     * phrasing the message itself again (instead of building it from the two
     * pieces) — then a single quotation mark already deviates and the test
     * breaks, before the deviation passes as „gleicher Sinn".
     */
    it('trägt den Einzelsatz jedes Befunds wörtlich', () => {
      const draft = form([
        mitfahren(conditionOn(SOURCE, 'equals', 'bahn')),
        {
          ...base(THIRD, 'text'),
          label: 'Anzahl Plätze',
          minLength: null,
          maxLength: null,
          pattern: null,
          visibleIf: conditionOn(SOURCE, 'filled'),
        },
      ]);
      const found = findings(draft);
      const message = unresolvableConditionMessage(found);

      expect(found).toHaveLength(2);
      for (const finding of found) {
        const text = unresolvableConditionText(finding);
        // No empty sentence: `toContain('')` would be true for every message.
        expect(text).toContain(finding.questionLabel);
        expect(message).toContain(text);
      }

      // The explanation stands **once** in front, not per finding — otherwise
      // the dialog reads it twice below one another.
      expect(message).toContain(UNRESOLVABLE_CONDITION_LEAD);
      expect(message.split(UNRESOLVABLE_CONDITION_LEAD)).toHaveLength(2);
    });

    /**
     * The three fields the dialog gets on the wire suffice for the sentence —
     * it must not secretly hang on `questionId`/`sourceId`, which
     * `publishBlockedConditionSchema` deliberately does not send along.
     */
    it('kommt mit den drei Feldern aus, die auf dem Draht stehen', () => {
      const draft = form([mitfahren(conditionOn(SOURCE, 'equals', 'bahn'))]);
      const found = findings(draft);
      const finding = found[0];
      if (finding === undefined) {
        throw new Error('Der Aufbau dieses Falls erzeugt genau einen Befund.');
      }

      expect(
        unresolvableConditionText({
          questionLabel: finding.questionLabel,
          sourceLabel: finding.sourceLabel,
          defect: finding.defect,
        }),
      ).toBe(unresolvableConditionText(finding));
    });
  });
});
