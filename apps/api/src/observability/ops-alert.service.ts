import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobKind, OpsMetric } from '@prisma/client';
import {
  escapeHtml,
  exceeds,
  formatDeadline,
  MAIL_FAILURE_WINDOW_MS,
  OPS_THRESHOLDS,
  renderAnswerTable,
  wrapMailBody,
  type ApiEnv,
  type MailLabelledValue,
  type OpsStatus,
} from '@formsache/shared';

import { PublicUrlService } from '../common/public-url/public-url.service';
import { API_ENV } from '../config/env';
import { MailClock } from '../mail/mail-clock';
import { MailIdentityService } from '../mail/mail-identity.service';
import { MailTransport, SYSTEM_IDENTITY_KEY } from '../mail/mail-transport';
import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_SETTING_ID } from '../system-settings/system-settings.repository';
import { JobRunService } from './job-run.service';
import { OpsStatusService } from './ops-status.service';

/**
 * How long the same metric stays silent after an alert.
 *
 * Six hours, and the number is a compromise with a direction: too short,
 * and a persistent failure fills the mailbox until nobody looks any more;
 * too long, and a second, independent failure of the same metric stays
 * unnoticed. Six hours means at most four mails a day per metric.
 *
 * ⚠️ **A literal of its own, although `MAIL_FAILURE_WINDOW_MS` is the same number.**
 * The first attempt wrote
 * `= MAIL_FAILURE_WINDOW_MS` here — which looks as if it saved a duplication, but
 * it hangs the promise of this comment on a **foreign** constant: the suppression
 * applies to *all five* metrics, the window length is a statement about the
 * mail queue. Whoever shortens the window to 30 minutes in order to see outbreaks
 * faster would thereby have `storage_full` and `job_stale` mail 48 times a day
 * — and no test would have noticed it, because the delivery tests are immune to
 * every change through `clock.advance(ALERT_REPEAT_SUPPRESSION_MS)`.
 *
 * That both numbers *are supposed* to be equal remains right and is now
 * **checked** instead of enforced (`ops-alert.spec.ts`, last case).
 */
export const ALERT_REPEAT_SUPPRESSION_MS = 6 * 60 * 60 * 1000;

/** From how many `failed` rows on the queue counts as disturbed. */
export const MAIL_FAILURE_THRESHOLD = 5;

/**
 * **The watchman** (ADR-0016).
 *
 * It reads the same operations status that the view shows, compares it with
 * the same thresholds (`OPS_THRESHOLDS` from `@formsache/shared`) and sends a
 * mail to the operator address from the system-wide settings.
 *
 * Three properties are more important than the numbers:
 *
 * 1. ⚠️ **The alert goes out *directly*, not via the queue.** An
 *    alert about the backlog of the mail queue that itself landed in that
 *    queue would stand behind the backlog it reports.
 * 2. **It does not repeat endlessly** — otherwise the first alert is the
 *    last one anybody reads. The suppression stands in the **database**, because one
 *    in memory would be empty again after every rollout.
 * 3. **Its own failure is a `job_run` row.** A watchman whose
 *    failure nobody sees is the most silent of all gaps — and the case is
 *    real: a dead mail server cannot report its own failure.
 *    Exactly for that there is the outer observer in addition (ADR-0016).
 */
