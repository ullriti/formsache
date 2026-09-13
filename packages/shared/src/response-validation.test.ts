import { describe, expect, it } from 'vitest';

import { parseFormDefinition, type FormDefinition } from './form-schema.ts';
import {
  MATRIX_UNKNOWN_ROW_CODE,
  TABLE_ROW_LIMIT_CODE,
  answerValueSchema,
  buildAnswersSchema,
  canonicalAnswerValue,
  isBlankAnswer,
  safeParseAnswers,
  safeParseDraftAnswers,
  type AnswerValue,
} from './response-validation.ts';

/**
 * **Every question type is exercised with an allowed *and* a forbidden
 * value.** A suite that only shows the happy path demonstrates that the
 * validator runs, not that it refuses anything (`CONTRIBUTING.md`).
 *
 * The forbidden cases are the ones a real submission produces or a tampered
 * one carries: an out-of-range number, a text against its pattern, an option
 * value that is not on the list, a value for a question that does not exist.
 */

const P = '019fc000-0000-7000-8000-0000000000f0';
const ids = {
  text: '019fc000-0000-7000-8000-000000000001',
  textarea: '019fc000-0000-7000-8000-000000000002',
  number: '019fc000-0000-7000-8000-000000000003',
  date: '019fc000-0000-7000-8000-000000000004',
  email: '019fc000-0000-7000-8000-000000000005',
  phone: '019fc000-0000-7000-8000-000000000006',
  select: '019fc000-0000-7000-8000-000000000007',
  radio: '019fc000-0000-7000-8000-000000000008',
  checkbox: '019fc000-0000-7000-8000-000000000009',
} as const;

const base = { hint: null, required: false, width: 'full' } as const;
const options = [
  { value: 'a', label: 'Aktiv' },
  { value: 'b', label: 'Inaktiv' },
];

/** One form carrying all nine original types, every rule switched on. */
function definition(overrides: Record<string, unknown> = {}): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: P,
        title: 'Alles',
        questions: [
          {
            ...base,
            id: ids.text,
            type: 'text',
            label: 'Kürzel',
            minLength: 2,
            maxLength: 4,
            pattern: '^[A-Z]+$',
          },
          {
            ...base,
            id: ids.textarea,
            type: 'textarea',
            label: 'Bemerkung',
            minLength: null,
            maxLength: 20,
          },
          {
            ...base,
            id: ids.number,
            type: 'number',
            label: 'Semester',
            min: 1,
            max: 30,
            integer: true,
          },
          {
            ...base,
            id: ids.date,
            type: 'date',
            label: 'Eintritt',
            minDate: '2020-01-01',
            maxDate: '2030-12-31',
          },
          { ...base, id: ids.email, type: 'email', label: 'E-Mail' },
          { ...base, id: ids.phone, type: 'phone', label: 'Telefon' },
          {
            ...base,
            id: ids.select,
            type: 'select',
            label: 'Status',
            options,
            allowOther: false,
            otherLabel: null,
          },
          {
            ...base,
            id: ids.radio,
            type: 'radio',
            label: 'Teilnahme',
            options,
            allowOther: true,
            otherLabel: 'Sonstiges',
          },
          {
            ...base,
            id: ids.checkbox,
            type: 'checkbox',
            label: 'Tage',
            options,
            allowOther: false,
            otherLabel: null,
            minSelected: null,
            maxSelected: 1,
          },
        ],
      },
    ],
    ...overrides,
  });
}

const empty = { values: [], other: null };

/** Accepts one answer in isolation; every other question is left blank. */
function check(questionId: string, value: unknown): boolean {
  return safeParseAnswers(definition(), { [questionId]: value }).success;
}

describe('buildAnswersSchema — allowed and forbidden per type', () => {
  it.each([
    ['text', ids.text, 'ABC', 'abc'],
    ['textarea', ids.textarea, 'kurz', 'x'.repeat(21)],
    ['number', ids.number, 4, 31],
    ['date', ids.date, '2026-07-27', '2019-12-31'],
    ['email', ids.email, 'bruder@example.org', 'bruder@'],
    ['phone', ids.phone, '+49 (0)711 / 123-45', 'nicht angegeben'],
  ])(
    '%s accepts a valid value and refuses an invalid one',
    (_label, id, allowed, forbidden) => {
      expect(check(id, allowed)).toBe(true);
      expect(check(id, forbidden)).toBe(false);
    },
  );

  it('select accepts a listed option and refuses an unlisted one', () => {
    expect(check(ids.select, { values: ['a'], other: null })).toBe(true);
    expect(check(ids.select, { values: ['c'], other: null })).toBe(false);
  });

  it('radio refuses two selections', () => {
    expect(check(ids.radio, { values: ['a'], other: null })).toBe(true);
    expect(check(ids.radio, { values: ['a', 'b'], other: null })).toBe(false);
  });

  it('checkbox honours its upper bound, counting „Sonstiges" as a selection', () => {
    expect(check(ids.checkbox, { values: ['a'], other: null })).toBe(true);
    expect(check(ids.checkbox, { values: ['a', 'b'], other: null })).toBe(
      false,
    );
  });

  it('refuses „Sonstiges" on a question that does not offer it', () => {
    expect(check(ids.radio, { values: [], other: 'per Bahn' })).toBe(true);
    expect(check(ids.select, { values: [], other: 'per Bahn' })).toBe(false);
  });

  it('refuses a duplicate selection', () => {
    expect(check(ids.checkbox, { values: ['a', 'a'], other: null })).toBe(
      false,
    );
  });

  it('applies the number question’s integer rule', () => {
    expect(check(ids.number, 4.5)).toBe(false);
  });

  it('refuses a value of the wrong JavaScript type', () => {
    expect(check(ids.number, '4')).toBe(false);
    expect(check(ids.text, 42)).toBe(false);
    expect(check(ids.select, 'a')).toBe(false);
  });
});

describe('buildAnswersSchema — structure of a submission', () => {
  /**
   * The case worth singling out: a value for a question the form does
   * not have. Rejected, not dropped — silently discarding it would let a
   * tampered payload look like a valid submission, and `.strict()` is what
   * keeps unknown keys out of the JSONB column.
   */
  it('refuses an answer to a question that does not exist', () => {
    const result = safeParseAnswers(definition(), {
      '019fc000-0000-7000-8000-0000000000ff': 'irgendwas',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a submission that leaves every optional question blank', () => {
    expect(safeParseAnswers(definition(), {}).success).toBe(true);
  });

  it('accepts both blank spellings a client may send', () => {
    expect(check(ids.text, '')).toBe(true);
    expect(check(ids.text, null)).toBe(true);
    expect(check(ids.number, null)).toBe(true);
    expect(check(ids.checkbox, empty)).toBe(true);
  });

  it('reports the failing question by id, so the view can mark the field', () => {
    const result = safeParseAnswers(definition(), { [ids.number]: 99 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(ids.number);
  });
});

describe('buildAnswersSchema — required questions', () => {
  function requiredDefinition(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Pflicht',
          questions: [
            {
              ...base,
              required: true,
              id: ids.text,
              type: 'text',
              label: 'Name',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
            {
              ...base,
              required: true,
              id: ids.checkbox,
              type: 'checkbox',
              label: 'Tage',
              options,
              allowOther: false,
              otherLabel: null,
              minSelected: null,
              maxSelected: null,
            },
          ],
        },
      ],
    });
  }

  it('refuses a missing, empty or whitespace-only required answer', () => {
    const schema = buildAnswersSchema(requiredDefinition());

    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a'], other: null } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        [ids.text]: '',
        [ids.checkbox]: { values: ['a'], other: null },
      }).success,
    ).toBe(false);
    // Whitespace is the one that slips through a naive `length > 0` check, and
    // it is what a participant tabbing through a form actually produces.
    expect(
      schema.safeParse({
        [ids.text]: '   ',
        [ids.checkbox]: { values: ['a'], other: null },
      }).success,
    ).toBe(false);
  });

  it('refuses an empty selection for a required choice question', () => {
    const schema = buildAnswersSchema(requiredDefinition());

    expect(
      schema.safeParse({ [ids.text]: 'Anton', [ids.checkbox]: empty }).success,
    ).toBe(false);
  });

  it('accepts a complete submission', () => {
    const schema = buildAnswersSchema(requiredDefinition());

    expect(
      schema.safeParse({
        [ids.text]: 'Anton',
        [ids.checkbox]: { values: ['a', 'b'], other: null },
      }).success,
    ).toBe(true);
  });

  /**
   * Negative probe: the required rule has to be the thing these
   * tests fail on. Building the same form with `required: false` must flip
   * exactly the assertions above and leave the type checks alone — if a blank
   * answer were still refused, the message "Pflichtfeld" would be coming from
   * somewhere else.
   */
  it('negative probe: the same blanks pass once the questions are optional', () => {
    const optional = parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Pflicht',
          questions: [
            {
              ...base,
              required: false,
              id: ids.text,
              type: 'text',
              label: 'Name',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
      ],
    });

    expect(buildAnswersSchema(optional).safeParse({}).success).toBe(true);
    expect(
      buildAnswersSchema(optional).safeParse({ [ids.text]: '   ' }).success,
    ).toBe(true);
  });
});

