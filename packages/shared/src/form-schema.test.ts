import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { questionColumns } from './answer-columns.ts';
import {
  TABLE_ROWS_MAX,
  allQuestions,
  formDefinitionSchema,
  isChoiceQuestion,
  otherLabelOf,
  otherPositionOf,
  pageSchema,
  parseFormDefinition,
  questionSchema,
  tableRowLimit,
  type FormDefinition,
} from './form-schema.ts';
import { safeParseAnswers } from './response-validation.ts';

/**
 * The valid case is one test; the rest of the file is the
 * part that carries weight — a schema that only ever sees documents it likes
 * proves nothing about what it keeps out.
 *
 * Every rejection is asserted **with its path**, because the builder has to
 * point at the field that is wrong. An assertion on `success === false` alone
 * would pass just as happily if the whole document failed for an unrelated
 * reason.
 */

const PAGE_A = '019fb000-0000-7000-8000-0000000000a0';
const PAGE_B = '019fb000-0000-7000-8000-0000000000b0';
const Q1 = '019fb000-0000-7000-8000-000000000001';
const Q2 = '019fb000-0000-7000-8000-000000000002';
const Q3 = '019fb000-0000-7000-8000-000000000003';

function textQuestion(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'text',
    label: 'Name',
    hint: null,
    required: true,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
    ...overrides,
  };
}

function selectQuestion(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'select',
    label: 'Organisation',
    hint: null,
    required: false,
    width: 'half',
    options: [
      { value: 'muster', label: 'Musterorganisation' },
      { value: 'hil', label: 'Musterstadt' },
    ],
    allowOther: false,
    otherLabel: null,
    ...overrides,
  };
}

/** A realistic two-page form — the shape a Bestandsmeldung actually has. */
function validDefinition(): unknown {
  return {
    pages: [
      {
        id: PAGE_A,
        title: 'Person',
        questions: [
          textQuestion(Q1),
          {
            id: Q2,
            type: 'email',
            label: 'E-Mail',
            hint: 'Für die Bestätigung',
            required: true,
            width: 'half',
          },
        ],
      },
      {
        id: PAGE_B,
        title: 'Semester',
        questions: [selectQuestion(Q3)],
      },
    ],
  };
}

/**
 * Paths of all issues, dotted — `pages.1.questions.0.id`.
 *
 * Asserting on the path rather than only on `success === false` is what makes
 * these tests about the rule they name: a document can fail for a dozen
 * reasons, and a test that accepts any of them is green for the wrong one.
 */
