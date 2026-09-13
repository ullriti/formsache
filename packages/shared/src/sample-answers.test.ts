import { describe, expect, it } from 'vitest';

import {
  parseFormDefinition,
  questionTypeSchema,
  type FormDefinition,
} from './form-schema.ts';
import {
  answerSchemaFor,
  buildAnswersSchema,
  isBlankAnswer,
} from './response-validation.ts';
import { sampleAnswers } from './sample-answers.ts';

/**
 * The sample-value generator of the test mode.
 *
 * The three assurances of this file fulfil the requirement, and the middle one
 * is the actual work:
 *
 * 1. **All question types.** Not „a few" — the list that is checked against
 *    comes from {@link questionTypeSchema} and not from a literal here, so
 *    that a seventeenth question type makes this test red instead of running
 *    through unnoticed.
 * 2. **Checking happens through `answerSchemaFor`**, not through a rebuild of
 *    the rules — and additionally the whole document through
 *    `buildAnswersSchema`, because only there do mandatoriness, conditions and
 *    `.strict()` come together.
 * 3. **Run twice, the same values.**
 *
 * And the case that is easily swallowed: a field whose rules contradict each
 * other is **named instead of filled**.
 */

const PAGE = '019fc000-0000-7000-8000-0000000000e0';

const base = { hint: null, required: true, width: 'full' } as const;

const options = [
  { value: 'ja', label: 'Ja' },
  { value: 'nein', label: 'Nein' },
];

/**
 * A form with **every** question type, every question mandatory and every rule
 * the type can carry switched on.
 *
 * Mandatory everywhere, because that is the strictest reading: a value that
 * satisfies a mandatory question satisfies the same question all the more when
 * it is optional — and the reverse test would have checked nothing at all for
 * the four types with mandatoriness *inside* the answer (address, matrix,
 * table, event).
 */
function everyTypeDefinition(): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Alle Typen',
        description: null,
        questions: [
          {
            ...base,
            id: id(1),
            type: 'text',
            label: 'Kürzel',
            minLength: 2,
            maxLength: 40,
            pattern: null,
          },
          {
            ...base,
            id: id(2),
            type: 'textarea',
            label: 'Anmerkungen',
            minLength: 20,
            maxLength: 500,
          },
          {
            ...base,
            id: id(3),
            type: 'number',
            label: 'Semester',
            min: 3,
            max: 12,
            integer: true,
          },
          {
            ...base,
            id: id(4),
            type: 'date',
            label: 'Anreise',
            minDate: '2026-05-01',
            maxDate: '2026-05-31',
          },
          { ...base, id: id(5), type: 'email', label: 'E-Mail' },
          { ...base, id: id(6), type: 'phone', label: 'Telefon' },
          {
            ...base,
            id: id(7),
            type: 'select',
            label: 'Liste',
            options,
            allowOther: false,
            otherLabel: null,
          },
          {
            ...base,
            id: id(8),
            type: 'radio',
            label: 'Optionsfeld',
            options,
            allowOther: true,
            otherLabel: 'Sonstiges',
          },
          {
            ...base,
            id: id(9),
            type: 'checkbox',
            label: 'Mehrfachauswahl',
            options,
            allowOther: false,
            otherLabel: null,
            minSelected: 2,
            maxSelected: 2,
          },
          { ...base, id: id(10), type: 'rating', label: 'Bewertung', max: 6 },
          { ...base, id: id(11), type: 'info', label: 'Bitte pünktlich sein.' },
          { ...base, id: id(12), type: 'address', label: 'Anschrift' },
          {
            ...base,
            id: id(13),
            type: 'matrix',
            label: 'Matrix',
            rows: [
              { value: 'organisation', label: 'Organisation' },
              { value: 'programm', label: 'Programm' },
            ],
            columns: [
              { value: 'gut', label: 'Gut' },
              { value: 'schlecht', label: 'Schlecht' },
            ],
            multiple: false,
          },
          {
            ...base,
            id: id(14),
            type: 'table',
            label: 'Begleitpersonen',
            rows: 3,
            columns: [
              { key: 'name', label: 'Name', type: 'text' },
              { key: 'anzahl', label: 'Anzahl', type: 'number' },
              {
                key: 'essen',
                label: 'Essen',
                type: 'select',
                options: [{ value: 'vegan', label: 'Vegan' }],
              },
              { key: 'kommt', label: 'Kommt', type: 'checkbox' },
            ],
          },
          {
            ...base,
            id: id(15),
            type: 'file',
            label: 'Nachweis',
            maxFiles: 2,
          },
          {
            ...base,
            id: id(16),
            type: 'event',
            label: 'Veranstaltungen',
            events: [
              {
                key: 'sommerfest',
                label: 'Sommerfest',
                when: 'Fr, 19:00',
                capacity: 80,
                showRemaining: true,
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
        ],
      },
    ],
  });
}

