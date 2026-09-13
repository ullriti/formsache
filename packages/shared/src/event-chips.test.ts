import { describe, expect, it } from 'vitest';

import { formatAnswerCell } from './answer-columns.ts';
import { eventChips } from './event-chips.ts';
import {
  allQuestions,
  parseFormDefinition,
  type Question,
} from './form-schema.ts';

/**
 * **Eine Veranstaltungsantwort als Chips** .
 *
 * The rendered half is measured in
 * `apps/web/src/views/ResponsesView.test.tsx` — this file measures the rule
 * underneath it, which is what decides *which* chips there are and in which
 * order.
 *
 * The last case is the one that keeps `formatAnswerCell` and the chips from
 * drifting apart: both are asserted over the same answer, so a second walk over
 * the document would have to keep agreeing with this one (`CONTRIBUTING.md`).
 */

const PAGE = '019ff900-0000-7000-8000-0000000000a0';
const EVENTS = '019ff900-0000-7000-8000-000000000001';
const NAME = '019ff900-0000-7000-8000-000000000002';

function eventQuestion(): Question {
  const definition = parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Veranstaltungsanmeldung',
        description: null,
        questions: [
          {
            id: EVENTS,
            type: 'event',
            label: 'Veranstaltungen',
            hint: null,
            required: false,
            width: 'full',
            events: [
              {
                key: 'sommerfest',
                label: 'Sommerfest',
                when: 'Fr, 19:00',
                capacity: 120,
                showRemaining: true,
              },
              {
                key: 'stadtfest',
                label: 'Stadtfest',
                when: 'Sa, 20:00',
                capacity: 80,
                showRemaining: false,
              },
              {
                key: 'festzug',
                label: 'Festzug / Umzug',
                when: 'So, 11:00',
                capacity: null,
                showRemaining: false,
              },
            ],
          },
        ],
      },
    ],
  });
  const question = allQuestions(definition)[0];
  if (question === undefined) {
    throw new Error('fixture has no question');
  }
  return question;
}

function textQuestion(): Question {
  const definition = parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Seite 1',
        description: null,
        questions: [
          {
            id: NAME,
            type: 'text',
            label: 'Name',
            hint: null,
            required: false,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  });
  const question = allQuestions(definition)[0];
  if (question === undefined) {
    throw new Error('fixture has no question');
  }
  return question;
}

describe('eventChips ', () => {
  it('names every registered Veranstaltung with its Personenzahl', () => {
    const chips = eventChips(eventQuestion(), {
      seats: { sommerfest: 3, stadtfest: 2 },
    });

    expect(chips).toStrictEqual([
      { key: 'sommerfest', label: 'Sommerfest', seats: 3 },
      { key: 'stadtfest', label: 'Stadtfest', seats: 2 },
    ]);
  });

  /**
   * **Null Plätze ist kein Chip.** An `EventAnswer` says „wir kommen nicht" by
   * not carrying the key at all; a `0` reaching a reader comes from an older
   * row or a hand-written document, and a chip for it would claim a
   * registration of nobody.
   */
  it('leaves out a Veranstaltung with zero seats instead of drawing an empty chip', () => {
    const chips = eventChips(eventQuestion(), {
      seats: { sommerfest: 3, stadtfest: 0 },
    });

    expect(chips.map((chip) => chip.key)).toStrictEqual(['sommerfest']);
  });

  it('has no chip at all for an answer that registers for nothing', () => {
    expect(eventChips(eventQuestion(), { seats: {} })).toStrictEqual([]);
  });

  /**
   * Ordered by the **question**, never by the answer: a JSONB object keeps the
   * key order the client happened to send, and an evaluation reads the
   * Veranstaltungen in the order the form offers them.
   */
  it('orders the chips by the form, not by the answer’s key order', () => {
    const chips = eventChips(eventQuestion(), {
      seats: { festzug: 1, sommerfest: 4 },
    });

    expect(chips.map((chip) => chip.label)).toStrictEqual([
      'Sommerfest',
      'Festzug / Umzug',
    ]);
  });

  it('ignores a Veranstaltung the form no longer offers', () => {
    const chips = eventChips(eventQuestion(), {
      seats: { abgesagt: 2, stadtfest: 1 },
    });

    expect(chips.map((chip) => chip.key)).toStrictEqual(['stadtfest']);
  });

  /**
   * Tolerant like every other reader of a stored answer: a damaged document is
   * an empty list, never a throw that takes a whole evaluation down.
   */
  it('answers empty for a value that is not a readable Veranstaltungsantwort', () => {
    expect(eventChips(eventQuestion(), undefined)).toStrictEqual([]);
    expect(eventChips(eventQuestion(), 'Sommerfest')).toStrictEqual([]);
    expect(
      eventChips(eventQuestion(), { seats: { stadtfest: 'zwei' } }),
    ).toStrictEqual([]);
  });

  it('answers empty for a question of another type', () => {
    expect(
      eventChips(textQuestion(), { seats: { sommerfest: 1 } }),
    ).toStrictEqual([]);
  });

  /**
   * **The folded cell is written from this list** — the guard against the
   * second read path. A `formatAnswerCell` that walked the answer itself would
   * pass this today and drift the day one of the two rules above changes.
   */
  it('agrees with the folded cell the table and the export show', () => {
    const question = eventQuestion();
    const answer = { seats: { festzug: 1, sommerfest: 4, stadtfest: 0 } };

    expect(formatAnswerCell(question, answer)).toBe(
      eventChips(question, answer)
        .map((chip) => `${chip.label}: ${String(chip.seats)}`)
        .join('; '),
    );
    expect(formatAnswerCell(question, answer)).toBe(
      'Sommerfest: 4; Festzug / Umzug: 1',
    );
  });
});
