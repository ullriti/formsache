/**
 * The one place where a deadline crosses between a wall clock and an instant
 * (client decision, Konzept no. 16).
 *
 * **In `@formsache/shared`, not in the web app**, for the same reason
 * `effectiveSettings()` and `availabilityOf()` are: three consumers need the
 * identical wall clock. The editor's settings page converts what is typed,
 * the submission path compares it against the stored instant, and
 * the confirmation mails print a deadline into text nobody can
 * recall. Two implementations of „18:00 Uhr MESZ" would disagree exactly
 * once a year, on a Sunday, in the middle of a semester.
 *
 * **Input is `Europe/Berlin`, storage is UTC.** The editor types into a
 * `datetime-local` field, which carries no zone at all; the shared schema
 * accepts a UTC instant and *rejects* both a naive value and one with an
 * explicit offset, so the conversion cannot be skipped and cannot be spelled
 * two ways. Doing it here — rather than letting `new Date(local)` guess the
 * viewer's own zone — is what makes „18:00 Uhr" mean the same thing to a
 * Mitglied in Stuttgart, to one on holiday in Lissabon and to the server
 * clock that will compare against it.
 *
 * **Daylight saving is handled, not hoped for.** Two hours a year are not what
 * they look like, and both fall inside a semester:
 *
 * - *Sommerzeitbeginn* (last Sunday in March, 02:00 → 03:00): local times in
 *   the gap do not exist. `toInstant` resolves them **forwards** — 02:30 becomes
 *   03:30 MESZ — the same rule `Temporal`'s `compatible` disambiguation uses.
 *   Refusing the input instead would leave an editor staring at a value the
 *   date picker happily offered them.
 * - *Sommerzeitende* (last Sunday in October, 03:00 → 02:00): local times in
 *   that hour happen twice. `toInstant` takes the **earlier** of the two, again
 *   matching `compatible`. For an opening that is the more permissive reading,
 *   for a closing the stricter one — and either way it is written down, which
 *   is what an organisation arguing about a deadline needs.
 *
 * No dependency: `Intl` knows the zone rules, and the arithmetic below is the
 * standard two-candidate resolution over them.
 */

/** The zone every deadline of this application is entered in. */
export const DEADLINE_TIME_ZONE = 'Europe/Berlin';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Wall-clock parts of an instant in Berlin.
 *
 * `formatToParts` rather than a formatted string: the assembled output below is
 * matched character by character, and a locale that inserts a narrow no-break
 * space would silently break every round-trip check.
 */
