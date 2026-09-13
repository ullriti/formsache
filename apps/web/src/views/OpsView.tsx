import type { ReactElement, ReactNode } from 'react';

import {
  exceeds,
  OPS_THRESHOLDS,
  type AiModelUsage,
  type JobStatus,
  type OpsStatus,
} from '@formsache/shared';

import { useOpsStatus } from '../api/ops-status';

import './ops-view.css';

/**
 * The **Überwachung** tab of the system administration (ADR-0016; finding 16) — until
 * then a page of its own named „Betrieb" under `/verwaltung/betrieb` —
 * damals, als die Pfade noch deutsch waren (ADR-0030).
 *
 * **The name is the finding.** „Betrieb" promised an action; there is no
 * button here. Five groups of numbers, each with a signal against the **same**
 * threshold the alarm in the server helps itself to (`OPS_THRESHOLDS` in
 * `@formsache/shared`). Were the number in both places, this signal would
 * at some point be green while the alarm had long since fired — and nobody would know
 * which of the two is right.
 *
 * The page title stands in the frame (`SystemAdminView`); what stands here is the
 * heading of this one tab, and the panels below it are one step
 * subordinate to it (`<h3>`) instead of standing beside it.
 *
 * ⚠️ **The view is no access protection.** It is rendered for whoever
 * asks; the boundary is the `SuperadminGuard` behind `GET /api/admin/ops`.
 * For everybody else the error text below says what 403 means.
 */
export function OpsView(): ReactElement {
  const status = useOpsStatus();

  return (
    <div className="ops-view">
      <header className="ops-view__head">
        <h2>Überwachung</h2>
        <p className="ops-view__lede">
          Der Zustand dieser Installation — über alle Organisationen gezählt.
          Die Schwellen sind dieselben, aus denen der Alarm sich bedient.
        </p>
      </header>

      {status.isPending ? (
        <p className="ops-view__pending">Betriebsstatus wird geladen…</p>
      ) : status.isError ? (
        <p role="alert" className="ops-view__error">
          {describeError(status.error)}
        </p>
      ) : (
        <OpsPanels status={status.data} />
      )}
    </div>
  );
}

function OpsPanels({ status }: { readonly status: OpsStatus }): ReactElement {
  const observedAt = new Date(status.observedAt);
  const queueAgeMs =
    status.mailQueue.oldestQueuedAt === null
      ? null
      : observedAt.getTime() -
        new Date(status.mailQueue.oldestQueuedAt).getTime();

  return (
    <div className="ops-view__panels">
      <Panel
        title="Warteschlange"
        alert={exceeds(queueAgeMs, OPS_THRESHOLDS.mailQueueAgeMs)}
      >
        <Figure label="Wartend" value={String(status.mailQueue.queued)} />
        <Figure label="Gescheitert" value={String(status.mailQueue.failed)} />
        {/*
          **The number that triggers the alarm — otherwise it stands only in the mail.**

          „Gescheitert" beside it is the stock of the last 90 days; the alarm
          fires over the six-hour window. Without this tile an
          operator would get a mail about „7 in den letzten sechs Stunden" and find
          a 40 on the operations page — two numbers about the same thing, of
          which the page names only the one that was *not* meant.
        */}
        <Figure
          label="Davon in 6 h"
          value={String(status.mailQueue.failedRecently)}
        />
        <Figure
          label="Älteste wartet seit"
          value={queueAgeMs === null ? '—' : formatDuration(queueAgeMs)}
        />
      </Panel>

      <Panel
        title="Ablage"
        alert={exceeds(
          status.storage.usedFraction,
          OPS_THRESHOLDS.storageUsedFraction,
        )}
      >
        <Figure
          label="Dateien"
          value={
            status.storage.files === null ? '—' : String(status.storage.files)
          }
        />
        <Figure
          label="Belegt"
          value={
            status.storage.usedBytes === null
              ? '—'
              : formatBytes(status.storage.usedBytes)
          }
        />
        <Figure
          label="Datenträger"
          value={
            status.storage.usedFraction === null
              ? '—'
              : `${String(Math.round(status.storage.usedFraction * 100))} %`
          }
        />
      </Panel>

      <Panel
        title="KI"
        alert={exceeds(status.ai.failureRate, OPS_THRESHOLDS.aiFailureRate)}
      >
        <Figure label="Aufrufe im Monat" value={String(status.ai.calls)} />
        <Figure label="Gescheitert" value={String(status.ai.failed)} />
        <Figure
          label="Fehlerquote"
          value={
            status.ai.failureRate === null
              ? '—'
              : `${String(Math.round(status.ai.failureRate * 100))} %`
          }
        />
      </Panel>

      <AiModelUsageTable rows={status.ai.byModel} />

      {/*
        `tabIndex={0}` on a **scrollable** region (axe:
        `scrollable-region-focusable`): at narrow widths this
        table scrolls within itself, and without focus somebody without a mouse could not
        reach the right-hand columns at all. The guard found it because this
        view **did not stand in the axe check list at all**.
      */}
      <section
        className="ops-view__jobs"
        aria-labelledby="ops-jobs-heading"
        tabIndex={0}
      >
        <h3 id="ops-jobs-heading">Hintergrundläufe</h3>
        <table className="ops-view__table">
          <thead>
            <tr>
              <th scope="col">Lauf</th>
              <th scope="col">Zuletzt erfolgreich</th>
              <th scope="col">Zuletzt gelaufen</th>
              <th scope="col">Ergebnis</th>
            </tr>
          </thead>
          <tbody>
            {status.jobs.map((job) => (
              <JobRow key={job.job} job={job} now={observedAt} />
            ))}
          </tbody>
        </table>
      </section>

      <p className="ops-view__foot">
        Fassung <strong>{status.version}</strong> · erhoben{' '}
        {observedAt.toLocaleString('de-DE')}
      </p>
    </div>
  );
}