/**
 * The requirement explicitly asks for the boundary against a
 * value **above** the question's own `max` — checked here against **two**
 * versions with different `max` values, because the rule it
 * names is „gegen ihre eigene Fassung", not „gegen a fixed 5".
 */
describe('buildAnswersSchema — rating', () => {
  const RATING_ID = '019fc000-0000-7000-8000-00000000000a';

  function ratingDefinition(max: number, required = false): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Rückmeldung',
          description: null,
          questions: [
            {
              ...base,
              required,
              id: RATING_ID,
              type: 'rating',
              label: 'Zufriedenheit',
              max,
            },
          ],
        },
      ],
    });
  }

  it('accepts every star from 1 up to the question’s own max', () => {
    const schema = buildAnswersSchema(ratingDefinition(5));

    for (const value of [1, 2, 3, 4, 5]) {
      expect(schema.safeParse({ [RATING_ID]: value }).success).toBe(true);
    }
  });

  it('refuses a value above max, and 0 is not a rating either', () => {
    const schema = buildAnswersSchema(ratingDefinition(5));

    expect(schema.safeParse({ [RATING_ID]: 6 }).success).toBe(false);
    expect(schema.safeParse({ [RATING_ID]: 0 }).success).toBe(false);
  });

  /**
   * The setting is **per question**, not a shared constant — a value legal
   * against a 10-star version must still fail against a 5-star one, and the
   * reverse. Guards against a validator that reads `max` once and reuses it.
   */
  it('validates against the max of its own Fassung, not a shared one', () => {
    const wide = buildAnswersSchema(ratingDefinition(10));
    const narrow = buildAnswersSchema(ratingDefinition(5));

    expect(wide.safeParse({ [RATING_ID]: 8 }).success).toBe(true);
    expect(narrow.safeParse({ [RATING_ID]: 8 }).success).toBe(false);
  });

  it('refuses a fractional star count', () => {
    const schema = buildAnswersSchema(ratingDefinition(5));

    expect(schema.safeParse({ [RATING_ID]: 3.5 }).success).toBe(false);
  });

  /** Required means required: no star clicked is `null`, and `null` is refused. */
  it('refuses a missing required rating and accepts a complete one', () => {
    const schema = buildAnswersSchema(ratingDefinition(5, true));

    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ [RATING_ID]: null }).success).toBe(false);
    expect(schema.safeParse({ [RATING_ID]: 3 }).success).toBe(true);
  });

  /**
   * `blankSchemaFor` has an explicit `rating` branch rather than falling
   * through to the `default` (`'' | null`): a rating is set by clicking a
   * star, never typed, so `''` is not a shape the fill-in view ever
   * produces for it — only `null` is „no star clicked".
   */
  it('accepts a blank optional rating as null, and refuses the empty-string spelling', () => {
    const schema = buildAnswersSchema(ratingDefinition(5));

    expect(schema.safeParse({ [RATING_ID]: null }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ [RATING_ID]: '' }).success).toBe(false);
  });
});

describe('buildAnswersSchema — Datei-Upload', () => {
  const FILE_ID = '019fc000-0000-7000-8000-00000000000f';
  const REF_A = 'AbCdEfGhIjKlMnOpQrStUv';
  const REF_B = 'ZyXwVuTsRqPoNmLkJiHgFe';

  function fileDefinition(maxFiles: number, required = false): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Anmeldung',
          description: null,
          questions: [
            {
              ...base,
              required,
              id: FILE_ID,
              type: 'file',
              label: 'Nachweis',
              maxFiles,
            },
          ],
        },
      ],
    });
  }

  const answer = (
    files: readonly { ref: string; name: string }[],
  ): Record<string, unknown> => ({ [FILE_ID]: { files } });

  it('accepts up to as many files as this question offers', () => {
    const schema = buildAnswersSchema(fileDefinition(2));

    expect(
      schema.safeParse(answer([{ ref: REF_A, name: 'Nachweis.pdf' }])).success,
    ).toBe(true);
    expect(
      schema.safeParse(
        answer([
          { ref: REF_A, name: 'Nachweis.pdf' },
          { ref: REF_B, name: 'Vollmacht.pdf' },
        ]),
      ).success,
    ).toBe(true);
  });

  /**
   * The bound is read from **this** question, exactly as `rating` reads its
   * `max`: two versions may offer different numbers, and an answer is only
   * ever validated against the one it was given to.
   */
  it('refuses more files than this Fassung offers', () => {
    const two = buildAnswersSchema(fileDefinition(2));
    const one = buildAnswersSchema(fileDefinition(1));
    const both = answer([
      { ref: REF_A, name: 'Nachweis.pdf' },
      { ref: REF_B, name: 'Vollmacht.pdf' },
    ]);

    expect(two.safeParse(both).success).toBe(true);
    expect(one.safeParse(both).success).toBe(false);
  });

  /**
   * **The reference is spelled before the database sees it** (ADR-0014 no. 9).
   * A percent escape is decoded before the application looks at it, `%00`
   * arrives as a NUL byte, PostgreSQL refuses U+0000 in `text` — and the claim's
   * query would throw a **500** where every unknown reference answers the same
   * refusal.
   */
  it('refuses a reference that is not one', () => {
    const schema = buildAnswersSchema(fileDefinition(2));

    for (const ref of [
      '',
      'has space',
      'has/slash',
      '\u0000',
      'a'.repeat(201),
    ]) {
      expect(schema.safeParse(answer([{ ref, name: 'x.pdf' }])).success).toBe(
        false,
      );
    }
  });

  /** The name is held to the same schema the upload held it to (no. 10). */
  it('refuses a name that no upload could have stored', () => {
    const schema = buildAnswersSchema(fileDefinition(2));

    for (const name of ['', '..', 'pfad/name.pdf', 'a'.repeat(256)]) {
      expect(schema.safeParse(answer([{ ref: REF_A, name }])).success).toBe(
        false,
      );
    }
  });

  /**
   * One file cannot be hung onto the same answer twice. The claim refuses it
   * as well — it de-duplicates and then finds a length mismatch — but with the
   * one opaque „Anhang nicht verfügbar" for all five of its conditions; here
   * the answer can still name the field it happened in.
   */
  it('refuses the same file twice', () => {
    const schema = buildAnswersSchema(fileDefinition(2));

    expect(
      schema.safeParse(
        answer([
          { ref: REF_A, name: 'Nachweis.pdf' },
          { ref: REF_A, name: 'Nachweis.pdf' },
        ]),
      ).success,
    ).toBe(false);
  });

  /**
   * „Leer" is `{files: []}` — the shape the fill-in view produces once the last
   * attachment was removed again. Under the `default` of `blankSchemaFor` it
   * would have been `'' | null`, which compiles and never matches (the trap the
   * Adresse, the Matrix and the Tabelle branches each closed before it).
   */
  it('reads an empty file list as blank, and refuses it when the question is required', () => {
    expect(isBlankAnswer({ files: [] })).toBe(true);
    expect(isBlankAnswer({ files: [{ ref: REF_A, name: 'x.pdf' }] })).toBe(
      false,
    );

    const optional = buildAnswersSchema(fileDefinition(2));
    expect(optional.safeParse(answer([])).success).toBe(true);
    expect(optional.safeParse({}).success).toBe(true);

    const required = buildAnswersSchema(fileDefinition(2, true));
    expect(required.safeParse(answer([])).success).toBe(false);
    expect(required.safeParse({}).success).toBe(false);
    expect(
      required.safeParse(answer([{ ref: REF_A, name: 'Nachweis.pdf' }]))
        .success,
    ).toBe(true);
  });

  /**
   * A `files` that is not a list must not read as „war eben leer": it falls
   * through to the filled schema and is refused there with a message about the
   * field, rather than being waved past a required question
   * (`blankText`'s reasoning, one type further along).
   */
  it('does not read an unreadable file list as blank', () => {
    expect(isBlankAnswer({ files: 5 })).toBe(false);
    expect(
      buildAnswersSchema(fileDefinition(2, true)).safeParse({
        [FILE_ID]: { files: 5 },
      }).success,
    ).toBe(false);
  });
});