function issuePaths(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('formDefinitionSchema', () => {
  it('accepts a multi-page form and infers its types', () => {
    const definition: FormDefinition = parseFormDefinition(validDefinition());

    expect(definition.pages).toHaveLength(2);
    expect(allQuestions(definition)).toHaveLength(3);
    const [first] = definition.pages;
    expect(first?.questions[0]?.type).toBe('text');
  });

  it('rejects an unknown question type and names the allowed ones', () => {
    // The example moves on with every type the schema adds, and that is the test
    // working rather than the test decaying: `rating`, `matrix`, `file` and
    // `event` each lost the role in turn, because a document naming
    // a type the schema now knows matches *that* branch and fails on a missing
    // field instead — a different rejection than the one this test is about.
    // **All sixteen types of the Prototyp now exist**, so the example is no
    // longer a type that is „coming next" but one that never will: `signature`
    // is a field the handoff does not have and nobody has asked for, which is
    // exactly the shape of the mistake this test is about — a document written
    // against a system that is not this one.
    const result = formDefinitionSchema.safeParse({
      pages: [
        {
          id: PAGE_A,
          title: 'Person',
          questions: [textQuestion(Q1, { type: 'signature' })],
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('pages.0.questions.0.type');
  });

  it('rejects a duplicate question id across different pages', () => {
    // The same id on two pages — the case a "duplicate page" feature produces,
    // and the one that makes stored answers unattributable.
    const result = formDefinitionSchema.safeParse({
      pages: [
        { id: PAGE_A, title: 'Person', questions: [textQuestion(Q1)] },
        { id: PAGE_B, title: 'Semester', questions: [textQuestion(Q1)] },
      ],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('pages.1.questions.0.id');
  });

  it('rejects a duplicate page id', () => {
    const result = formDefinitionSchema.safeParse({
      pages: [
        { id: PAGE_A, title: 'Person', questions: [] },
        { id: PAGE_A, title: 'Semester', questions: [] },
      ],
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('pages.1.id');
  });

  it('rejects a dropdown without options', () => {
    const result = questionSchema.safeParse(
      selectQuestion(Q3, { options: [] }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('options');
  });

  it('rejects duplicate option values, which would make answers ambiguous', () => {
    const result = questionSchema.safeParse(
      selectQuestion(Q3, {
        options: [
          { value: 'muster', label: 'Musterorganisation' },
          { value: 'muster', label: 'Musterorganisation e. V.' },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('options.1.value');
  });

  it('rejects a form without pages, so "delete the last page" is defined', () => {
    const result = formDefinitionSchema.safeParse({ pages: [] });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('pages');
  });

  it('rejects a pattern that does not compile — at save time, not at fill-in time', () => {
    const result = questionSchema.safeParse(
      textQuestion(Q1, { pattern: '([a-z' }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('pattern');
  });

  it('accepts a pattern that compiles', () => {
    expect(
      questionSchema.safeParse(textQuestion(Q1, { pattern: '^[A-Z]{2}\\d+$' }))
        .success,
    ).toBe(true);
  });

  it('rejects a range whose ends cross', () => {
    const result = questionSchema.safeParse(
      textQuestion(Q1, { minLength: 10, maxLength: 5 }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('maxLength');
  });

  it('rejects a date range whose ends cross, comparing as a calendar would', () => {
    const result = questionSchema.safeParse({
      id: Q1,
      type: 'date',
      label: 'Geburtstag',
      hint: null,
      required: false,
      width: 'full',
      minDate: '2026-05-01',
      maxDate: '2026-04-30',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('maxDate');
  });

  it('rejects a calendar-impossible date bound', () => {
    const result = questionSchema.safeParse({
      id: Q1,
      type: 'date',
      label: 'Geburtstag',
      hint: null,
      required: false,
      width: 'full',
      minDate: '2026-02-30',
      maxDate: null,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a checkbox that demands more ticks than it offers', () => {
    const result = questionSchema.safeParse({
      ...selectQuestion(Q3),
      type: 'checkbox',
      minSelected: 5,
      maxSelected: null,
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('minSelected');
  });

  it('counts „Sonstiges" towards what a checkbox offers', () => {
    const result = questionSchema.safeParse({
      ...selectQuestion(Q3),
      type: 'checkbox',
      allowOther: true,
      otherLabel: 'Sonstiges',
      // Two options plus „Sonstiges" — exactly satisfiable.
      minSelected: 3,
      maxSelected: null,
    });

    expect(result.success).toBe(true);
  });

  /**
   * The one setting a rating question has: 2–10 stars.
   * Both ends of the range are asserted, not just one, because a `min`
   * mistyped as `max` (or the reverse) still refuses *some* out-of-range
   * value and would leave a one-sided test green.
   */
  it('bounds a rating question’s star count to 2–10', () => {
    const rating = (max: number) => ({
      id: Q1,
      type: 'rating',
      label: 'Zufriedenheit',
      hint: null,
      required: false,
      width: 'full',
      max,
    });

    expect(questionSchema.safeParse(rating(1)).success).toBe(false);
    expect(questionSchema.safeParse(rating(2)).success).toBe(true);
    expect(questionSchema.safeParse(rating(5)).success).toBe(true);
    expect(questionSchema.safeParse(rating(10)).success).toBe(true);
    expect(questionSchema.safeParse(rating(11)).success).toBe(false);
  });

  it('narrows choice questions for callers', () => {
    const definition = parseFormDefinition(validDefinition());
    const choice = allQuestions(definition).filter(isChoiceQuestion);

    expect(choice).toHaveLength(1);
    expect(choice[0]?.options).toHaveLength(2);
  });

  /**
   * Shared rather than repeated: the builder preview, the dropdown, the
   * checkbox list and the CSV export all show this caption, and four copies of
   * `?? 'Sonstiges'` is how an export ends up worded differently from the form
   * it came from.
   */
  it('answers the „Sonstiges" caption once for every view', () => {
    const question = questionSchema.parse({
      ...selectQuestion(Q3),
      allowOther: true,
      otherLabel: 'Nicht Mitglied der Dachorganisation – Name der Organisation',
    });
    const unnamed = questionSchema.parse({
      ...selectQuestion(Q3),
      allowOther: false,
      otherLabel: null,
    });

    expect(isChoiceQuestion(question) && otherLabelOf(question)).toBe(
      'Nicht Mitglied der Dachorganisation – Name der Organisation',
    );
    expect(isChoiceQuestion(unnamed) && otherLabelOf(unnamed)).toBe(
      'Sonstiges',
    );
  });

  /**
   * `otherPosition` (Issue #37) — optional for the same reason `visibleIf`
   * is: every choice question stored before this switch existed has no such
   * key, and demanding one would turn every one of those documents into one
   * that no longer parses.
   */
  it('parses a document without `otherPosition` at all, and reads it as „first"', () => {
    const question = questionSchema.parse({
      ...selectQuestion(Q3),
      allowOther: true,
      otherLabel: 'Sonstiges',
    });

    expect(isChoiceQuestion(question) && 'otherPosition' in question).toBe(
      false,
    );
    expect(isChoiceQuestion(question) && otherPositionOf(question)).toBe(
      'first',
    );
  });

  it('keeps an explicit „first" or „last" as given', () => {
    const first = questionSchema.parse({
      ...selectQuestion(Q3),
      allowOther: true,
      otherLabel: 'Sonstiges',
      otherPosition: 'first',
    });
    const last = questionSchema.parse({
      ...selectQuestion(Q3),
      allowOther: true,
      otherLabel: 'Sonstiges',
      otherPosition: 'last',
    });

    expect(isChoiceQuestion(first) && otherPositionOf(first)).toBe('first');
    expect(isChoiceQuestion(last) && otherPositionOf(last)).toBe('last');
  });

  it('rejects a value beyond „first"/„last"', () => {
    const result = questionSchema.safeParse({
      ...selectQuestion(Q3),
      allowOther: true,
      otherLabel: 'Sonstiges',
      otherPosition: 'middle',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain('otherPosition');
  });

  /**
   * The type-level half of the single-source-of-truth rule: no hand-kept interface beside a schema. This
   * cannot be asserted at runtime, so it is asserted at compile time — the
   * assignment below only type-checks while `FormDefinition` is the inferred
   * type and not a parallel declaration that has drifted from it.
   */
  it('derives its types from the schema', () => {
    const definition = parseFormDefinition(validDefinition());
    const roundTrip: FormDefinition = formDefinitionSchema.parse(definition);

    expect(roundTrip).toStrictEqual(definition);
  });
});

/**
 * `pageSchema.description` — three spellings of "keine Beschreibung" on the
 * way in, one on the way out (a review finding).
 *
 * The three inputs are exactly what the finding names: a document that never
 * had the key (every page saved before the `description` field existed), one that has it as `null` (what
 * the builder writes once a page is touched), and one with `''` (what used to
 * survive intact if it ever reached this schema by a route other than the
 * store). All three are asserted to parse to the identical `null` — not
 * merely to equal values, `toBe` rather than `toEqual`, so a future change
 * that keeps them `.toEqual`-equal but structurally different (one an empty
 * string typed as `null` somehow) would still be caught.
 */
describe('pageSchema.description — normalised to one null', () => {
  function pageWith(overrides: Record<string, unknown>): unknown {
    return { id: PAGE_A, title: 'Person', questions: [], ...overrides };
  }

  it('parses an absent key, an explicit null and an empty string to the same null', () => {
    const absent = pageSchema.parse(pageWith({}));
    const explicitNull = pageSchema.parse(pageWith({ description: null }));
    const emptyString = pageSchema.parse(pageWith({ description: '' }));

    expect(absent.description).toBe(null);
    expect(explicitNull.description).toBe(null);
    expect(emptyString.description).toBe(null);
  });

  it('keeps a real description untouched', () => {
    const page = pageSchema.parse(
      pageWith({ description: 'Bitte in Blockschrift ausfüllen.' }),
    );

    expect(page.description).toBe('Bitte in Blockschrift ausfüllen.');
  });

  /**
   * The end-to-end nachweis the finding asks for: with the three spellings
   * collapsed, `sameDefinition`/`hasUnpublishedChanges` (`form-history.ts`)
   * can no longer tell a page apart from itself just because its empty
   * description was once typed into and cleared again — while a *real*
   * description change still counts as something to publish.
   *
   * Imports `form-history.ts` read-only, to prove the schema-level fix
   * actually closes the comparison the finding measured; nothing in that
   * module is touched here.
   */
  it('makes hasUnpublishedChanges blind to the three spellings, but not to a real change', async () => {
    const { hasUnpublishedChanges } = await import('./form-history.ts');

    const published = formDefinitionSchema.parse({
      pages: [pageWith({})], // document predating the `description` field: no `description` key at all
    });
    const clearedAgain = formDefinitionSchema.parse({
      pages: [pageWith({ description: '' })], // touched once, emptied again
    });
    const stillNull = formDefinitionSchema.parse({
      pages: [pageWith({ description: null })],
    });
    const actuallyChanged = formDefinitionSchema.parse({
      pages: [pageWith({ description: 'Neu.' })],
    });

    expect(hasUnpublishedChanges(published, clearedAgain)).toBe(false);
    expect(hasUnpublishedChanges(published, stillNull)).toBe(false);
    expect(hasUnpublishedChanges(published, actuallyChanged)).toBe(true);
  });
});

/**
 * A retyped question names the one it replaced.
 *
 * The field is **added**, and the tests that carry weight here are the ones
 * about what it must not break: every document written before this field
 * existed has no such field, and every one of them still has to parse to exactly what it parsed to
 * before. That is asserted first, and against the *unmodified* fixtures of this
 * file rather than against a fresh one, so a `.nullable()` slipping in later —
 * which would demand the key be present — turns this red.
 */
describe('a question’s reference to its predecessor (Nr. 26)', () => {
  it('parses a document that has never heard of the field, unchanged', () => {
    const definition = parseFormDefinition(validDefinition());

    // Not merely „success": the absent field must stay absent. A default would
    // rewrite fifty stored documents into something they never said.
    for (const question of allQuestions(definition)) {
      expect(question.replaces).toBeUndefined();
      expect(Object.hasOwn(question, 'replaces')).toBe(false);
    }
  });

  it('keeps the reference when one is there', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE_A,
          title: 'Person',
          questions: [textQuestion(Q1, { replaces: Q2 })],
        },
      ],
    });

    expect(allQuestions(definition)[0]?.replaces).toBe(Q2);
  });

  /**
   * `questionSchema` is a union discriminated by `type`, so „the field exists"
   * is nine statements and not one. A field added to a single variant would
   * pass any test that happens to use a text question — which is most of them.
   */
  it('accepts the reference on every one of the nine types', () => {
    const plain = {
      id: Q1,
      label: 'Frage',
      hint: null,
      required: false,
      width: 'full',
    };
    const withReference: Record<string, unknown>[] = [
      textQuestion(Q1),
      { ...plain, type: 'textarea', minLength: null, maxLength: null },
      { ...plain, type: 'number', min: null, max: null, integer: true },
      { ...plain, type: 'date', minDate: null, maxDate: null },
      { ...plain, type: 'email' },
      { ...plain, type: 'phone' },
      selectQuestion(Q1),
      { ...selectQuestion(Q1), type: 'radio' },
      {
        ...selectQuestion(Q1),
        type: 'checkbox',
        minSelected: null,
        maxSelected: null,
      },
    ];

    for (const question of withReference) {
      const result = questionSchema.safeParse({ ...question, replaces: Q2 });
      expect(result.success).toBe(true);
      expect(result.data?.replaces).toBe(Q2);
    }
    // The list is the nine original types, each of them exactly once.
    expect(new Set(withReference.map((question) => question.type)).size).toBe(
      9,
    );
  });

  it('rejects a reference that is not a question id', () => {
    const result = questionSchema.safeParse(
      textQuestion(Q1, { replaces: 'die-frage-davor' }),
    );

    expect(issuePaths(result)).toEqual(['replaces']);
  });
});

/**
 * **„Zeilen ergänzbar" and its Obergrenze** .
 *
 * The block is here rather than beside the answer tests because every rule it
 * measures is a rule about the **document**: what an editor may write down is
 * what a participant may later send, and the one number the two agree on is
 * `tableRowLimit`.
 */
describe('Tabelle — Startzeilen und Obergrenze', () => {
  const TABLE = '019fb000-0000-7000-8000-00000000000f';

  function table(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: TABLE,
      type: 'table',
      label: 'Begleitpersonen',
      hint: null,
      required: false,
      width: 'full',
      rows: 2,
      columns: [{ key: 'name', label: 'Name', type: 'text' }],
      ...overrides,
    };
  }

  /**
   * **Legacy data is the rule, not the exception**.
   *
   * The document below is written as **text**, parsed from JSON, exactly the
   * way a row of `form_version.schema` arrives from PostgreSQL — not as a
   * TypeScript literal, which today's types would quietly complete. It is a
   * table in its original stored shape, and the two assertions are the whole promise: it
   * still parses, and it means what it meant — a fixed row count, because
   * `tableRowLimit` reads the start rows when there is no `addRows`.
   */
  it('reads an older document without the new fields as „nicht ergänzbar"', () => {
    const stored: unknown = JSON.parse(
      `{"pages":[{"id":"${PAGE_A}","title":"Anmeldung","description":null,
        "questions":[{"id":"${TABLE}","type":"table","label":"Begleitpersonen",
        "hint":null,"required":false,"width":"full","rows":3,
        "columns":[{"key":"name","label":"Name","type":"text"},
        {"key":"vegetarisch","label":"Vegetarisch","type":"checkbox"}]}]}]}`,
    );

    const definition = parseFormDefinition(stored);
    const question = allQuestions(definition)[0];

    expect(question?.type).toBe('table');
    expect(question?.type === 'table' && question.addRows).toBeUndefined();
    expect(question?.type === 'table' && tableRowLimit(question)).toBe(3);
  });

  it('accepts „ergänzbar" and reads the limit from it', () => {
    const parsed = questionSchema.parse(table({ addRows: { maxRows: 12 } }));

    expect(parsed.type === 'table' && tableRowLimit(parsed)).toBe(12);
  });

  /**
   * **The Obergrenze must not lie below the start rows.** A form offering
   * three rows and accepting two refuses its own untouched submission — the
   * fill-in view renders `rows`, the validator counts what arrives.
   */
  it('refuses an Obergrenze below the start rows', () => {
    expect(
      issuePaths(
        questionSchema.safeParse(table({ rows: 3, addRows: { maxRows: 2 } })),
      ),
    ).toEqual(['addRows.maxRows']);
    expect(
      questionSchema.safeParse(table({ rows: 3, addRows: { maxRows: 3 } }))
        .success,
    ).toBe(true);
  });

  /**
   * **`rows ≥ 1` bleibt** — a deliberate decision, and the reason is in
   * `form-history.ts`: `responseColumns` is asked **without any answer in
   * hand**, and a table with no start row would plan no column there while
   * the export, which does hold the answers, writes columns for it. „Beliebig
   * viele Begleitpersonen" is `rows: 1` plus `addRows`, which costs a
   * participant who brings nobody exactly one empty row.
   */
  it('refuses a Tabelle without a start row', () => {
    expect(issuePaths(questionSchema.safeParse(table({ rows: 0 })))).toEqual([
      'rows',
    ]);
    expect(
      issuePaths(
        questionSchema.safeParse({
          ...(table({ rows: 0 }) as object),
          addRows: { maxRows: 5 },
        }),
      ),
    ).toEqual(['rows']);
  });

  /**
   * **The Obergrenze is bound to the schema — and to the number the file can
   * write.**
   *
   * The bound is probed with **literal** numbers rather than compared against
   * `TABLE_ROWS_MAX`, and that is the whole point of the shape: an earlier review
   * found a test that was written against the same constant it was supposed to
   * guard and could therefore never fail. Here the schema is asked what it
   * accepts, and the answer is held against what `questionColumns` writes.
   */
  it('accepts no Obergrenze the export cannot write', () => {
    const accepted = Array.from({ length: 64 }, (_, index) => index + 1).filter(
      (maxRows) =>
        questionSchema.safeParse(table({ rows: 1, addRows: { maxRows } }))
          .success,
    );

    expect(accepted[0]).toBe(1);
    expect(Math.max(...accepted)).toBe(TABLE_ROWS_MAX);
    // The same statement once more without the constant, so that raising
    // *both* numbers together stays green and raising only the schema's does
    // not: 21 rows is a document, 20 is a file.
    expect(
      questionSchema.safeParse(table({ addRows: { maxRows: 21 } })).success,
    ).toBe(false);
  });

  /**
   * **What the schema accepts is also in the file** — the measurement that
   * earlier review asked for, and the only one that would have caught the case it
   * described: a stored answer with 25 rows loses `N21`–`N25` from the file
   * without a header, without a marker, without a word.
   *
   * It mentions no bound at all. The largest Obergrenze the **schema** accepts
   * is found by probing; an answer that fills it is run through the validator;
   * and the column plan is counted. Widen the schema alone and the plan falls
   * short of the answer the validator just accepted — red, with the numbers in
   * the message.
   */
  it('plans a column for every row the validator accepts', () => {
    const limit = Array.from({ length: 64 }, (_, index) => index + 1)
      .filter(
        (maxRows) =>
          questionSchema.safeParse(table({ rows: 1, addRows: { maxRows } }))
            .success,
      )
      .reduce((a, b) => Math.max(a, b));
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE_A,
          title: 'Anmeldung',
          questions: [table({ rows: 1, addRows: { maxRows: limit } })],
        },
      ],
    });
    const question = allQuestions(definition)[0];
    const answers = {
      [TABLE]: {
        cells: Array.from({ length: limit }, (_, index) => ({
          name: `Person ${String(index + 1)}`,
        })),
      },
    };

    expect(safeParseAnswers(definition, answers).success).toBe(true);
    expect(question).toBeDefined();
    if (question === undefined) {
      return;
    }
    const plan = questionColumns(question, [answers]);
    expect(plan).toHaveLength(limit);
    // Not merely as many columns as rows — **the last row is in the file**.
    expect(plan.at(-1)?.render(answers[TABLE])).toBe(`Person ${String(limit)}`);
  });
});