function id(n: number): string {
  return `019fc000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** One question in a form of its own — for the special cases below. */
function oneQuestion(question: Record<string, unknown>): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Eine Frage',
        description: null,
        questions: [question],
      },
    ],
  });
}

describe('sampleAnswers — jeder Fragetyp ', () => {
  const definition = everyTypeDefinition();
  const generated = sampleAnswers(definition);

  it('lässt kein Feld offen', () => {
    expect(generated.unfillable).toEqual([]);
  });

  it('deckt jeden Fragetyp der Wahrheit ab', () => {
    // The list comes from the schema, not from this test: a new question type
    // missing in `everyTypeDefinition` makes this line red.
    const covered = new Set(
      definition.pages[0]?.questions.map((question) => question.type),
    );
    expect([...questionTypeSchema.options].sort()).toEqual([...covered].sort());
  });

  it('erzeugt für jede beantwortbare Frage einen Wert, den ihr eigenes Schema annimmt', () => {
    for (const question of definition.pages[0]?.questions ?? []) {
      if (question.type === 'info') {
        continue;
      }
      const value = generated.answers[question.id];
      // Not empty — otherwise a mandatory question would fail at
      // `isBlankAnswer` before any schema sees it.
      expect(isBlankAnswer(value), question.label).toBe(false);
      // **Through `answerSchemaFor`**, as intended — no rebuild of the rules
      // in this test.
      const parsed = answerSchemaFor(question, true).safeParse(value);
      expect(
        parsed.success,
        `${question.label}: ${JSON.stringify(value)}`,
      ).toBe(true);
    }
  });

  it('gibt einem Infotext keinen Schlüssel', () => {
    // Not „an empty value": `buildAnswersSchema` knows no key at all for an
    // info text, and `.strict()` would reject the whole document.
    expect(Object.keys(generated.answers)).not.toContain(id(11));
  });

  it('läuft als ganzes Dokument durch buildAnswersSchema', () => {
    const parsed = buildAnswersSchema(definition).safeParse(generated.answers);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path),
    ).toEqual([]);
  });
});

describe('sampleAnswers — deterministisch ', () => {
  it('erzeugt zweimal dieselben Werte', () => {
    const definition = everyTypeDefinition();
    expect(sampleAnswers(definition)).toEqual(sampleAnswers(definition));
  });

  it('erzeugt sie auch für ein zweites, gleich gebautes Formular', () => {
    // Same document, parsed twice: the generator must not hang on anything
    // that differs between two calls (time of day, object identity).
    expect(sampleAnswers(everyTypeDefinition())).toEqual(
      sampleAnswers(everyTypeDefinition()),
    );
  });
});

describe('sampleAnswers — Werte, die zu den Regeln passen', () => {
  it('trifft die Längengrenzen eines Textfeldes', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'text',
      label: 'Langer Text',
      minLength: 120,
      maxLength: 140,
      pattern: null,
    });
    const value = sampleAnswers(definition).answers[id(1)];
    expect(typeof value === 'string' && value.length).toBeGreaterThanOrEqual(
      120,
    );
    expect(typeof value === 'string' && value.length).toBeLessThanOrEqual(140);
  });

  it('trifft ein Muster, das eine der üblichen Formen beschreibt', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'text',
      label: 'Postleitzahl',
      minLength: null,
      maxLength: null,
      pattern: '^\\d{5}$',
    });
    expect(sampleAnswers(definition).answers[id(1)]).toBe('70173');
  });

  it('bleibt bei einer Zahlfrage in den Grenzen', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'number',
      label: 'Semester',
      min: 100,
      max: 104,
      integer: true,
    });
    const value = sampleAnswers(definition).answers[id(1)];
    expect(value).toBe(100);
  });

  it('bleibt bei einer Datumsfrage in den Grenzen', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'date',
      label: 'Anreise',
      minDate: '2027-01-10',
      maxDate: '2027-01-20',
      pattern: null,
    });
    expect(sampleAnswers(definition).answers[id(1)]).toBe('2027-01-10');
  });

  it('setzt bei einer Mehrfachauswahl genug Häkchen — und nicht zu viele', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'checkbox',
      label: 'Mahlzeiten',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
      allowOther: false,
      otherLabel: null,
      minSelected: 2,
      maxSelected: 2,
    });
    const value = sampleAnswers(definition).answers[id(1)];
    expect(value).toEqual({ values: ['a', 'b'], other: null });
  });

  it('schließt eine Pflichtlücke über „Sonstiges", wenn die Optionen nicht reichen', () => {
    // `minSelected` 2 with one option is allowed, **because** „Sonstiges"
    // counts along (`checkboxQuestionSchema`). Without the free text there
    // would be no valid value — the generator has to find it, not report the
    // field.
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'checkbox',
      label: 'Mahlzeiten',
      options: [{ value: 'a', label: 'A' }],
      allowOther: true,
      otherLabel: 'Sonstiges',
      minSelected: 2,
      maxSelected: null,
    });
    const value = sampleAnswers(definition).answers[id(1)];
    expect(value).toEqual({ values: ['a'], other: 'Sonstiges Beispiel' });
  });

  it('beantwortet jede Zeile einer Pflicht-Matrix', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'matrix',
      label: 'Matrix',
      rows: [
        { value: 'r1', label: 'Eins' },
        { value: 'r2', label: 'Zwei' },
      ],
      columns: [{ value: 'c1', label: 'Gut' }],
      multiple: false,
    });
    expect(sampleAnswers(definition).answers[id(1)]).toEqual({
      rows: { r1: ['c1'], r2: ['c1'] },
    });
  });

  it('füllt bei einer Tabelle genau eine Zeile', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'table',
      label: 'Begleitung',
      rows: 5,
      columns: [{ key: 'name', label: 'Name', type: 'text' }],
    });
    expect(sampleAnswers(definition).answers[id(1)]).toEqual({
      cells: [{ name: 'Beispieltext' }],
    });
  });

  it('meldet für eine Veranstaltung genau eine Personenzahl an', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'event',
      label: 'Veranstaltungen',
      events: [
        {
          key: 'sommerfest',
          label: 'Sommerfest',
          when: null,
          capacity: 2,
          showRemaining: true,
        },
        {
          key: 'umzug',
          label: 'Umzug',
          when: null,
          capacity: null,
          showRemaining: false,
        },
      ],
    });
    // One event, not all of them — „at least one carries a number" is the
    // mandatory reading of the type. And a **number of people**, not a
    // sign-up marker. None of it is booked: the trial run does not send.
    expect(sampleAnswers(definition).answers[id(1)]).toEqual({
      seats: { sommerfest: 2 },
    });
  });

  /**
   * Follow-up work on a review finding. `eventAnswerSchema` deliberately does
   * **not** check the capacity — only the submit transaction does — so
   * „schema-valid" is a weaker promise for this one type than for the
   * remaining fifteen. Two people for an event with `capacity: 1` would be
   * exactly that: valid here, a 409 on a real submission.
   *
   * *Reproduction:* remove the `Math.min` in `sample-answers.ts` → the number
   * here is 2 again, i.e. more than the event takes at all.
   */
  it('bleibt bei einer Veranstaltung mit einem Platz bei einer Person', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'event',
      label: 'Veranstaltungen',
      events: [
        {
          key: 'empfang',
          label: 'Empfang',
          when: null,
          capacity: 1,
          showRemaining: true,
        },
      ],
    });

    expect(sampleAnswers(definition).answers[id(1)]).toEqual({
      seats: { empfang: 1 },
    });
    expect(sampleAnswers(definition).unfillable).toStrictEqual([]);
  });
});

describe('sampleAnswers — widersprüchliche Regeln werden benannt, nicht gefüllt', () => {
  it('meldet eine Ganzzahlfrage, zwischen deren Grenzen keine ganze Zahl liegt', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'number',
      label: 'Beitrag',
      min: 0.2,
      max: 0.8,
      integer: true,
    });
    const generated = sampleAnswers(definition);

    expect(generated.unfillable).toEqual([
      { questionId: id(1), label: 'Beitrag' },
    ]);
    // And **nothing** entered: a value would be the assurance the
    // specification explicitly forbids here — it swallows the finding.
    expect(id(1) in generated.answers).toBe(false);
  });

  it('meldet ein Muster, das keine der üblichen Formen trifft', () => {
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'text',
      label: 'Interne Kennung',
      minLength: null,
      maxLength: null,
      pattern: '^ZZZ[0-9]{2}QQ$',
    });
    expect(sampleAnswers(definition).unfillable).toEqual([
      { questionId: id(1), label: 'Interne Kennung' },
    ]);
  });

  it('meldet ein Muster, das mit der Mindestlänge nicht zusammengeht', () => {
    // Five digits, but at least eight characters: there is no value that
    // satisfies both. The generator cannot *prove* that — it tries its ladder
    // and reports what it could not satisfy, and that is exactly the right
    // piece of information here.
    const definition = oneQuestion({
      ...base,
      id: id(1),
      type: 'text',
      label: 'Postleitzahl',
      minLength: 8,
      maxLength: null,
      pattern: '^\\d{5}$',
    });
    expect(sampleAnswers(definition).unfillable).toEqual([
      { questionId: id(1), label: 'Postleitzahl' },
    ]);
  });

  it('füllt die übrigen Felder weiter, wenn eines nicht geht', () => {
    const definition = parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Gemischt',
          description: null,
          questions: [
            {
              ...base,
              id: id(1),
              type: 'text',
              label: 'Kennung',
              minLength: null,
              maxLength: null,
              pattern: '^ZZZ[0-9]{2}QQ$',
            },
            { ...base, id: id(2), type: 'email', label: 'E-Mail' },
          ],
        },
      ],
    });
    const generated = sampleAnswers(definition);
    expect(generated.unfillable).toHaveLength(1);
    expect(generated.answers[id(2)]).toBe('max.mustermann@example.de');
  });
});
