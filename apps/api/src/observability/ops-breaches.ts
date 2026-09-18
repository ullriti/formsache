import { OpsMetric } from '@prisma/client';
import {
  exceeds,
  MAIL_FAILURE_WINDOW_MS,
  OPS_METRIC_SUBJECTS,
  OPS_THRESHOLDS,
  type OpsStatus,
} from '@formsache/shared';

/**
 * **Which thresholds are exceeded** — the one evaluation, read by two sides.
 *
 * It sits in a file of its own and without dependency injection, because the
 * watchman is no longer its only reader: `OpsStatusService` runs the same
 * function so that the monitoring view's traffic lights hang on exactly the
 * evaluation that sends the mail. Two implementations of the same thresholds
 * are how a green page and a firing alert end up side by side.
 */

/** From how many `failed` rows on the queue counts as disturbed. */
export const MAIL_FAILURE_THRESHOLD = 5;

/**
 * An exceeded threshold, as a value — **four fields, and none of them is
 * decorative**.
 *
 * `subject` and `detail` always existed. Added since point 20 of the second
 * review round are the two that make a report usable in the first place:
 * {@link measured} and {@link threshold} next to each other (a number without its
 * threshold is no statement) and {@link action}, the action. They stand
 * **here** and not in a table next to the dispatch, because they belong to the
 * threshold: whoever adds a sixth metric cannot forget the action for it
 * — there is no field that may be left out.
 */
export interface Breach {
  readonly metric: OpsMetric;
  /** From `OPS_METRIC_SUBJECTS` — the monitoring view captions the same
   * metric with the same line. */
  readonly subject: string;
  /** One sentence: what happened. Numbers, no names. */
  readonly detail: string;
  /** The measured value, with unit. */
  readonly measured: string;
  /** The value from which on a report is made — the same unit as {@link measured}. */
  readonly threshold: string;
  /** What the operator should do now. One sentence, no reference. */
  readonly action: string;
}

/**
 * Which thresholds are exceeded.
 *
 * A pure function over the operations status, so that every threshold can get
 * **two** test cases — just above it loud, just below it silent. One case
 * alone would only evidence that an alert always happens.
 *
 * ⚠️ **The reports name numbers, no names.** No organization, no form,
 * no address — the same rule as with `job_run`: an operations message that
 * gave away *whose* post is stuck would be information about foreign organizations in
 * a mail that leaves the operation.
 */