const berlinParts = new Intl.DateTimeFormat('en-US', {
  timeZone: DEADLINE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClockOf(instantMs: number): WallClock {
  const parts = new Map<string, string>(
    berlinParts
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, part.value]),
  );

  const read = (type: string): number => Number(parts.get(type) ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * How far Berlin runs ahead of UTC at a given instant, in milliseconds.
 *
 * **The instant is truncated to the second before the subtraction**, because
 * the wall clock it is subtracted from has no milliseconds: `formatToParts`
 * stops at the second, so `16:15:13.130Z` in summer would come out as
 * `7_200_000 − 130`, and every caller comparing against `2 * HOUR_MS` would
 * read that as winter time. Deadlines end in `:00` and hid this; the instants
 * that carry a millisecond part are the real ones — the moment an answer
 * arrived, which `{{datum}}` prints into a mail that cannot be recalled.
 *
 * `Math.floor` rather than a truncation towards zero: it matches how the
 * formatter reads a wall clock on both sides of the epoch.
 */
function offsetAt(instantMs: number): number {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  const wall = wallClockOf(wholeSecond);
  return (
    Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    ) - wholeSecond
  );
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** `YYYY-MM-DDTHH:mm` — the value shape of a `datetime-local` field. */
function localInputOf(instantMs: number): string {
  const wall = wallClockOf(instantMs);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * A stored instant as the `datetime-local` field shows it, or `''` for „no
 * deadline".
 *
 * An unparseable stored value also yields `''`: the field can only hold a
 * well-formed local time, and showing an empty box beats showing a broken one
 * that the next save would write back.
 */
export function toLocalInput(instant: string | null): string {
  if (instant === null || instant === '') {
    return '';
  }
  const parsed = Date.parse(instant);
  return Number.isNaN(parsed) ? '' : localInputOf(parsed);
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * A wall-clock time in Berlin as a UTC instant (`2026-08-15T21:59:00.000Z`), or
 * `null` when the field is empty or holds something that is not a local time.
 *
 * The two candidates come from the offsets a day before and a day after the
 * entered time, which is how both sides of a transition are reached without
 * knowing where the transition sits. Exactly one of them round-trips on an
 * ordinary day, both do in the repeated hour, neither does in the gap.
 */
export function toInstant(localInput: string): string | null {
  const match = LOCAL_INPUT.exec(localInput);
  if (match === null) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;
  const asIfUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (Number.isNaN(asIfUtc)) {
    return null;
  }

  // Before the transition first: it is the fallback for the gap, and taking it
  // there is what shifts a non-existent 02:30 forwards to 03:30 rather than
  // backwards to 01:30 — an editor who typed „half past two" means the half
  // hour after two, not the one before it.
  const offsets = [offsetAt(asIfUtc - DAY_MS), offsetAt(asIfUtc + DAY_MS)];
  const candidates = [...new Set(offsets)].map((offset) => asIfUtc - offset);
  const expected = localInput.slice(0, 16);

  const resolved =
    candidates
      .filter((candidate) => localInputOf(candidate) === expected)
      // The repeated hour: the earlier instant is still summer time, and that
      // is the one `compatible` disambiguation picks.
      .sort((one, other) => one - other)[0] ?? candidates[0];

  return resolved === undefined ? null : new Date(resolved).toISOString();
}

/**
 * **The start of the calendar month `now` lies in, in Berlin** (ADR-0015
 * no. 7).
 *
 * The AI quota of an organisation is a number of calls **per
 * calendar month**, „weil der Monat die Einheit ist, in der die Rechnung kommt
 * und in der ein Kassenwart denkt". This function is the boundary that is
 * counted against: `created_at >= berlinMonthStart(now)`.
 *
 * **Here and not in the counter**, for the same reason `toInstant` stands
 * here: it is a conversion between wall clock and instant, and the
 * application has exactly one version of it. A `new Date(y, m, 1)` in the
 * service would read the zone of the server — UTC in this application —, and
 * the 1st of a month would begin two hours too early for an organisation: the
 * calls of the last evening would fall into the new month and would be free
 * twice.
 *
 * The month start never lies in a daylight saving transition (Berlin switches
 * on Sundays at 02:00/03:00), but the resolution runs through
 * {@link toInstant} nonetheless — a second, "good enough for this case"
 * conversion would be the second spelling that this module avoids.
 */
export function berlinMonthStart(now: Date): Date {
  const wall = wallClockOf(now.getTime());
  const instant = toInstant(`${pad(wall.year, 4)}-${pad(wall.month)}-01T00:00`);
  /* c8 ignore next 4 -- unreachable: the string above always matches
     LOCAL_INPUT and `Date.UTC` of a formatted wall clock is never NaN. The
     branch exists because `toInstant` answers `null` for input this function
     does not produce. */
  if (instant === null) {
    throw new Error('berlinMonthStart: could not resolve the month boundary');
  }
  return new Date(instant);
}

/**
 * The zone abbreviation that has to stand next to every deadline in the
 * interface.
 *
 * Derived from the offset rather than from `timeZoneName: 'short'`: the ICU
 * short name depends on the locale data a runtime happens to ship, and a
 * deadline label that reads „GMT+2" in one environment and „MESZ" in another is
 * the ambiguity this label exists to remove. Berlin has exactly two offsets.
 *
 * **Without an instant the answer is `'MEZ/MESZ'`, not today's abbreviation.**
 * An empty deadline field has no point in time to be in a zone at, and reading
 * the clock instead would make the label flip twice a year for a field nobody
 * has filled in — a value that changes with the day it is looked at cannot be
 * asserted, which is how a test ends up working around it instead of checking
 * it. Naming both is the honest answer to „welche Zone gilt hier?".
 */
export function zoneAbbreviation(
  instant: string | null,
): 'MEZ' | 'MESZ' | 'MEZ/MESZ' {
  if (instant === null || instant === '') {
    return 'MEZ/MESZ';
  }
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) {
    return 'MEZ/MESZ';
  }
  return offsetAt(parsed) >= 2 * HOUR_MS ? 'MESZ' : 'MEZ';
}

/**
 * A deadline as it is read out loud: `15.08.2026, 23:59 Uhr MESZ`.
 *
 * Assembled from the parts rather than through `toLocaleString`, so the output
 * does not change with the browser's locale — the zone is fixed for this
 * application, and the format that goes with it should be too.
 */
export function formatDeadline(instant: string | null): string {
  if (instant === null || instant === '') {
    return '—';
  }
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) {
    return '—';
  }

  const wall = wallClockOf(parsed);
  return `${pad(wall.day)}.${pad(wall.month)}.${pad(wall.year, 4)}, ${pad(wall.hour)}:${pad(wall.minute)} Uhr ${zoneAbbreviation(instant)}`;
}