@Injectable()
export class OpsAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsAlertService.name);
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly clock: MailClock,
    private readonly status: OpsStatusService,
    private readonly transport: MailTransport,
    private readonly identities: MailIdentityService,
    private readonly jobRuns: JobRunService,
    /**
     * The address of the installation for the footer — never the chain via an
     * organization (see {@link send}).
     */
    private readonly publicUrls: PublicUrlService,
  ) {}

  onModuleInit(): void {
    const interval = this.env.OPS_ALERT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    // And once immediately — the same reasoning as with the purges: nothing
    // outside remembers that a check has to happen.
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.checking;
  }

  get schedulerRunning(): boolean {
    return this.timer !== undefined;
  }

  private tick(): Promise<void> {
    this.checking ??= this.runTick().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async runTick(): Promise<void> {
    try {
      await this.jobRuns.record(JobKind.ops_alert, () => this.runOnce());
    } catch (error: unknown) {
      this.logger.error(`ops alert run failed: ${classOf(error)}`);
    }
  }

  /**
   * Checks all thresholds and reports what is due.
   *
   * Answers with the number of alerts **sent** — not of the
   * thresholds exceeded: a metric that still lies within its suppression
   * is detected and not reported, and that is the difference the
   * `job_run` row is meant to record.
   */
  async runOnce(): Promise<number> {
    // **Without the inventory of the storage** (a review finding): `findBreaches`
    // reads nothing of it, and this run is the one every five minutes.
    const status = await this.status.read({ inventory: false });
    const breaches = findBreaches(status);
    if (breaches.length === 0) return 0;

    const recipient = await this.alertRecipient();
    if (recipient === null) {
      // No recipient is an admissible state (fresh installation) and
      // is reported, not kept quiet: the numbers stand in the operations status,
      // but nobody sees them of their own accord.
      this.logger.warn(
        `${String(breaches.length)} threshold(s) exceeded and no alert address is configured`,
      );
      return 0;
    }

    let sent = 0;
    for (const breach of breaches) {
      if (!(await this.due(breach.metric))) continue;
      await this.send(recipient, breach);
      await this.remember(breach.metric);
      sent += 1;
    }
    return sent;
  }

  private async alertRecipient(): Promise<string | null> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: { opsAlertEmail: true },
    });
    return row?.opsAlertEmail ?? null;
  }

  /**
   * ⚠️ **Assumption: one instance.** `due()` → `send()` → `remember()` is a
   * read-modify-write without a lock. Within one process `tick()` protects
   * against two runs overtaking each other; across **two replicas** it does not
   * — both would see the same metric as due and report it. The
   * delivery runs one API instance today (`docker-compose.yml`), hence
   * bearable; whoever scales needs a conditional
   * `UPDATE … WHERE last_sent_at < $frist RETURNING` instead of these three
   * steps. A review named the gap, did not measure it — here it is
   * an assumption and no promise.
   */
  private async due(metric: OpsMetric): Promise<boolean> {
    const row = await this.prisma.opsAlert.findUnique({ where: { metric } });
    if (row === null) return true;
    return (
      this.clock.now().getTime() - row.lastSentAt.getTime() >=
      ALERT_REPEAT_SUPPRESSION_MS
    );
  }

  private async remember(metric: OpsMetric): Promise<void> {
    const lastSentAt = this.clock.now();
    await this.prisma.opsAlert.upsert({
      where: { metric },
      create: { metric, lastSentAt },
      update: { lastSentAt },
    });
  }

  /**
   * Sends **directly**, under the identity of the installation.
   *
   * The resolution runs via {@link MailIdentityService}, not past it:
   * the same path the worker takes, hence the same answer to "is a
   * mail server configured?" — and the same place where an unreadable block
   * stands out. A path of its own here would be the second answer to the same
   * question that CONTRIBUTING.md warns about.
   *
   * The resolution is expressly requested as `'system'` (ADR-0020) — which
   * is right here anyway: the alert belongs to the installation, to no
   * organization. Previously the same stood implicitly in `smtp: null`; since the
   * source is a mandatory argument it stands there out loud.
   */
  private async send(recipient: string, breach: Breach): Promise<void> {
    const identity = await this.identities.resolve(
      { id: SYSTEM_IDENTITY_KEY, smtp: null },
      'system',
    );
    if (identity.kind !== 'send') {
      // No mail server of the instance: that is no defect (ADR-0013 no. 5),
      // but it means that this alert reaches nobody — and **exactly
      // for that** there is the outer observer from ADR-0016. Since ADR-0023 that
      // is also the only case: there is no mail server of an
      // organization to which an operations alert would be allowed to fall back.
      throw new Error(`no usable mail identity (${identity.kind})`);
    }
    const body = opsAlertBody(breach, this.clock.now());
    /*
     * The same wrapper as every other mail of this application, but **without**
     * an organization: an operations message belongs to the installation, and putting
     * the colour and name of some organization into its footer would be
     * exactly the mixing that ADR-0023 resolves.
     *
     * For the same reason the footer links to `installationBaseUrl()`
     * and never via the chain of an organization: there is no
     * organization here, and `tenant.public_base_url` belongs to somebody who has
     * nothing to do with this alert. If none is stored, the
     * footer stays without a link — an operations alert that failed at a missing
     * base address would be the one mail whose absence nobody
     * notices.
     *
     * **The second call of `wrapMailBody` besides `QueuedBodyRenderer`, and
     * it is unavoidable**: this mail deliberately goes past the queue
     * (see the comment at `OpsAlertModule`), so it does not come past the
     * one place that otherwise wraps at all.
     */
    const base = await this.publicUrls.installationBaseUrl();
    const wrapped = wrapMailBody(
      { text: body.text, html: body.html },
      base === null ? {} : { link: { owner: 'installation', url: base } },
    );
    await this.transport.send(
      {
        to: recipient,
        subject: opsAlertSubject(breach),
        text: wrapped.text,
        ...(wrapped.html === undefined ? {} : { html: wrapped.html }),
      },
      { key: SYSTEM_IDENTITY_KEY, block: identity.block },
    );
  }
}

