import { describe, expect, it } from 'vitest';

import { formatAnswerCell, questionColumns } from './answer-columns.ts';
import { visibleQuestionIds } from './condition.ts';
import {
  INFO_TEXT_MAX,
  allQuestions,
  parseFormDefinition,
  type FormDefinition,
} from './form-schema.ts';
import {
  safeParseAnswers,
  safeParseDraftAnswers,
} from './response-validation.ts';

/**
 * **Die Bestätigung (eine Checkbox), die Datumsspalte der Tabelle und der
 * längere Infotext** — three small additions to existing types, proven together
 * because none of them is big enough for a file of its own.
 */

const PAGE = '019ff700-0000-7000-8000-0000000000a0';
const CONFIRM = '019ff700-0000-7000-8000-000000000001';
const TABLE = '019ff700-0000-7000-8000-000000000002';
const DEPENDENT = '019ff700-0000-7000-8000-000000000003';
const INFO = '019ff700-0000-7000-8000-000000000004';

const base = { hint: null, required: false, width: 'full' } as const;

function definition(confirmRequired: boolean, extra: unknown[] = []) {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Seite 1',
        description: null,
        questions: [
          {
            ...base,
            id: CONFIRM,
            type: 'confirm',
            label: 'Ich habe die Hinweise gelesen',
            required: confirmRequired,
          },
          {
            ...base,
            id: TABLE,
            type: 'table',
            label: 'Termine',
            rows: 2,
            columns: [
              { key: 'wann', label: 'Wann', type: 'date' },
              { key: 'was', label: 'Was', type: 'text' },
            ],
          },
          ...extra,
        ],
      },
    ],
  });
}

describe('Bestätigung', () => {
  it('verlangt bei Pflicht den Haken', () => {
    expect(safeParseAnswers(definition(true), {}).success).toBe(false);
    expect(
      safeParseAnswers(definition(true), { [CONFIRM]: null }).success,
    ).toBe(false);
    expect(
      safeParseAnswers(definition(true), { [CONFIRM]: false }).success,
    ).toBe(false);
    expect(
      safeParseAnswers(definition(true), { [CONFIRM]: true }).success,
    ).toBe(true);
  });

  it('nimmt ohne Pflicht auch „nicht angekreuzt" an, aber nie etwas anderes', () => {
    const optional = definition(false);

    expect(safeParseAnswers(optional, {}).success).toBe(true);
    expect(safeParseAnswers(optional, { [CONFIRM]: null }).success).toBe(true);
    expect(safeParseAnswers(optional, { [CONFIRM]: false }).success).toBe(true);
    expect(safeParseAnswers(optional, { [CONFIRM]: 'ja' }).success).toBe(false);
    expect(safeParseAnswers(optional, { [CONFIRM]: 1 }).success).toBe(false);
  });

  it('prüft die Pflicht im Entwurf nicht', () => {
    expect(
      safeParseDraftAnswers(definition(true), { [CONFIRM]: null }).success,
    ).toBe(true);
  });

  it('exportiert „Ja" und sonst eine leere Zelle', () => {
    const [question] = allQuestions(definition(true));
    if (question === undefined) {
      throw new Error('fixture has no question');
    }

    expect(formatAnswerCell(question, true)).toBe('Ja');
    expect(formatAnswerCell(question, false)).toBe('');
    expect(questionColumns(question, [])).toHaveLength(1);
  });

  it('lässt sich als Quelle einer Bedingung nutzen', () => {
    const withCondition = definition(false, [
      {
        ...base,
        id: DEPENDENT,
        type: 'text',
        label: 'Warum?',
        minLength: null,
        maxLength: null,
        pattern: null,
        visibleIf: { questionId: CONFIRM, operator: 'filled' },
      },
    ]);

    expect(
      visibleQuestionIds(withCondition, { [CONFIRM]: true }).has(DEPENDENT),
    ).toBe(true);
    expect(
      visibleQuestionIds(withCondition, { [CONFIRM]: null }).has(DEPENDENT),
    ).toBe(false);
  });
});

describe('Tabelle — Datumsspalte', () => {
  function answer(cell: unknown) {
    return { [TABLE]: { cells: [{ wann: cell, was: 'Treffen' }] } };
  }

  it('nimmt ein gültiges Datum an', () => {
    expect(
      safeParseAnswers(definition(false), answer('2026-05-15')).success,
    ).toBe(true);
  });

  it.each([
    ['ein unmögliches Datum', '2026-02-30'],
    ['die deutsche Schreibweise', '15.05.2026'],
    ['Text', 'morgen'],
    ['eine Zahl', 20260515],
    ['einen Haken', true],
  ])('weist %s ab', (_name, cell) => {
    expect(safeParseAnswers(definition(false), answer(cell)).success).toBe(
      false,
    );
  });

  it('schreibt das Datum wie eine Datumsfrage: TT.MM.JJJJ', () => {
    const [, table] = allQuestions(definition(false));
    if (table === undefined) {
      throw new Error('fixture has no table');
    }

    expect(
      formatAnswerCell(table, {
        cells: [{ wann: '2026-05-15', was: 'Treffen' }],
      }),
    ).toBe('Wann: 15.05.2026, Was: Treffen');
  });
});

describe('Infotext — längerer Text', () => {
  function infoWith(hint: string): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Seite 1',
          description: null,
          questions: [
            { ...base, id: INFO, type: 'info', label: 'Hinweis', hint },
          ],
        },
      ],
    });
  }

  it('nimmt mehr als die Hinweisgrenze der anderen Typen an', () => {
    expect(() => infoWith('x'.repeat(5000))).not.toThrow();
    expect(() => infoWith('x'.repeat(INFO_TEXT_MAX))).not.toThrow();
  });

  it('hat trotzdem eine Grenze', () => {
    expect(() => infoWith('x'.repeat(INFO_TEXT_MAX + 1))).toThrow();
  });

  it('lässt die kurze Grenze bei den übrigen Typen bestehen', () => {
    expect(() =>
      parseFormDefinition({
        pages: [
          {
            id: PAGE,
            title: 'Seite 1',
            description: null,
            questions: [
              {
                ...base,
                id: CONFIRM,
                type: 'confirm',
                label: 'x',
                hint: 'x'.repeat(1001),
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
