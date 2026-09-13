import { describe, expect, it } from 'vitest';

import { formatAnswerCell, questionColumns } from './answer-columns.ts';
import {
  boundedRequests,
  exhaustedPosition,
  inDefinitionOrder,
  publicEventSeats,
  seatKey,
  seatRequests,
  snapshotEventSeats,
} from './event-seats.ts';
import {
  allQuestions,
  parseFormDefinition,
  type FormDefinition,
  type Question,
} from './form-schema.ts';
import {
  canonicalAnswerValue,
  safeParseAnswers,
  seatsOf,
  type AnswerMap,
} from './response-validation.ts';

/**
 * **The Veranstaltung with a participant limit — the half that is provable
 * without a database.**
 *
 * The Obergrenze itself is a transaction and is proven where it is enforced
 * (`apps/api/test/public/event-limit.spec.ts`, sequentially **and** in
 * parallel). What is measured here is everything the transaction *reads*: the
 * definition, the shape of the answer, the single spelling of „nicht
 * angemeldet", the seats one submission asks for, and the arithmetic of
 * „belegt + gewünscht > Grenze". That last one is a pure function on purpose —
 * an off-by-one in it is invisible to an integration test that only ever asks
 * „wurde abgelehnt?".
 */

/**
 * „Keine Antworten" — the plan's second source, empty. A
 * Veranstaltung's columns come from the **document** (one per entry) and are
 * unaffected by it; the test that says so for every type is in
 * `answer-columns.test.ts`.
 */
const NO_ANSWERS: readonly AnswerMap[] = [];

const PAGE = '019ff400-0000-7000-8000-0000000000a0';
const EVENTS = '019ff400-0000-7000-8000-000000000001';
const NAME = '019ff400-0000-7000-8000-000000000002';