describe('buildAnswersSchema — info', () => {
  const INFO_ID = '019fc000-0000-7000-8000-00000000000b';
  const NAME_ID = '019fc000-0000-7000-8000-00000000000c';

  /**
   * An `info` next to an ordinary required question — so an empty submission
   * fails for a reason that has nothing to do with the `info`, and a complete
   * one shows the `info` is not itself demanding anything.
   */
  function infoDefinition(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Hinweise',
          description: null,
          questions: [
            {
              ...base,
              id: INFO_ID,
              type: 'info',
              label: 'Bitte in Blockschrift ausfüllen.',
            },
            {
              ...base,
              id: NAME_ID,
              type: 'text',
              label: 'Name',
              required: true,
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
      ],
    });
  }

  /** A value sent for the `info` is rejected, not silently kept. */
  it('refuses any value submitted for the info question, whatever its shape', () => {
    const schema = buildAnswersSchema(infoDefinition());

    for (const value of ['', 'Gelesen', null, 0, { values: [], other: null }]) {
      const result = schema.safeParse({
        [NAME_ID]: 'Beispiel',
        [INFO_ID]: value,
      });
      expect(result.success).toBe(false);
    }
  });

  /**
   * The other half of the same claim: a submission that never mentions the
   * `info` at all — which is what every real fill-in view sends, since it
   * renders no control for one — passes. An `info` is not a hole `.strict()`
   * quietly forgives; it is a question the shape never names.
   */
  it('accepts a submission that omits the info question entirely', () => {
    const schema = buildAnswersSchema(infoDefinition());

    expect(schema.safeParse({ [NAME_ID]: 'Beispiel' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // NAME_ID is required
  });
});

describe('buildAnswersSchema — Adresse', () => {
  const ADDRESS_ID = '019fc000-0000-7000-8000-00000000000d';

  function addressDefinition(required: boolean): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Anschrift',
          description: null,
          questions: [
            {
              ...base,
              required,
              id: ADDRESS_ID,
              type: 'address',
              label: 'Anschrift',
            },
          ],
        },
      ],
    });
  }

  const complete = {
    street: 'Musterstraße 12',
    zip: '01067',
    city: 'Dresden',
    country: 'Deutschland',
  };

  it('accepts a complete address, required or not', () => {
    expect(
      buildAnswersSchema(addressDefinition(true)).safeParse({
        [ADDRESS_ID]: complete,
      }).success,
    ).toBe(true);
    expect(
      buildAnswersSchema(addressDefinition(false)).safeParse({
        [ADDRESS_ID]: complete,
      }).success,
    ).toBe(true);
  });

  /** Street, postcode and city are mandatory — country is not. */
  it('requires street, zip and city when the question is required, but never country', () => {
    const schema = buildAnswersSchema(addressDefinition(true));

    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({
        [ADDRESS_ID]: { ...complete, country: '' },
      }).success,
    ).toBe(true);
    for (const missing of ['street', 'zip', 'city'] as const) {
      expect(
        schema.safeParse({
          [ADDRESS_ID]: { ...complete, [missing]: '' },
        }).success,
      ).toBe(false);
    }
  });

  /**
   * A **partially** filled required address is refused — not
   * accepted as „irgendetwas ist da". Half-empty is exactly the shape
   * `addressAnswerSchema` closes: it reads `required` per subfield rather
   * than only at the blank/filled fork `buildAnswersSchema` makes for every
   * other type.
   */
  it('refuses a partially filled required address', () => {
    const schema = buildAnswersSchema(addressDefinition(true));

    const result = schema.safeParse({
      [ADDRESS_ID]: {
        street: 'Musterstraße 12',
        zip: '',
        city: '',
        country: '',
      },
    });
    expect(result.success).toBe(false);
  });

  /** An optional address may stay entirely untouched. */
  it('accepts an untouched optional address, key present or absent', () => {
    const schema = buildAnswersSchema(addressDefinition(false));

    expect(schema.safeParse({}).success).toBe(true);
    expect(
      schema.safeParse({
        [ADDRESS_ID]: { street: '', zip: '', city: '', country: '' },
      }).success,
    ).toBe(true);
  });

  /**
   * `blankSchemaFor` has its own `address` branch rather than the `default`
   * (`'' | null`, the requirement's fifth point): the fill-in view never
   * sends either scalar spelling for a structured answer, only the
   * all-empty object or an absent key.
   */
  it('refuses the scalar blank spellings other types accept', () => {
    const schema = buildAnswersSchema(addressDefinition(false));

    expect(schema.safeParse({ [ADDRESS_ID]: '' }).success).toBe(false);
    expect(schema.safeParse({ [ADDRESS_ID]: null }).success).toBe(false);
  });
});

