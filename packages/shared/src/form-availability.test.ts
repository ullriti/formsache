import { describe, expect, it } from 'vitest';

import {
  availabilityBadge,
  availabilityOf,
  needsResponseCount,
  publicAvailability,
  type FormAvailability,
} from './form-availability.ts';
import { SYSTEM_FORM_SETTINGS, type FormSettings } from './form-settings.ts';

/**
 * The verdict of the public route — and the badge of the settings page, which is the same
 * arithmetic with one more distinction on top.
 *
 * Unit tests, because the function is pure and the cases are arithmetic: what
 * needs a database is whether the *payload* carries only the documented subset
 * (the allow list in `apps/api/test/public/public-forms.spec.ts`).
 */

function settings(overrides: Partial<FormSettings> = {}): FormSettings {
  return { ...SYSTEM_FORM_SETTINGS, ...overrides };
}

const NOON = new Date('2026-08-15T12:00:00Z');

/** One verdict, with the three inputs spelled out at each call site. */
function at(
  now: Date,
  overrides: Partial<FormSettings> = {},
  responseCount: number | null = null,
): FormAvailability {
  return availabilityOf({ settings: settings(overrides), now, responseCount });
}

describe('availabilityOf ', () => {
  it('calls a form without any window open, and says no window was set', () => {
    expect(at(NOON)).toEqual({
      state: 'open',
      opensAt: null,
      closesAt: null,
      windowConfigured: false,
    });
  });

  it('reports a window that has not started, and when it will', () => {
    const verdict = at(NOON, {
      openEnabled: true,
      openAt: '2026-08-15T18:00:00Z',
      closeAt: '2026-08-20T18:00:00Z',
    });

    expect(verdict.state).toBe('not_yet_open');
    expect(verdict.opensAt).toBe('2026-08-15T18:00:00Z');
    // The closing instant is withheld while the form has not opened: nothing
    // on the page renders it, and the public payload contract stops at „für die Anzeige Nötige".
    expect(verdict.closesAt).toBeNull();
  });

  it('reports a window that has ended, and when it did', () => {
    expect(
      at(NOON, { openEnabled: true, closeAt: '2026-08-15T11:59:00Z' }),
    ).toEqual({
      state: 'closed',
      opensAt: null,
      closesAt: '2026-08-15T11:59:00Z',
      windowConfigured: true,
    });
  });

  /**
   * The boundary, stated rather than left to a reader of `<` versus `<=`: a
   * form closes **at** its closing instant and is already open **at** its
   * opening one. Two comparisons, two assertions.
   */
  it('is open at the opening instant and closed at the closing one', () => {
    const window = {
      openEnabled: true,
      openAt: '2026-08-15T12:00:00Z',
      closeAt: '2026-08-20T12:00:00Z',
    };

    expect(at(new Date('2026-08-15T12:00:00Z'), window).state).toBe('open');
    expect(at(new Date('2026-08-15T11:59:59Z'), window).state).toBe(
      'not_yet_open',
    );
    expect(at(new Date('2026-08-20T12:00:00Z'), window).state).toBe('closed');
    expect(at(new Date('2026-08-20T11:59:59Z'), window).state).toBe('open');
  });

  /**
   * The instants outlive the switch — the editor's values are not discarded
   * when the section is toggled off — so reading them regardless of
   * `openEnabled` would close forms nobody meant to close.
   */
  it('ignores a stored window while the switch is off', () => {
    expect(
      at(NOON, {
        openEnabled: false,
        openAt: '2026-09-01T00:00:00Z',
        closeAt: '2026-09-02T00:00:00Z',
      }),
    ).toEqual({
      state: 'open',
      opensAt: null,
      closesAt: null,
      windowConfigured: false,
    });
  });

  it('reports a reached limit as a state, at the limit and beyond', () => {
    const limited = { maxResponsesEnabled: true, maxResponses: 10 };

    expect(at(NOON, limited, 9).state).toBe('open');
    expect(at(NOON, limited, 10).state).toBe('limit_reached');
    expect(at(NOON, limited, 11).state).toBe('limit_reached');
  });

  /**
   * `null` is „ich weiß es nicht", not „es sind keine".
   *
   * The editor's badge does not count answers, and a parameter defaulting to
   * zero would have made it report „offen" for a form that is in fact full —
   * the friendly wrong answer. Passing `null` leaves the limit out of the
   * verdict instead of guessing at it.
   */
  it('leaves the limit out of the verdict when the count is unknown', () => {
    const limited = { maxResponsesEnabled: true, maxResponses: 1 };

    expect(at(NOON, limited, null).state).toBe('open');
    expect(at(NOON, limited, 5).state).toBe('limit_reached');
  });

  it('ignores the count while no limit is configured', () => {
    expect(at(NOON, {}, 10_000).state).toBe('open');
    expect(needsResponseCount(settings())).toBe(false);
    expect(needsResponseCount(settings({ maxResponsesEnabled: true }))).toBe(
      true,
    );
  });

  /**
   * The order matters and is the order a participant experiences: a form that
   * has not opened is not „voll", and one that has closed is not „offen mit
   * Restplätzen". Asserted with both conditions true at once, because that is
   * the only arrangement in which a wrong order shows.
   */
  it('answers the window before the limit', () => {
    expect(
      at(
        NOON,
        {
          openEnabled: true,
          openAt: '2026-08-16T00:00:00Z',
          maxResponsesEnabled: true,
          maxResponses: 1,
        },
        50,
      ).state,
    ).toBe('not_yet_open');

    expect(
      at(
        NOON,
        {
          openEnabled: true,
          closeAt: '2026-08-01T00:00:00Z',
          maxResponsesEnabled: true,
          maxResponses: 1,
        },
        50,
      ).state,
    ).toBe('closed');
  });
});

