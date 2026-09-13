import type { EditLinkPresentation } from '@formsache/shared';
import type { NotificationTrigger } from '@prisma/client';

/**
 * The body of one mail, as the worker hands it to the transport.
 *
 * `text` is always there — an HTML mail carries a plain-text alternative, as
 * `OutgoingMail` already says.
 */
export interface RenderedMailBody {
  readonly text: string;
  readonly html?: string;
}

/**
 * What {@link MailBodyRenderer.render} needs from a row.
 *
 * **Not `ClaimedMail`, since the mail log's detail route (* „Die gerenderte Mail ansehen") reuses this renderer too.** That route reads
 * through `ScopedMailLogDelegate` — a plain `mail_log` row, tenant-scoped, no
 * queue claim behind it — and the `{{bearbeiten}}` resolution it needs is
 * exactly `editUrlFor` below, not a second reading of `response`/`allowEdit`.
 * Narrowing the parameter to what `render()` actually touches is what lets
 * both callers hand it their own row shape without either duplicating the
 * resolution or reaching for fields (`recipient`, `attempts`, `tenantName`, …)
 * that only the worker's claim carries. `ClaimedMail` satisfies this shape
 * structurally, so the worker's call site is unchanged.
 *
 * **That detail route asks for `'redacted'`, never `'real'`.** The route
 * proves `can_view_responses` — read rights — and the edit link is a write
 * capability on a stranger's answer; `editUrlFor` still decides whether a
 * link exists (revoked token, `allowEdit` off, a deleted answer), but
 * {@link EditLinkPresentation} decides whether the *address* leaves the
 * server. See `apps/api/src/mail-log/mail-log.service.ts`.
 */
export interface MailBodySource {
  /**
   * The identifier of the log row.
   *
   * Part of this shape since ADR-0020, and for a reason that is worth the care:
   * a reset mail carries only a mark in the stored body, and the link for it is
   * found by the sending over **this** identifier — the `password_reset` row
   * points to the mail row out of whose identifier it forms the token anew.
   * Without this field the power of attorney would stand in
   * `mail_log.body_text`, that is in a column the mail log displays.
   */
  readonly id: string;
  /**
   * Why this row goes out — and for the body **a condition, not a label**
   * (ADR-0020).
   *
   * `system` is the identifying mark of a system mail. The reset link is
   * fastened to it and to the `password_reset` row, **never** to whether the
   * mark occurs in the text: otherwise an editor who writes it verbatim into an
   * HTML template could make every mail of that notification permanently
   * undeliverable.
   */
  readonly trigger: NotificationTrigger;
  readonly tenantId: string;
  readonly responseId: string | null;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
}

/**
 * Turns a claimed queue row — or a mail log row — into the rendered
 * message body.
 *
 * **Almost nothing is left to do here, and that is the decision of
 * 2026-07-28.** The body is rendered when the answer arrives and stored in
 * `mail_log.body_text` / `body_html` (see `schema.prisma`); this step only
 * fills the one slot that was deliberately left open, the `{{bearbeiten}}`
 * link, whose validity is read fresh on every attempt.
 *
 * Until then the whole text was rebuilt here from the notification and the
 * answer. The argument for that was data economy — no second copy of the
 * participant's answers in the log — and it lost to three consequences of the
 * window between queueing and sending, which is days long with a dead mail
 * server or after „↻ Erneut": an edited notification silently rewrote a
 * confirmation that had already been promised, a corrected answer did too, and
 * a deleted answer made the row unrenderable, so the delivery failed for good.
 * A confirmation confirms what held at the moment it was sent. The price — a
 * second copy of the answer values, purged with the row after ninety days and
 * blanked when the answer is physically deleted — is named at the column.
 *
 * **Still a port and not a method on the worker.** The worker orchestrates
 * claim → send → record and must stay testable without a database behind the
 * body; the test suites substitute a stub renderer for exactly that
 * reason.
 */
export abstract class MailBodyRenderer {
  /**
   * `presentation` defaults to `'real'` — the worker's send, unchanged. The
   * mail log's detail route is the only caller that passes
   * `'redacted'`.
   */
  abstract render(
    mail: MailBodySource,
    presentation?: EditLinkPresentation,
  ): Promise<RenderedMailBody>;
}
