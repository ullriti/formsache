import {
  allQuestions,
  type EventEntry,
  type FormDefinition,
} from './form-schema.ts';
import type { PublicEventSeats } from './public-form.ts';
import { seatsOf, type AnswerMap } from './response-validation.ts';

/**
 * **What a submission asks for, and which of it is bounded** — the shared half
 * of the participant limit.
 *
 * The enforcement itself is a transaction and cannot be anywhere but the server
 * (`public-forms.service.ts`): only the database knows how many seats are left,
 * and it only knows it reliably while it holds the lock. What *can* live here —
 * and has to, or it will be written twice — is everything around that one query:
 * reading the requested seats out of an answer, knowing which of them have an
 * Obergrenze at all, and deciding which position is the one to refuse.
 *
 * Two callers today (the submission path, and the same code read the other way
 * round by the Bearbeiten difference of the requirement), a third in the evaluation.
 * The alternative is three walks over one answer, which is how „gegen
 * das Limit zählt die Personenzahl" comes to mean two different things.
 */

/** Which Veranstaltung of which question — the machine-readable position. */
export interface SeatPosition {
  readonly questionId: string;
  readonly eventKey: string;
}

/** One Veranstaltung a submission asks seats for, with the bound it stands under. */
export interface SeatRequest extends SeatPosition {
  /** The Personenzahl this answer wants — always ≥ 1 (`seatsOf` drops the rest). */
  readonly seats: number;
  /** The Obergrenze of this event, or `null` for „ohne Grenze". */
  readonly capacity: number | null;
}

/**
 * One position as a map key.
 *
 * **`U+0000` as the separator**, written as an escape rather than as the byte
 * itself — the byte made this whole file *binary* to git and to ripgrep, so its
 * diff read „Bin 0 -> 6043 bytes, 0 insertions" and the repository's own search
 * skipped it without a word (a review finding). A file that carries this arithmetic
 * must be readable in a review.
 *
 * `U+0000` rather than `#` or `:` — a question id is a UUID and
 * could not collide, but an `EventEntry.key` is a string an editor's builder
 * mints and nothing stops two of them from containing the separator. A NUL is
 * the one byte neither of the two can carry: `key` comes out of
 * `eventEntrySchema` (a `z.string()` that PostgreSQL would refuse a U+0000 in
 * anyway, which is the same argument `isPublicSlug` makes).
 */
export function seatKey(position: SeatPosition): string {
  return `${position.questionId}\u0000${position.eventKey}`;
}

/**
 * The seats one submission asks for, read from the answers **against the
 * definition they were validated with**.
 *
 * The definition is what decides which questions are Veranstaltungen and what
 * their Obergrenzen are, so a stray `seats` object under a text question's id
 * contributes nothing — the same rule every other reader of an answer map
 * follows, and the reason this is not simply „every value that has a `seats`
 * key".
 *
 * Events the answer does not mention are **absent from the result**, not present
 * with zero: „keine Anmeldung" occupies nothing, needs no row and must not
 * produce a `WHERE` clause that then has to be filtered out again.
 *
 * The order is the definition's — page order, then question order, then the
 * editor's own order of the events. That is what makes „die erste volle
 * Veranstaltung" (see {@link exhaustedPosition}) a stable answer rather than one
 * that depends on the key order of a JSON object a stranger sent.
 */
export function seatRequests(
  definition: FormDefinition,
  answers: AnswerMap,
): SeatRequest[] {
  const requests: SeatRequest[] = [];

  for (const question of allQuestions(definition)) {
    if (question.type !== 'event') {
      continue;
    }
    const asked = new Map(seatsOf(answers[question.id]));
    for (const event of question.events) {
      const seats = asked.get(event.key);
      if (seats === undefined) {
        continue;
      }
      requests.push({
        questionId: question.id,
        eventKey: event.key,
        seats,
        capacity: event.capacity,
      });
    }
  }

  return requests;
}

/**
 * The same positions, **in the order the form defines them** — page order, then
 * question order, then the editor's own order of the events.
 *
 * ## Why this is not simply how they arrive
 *
 * {@link seatRequests} produces that order by construction: it *walks* the
 * definition. The restore path of the trash cannot —
 * its positions come out of the `event_registration` rows of one answer, i.e.
 * out of whatever order PostgreSQL felt like returning them in. That order then
 * decided which position {@link exhaustedPosition} names, and the message a
 * editor reads („diese Veranstaltung ist voll") named an arbitrary one of
 * the full ones — arbitrary in the sense that a `VACUUM` or a plan change can
 * make the same form answer differently tomorrow (a review finding).
 *
 * „Die erste volle Veranstaltung" is only a stable answer while „die erste"
 * means something, and the only thing it can mean is the form's own order —
 * the one the person reading the refusal is looking at on screen.
 *
 * A position the definition does not name keeps its relative place **at the
 * end** (the sort is stable, and an unknown position ranks last). Those are
 * exactly the ones {@link withLiveCapacity} answers `null` for and
 * {@link boundedRequests} then drops, so they never reach a verdict at all.
 */