/**
 * **What the AI has consumed in the current month — per model and version**.
 *
 * ⚠️ **Quantities, not costs**, and that is a decision: neither of the two
 * provider APIs supplies prices, and a hand-maintained price table would go stale
 * quietly. What stands here are calls and tokens — the bill comes from the
 * provider, and this table says how it came about.
 *
 * **Two columns for the model** are the whole purpose: since the selection list
 * stands on aliases, the application calls under a *migrating* name, and
 * the provider reports back exactly that one. „Kennung" is therefore what was called
 * with; „Fassung" is what stood behind it. Two rows with the same identifier
 * and a different version mean: the alias moved on in the middle of the month
 * — and without the second column that would look like one row.
 *
 * `tabIndex={0}` as with the runs below it: the region scrolls within itself at
 * narrow widths, and without focus somebody without a mouse could not reach the
 * right-hand columns (axe: `scrollable-region-focusable`).
 */
function AiModelUsageTable({
  rows,
}: {
  readonly rows: readonly AiModelUsage[];
}): ReactElement {
  return (
    <section
      className="ops-view__models"
      aria-labelledby="ops-models-heading"
      tabIndex={0}
    >
      <h3 id="ops-models-heading">KI-Verbrauch je Modell</h3>
      {rows.length === 0 ? (
        /*
         * **„Keine Aufrufe" and not an empty table.** A table with a
         * header row and without rows reads like a defect; the sentence says
         * that the number is right.
         */
        <p className="ops-view__empty">
          In diesem Monat wurde die KI nicht aufgerufen.
        </p>
      ) : (
        <table className="ops-view__table">
          <thead>
            <tr>
              <th scope="col">Kennung</th>
              <th scope="col">Fassung</th>
              <th scope="col">Aufrufe</th>
              {/*
                „Input-Tokens"/„Output-Tokens" and not „Token ein"/„Token
                aus": the columns stand beside the provider's billing, and
                *there* they are called that — at Anthropic, OpenAI and Mistral
                alike. The Germanised version was an invention of
                this view, with which nobody could reconcile their own bill
                and for which nobody could search. An exception to „Oberfläche auf
                Deutsch", because the technical term is the translation.
              */}
              <th scope="col">Input-Tokens</th>
              <th scope="col">Output-Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.model}|${row.resolved ?? ''}`}>
                <th scope="row">
                  <code>{row.model}</code>
                </th>
                <td>
                  {row.resolved === null ? (
                    /*
                     * „—" instead of repeating the identifier: `null` means „dieser
                     * Anbieter sagt es nicht" (Anthropic carries no
                     * alias field) or „die Zeile ist älter als diese Spalte".
                     * Writing the identifier down a second time would assert that it
                     * had been resolved.
                     */
                    '—'
                  ) : (
                    <code>{row.resolved}</code>
                  )}
                </td>
                <td>{row.calls}</td>
                {/*
                  `null` is not 0: the provider reported no number at all
                  for this group (assumption A8). A 0 would look like a
                  call without consumption.
                */}
                <td>{formatTokens(row.inputTokens)}</td>
                <td>{formatTokens(row.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function formatTokens(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('de-DE');
}

/**
 * One row per run, with **both** points in time.
 *
 * „Zuletzt gelaufen" alone does not suffice: a run that has been failing every
 * night for three days would look healthy in it. The signal therefore hangs on the **last
 * success**.
 */
function JobRow({
  job,
  now,
}: {
  readonly job: JobStatus;
  readonly now: Date;
}): ReactElement {
  const successAgeMs =
    job.lastSuccessAt === null
      ? null
      : now.getTime() - new Date(job.lastSuccessAt).getTime();
  // A run that has **never** succeeded is normal on a fresh
  // installation and the alarm on an old one. The view cannot tell the
  // two apart and therefore does not claim to: it shows „—"
  // and leaves the judgement to the alarm, which knows the installation's
  // running time.
  const alert = exceeds(successAgeMs, OPS_THRESHOLDS.jobSuccessAgeMs);

  return (
    <tr className={alert ? 'ops-view__row--alert' : undefined}>
      <th scope="row">{JOB_LABELS[job.job]}</th>
      <td>
        {successAgeMs === null ? '—' : `vor ${formatDuration(successAgeMs)}`}
        {alert ? (
          <span className="ops-view__badge" role="status">
            über der Frist
          </span>
        ) : null}
      </td>
      <td>
        {job.lastRunAt === null
          ? '—'
          : new Date(job.lastRunAt).toLocaleString('de-DE')}
      </td>
      <td>
        {job.lastOutcome === null
          ? '—'
          : job.lastOutcome === 'ok'
            ? `${String(job.lastItemCount ?? 0)} behandelt`
            : `gescheitert (${job.lastErrorClass ?? 'unbekannt'})`}
      </td>
    </tr>
  );
}

const JOB_LABELS: Record<JobStatus['job'], string> = {
  mail_worker: 'Mailversand',
  mail_log_purge: 'Versandprotokoll aufräumen',
  file_purge: 'Unbeanspruchte Anlagen',
  retention_purge: 'Papierkorb und Entwürfe',
  ai_prompt_purge: 'KI-Freitexte',
  session_purge: 'Tote Sitzungen',
  // The guard itself — it clears nothing away, but it too can fail.
  ops_alert: 'Betriebsüberwachung',
};

function Panel({
  title,
  alert,
  children,
}: {
  readonly title: string;
  readonly alert: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      className={
        alert ? 'ops-view__panel ops-view__panel--alert' : 'ops-view__panel'
      }
      aria-labelledby={`ops-panel-${title}`}
    >
      <h3 id={`ops-panel-${title}`}>
        {title}
        {/*
          The announcement stands in the text, not in the colour: a signal that is only
          coloured says nothing to a screen reader (the lesson).
        */}
        {alert ? (
          <span className="ops-view__badge">über der Schwelle</span>
        ) : null}
      </h3>
      <dl className="ops-view__figures">{children}</dl>
    </section>
  );
}

function Figure({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="ops-view__figure">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.floor(hours / 24))} d`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/**
 * What a failure means — **403 expressly named**.
 *
 * Without this sentence an organisation admin who knows the address would see an empty
 * page and take it for a defect.
 */
function describeError(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 403) {
    return 'Diese Seite gehört der Installation, nicht einer Organisation — sie ist Superadmins vorbehalten.';
  }
  return 'Der Betriebsstatus konnte nicht geladen werden.';
}
