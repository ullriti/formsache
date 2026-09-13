import 'reflect-metadata';

import type { OpsStatus } from '@formsache/shared';
import { OpsMetric } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  ALERT_REPEAT_SUPPRESSION_MS,
  findBreaches,
  opsAlertBody,
  opsAlertSubject,
} from '../../src/observability/ops-alert.service';
import { MAIL_FAILURE_WINDOW_MS } from '@formsache/shared';

/**
 * **Every threshold gets two cases** .
 *
 * Just above it loud, just below it silent — one case alone would only prove
 * that an alert is always raised. That is the same shape the alerts elsewhere have needed once before.
 *
 * What is checked is {@link findBreaches} as a pure function over the operations status.
 * The delivery path, the repeat suppression and the `job_run` row hang on the
 * database and are in `ops-alert-delivery.spec.ts`.
 *
 * *Reproduction:* set one threshold in `OPS_THRESHOLDS` to `Infinity` →
 * exactly **its** „darüber" case turns red, the others stay green.
 */

const NOW = '2026-08-11T12:00:00.000Z';

function status(overrides: Partial<OpsStatus> = {}): OpsStatus {
  return {
    version: '1.0.0',
    observedAt: NOW,
    mailQueue: {
      queued: 0,
      failed: 0,
      failedRecently: 0,
      oldestQueuedAt: null,
    },
    jobs: [],
    storage: { usedBytes: 0, files: 0, usedFraction: 0.1 },
    ai: { calls: 0, failed: 0, failureRate: null, byModel: [] },
    ...overrides,
  };
}

