import { Injectable } from '@nestjs/common';
import {
  accountInvitationPath,
  insertEditLink,
  insertPasswordResetLink,
  passwordResetPath,
  wrapMailBody,
  type EditLinkPresentation,
  type MailShell,
  type PasswordResetLinkSlot,
} from '@formsache/shared';

import { recoverPasswordResetToken } from '../auth/password-reset/password-reset-token';
import { PublicUrlService } from '../common/public-url/public-url.service';
import { SigningService } from '../common/secret-box/signing.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  UnreadableSettingsError,
  enforcedSettings,
} from '../settings/settings-enforcement';
import {
  MailBodyRenderer,
  type MailBodySource,
  type RenderedMailBody,
} from './mail-body-renderer';
import { identitySourceOf } from './mail-identity.service';

/**
 * The body of a queued mail: **read, not rendered** .
 *
 * ## What this step does, and what it deliberately no longer does
 *
 * `mail_log` carries the rendered body since the freeze decision, so there is
 * nothing left to build here. The only thing still open in that text is the
 * `{{bearbeiten}}` slot (`EDIT_LINK_MARK`), and filling it is the whole job of
 * this class.
 *
 * Everything else about a queued mail — the answer values, the organisation, the date,
 * the notification's wording — was settled inside the transaction that stored
 * the answer. It follows that **this class reads no notification at all any
 * more**: the query that fetched the template back is gone, not commented out,
 * because a second read is exactly how „der Rumpf folgt der Benachrichtigung
 * von heute" came to exist in the first place.
 *
 * ## Why the link is the one exception
 *
 * It is not a property of the submission but of the *present*: the requirement
 * says `allowEdit` is evaluated „bei jedem Zugriff", and the application clears
 * `response.edit_token` when the access word is switched on — usually because
 * the link leaked. A link frozen three days ago would therefore be an address
 * that is dead, or worse revoked, by the time somebody clicks it, in an inbox
 * where nothing can be taken back.
 *
 * **No link is a valid answer, and the mail still goes out.** `allowEdit` off,
 * a revoked token, an answer in the trash, an answer physically deleted, a
 * form withdrawn: each of them means the placeholder resolves to nothing and the
 * rest of the text stands exactly as it was written. That is the direction that
 * cannot do harm — the opposite, a confirmation withheld because a switch moved
 * after it was promised, would punish a participant for somebody else's setting.
 *
 * **A settings document that does not parse is the one exception, and it became
 * one after a later review.** „Kein Link" is the right answer to a *decision* („dieses
 * Formular erlaubt kein Bearbeiten"); it is the wrong answer to „ich kann die
 * Entscheidung nicht lesen". The three possibilities are not two:
 *
 * 1. send without the link — irreversible, and since the system layer is one row
 *    for the whole installation, its radius is every organisation at once;
 * 2. **let the attempt fail** — chosen: the row stays `queued`, runs the backoff
 *    and ends on `failed` with a readable reason in the mail log;
 * 3. not enqueue at all — wrong, the answer has been accepted and the requirement promises
 *    the confirmation.
 *
 * An unreadable document is a *temporary* operating state, and the queue is
 * built for exactly that. A delayed, visible failure is repairable; a linkless
 * mail already sitting in somebody's inbox is not. Same ranking as „sichtbar
 * schlägt still" — and the same reason the submission path answers a
 * repeatable 503 instead of accepting on guessed settings.
 *
 * ## What a failure here means
 *
 * A rejection, never an empty mail — two ways to fail: a row whose `body_text`
 * is null (queued before the body was frozen), and a settings document that
 * cannot be read. Both are retried by the worker under the backoff and end
 * on `failed` with a readable German reason in the mail log.
 *
 * ---------------------------------------------------------------------------
 * **`PrismaService` here is the fifth allow-list entry of `eslint.config.js`,
 * used exactly as that entry describes.** There is no request behind this and
 * no caller with a tenant: the worker hands over the row it claimed, and the
 * query below is bound to **that row's** `tenant_id` — one resolved source, the
 * same rule the write in `public/submission-mail.ts` follows. The table has no
 * composite foreign key underneath it, so the binding in
 * the `where` is the whole boundary, not a second one.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class QueuedBodyRenderer extends MailBodyRenderer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publicUrls: PublicUrlService,
    /**
     * The subkey a reset token comes out of — used here
     * to **recover** it (ADR-0020, {@link resetLinkFor}).
     */
    private readonly signing: SigningService,
  ) {
    super();
  }

  async render(
    mail: MailBodySource,
    presentation: EditLinkPresentation = 'real',
  ): Promise<RenderedMailBody> {
    if (mail.bodyText === null) {
      // Written before the body was frozen (or by hand). There is nothing to
      // send, and an empty mail is not the answer.
      throw new Error(
        'Zu dieser Nachricht ist kein Text gespeichert; sie wurde vor der ' +
          'Umstellung eingereiht und kann nicht erzeugt werden.',
      );
    }

    const editUrl = await this.editUrlFor(mail, presentation);
    const reset = await this.resetLinkFor(mail, presentation);
    if (reset.kind === 'dead' && presentation === 'real') {
      // **An account mail without its link does not go out** — a
      // reset as little as an invitation (ADR-0024). Not: remove the
      // mark and deliver the rest — what would be left is a mail that
      // announces an address and names none, and nobody can take that
      // back. The queue tries again under the delay
      // and ends after the attempts on `failed` with a readable
      // reason — „sichtbar schlägt still".
      //
      // Only for `'real'`: the detail view shows nothing but a label anyway and
      // is the page on which somebody looks up *why* a mail did not go
      // out. Answering it with the same error would take the diagnosis
      // away.
      throw new Error(PASSWORD_RESET_LINK_MISSING_REASON);
    }
    const slot: PasswordResetLinkSlot =
      reset.kind === 'live'
        ? { present: true, url: reset.url }
        : { present: false, url: null };

    const text = insertPasswordResetLink(
      insertEditLink(mail.bodyText, 'text', editUrl, presentation),
      'text',
      slot,
      presentation,
    );

    /*
     * **First fill the marks, then wrap — and never the other way round.**
     *
     * `insertEditLink` and `insertPasswordResetLink` are `replaceAll` over the
     * **stored** body. The shell comes afterwards and is fixed text
     * of this process: it contains no mark, so it can produce none, and
     * it moves none — the result of the two insertions is character
     * for character the same as before, it merely stands in a document. Exactly
     * that is what the tests of this package hold fast.
     *
     * In this order for a second reason as well: inserting the shell
     * *before* the marks are filled would mean letting a `replaceAll`
     * run over a document this module wrote itself
     * — and thus over text which it expressly avoids searching
     * elsewhere (see `resetLinkFor`, „The condition is the
     * **row**, never the text").
     *
     * **One call for both versions.** `wrapMailBody` takes text and HTML
     * together, so that no mail goes out with a footer in the HTML and without
     * one in the plain text — the text version is the half that gets
     * forgotten (ADR-0026).
     */
    return wrapMailBody(
      {
        text,
        ...(mail.bodyHtml === null
          ? {}
          : {
              html: insertPasswordResetLink(
                insertEditLink(mail.bodyHtml, 'html', editUrl, presentation),
                'html',
                slot,
                presentation,
              ),
            }),
      },
      await this.shellFor(mail),
    );
  }

  /**
   * **The frame around both versions — and it follows the identity, not the
   * row.**
   *
   * ## One rule for colour, name and address
   *
   * What is asked is {@link identitySourceOf}, the same single version of the
   * mapping „who does this row belong to?" the worker also picks its mail
   * server by (ADR-0023 no. 4) — and it decides **all three** entries of the
   * shell together, not the address alone:
   *
   * - **`tenant`** — confirmation, message to the office, change message, test
   *   mail of an Organisation: the mail goes out over the mail server *of this
   *   Organisation* under its domain. It carries its colour, its
   *   name and its address — the same one the edit link
   *   of the same mail points at ({@link PublicUrlService.resolveBaseUrl}, with
   *   the fallback to the address of the installation). Two hosts in one mail
   *   would be two offers, of which a participant can check neither.
   * - **`system`** — reset, invitation, notice about a password that was
   *   set, system test mail: the mail belongs to the **installation**. It carries
   *   **no** Organisation colour and **no** Organisation name in the
   *   shell, and its address is `installationBaseUrl()`.
   *
   * ⚠️ **The `system` arm is a correction, not an addition.** Until this
   * finding this method read the `tenant` row for *every* mail and thereby
   * dressed an invitation, too, in the colours of the Organisation that
   * issued it. Two things were wrong about it:
   *
   * 1. **ADR-0023.** „An einer Systemmail bestimmt keine Organisation etwas" —
   *    `TestMailService.shellFor` and `OpsAlertService` had already built
   *    exactly that for their own mails and commented it with the same
   *    reasoning. This place was the third that should have done it.
   * 2. **The two ways said different things about the same row.** A
   *    system test mail is delivered by `TestMailService` **without** colour and
   *    name; the same row rendered once more through this method
   *    (the detail view of the mail log) produced it **with** them. The promise
   *    „the detail view shows exactly what went out" did not hold with that.
   *
   * The origin is not lost in the process: reset, invitation and
   * password-notice mail name the Organisation in their **body**
   * („Organisation „X"", `password-reset-mail.ts` and
   * `account-invitation-mail.ts`) — there, where ADR-0026 expressly allows it
   * as an *entry* and has bolted it against line breaks.
   *
   * ## What that costs
   *
   * A system mail now costs **no** `tenant` query any more (one before);
   * an Organisation mail costs the resolution of the base address in addition —
   * up to two reads, and on a confirmation with an edit link
   * `responseEditUrl` resolves the same chain a second time. Deliberately not
   * cached: this service is a singleton, a store across
   * several deliveries would be an address from yesterday, and a
   * store per call would be state in a method that has none today.
   * The queue works at the pace of humans, not of thousands per
   * second.
   *
   * `mail.tenantId` is the id of the **claimed row**, never a
   * parameter of a caller; so the same binding holds here as for the
   * query in `editUrlFor`, and the same reasoning that stands in the header of
   * this file for the `PrismaService`.
   *
   * An Organisation that no longer exists costs the colour and not the
   * mail: `wrapMailBody` takes all fields optionally and falls back on the
   * default. Letting a delivery fail over a colour would be
   * the direction this file expressly does not take for the edit link
   * („no link is a valid answer").
   */
  private async shellFor(mail: MailBodySource): Promise<MailShell> {
    if (identitySourceOf(mail.trigger) === 'system') {
      const base = await this.publicUrls.installationBaseUrl();
      return base === null
        ? {}
        : { link: { owner: 'installation', url: base } };
    }
    const [tenant, base] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: mail.tenantId },
        select: { name: true, accentColor: true },
      }),
      this.publicUrls.resolveBaseUrl(mail.tenantId),
    ]);
    return {
      ...(tenant === null
        ? {}
        : { accent: tenant.accentColor, organisation: tenant.name }),
      ...(base === null
        ? {}
        : { link: { owner: 'organisation' as const, url: base } }),
    };
  }

  /**
   * The reset link of this row (ADR-0020) — three answers, not two.
   *
   * ## Why the token comes into being here and not at enqueueing time
   *
   * The stored body carries only a mark. If the address stood in it, it
   * would be in `mail_log.body_text` — the column the detail view of the
   * mail log outputs (`mailLogDetailSchema.bodyText`), reachable with
   * `can_manage_form_settings` + `can_view_responses`. But a reset link is the
   * power over an **account**: that read view would thereby be a way to every
   * local account whose reset mail landed in this Organisation — past
   * `can_manage_users` and not stopping at the system administration.
   *
   * It is possible because the token is **recoverable** from the id of the
   * `password_reset` row and the installation key
   * (`auth/password-reset/password-reset-token.ts`).
   *
   * ## The condition is the **row**, never the text
   *
   * A reset mail is recognised at `trigger = 'system'` and at the
   * `password_reset` row that points at it via `mail_log_id` — not at whether
   * the mark occurs in the body. That is the difference between a
   * condition and a text search: if an editor wrote the mark verbatim
   * into an HTML template (`neutraliseLiteral` leaves author markup standing),
   * every mail of that notification would otherwise be permanently undeliverable — with a
   * message that fits nothing the author did. This way it gets
   * `'none'`, the mark is removed, and the mail goes.
   *
   * ## The base address is that of the **installation**
   *
   * `installationBaseUrl()`, not `resolveBaseUrl(tenantId)`: the
   * Organisation's own address is set by whoever has `can_manage_settings`, and
   * `baseUrlSchema` accepts every absolute http(s) address. A reset link
   * on it would be a real, correctly worded mail to the victim whose
   * only link points at the attacker. The same reasoning that
   * `oidcCallbackUrl` and `appUrl` already carry.
   *
   * ## `'redacted'` does not sign
   *
   * The detail view gets a label; a token that were first formed for it
   * and then thrown away would be a power that travels one step
   * too far. The branch therefore ends at „there is one" and computes nothing.
   */
  private async resetLinkFor(
    mail: MailBodySource,
    presentation: EditLinkPresentation,
  ): Promise<ResetLink> {
    if (mail.trigger !== 'system') {
      // The cheap exclusion, and it stands on a **column**: the
      // overwhelming majority of rows is a confirmation, and one
      // query per mail for a kind that occurs once a month would be one
      // query too many.
      return { kind: 'none' };
    }

    const reset = await this.prisma.passwordResetToken.findUnique({
      where: { mailLogId: mail.id },
      select: { id: true, kind: true, expiresAt: true, usedAt: true },
    });
    if (reset === null) {
      // A system mail without a reset row — the notice about a
      // password set administratively is exactly that. It carries no mark,
      // and if it does, no power belongs in it.
      return { kind: 'none' };
    }
    if (reset.usedAt !== null || reset.expiresAt.getTime() <= Date.now()) {
      // Redeemed or expired: the link leads nowhere, and building it
      // all the same would be an address that answers with „ungültig".
      return { kind: 'dead' };
    }

    if (presentation === 'redacted') {
      return { kind: 'live', url: null };
    }

    const base = await this.publicUrls.installationBaseUrl();
    if (base === null) {
      return { kind: 'dead' };
    }
    const token = recoverPasswordResetToken(this.signing, reset.id);
    return {
      kind: 'live',
      /*
       * **The kind decides the address, not the power**
       * (ADR-0024). Both links carry the same token and are redeemed over the
       * same route; what differs is the page that opens the
       * link — „Neues Passwort vergeben" against „Willkommen, jetzt dein
       * Passwort setzen". A human who never had a password reads
       * the first sentence as an error.
       *
       * The column is read, not the text: the same rule as for
       * recognising the row at all („The condition is the **row**, never
       * the text").
       */
      url: `${base}${
        reset.kind === 'invitation'
          ? accountInvitationPath(token)
          : passwordResetPath(token)
      }`,
    };
  }

  /**
   * Where the participant may still change this answer — or `null`.
   *
   * The conditions are the refusal chain of the edit route itself
   * (`PublicFormsService.loadForEdit` and `byEditToken`), asked one attempt
   * before the participant would: an unknown or revoked token, an answer in the
   * trash, a form that is gone or unpublished, and `allowEdit` off all end
   * that route in a 404 or a 409. Handing out an address that is already known
   * to answer „gibt es nicht" is worse than handing out none.
   *
   * A settings document that does not parse **refuses**, it does not answer
   * „kein Link" — see the block at the top of this file for why the delivery is
   * the thing that has to wait.
   *
   * **Except when the caller is the mail log's detail route**
   * (`presentation === 'redacted'`). That route hands out no address at all, it
   * shows a label; it is also the page an operator opens to find out *why* mails
   * are failing, and answering it with a 500 for the same broken row would take
   * away the diagnosis. It degrades to „kein Link", which is a display
   * inaccuracy in a read-only view rather than something that leaves the server.
   */
  private async editUrlFor(
    mail: MailBodySource,
    presentation: EditLinkPresentation,
  ): Promise<string | null> {
    if (mail.responseId === null) {
      // The answer was physically deleted; `SetNull` kept the log line. The
      // mail still goes out — its text does not depend on that row any more.
      return null;
    }

    const response = await this.prisma.response.findFirst({
      // `tenant_id` from the claimed row, never from anywhere else.
      where: { id: mail.responseId, tenantId: mail.tenantId, deletedAt: null },
      select: {
        editToken: true,
        form: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            settingsOverride: true,
            tenant: { select: { id: true, formDefaults: true } },
          },
        },
      },
    });

    // The answer is gone or in the trash; the edit route answers 404 for
    // both, so there is no link to hand out.
    if (response === null) {
      return null;
    }

    const { editToken, form } = response;
    if (
      // Revoked with the access word  …
      editToken === null ||
      // … or the form itself is gone or no longer published.
      form.deletedAt !== null ||
      form.status !== 'active'
    ) {
      return null;
    }

    let allowEdit: boolean;
    try {
      // The **strict** reading of both documents — an unreadable one refuses
      // rather than answering „darf bearbeitet werden".
      allowEdit = enforcedSettings(form).allowEdit;
    } catch (error: unknown) {
      if (error instanceof UnreadableSettingsError) {
        if (presentation === 'redacted') {
          return null;
        }
        // The cause is deliberately **not** chained: the message of this error
        // becomes `mail_log.last_error`, which an editor reads in the
        // mail log, and `UnreadableSettingsError` carries the ids of the
        // documents it choked on. What is actionable there is „später erneut",
        // not which row is broken (`CONTRIBUTING.md`).
        // eslint-disable-next-line preserve-caught-error -- see above
        throw new Error(UNREADABLE_SETTINGS_MAIL_REASON);
      }
      throw error;
    }

    // The form's own Organisation, read off the row this method already fetched —
    // never a session, which the worker does not have at all (the requirement's second reproduction: reading a session here is not merely
    // wrong, there is nothing to read).
    return allowEdit
      ? await this.publicUrls.responseEditUrl(form.tenant.id, editToken)
      : null;
  }
}