describe('buildAnswersSchema — Matrix', () => {
  const MATRIX_ID = '019fc000-0000-7000-8000-00000000000e';

  function matrixDefinition(
    required: boolean,
    multiple = false,
  ): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Bewertung',
          description: null,
          questions: [
            {
              ...base,
              required,
              multiple,
              id: MATRIX_ID,
              type: 'matrix',
              label: 'Bewerte folgende Punkte',
              rows: [
                { value: 'organisation', label: 'Organisation' },
                { value: 'programm', label: 'Programm' },
              ],
              columns: [
                { value: 'sehr-gut', label: 'Sehr gut' },
                { value: 'gut', label: 'Gut' },
              ],
            },
          ],
        },
      ],
    });
  }

  const complete = {
    rows: { organisation: ['sehr-gut'], programm: ['gut'] },
  };

  it('accepts one pick per row', () => {
    expect(
      buildAnswersSchema(matrixDefinition(true)).safeParse({
        [MATRIX_ID]: complete,
      }).success,
    ).toBe(true);
  });

  /**
   * **The mandatory rule of this type: all rows.** Stated on the schema
   * (`matrixAnswerSchema`) with its reason — every row becomes its own export
   * column, so a Matrix answered in one row of twelve fills one column and
   * leaves eleven blank in a file whose reader cannot tell „nicht gefragt"
   * from „nicht beantwortet".
   */
  it('requires every row when the question is required', () => {
    const result = buildAnswersSchema(matrixDefinition(true)).safeParse({
      [MATRIX_ID]: { rows: { organisation: ['sehr-gut'] } },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'Bitte „Programm" beantworten.',
    );
  });

  /** The other half of the pair: an optional Matrix needs no row at all. */
  it('accepts a partly or wholly unanswered optional matrix', () => {
    const schema = buildAnswersSchema(matrixDefinition(false));

    expect(
      schema.safeParse({ [MATRIX_ID]: { rows: { organisation: ['gut'] } } })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ [MATRIX_ID]: { rows: {} } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('refuses a second pick in one row unless Mehrfachauswahl is on', () => {
    const two = {
      rows: { organisation: ['sehr-gut', 'gut'], programm: ['gut'] },
    };

    expect(
      buildAnswersSchema(matrixDefinition(false)).safeParse({
        [MATRIX_ID]: two,
      }).success,
    ).toBe(false);
    expect(
      buildAnswersSchema(matrixDefinition(false, true)).safeParse({
        [MATRIX_ID]: two,
      }).success,
    ).toBe(true);
  });

  /** Unknown rows and unknown scale steps are refused, never dropped. */
  it('refuses a row or a scale step this question does not have', () => {
    const schema = buildAnswersSchema(matrixDefinition(false));

    expect(
      schema.safeParse({ [MATRIX_ID]: { rows: { erfundenes: ['gut'] } } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ [MATRIX_ID]: { rows: { programm: ['spitze'] } } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        [MATRIX_ID]: { rows: { programm: ['gut', 'gut'] } },
      }).success,
    ).toBe(false);
  });

  /** `blankSchemaFor` has a branch of its own — the scalar spellings are not it. */
  it('refuses the scalar blank spellings other types accept', () => {
    const schema = buildAnswersSchema(matrixDefinition(false));

    expect(schema.safeParse({ [MATRIX_ID]: '' }).success).toBe(false);
    expect(schema.safeParse({ [MATRIX_ID]: null }).success).toBe(false);
  });

  /**
   * **An unknown row *without* a pick is an unknown row too**
   * (security review).
   *
   * The case above („refuses a row … this question does not have") sends
   * `{erfundenes: ['gut']}` — a **filled** answer, which never touches the blank
   * branch of the union. `{erfundenes: []}` does, and until this fix the blank
   * branch was `z.record(z.string(), …)`: it bounded neither the number of keys
   * nor their length, and passed them through into the stored document.
   * *Measured on 2026-08-07, before:* a matrix with one row accepted **5000**
   * invented keys and stored all of them; at the real transport limit
   * (100 KiB) **9404** keys and **102 344 bytes**; a single key with 90 000
   * characters likewise.
   *
   * **Why that is worse than the space:** `questionColumns` plans the columns
   * of a matrix from `question.rows`, so the content would appear neither in
   * the responses table nor in the export — stored, invisible and thereby
   * deletable by nobody in a targeted way.
   */
  it('refuses an unknown row that carries no pick, on every path', () => {
    const optional = matrixDefinition(false);
    const required = matrixDefinition(true);
    const flood = {
      [MATRIX_ID]: {
        rows: Object.fromEntries(
          Array.from({ length: 5000 }, (_, index) => [`r${String(index)}`, []]),
        ),
      },
    };
    const single = { [MATRIX_ID]: { rows: { erfundenes: [] } } };
    const long = { [MATRIX_ID]: { rows: { ['k'.repeat(90_000)]: [] } } };

    // Submission (optional matrix), edit path — the same function.
    expect(safeParseAnswers(optional, flood).success).toBe(false);
    expect(safeParseAnswers(optional, single).success).toBe(false);
    expect(safeParseAnswers(optional, long).success).toBe(false);
    // The draft, and there the **mandatory** matrix too: `enforceRequired:
    // false` leads it into exactly the same optional branch.
    expect(safeParseDraftAnswers(optional, flood).success).toBe(false);
    expect(safeParseDraftAnswers(required, flood).success).toBe(false);
    expect(safeParseDraftAnswers(required, single).success).toBe(false);
    // …and what the question really has still parses — on both sides of the
    // union: „leer" has not become an error.
    expect(
      safeParseAnswers(optional, { [MATRIX_ID]: { rows: { programm: [] } } })
        .success,
    ).toBe(true);
    expect(safeParseAnswers(optional, { [MATRIX_ID]: complete }).success).toBe(
      true,
    );
  });

  /**
   * **The reason travels along, and at the row** — the reason the check sits
   * *in front of* the union and not in the blank branch: narrowing the blank
   * branch alone makes both members fail, Zod answers `invalid_union` /
   * „Invalid input", and neither `path` nor `code` ever reaches the wire.
   */
  it('names the field and the rule of an unknown row', () => {
    const result = safeParseAnswers(matrixDefinition(false), {
      [MATRIX_ID]: { rows: { erfundenes: [] } },
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(
      (candidate) =>
        candidate.path.join('.') === `${MATRIX_ID}.rows.erfundenes`,
    );
    expect(issue?.message).toBe('Unbekannte Zeile.');
    expect(issue?.code === 'custom' ? issue.params?.code : undefined).toBe(
      MATRIX_UNKNOWN_ROW_CODE,
    );
  });

  /**
   * **The counter-check on the scale** (same review): the scale values were checked
   * for the same hole and do **not** have it — the blank branch admits only the
   * empty array, so a scale step this question does not have can never be part
   * of a blank answer and always meets `matrixAnswerSchema`. Asserted rather
   * than argued, because „wir haben nachgesehen" is not a mechanism.
   */
  it('refuses an unknown scale step on the optional and the Entwurf path too', () => {
    const optional = matrixDefinition(false);
    const required = matrixDefinition(true);
    const invented = { [MATRIX_ID]: { rows: { programm: ['spitze'] } } };

    expect(safeParseAnswers(optional, invented).success).toBe(false);
    expect(safeParseDraftAnswers(optional, invented).success).toBe(false);
    expect(safeParseDraftAnswers(required, invented).success).toBe(false);
  });

  /**
   * **And the refused row stands in no stored document.** The
   * cases above measure the refusal; this one measures what the *accepted*
   * neighbour carries, because a validator that refused and a validator that
   * silently dropped would be indistinguishable from a status code alone.
   */
  it('stores only the rows the question has', () => {
    const parsed = safeParseAnswers(matrixDefinition(false), {
      [MATRIX_ID]: { rows: { programm: ['gut'] } },
    });

    expect(parsed.success).toBe(true);
    const stored = parsed.data?.[MATRIX_ID];
    const rows =
      typeof stored === 'object' && stored !== null && 'rows' in stored
        ? (stored as { rows: Record<string, unknown> }).rows
        : {};
    expect(Object.keys(rows)).toEqual(['programm']);
  });
});

describe('buildAnswersSchema — Tabelle', () => {
  const TABLE_ID = '019fc000-0000-7000-8000-00000000000f';

  function tableDefinition(required: boolean, rows = 2): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Begleitpersonen',
          description: null,
          questions: [
            {
              ...base,
              required,
              rows,
              id: TABLE_ID,
              type: 'table',
              label: 'Begleitpersonen',
              columns: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'anzahl', label: 'Anzahl', type: 'number' },
                {
                  key: 'kategorie',
                  label: 'Kategorie',
                  type: 'select',
                  options: [
                    { value: 'gast', label: 'Gast' },
                    { value: 'partner', label: 'Partner/in' },
                  ],
                },
                {
                  key: 'vegetarisch',
                  label: 'Vegetarisch',
                  type: 'checkbox',
                },
              ],
            },
          ],
        },
      ],
    });
  }

  it('accepts a filled row beside an empty one', () => {
    expect(
      buildAnswersSchema(tableDefinition(true)).safeParse({
        [TABLE_ID]: {
          cells: [
            { name: 'Anna', anzahl: 1, kategorie: 'gast', vegetarisch: true },
            {},
          ],
        },
      }).success,
    ).toBe(true);
  });

  /**
   * **The mandatory rule of this type: at least one row** — deliberately the
   * opposite of the matrix, and the pair is the point. The row count is what
   * the form *offers*; demanding all of it would refuse the submission of
   * everyone who brings one companion to a table that offers three.
   */
  it('requires one filled row when required — not all of them', () => {
    const schema = buildAnswersSchema(tableDefinition(true));

    expect(
      schema.safeParse({ [TABLE_ID]: { cells: [{ name: 'Anna' }, {}] } })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ [TABLE_ID]: { cells: [{}, {}] } }).success).toBe(
      false,
    );
    expect(schema.safeParse({}).success).toBe(false);
  });

  /**
   * „Leer" has one spelling, and a box ticked and unticked again is not an
   * answer: `false` never reaches the store (`setTableCell` removes the key),
   * and a payload carrying it is refused rather than counted.
   */
  it('does not let a false Haken satisfy the Pflicht', () => {
    const schema = buildAnswersSchema(tableDefinition(true));

    expect(
      schema.safeParse({ [TABLE_ID]: { cells: [{ vegetarisch: false }, {}] } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ [TABLE_ID]: { cells: [{ name: '   ' }, {}] } })
        .success,
    ).toBe(false);
  });

  it('checks every cell against the type of its own column', () => {
    const schema = buildAnswersSchema(tableDefinition(false));
    const bad = [
      { name: 42 },
      { anzahl: 'zwei' },
      { kategorie: 'ehrengast' },
      { vegetarisch: 'ja' },
      { erfunden: 'x' },
    ];

    for (const row of bad) {
      expect(
        schema.safeParse({ [TABLE_ID]: { cells: [row, {}] } }).success,
      ).toBe(false);
    }
  });

  /**
   * Without „Zeilen ergänzbar" the row count is a property of the **form**, not
   * of the answer (a requirement, later revised): a payload with more rows than
   * the form offers is refused, because
   * the export columns are minted from the question and a third row would have
   * nowhere to go. What that revision changed is *which number* that is — see
   * „Tabelle mit ergänzbaren Zeilen" below —, never that there is one.
   */
  it('refuses more rows than the form offers', () => {
    expect(
      buildAnswersSchema(tableDefinition(false, 2)).safeParse({
        [TABLE_ID]: { cells: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      }).success,
    ).toBe(false);
  });

  it('refuses the scalar blank spellings other types accept', () => {
    const schema = buildAnswersSchema(tableDefinition(false));

    expect(schema.safeParse({ [TABLE_ID]: '' }).success).toBe(false);
    expect(schema.safeParse({ [TABLE_ID]: null }).success).toBe(false);
    // …and accepts the two shapes „leer" really has.
    expect(schema.safeParse({ [TABLE_ID]: { cells: [] } }).success).toBe(true);
    expect(schema.safeParse({ [TABLE_ID]: { cells: [{}, {}] } }).success).toBe(
      true,
    );
  });
});

