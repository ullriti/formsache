import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import {
  MAIL_LOG_RETENTION_DAYS,
  formatDeadline,
  type MailLogCounts,
  type MailLogDetail,
  type MailLogEntry,
  type MailSenderIdentity,
  type MailStatus,
  type NotificationTrigger,
} from '@formsache/shared';

import { useFormSummary } from '../api/forms';
import { ApiError } from '../api/http';
import {
  useMailLog,
  useMailLogDetail,
  useRetryMailLogEntry,
} from '../api/mail-log';
import {
  DASHBOARD_PATH,
  mailLogPath,
  notificationsPath,
} from '../router/routes';
import { navigate } from '../router/use-route';
import { useFocusTrap } from '../shell/use-focus-trap';

import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';
import './mail-log-view.css';

/**
 * The mail log.
 *
 * KPI tiles as clickable filters, the table underneath, and „↻ Erneut" on every
 * failed line.
 *
 * **Tenant-wide, with a prefilter** . The address carries
 * the form one arrived from, so the filter survives a reload and a shared link;
 * clearing it is a navigation, not a hidden piece of state. The **status**
 * filter is not in the address: it changes on every click of a tile and is view
 * state.
 *
 * **Nothing is counted here.** The four numbers come from the server, computed
 * over the whole organisation; counting the rows on screen would produce a second,
 * quieter answer that disagrees as soon as the list is filtered — the drift
 * `pickDefaultColumns` was shared against.
 */

/**
 * What a row says where `recipient`/`subject` were erased.
 *
 * The row itself stays — delivery status, timestamps, attempts and sending
 * identity are the record that a send happened — but everything that names a
 * person is gone, deliberately: a permanently deleted answer takes their
 * address and the rendered subject with it. **Display text only, never
 * written into the data column it stands in for** — a German placeholder
 * *inside* `recipient`/`subject` would age (the string is not the reason) and
 * is, in SQL, indistinguishable from a real recipient of that name. This
 * constant is read only where `=== null` has already been checked, so the
 * data column itself is never touched.
 */
const ERASED_TEXT = '(endgültig gelöscht)';

/** The four tiles of the handoff, in its order. `null` = „Gesamt". */
const TILES: readonly {
  readonly status: MailStatus | null;
  readonly label: string;
  readonly key: keyof MailLogCounts;
}[] = [
  { status: null, label: 'Gesamt', key: 'total' },
  { status: 'sent', label: 'Zugestellt', key: 'sent' },
  { status: 'failed', label: 'Fehlgeschlagen', key: 'failed' },
  { status: 'queued', label: 'In Warteschlange', key: 'queued' },
];

const STATUS_LABELS: Readonly<Record<MailStatus, string>> = {
  sent: 'Zugestellt',
  failed: 'Fehlgeschlagen',
  queued: 'In Warteschlange',
};

/**
 * `save` is in here although nothing writes it today (Konzept no. 58's
 * non-goal „Bei Zwischenspeichern", `packages/shared/src/mail.ts`), for the
 * same reason `mailLogDetailSchema` reads the wide enum: a row written
 * straight into the database has to stay showable.
 */
const TRIGGER_LABELS: Readonly<Record<NotificationTrigger, string>> = {
  submit: 'Beim Absenden',
  save: 'Beim Zwischenspeichern',
  edit: 'Bei Bearbeitung',
  // Not a notification, but the application itself (ADR-0020) — a reset mail
  // or the message about a password that has been set.
  system: 'Systemmail',
};

/**
 * How the two blocks are named where an editor reads them (the requirement).
 *
 * „Systemweiter Mailserver" and „Eigener Mailserver dieser Organisation" and not
 * „System"/„Eigen": the row is always one of the organisation the reader is in — the
 * log is tenant-scoped and the identity is resolved from the row's own
 * `tenant_id` — so „dieser Organisation" is precise without carrying a name the
 * server would have to copy into every line.
 */
const SENDER_IDENTITY_LABELS: Readonly<Record<MailSenderIdentity, string>> = {
  system: 'Systemweiter Mailserver',
  own: 'Eigener Mailserver dieser Organisation',
};

