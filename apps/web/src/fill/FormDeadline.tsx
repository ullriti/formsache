import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { deadlineNotice } from './deadline-notice';

/**
 * The deadline and the time limit above the form — **and the clock that sees the
 * deadline expire** (finding 32).
 *
 * The wording is in {@link deadlineNotice}; here stands only the one thing that
 * is a component about it: a timer that fires exactly once when the
 * deadline is reached.
 *
 * **The timer belongs to the deadline alone.** The time limit stands in the same
 * line but has nothing to clock here: when *its* minutes run out is the
 * server's measurement from the moment in the signed start proof, which this
 * page does not know — see `DeadlineNotice.expired`. It is a number that
 * stands there, not an alarm clock.
 *
 * **No second-by-second tick.** A countdown nags — on a page on
 * which somebody is thinking and typing it constantly draws the eye to itself, and it would be
 * a statement accurate to the minute that this page must not make at all (the
 * clock that counts is the server's). So a line that stands still, and
 * a single change at the moment at which it is no longer right.
 *
 * **Nothing is blocked.** The submit button stays, even after the change:
 * a browser clock going wrong would otherwise take a submission away from somebody that the
 * server would have accepted — a client check is UX, never truth
 * (`CONTRIBUTING.md`). If it is refused after all, that is already in the
 * 409 message under the fields.
 */
export function FormDeadline({
  closesAt,
  timeLimitMin,
}: {
  readonly closesAt: string | null;
  /** The minutes per fill-in, or `null` — `publicFormSchema.timeLimitMin`. */
  readonly timeLimitMin: number | null;
}): ReactElement | null {
  /*
   * The clock as state, so that the change is a render pass.
   *
   * `Date.now()` and not a counter: the effect below computes the remaining time
   * out of *this* value, and a timer that fires too early (the browser
   * paused the tab, the device slept) thereby arms itself anew by itself,
   * instead of setting the state wrongly once.
   */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (closesAt === null) {
      return;
    }
    const instant = Date.parse(closesAt);
    if (Number.isNaN(instant)) {
      return;
    }
    const remaining = instant - now;
    if (remaining <= 0) {
      // Over — there is nothing left to wait for, and a timer that still
      // ran would be an alarm clock without an appointment.
      return;
    }
    /*
     * `setTimeout` computes its delay in a signed
     * 32-bit value: anything over ~24.8 days overflows and fires **immediately**. A
     * deadline two months away is nothing unusual for a form, and
     * the overflow would not be a visible error but a timer running
     * in a loop. So it is capped and armed anew — the effect runs
     * again after every `setNow`.
     */
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.min(remaining, MAX_TIMEOUT_MS),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [closesAt, now]);

  const notice = deadlineNotice({ closesAt, timeLimitMin, now });
  if (notice === null) {
    return null;
  }

  return (
    <p
      className={
        notice.expired
          ? 'public__deadline public__deadline--expired'
          : 'public__deadline'
      }
      data-testid="public-deadline"
      /*
       * `role="status"` and not `alert`: the participant has done nothing
       * wrong, and the change is the running of the clock, not the failure
       * of an action.
       *
       * **The region is there before the change already.** A form with a deadline
       * renders this paragraph from the first render pass on; once expired only
       * its *text* changes. That is the condition under which a live region
       * speaks at all — one that only comes into being together with its text
       * is new in the accessibility tree when the text arrives, and is then often
       * not announced at all (the same rule as with the page announcement in
       * `FillIn`). A form without a deadline **and** without a time limit renders
       * nothing — there is never a change to announce there either; one with
       * a mere time limit renders a line that stays standing, and thereby keeps
       * quiet just the same.
       */
      role="status"
    >
      {notice.text}
    </p>
  );
}

/** What `setTimeout` just barely accepts as a delay — see above. */
const MAX_TIMEOUT_MS = 2_147_483_647;
