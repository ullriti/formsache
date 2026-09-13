import {
  availabilityBadge,
  availabilityOf,
  formatDeadline,
  type FormSettings,
} from '@formsache/shared';

/**
 * The live status badge of the settings page (handoff).
 *
 * **The window arithmetic is not repeated here.** `availabilityOf()` and
 * `availabilityBadge()` live in `@formsache/shared`, next to `effectiveSettings()`,
 * and the public fill-in view and the server's submission-time enforcement
 * read the very same functions. What is left in this module is the
 * *wording* — which is a rendering decision and belongs to the view.
 *
 * **`responseCount: null` is deliberate, not a placeholder.** The editor's
 * badge answers „ist das Fenster offen?"; how full the form is belongs to the
 * Antworten view, which knows the count. Passing a fabricated `0` would have
 * claimed knowledge this page does not have and would have made a full form
 * look open.
 *
 * **The badge is a reading, not a rule.** Whether a submission is accepted is
 * decided by the server against its own clock at the moment it arrives
 * ; this says what the settings on screen mean, right now —
 * before they are saved, which is the point of it being live.
 */

export type AvailabilityTone = 'open' | 'scheduled' | 'closed';

export interface AvailabilityStatus {
  /** The full reading, with the instant it depends on. */
  readonly label: string;
  /**
   * The same reading without the date — what the badge shows below the
   * breakpoint.
   *
   * „Geschlossen seit 15.08.2026, 23:59 Uhr MESZ" is wider than a 360 px
   * viewport, and the shell hides horizontal overflow, so the long label would
   * be **cut off** rather than scrolled to. Nothing is lost by dropping the
   * date there: it stands in the deadline field the badge reads it from.
   */
  readonly shortLabel: string;
  readonly tone: AvailabilityTone;
}

export function availabilityStatus(
  settings: FormSettings,
  now: Date = new Date(),
): AvailabilityStatus {
  const availability = availabilityOf({ settings, now, responseCount: null });

  switch (availabilityBadge(availability)) {
    case 'always_open':
      return {
        label: 'Immer geöffnet',
        shortLabel: 'Immer geöffnet',
        tone: 'open',
      };
    case 'scheduled':
      return {
        label: `Geplant · öffnet ${formatDeadline(availability.opensAt)}`,
        shortLabel: 'Geplant',
        tone: 'scheduled',
      };
    case 'closed':
      return {
        label: `Geschlossen seit ${formatDeadline(availability.closesAt)}`,
        shortLabel: 'Geschlossen',
        tone: 'closed',
      };
    case 'limit_reached':
      // Unreachable while `responseCount` is null — `availabilityOf` only
      // reaches this state when a count was supplied. Answered rather than
      // asserted away: should the badge ever learn the count, „voll" is a
      // closed form, and saying so is better than a non-null assertion.
      return {
        label: 'Antwortlimit erreicht',
        shortLabel: 'Limit erreicht',
        tone: 'closed',
      };
    case 'open':
      return {
        label:
          availability.closesAt === null
            ? 'Geöffnet'
            : `Geöffnet · bis ${formatDeadline(availability.closesAt)}`,
        shortLabel: 'Geöffnet',
        tone: 'open',
      };
  }
}
