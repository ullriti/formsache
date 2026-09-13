import type { Prisma } from '@prisma/client';

/**
 * Invalidates **every** open reset link of a person — one version, four
 * callers (ADR-0020 §6).
 *
 * A link that survives a password change is exactly the second key a password
 * change is meant to remove. The four places that therefore have to remove it:
 *
 * | Place | Path |
 * |---|---|
 * | `PasswordResetService.request` | a new link invalidates the older ones |
 * | `PasswordResetService.redeem` | the redemption itself |
 * | `ProfileService.changePassword` | one's own change |
 * | `ScopedMembershipDelegate.setPassword` | the administrative setting |
 *
 * Takes a transaction and not a `PrismaService`: the invalidation belongs in
 * the same transaction as the password change, otherwise there is a window in
 * which the new password stands and the old link still works.
 *
 * ## Why a file and not an export out of `password-reset.service.ts`
 *
 * That is where it stood first, and the fourth caller — `tenant-scope.ts` —
 * **copied the statement out by hand** instead of calling it (a review
 * finding). The promise „one version" stood in the docblock and was not kept;
 * no cycle ever forced it.
 *
 * A module of its own, free of dependencies, is the construction
 * `tenant-scope.ts` already uses twice for exactly this case
 * (`mail-log-erasure.ts`, `public/event-seats.ts`): the core layer fetches a
 * **statement** and not a service class along with its dependencies. The
 * import out of the service file would have worked — it would have pulled
 * `PasswordResetService`, `SigningService`, `MailClock` and
 * `SystemMailSettingsService` into the import graph of almost every request
 * path, for a statement of four lines.
 *
 * ## No `tenantId`, and that is deliberate
 *
 * A reset link belongs to an **account**, not to an organisation
 * (`password_reset` carries no `tenant_id`). The administrative setting checks
 * the membership in the same transaction before it gets here; were this
 * statement restricted to one organisation, the link would survive that of
 * every other — and an account has exactly one password per person.
 */
export async function invalidateOpenTokens(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
): Promise<void> {
  await tx.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
}
