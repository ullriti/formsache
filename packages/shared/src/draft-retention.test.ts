import { describe, expect, it } from 'vitest';

import { draftDeadline, draftExpiresAt } from './draft-retention.ts';
import { SYSTEM_FORM_SETTINGS, type FormSettings } from './form-settings.ts';
import { TRASH_RETENTION_DAYS } from './trash.ts';

/**
 * Konzept no. 63 — **wie lange ein Entwurf lebt**.
 *
 * Every case is measured against an injected `now`, which is the whole reason
 * the function takes one: „29 Tage bleibt, 31 ist weg" is not a statement a test
 * can make while the boundary reads `Date.now()`.
 */

const NOW = new Date('2026-08-05T10:00:00.000Z');
const DAY_MS = 86_400_000;

function settings(overrides: Partial<FormSettings> = {}): FormSettings {
  return { ...SYSTEM_FORM_SETTINGS, ...overrides };
}

describe('draftExpiresAt ', () => {
  it('keeps a draft for thirty days when the form has no Frist', () => {
    expect(draftExpiresAt(settings(), NOW)).toStrictEqual(
      new Date(NOW.getTime() + 30 * DAY_MS),
    );
  });

  /**
   * **The same number as the trash, and read from the same constant.**
   * Written as an assertion rather than as a comment because that is the whole
   * of the decision: three retentions that happen to agree today are three
   * numbers that drift, and this line fails if one of them moves alone.
   */
  it('counts the Papierkorb’s own retention, not a second thirty', () => {
    expect(draftExpiresAt(settings(), NOW)).toStrictEqual(
      new Date(NOW.getTime() + TRASH_RETENTION_DAYS * DAY_MS),
    );
  });

  it('lets a draft die with the Frist where one is set', () => {
    const closeAt = '2026-08-09T18:00:00.000Z';
    expect(
      draftExpiresAt(settings({ openEnabled: true, closeAt }), NOW),
    ).toStrictEqual(new Date(closeAt));
  });

  /**
   * The consequence the function's own comment names rather than hides: a deadline
   * six months out keeps drafts six months. It is asserted so that a later
   * reader meets the decision instead of assuming a cap that is not there.
   */
  it('does not cap a distant Frist at thirty days', () => {
    const closeAt = '2027-02-01T00:00:00.000Z';
    const expiry = draftExpiresAt(
      settings({ openEnabled: true, closeAt }),
      NOW,
    );
    expect(expiry).toStrictEqual(new Date(closeAt));
    expect(expiry.getTime()).toBeGreaterThan(NOW.getTime() + 30 * DAY_MS);
  });

  /**
   * The instants survive the switch being turned off — that is `closingInstant`'s
   * rule, and this is the reader that must not have a second opinion about it.
   */
  it('ignores a stored Frist while the Zeitraum switch is off', () => {
    expect(
      draftExpiresAt(
        settings({ openEnabled: false, closeAt: '2026-08-09T18:00:00.000Z' }),
        NOW,
      ),
    ).toStrictEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });

  /**
   * A JSONB column takes what a hand-written row puts in it. „Unlesbar" reads as
   * „keine Frist" here, which keeps the draft alive rather than deleting it
   * early — the direction that cannot lose somebody's typing to a broken row.
   */
  it('treats an unreadable Frist as no Frist', () => {
    expect(
      draftExpiresAt(
        settings({ openEnabled: true, closeAt: 'übermorgen' }),
        NOW,
      ),
    ).toStrictEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });
});

/**
 * The **deadline** on its own — what the settings writes cap stored rows at
 * (a review finding).
 *
 * It is the same reading of „gibt es eine Frist" the function above uses, which
 * is the point of exporting it rather than restating `settings.closeAt` in the
 * API: switch off, unreadable value and deadline agree in both, or a draft outlives
 * a deadline in one reader and not in the other.
 */
describe('draftDeadline (ein Review-Befund)', () => {
  it('is the Frist where one applies', () => {
    const closeAt = '2026-08-09T18:00:00.000Z';
    expect(
      draftDeadline(settings({ openEnabled: true, closeAt })),
    ).toStrictEqual(new Date(closeAt));
  });

  it.each([
    ['keine Frist gesetzt ist', settings()],
    [
      'der Zeitraum-Schalter aus ist',
      settings({ openEnabled: false, closeAt: '2026-08-09T18:00:00.000Z' }),
    ],
    [
      'der gespeicherte Wert kein Datum ist',
      settings({ openEnabled: true, closeAt: 'übermorgen' }),
    ],
  ])('is null where %s', (_name, value) => {
    expect(draftDeadline(value)).toBeNull();
  });

  /** One rule, two readers: the expiry is the deadline wherever there is one. */
  it('agrees with draftExpiresAt wherever it answers a date', () => {
    const withFrist = settings({
      openEnabled: true,
      closeAt: '2026-08-09T18:00:00.000Z',
    });
    expect(draftExpiresAt(withFrist, NOW)).toStrictEqual(
      draftDeadline(withFrist),
    );
  });
});