/**
 * **The upper bound of the extendable table.**
 *
 * Every case here asks the **validator**, not a view: the fill-in view's „+
 * Zeile" is a convenience, and nothing forces a stranger to use it. What is
 * measured is what the three write paths accept — `safeParseAnswers` for the
 * Absendung and the Korrektur, `safeParseDraftAnswers` for the draft.
 */
describe('buildAnswersSchema — Tabelle mit ergänzbaren Zeilen', () => {
  const TABLE_ID = '019fc000-0000-7000-8000-00000000000f';

  function growable(
    rows: number,
    addRows: { maxRows: number } | undefined,
    required = false,
  ): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Begleitpersonen',
          description: null,
          questions: [
            {
              ...base,
              required,
              rows,
              id: TABLE_ID,
              type: 'table',
              label: 'Begleitpersonen',
              ...(addRows === undefined ? {} : { addRows }),
              columns: [{ key: 'name', label: 'Name', type: 'text' }],
            },
          ],
        },
      ],
    });
  }

  /** `n` filled rows — the shape a fill-in view produces after „+ Zeile". */
  function filled(count: number): Record<string, unknown> {
    return {
      [TABLE_ID]: {
        cells: Array.from({ length: count }, (_, index) => ({
          name: `Person ${String(index + 1)}`,
        })),
      },
    };
  }

  /** The same, but every row untouched — a **blank** answer of `count` rows. */
  function empty(count: number): Record<string, unknown> {
    return {
      [TABLE_ID]: { cells: Array.from({ length: count }, () => ({})) },
    };
  }

  it('accepts more rows than the form starts with, up to the Obergrenze', () => {
    const definition = growable(2, { maxRows: 5 });

    expect(safeParseAnswers(definition, filled(3)).success).toBe(true);
    expect(safeParseAnswers(definition, filled(5)).success).toBe(true);
    expect(safeParseAnswers(definition, filled(6)).success).toBe(false);
  });

  /**
   * **The reason travels along, and machine-readably at that** . `path`
   * names the question, `params.code` names the rule: a caller can tell „zu
   * viele Zeilen" from „unbekannte Spalte" without matching on a German
   * sentence. The message is asserted too, because it is what the participant
   * reads and it has to name the number that actually applies — the
   * Obergrenze, not the Startzeilen.
   */
  it('names the rule and the number it enforced', () => {
    const result = safeParseAnswers(growable(2, { maxRows: 5 }), filled(9));

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(
      (candidate) => candidate.path.join('.') === `${TABLE_ID}.cells`,
    );
    expect(issue?.message).toBe('Höchstens 5 Zeilen.');
    expect(issue?.code === 'custom' ? issue.params?.code : undefined).toBe(
      TABLE_ROW_LIMIT_CODE,
    );
  });

  /**
   * **The draft path is the cheapest way of attack** (reproduction): it
   * knows neither deadline nor answer limit, so a bound that the submission
   * carries and the draft does not is a bound with a door beside it.
   */
  it('bounds the Entwurf exactly as it bounds the Absendung', () => {
    const definition = growable(2, { maxRows: 5 }, true);

    expect(safeParseDraftAnswers(definition, filled(5)).success).toBe(true);
    expect(safeParseDraftAnswers(definition, filled(6)).success).toBe(false);
    expect(safeParseDraftAnswers(definition, empty(6)).success).toBe(false);
  });

  /**
   * **An empty row is a row too** — the hole this package closed,
   * measured on 2026-08-06 **before** the fix: a table with two rows accepted
   * `{cells: [{} × 5000]}` on the optional path and on the draft path,
   * because a blank answer matches `blankSchemaFor` and never reaches the
   * filled schema where the bound used to live. A payload does not have to
   * write anything into a row to make it cost.
   */
  it('refuses a flood of empty rows on every path', () => {
    const fixed = growable(2, undefined);
    const grows = growable(2, { maxRows: 5 });

    expect(safeParseAnswers(fixed, empty(5000)).success).toBe(false);
    expect(safeParseDraftAnswers(fixed, empty(5000)).success).toBe(false);
    expect(safeParseAnswers(grows, empty(5000)).success).toBe(false);
    expect(safeParseDraftAnswers(grows, empty(5000)).success).toBe(false);
    // …and the blank shapes that are *within* the bound still parse, on both
    // sides of the union: „leer" did not become an error.
    expect(safeParseAnswers(grows, empty(5)).success).toBe(true);
    expect(safeParseAnswers(fixed, empty(2)).success).toBe(true);
  });

  /**
   * **The bound of the *Pflicht* table** (security review).
   *
   * Every other case in this file uses `required: false` or the draft path,
   * and both go through the pre-union hook. A **Pflicht** table does not: the
   * Pflicht branch of `fieldSchemaFor` returns before the hook is ever built, so
   * the `checkRowCount` call inside `tableAnswerSchema` is not a second opinion
   * there — it is the **only** bound. *Measured on 2026-08-07:* removing that
   * call left all 1362 shared tests and `table-rows.spec.ts` green, and a
   * mandatory table with `rows: 2` accepted three rows. This case is what turns
   * red.
   */
  it('refuses more rows than a Pflicht-Tabelle offers', () => {
    const definition = growable(2, undefined, true);

    expect(safeParseAnswers(definition, filled(2)).success).toBe(true);

    const result = safeParseAnswers(definition, filled(3));
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(
      (candidate) => candidate.path.join('.') === `${TABLE_ID}.cells`,
    );
    expect(issue?.message).toBe('Höchstens 2 Zeilen.');
    expect(issue?.code === 'custom' ? issue.params?.code : undefined).toBe(
      TABLE_ROW_LIMIT_CODE,
    );

    // …and the same limit on an extendable mandatory table, so that the case
    // does not only prove „ohne addRows".
    expect(
      safeParseAnswers(growable(2, { maxRows: 5 }, true), filled(6)).success,
    ).toBe(false);
  });

  /**
   * An older table — no `addRows` — keeps the row count it had. Stated over
   * the **validator** rather than over the schema alone, because „verhält sich
   * wie nicht ergänzbar" is a statement about what it accepts.
   */
  it('leaves a form without the new field exactly as it was', () => {
    const definition = growable(2, undefined);

    expect(safeParseAnswers(definition, filled(2)).success).toBe(true);
    expect(safeParseAnswers(definition, filled(3)).success).toBe(false);
  });
});

/**
 * A payload whose **shape** is wrong must come back as a 400, never as a crash
 * — found by a review and **measured** on the public route
 * (2026-07-31): a required table answered with `{"cells": "x"}` returned
 * **500**, because `buildAnswersSchema` runs `isBlankAnswer` on the *raw* body
 * before any schema sees it, the `is…Answer` guards narrow on a key rather than
 * on a shape, and a `TypeError` thrown inside a Zod refinement is not caught by
 * `safeParse`.
 *
 * The bug predates this package: an **Adresse** does the same with
 * `{"street": 5, …}` (shipped), and a choice answer with
 * `{"other": 5}`. All three are covered here, because the fix is one rule in
 * one function and a test for only the new instance would leave the old ones
 * looking checked.
 */
