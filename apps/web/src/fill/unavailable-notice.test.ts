import { describe, expect, it } from 'vitest';

import { unavailableNotice } from './unavailable-notice';

/**
 * The requirement, second half — „the fill-in view of a closed
 * form shows the state instead of offering a form".
 *
 * The wording is asserted here rather than through the view, so the four cases
 * are four assertions instead of four renders — and so `PublicFormView` only
 * has to be shown to *use* it.
 */
describe('unavailableNotice', () => {
  it('says nothing about an open form, so a caller cannot show both', () => {
    expect(
      unavailableNotice({ state: 'open', opensAt: null, closesAt: null }),
    ).toBeNull();
  });

  it('names the opening instant with its zone while the form is still to come', () => {
    const notice = unavailableNotice({
      state: 'not_yet_open',
      // 01.09.2026, 08:00 MESZ — summer, so the offset is +2.
      opensAt: '2026-09-01T06:00:00.000Z',
      closesAt: null,
    });

    expect(notice?.headline).toBe('Dieses Formular ist noch nicht geöffnet.');
    expect(notice?.detail).toBe('Es öffnet am 01.09.2026, 08:00 Uhr MESZ.');
  });

  it('names the closing instant with its zone once the deadline has passed', () => {
    const notice = unavailableNotice({
      state: 'closed',
      opensAt: null,
      // 15.12.2026, 18:00 MEZ — winter, so the offset is +1. The two cases
      // together are what would go wrong if the label were computed from the
      // reader's own clock instead of from the instant.
      closesAt: '2026-12-15T17:00:00.000Z',
    });

    expect(notice?.headline).toBe(
      'Die Frist für dieses Formular ist abgelaufen.',
    );
    expect(notice?.detail).toBe('Sie endete am 15.12.2026, 18:00 Uhr MEZ.');
  });

  it('falls back to a sentence without a date when none was sent', () => {
    expect(
      unavailableNotice({ state: 'closed', opensAt: null, closesAt: null })
        ?.detail,
    ).toBe('Es können keine Antworten mehr abgegeben werden.');
  });

  /**
   * The count is configuration, and the requirement keeps it off the wire. So the
   * notice cannot name it — and must not sound as if it could.
   */
  it('reports a full form without quoting a number it does not have', () => {
    const notice = unavailableNotice({
      state: 'limit_reached',
      opensAt: null,
      closesAt: null,
    });

    expect(notice?.headline).toBe('Die Höchstzahl an Antworten ist erreicht.');
    expect(notice?.detail).not.toMatch(/\d/);
  });

  /**
   * Finding 32, second part — „die formulare sind ja nicht immer anmeldungen".
   *
   * Asserted as a rule over all four states and not only on the three
   * sentences above: otherwise the next wording that is added here reaches
   * for the nearest word again. **„Anmeldung" is no synonym for „Formular"
   * in the fill-in path** — the same address carries a survey, a
   * needs enquiry and a piece of feedback.
   */
  it('never calls the form a registration, whatever its state', () => {
    for (const state of ['not_yet_open', 'closed', 'limit_reached'] as const) {
      const notice = unavailableNotice({
        state,
        opensAt: '2026-09-01T06:00:00.000Z',
        closesAt: '2026-12-15T17:00:00.000Z',
      });

      expect(`${notice?.headline ?? ''} ${notice?.detail ?? ''}`).not.toMatch(
        /Anmeld/i,
      );
    }
  });
});
