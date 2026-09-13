import { formatDeadline } from '@formsache/shared';

/**
 * What a participant is told about the temporal boundaries of an **open** form —
 * the deadline and the time limit (finding 32).
 *
 * The counterpart to {@link unavailableNotice} next door: that one says what
 * stands there *instead of* a form, this one says what one is working against
 * while the form is open. Both live off the same piece of information —
 * `closesAt` from the server's verdict, which `form-availability.ts` expressly
 * sends along, „non-null **while it is open** (so a participant sees the
 * deadline they are working against)". Up to here nobody has redeemed that: the
 * only consumer in the fill-in path was `unavailableNotice`, and that one
 * returns `null` for the state `'open'`.
 *
 * **A pure function and not a component**, for the same reason as next door: the
 * wording can be checked without rendering a page, and the clock — the only
 * thing that really is state here — stays in `FormDeadline.tsx`.
 *
 * **Two boundaries, one pair of sentences.** The deadline is a point in time and
 * applies to everyone alike, the time limit is a duration and applies to this
 * one filling-in; a form can have neither, one or both. They nevertheless stand
 * in *one* line: it is a single piece of information — „how long do I have" —,
 * and two paragraphs above one another would be twice the same interruption
 * above the fields.
 *
 * **The time limit has been on the public line since finding 32**
 * (`publicFormSchema.timeLimitMin`). The predecessor of this file expressly left
 * it out, because the payload carried „ein Verdikt, nie die Konfiguration
 * dahinter"; that line now runs more narrowly and better justified — public is
 * what *binds* the person filling in, not what the form *fends off*. The
 * justification stands in the contract, not here.
 */
export interface DeadlineNotice {
  readonly text: string;
  /**
   * Whether the **deadline** is already past from this page's point of view.
   *
   * A display state and not an enforcement: the clock that counts is the
   * server's at the arrival of the submission (`availabilityOf` there, in the
   * same transaction step). A browser clock that runs wrong may therefore at
   * most show a hint too early or too late — it must not lock the button,
   * otherwise a skewed clock takes away from somebody the submission the server
   * would have accepted.
   *
   * **Only the deadline, never the time limit.** When the minutes of this
   * filling-in run out is something this page does not know: counting starts
   * from the point in time in the signed start token, and that one deliberately
   * does not reveal its point in time
   * (`apps/api/src/public/start-token.service.ts`). To count from one's own
   * render pass would be a guessed clock above a foreign measurement — and the
   * error would go in the expensive direction: „deine Zeit ist um" above a form
   * that the server would still have accepted.
   */
  readonly expired: boolean;
}

/**
 * What is passed in here — the two boundaries and the clock.
 *
 * An object and not three positions: two of the three values are numbers or
 * `null` respectively, and `deadlineNotice(null, 30, now)` would be exactly the
 * call one writes the wrong way round once.
 */
export interface DeadlineNoticeInput {
  /** The point in time from the server's verdict, or `null` without a deadline. */
  readonly closesAt: string | null;
  /** The minutes from the payload, or `null` without a time limit. */
  readonly timeLimitMin: number | null;
  /** The browser's clock, passed in — so that a test can stand on the boundary. */
  readonly now: number;
}

/**
 * The line above the form, or `null` if there is nothing to say.
 *
 * `null` and not an empty sentence: the overwhelming majority of forms have
 * neither a deadline nor a time limit, and a line „keine Frist" would be a line
 * that stands on every page and never says anything.
 */
export function deadlineNotice({
  closesAt,
  timeLimitMin,
  now,
}: DeadlineNoticeInput): DeadlineNotice | null {
  const deadline = readDeadline(closesAt);

  if (deadline !== null && now >= deadline.instant) {
    /*
     * **What happens when the deadline runs out during the filling-in**
     * (finding 32). Not: swap the page. The typed state is the most expensive
     * thing on this screen — `FillIn` reads `initialAnswers` exactly once, after
     * that it is not recoverable —, and trading it for a refusal would be the
     * same data loss that `PublicFormView` secures its background refetch
     * against.
     *
     * Instead this one sentence changes its tone and says both: that a
     * submission is now rejected, and that nothing is gone.
     *
     * **And it says it alone.** The time limit falls away here: it describes how
     * long a filling-in was allowed to take, and this form accepts none any
     * more. Whoever read after the deadline how many minutes they would have would
     * get a piece of information there is nothing left to do with.
     */
    return {
      text: `Die Frist ist am ${deadline.when} abgelaufen. Eine Absendung wird nicht mehr angenommen; die Eingaben auf dieser Seite bleiben erhalten.`,
      expired: true,
    };
  }

  const sentences: string[] = [];
  if (deadline !== null) {
    sentences.push(
      `Dieses Formular kann noch bis ${deadline.when} ausgefüllt und abgesendet werden.`,
    );
  }
  if (timeLimitMin !== null) {
    /*
     * **„ab dem Öffnen dieser Seite" is not a stock phrase, but the
     * measurement.** The server counts from the point in time it has written
     * into the start token, and that comes into being when *reading* the form —
     * that is when opening this page, when resuming a draft and when opening an
     * answer for changing alike, each time anew
     * (`public-forms.service.ts`, three payloads). „Ab dem ersten Tippen" or
     * „ab dem Absenden" would be two other measurements, and both would stand
     * wrong here.
     *
     * What deliberately does **not** stand here is the gap: reloading fetches a
     * fresh token and thereby new minutes. That is decided so
     * (`start-token.service.ts`) and of no consequence for the honest
     * participant — to write it down would mean advertising the detour instead
     * of naming the boundary. The same holds for the background refetch after a
     * connection breakdown (`refetchOnReconnect`, TanStack Query's default): it
     * silently stamps a new token, so the participant then has **more** time than
     * this sentence promises. An error in their favour is the only one a display
     * above a foreign measurement may make.
     */
    sentences.push(
      `Für das Ausfüllen stehen ab dem Öffnen dieser Seite ${minutes(timeLimitMin)} zur Verfügung.`,
    );
  }

  return sentences.length === 0
    ? null
    : { text: sentences.join(' '), expired: false };
}

/**
 * The point in time and its wording, or `null`.
 *
 * Read together, because both sentences above need both halves and because next
 * to it stands a second reason to say nothing at all: a point in time that
 * nobody can read is no deadline that anybody can keep — better to say nothing
 * about it than to write „—" above the form (that is what `formatDeadline`
 * delivers for an unreadable value). **The time limit next to it stays
 * untouched by that** and is still named; the two boundaries are two pieces of
 * information, and the one does not fall away with the other.
 */
function readDeadline(
  closesAt: string | null,
): { readonly instant: number; readonly when: string } | null {
  if (closesAt === null) {
    return null;
  }
  const instant = Date.parse(closesAt);
  if (Number.isNaN(instant)) {
    return null;
  }
  // `formatDeadline` names the zone, for the same reason as in
  // `unavailableNotice`: a time of day whose zone one has to guess becomes
  // contentious between two organisations.
  return { instant, when: formatDeadline(closesAt) };
}

/**
 * „1 Minute" and „30 Minuten".
 *
 * A time limit of one minute is a borderline case that an editor may set
 * (`timeLimitMin` is a positive whole number), and „1 Minuten" above a public
 * form is exactly the kind of mistake an organisation gets reported.
 */
function minutes(count: number): string {
  return count === 1 ? '1 Minute' : `${String(count)} Minuten`;
}
