import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobKind, OpsMetric } from '@prisma/client';
import {
  acknowledgementHolds,
  escapeHtml,
  formatDeadline,
  renderAnswerTable,
  wrapMailBody,
  type ApiEnv,
  type MailLabelledValue,
} from '@formsache/shared';

import { PublicUrlService } from '../common/public-url/public-url.service';
import { API_ENV } from '../config/env';
import { MailClock } from '../mail/mail-clock';
import { MailIdentityService } from '../mail/mail-identity.service';
import { MailTransport, SYSTEM_IDENTITY_KEY } from '../mail/mail-transport';
import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_SETTING_ID } from '../system-settings/system-settings.repository';
import { JobRunService } from './job-run.service';
import { findBreaches, type Breach } from './ops-breaches';
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

/**
 * The four columns of an acknowledgement, cleared as one.
 *
 * Shared with the write path so that "not acknowledged" is written the same
 * way everywhere — a row that kept a stale note beside an empty
 * `acknowledged_at` would be a half state nothing reads.
 */
export const NO_ACKNOWLEDGEMENT = {
  acknowledgedAt: null,
  acknowledgedUntil: null,
  acknowledgedById: null,
  acknowledgedNote: null,
} as const;

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
 * 4. **It respects an acknowledgement** and ends one that has nothing left to
 *    silence (ADR-0016, continuation 2026-09-16).
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
    // The second run of a pure function over the same figures — `read()`
    // already derived `status.alerts[].breaching` from it. Repeated rather
    // than read back, because the mail needs the whole `Breach` and not the
    // flag.
    const breaches = findBreaches(status);
    // **Before the early return**, because the case that matters most here is
    // exactly the empty one: a metric that has recovered ends its own
    // acknowledgement.
    await this.releaseAcknowledgements(breaches);
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
    const now = this.clock.now();
    // An acknowledgement in force beats the suppression: the operator knows
    // about this one and asked for quiet.
    if (
      row.acknowledgedAt !== null &&
      acknowledgementHolds(row.acknowledgedUntil?.toISOString() ?? null, now)
    ) {
      return false;
    }
    if (row.lastSentAt === null) return true;
    return (
      now.getTime() - row.lastSentAt.getTime() >= ALERT_REPEAT_SUPPRESSION_MS
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
   * Ends every acknowledgement that has nothing left to silence — the metric
   * is back below its threshold, or the chosen span has run out.
   *
   * ⚠️ **Recovery clears the acknowledgement, not the repeat suppression.** A
   * metric flapping around its threshold would otherwise report on every tick,
   * which is the noise this whole guard exists to cap. The next incident is
   * therefore announced afresh, but at most every six hours.
   */
  private async releaseAcknowledgements(
    breaches: readonly Breach[],
  ): Promise<void> {
    const breaching = breaches.map((breach) => breach.metric);
    await this.prisma.opsAlert.updateMany({
      where: {
        acknowledgedAt: { not: null },
        // With nothing breaching, every acknowledgement has recovered — and a
        // `notIn: []` is not a filter Prisma should have to answer.
        ...(breaching.length === 0
          ? {}
          : {
              OR: [
                { metric: { notIn: breaching } },
                { acknowledgedUntil: { lte: this.clock.now() } },
              ],
            }),
      },
      data: NO_ACKNOWLEDGEMENT,
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
  // The tab has been called „Überwachung" since it stopped being a page of its
  // own; this sentence still sent readers to „Betrieb".
  const closing =
    'Diese Meldung kommt aus der Betriebsüberwachung der Installation. Die ' +
    'Zahlen dahinter stehen unter „Überwachung" in der Systemverwaltung. Bis ' +
    'die Ursache behoben ist, meldet sich dieselbe Kennzahl höchstens alle ' +
    'sechs Stunden erneut. Wer die Ursache kennt und trotzdem Ruhe braucht, ' +
    'quittiert sie dort — für 24 Stunden, 7 oder 30 Tage oder bis auf ' +
    'Weiteres.';

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

function classOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