describe('a required question survives an answer of the wrong shape', () => {
  const STRUCTURED = '019fc000-0000-7000-8000-00000000001a';

  function requiredQuestion(shape: Record<string, unknown>): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Pflicht',
          description: null,
          questions: [{ ...base, required: true, id: STRUCTURED, ...shape }],
        },
      ],
    });
  }

  const table = requiredQuestion({
    type: 'table',
    label: 'Begleitpersonen',
    columns: [{ key: 'name', label: 'Name', type: 'text' }],
    rows: 2,
  });
  const matrix = requiredQuestion({
    type: 'matrix',
    label: 'Bewertung',
    rows: [{ value: 'organisation', label: 'Organisation' }],
    columns: [{ value: 'gut', label: 'Gut' }],
    multiple: false,
  });
  const address = requiredQuestion({ type: 'address', label: 'Anschrift' });
  const choice = requiredQuestion({
    type: 'radio',
    label: 'Teilnahme',
    options,
    allowOther: true,
    otherLabel: 'Sonstiges',
  });

  it.each([
    ['a table whose cells are a string', table, { cells: 'x' }],
    ['a table whose cells are a number', table, { cells: 5 }],
    ['a table row that is null', table, { cells: [null] }],
    ['a matrix whose rows are a string', matrix, { rows: 'x' }],
    ['a matrix whose rows are null', matrix, { rows: null }],
    ['a matrix row that is not a list', matrix, { rows: { organisation: 5 } }],
    [
      'an address subfield that is a number',
      address,
      { street: 5, zip: '', city: '', country: '' },
    ],
    [
      'a choice whose values are a string',
      choice,
      { values: 'a', other: null },
    ],
    [
      'a choice whose „Sonstiges" is a number',
      choice,
      { values: [], other: 5 },
    ],
  ])('refuses %s without throwing', (_name, definition, answer) => {
    const run = (): boolean =>
      safeParseAnswers(definition, { [STRUCTURED]: answer }).success;

    expect(run).not.toThrow();
    expect(run()).toBe(false);
  });
});

describe('isBlankAnswer', () => {
  it('treats undefined, null, empty and whitespace strings as unanswered', () => {
    expect(isBlankAnswer(undefined)).toBe(true);
    expect(isBlankAnswer(null)).toBe(true);
    expect(isBlankAnswer('')).toBe(true);
    expect(isBlankAnswer('  \t ')).toBe(true);
  });

  it('treats an empty selection as unanswered but zero as an answer', () => {
    expect(isBlankAnswer(empty)).toBe(true);
    // Zero is a number someone typed. Reading it as "blank" is the classic
    // falsy-value bug, and on a Semesterzahl it silently drops a real answer.
    expect(isBlankAnswer(0)).toBe(false);
  });

  /**
   * `other: ''` and `other: null` say different things — „das Freitextfeld ist
   * sichtbar und leer" against „kein Freitext im Spiel" — and the difference is
   * worth keeping in the stored answer. For *blankness* they mean the same:
   * nobody chose anything and nobody wrote anything. Reading only `null` as
   * blank let a required choice question be submitted empty, and the export
   * showed a cell nobody could tell from a question that was never asked.
   */
  it('treats an empty selection with an empty „Sonstiges" as unanswered', () => {
    expect(isBlankAnswer({ values: [], other: '' })).toBe(true);
    expect(isBlankAnswer({ values: [], other: null })).toBe(true);
    // Whitespace, exactly as for a string answer: a space bar is not an answer.
    expect(isBlankAnswer({ values: [], other: '   ' })).toBe(true);
  });

  /**
   * The two structured shapes: „leer" for a **Matrix** is
   * „keine Zeile trägt eine Auswahl" — not „nicht jede Zeile", which is the
   * *Pflicht* rule and a different question (`matrixAnswerSchema`).
   */
  it('treats a matrix as unanswered only while no row carries a pick', () => {
    expect(isBlankAnswer({ rows: {} })).toBe(true);
    expect(isBlankAnswer({ rows: { organisation: [] } })).toBe(true);
    expect(isBlankAnswer({ rows: { organisation: ['gut'] } })).toBe(false);
  });

  /**
   * And „leer" for a **table** is „keine Zelle trägt etwas" — with `false`
   * counting as nothing, because a Haken stores `true` or nothing at all: a
   * box ticked and unticked again is not an answer, and letting it satisfy a
   * Pflicht table would be the `other: ''` hole one type further along.
   */
  it('treats a table as unanswered while every cell is empty, false included', () => {
    expect(isBlankAnswer({ cells: [] })).toBe(true);
    expect(isBlankAnswer({ cells: [{}, {}] })).toBe(true);
    expect(isBlankAnswer({ cells: [{ name: '   ' }] })).toBe(true);
    expect(isBlankAnswer({ cells: [{ vegetarisch: false }] })).toBe(true);
    expect(isBlankAnswer({ cells: [{ vegetarisch: true }] })).toBe(false);
    // Zero is a number someone typed — the same rule as for a Zahl answer.
    expect(isBlankAnswer({ cells: [{ anzahl: 0 }] })).toBe(false);
  });

  it('treats a selection as answered even next to an empty „Sonstiges"', () => {
    expect(isBlankAnswer({ values: ['a'], other: '' })).toBe(false);
    expect(isBlankAnswer({ values: [], other: 'per Bahn' })).toBe(false);
  });

  /**
   * Blank means **all four** subfields, Land included — a
   * Land typed on its own is an answer, even though it is never required.
   */
  it('treats an address as unanswered only while every subfield is', () => {
    expect(isBlankAnswer({ street: '', zip: '', city: '', country: '' })).toBe(
      true,
    );
    expect(
      isBlankAnswer({ street: '  ', zip: '', city: '', country: '\t' }),
    ).toBe(true);
    expect(
      isBlankAnswer({
        street: '',
        zip: '',
        city: '',
        country: 'Deutschland',
      }),
    ).toBe(false);
    expect(
      isBlankAnswer({
        street: 'Musterstraße 12',
        zip: '',
        city: '',
        country: '',
      }),
    ).toBe(false);
  });
});

/**
 * The finding this describes: a **required** choice question with
 * „Sonstiges" was accepted with nothing chosen and nothing typed, because the
 * fill-in view sends `other: ''` for a visible-but-empty free-text field. What
 * was stored was `{"other": "", "values": []}` and what the export showed was a
 * blank cell. It is not the dropdown's bug — every choice type shares one
 * answer shape and therefore shared the hole.
 */
describe('a required choice question with „Sonstiges" cannot be left empty', () => {
  function requiredChoice(
    type: 'select' | 'radio' | 'checkbox',
  ): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Pflicht',
          questions: [
            {
              ...base,
              required: true,
              id: ids[type],
              type,
              label: 'Anreise',
              options,
              allowOther: true,
              otherLabel: 'Sonstiges',
              ...(type === 'checkbox'
                ? { minSelected: null, maxSelected: null }
                : {}),
            },
          ],
        },
      ],
    });
  }

  it.each(['select', 'radio', 'checkbox'] as const)(
    '%s refuses an empty selection with an empty free text',
    (type) => {
      const schema = buildAnswersSchema(requiredChoice(type));

      expect(
        schema.safeParse({ [ids[type]]: { values: [], other: '' } }),
      ).toMatchObject({ success: false });
      expect(
        schema.safeParse({ [ids[type]]: { values: [], other: '   ' } }),
      ).toMatchObject({ success: false });
      expect(
        schema.safeParse({ [ids[type]]: { values: [], other: null } }),
      ).toMatchObject({ success: false });
    },
  );

  it.each(['select', 'radio', 'checkbox'] as const)(
    '%s still accepts a real answer, whichever way it was given',
    (type) => {
      const schema = buildAnswersSchema(requiredChoice(type));

      expect(
        schema.safeParse({ [ids[type]]: { values: ['a'], other: null } })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ [ids[type]]: { values: [], other: 'per Bahn' } })
          .success,
      ).toBe(true);
    },
  );

  it('reports the empty free text as „Pflichtfeld", not as a shape error', () => {
    const result = buildAnswersSchema(requiredChoice('select')).safeParse({
      [ids.select]: { values: [], other: '' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Pflichtfeld.');
  });
});

/**
 * The same hole one door further along: `required` had learnt that an empty
 * „Sonstiges" box is not an answer, `minSelected` had not. Counting the mere
 * presence of the box let one real tick plus an untouched free-text field pass
 * „Mindestens 2 Auswahlen" — a bound the builder set and a participant was
 * never actually held to.
 *
 * One count serves all three bounds, so the upper one is asserted here too: a
 * rule that reads emptiness differently from `isBlankAnswer` is the defect,
 * not the individual number.
 */
describe('choice bounds count a „Sonstiges" box only once something is typed', () => {
  function boundedCheckbox(bounds: {
    minSelected: number | null;
    maxSelected: number | null;
  }): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Grenzen',
          questions: [
            {
              ...base,
              id: ids.checkbox,
              type: 'checkbox',
              label: 'Tage',
              options,
              allowOther: true,
              otherLabel: 'Sonstiges',
              ...bounds,
            },
          ],
        },
      ],
    });
  }

  const min2 = { minSelected: 2, maxSelected: null };

  it('refuses one selection plus an empty free text under „Mindestens 2"', () => {
    const schema = buildAnswersSchema(boundedCheckbox(min2));

    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a'], other: '' } }),
    ).toMatchObject({ success: false });
    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a'], other: '   ' } }),
    ).toMatchObject({ success: false });
  });

  it('accepts one selection plus a free text that was actually filled in', () => {
    const schema = buildAnswersSchema(boundedCheckbox(min2));

    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a'], other: 'per Bahn' } })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a', 'b'], other: null } })
        .success,
    ).toBe(true);
  });

  it('counts a filled free text towards the upper bound as well', () => {
    const schema = buildAnswersSchema(
      boundedCheckbox({ minSelected: null, maxSelected: 2 }),
    );

    expect(
      schema.safeParse({
        [ids.checkbox]: { values: ['a', 'b'], other: 'per Bahn' },
      }),
    ).toMatchObject({ success: false });
    // The same two ticks with an untouched box are two selections, not three.
    expect(
      schema.safeParse({ [ids.checkbox]: { values: ['a', 'b'], other: '' } })
        .success,
    ).toBe(true);
  });
});

