import {
  useId,
  useState,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

import {
  ACK_DURATION_LABELS,
  ACK_NOTE_MAX,
  ackDurationSchema,
  exceeds,
  OPS_METRIC_SUBJECTS,
  OPS_THRESHOLDS,
  type AckDuration,
  type AiModelUsage,
  type AlertAcknowledgement,
  type JobStatus,
  type OpsAlertState,
  type OpsMetricName,
  type OpsStatus,
} from '@formsache/shared';

import {
  useAcknowledgeAlert,
  useOpsStatus,
  useReleaseAlert,
} from '../api/ops-status';

import './ops-view.css';

/**
 * The **Überwachung** tab of the system administration (ADR-0016; finding 16) — until
 * then a page of its own named „Betrieb" under `/verwaltung/betrieb` —
 * damals, als die Pfade noch deutsch waren (ADR-0030).
 *
 * **The name is the finding.** „Betrieb" promised an action the page did not
 * have. Five groups of numbers, each with a signal that comes **from the
 * server** (`alerts[].breaching`) — the very evaluation that sends the mail,
 * so a green card beside a firing alert is no longer constructible.
 *
 * Since the acknowledgement (ADR-0016, continuation 2026-09-16) there *is* one
 * action here, and it is deliberately the only one: it silences a metric, it
 * does not fix it, and the card stays red while it holds.
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
  const alerts = new Map(status.alerts.map((state) => [state.metric, state]));
  const states = (...metrics: readonly OpsMetricName[]): OpsAlertState[] =>
    metrics.flatMap((metric) => {
      const state = alerts.get(metric);
      return state === undefined ? [] : [state];
    });

  return (
    <div className="ops-view__panels">
      <Panel
        title="Warteschlange"
        alerts={states('mail_queue_age', 'mail_failures')}
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

      <Panel title="Ablage" alerts={states('storage_full')}>
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

      <Panel title="KI" alerts={states('ai_failure_rate')}>
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
        <AlertControls alerts={states('job_stale')} />
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

/**
 * One card of figures, with the alert states of the metrics it shows.
 *
 * **The signal comes from the server** (`alerts[].breaching`), not from a
 * threshold compared again here. That closes a gap this card had: „Nachrichten
 * scheitern" fires on `failedRecently`, which the traffic light never looked
 * at — a card could stand green beside a mail about it.
 */
function Panel({
  title,
  alerts,
  children,
}: {
  readonly title: string;
  readonly alerts: readonly OpsAlertState[];
  readonly children: ReactNode;
}): ReactElement {
  const alert = alerts.some((state) => state.breaching);
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
      <AlertControls alerts={alerts} />
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

/**
 * **Quittieren** (ADR-0016, Fortschreibung 2026-09-16).
 *
 * Shown for a metric that is over its threshold or already acknowledged, and
 * for nothing else: a quiet installation offers no buttons at all.
 */
function AlertControls({
  alerts,
}: {
  readonly alerts: readonly OpsAlertState[];
}): ReactElement | null {
  const shown = alerts.filter(
    (state) => state.breaching || state.acknowledgement !== null,
  );
  if (shown.length === 0) return null;
  return (
    <div className="ops-view__alerts">
      {shown.map((state) => (
        <AlertControl key={state.metric} state={state} />
      ))}
    </div>
  );
}

function AlertControl({
  state,
}: {
  readonly state: OpsAlertState;
}): ReactElement {
  const acknowledge = useAcknowledgeAlert();
  const release = useReleaseAlert();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<AckDuration>('day');
  const [note, setNote] = useState('');
  const fieldId = useId();

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    acknowledge.mutate(
      { metric: state.metric, duration, note },
      {
        onSuccess: () => {
          setOpen(false);
          setNote('');
        },
      },
    );
  }

  const busy = acknowledge.isPending || release.isPending;
  const subject = OPS_METRIC_SUBJECTS[state.metric];

  return (
    <div className="ops-view__alert">
      <p className="ops-view__alert-subject">
        {subject}
        {/*
          The acknowledgement says „die Mail schweigt", never „alles gut" — so
          the card keeps its badge and this line says which of the two it is.
        */}
        {state.acknowledgement === null ? null : (
          <span className="ops-view__badge">quittiert</span>
        )}
      </p>

      {state.acknowledgement === null ? (
        open ? (
          <form className="ops-view__ack-form" onSubmit={submit}>
            <label htmlFor={`${fieldId}-duration`}>Ruhe für</label>
            <select
              id={`${fieldId}-duration`}
              value={duration}
              onChange={(event) => {
                setDuration(readDuration(event.target.value));
              }}
            >
              {ackDurationSchema.options.map((option) => (
                <option key={option} value={option}>
                  {ACK_DURATION_LABELS[option]}
                </option>
              ))}
            </select>
            <label htmlFor={`${fieldId}-note`}>Begründung (wahlfrei)</label>
            <input
              id={`${fieldId}-note`}
              type="text"
              value={note}
              maxLength={ACK_NOTE_MAX}
              placeholder="Platte wird Freitag vergrößert"
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            <div className="ops-view__ack-actions">
              <button type="submit" disabled={busy}>
                Stillstellen
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  // Also clears a failed attempt: the sentence below belongs to
                  // the form, and it must not outlive it.
                  acknowledge.reset();
                }}
              >
                Abbrechen
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(true);
            }}
          >
            Quittieren
          </button>
        )
      ) : (
        <>
          <p className="ops-view__ack-state">
            {describeAcknowledgement(state.acknowledgement)}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              release.mutate(state.metric);
            }}
          >
            Quittierung aufheben
          </button>
        </>
      )}

      {acknowledge.isError || release.isError ? (
        <p role="alert" className="ops-view__ack-error">
          Die Quittierung konnte nicht gespeichert werden.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Who silenced this metric, until when, and why.
 *
 * The name is in it because a second superadmin (ADR-0029) otherwise only
 * learns that *somebody* stopped the mails.
 */
function describeAcknowledgement(ack: AlertAcknowledgement): string {
  const by = ack.by ?? 'unbekannt';
  const until =
    ack.until === null
      ? 'bis auf Weiteres'
      : `bis ${new Date(ack.until).toLocaleString('de-DE')}`;
  const reason = ack.note === null ? '' : ` — „${ack.note}"`;
  return `Quittiert von ${by} am ${new Date(ack.at).toLocaleString('de-DE')}, ${until}${reason}`;
}

/**
 * A `<select>` hands back a `string`; this is where it becomes one of the four
 * spans again — parse, never cast.
 */
function readDuration(value: string): AckDuration {
  const parsed = ackDurationSchema.safeParse(value);
  return parsed.success ? parsed.data : 'day';
}
