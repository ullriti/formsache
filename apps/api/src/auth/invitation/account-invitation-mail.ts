import {
  ACCOUNT_INVITATION_TTL_DAYS,
  PASSWORD_RESET_LINK_MARK,
  collapseWhitespace,
  escapeHtml,
  renderAnswerTable,
  type MailLabelledValue,
} from '@formsache/shared';

/**
 * The text of the **invitation mail** — fixed, German, without any template
 * (ADR-0024).
 *
 * ## Why no notification template
 *
 * The same reasoning that `password-reset-mail.ts` and `passwordSetNoticeBody`
 * already carry, here with double weight: a mail whose wording an organisation
 * determines would be a way to write something to somebody in the name of the
 * installation that looks like a system message — and **this** mail carries a
 * power of attorney over an account. A sentence like "please confirm here
 * first" next to the real link would be one line of work in an editable
 * template.
 *
 * What goes in is therefore fixed and short: the name of the person, the name
 * of the organisation, the address of the installation and — in the SSO case —
 * the caption of the sign-in button. No *sentence* of this mail is selectable.
 *
 * ## ⚠️ Three of these four values are foreign values — the correction to
 * ADR-0026
 *
 * Until this finding it said here that no field of these functions comes out of
 * a request body that somebody fills freely. **That was wrong**, and precisely
 * at the place where it weighs most: `personName` is literally `request.name`
 * when a person is created (`TenantUsersService.create`), the recipient is
 * `request.email` out of the same body, `tenantName` is written by whoever
 * holds `can_manage_settings`, and `buttonLabel` likewise. They all come out of
 * the database — but somebody wrote them into it.
 *
 * The way that opened: a name with line breaks yields additional lines in the
 * **text version** (the HTML version was covered by {@link escapeHtml} and
 * `renderAnswerTable`, the text version goes through `stripMarkup` and lets
 * `\n` through) — so a mail delivered over the mail server of the
 * **installation**, SPF/DKIM-signed, to a freely chosen mailbox, whose wording
 * the caller determines by half.
 *
 * Two bolts stand against that now, and the order is deliberate:
 *
 * 1. **At the place of origin**: `userNameSchema`,
 *    `tenantBrandingWriteSchema.name`, `tenantCreateSchema.name` and
 *    `oidcConfigWriteSchema.buttonLabel` demand `isSingleLineText` — a value
 *    with `\n` does not reach the column at all.
 * 2. **Here**, immediately before inserting: {@link collapseWhitespace} over
 *    every foreign value, for lines from the time before bolt 1, from a restore
 *    or from a write path that somebody adds later.
 *
 * ## Two versions, one source
 *
 * `text` is **always** set, next to `html` as well: a mailbox without an HTML
 * display would otherwise get an empty invitation — and that is the one mail
 * without which somebody does not get in at all. **Nothing** is wrapped here:
 * the row goes over `mail_log`, and `QueuedBodyRenderer.render` sets the shell
 * when delivering (`wrapMailHtml`), after it has filled the mark.
 */

/**
 * The subject.
 *
 * Fixed and recognisable, like `PASSWORD_RESET_SUBJECT` and
 * `TEST_MAIL_SUBJECT` — in the mail log the row is not supposed to look
 * like a confirmed sign-up.
 */
export const ACCOUNT_INVITATION_SUBJECT =
  'Formsache: Einladung zu deinem Konto';

/** Both versions of an invitation; `text` is never absent. */
export interface AccountInvitationBody {
  readonly text: string;
  readonly html: string;
}

/** What the invitation of a **local** account knows about itself. */
export interface LocalInvitationInput {
  readonly personName: string;
  /**
   * The organisation that invited — or `null`.
   *
   * `null` means "the row does not exist any more" (a deleted organisation
   * whose membership was still standing). The sentence then leaves out the
   * origin instead of putting an empty space in quotation marks: a mail with
   * `Organisation „"` is worse than one without this half-sentence. The same
   * direction that `QueuedBodyRenderer.shellFor` takes for colour and name —
   * that costs the detail and not the mail.
   */
  readonly tenantName: string | null;
  /** The address at which the person signs in later. */
  readonly appUrl: string;
}