/** The three Veranstaltungen of the handoff's own BT page, verbatim. */
function eventQuestion(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function definitionWith(question: Record<string, unknown>): FormDefinition {
  return parseFormDefinition({
    pages: [
      {
        id: PAGE,
        title: 'Veranstaltungsanmeldung',
        description: null,
        questions: [
          question,
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
}

function questionOf(definition: FormDefinition): Question {
  const question = allQuestions(definition)[0];
  if (question === undefined) {
    throw new Error('fixture has no question');
  }
  return question;
}

describe('the Veranstaltung question', () => {
  it('carries a list of events, each with its own Obergrenze', () => {
    const question = questionOf(definitionWith(eventQuestion()));

    expect(question.type).toBe('event');
    if (question.type !== 'event') {
      throw new Error('unreachable');
    }
    expect(question.events).toHaveLength(3);
    // Both halves of „Pflicht *oder* ohne Grenze" are expressible, which is
    // exactly the point.
    expect(question.events.map((entry) => entry.capacity)).toStrictEqual([
      120,
      80,
      null,
    ]);
    expect(question.events[0]?.when).toBe('Fr, 19:00');
    expect(question.events[0]?.showRemaining).toBe(true);
  });

  /** The reproduction: the schema refuses it, not the display. */
  it('refuses a Veranstaltung without a Bezeichnung', () => {
    expect(() =>
      definitionWith(
        eventQuestion({
          events: [
            {
              key: 'x',
              label: '',
              when: null,
              capacity: 10,
              showRemaining: false,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('refuses a question without a single Veranstaltung', () => {
    expect(() => definitionWith(eventQuestion({ events: [] }))).toThrow();
  });

  it('refuses two Veranstaltungen sharing one key', () => {
    expect(() =>
      definitionWith(
        eventQuestion({
          events: [
            {
              key: 'a',
              label: 'Eins',
              when: null,
              capacity: 10,
              showRemaining: false,
            },
            {
              key: 'a',
              label: 'Zwei',
              when: null,
              capacity: 10,
              showRemaining: false,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('refuses an Obergrenze of zero — that is not „ohne Grenze"', () => {
    expect(() =>
      definitionWith(
        eventQuestion({
          events: [
            {
              key: 'a',
              label: 'Eins',
              when: null,
              capacity: 0,
              showRemaining: false,
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

describe('the answer: a number per Veranstaltung', () => {
  const definition = definitionWith(eventQuestion());

  it('accepts a Personenzahl per event', () => {
    const parsed = safeParseAnswers(definition, {
      [EVENTS]: { seats: { sommerfest: 3, stadtfest: 2 } },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.[EVENTS]).toStrictEqual({
      seats: { sommerfest: 3, stadtfest: 2 },
    });
  });

  it('refuses an unknown Veranstaltung rather than dropping it', () => {
    const parsed = safeParseAnswers(definition, {
      [EVENTS]: { seats: { gartenfest: 2 } },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('Unbekannte Veranstaltung.');
  });

  it('refuses a fractional and a negative Personenzahl', () => {
    for (const seats of [{ sommerfest: 2.5 }, { sommerfest: -3 }]) {
      expect(
        safeParseAnswers(definition, { [EVENTS]: { seats } }).success,
      ).toBe(false);
    }
  });

  /**
   * **The Obergrenze is not checked here, deliberately** — asking for more than
   * the whole hall holds is refused by the transaction with a 409 and a
   * position, not by the validator with a 400. One rule, one place.
   */
  it('accepts a number above the Obergrenze — that is the transaction’s call', () => {
    expect(
      safeParseAnswers(definition, { [EVENTS]: { seats: { stadtfest: 500 } } })
        .success,
    ).toBe(true);
  });

  it('treats a cleared and a zeroed box as „nicht angemeldet" (one spelling)', () => {
    const parsed = safeParseAnswers(definition, {
      [EVENTS]: { seats: { sommerfest: 0, stadtfest: '', festzug: 4 } },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.[EVENTS]).toStrictEqual({ seats: { festzug: 4 } });
  });

  it('canonicalises the same way outside the schema', () => {
    expect(canonicalAnswerValue({ seats: { a: 0, b: 2 } })).toStrictEqual({
      seats: { b: 2 },
    });
    // Not a spelling of „nichts" — left alone so the schema can name it.
    expect(canonicalAnswerValue({ seats: { a: 'zwei' } })).toStrictEqual({
      seats: { a: 'zwei' },
    });
  });

  it('reads a required question with every box cleared as „Pflichtfeld"', () => {
    const required = definitionWith(eventQuestion({ required: true }));
    const parsed = safeParseAnswers(required, {
      [EVENTS]: { seats: { sommerfest: 0 } },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('Pflichtfeld.');
  });

  it('accepts a required question answered for one of three events', () => {
    const required = definitionWith(eventQuestion({ required: true }));

    expect(
      safeParseAnswers(required, { [EVENTS]: { seats: { stadtfest: 1 } } })
        .success,
    ).toBe(true);
  });

  /** A damaged row must not take a reader down — the `textOf` rule. */
  it('reads a damaged seats value as no registration at all', () => {
    expect(seatsOf({ seats: 5 })).toStrictEqual([]);
    expect(seatsOf({ seats: { a: 'x', b: 0, c: 2 } })).toStrictEqual([
      ['c', 2],
    ]);
    expect(seatsOf(null)).toStrictEqual([]);
  });
});

describe('the export and the folded cell', () => {
  const definition = definitionWith(eventQuestion());
  const question = questionOf(definition);

  it('gives one column per Veranstaltung, guarded as a number', () => {
    const columns = questionColumns(question, NO_ANSWERS);

    expect(columns.map((column) => column.label)).toStrictEqual([
      'Veranstaltungen — Sommerfest',
      'Veranstaltungen — Stadtfest',
      'Veranstaltungen — Festzug / Umzug',
    ]);
    expect(new Set(columns.map((column) => column.guard))).toStrictEqual(
      new Set(['number']),
    );
  });

  it('writes the count in its own column and leaves the others empty', () => {
    const columns = questionColumns(question, NO_ANSWERS);
    const answer = { seats: { sommerfest: 3 } };

    expect(columns.map((column) => column.render(answer))).toStrictEqual([
      '3',
      '',
      '',
    ]);
  });

  it('folds to „Name: Zahl" on screen, in the order the form offers', () => {
    expect(
      formatAnswerCell(question, { seats: { stadtfest: 2, sommerfest: 3 } }),
    ).toBe('Sommerfest: 3; Stadtfest: 2');
  });
});

describe('seatRequests — what one submission asks for', () => {
  const definition = definitionWith(eventQuestion());

  it('reads the seats against the definition, in the form’s own order', () => {
    expect(
      seatRequests(definition, {
        [EVENTS]: { seats: { festzug: 1, sommerfest: 3 } },
        [NAME]: 'Muster',
      }),
    ).toStrictEqual([
      {
        questionId: EVENTS,
        eventKey: 'sommerfest',
        seats: 3,
        capacity: 120,
      },
      { questionId: EVENTS, eventKey: 'festzug', seats: 1, capacity: null },
    ]);
  });

  it('ignores a seats object sent for a question that is not a Veranstaltung', () => {
    expect(
      seatRequests(definition, {
        // Cast-free: the map is `AnswerValue | undefined` and this is a real
        // member of it, which is exactly why the definition has to decide.
        [NAME]: { seats: { sommerfest: 5 } },
      }),
    ).toStrictEqual([]);
  });

  it('keeps only the bounded ones for the lock', () => {
    const requests = seatRequests(definition, {
      [EVENTS]: { seats: { festzug: 1 } },
    });

    expect(requests).toHaveLength(1);
    // „Ohne Grenze" is recorded and never counted against anything.
    expect(boundedRequests(requests)).toStrictEqual([]);
  });
});

describe('exhaustedPosition — the arithmetic under the lock', () => {
  const definition = definitionWith(eventQuestion());
  const requests = seatRequests(definition, {
    [EVENTS]: { seats: { sommerfest: 4, festzug: 9 } },
  });
  const bounded = boundedRequests(requests);
  const key = seatKey({ questionId: EVENTS, eventKey: 'sommerfest' });

  it('lets a submission through while the seats are there', () => {
    expect(exhaustedPosition(bounded, new Map([[key, 116]]))).toBeNull();
  });

  /** Exactly full is still through — 116 + 4 = 120 is the Obergrenze itself. */
  it('lets the last seats go', () => {
    expect(exhaustedPosition(bounded, new Map([[key, 116]]))).toBeNull();
    expect(exhaustedPosition(bounded, new Map([[key, 117]]))).toStrictEqual({
      questionId: EVENTS,
      eventKey: 'sommerfest',
    });
  });

  it('never refuses an event „ohne Grenze", whatever is taken', () => {
    const unbounded = seatRequests(definition, {
      [EVENTS]: { seats: { festzug: 500 } },
    });

    expect(
      exhaustedPosition(
        boundedRequests(unbounded),
        new Map([
          [seatKey({ questionId: EVENTS, eventKey: 'festzug' }), 10_000],
        ]),
      ),
    ).toBeNull();
  });

  it('names the first full position in the form’s order', () => {
    const both = boundedRequests(
      seatRequests(definition, {
        [EVENTS]: { seats: { sommerfest: 4, stadtfest: 4 } },
      }),
    );

    expect(
      exhaustedPosition(
        both,
        new Map([
          [key, 120],
          [seatKey({ questionId: EVENTS, eventKey: 'stadtfest' }), 80],
        ]),
      ),
    ).toStrictEqual({ questionId: EVENTS, eventKey: 'sommerfest' });
  });

  /**
   * The Bearbeiten difference reads the same function with a
   * `delta` — proven here so the editor inherits a rule rather than a
   * suggestion. A **reduction** can never be refused, not even on an event that
   * is already over its Obergrenze because the limit was lowered afterwards.
   */
  it('measures the difference when one is given (the delta seam)', () => {
    const taken = new Map([[key, 118]]);

    // 118 + 4 > 120, but the answer already holds 3 of those 118: the two
    // additional seats fit.
    expect(exhaustedPosition(bounded, taken, () => 1)).toBeNull();
    expect(exhaustedPosition(bounded, taken, () => 3)).toStrictEqual({
      questionId: EVENTS,
      eventKey: 'sommerfest',
    });
    expect(
      exhaustedPosition(bounded, new Map([[key, 500]]), () => -2),
    ).toBeNull();
  });
});

/**
 * **`inDefinitionOrder` — what „die erste volle Veranstaltung" can mean at
 * all** (a review finding).
 *
 * `seatRequests` produces the definition's order by walking it. The restore
 * path of the trash cannot: its positions come out of the
 * `event_registration` rows of one answer, in whatever order PostgreSQL
 * returned them. That order then decided which position the refusal named — so
 * the same form could name a different Veranstaltung tomorrow, on the same
 * data, for no reason an editor can see.
 */
describe('inDefinitionOrder — die Ordnung, auf die sich die Meldung beruft', () => {
  const definition = definitionWith(eventQuestion());
  const position = (eventKey: string) => ({ questionId: EVENTS, eventKey });

  it('puts arbitrary rows into page, question and editor order', () => {
    const rows = [
      position('festzug'),
      position('stadtfest'),
      position('sommerfest'),
    ];

    expect(inDefinitionOrder(rows, definition).map((one) => one.eventKey)) //
      .toStrictEqual(['sommerfest', 'stadtfest', 'festzug']);
  });

  it('leaves an order that is already the definition’s alone', () => {
    const rows = seatRequests(definition, {
      [EVENTS]: { seats: { sommerfest: 1, stadtfest: 1, festzug: 1 } },
    });

    expect(
      inDefinitionOrder(rows, definition).map((one) => one.eventKey),
    ).toStrictEqual(rows.map((one) => one.eventKey));
  });

  /**
   * A Veranstaltung the organisation has since removed has no place in an order it is
   * not part of — it goes last, keeping its relative position, and is dropped
   * by `boundedRequests` before any verdict sees it (`withLiveCapacity`
   * answers `null` for it).
   */
  it('sends a position the definition no longer names to the end', () => {
    const rows = [
      position('abgesagt'),
      position('stadtfest'),
      position('auch-weg'),
      position('sommerfest'),
    ];

    expect(
      inDefinitionOrder(rows, definition).map((one) => one.eventKey),
    ).toStrictEqual(['sommerfest', 'stadtfest', 'abgesagt', 'auch-weg']);
  });

  /** The whole point: the refusal names the same position either way round. */
  it('makes the refusal independent of the order the rows arrived in', () => {
    const full = new Map([
      [seatKey(position('sommerfest')), 120],
      [seatKey(position('stadtfest')), 80],
    ]);
    const named = (rows: readonly { questionId: string; eventKey: string }[]) =>
      exhaustedPosition(
        boundedRequests(
          inDefinitionOrder(rows, definition).map((one) => ({
            ...one,
            seats: 1,
            capacity: one.eventKey === 'sommerfest' ? 120 : 80,
          })),
        ),
        full,
      );

    expect(
      named([position('stadtfest'), position('sommerfest')]),
    ).toStrictEqual({ questionId: EVENTS, eventKey: 'sommerfest' });
    expect(
      named([position('sommerfest'), position('stadtfest')]),
    ).toStrictEqual({ questionId: EVENTS, eventKey: 'sommerfest' });
  });
});

/**
 * **What a stranger may learn about the seats**  — the rule, without a database.
 *
 * The figure itself comes from `takenSeats`, which is proven where it runs
 * (`event-limit.spec.ts`). What is decided *here* is whether it may be sent at
 * all, and that is a rule rather than a query: „ausgebucht" always, the number
 * only where the editor switched it on.
 *
 * ⚠️ **Nothing in this block is the Obergrenze.** A payload that says „frei"
 * has refused nobody; the limit holds in the transaction, for
 * a caller who never read this payload at all.
 */
describe('publicEventSeats — die öffentliche Sicht auf die Plätze', () => {
  const definition = definitionWith(eventQuestion());
  const sommerfest = seatKey({ questionId: EVENTS, eventKey: 'sommerfest' });
  const stadtfest = seatKey({ questionId: EVENTS, eventKey: 'stadtfest' });

  it('sends the figure only for the Veranstaltung whose switch is on', () => {
    const seats = publicEventSeats(
      definition,
      new Map([
        [sommerfest, 100],
        [stadtfest, 10],
      ]),
    );

    // The counter-case: write `remaining` unconditionally and
    // the second assertion goes red. Asserted as the **set of keys**, because
    // `remaining: null` would pass a `toBeUndefined()` and still be a field on
    // the wire.
    expect(seats[0]).toStrictEqual({
      questionId: EVENTS,
      eventKey: 'sommerfest',
      full: false,
      remaining: 20,
    });
    expect(Object.keys(seats[1] ?? {}).sort()).toStrictEqual([
      'eventKey',
      'full',
      'questionId',
    ]);
  });

  it('says „ausgebucht" whatever the switch says', () => {
    const seats = publicEventSeats(
      definition,
      new Map([
        [sommerfest, 120],
        [stadtfest, 80],
      ]),
    );

    expect(seats.map((entry) => entry.full)).toStrictEqual([true, true]);
    // The one with the switch off is full and still nameless about numbers.
    expect(seats[1]).not.toHaveProperty('remaining');
  });

  it('lists no entry for a Veranstaltung „ohne Grenze"', () => {
    const seats = publicEventSeats(definition, new Map());

    // Two of the three events are bounded; the Festzug can never be full and
    // has no figure to give, so it produces nothing rather than a row saying
    // „false, forever".
    expect(seats.map((entry) => entry.eventKey)).toStrictEqual([
      'sommerfest',
      'stadtfest',
    ]);
  });

  it('clamps at zero when an Obergrenze was lowered under the registrations', () => {
    const lowered = definitionWith(
      eventQuestion({
        events: [
          {
            key: 'sommerfest',
            label: 'Sommerfest',
            when: null,
            capacity: 5,
            showRemaining: true,
          },
        ],
      }),
    );

    expect(
      publicEventSeats(lowered, new Map([[sommerfest, 12]])),
    ).toStrictEqual([
      {
        questionId: EVENTS,
        eventKey: 'sommerfest',
        full: true,
        remaining: 0,
      },
    ]);
  });
});

/**
 * **What a Bearbeiten token may learn** (a security review).
 *
 * The correction path renders the snapshot of the answer's own version and
 * measures the seats against the live Obergrenze — two definitions, and the
 * question this block settles is which of them decides *which positions exist*.
 * The route is public, sessionless and past the access word, so an entry for a
 * Veranstaltung the snapshot never contained is a statement about a form the
 * token holder was never shown.
 */
describe('snapshotEventSeats — die Sicht einer älteren Fassung', () => {
  /** A second Veranstaltungsfrage — the one published after the answer. */
  const WORKSHOPS = '019ff400-0000-7000-8000-000000000003';
  const sommerfest = seatKey({ questionId: EVENTS, eventKey: 'sommerfest' });
  const workshop = seatKey({ questionId: WORKSHOPS, eventKey: 'workshop' });

  function workshopQuestion(overrides: Record<string, unknown> = {}) {
    return {
      id: WORKSHOPS,
      type: 'event',
      label: 'Workshops',
      hint: null,
      required: false,
      width: 'full',
      events: [
        {
          key: 'workshop',
          label: 'Workshop',
          when: null,
          capacity: 10,
          showRemaining: true,
        },
      ],
      ...overrides,
    };
  }

  /** Both Veranstaltungsfragen on one page — the *live* form. */
  function withWorkshops(
    question: Record<string, unknown> = eventQuestion(),
  ): FormDefinition {
    return parseFormDefinition({
      pages: [
        {
          id: PAGE,
          title: 'Veranstaltungsanmeldung',
          description: null,
          questions: [question, workshopQuestion()],
        },
      ],
    });
  }

  it('says nothing at all about a position the snapshot does not know', () => {
    const snapshot = definitionWith(eventQuestion());
    const live = withWorkshops();

    const seats = snapshotEventSeats(
      snapshot,
      live,
      new Map([
        [sommerfest, 100],
        [workshop, 9],
      ]),
    );

    // The reproduction: pass `live` as the first argument as well — i.e. what
    // the first cut of this function did — and the Workshop appears here with its
    // questionId, its eventKey, `full` and its remaining-seat count.
    expect(seats.map((entry) => entry.eventKey)).toStrictEqual([
      'sommerfest',
      'stadtfest',
    ]);
    expect(JSON.stringify(seats)).not.toContain(WORKSHOPS);
    expect(JSON.stringify(seats)).not.toContain('workshop');
  });

  it('takes the Obergrenze and the switch from the live form', () => {
    const snapshot = definitionWith(eventQuestion());
    const live = withWorkshops(
      eventQuestion({
        events: [
          {
            key: 'sommerfest',
            label: 'Sommerfest',
            when: null,
            // Lowered *and* the figure switched off since the answer.
            capacity: 50,
            showRemaining: false,
          },
          {
            key: 'stadtfest',
            label: 'Stadtfest',
            when: null,
            capacity: 80,
            showRemaining: true,
          },
        ],
      }),
    );

    expect(
      snapshotEventSeats(snapshot, live, new Map([[sommerfest, 40]])),
    ).toStrictEqual([
      // 50 − 40, and no `remaining` although the snapshot's own switch was on.
      { questionId: EVENTS, eventKey: 'sommerfest', full: false },
      { questionId: EVENTS, eventKey: 'stadtfest', full: false, remaining: 80 },
    ]);
  });

  it('drops a position the live form no longer bounds', () => {
    const snapshot = definitionWith(eventQuestion());
    const live = withWorkshops(
      eventQuestion({
        events: [
          {
            key: 'sommerfest',
            label: 'Sommerfest',
            when: null,
            capacity: null,
            showRemaining: false,
          },
        ],
      }),
    );

    // „ohne Grenze" and „live nicht mehr genannt" are one state (the reading
    // `withLiveCapacity` uses): no entry, i.e. unbeschränkt.
    expect(snapshotEventSeats(snapshot, live, new Map())).toStrictEqual([]);
  });

  it('is the same view as publicEventSeats when both fassungen agree', () => {
    const definition = withWorkshops();
    const taken = new Map([
      [sommerfest, 20],
      [workshop, 3],
    ]);

    expect(snapshotEventSeats(definition, definition, taken)).toStrictEqual(
      publicEventSeats(definition, taken),
    );
  });
});