export function inDefinitionOrder<T extends SeatPosition>(
  positions: readonly T[],
  definition: FormDefinition,
): T[] {
  const rank = new Map<string, number>();
  for (const question of allQuestions(definition)) {
    if (question.type !== 'event') {
      continue;
    }
    for (const event of question.events) {
      rank.set(
        seatKey({ questionId: question.id, eventKey: event.key }),
        rank.size,
      );
    }
  }

  const last = Number.MAX_SAFE_INTEGER;
  return [...positions].sort(
    (left, right) =>
      (rank.get(seatKey(left)) ?? last) - (rank.get(seatKey(right)) ?? last),
  );
}

/**
 * The same requests, but with every Obergrenze taken from the **live** form.
 *
 * ## Why the snapshot may not decide this
 *
 * An edit validates against the version the answer was given under — that is
 * what keeps a question the organisation has since renamed from turning an old answer
 * into a 400. The **capacity is not part of that**: it is an operating limit,
 * a statement about how many people fit into a hall, and the organisation changes it
 * without publishing a new idea of what the form asks.
 *
 * Reading it from the snapshot made the two write paths disagree, and an
 * earlier review measured both directions:
 *
 * - **Lowered:** version 1 says 100, the organisation publishes 5. A *submission* of
 *   four is refused with 409 — and in the same second a *correction* from 3 to
 *   50 answers 200, leaving **50 seats in a hall for 5**.
 * - **Added afterwards** (the sharper one): version 1 says „ohne Grenze",
 *   version 2 says 10. The snapshot then yields no bounded position at all, so
 *   neither the lock nor the check runs — a correction from 3 to 40 answers
 *   200, **40 seats for 10**, unchecked and unserialised.
 *
 * A position the live form no longer names is treated as **unbounded**: the
 * Organisation has removed the constraint, and enforcing a number nobody can see any
 * more would be the snapshot deciding again, one step further along.
 */
export function withLiveCapacity(
  requests: readonly SeatRequest[],
  live: FormDefinition,
): SeatRequest[] {
  const capacities = new Map<string, number | null>();
  for (const question of allQuestions(live)) {
    if (question.type !== 'event') {
      continue;
    }
    for (const event of question.events) {
      capacities.set(
        seatKey({ questionId: question.id, eventKey: event.key }),
        event.capacity,
      );
    }
  }

  return requests.map((request) => ({
    ...request,
    capacity: capacities.get(seatKey(request)) ?? null,
  }));
}

/**
 * Only the requests that stand under an Obergrenze — **the lock decision, and
 * nothing else**.
 *
 * It looks like a second copy of the `capacity === null` guard in
 * {@link exhaustedPosition}, and an earlier review asked which of the two is
 * the truth. The verdict's own guard is: it must hold for any caller, including
 * one that hands in unfiltered requests. This function answers a different
 * question — „is there anything here that could possibly be refused?" — and its
 * answer decides whether the transaction takes the form row's lock at all. A
 * submission naming only unbounded Veranstaltungen must not serialise itself
 * behind everybody else's.
 */
export function boundedRequests(
  requests: readonly SeatRequest[],
): SeatRequest[] {
  return requests.filter((request) => request.capacity !== null);
}

/**
 * **What a stranger may know about the seats** — the public half of the requirement, and the one place that decides it.
 *
 * Pure, and here rather than in the service for the reason the whole file
 * exists: „die Zahl steht in der Nutzlast nur, wenn der Schalter an ist" is a
 * rule, not a query, and a rule that lives next to the `SELECT` that feeds it
 * gets restated the first time a second caller needs it (the read path and the
 * Bearbeiten path are already two).
 *
 * `taken` is what {@link takenSeats}-shaped callers hand in: seats already
 * committed, keyed by {@link seatKey}, missing where nothing is taken. On the
 * Bearbeiten path the caller subtracts what *this* answer holds before calling —
 * see `public-forms.service.ts` — so that somebody correcting their own
 * registration is not locked out of the box their own three seats are in.
 *
 * **Unbounded Veranstaltungen produce no entry** (see {@link PublicEventSeats}),
 * and neither does a question that is not an `event`. The order is the
 * definition's, like {@link seatRequests}'.
 *
 * One definition decides both halves here — which positions exist and what
 * they hold — because the read path shows the version it also computes from.
 * The Bearbeiten path cannot: see {@link snapshotEventSeats}, which this is the
 * degenerate case of.
 */
export function publicEventSeats(
  definition: FormDefinition,
  taken: ReadonlyMap<string, number>,
): PublicEventSeats[] {
  return snapshotEventSeats(definition, definition, taken);
}