/**
 * The invitation of a **local** account — **with the mark instead of the
 * address**.
 *
 * {@link PASSWORD_RESET_LINK_MARK} is the reason why this function has no `url`
 * argument for the invitation link and must not get one either: the body is
 * frozen and displayed (`mail_log.body_text`, the mail log behind
 * `can_manage_form_settings` + `can_view_responses`), the power of attorney
 * only comes into being when delivering. A caller that handed a finished
 * address in here would put it into a column that a read view outputs — the
 * whole reasoning stands in
 * `auth/password-reset/password-reset-token.ts`.
 *
 * `appUrl` on the other hand **may** stand in it: that is the start page of the
 * installation, no power of attorney, and it stands in every other mail of this
 * application anyway.
 */
export function localInvitationBody(
  input: LocalInvitationInput,
): AccountInvitationBody {
  const tenantName = mailSafeTenantName(input.tenantName);
  const lead = invitationLead(input.personName, tenantName);
  const ask =
    'Damit du dich anmelden kannst, fehlt nur noch dein Passwort. Du ' +
    'vergibst es selbst; niemand sonst kennt es.';
  const facts: readonly MailLabelledValue[] = [
    ...organisationFact(tenantName),
    { label: 'Anmeldeadresse', value: input.appUrl },
    { label: 'Anmeldename', value: 'deine E-Mail-Adresse' },
  ];
  const validity =
    `Der Link gilt ${String(ACCOUNT_INVITATION_TTL_DAYS)} Tage und lässt sich ` +
    'genau einmal benutzen. Ist er abgelaufen, bitte die Verwaltung deiner ' +
    'Organisation, dir die Einladung erneut zu schicken.';
  const unexpected =
    'Erwartest du diese Einladung nicht, brauchst du nichts zu tun: ohne den ' +
    'Link entsteht kein Passwort, und er verfällt von allein.';

  return {
    text: [
      lead,
      '',
      ask,
      '',
      'Über diese Adresse vergibst du dein Passwort:',
      // The mark stands alone on a line — as in the reset mail, so that a
      // mail client recognises it as an address as soon as it is filled.
      PASSWORD_RESET_LINK_MARK,
      '',
      validity,
      '',
      renderAnswerTable(facts, 'text'),
      '',
      unexpected,
    ].join('\n'),
    html: [
      `<p style="margin:0 0 16px 0">${escapeHtml(lead)}</p>`,
      `<p style="margin:0 0 16px 0">${escapeHtml(ask)}</p>`,
      `<p style="margin:0 0 16px 0">${escapeHtml(
        'Über diese Adresse vergibst du dein Passwort:',
      )}<br />${PASSWORD_RESET_LINK_MARK}</p>`,
      `<p style="margin:0 0 16px 0">${escapeHtml(validity)}</p>`,
      renderAnswerTable(facts, 'html'),
      `<p style="margin:16px 0 0 0">${escapeHtml(unexpected)}</p>`,
    ].join(''),
  };
}

/** What the invitation of an **SSO** account knows about itself. */
export interface OidcInvitationInput {
  readonly personName: string;
  /** See {@link LocalInvitationInput.tenantName}. */
  readonly tenantName: string | null;
  readonly appUrl: string;
  /**
   * The caption of the button that leads to this sign-in service on the sign-in
   * page — the value `oidcProviderSchema.buttonLabel` carries, already resolved
   * to the default.
   *
   * It stands in the mail, because "sign in via SSO" tells nobody where to
   * click: what the person looks for on the page is this word.
   */
  readonly buttonLabel: string;
}

