import type { Question } from './form-schema.ts';
import { seatsOf } from './response-validation.ts';

/**
 * **Eine Veranstaltungsantwort als Chips** (design handoff).
 *
 * The handoff draws a Veranstaltungsfeld in the detail panel as one chip per
 * Veranstaltung, carrying its name and the Personenzahl — not as the folded
 * sentence „Sommerfest: 3; Stadtfest: 2" the table cell and the export show.
 *
 * ## Why this is a shared function and not three lines in the panel
 *
 * The folded cell (`formatAnswerCell`) and the chips answer the *same two
 * questions* — which Veranstaltungen count as answered, and in which order they
 * are listed — and only differ in how the answer is written out. Two places
 * deciding that is the second read path of CONTRIBUTING.md rule 5: the day
 * somebody changes „was zählt als angemeldet", one of the two surfaces keeps
 * the old rule and nothing goes red. `formatAnswerCell` therefore builds its
 * sentence **from this list** rather than walking the answer a second time.
 *
 * ## The two rules, spelled out
 *
 * - **Ordered by the question, never by the answer.** A JSONB object's key
 *   order is whatever the client happened to send; an evaluation reads the
 *   Veranstaltungen in the order the form offers them.
 * - **„Null Plätze" is no chip at all.** An `EventAnswer` is sparse — „wir
 *   kommen nicht" is the *absence* of the key (`response-validation.ts`) — and
 *   `seatsOf` additionally drops a non-positive count that an older row or a
 *   hand-written document may carry. A chip reading „Stadtfest · 0 Personen"
 *   would claim a registration of nobody, which is a different statement from
 *   „nicht angemeldet" and the only one of the two that is false.
 */
export interface EventChip {
  /** The Veranstaltung's key — stable across renames, unlike its label. */
  readonly key: string;
  /** The Veranstaltung's label, as the form spells it today. */
  readonly label: string;
  /** Personenzahl — always at least 1; see the note on „null Plätze" above. */
  readonly seats: number;
}

/**
 * The chips of one Veranstaltungsantwort, in the question's own order.
 *
 * Answers an empty list for a question of another type and for a value that is
 * not a readable `EventAnswer` — tolerantly, like every other reader of a
 * stored answer in this package: one damaged row must not take a whole
 * evaluation down.
 *
 * `value` is `unknown` for the same reason `seatsOf` takes `unknown`: what
 * reaches here came out of a JSONB column, and a parameter type that promised
 * more than the storage does would be a cast at every call site.
 */
export function eventChips(question: Question, value: unknown): EventChip[] {
  if (question.type !== 'event') {
    return [];
  }
  const seats = new Map(seatsOf(value));
  return question.events
    .map((event) => ({
      key: event.key,
      label: event.label,
      seats: seats.get(event.key),
    }))
    .filter((chip): chip is EventChip => chip.seats !== undefined);
}