/**
 * The sentence under *Versandidentität* — **four cases, and each of them is a
 * different sentence on purpose.**
 *
 * 1. An identity was recorded → the block plus the address it sent from. The
 *    address is the actionable half (which domain's SPF record is in question),
 *    so it is shown and not hidden behind the label.
 *    **On a `queued` line it is prefixed with „Letzter Versuch".** Such a line
 *    exists — a refused attempt goes back to the queue and keeps the identity
 *    it was refused under, deliberately — and without the prefix the same
 *    words appear under a „In Warteschlange"-Chip as under a „Zugestellt"-Chip
 *    and read like a promise about the *next* send. The columns only ever
 *    describe an attempt that has already happened; the next run resolves
 *    anew, and after a System→eigen switch it will resolve differently.
 * 2. No identity **and nothing has been attempted** (`queued`) → „noch nicht
 *    versandt". This is the case the requirement names by name: the view must
 *    **not** say „System" here. It is written as a *derivation from the status*
 *    rather than as a default so that the two cannot be confused — a `??
 *    'Systemweiter Mailserver'` would read perfectly and be a claim about a
 *    send that never happened.
 * 3. No identity, the line is finished, and **no attempt was ever counted** →
 *    „Kein Versand versucht". That is not a gap in the record but the record
 *    itself: the only way a line reaches `failed` with `attempts` still at zero
 *    is the arm that refuses to interpret a stored block (mixed, half-filled,
 *    or one that will not open), and it fails the row without asking any mail
 *    server. „Nicht aufgezeichnet" over that line would send a reader looking
 *    for a lost value instead of at `Grund`, which says what is wrong.
 * 4. No identity, the line is finished, and attempts were counted → „nicht
 *    aufgezeichnet". A row from before this column existed — or one whose body
 *    would not render, which counts an attempt and still asks no transport.
 *    Saying „noch nicht versandt" over a „Zugestellt" chip would be a
 *    contradiction on screen; this one is the honest „wir wissen es nicht".
 *
 * The address may also stand without a label only in theory — the two columns
 * are written by one statement — so a missing address degrades to the label
 * alone rather than to a stray pair of brackets.
 */
function senderIdentityLabel(entry: {
  readonly senderIdentity: MailSenderIdentity | null;
  readonly senderAddress: string | null;
  readonly status: MailStatus;
  readonly attempts: number;
}): string {
  if (entry.senderIdentity === null) {
    if (entry.status === 'queued') {
      return 'Noch nicht versandt';
    }
    return entry.attempts === 0
      ? 'Kein Versand versucht'
      : 'Nicht aufgezeichnet';
  }
  const label = SENDER_IDENTITY_LABELS[entry.senderIdentity];
  const named =
    entry.senderAddress === null ? label : `${label} (${entry.senderAddress})`;
  // A waiting line's identity is a past attempt, never a plan for the next one.
  return entry.status === 'queued' ? `Letzter Versuch: ${named}` : named;
}

/**
 * What stands in the „Antwortadresse" row of the detail panel (the requirement).
 *
 * `null` is **not** a missing value here but the effective one: if nothing is
 * set on any of the three levels, the mail goes out without a `Reply-To`
 * header, and an answer lands at the sender address — the decision
 * `effectiveReplyTo` (`@formsache/shared`) justifies. „Nicht aufgezeichnet"
 * would therefore be wrong here, unlike one row further up at the sending
 * identity: the column is written for *every* row when it is queued, there is
 * no state “not yet”.
 *
 * The **origin** deliberately does not stand next to it: which level won back
 * then is a statement about a configuration of up to 90 days ago that need not
 * exist that way any more. Whoever wants to know it for the *next* mail finds
 * it in the notification editor, where it supports a decision.
 */
function replyToLabel(replyTo: string | null): string {
  return replyTo ?? 'Keine – Antworten gehen an die Absenderadresse';
}

