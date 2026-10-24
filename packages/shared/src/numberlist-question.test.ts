import { describe, expect, it } from 'vitest';

import { formatAnswerCell, questionColumns } from './answer-columns.ts';
import {
  allQuestions,
  parseFormDefinition,
  type FormDefinition,
} from './form-schema.ts';
import {
  canonicalAnswerValue,
  isBlankAnswer,
  numbersOf,
  safeParseAnswers,
  safeParseDraftAnswers,
} from './response-validation.ts';

/**
 * **Die Zahlenliste — der reduzierte Veranstaltungs-Fragetyp.**
 *
 * What sets it apart from the Veranstaltung is measured here, and in
 * particular the one rule the two do *not* share: a `0` is an answer.
 */

const PAGE = '019ff600-0000-7000-8000-0000000000a0';
const LIST = '019ff600-0000-7000-8000-000000000001';

function definitionOf(overrides: Record<string, unknown> = {}): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Seite 1',
        description: null,
        questions: [
          {
            id: LIST,
            type: 'numberlist',
            label: 'Aktivitas',
            hint: null,
            required: false,
            width: 'full',
            items: [
              { key: 'fuexe', label: '1. Füxe' },
              { key: 'aktive', label: '2. Aktive Burschen' },
              { key: 'inaktive', label: '3. Inaktive Burschen' },
            ],
            ...overrides,
          },
        ],
      },
    ],
  });
}

function required(): FormDefinition {
  return definitionOf({ required: true });
}

describe('Zahlenliste — Schema', () => {
  it('verlangt mindestens eine Zeile', () => {
    expect(() => definitionOf({ items: [] })).toThrow();
  });

  it('lehnt einen doppelten Schlüssel ab', () => {
    expect(() =>
      definitionOf({
        items: [
          { key: 'a', label: 'A' },
          { key: 'a', label: 'B' },
        ],
      }),
    ).toThrow(/Doppelte Zeile/u);
  });

  it('kennt weder Obergrenze noch Termin — ein Feld davon wird nicht gespeichert', () => {
    const definition = definitionOf({
      items: [{ key: 'a', label: 'A', capacity: 5, when: 'Fr' }],
    });
    const [question] = allQuestions(definition);

    expect(question?.type === 'numberlist' ? question.items[0] : null).toEqual({
      key: 'a',
      label: 'A',
    });
  });
});

describe('Zahlenliste — Antwort', () => {
  it('nimmt Zahlen je Zeile an, die Null eingeschlossen', () => {
    const result = safeParseAnswers(definitionOf(), {
      [LIST]: { numbers: { fuexe: 2, aktive: 0 } },
    });

    expect(result.success).toBe(true);
    expect(result.data?.[LIST]).toEqual({ numbers: { fuexe: 2, aktive: 0 } });
  });

  it('behält eine eingetippte 0 und entfernt nur das leere Feld', () => {
    expect(
      canonicalAnswerValue({
        numbers: { fuexe: 0, aktive: '', inaktive: null },
      }),
    ).toEqual({ numbers: { fuexe: 0 } });
  });

  it.each([
    ['eine negative Zahl', { fuexe: -1 }],
    ['eine Kommazahl', { fuexe: 1.5 }],
    ['Text', { fuexe: 'zwei' }],
    ['mehr als die Obergrenze', { fuexe: 1_000_001 }],
  ])('weist %s ab', (_name, numbers) => {
    expect(
      safeParseAnswers(definitionOf(), { [LIST]: { numbers } }).success,
    ).toBe(false);
  });

  it('weist eine unbekannte Zeile ab, statt sie zu verwerfen', () => {
    const result = safeParseAnswers(definitionOf(), {
      [LIST]: { numbers: { gibtsnicht: 3 } },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('Unbekannte Zeile');
  });

  it('meldet zu viele Schlüssel als ein einziges Problem', () => {
    const numbers = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`x${String(index)}`, 1]),
    );
    const result = safeParseAnswers(definitionOf(), { [LIST]: { numbers } });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });

  it('liest keine Sitzplatzform: {seats} ist keine Zahlenliste', () => {
    expect(
      safeParseAnswers(definitionOf(), { [LIST]: { seats: { fuexe: 2 } } })
        .success,
    ).toBe(false);
  });
});

describe('Zahlenliste — Pflicht', () => {
  it('verlangt mindestens eine ausgefüllte Zeile', () => {
    expect(
      safeParseAnswers(required(), { [LIST]: { numbers: {} } }).success,
    ).toBe(false);
  });

  it('wertet eine eingetragene 0 als Antwort', () => {
    expect(
      safeParseAnswers(required(), { [LIST]: { numbers: { fuexe: 0 } } })
        .success,
    ).toBe(true);
  });

  it('prüft die Pflicht im Entwurf nicht', () => {
    expect(
      safeParseDraftAnswers(required(), { [LIST]: { numbers: {} } }).success,
    ).toBe(true);
  });

  it('kennt „leer" nur ohne Zeile — die Null ist nicht leer', () => {
    expect(isBlankAnswer({ numbers: {} })).toBe(true);
    expect(isBlankAnswer({ numbers: { fuexe: 0 } })).toBe(false);
  });
});

describe('Zahlenliste — Export', () => {
  const [question] = allQuestions(definitionOf());

  it('legt je Zeile eine Spalte an, in der Reihenfolge der Frage', () => {
    if (question === undefined) {
      throw new Error('fixture has no question');
    }
    const columns = questionColumns(question, []);

    expect(columns.map((column) => column.label)).toEqual([
      'Aktivitas — 1. Füxe',
      'Aktivitas — 2. Aktive Burschen',
      'Aktivitas — 3. Inaktive Burschen',
    ]);
    expect(columns.every((column) => column.guard === 'number')).toBe(true);
  });

  it('schreibt die Null als 0 und eine unberührte Zeile als leere Zelle', () => {
    if (question === undefined) {
      throw new Error('fixture has no question');
    }
    const answer = { numbers: { fuexe: 2, aktive: 0 } };

    expect(
      questionColumns(question, []).map((column) => column.render(answer)),
    ).toEqual(['2', '0', '']);
  });

  it('faltet die Antwort in die Reihenfolge der Frage', () => {
    if (question === undefined) {
      throw new Error('fixture has no question');
    }

    expect(
      formatAnswerCell(question, { numbers: { aktive: 0, fuexe: 2 } }),
    ).toBe('1. Füxe: 2; 2. Aktive Burschen: 0');
  });

  it('liest beschädigte Zeilen als leer, statt zu werfen', () => {
    expect(numbersOf({ numbers: 5 })).toEqual([]);
    expect(numbersOf({ numbers: { a: 'x', b: -2, c: 1.5, d: 4 } })).toEqual([
      ['d', 4],
    ]);
  });
});
