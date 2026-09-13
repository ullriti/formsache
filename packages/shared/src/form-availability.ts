import { z } from 'zod';

import type { FormSettings } from './form-settings.ts';

/**
 * Is this form open? — asked once, in one place.
 *
 * It sits next to `effectiveSettings()` for the same reason that function
 * exists: three consumers ask the question and must not answer it three times.
 * The public fill-in payload carries a **verdict** (the public payload contract),
 * the editor's settings page shows a live badge (the live-badge requirement),
 * and submission handling *enforces* the same window when a
 * submission arrives. `apps/web` cannot import `apps/api`, so a
 * version living in the API would have forced the badge to restate the
 * arithmetic — which is exactly the duplication this project has paid for before.
 *
 * **Two things this is not.**
 *
 * 1. **It is not enforcement.** Nothing here refuses anything. A verdict
 *    computed when a page was *loaded* is precisely the stale value the
 *    submission check exists to defeat — the browser tab left open across the
 *    deadline. The submission check and the edit check call this again, with
 *    the server's clock at the moment of submission, and act
 *    on the answer inside a transaction.
 * 2. **It is not the public payload.** {@link FormAvailability} carries one
 *    field more than a stranger is given; {@link publicAvailability} is the
 *    documented subset the public payload contract pins down. Adding a field here is free, adding one
 *    *there* has to be justified.
 */

/**
 * What is true of a form right now.
 *
 * A schema rather than a bare union because the verdict travels to the public
 * fill-in view and therefore has to be *parsed* there, not
 * trusted — and a second, hand-written list of the four names next to this one
 * is exactly the drift `CONTRIBUTING.md` forbids.
 */
export const availabilityStateSchema = z.enum([
  'open',
  'not_yet_open',
  'closed',
  'limit_reached',
]);
export type AvailabilityState = z.infer<typeof availabilityStateSchema>;

/** The full verdict — what an editor's badge is built from. */
export interface FormAvailability {
  readonly state: AvailabilityState;
  /**
   * When the form opens — non-null **only** while it has not opened yet. After
   * opening the instant renders nothing and would just be one more configured
   * value travelling around.
   */
  readonly opensAt: string | null;
  /**
   * When the form closes, if it does — non-null while it is open (so a
   * participant sees the deadline they are working against) and after it has
   * closed (so „war bis …" can be said instead of a bare „geschlossen").
   */
  readonly closesAt: string | null;
  /**
   * Whether a time window is configured at all.
   *
   * This is the field the public payload does **not** get, and the reason it
   * exists: the editor's badge distinguishes „Geöffnet" from „Immer geöffnet"
   * (design handoff), and the two differ only in whether anybody set a window. A
   * participant has no use for that difference — an open form is open.
   */
  readonly windowConfigured: boolean;
}

/**
 * The three fields the public endpoint carries.
 *
 * Derived with `Omit` rather than written out, so a field added to the verdict
 * cannot silently join the public payload — it has to be excluded here or
 * consciously let through.
 */
export type PublicAvailability = Omit<FormAvailability, 'windowConfigured'>;

/** The badge of the settings page (design handoff), one label per state. */
export type AvailabilityBadge =
  'always_open' | 'open' | 'scheduled' | 'closed' | 'limit_reached';

export interface AvailabilityInput {
  /** The **effective** settings — the result of `effectiveSettings()`. */
  readonly settings: FormSettings;
  /** The clock to judge against. Passed in, never read here, so the function
   * stays pure and a test can stand on a boundary instead of near it. */
  readonly now: Date;
  /**
   * Answers so far, or `null` when the caller does not know.
   *
   * `null` and not an optional parameter defaulting to zero: „ich weiß es
   * nicht" and „es sind keine" lead to different verdicts, and a default would
   * quietly pick the second. A caller that passes `null` gets a verdict with
   * the response limit left out of it — which is what the editor's badge
   * wants, and what {@link needsResponseCount} lets a server avoid a query for.
   */
  readonly responseCount: number | null;
}

/**
 * The verdict.
 *
 * The order of the tests is the order a participant experiences it: a form that
 * has not opened is not „voll", and one that has closed is not „offen mit
 * Restplätzen".
 */
export function availabilityOf(input: AvailabilityInput): FormAvailability {
  const { settings, now, responseCount } = input;

  // The window only counts while the switch is on. The instants survive the
  // switch being turned off — the editor's values are not discarded — so
  // reading them regardless would close forms nobody meant to close.
  const openAt =
    settings.openEnabled && settings.openAt !== null ? settings.openAt : null;
  const closeAt = closingInstant(settings);
  const windowConfigured = openAt !== null || closeAt !== null;

  const instant = now.getTime();

  if (openAt !== null && instant < Date.parse(openAt)) {
    return {
      state: 'not_yet_open',
      opensAt: openAt,
      closesAt: null,
      windowConfigured,
    };
  }
  if (closeAt !== null && instant >= Date.parse(closeAt)) {
    return {
      state: 'closed',
      opensAt: null,
      closesAt: closeAt,
      windowConfigured,
    };
  }
  if (
    settings.maxResponsesEnabled &&
    responseCount !== null &&
    responseCount >= settings.maxResponses
  ) {
    return {
      state: 'limit_reached',
      opensAt: null,
      closesAt: closeAt,
      windowConfigured,
    };
  }
  return { state: 'open', opensAt: null, closesAt: closeAt, windowConfigured };
}

/**
 * **When this form closes, or `null`** — the one reading of „hat dieses Formular
 * eine Frist".
 *
 * Lifted out of {@link availabilityOf} for a second reader: the life of a
 * saved draft ends with the deadline where one is set (`draft-retention.ts`). Written once because the rule is not just
 * `settings.closeAt` — the instants survive the switch being turned off, so
 * reading the column regardless would close forms nobody meant to close, and a
 * second spelling of that would be the drift this project keeps removing.
 *
 * Deliberately **not** read off a verdict's `closesAt`: that field is `null`
 * while a form is `not_yet_open`, so a caller asking „gibt es eine Frist" would
 * get „nein" for a form that has one and simply has not opened yet.
 */
export function closingInstant(settings: FormSettings): string | null {
  return settings.openEnabled && settings.closeAt !== null
    ? settings.closeAt
    : null;
}

/** Whether a verdict needs the answer count at all — see {@link availabilityOf}. */
export function needsResponseCount(settings: FormSettings): boolean {
  return settings.maxResponsesEnabled;
}

/**
 * The subset a stranger receives.
 *
 * Written as an explicit projection rather than a spread-and-delete: the
 * positive-list test asserts these three key names, and this is the line that
 * has to change first if that list ever should.
 */
export function publicAvailability(
  availability: FormAvailability,
): PublicAvailability {
  return {
    state: availability.state,
    opensAt: availability.opensAt,
    closesAt: availability.closesAt,
  };
}

/**
 * The badge label of the settings page.
 *
 * „Immer geöffnet" is *open without a configured window* — the one distinction
 * the state alone cannot make, and the reason {@link FormAvailability} carries
 * `windowConfigured`. Kept here rather than in the view so that the editor's
 * badge and any later surface agree on what „immer" means.
 */
export function availabilityBadge(
  availability: FormAvailability,
): AvailabilityBadge {
  switch (availability.state) {
    case 'open':
      return availability.windowConfigured ? 'open' : 'always_open';
    case 'not_yet_open':
      return 'scheduled';
    case 'closed':
      return 'closed';
    case 'limit_reached':
      return 'limit_reached';
  }
}