export function findBreaches(status: Omit<OpsStatus, 'alerts'>): Breach[] {
  const now = new Date(status.observedAt).getTime();
  const breaches: Breach[] = [];

  const queueAgeMs =
    status.mailQueue.oldestQueuedAt === null
      ? null
      : now - new Date(status.mailQueue.oldestQueuedAt).getTime();
  if (exceeds(queueAgeMs, OPS_THRESHOLDS.mailQueueAgeMs)) {
    breaches.push({
      metric: OpsMetric.mail_queue_age,
      subject: OPS_METRIC_SUBJECTS.mail_queue_age,
      detail:
        `Die älteste wartende Nachricht liegt seit ${minutes(queueAgeMs)} Minuten ` +
        `in der Warteschlange (${String(status.mailQueue.queued)} wartend).`,
      measured: `${minutes(queueAgeMs)} Minuten Wartezeit`,
      threshold: `${minutes(OPS_THRESHOLDS.mailQueueAgeMs)} Minuten`,
      action:
        'Prüfen, ob der Mail-Worker läuft und ob der Mailserver erreichbar ist; ' +
        'ein Blick ins Versandprotokoll zeigt, woran die älteste Zeile hängt.',
    });
  }

  /*
   * **What is counted is the window, not the lifetime** (a review finding).
   * `status.mailQueue.failed` is the sum over everything the table still
   * holds — six mistyped addresses kept it above the threshold for months,
   * and the watchman reported the same known state every six hours.
   * The report nevertheless names **both** numbers: the new one says what has
   * happened, the old one how much has been left lying in total.
   */
  if (status.mailQueue.failedRecently > MAIL_FAILURE_THRESHOLD) {
    breaches.push({
      metric: OpsMetric.mail_failures,
      subject: OPS_METRIC_SUBJECTS.mail_failures,
      detail:
        `${String(status.mailQueue.failedRecently)} Nachrichten sind in den ` +
        `letzten ${hours(MAIL_FAILURE_WINDOW_MS)} Stunden ` +
        `endgültig gescheitert (insgesamt liegen ${String(status.mailQueue.failed)} ` +
        'gescheiterte Zeilen im Versandprotokoll).',
      measured:
        `${String(status.mailQueue.failedRecently)} Fehlschläge in ` +
        `${hours(MAIL_FAILURE_WINDOW_MS)} Stunden`,
      threshold: `mehr als ${String(MAIL_FAILURE_THRESHOLD)} im selben Zeitraum`,
      action:
        'Im Versandprotokoll den Grund der gescheiterten Zeilen ansehen: eine ' +
        'einzelne falsche Adresse ist harmlos, gleiche Gründe in Folge sind ein ' +
        'Problem des Mailservers oder der Zugangsdaten.',
    });
  }

  for (const job of status.jobs) {
    const ageMs =
      job.lastSuccessAt === null
        ? null
        : now - new Date(job.lastSuccessAt).getTime();

    /*
     * **Two ways into the same alert, and the second one was missing.**
     *
     * The first is the age: the last success lies too far back.
     * The second is the one the age **cannot** see — a run that
     * has *never yet* succeeded in this installation. Then
     * `lastSuccessAt` is null, `ageMs` likewise, and `exceeds(null, …)` is
     * false: `retention_purge`, which fails every night since the first day,
     * looked permanently healthy to the watchman while the 30-day deletion
     * silently broke. The schema comment at `jobStatusSchema` has said exactly
     * that all along — "with a fresh installation the normal case, with an
     * old one the alert" —, only the second half stood nowhere in the code.
     *
     * The distinction is made via `lastOutcome`, not via the age of
     * `lastRunAt`: a run that fails hourly has a **fresh**
     * `lastRunAt` — by the clock it would not be distinguishable from a healthy
     * one. A failed last run, by contrast, is always worth a
     * report, however young it is. The fresh installation in which
     * nothing at all has run yet (`lastOutcome === null`) stays silent.
     *
     * ⚠️ **Deliberately already on the *first* failure** — the review gate
     * asked whether two consecutive ones would not be better (a purge that
     * runs against a not-yet-ready database on the very first boot
     * thereby reports at once). Weighed up and **left this way**: the report
     * describes a real state, the repeat suppression caps it at
     * at most four mails a day, and it disappears by itself with the first
     * successful run. The error in the other direction — the
     * silent failure — is exactly the one these lines stand against, and it
     * costs deletion deadlines instead of one mail.
     */
    const neverSucceeded =
      job.lastSuccessAt === null && job.lastOutcome === 'failed';

    if (exceeds(ageMs, OPS_THRESHOLDS.jobSuccessAgeMs) || neverSucceeded) {
      breaches.push({
        metric: OpsMetric.job_stale,
        subject: OPS_METRIC_SUBJECTS.job_stale,
        detail: neverSucceeded
          ? `Der Lauf „${job.job}" ist in dieser Installation noch nie erfolgreich ` +
            `gewesen; der letzte Versuch scheiterte (${job.lastErrorClass ?? 'Grund unbekannt'}). ` +
            'Löschfristen laufen darüber — siehe Betriebshandbuch.'
          : `Der Lauf „${job.job}" war zuletzt vor ${hours(ageMs)} Stunden erfolgreich. ` +
            'Löschfristen laufen darüber — siehe Betriebshandbuch.',
        measured: neverSucceeded
          ? 'noch nie erfolgreich'
          : `${hours(ageMs)} Stunden seit dem letzten Erfolg`,
        threshold: `${hours(OPS_THRESHOLDS.jobSuccessAgeMs)} Stunden seit dem letzten Erfolg`,
        action:
          'Im Betriebsstatus die Fehlerklasse dieses Laufs ansehen und die ' +
          'Ursache beheben — bis dahin werden die gesetzlichen Löschfristen ' +
          'nicht eingehalten.',
      });
      // One report per run would, with five failed runs, be five mails
      // about the same cause (mostly: the database). The first one suffices.
      break;
    }
  }

  if (
    exceeds(status.storage.usedFraction, OPS_THRESHOLDS.storageUsedFraction)
  ) {
    breaches.push({
      metric: OpsMetric.storage_full,
      subject: OPS_METRIC_SUBJECTS.storage_full,
      detail: `Die Ablage liegt bei ${percent(status.storage.usedFraction)} %. Uploads scheitern, sobald er voll ist.`,
      measured: `${percent(status.storage.usedFraction)} % belegt`,
      threshold: `${percent(OPS_THRESHOLDS.storageUsedFraction)} % belegt`,
      action:
        'Speicher vergrößern oder Platz schaffen — etwa endgültig gelöschte ' +
        'Formulare aus dem Papierkorb entfernen. Ist der Datenträger voll, ' +
        'nimmt die Anwendung keine Anhänge mehr an.',
    });
  }

  if (exceeds(status.ai.failureRate, OPS_THRESHOLDS.aiFailureRate)) {
    breaches.push({
      metric: OpsMetric.ai_failure_rate,
      subject: OPS_METRIC_SUBJECTS.ai_failure_rate,
      detail: `${percent(status.ai.failureRate)} % der Aufrufe dieses Monats sind gescheitert.`,
      measured: `${percent(status.ai.failureRate)} % Fehlerquote`,
      threshold: `${percent(OPS_THRESHOLDS.aiFailureRate)} % Fehlerquote`,
      action:
        'API-Schlüssel, Kontingent und Erreichbarkeit des Anbieters prüfen. ' +
        'Bis dahin bleibt der Formular-Entwurf per KI unzuverlässig; alles ' +
        'andere in der Anwendung ist davon nicht betroffen.',
    });
  }

  return breaches;
}

function minutes(ms: number | null): string {
  return String(Math.floor((ms ?? 0) / 60_000));
}

function hours(ms: number | null): string {
  return String(Math.floor((ms ?? 0) / 3_600_000));
}

function percent(fraction: number | null): string {
  return String(Math.round((fraction ?? 0) * 100));
}
