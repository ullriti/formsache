/**
 * What an invitation is, **as a value** — without Nest, without Prisma, without
 * an import (ADR-0024).
 *
 * Its own dependency-free file for the same reason as
 * `password-reset-invalidation.ts`: the write side lives in
 * `tenancy/tenant-scope.ts` and in `admin/admin.repository.ts`, and both
 * are meant to know the **value**, not the service class that builds it
 * ({@link AccountInvitationService}) — otherwise its dependency tree
 * (signing key, clock, system settings) would be pulled into the import graph
 * of nearly every request path.
 */

/** The invitation link, before its row is written. */
export interface AccountInvitationToken {
  /**
   * The id of the `password_reset` row — **and** the message that is
   * signed over. It comes along instead of being assigned by the database;
   * see `password-reset-token.ts` for the whole reasoning.
   */
  readonly id: string;
  /** What goes into the column: the SHA-256 of the value from the link. */
  readonly tokenHash: Uint8Array<ArrayBuffer>;
  /** `ACCOUNT_INVITATION_TTL_DAYS` after the enqueueing. */
  readonly expiresAt: Date;
}

/**
 * The invitation as the write operation gets it.
 *
 * **The recipient is deliberately not in it** — the same shape as
 * `PasswordNotice`: the transaction reads the address from the row it has
 * just written, so that it cannot be the one from earlier.
 */
export interface AccountInvitation {
  readonly subject: string;
  /** For a local account it carries the brand, never the address. */
  readonly bodyText: string;
  readonly bodyHtml: string;
  /** The effective `Reply-To` value, or `null` for „no header". */
  readonly replyTo: string | null;
  /** The moment of enqueueing — from the clock of the queue. */
  readonly stampedAt: Date;
  /**
   * The link — **`null` for an SSO account**, and that is no omission: a
   * provider account gets no password, so there is nothing to set. The
   * mail goes out all the same; it says where one signs in.
   */
  readonly token: AccountInvitationToken | null;
}

/**
 * Why an invitation cannot go out — **before** anything is
 * written (ADR-0024).
 *
 * Both sentences name the place where it is to be fixed, and not the
 * person who happens to be standing in front of it: whoever manages members as
 * a rule does *not* reach the system administration, and a sentence that asks
 * them to enter something there would be a dead end. The same consideration
 * ADR-0023 no. 1 makes for the two versions of „kein Mailserver".
 *
 * They stand **here** and not with the service class, so that
 * `admin/admin.repository.ts` can use them without importing its dependency
 * tree — the same separation that is the reason for this file in the first place.
 */
export const INVITATION_NO_MAIL_SERVER_MESSAGE =
  'Der Mailserver der Instanz ist nicht eingerichtet, und ohne ihn lässt sich ' +
  'keine Einladung verschicken. Die Systemverwaltung trägt ihn unter ' +
  '„Mailserver & Basis-Adresse" ein; danach lässt sich die Person anlegen.';

export const INVITATION_NO_BASE_URL_MESSAGE =
  'Die Basis-Adresse der Installation ist nicht eingetragen, und ohne sie ' +
  'lässt sich kein Einladungslink bilden. Die Systemverwaltung trägt sie ' +
  'unter „Mailserver & Basis-Adresse" ein; danach lässt sich die Person ' +
  'anlegen.';

/**
 * What `AccountInvitationService.plan` answers — **three exits, and two
 * of them are refusals with a name.**
 *
 * Not `AccountInvitation | null`: „it cannot be done" has two causes with two
 * different sentences, and a single `null` would force every caller to think
 * one up or to melt both into one.
 */
export type InvitationPlan =
  | { readonly kind: 'ready'; readonly invitation: AccountInvitation }
  | { readonly kind: 'no-mail-server' }
  | { readonly kind: 'no-base-url' };

/**
 * The sentence for one of the two refusals — one version for all callers.
 *
 * Takes the refusal arms of the plan and not the whole plan: a `'ready'`
 * would have no answer here, and a caller who passed it in would have
 * forgotten a case. The type says so, instead of discovering it at runtime.
 */
export function invitationRefusalMessage(
  plan: Exclude<InvitationPlan, { kind: 'ready' }>,
): string {
  return plan.kind === 'no-mail-server'
    ? INVITATION_NO_MAIL_SERVER_MESSAGE
    : INVITATION_NO_BASE_URL_MESSAGE;
}