/** `minutes` before {@link NOW}, as an ISO string. */
function agoMinutes(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function metrics(source: OpsStatus): string[] {
  return findBreaches(source).map((breach) => breach.metric);
}

describe('Die Schwellen des Wächters ', () => {
  it('meldet nichts an einer ruhigen Installation', () => {
    expect(findBreaches(status())).toStrictEqual([]);
  });

  describe('Warteschlange älter als 30 Minuten', () => {
    it('meldet bei 31 Minuten', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 2,
              failed: 0,
              failedRecently: 0,
              oldestQueuedAt: agoMinutes(31),
            },
          }),
        ),
      ).toContain('mail_queue_age');
    });

    it('schweigt bei 29 Minuten', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 2,
              failed: 0,
              failedRecently: 0,
              oldestQueuedAt: agoMinutes(29),
            },
          }),
        ),
      ).not.toContain('mail_queue_age');
    });

    it('schweigt bei **genau** 30 Minuten — die Schwelle selbst ist noch erlaubt', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 2,
              failed: 0,
              failedRecently: 0,
              oldestQueuedAt: agoMinutes(30),
            },
          }),
        ),
      ).not.toContain('mail_queue_age');
    });
  });

  /**
   * ⚠️ **What is counted is the window, not the stock** (a review finding).
   *
   * Until 2026-08-12 the guard looked at `failed` — the stock since the
   * beginning of the retention. The third case below is the one where that
   * broke: six mistyped addresses from three weeks ago kept the number above
   * the threshold, so the guard went on alerting every six hours until the
   * 90-day retention period cleared the rows away. An alert that does not stop
   * on its own is the next one somebody mutes.
   *
   * *Counter-check:* in `findBreaches` replace `failedRecently` with `failed` →
   * the third case turns red, the two above it stay green.
   */
  describe('gescheiterte Nachrichten im Sechs-Stunden-Fenster', () => {
    it('meldet bei sechs im Fenster', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 0,
              failed: 6,
              failedRecently: 6,
              oldestQueuedAt: null,
            },
          }),
        ),
      ).toContain('mail_failures');
    });

    it('schweigt bei fünf — eine einzelne unzustellbare Adresse ist normal', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 0,
              failed: 5,
              failedRecently: 5,
              oldestQueuedAt: null,
            },
          }),
        ),
      ).not.toContain('mail_failures');
    });

    it('schweigt, wenn die vierzig Fehlschläge alle älter als das Fenster sind', () => {
      expect(
        metrics(
          status({
            mailQueue: {
              queued: 0,
              failed: 40,
              failedRecently: 0,
              oldestQueuedAt: null,
            },
          }),
        ),
      ).not.toContain('mail_failures');
    });

    /*
     * ⚠️ **Not `toContain('7')` and `toContain('40')`** (review rework).
     * That is how it stood at first, and that way the case was blind to the one
     * mix-up that can happen here at all: swap the two
     * interpolations and the mail reports „40 Nachrichten sind in den letzten 6
     * Stunden gescheitert (insgesamt liegen 7 …)" — both numbers are in it,
     * both assurances hold, and the message says the opposite. What is checked
     * is therefore which number stands **in which place**.
     */
    it('nennt beide Zahlen — und jede an ihrer Stelle', () => {
      const [breach] = findBreaches(
        status({
          mailQueue: {
            queued: 0,
            failed: 40,
            failedRecently: 7,
            oldestQueuedAt: null,
          },
        }),
      );
      expect(breach?.detail).toMatch(/^7 Nachrichten sind in den letzten 6 /u);
      expect(breach?.detail).toContain('insgesamt liegen 40 ');
    });
  });

  describe('letzter erfolgreicher Lauf über 26 Stunden', () => {
    const job = (
      hoursAgo: number | null,
      overrides: Partial<OpsStatus['jobs'][number]> = {},
    ): OpsStatus['jobs'] => [
      {
        job: 'retention_purge',
        lastSuccessAt:
          hoursAgo === null
            ? null
            : new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString(),
        lastRunAt: NOW,
        lastOutcome: 'ok',
        lastItemCount: 0,
        lastErrorClass: null,
        ...overrides,
      },
    ];

    it('meldet bei 27 Stunden', () => {
      expect(metrics(status({ jobs: job(27) }))).toContain('job_stale');
    });

    it('schweigt bei 25 Stunden — ein verspäteter Lauf ist kein Ausfall', () => {
      expect(metrics(status({ jobs: job(25) }))).not.toContain('job_stale');
    });

    it('schweigt auf einer frischen Installation, in der noch nichts lief', () => {
      // No success **and** no attempt: the normal case on the first day. An
      // alert that arrives with every new installation is the first one
      // somebody switches off.
      expect(
        metrics(status({ jobs: job(null, { lastOutcome: null }) })),
      ).not.toContain('job_stale');
    });

    /*
     * **The gap this guard had for four months.** A run that has been failing
     * since the first day has no `lastSuccessAt` — and via the age it is
     * therefore not to be caught. `retention_purge`, failing every night,
     * looked healthy while the 30-day deletion promise silently broke.
     *
     * Counter-check: remove `|| neverSucceeded` from `findBreaches` → this
     * case turns red, the three above it stay green.
     */
    it('meldet einen Lauf, der noch nie erfolgreich war und zuletzt scheiterte', () => {
      expect(
        metrics(
          status({
            jobs: job(null, {
              lastOutcome: 'failed',
              lastErrorClass: 'PrismaClientKnownRequestError',
            }),
          }),
        ),
      ).toContain('job_stale');
    });

    it('nennt die Fehlerklasse, nie die Meldung', () => {
      const [breach] = findBreaches(
        status({
          jobs: job(null, {
            lastOutcome: 'failed',
            lastErrorClass: 'PrismaClientKnownRequestError',
          }),
        }),
      );
      expect(breach?.detail).toContain('noch nie erfolgreich');
      expect(breach?.detail).toContain('PrismaClientKnownRequestError');
    });

    it('unterscheidet nicht an der Uhr: ein stündlich scheiternder Lauf ist frisch', () => {
      // `lastRunAt` is **now** here — by the clock this run would not be
      // distinguishable from a healthy one. Exactly for that reason
      // `lastOutcome` decides and not the age of the last attempt.
      const stale = job(null, { lastOutcome: 'failed', lastRunAt: NOW });
      expect(metrics(status({ jobs: stale }))).toContain('job_stale');
    });

    it('meldet **einmal**, auch wenn drei Läufe gleichzeitig ausfallen', () => {
      const stale = [...job(30), ...job(30), ...job(30)];
      expect(
        metrics(status({ jobs: stale })).filter((m) => m === 'job_stale'),
      ).toHaveLength(1);
    });
  });

  describe('Ablage über 85 %', () => {
    it('meldet bei 86 %', () => {
      expect(
        metrics(
          status({ storage: { usedBytes: 1, files: 1, usedFraction: 0.86 } }),
        ),
      ).toContain('storage_full');
    });

    it('schweigt bei 84 %', () => {
      expect(
        metrics(
          status({ storage: { usedBytes: 1, files: 1, usedFraction: 0.84 } }),
        ),
      ).not.toContain('storage_full');
    });

    it('schweigt, wenn das Betriebssystem den Anteil nicht hergibt', () => {
      expect(
        metrics(
          status({ storage: { usedBytes: 1, files: 1, usedFraction: null } }),
        ),
      ).not.toContain('storage_full');
    });
  });

  describe('KI-Fehlerquote über 25 %', () => {
    it('meldet bei 30 %', () => {
      expect(
        metrics(
          status({
            ai: { calls: 10, failed: 3, failureRate: 0.3, byModel: [] },
          }),
        ),
      ).toContain('ai_failure_rate');
    });

    it('schweigt bei 20 %', () => {
      expect(
        metrics(
          status({
            ai: { calls: 10, failed: 2, failureRate: 0.2, byModel: [] },
          }),
        ),
      ).not.toContain('ai_failure_rate');
    });

    it('schweigt ohne einen einzigen Aufruf — keine Quote ist keine 0 %', () => {
      expect(
        metrics(
          status({
            ai: { calls: 0, failed: 0, failureRate: null, byModel: [] },
          }),
        ),
      ).not.toContain('ai_failure_rate');
    });
  });

  it('nennt in keiner Meldung eine Organisation, ein Formular oder eine Adresse', () => {
    const breaches = noisyBreaches();

    expect(breaches.length).toBeGreaterThan(0);
    for (const breach of breaches) {
      // An operations alert that gave away *whose* mail is stuck would be
      // information about other organisations — in a mail that leaves the house.
      // **All five text fields**, not just the two of earlier days: since point
      // 20 of the second review round `measured`, `threshold` and `action`
      // carry text into the mail as well, and a field that the check does not
      // look at is the field the name ends up in.
      const everything = [
        breach.subject,
        breach.detail,
        breach.measured,
        breach.threshold,
        breach.action,
      ].join(' ');
      expect(everything).not.toMatch(/@|Organisation |Formular „/);
    }
  });

  // -------------------------------------------------------------------------
  // The body of an operations alert (point 20 of the second review round)
  // -------------------------------------------------------------------------

  /**
   * **What has happened, the number next to its threshold, and what is to be done.**
   *
   * Before, that was one sentence and a pointer to the administration; the
   * action was missing entirely. **Both** versions are checked, because both go
   * out: a mailbox without HTML would otherwise get an empty alert, and that is
   * the one mail of this application that nobody can ask for again.
   */
  describe('opsAlertBody', () => {
    const observedAt = new Date('2026-08-11T12:00:00.000Z');

    function storageBreach() {
      const breach = noisyBreaches().find(
        (candidate) => candidate.metric === OpsMetric.storage_full,
      );
      if (breach === undefined) {
        throw new Error('kein storage_full-Alarm im lauten Status');
      }
      return breach;
    }

    it('trägt Sachverhalt, Kennzahl, Schwelle und Handlung — in beiden Fassungen', () => {
      const breach = storageBreach();
      const body = opsAlertBody(breach, observedAt);

      for (const [name, fassung] of [
        ['text', body.text],
        ['html', body.html],
      ] as const) {
        expect(fassung, `${name}: der Sachverhalt`).toContain(breach.detail);
        expect(fassung, `${name}: die Kennzahl`).toContain(breach.measured);
        expect(fassung, `${name}: die Schwelle`).toContain(breach.threshold);
        expect(fassung, `${name}: die Handlung`).toContain(breach.action);
        expect(fassung, `${name}: der Zeitpunkt`).toContain('11.08.2026');
      }
      // The plain text is not a stopgap: it stays typeset and is readable,
      // that is, without markup.
      expect(body.text).not.toContain('<');
      // …and the HTML branch really is one.
      expect(body.html).toContain('<p');
    });

    /** Here too: numbers, no names — now measured on the finished body. */
    it('nennt auch im fertigen Rumpf keine Adresse und keine Organisation', () => {
      for (const breach of noisyBreaches()) {
        const body = opsAlertBody(breach, observedAt);
        for (const fassung of [body.text, body.html]) {
          expect(fassung).not.toMatch(/@|Organisation |Formular „/);
        }
      }
    });

    it('macht den Betreff erkennbar, ohne ihn mit Fachpost zu verwechseln', () => {
      const subject = opsAlertSubject(storageBreach());

      expect(subject).toContain('[Formsache]');
      expect(subject).toContain('Betrieb');
      expect(subject).toContain('Der Datenträger füllt sich');
    });
  });

  /** A status that breaches several thresholds at once. */
  function noisyBreaches() {
    return findBreaches(
      status({
        mailQueue: {
          queued: 400,
          failed: 9,
          failedRecently: 9,
          oldestQueuedAt: agoMinutes(90),
        },
        storage: { usedBytes: 1, files: 1, usedFraction: 0.99 },
      }),
    );
  }
});

/**
 * **The two six-hour numbers, checked instead of derived**
 * (rework on a review finding).
 *
 * For one commit `ALERT_REPEAT_SUPPRESSION_MS` stood there as
 * `= MAIL_FAILURE_WINDOW_MS`. That looked like de-duplication and was a silent
 * coupling: the suppression applies to **all five** metrics, the window only
 * to the mail queue. Whoever shortens the window in order to see outbreaks
 * faster would thereby also make `storage_full` and `job_stale` mail more
 * often — and the delivery tests would not have noticed it, because they work
 * with `clock.advance(ALERT_REPEAT_SUPPRESSION_MS)` and are therefore immune
 * to any change of this number.
 *
 * *Counter-check:* change one of the two numbers → this case turns red and
 * names both.
 */
describe('Fenster und Wiederholsperre', () => {
  it('sind dieselbe Zahl — sonst Lücke oder Doppelmeldung', () => {
    expect(MAIL_FAILURE_WINDOW_MS).toBe(ALERT_REPEAT_SUPPRESSION_MS);
  });
});