/**
 * The shape schema behind {@link answerValueSchema} — the middle ground the
 * edit view needs.
 *
 * It is **not** a substitute for `buildAnswersSchema`: it knows nothing about
 * the question an answer belongs to and refuses nothing a question would. Its
 * one job is to say whether a value out of the JSONB column is *a* possible
 * answer at all, so a stored object cannot reach an `<input>` unchecked while a
 * snapshot whose rules have since tightened still renders.
 */
describe('answerValueSchema (the edit view)', () => {
  it('accepts every shape an answer can have', () => {
    for (const value of [
      'Anton',
      42,
      null,
      { values: ['vegetarisch'], other: null },
      { values: [], other: 'Etwas anderes' }, // The fourth shape `AnswerValue` can hold.
      {
        street: 'Musterstraße 12',
        zip: '01067',
        city: 'Dresden',
        country: 'Deutschland',
      },
    ]) {
      expect(answerValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses what is not an answer at all', () => {
    for (const value of [
      true,
      ['Anton'],
      { question: 'Name' },
      { values: [1, 2], other: null },
      { values: ['ok'] },
      // Missing subfields — the shape a `ChoiceAnswer` would leave behind.
      { street: 'Musterstraße 12', zip: '01067' },
      undefined,
    ]) {
      expect(answerValueSchema.safeParse(value).success).toBe(false);
    }
  });

  /**
   * The union and the type it recognises are written **once**. Two spellings of
   * „what an answer is" would drift, and the one that drifts is the one facing
   * whatever a restore wrote into the column.
   */
  it('is the schema of AnswerValue, not a second description of it', () => {
    const fromSchema: AnswerValue = answerValueSchema.parse('Anton');
    expect(fromSchema).toBe('Anton');
  });
});

/**
 * **`other: ''` and `other: null` are *one* form.**
 *
 * The double spelling has long been in the JSONB column.
 * It was argued for at `isBlankAnswer` as a *meaning* — „das
 * Freitextfeld ist sichtbar und leer" against „kein Freitext im Spiel" — and
 * that argument was measured against every reader before it was given up:
 * `formatAnswerCell` (responses table, export **and** mail body),
 * `isBlankAnswer`, the selection count of a choice question, the blank schema
 * and the change block of an edit mail all collapse the two by hand. What is
 * left is the control state the edit view rebuilds from it, and for a
 * *required* question that state cannot be stored at all.
 *
 * So the rule is stated **once, at the writer**: everything that goes through
 * the validator comes out canonical. Just as important: `''` keeps
 * being *read*, because the column
 * is full of it.
 */
describe('the canonical form of an empty „Sonstiges"', () => {
  const CHOICE = ids.checkbox;

  /** One question, „Sonstiges" switchable — the whole surface of the rule. */
  function choiceForm(options: {
    required?: boolean;
    allowOther?: boolean;
  }): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Anreise',
          questions: [
            {
              ...base,
              required: options.required ?? false,
              id: CHOICE,
              type: 'checkbox',
              label: 'Anreise',
              options: [
                { value: 'a', label: 'Aktiv' },
                { value: 'b', label: 'Inaktiv' },
              ],
              allowOther: options.allowOther ?? true,
              otherLabel: options.allowOther === false ? null : 'Sonstiges',
              minSelected: null,
              maxSelected: null,
            },
          ],
        },
      ],
    });
  }

  function parsedAnswer(
    form: FormDefinition,
    value: unknown,
  ): AnswerValue | undefined {
    const result = safeParseAnswers(form, { [CHOICE]: value });
    expect(result.success).toBe(true);
    return result.data?.[CHOICE];
  }

  /**
   * The three shapes a fill-in view really produces for a ticked-and-empty
   * box, and all three are reachable: an optional question with nothing else
   * chosen, an optional one with an option chosen beside it, and a **required**
   * one — which the coarse `isBlankAnswer` check lets through precisely
   * because an option *is* selected.
   */
  it.each([
    ['nichts gewählt, Kasten leer', { required: false }, { values: [] }],
    ['Option gewählt, Kasten leer', { required: false }, { values: ['a'] }],
    ['Pflichtfrage, Kasten leer', { required: true }, { values: ['a'] }],
  ])('writes %s as other: null', (_name, formOptions, answer) => {
    expect(
      parsedAnswer(choiceForm(formOptions), { ...answer, other: '' }),
    ).toEqual({ ...answer, other: null });
  });

  /**
   * **The required case is why the rule sits on the whole object.** A required
   * answer is validated with `z.unknown().superRefine`, which returns its
   * *input*; a transform on the filled schema would canonicalise the two
   * optional rows above and leave this one spelled `''`.
   */
  it('canonicalises a required answer, which returns its raw input', () => {
    const result = safeParseAnswers(choiceForm({ required: true }), {
      [CHOICE]: { values: ['a'], other: '   ' },
    });

    expect(result.data?.[CHOICE]).toEqual({ values: ['a'], other: null });
  });

  it('reads whitespace as „kein Freitext", the way every other rule here does', () => {
    expect(
      parsedAnswer(choiceForm({}), { values: ['a'], other: ' \t ' }),
    ).toEqual({ values: ['a'], other: null });
  });

  /**
   * The other direction, and the one a blanket `other: null` would break: a
   * free text somebody wrote is stored **as written**, leading and trailing
   * spaces included. The rule spells „leer", it does not repair input.
   */
  it('leaves a real free text alone, untrimmed', () => {
    expect(
      parsedAnswer(choiceForm({}), { values: [], other: ' per Bahn ' }),
    ).toEqual({ values: [], other: ' per Bahn ' });
  });

  /**
   * **Legacy data, and the reason this is not merely cosmetic.** A row written
   * before the `other: null` decision carries `other: ''`. Should the editor since have switched
   * „Sonstiges" off, `choiceAnswerSchema` refuses any non-null `other` — so
   * that row used to fail its own edit view: the participant could open the
   * correction form and never save it. Canonicalising ahead of the rules is
   * what makes it readable again.
   */
  it('lets an old other: "" through on a question whose „Sonstiges" was switched off', () => {
    const form = choiceForm({ allowOther: false });

    expect(parsedAnswer(form, { values: ['a'], other: '' })).toEqual({
      values: ['a'],
      other: null,
    });
    // The rule itself is untouched: a free text really written for a question
    // that does not offer one is still refused.
    expect(
      safeParseAnswers(form, { [CHOICE]: { values: ['a'], other: 'per Bahn' } })
        .success,
    ).toBe(false);
  });

  /** Nothing else is collapsed — `canonicalAnswerValue` touches one key. */
  it.each([
    ['ein Textwert', 'Anton'],
    ['eine Zahl', 4],
    ['null', null],
    ['eine Adresse', { street: '', zip: '', city: '', country: '' }],
    ['eine Matrix', { rows: { organisation: [] } }],
    ['eine Tabelle', { cells: [{ name: '' }] }],
    ['ein fremdes Dokument', { irgendwas: '' }],
    ['ein Array', ['']],
  ])('leaves %s untouched', (_name, value) => {
    expect(canonicalAnswerValue(value)).toEqual(value);
  });

  /** An absent `other` is not invented — the write path stays as strict as it was. */
  it('does not add an „other" key that was never sent', () => {
    expect(canonicalAnswerValue({ values: ['a'] })).toEqual({ values: ['a'] });
    expect(
      safeParseAnswers(choiceForm({}), { [CHOICE]: { values: ['a'] } }).success,
    ).toBe(false);
  });
});