/**
 * Why a delivery was postponed when the settings could not be read.
 *
 * German and free of ids, because it is what an editor sees in the
 * mail log — the same shape as the „kein Text gespeichert" reason above.
 * It says „später erneut", because that is true: the queue retries under the
 * backoff, and the state resolves itself as soon as the document parses.
 */
export const UNREADABLE_SETTINGS_MAIL_REASON =
  'Die geltenden Einstellungen konnten nicht gelesen werden; die Nachricht ' +
  'wird später erneut versucht.';

/**
 * What {@link QueuedBodyRenderer.resetLinkFor} answers — **three** states,
 * because two would throw them together (ADR-0020).
 *
 * `none` means „this mail is no reset mail": the mark is removed,
 * and the delivery runs. `dead` means „it is one, and the link leads
 * nowhere": the delivery fails. With a single `null` both would be
 * the same — and an HTML template in which the mark stands verbatim
 * would permanently block every mail of a notification.
 */
type ResetLink =
  | { readonly kind: 'none' }
  | { readonly kind: 'dead' }
  /** `url` is `null` exactly when the rendering is redacted. */
  | { readonly kind: 'live'; readonly url: string | null };

/**
 * Why an account mail with a link stays lying — German, without ids and
 * without values, like every other reason that lands in `mail_log.last_error`.
 *
 * **„Link" and not „Rücksetz-Link"** (ADR-0024): since the invitation the same
 * row carries two kinds, and the sentence stands in the mail log of an
 * Organisation. „Rücksetz-Link" on an invitation would be a word that fits
 * nothing the reading person occasioned.
 */
export const PASSWORD_RESET_LINK_MISSING_REASON =
  'Zu dieser Nachricht lässt sich kein gültiger Link mehr bilden; sie wird ' +
  'nicht ohne Link zugestellt.';
