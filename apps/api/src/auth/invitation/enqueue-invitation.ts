import type { Prisma } from '@prisma/client';

import type { AccountInvitation } from './account-invitation';

/**
 * Enqueues the invitation of an account — **one version, three callers**
 * (ADR-0024).
 *
 * | Place | Occasion |
 * |---|---|
 * | `ScopedMembershipDelegate.createLocal` | an organization creates a person |
 * | `ScopedMembershipDelegate.createOidcInvitation` | the same, with SSO |
 * | `ScopedMembershipDelegate.resendInvitation` | „Einladung erneut senden" |
 * | `AdminRepository.createTenant` | the first administrator of a new organization |
 *
 * Takes a **transaction** and not a `PrismaService`, for the same reason as
 * `password-reset-invalidation.ts`: the invitation belongs in the same
 * transaction as the account. Two statements one after the other would have a
 * window in between — an account without an invitation is an account nobody
 * gets into, and an invitation without an account is a mail whose link points
 * nowhere.
 *
 * A dependency-free module and not the export of a service class, likewise as
 * there: `tenant-scope.ts` and `admin.repository.ts` fetch themselves a
 * **statement**, not the dependency tree of `AccountInvitationService`.
 *
 * ## The recipient is read, not passed in
 *
 * From the row that the same transaction has just written — the same
 * construction as in `ScopedMembershipDelegate.setPassword`, and for the same
 * reason: that way the address cannot be the one from before.
 *
 * ## `trigger: 'system'`, and that is a security condition
 *
 * Three things hang on this value (ADR-0023 *Consequences*): the row goes over
 * the mail server of the **installation**, its link is built from that
 * installation's base address, and it is not repeatable in the dispatch log.
 * Were it to go over the organization's mail server, a relay that someone with
 * `can_manage_settings` enters would get the fully rendered invitation link in
 * plaintext — that is, full power over an account that does not belong to that
 * person. The same decision that ADR-0020 §8 made for the reset, and with an
 * invitation it weighs more heavily: it goes to **every** new account,
 * not only to the one whose password was just forgotten.
 */
export async function enqueueInvitation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  invitation: AccountInvitation,
): Promise<void> {
  const person = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });

  const mail = await tx.mailLog.create({
    data: {
      tenantId,
      recipient: person.email,
      subject: invitation.subject,
      // For a local account the body carries the **marker**, never the address
      // — `account-invitation-mail.ts` says why.
      bodyText: invitation.bodyText,
      bodyHtml: invitation.bodyHtml,
      replyTo: invitation.replyTo,
      status: 'queued',
      trigger: 'system',
      // The clock of the queue, as on every other enqueue path.
      createdAt: invitation.stampedAt,
    },
    select: { id: true },
  });

  if (invitation.token === null) {
    // An SSO account: no invitation row, so `QueuedBodyRenderer.resetLinkFor`
    // finds none and inserts nothing. The mail carries no marker anyway.
    return;
  }

  await tx.passwordResetToken.create({
    data: {
      // The id comes along — it **is** the signed message
      // (`password-reset-token.ts`).
      id: invitation.token.id,
      kind: 'invitation',
      userId,
      tokenHash: invitation.token.tokenHash,
      expiresAt: invitation.token.expiresAt,
      mailLogId: mail.id,
    },
  });
}