/**
 * The same view for a reader who holds an **older** version of the form —
 * positions out of the snapshot, Obergrenzen out of the live one.
 *
 * ## Why the two definitions have to be split, and this way round
 *
 * The Bearbeiten path renders the snapshot the answer was given under
 * and judges the seats against the live Obergrenze ({@link withLiveCapacity}).
 * Building the seat view from the live definition alone — what the first cut of
 * this function did — mixed the two: a Veranstaltung published *after* the answer showed
 * up in `eventSeats` with its `questionId`, its `eventKey`, its „ausgebucht"
 * and, with the switch on, its remaining-seat count, for a form that never contained
 * it. The route is public, sessionless and deliberately **past the access word**
 * (`byEditToken` says why), so on a protected form that is a statement about
 * content behind the gate, handed to whoever holds one old token (a security
 * review).
 *
 * So the snapshot names the positions: a position it does not know does not
 * appear at all, exactly like the unbounded ones.
 *
 * **What the live definition still decides is everything inside the entry**:
 * the Obergrenze, and with it „ausgebucht" and the remaining-seat count — a figure
 * about today's registration state can only be measured against today's limit, and a
 * position the live form no longer bounds counts as unbeschränkt and produces
 * no entry, the same reading the enforcement uses. „Restplätze anzeigen" goes
 * with it rather than with the snapshot: it is the permission to publish that
 * very figure, and the current one is the editor's current answer.
 */
export function snapshotEventSeats(
  snapshot: FormDefinition,
  live: FormDefinition,
  taken: ReadonlyMap<string, number>,
): PublicEventSeats[] {
  const bounds = new Map<string, EventEntry>();
  for (const question of allQuestions(live)) {
    if (question.type !== 'event') {
      continue;
    }
    for (const event of question.events) {
      bounds.set(
        seatKey({ questionId: question.id, eventKey: event.key }),
        event,
      );
    }
  }

  const seats: PublicEventSeats[] = [];
  for (const question of allQuestions(snapshot)) {
    if (question.type !== 'event') {
      continue;
    }
    for (const event of question.events) {
      const position = { questionId: question.id, eventKey: event.key };
      const bound = bounds.get(seatKey(position));
      // The two reasons to say nothing, in the order they were argued above:
      // the live form does not name this position any more, or it names it
      // without an Obergrenze. Both read as „unbeschränkt".
      if (bound === undefined) {
        continue;
      }
      if (bound.capacity === null) {
        continue;
      }
      // Clamped at zero: an Obergrenze lowered under the registrations already
      // taken would otherwise publish „−7 frei", which reads as a bug rather
      // than as the „ausgebucht" it is.
      const left = Math.max(
        0,
        bound.capacity - (taken.get(seatKey(position)) ?? 0),
      );
      seats.push({
        ...position,
        full: left === 0,
        // The whole of the evidence: the key is **absent**, not zero and not
        // null, unless the editor switched „Restplätze anzeigen" on.
        ...(bound.showRemaining ? { remaining: left } : {}),
      });
    }
  }

  return seats;
}

/**
 * **The verdict**: the first position whose Obergrenze this submission would
 * break, or `null` when all of them fit.
 *
 * Pure, and that is the whole reason it is here rather than inline in the
 * service: the arithmetic of „belegt + gewünscht > Grenze" is the one part of
 * the participant limit that can be proven without a database, and the part where
 * an off-by-one is invisible in an integration test that only ever asks „wurde
 * abgelehnt?".
 *
 * `taken` is the sum **already committed** for each position — keyed by
 * {@link seatKey}, missing where nothing is taken. It is read under the lock;
 * this function does not know that and must not care.
 *
 * `delta` is what the caller wants to *add*, and it is a parameter rather than
 * `request.seats` because of the requirement: on the Bearbeiten path the seats this
 * answer already holds are its own, so what needs a free seat is the
 * **difference**. Passing `seats` there would refuse an unchanged submission on
 * a full event, and passing the difference here would be the same function twice.
 */
export function exhaustedPosition(
  requests: readonly SeatRequest[],
  taken: ReadonlyMap<string, number>,
  delta: (request: SeatRequest) => number = (request) => request.seats,
): SeatPosition | null {
  for (const request of requests) {
    if (request.capacity === null) {
      continue;
    }
    const wanted = delta(request);
    if (wanted <= 0) {
      // A reduction frees seats and can never be refused. Skipped
      // rather than compared, so that an event which is *already* over its
      // Obergrenze — the limit was lowered after registrations were taken —
      // does not block the very edits that bring it back down.
      continue;
    }
    if ((taken.get(seatKey(request)) ?? 0) + wanted > request.capacity) {
      return { questionId: request.questionId, eventKey: request.eventKey };
    }
  }
  return null;
}