/**
 * **A draft is half filled in, and nothing else.**
 *
 * The one rule `safeParseDraftAnswers` lifts is Pflicht. Every assertion here
 * comes in the shape „the submission refuses it *and* the draft does too",
 * because that pairing is the whole risk of this function: a draft path that
 * quietly stopped checking types would be the way to put into a JSONB column
 * what a submission would never accept — and it would look green from the one
 * side that only tests the happy path.
 */
describe('safeParseDraftAnswers — the half-filled form', () => {
  const DRAFT_TEXT = ids.text;

  function pflicht(): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Pflicht',
          questions: [
            {
              ...base,
              required: true,
              id: DRAFT_TEXT,
              type: 'text',
              label: 'Kürzel',
              minLength: 2,
              maxLength: 4,
              pattern: '^[A-Z]+$',
            },
            {
              ...base,
              required: true,
              id: ids.number,
              type: 'number',
              label: 'Semester',
              min: 1,
              max: 30,
              integer: true,
            },
          ],
        },
      ],
    });
  }

  it('accepts a document that leaves every Pflichtfrage empty', () => {
    const form = pflicht();
    expect(safeParseAnswers(form, {}).success).toBe(false);
    expect(safeParseDraftAnswers(form, {}).success).toBe(true);
  });

  it('accepts one answered Pflichtfrage beside one that is still blank', () => {
    const form = pflicht();
    const half = { [DRAFT_TEXT]: 'ABC' };
    expect(safeParseAnswers(form, half).success).toBe(false);
    expect(safeParseDraftAnswers(form, half).success).toBe(true);
  });

  /**
   * The half that matters: a value that **is** there meets its own rules, on a
   * Pflichtfrage as much as on an optional one. Without this the draft route
   * would be a way to store `zzz` under a question whose Muster is `^[A-Z]+$`
   * and a 99 under a Semester that ends at 30 — and the submission out of that
   * draft would then refuse the answers the participant was shown.
   */
  it('still holds a value that is there to its type and its bounds', () => {
    const form = pflicht();
    for (const answers of [
      { [DRAFT_TEXT]: 'abc' }, // against the pattern
      { [DRAFT_TEXT]: 'A' }, // under minLength
      { [DRAFT_TEXT]: 'ABCDE' }, // over maxLength
      { [ids.number]: 99 }, // over max
      { [ids.number]: 2.5 }, // not an integer
      { [DRAFT_TEXT]: 42 }, // not a string at all
    ]) {
      expect(safeParseDraftAnswers(form, answers).success).toBe(false);
    }
  });

  it('still refuses a key for a question this form does not have', () => {
    expect(
      safeParseDraftAnswers(pflicht(), {
        '019fc000-0000-7000-8000-0000000000ff': 'x',
      }).success,
    ).toBe(false);
  });

  /**
   * The conditions run on a draft as they do on a submission — the value of a
   * hidden question is dropped rather than stored. „Halb ausgefüllt" must not
   * become „was der Absender schickt, landet in der Spalte".
   */
  it('discards the answer of a question the conditions hide', () => {
    const SOURCE = ids.radio;
    const TARGET = ids.textarea;
    const form = parseFormDefinition({
      pages: [
        {
          id: P,
          title: 'Bedingt',
          questions: [
            {
              ...base,
              id: SOURCE,
              type: 'radio',
              label: 'Teilnahme',
              options,
              allowOther: false,
              otherLabel: null,
            },
            {
              ...base,
              id: TARGET,
              type: 'textarea',
              label: 'Bemerkung',
              minLength: null,
              maxLength: 20,
              visibleIf: {
                questionId: SOURCE,
                operator: 'equals',
                value: 'a',
              },
            },
          ],
        },
      ],
    });

    const parsed = safeParseDraftAnswers(form, {
      [SOURCE]: { values: ['b'], other: null },
      [TARGET]: 'unsichtbar',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data)).not.toContain(TARGET);
  });

  /** The canonical form applies here too — one spelling, both paths. */
  it('canonicalises an empty „Sonstiges" like a submission does', () => {
    const CHOICE = ids.radio;
    const form = definition();
    const parsed = safeParseDraftAnswers(form, {
      [CHOICE]: { values: ['a'], other: '' },
    });
    expect(parsed.success && parsed.data[CHOICE]).toEqual({
      values: ['a'],
      other: null,
    });
  });

  /**
   * **The mandatory check was skipped only at the topmost level** (a review finding).
   *
   * Four types read `question.required` *inside* the answer, past the
   * blank/filled fork the flag used to stop at — and a half-typed one of them is
   * not blank, so it went through the fork and was refused behind it. That is
   * the state a participant reaches by typing their street and stopping.
   *
   * *Reproduction:* remove the `enforceRequired` in `addressAnswerSchema`,
   * `matrixAnswerSchema` or `tableAnswerSchema` again → the corresponding case
   * below goes red, and with exactly the message that arrived on the route as
   * a 400.
   */
  describe('the Pflicht rule inside a composite answer', () => {
    const STRUCTURED = '019fc000-0000-7000-8000-00000000002a';

    function pflichtQuestion(shape: Record<string, unknown>): FormDefinition {
      return parseFormDefinition({
        pages: [
          {
            id: P,
            title: 'Pflicht',
            description: null,
            questions: [{ ...base, required: true, id: STRUCTURED, ...shape }],
          },
        ],
      });
    }

    const address = pflichtQuestion({ type: 'address', label: 'Anschrift' });
    const matrix = pflichtQuestion({
      type: 'matrix',
      label: 'Bewertung',
      rows: [
        { value: 'organisation', label: 'Organisation' },
        { value: 'programm', label: 'Programm' },
      ],
      columns: [{ value: 'gut', label: 'Gut' }],
      multiple: false,
    });
    const table = pflichtQuestion({
      type: 'table',
      label: 'Begleitpersonen',
      columns: [{ key: 'name', label: 'Name', type: 'text' }],
      rows: 2,
    });

    it.each([
      [
        'eine halb getippte Adresse',
        address,
        { street: 'Hauptstraße 1', zip: '', city: '', country: 'Deutschland' },
      ],
      [
        'eine Matrix mit einer offenen Zeile',
        matrix,
        { rows: { organisation: ['gut'], programm: [] } },
      ],
      [
        'eine Tabelle, in der eine Zelle wieder geleert wurde',
        table,
        { cells: [{ name: '' }] },
      ],
    ])('nimmt %s an, die eine Absendung ablehnt', (_name, form, answer) => {
      expect(safeParseAnswers(form, { [STRUCTURED]: answer }).success).toBe(
        false,
      );
      expect(
        safeParseDraftAnswers(form, { [STRUCTURED]: answer }).success,
      ).toBe(true);
    });

    /**
     * The other half, and the one that keeps the relaxation honest: what is
     * *there* still meets its own rules. „Pflicht gilt nicht" must not become
     * „an einer Adresse wird nichts geprüft".
     */
    it.each([
      [
        'eine Adresse mit einer zu langen Straße',
        address,
        { street: 'x'.repeat(301), zip: '', city: '', country: '' },
      ],
      [
        'eine Matrix mit einer unbekannten Option',
        matrix,
        { rows: { organisation: ['nie-gehört'] } },
      ],
      [
        'eine Tabelle mit einer unbekannten Spalte',
        table,
        { cells: [{ hausnummer: '7' }] },
      ],
      [
        'eine Tabelle mit mehr Zeilen, als das Formular anbietet',
        table,
        { cells: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      ],
    ])('lehnt %s auch im Entwurf ab', (_name, form, answer) => {
      expect(
        safeParseDraftAnswers(form, { [STRUCTURED]: answer }).success,
      ).toBe(false);
    });
  });
});