/**
 * The subject of an operations message — recognizable without opening the mail.
 *
 * `[Formsache] Betrieb: …`, and the order is deliberate: the id of the
 * application first (that is how an operator filters), then the word that distinguishes this mail
 * from every domain mail, then the matter. A subject that carried only
 * `[Formsache]` would stand in the mailbox next to a registration confirmation.
 */
export function opsAlertSubject(breach: Breach): string {
  return `[Formsache] Betrieb: ${breach.subject}`;
}

/**
 * The body of an operations message — **what happened, how the number stands to
 * the threshold, what is to be done now** (point 20 of the second review round).
 *
 * Previously that was one sentence and a pointer to the administration. Whoever reads
 * such a mail at night needs three things, and the third was missing entirely: the
 * **action**. „Der Datenträger füllt sich" without „Anhänge löschen oder
 * Speicher vergrößern" is a disquiet, not a report.
 *
 * ⚠️ **Numbers, no names.** No organization, no form, no
 * address — the same rule as with `job_run` and {@link findBreaches}. This
 * mail leaves the operation; what it would give away about foreign organizations would be
 * exactly what it must not. `log-hygiene.spec.ts` holds the counter-check.
 *
 * `text` **always** stays set, even beside `html`: a mailbox that shows no
 * HTML otherwise gets an empty alert — and that is the one mail
 * of this application that nobody can ask for again.
 */
export function opsAlertBody(
  breach: Breach,
  observedAt: Date,
): { readonly text: string; readonly html: string } {
  const facts: readonly MailLabelledValue[] = [
    { label: 'Kennzahl', value: breach.measured },
    { label: 'Schwelle', value: breach.threshold },
    {
      label: 'Festgestellt am',
      value: formatDeadline(observedAt.toISOString()),
    },
  ];
  const closing =
    'Diese Meldung kommt aus der Betriebsüberwachung der Installation. Die ' +
    'Zahlen dahinter stehen unter „Betrieb" in der Systemverwaltung. Bis die ' +
    'Ursache behoben ist, meldet sich dieselbe Kennzahl höchstens alle sechs ' +
    'Stunden erneut.';

  return {
    text: [
      breach.detail,
      '',
      renderAnswerTable(facts, 'text'),
      '',
      `Was jetzt zu tun ist: ${breach.action}`,
      '',
      closing,
    ].join('\n'),
    html: [
      `<p style="margin:0 0 16px 0">${escapeHtml(breach.detail)}</p>`,
      renderAnswerTable(facts, 'html'),
      '<p style="margin:16px 0 0 0"><strong>Was jetzt zu tun ist:</strong> ' +
        `${escapeHtml(breach.action)}</p>`,
      `<p style="margin:16px 0 0 0">${escapeHtml(closing)}</p>`,
    ].join(''),
  };
}

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
export function findBreaches(status: OpsStatus): Breach[] {
  const now = new Date(status.observedAt).getTime();
  const breaches: Breach[] = [];

  const queueAgeMs =
    status.mailQueue.oldestQueuedAt === null
      ? null
      : now - new Date(status.mailQueue.oldestQueuedAt).getTime();
  if (exceeds(queueAgeMs, OPS_THRESHOLDS.mailQueueAgeMs)) {
    breaches.push({
      metric: OpsMetric.mail_queue_age,
      subject: 'Post bleibt liegen',
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
      subject: 'Nachrichten scheitern',
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
        subject: 'Ein Aufräumlauf bleibt aus',
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
      subject: 'Der Datenträger füllt sich',
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
      subject: 'Die KI antwortet unzuverlässig',
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

function classOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
