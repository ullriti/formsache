import { describe, expect, it } from 'vitest';

import {
  formatDeadline,
  toInstant,
  toLocalInput,
  zoneAbbreviation,
} from './berlin-time.ts';

/**
 * The deadline edge.
 *
 * The cases that matter are the two Sundays a year, and they are tested with
 * real transition dates rather than with a stand-in: 2026-03-29 and 2026-10-25
 * are the two the Jahrestagung-Anmeldung will actually straddle.
 */
describe('Berlin deadline conversion', () => {
  describe('winter time (MEZ, UTC+1)', () => {
    it('converts a local input to the UTC instant', () => {
      expect(toInstant('2026-01-15T18:00')).toBe('2026-01-15T17:00:00.000Z');
    });

    it('converts the instant back to the same local input', () => {
      expect(toLocalInput('2026-01-15T17:00:00.000Z')).toBe('2026-01-15T18:00');
    });

    it('labels the zone MEZ', () => {
      expect(zoneAbbreviation('2026-01-15T17:00:00.000Z')).toBe('MEZ');
    });
  });

  describe('summer time (MESZ, UTC+2)', () => {
    it('converts a local input to the UTC instant', () => {
      expect(toInstant('2026-08-15T18:00')).toBe('2026-08-15T16:00:00.000Z');
    });

    it('converts the instant back to the same local input', () => {
      expect(toLocalInput('2026-08-15T16:00:00.000Z')).toBe('2026-08-15T18:00');
    });

    it('labels the zone MESZ', () => {
      expect(zoneAbbreviation('2026-08-15T16:00:00.000Z')).toBe('MESZ');
    });
  });

  /**
   * Without the two-candidate resolution this is where a naive
   * `Date.parse(local + 'Z')` — or worse, `new Date(local)` in the viewer's own
   * zone — goes wrong by an hour, and an hour is the difference between „die
   * Anmeldung war noch offen" and „sie war zu".
   */
  describe('the spring transition, 2026-03-29 02:00 → 03:00', () => {
    it('keeps the hour before the gap at UTC+1', () => {
      expect(toInstant('2026-03-29T01:30')).toBe('2026-03-29T00:30:00.000Z');
    });

    it('keeps the hour after the gap at UTC+2', () => {
      expect(toInstant('2026-03-29T03:30')).toBe('2026-03-29T01:30:00.000Z');
    });

    it('resolves a time inside the gap forwards', () => {
      // 02:30 does not exist. It becomes 03:30 MESZ — the same instant 03:30
      // maps to — rather than jumping back to 01:30 or becoming null.
      const resolved = toInstant('2026-03-29T02:30');

      expect(resolved).toBe('2026-03-29T01:30:00.000Z');
      expect(toLocalInput(resolved)).toBe('2026-03-29T03:30');
    });
  });

  describe('the autumn transition, 2026-10-25 03:00 → 02:00', () => {
    it('takes the earlier of the two 02:30s (still summer time)', () => {
      const resolved = toInstant('2026-10-25T02:30');

      expect(resolved).toBe('2026-10-25T00:30:00.000Z');
      expect(zoneAbbreviation(resolved)).toBe('MESZ');
    });

    it('round-trips the later 02:30 to the same local input', () => {
      // Both instants are „02:30" in Berlin — that is the point of the
      // repeated hour, and the display must not pretend otherwise.
      expect(toLocalInput('2026-10-25T01:30:00.000Z')).toBe('2026-10-25T02:30');
      expect(zoneAbbreviation('2026-10-25T01:30:00.000Z')).toBe('MEZ');
    });

    it('keeps the hour after the transition at UTC+1', () => {
      expect(toInstant('2026-10-25T04:30')).toBe('2026-10-25T03:30:00.000Z');
    });
  });

  /**
   * The bug this describes was not a display detail: the zone label is derived
   * from an offset, the offset was computed against a wall clock that has no
   * milliseconds, and every *real* timestamp has them. A deadline typed into a
   * form ends in `:00` and was accidentally right; `{{datum}}` of a
   * confirmation mail, the mail log and the edit view carry the instant the
   * answer arrived — and printed „MEZ" through the whole summer, in a mail
   * nobody can recall.
   */
  describe('instants that carry milliseconds', () => {
    it('labels the same summer instant the same, with and without ms', () => {
      expect(zoneAbbreviation('2026-07-28T16:15:13.000Z')).toBe('MESZ');
      expect(zoneAbbreviation('2026-07-28T16:15:13.130Z')).toBe('MESZ');
      expect(zoneAbbreviation('2026-07-28T16:15:13.999Z')).toBe('MESZ');
    });

    it('labels the same winter instant the same, with and without ms', () => {
      expect(zoneAbbreviation('2026-01-28T16:15:13.000Z')).toBe('MEZ');
      expect(zoneAbbreviation('2026-01-28T16:15:13.130Z')).toBe('MEZ');
      expect(zoneAbbreviation('2026-01-28T16:15:13.999Z')).toBe('MEZ');
    });

    it('reads out a timestamp with milliseconds in the zone that holds', () => {
      expect(formatDeadline('2026-07-28T16:15:13.130Z')).toBe(
        '28.07.2026, 18:15 Uhr MESZ',
      );
      expect(formatDeadline('2026-01-28T16:15:13.130Z')).toBe(
        '28.01.2026, 17:15 Uhr MEZ',
      );
    });

    it('does not tip over at the transitions either', () => {
      // The last summer instant of 2026 and the first winter one, both with a
      // millisecond part. What this pins is the **boundary**: two of the four
      // are green with a truncating implementation as well (dropping `.999`
      // or `.001` does not cross the switch), so the millisecond defect itself
      // is what the three tests above prove — this one guards the edge they
      // work up to.
      expect(zoneAbbreviation('2026-10-25T00:59:59.999Z')).toBe('MESZ');
      expect(zoneAbbreviation('2026-10-25T01:00:00.001Z')).toBe('MEZ');
      expect(zoneAbbreviation('2026-03-29T00:59:59.999Z')).toBe('MEZ');
      expect(zoneAbbreviation('2026-03-29T01:00:00.001Z')).toBe('MESZ');
    });
  });

  describe('empty and unusable values', () => {
    it('reads „no deadline" as an empty field', () => {
      expect(toLocalInput(null)).toBe('');
      expect(toLocalInput('')).toBe('');
    });

    it('shows an empty field rather than a broken stored value', () => {
      expect(toLocalInput('irgendwann')).toBe('');
    });

    it('reads an empty field as „no deadline"', () => {
      expect(toInstant('')).toBeNull();
      expect(toInstant('2026-08-15')).toBeNull();
    });
  });

  /**
   * The empty field. Reading today's clock here would make the label flip twice
   * a year for a deadline nobody has entered — a value that changes with the
   * day it is looked at cannot be asserted, so a test ends up working around it
   * instead of checking it.
   */
  describe('the zone of a field with no instant in it', () => {
    it('names both abbreviations rather than guessing one', () => {
      expect(zoneAbbreviation(null)).toBe('MEZ/MESZ');
      expect(zoneAbbreviation('')).toBe('MEZ/MESZ');
      expect(zoneAbbreviation('irgendwann')).toBe('MEZ/MESZ');
    });
  });

  describe('the label a deadline is read out with', () => {
    it('names day, time and zone', () => {
      expect(formatDeadline('2026-08-15T16:00:00.000Z')).toBe(
        '15.08.2026, 18:00 Uhr MESZ',
      );
      expect(formatDeadline('2026-01-15T17:00:00.000Z')).toBe(
        '15.01.2026, 18:00 Uhr MEZ',
      );
    });

    it('says nothing rather than something wrong', () => {
      expect(formatDeadline(null)).toBe('—');
      expect(formatDeadline('irgendwann')).toBe('—');
    });
  });

  /**
   * The round-trip is the property that actually matters: whatever an editor
   * types has to come back unchanged when the page is reloaded — outside the
   * gap, where it comes back as the resolved time and the field says so.
   */
  it('round-trips every entered local time outside the gap', () => {
    for (const local of [
      '2026-01-01T00:00',
      '2026-03-29T01:59',
      '2026-03-29T03:00',
      '2026-06-15T12:34',
      '2026-10-25T01:59',
      '2026-10-25T03:00',
      '2026-12-31T23:59',
    ]) {
      expect(toLocalInput(toInstant(local))).toBe(local);
    }
  });
});