export function MailLogView({
  formId,
}: {
  /** The form the prefilter is on, or null for the whole organisation's log. */
  readonly formId: string | null;
}): ReactElement {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const retry = useRetryMailLogEntry();

  const log = useMailLog({
    ...(status === null ? {} : { status }),
    ...(formId === null ? {} : { formId }),
  });
  /**
   * Only to **name** the prefilter, and asked for only when there is one.
   *
   * The summary list rather than `GET /forms/:id`: a row whose form has since
   * been deleted still stands here (`form_id` is `SetNull`), and a 404 on a
   * detail route would turn “the form no longer exists” into an error
   * page over a log that is perfectly readable. Absent from the list simply
   * means the chip falls back to „dieses Formular".
   *
   * **By id.** It used to search the whole form list, which the
   * pagination made a wrong question: the list is one page now, so “not in
   * it” would have meant “on page three” for every organisation past two dozen
   * forms — and the chip would have fallen back to „dieses Formular" for
   * exactly the busy Organisationen whose mail log needs naming most.
   */
  const forms = useFormSummary(formId);
  const formTitle = forms.data?.items.find((row) => row.id === formId)?.title;

  if (log.isPending) {
    return (
      <div className="mail-log">
        <p className="mail-log__state" role="status">
          Versandprotokoll wird geladen…
        </p>
      </div>
    );
  }

  if (log.data === undefined) {
    const httpStatus =
      log.error instanceof ApiError ? log.error.status : undefined;
    return (
      <div className="mail-log">
        <p className="mail-log__state" role="alert">
          {httpStatus === 403
            ? 'Diese Rolle darf das Versandprotokoll nicht sehen. Es zeigt Empfängeradressen und Betreffzeilen aus Antworten – dafür sind die Rechte „Einstellungen verwalten" und „Antworten ansehen" nötig.'
            : 'Das Versandprotokoll konnte nicht geladen werden.'}{' '}
          <button
            type="button"
            className="mail-log__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  const { entries, counts } = log.data;
  /**
   * How many lines the current filter matches **in the whole organisation** — the
   * number the table is compared against.
   *
   * The KPI counters are computed server-side over everything, the table is one
   * page of the newest rows; „Gesamt 900" over a table of 200 is two numbers
   * about the same thing with no explanation, and a Jahrestagung with 400
   * registrations reaches that on the first day. Read off the counters rather
   * than from a „truncated" flag: the tile for the active status *is* the size
   * of the filtered set, so this stays right whatever the page size becomes and
   * needs nothing added to the payload.
   */
  const matching = status === null ? counts.total : counts[status];

  return (
    <div className="mail-log">
      <div className="mail-log__head">
        <h1 className="mail-log__title">E-Mail-Versandprotokoll</h1>
        {formId === null ? null : (
          <div className="mail-log__filter-chip">
            <span data-testid="form-filter">
              Nur Formular: {formTitle ?? 'dieses Formular'}
            </span>
            <button
              type="button"
              className="mail-log__link"
              onClick={() => {
                navigate(mailLogPath());
              }}
            >
              Filter aufheben
            </button>
          </div>
        )}
        {formId === null ? null : (
          <button
            type="button"
            className="mail-log__button"
            onClick={() => {
              navigate(notificationsPath(formId));
            }}
          >
            Zu den Benachrichtigungen
          </button>
        )}
      </div>

      <div
        className="mail-log__kpis"
        role="group"
        aria-label="Nach Status filtern"
      >
        {TILES.map((tile) => {
          const active = status === tile.status;
          return (
            <button
              key={tile.label}
              type="button"
              className={
                active ? 'mail-log__kpi mail-log__kpi--active' : 'mail-log__kpi'
              }
              aria-pressed={active}
              data-testid={`kpi-${tile.status ?? 'total'}`}
              onClick={() => {
                // A second click on the active tile clears the filter — the
                // tile is a toggle, not a radio, and „Gesamt" is the absence of
                // a status rather than a fourth one.
                setStatus(active ? null : tile.status);
              }}
            >
              <span className="mail-log__kpi-value">
                {String(counts[tile.key])}
              </span>
              <span className="mail-log__kpi-label">{tile.label}</span>
            </button>
          );
        })}
      </div>

      <p className="mail-log__retention">
        {/*
          The number comes from `MAIL_LOG_RETENTION_DAYS` — the **same**
          constant the purge deletes against (the requirement). A literal here
          would be the second number that keeps telling the old story on the day
          somebody changes the retention, and the one an organisation reads is this one.
        */}
        Protokoll wird {String(MAIL_LOG_RETENTION_DAYS)} Tage aufbewahrt, danach
        werden die Zeilen endgültig gelöscht.
      </p>

      {retry.isError ? (
        <p className="mail-log__alert" role="alert">
          {retryErrorMessage(retry.error)}
        </p>
      ) : null}

      <p className="mail-log__count" role="status" data-testid="row-count">
        {rowCountText(entries.length, matching)}
        {status === null ? '' : ` · Filter: ${STATUS_LABELS[status]}`}
      </p>

      {entries.length === 0 ? (
        <p className="mail-log__empty">
          Keine Einträge – hier steht jede E-Mail, die dieses System verschickt
          hat.
        </p>
      ) : (
        <div className="mail-log__table-scroll">
          <table className="mail-log__table">
            <thead>
              <tr>
                <th scope="col">Zeitpunkt</th>
                <th scope="col">Empfänger</th>
                <th scope="col">Betreff / Benachrichtigung</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <MailLogRow
                  key={entry.id}
                  entry={entry}
                  isRetrying={retry.isPending && retry.variables === entry.id}
                  onRetry={() => {
                    retry.mutate(entry.id);
                  }}
                  onOpenDetail={() => {
                    setDetailId(entry.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId === null ? null : (
        <MailLogDetailPanel
          id={detailId}
          onClose={() => {
            setDetailId(null);
          }}
        />
      )}
    </div>
  );
}

function MailLogRow({
  entry,
  isRetrying,
  onRetry,
  onOpenDetail,
}: {
  readonly entry: MailLogEntry;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
  /** Opens the detail panel — the rendered mail, the requirement, item 4. */
  readonly onOpenDetail: () => void;
}): ReactElement {
  return (
    <tr data-testid={`mail-log-row-${entry.id}`}>
      <td>{formatDeadline(entry.createdAt)}</td>
      <td className="mail-log__recipient">
        {entry.recipient ?? (
          <span className="mail-log__erased">{ERASED_TEXT}</span>
        )}
      </td>
      <td>
        {/*
          A button, not a plain span: this is the one thing a row does — open
          the mail it stands for. `entry` alone never carries the body (see
          `mailLogEntrySchema`), so there is nothing here to show without the
          detail route.

          Except once the row is erased: `subject === null` then, and a
          button whose accessible name is the empty string is worse than no
          button — keyboard and screen reader cannot name it at all. Plain,
          non-interactive text instead; there is nothing left to open.
        */}
        {entry.subject === null ? (
          <span className="mail-log__subject mail-log__erased">
            {ERASED_TEXT}
          </span>
        ) : (
          <button
            type="button"
            className="mail-log__subject-button"
            data-testid={`view-${entry.id}`}
            onClick={onOpenDetail}
          >
            <span className="mail-log__subject">{entry.subject}</span>
          </button>
        )}
        <span className="mail-log__notification">
          {entry.notificationName ?? 'Benachrichtigung gelöscht'}
        </span>
        {/*
          The reason a line sits where it sits — shown for `failed` (the error)
          and for `queued` with a reason, which is how the requirement („ohne
          SMTP-Konfiguration") becomes readable instead of a queue that never
          moves for no stated reason.
        */}
        {entry.lastError === null ? null : (
          <span className="mail-log__error">{entry.lastError}</span>
        )}
      </td>
      <td className="mail-log__status-cell">
        <span className={`mail-log__chip mail-log__chip--${entry.status}`}>
          {STATUS_LABELS[entry.status]}
        </span>
        {entry.attempts > 1 ? (
          <span className="mail-log__attempts">
            {String(entry.attempts)} Versuche
          </span>
        ) : null}
        {/*
          Erased rows (`recipient === null`) are excluded here too — the
          server is about to gain a lock against retrying one, but the UI is
          comfort, never the boundary, so it should not offer the click in the
          first place rather than lean on that lock alone.

          **And system rows likewise** (a review finding). `MailLogService.retry`
          refuses a `trigger = 'system'` row with a 409 (ADR-0020, ADR-0021):
          a reset mail hangs on this organization only because
          `mail_log.tenant_id` is NOT NULL, and an `editor` has nothing to do
          with the account in question. The boundary stays there; all that
          stands here is that the button does not lead into a refusal it
          triggered itself. That is only possible since `trigger` travels with
          the list — before that this row could not ask the question and offered
          it. The reason can be read in the detail panel as „Auslöser:
          Systemmail".
        */}
        {entry.status === 'failed' &&
        entry.recipient !== null &&
        entry.trigger !== 'system' ? (
          <button
            type="button"
            className="mail-log__retry"
            disabled={isRetrying}
            data-testid={`retry-${entry.id}`}
            onClick={onRetry}
          >
            {isRetrying ? 'Wird eingereiht…' : '↻ Erneut'}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * What stands above the table: how many lines it shows, and — when the server
 * sent fewer than the filter matches — that it is the **newest** ones.
 *
 * The alternative is a silent cut: „200 Zeilen" under a tile reading „900",
 * with nothing saying which 200 or why. Said as one sentence with both numbers,
 * because „gekürzt" without the total is just as unanswerable a question.
 *
 * `shown < matching` is the only test, so the sentence appears exactly when
 * something is missing and never otherwise — including the day the page size
 * changes.
 */
function rowCountText(shown: number, matching: number): string {
  if (shown < matching) {
    return `Es werden die neuesten ${String(shown)} von ${String(matching)} Zeilen gezeigt`;
  }
  return shown === 1 ? '1 Zeile' : `${String(shown)} Zeilen`;
}

/** What a failed „↻ Erneut" says. */
function retryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return 'Diese Zeile ist nicht (mehr) fehlgeschlagen – bitte die Liste neu laden.';
    }
    if (error.status === 429) {
      return 'Zu viele Wiederholungen in kurzer Zeit. Bitte einen Moment warten.';
    }
    if (error.detail !== undefined) {
      return error.detail;
    }
  }
  return 'Der erneute Versand konnte nicht angestoßen werden.';
}

/**
 * „Die gerenderte Mail im Versandprotokoll ansehen" —
 * one row's recipient, subject, status, Auslöser and rendered body.
 *
 * A modal slide-in, the same behaviour as `ResponseDetailPanel`
 * (`views/responses/ResponseDetailPanel.tsx`): focus moves in on open, Tab
 * stays inside, Escape and the scrim close it, and focus returns to the row's
 * „Anzeigen" button. Its own component rather than a shared one with that
 * panel — the two show unrelated shapes (a table of answers there, a mail
 * here) and forcing one component to cover both would be the wrong axis to
 * share on; what *is* shared is the sandboxed iframe (`SandboxedHtmlFrame`),
 * which is the part that actually repeats.
 */
function MailLogDetailPanel({
  id,
  onClose,
}: {
  readonly id: string;
  readonly onClose: () => void;
}): ReactElement {
  const titleId = useId();
  const { panelRef, onKeyDown } = useFocusTrap({ onClose });
  const detail = useMailLogDetail(id);

  return (
    <div className="mail-log__detail">
      <div
        className="mail-log__detail-scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="mail-log__detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="mail-log__detail-head">
          <h2 className="mail-log__detail-title" id={titleId}>
            E-Mail ansehen
          </h2>
          <button
            type="button"
            className="mail-log__detail-close"
            onClick={onClose}
          >
            <span className="visually-hidden">Schließen</span>
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {detail.isPending ? (
          <p className="mail-log__detail-note" role="status">
            Wird geladen…
          </p>
        ) : detail.isError ? (
          <p className="mail-log__detail-note" role="alert">
            {detail.error instanceof ApiError && detail.error.status === 404
              ? 'Diese Zeile wurde nicht gefunden – vermutlich wurde sie inzwischen endgültig gelöscht.'
              : 'Die E-Mail konnte nicht geladen werden.'}
          </p>
        ) : (
          <MailLogDetailBody detail={detail.data} />
        )}
      </div>
    </div>
  );
}

function MailLogDetailBody({
  detail,
}: {
  readonly detail: MailLogDetail;
}): ReactElement {
  return (
    <div className="mail-log__detail-body">
      <dl className="mail-log__detail-fields">
        <dt>Empfänger</dt>
        <dd>
          {detail.recipient ?? (
            <span className="mail-log__erased">{ERASED_TEXT}</span>
          )}
        </dd>
        <dt>Betreff</dt>
        <dd>
          {detail.subject ?? (
            <span className="mail-log__erased">{ERASED_TEXT}</span>
          )}
        </dd>
        <dt>Status</dt>
        <dd>
          <span className={`mail-log__chip mail-log__chip--${detail.status}`}>
            {STATUS_LABELS[detail.status]}
          </span>
        </dd>
        <dt>Auslöser</dt>
        <dd>{TRIGGER_LABELS[detail.trigger]}</dd>
        <dt>Versandidentität</dt>
        <dd data-testid="mail-log-sender-identity">
          {senderIdentityLabel(detail)}
        </dd>
        {/*
          **This row's reply address** (the requirement) — the value that
          `mail_log.reply_to` received when it was **queued**, not the one the
          three levels would yield today. That is precisely why it stands here
          and not as a query back to the notification: whoever changed the
          organization's default yesterday must still be able to see what the
          mail from the day before yesterday carried.
        */}
        <dt>Antwortadresse</dt>
        <dd data-testid="mail-log-reply-to">{replyToLabel(detail.replyTo)}</dd>
      </dl>

      {/*
        Three cases, in the order `mailLogDetailSchema`'s comment gives them:
        nothing stored (a row from before the freeze of 2026-07-28), text
        only, or both — and HTML is what a mail client would actually show, so
        it wins when it is there. `bodyHtml`/`bodyText` already carry
        `{{bearbeiten}}` resolved (`MailLogService.detail`); there is no raw
        mark to explain here.
      */}
      {detail.bodyText === null ? (
        <p className="mail-log__detail-note">
          Zu dieser Zeile ist kein Text gespeichert – sie wurde eingereiht,
          bevor der Rumpf beim Einreihen eingefroren wurde.
        </p>
      ) : detail.bodyHtml === null ? (
        <pre className="mail-log__detail-text" data-testid="mail-log-body-text">
          {detail.bodyText}
        </pre>
      ) : (
        <SandboxedHtmlFrame
          className="mail-log__detail-body-frame"
          testId="mail-log-body-frame"
          title="Gerenderte E-Mail (HTML)"
          html={detail.bodyHtml}
        />
      )}
    </div>
  );
}