describe('publicAvailability ', () => {
  /**
   * The projection is the wall between the two audiences. A field added to the
   * verdict — `windowConfigured` was the first — must not reach a stranger just
   * because the editor needed it, and this test is what makes the next such
   * field a decision instead of a side effect.
   */
  it('hands out exactly three keys, and not the one the badge needs', () => {
    const verdict = at(NOON, {
      openEnabled: true,
      closeAt: '2026-08-20T18:00:00Z',
      maxResponsesEnabled: true,
      maxResponses: 300,
      passwordEnabled: true,
      password: 'streng-geheim',
    });
    expect(verdict.windowConfigured).toBe(true);

    const publicView = publicAvailability(verdict);
    expect(Object.keys(publicView).sort()).toEqual([
      'closesAt',
      'opensAt',
      'state',
    ]);
    expect(JSON.stringify(publicView)).not.toContain('300');
    expect(JSON.stringify(publicView)).not.toContain('streng-geheim');
    expect(JSON.stringify(publicView)).not.toContain('windowConfigured');
  });
});

describe('availabilityBadge ', () => {
  /**
   * „Immer geöffnet" is the label the state alone cannot produce: it is *open
   * without a configured window*. Deriving it here rather than in the view is
   * what keeps the editor's badge and any later surface agreeing on „immer".
   */
  it('tells „Immer geöffnet" from „Geöffnet"', () => {
    expect(availabilityBadge(at(NOON))).toBe('always_open');
    expect(
      availabilityBadge(
        at(NOON, { openEnabled: true, closeAt: '2026-08-20T18:00:00Z' }),
      ),
    ).toBe('open');
  });

  it('maps the remaining three states one to one', () => {
    expect(
      availabilityBadge(
        at(NOON, { openEnabled: true, openAt: '2026-09-01T00:00:00Z' }),
      ),
    ).toBe('scheduled');
    expect(
      availabilityBadge(
        at(NOON, { openEnabled: true, closeAt: '2026-01-01T00:00:00Z' }),
      ),
    ).toBe('closed');
    expect(
      availabilityBadge(
        at(NOON, { maxResponsesEnabled: true, maxResponses: 1 }, 1),
      ),
    ).toBe('limit_reached');
  });
});