/**
 * The invitation of an **SSO** account — without a link, and that is no
 * shortcoming.
 *
 * An SSO account gets no password (ADR-0012: „kein Anbieterkonto mit einem
 * zweiten, leisen Weg hinein"), so there is nothing to set here and
 * consequently no power of attorney to send either. What the mail achieves is
 * what nobody else achieves: **the person learns that the account exists** and
 * by which way they get in.
 *
 * The body therefore carries no {@link PASSWORD_RESET_LINK_MARK} — and the row
 * in `mail_log` has no `password_reset` row next to it, which is why
 * `QueuedBodyRenderer.resetLinkFor` treats it as `'none'` and inserts nothing.
 */
export function oidcInvitationBody(
  input: OidcInvitationInput,
): AccountInvitationBody {
  const tenantName = mailSafeTenantName(input.tenantName);
  const buttonLabel = collapseWhitespace(input.buttonLabel);
  const lead = invitationLead(input.personName, tenantName);
  const provider =
    tenantName === null
      ? 'den Anmeldedienst deiner Organisation'
      : `den Anmeldedienst von „${tenantName}"`;
  const how =
    `Du brauchst dafür kein eigenes Passwort: die Anmeldung läuft über ` +
    `${provider}. Öffne ${input.appUrl} und wähle auf der Anmeldeseite die ` +
    `Schaltfläche „${buttonLabel}" — melde dich dort mit den ` +
    `Zugangsdaten an, die du in deiner Organisation ohnehin benutzt.`;
  const address =
    'Wichtig ist nur, dass die E-Mail-Adresse, die dein Anmeldedienst meldet, ' +
    'dieselbe ist, an die diese Nachricht ging — sonst wird die Anmeldung ' +
    'abgewiesen.';
  const facts: readonly MailLabelledValue[] = [
    ...organisationFact(tenantName),
    { label: 'Anmeldeadresse', value: input.appUrl },
    { label: 'Anmeldeweg', value: buttonLabel },
  ];
  const unexpected =
    'Erwartest du diese Einladung nicht, brauchst du nichts zu tun; wende ' +
    'dich bei Fragen an die Verwaltung deiner Organisation.';

  return {
    text: [
      lead,
      '',
      how,
      '',
      address,
      '',
      renderAnswerTable(facts, 'text'),
      '',
      unexpected,
    ].join('\n'),
    html: [
      `<p style="margin:0 0 16px 0">${escapeHtml(lead)}</p>`,
      `<p style="margin:0 0 16px 0">${escapeHtml(how)}</p>`,
      `<p style="margin:0 0 16px 0">${escapeHtml(address)}</p>`,
      renderAnswerTable(facts, 'html'),
      `<p style="margin:16px 0 0 0">${escapeHtml(unexpected)}</p>`,
    ].join(''),
  };
}

/**
 * The first sentence of both versions — written once, because it is the same in
 * both and on the second typing only almost.
 */
function invitationLead(personName: string, tenantName: string | null): string {
  // **The foreign value is folded here and not at the caller** (ADR-0026):
  // both versions go through this one function, and a caller that forgot it is
  // thereby no longer a possibility.
  const person = collapseWhitespace(personName);
  return tenantName === null
    ? `Hallo ${person}, für dich wurde bei Formsache ein Konto angelegt.`
    : `Hallo ${person}, für dich wurde bei Formsache ein Konto angelegt — ` +
        `von der Organisation „${tenantName}".`;
}

/**
 * The name of the organisation, single-line — and `null` when nothing of it
 * remains (ADR-0026).
 *
 * The second part is the reason for the separate function: `collapseWhitespace`
 * over a name that consists **only** of control characters yields the empty
 * string, and that would write `Organisation „"` into the mail — exactly what
 * {@link LocalInvitationInput.tenantName} rules out for the deleted
 * organisation. Both the same outcome, therefore the same answer.
 */
function mailSafeTenantName(tenantName: string | null): string | null {
  if (tenantName === null) {
    return null;
  }
  const folded = collapseWhitespace(tenantName);
  return folded === '' ? null : folded;
}

/** The „Organisation" row of the table — or none at all. */
function organisationFact(
  tenantName: string | null,
): readonly MailLabelledValue[] {
  return tenantName === null
    ? []
    : [{ label: 'Organisation', value: tenantName }];
}
