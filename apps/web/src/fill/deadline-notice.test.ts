import { describe, expect, it } from 'vitest';

import { deadlineNotice } from './deadline-notice';

/**
 * Finding 32 — „Frist und Zeitlimit sieht der Teilnehmer nicht".
 *
 * The wording is checked here and not through the view: the cases are
 * assertions instead of render runs, and `FillIn` only has to show that it
 * *uses* the line — the same split that `unavailable-notice.test.ts` next door
 * already makes.
 */
describe('deadlineNotice', () => {
  // 15.12.2026, 18:00 MEZ — winter, so +1.
  const CLOSES = '2026-12-15T17:00:00.000Z';
  const CLOSES_INSTANT = Date.parse(CLOSES);

  it('says nothing when the form has neither a deadline nor a time limit', () => {
    expect(
      deadlineNotice({ closesAt: null, timeLimitMin: null, now: Date.now() }),
    ).toBeNull();
  });

  it('names the deadline with its zone while the form is still open', () => {
    const notice = deadlineNotice({
      closesAt: CLOSES,
      timeLimitMin: null,
      now: CLOSES_INSTANT - 60_000,
    });

    expect(notice?.expired).toBe(false);
    expect(notice?.text).toBe(
      'Dieses Formular kann noch bis 15.12.2026, 18:00 Uhr MEZ ausgefüllt und abgesendet werden.',
    );
  });

  /**
   * The zone comes from the instant and not from the reader's clock — the case
   * at which a hand-built formatting is exposed.
   */
  it('names the summer zone for a summer deadline', () => {
    // 01.09.2026, 08:00 MESZ.
    const summer = '2026-09-01T06:00:00.000Z';

    expect(
      deadlineNotice({
        closesAt: summer,
        timeLimitMin: null,
        now: Date.parse(summer) - 1,
      })?.text,
    ).toContain('01.09.2026, 08:00 Uhr MESZ');
  });

  /**
   * **The boundary itself.** `availabilityOf` closes with `>=` — the instant
   * already belongs to the closed form —, and this line has to say the same,
   * otherwise it claims „noch bis 18:00 Uhr" in the very second in which the
   * server rejects the submission.
   */
  it('counts the closing instant itself as passed, like the server does', () => {
    expect(
      deadlineNotice({
        closesAt: CLOSES,
        timeLimitMin: null,
        now: CLOSES_INSTANT - 1,
      })?.expired,
    ).toBe(false);
    expect(
      deadlineNotice({
        closesAt: CLOSES,
        timeLimitMin: null,
        now: CLOSES_INSTANT,
      })?.expired,
    ).toBe(true);
  });

  /**
   * What happens when the deadline passes while someone is filling in: the
   * sentence changes, and it says expressly that nothing is gone. That is half
   * the statement — without it, “expired” reads like “typed for nothing”.
   */
  it('promises the typed answers are still there once the deadline has passed', () => {
    const notice = deadlineNotice({
      closesAt: CLOSES,
      timeLimitMin: null,
      now: CLOSES_INSTANT + 60_000,
    });

    expect(notice?.expired).toBe(true);
    expect(notice?.text).toContain('15.12.2026, 18:00 Uhr MEZ');
    expect(notice?.text).toContain('nicht mehr angenommen');
    expect(notice?.text).toContain('bleiben erhalten');
  });

  /**
   * An instant nobody can read is not a deadline anybody can keep — better to
   * say nothing than to write „—" above the form.
   */
  it('says nothing about an instant it cannot read', () => {
    expect(
      deadlineNotice({
        closesAt: 'irgendwann',
        timeLimitMin: null,
        now: Date.now(),
      }),
    ).toBeNull();
  });

  /**
   * **The second half of finding 32.** Whoever types thirty fields and then
   * runs into a `time_limit` 409 that nothing announced loses their work —
   * which is why the number of minutes stands above the fields and not only in
   * the rejection.
   */
  describe('das Zeitlimit', () => {
    it('names the minutes and what they are counted from', () => {
      const notice = deadlineNotice({
        closesAt: null,
        timeLimitMin: 30,
        now: Date.now(),
      });

      expect(notice?.expired).toBe(false);
      expect(notice?.text).toBe(
        'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 30 Minuten zur Verfügung.',
      );
    });

    /**
     * **One sentence, two boundaries, one line.** The deadline first: it is the
     * frame within which the form is open at all, the time limit applies inside
     * it.
     */
    it('puts both sentences in one line, deadline first', () => {
      expect(
        deadlineNotice({
          closesAt: CLOSES,
          timeLimitMin: 45,
          now: CLOSES_INSTANT - 60_000,
        })?.text,
      ).toBe(
        'Dieses Formular kann noch bis 15.12.2026, 18:00 Uhr MEZ ausgefüllt und abgesendet werden. ' +
          'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 45 Minuten zur Verfügung.',
      );
    });

    /**
     * „1 Minuten" above a public form is exactly the kind of mistake an
     * organization gets reported to it — and an editor is allowed to set a time
     * limit of one minute.
     */
    it('says „1 Minute" in the singular', () => {
      expect(
        deadlineNotice({ closesAt: null, timeLimitMin: 1, now: Date.now() })
          ?.text,
      ).toContain('1 Minute zur Verfügung');
    });

    /**
     * **After the deadline it disappears.** It describes how long a filling-in
     * was allowed to take, and this form no longer accepts any: a number of
     * minutes next to that would be a piece of information there is nothing
     * left to do with.
     */
    it('drops out once the deadline has passed', () => {
      const notice = deadlineNotice({
        closesAt: CLOSES,
        timeLimitMin: 30,
        now: CLOSES_INSTANT + 1,
      });

      expect(notice?.expired).toBe(true);
      expect(notice?.text).not.toContain('Minuten');
    });

    /**
     * The two boundaries are two pieces of information: an unreadable instant
     * does not take the time limit's line away from it.
     */
    it('still names the minutes when the deadline cannot be read', () => {
      expect(
        deadlineNotice({
          closesAt: 'irgendwann',
          timeLimitMin: 20,
          now: Date.now(),
        })?.text,
      ).toBe(
        'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 20 Minuten zur Verfügung.',
      );
    });

    /**
     * **`expired` remains the statement about the deadline alone.** When the
     * minutes of this filling-in run out is measured by the server from the
     * instant in the signed start proof, which this page does not know — an
     * expiry of its own here would be a guessed clock on top of somebody else's
     * measurement.
     */
    it('never expires on its own', () => {
      const notice = deadlineNotice({
        closesAt: null,
        timeLimitMin: 5,
        // An hour later, as if the page had stood open for a long time.
        now: Date.now() + 3_600_000,
      });

      expect(notice?.expired).toBe(false);
      expect(notice?.text).toContain('5 Minuten');
    });
  });
});
