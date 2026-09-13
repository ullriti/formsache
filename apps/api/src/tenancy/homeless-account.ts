import type { Prisma } from '@prisma/client';

/**
 * **An account that belongs to nobody any more is deleted** — the one version
 * of this rule (since 2026-08-03).
 *
 * `user` carries no `tenant_id`: an account is installation-wide and not a
 * datum of an organisation. It therefore hangs on nothing an organisation could
 * clear away, and nobody sees it any more as soon as its last membership is
 * gone — people are enumerated everywhere via `membership`. Without this
 * statement `email`, `name`, `password_hash` and the OIDC identity would stand
 * in the database **indefinitely**, the address would stay taken
 * installation-wide (`user.email` is `@unique`, ADR-0012), and the person could
 * go on signing in: `AuthService.login` demands no membership.
 *
 * ## Two doors, one rule
 *
 * A membership can disappear in two ways, and both end here:
 *
 * 1. the organisation is finally deleted after 30 days and takes it along
 *    (`RetentionPurgeService.purgeHomelessAccounts`);
 * 2. somebody is taken out of their last organisation via *Person entfernen*
 *    ({@link ScopedMembershipDelegate.remove}).
 *
 * The question is the same in both cases — „gehört diese Zeile noch
 * jemandem?" —, and it therefore has exactly **one** version. Two versions
 * would be two answers to „wer wird nie gelöscht", and the dangerous one of
 * the two would only be noticed once it had deleted somebody who still
 * exists.
 *
 * The same question a third time, without candidates:
 * {@link deleteHomelessAccounts}.
 *
 * ## The two conditions, and they stand in the `where`
 *
 * - **`memberships: { none: {} }`** — *the most dangerous line.* Whoever is
 *   still in **another** organisation is not touched; the account is
 *   installation-wide. Without this condition the removal from organisation A
 *   takes along somebody who works in the living organisation B, irrevocably.
 * - **`isSuperadmin: false`** — a superadmin needs no membership at all: „keine
 *   Organisation" is their normal state, not their homelessness. Otherwise the
 *   departure from the last organisation deletes the administration of the
 *   installation along with it.
 *
 * Both stand in the `where` condition of the statement that acts, not in an
 * `if` before it: a membership that comes into being between the check and the
 * `DELETE` has to make the `DELETE` **not match**, instead of losing against an
 * outdated read. The same form as
 * `ScopedTenantDelegate.purgeIfDeletedBefore`.
 *
 * ## „Uneingelöste Einladung" was the wrong rule
 *
 * The first version deleted only a row **without a password and without an
 * `oidc_subject`** — somebody who never signed in. That is a statement about
 * the account's past, and it answers the wrong question: a real user who loses
 * their last organisation thus stayed standing indefinitely, invisible to
 * everybody, with a taken address and a working login. The rule was never „hat
 * nie gearbeitet", but „gehört dieses Konto noch jemandem" — and that is what
 * the two conditions above answer. Since then the invitation is no special case
 * any more, but the same case without code of its own.
 *
 * ## The order belongs to the caller
 *
 * What is counted is what stands in `membership` **now**. The caller must
 * therefore be rid of the membership before asking — in the same transaction,
 * because otherwise they count the just-removed one too and delete nobody. For
 * the same reason the purge reads its candidates **before** deleting the
 * organisation and judges **afterwards**; a test covers both directions (see
 * `RetentionPurgeService.purgeHomelessAccounts`).
 *
 * `session`, `form_permission` and `membership` cascade from `user`, so an open
 * session of this person is gone afterwards and their next request gets the 401
 * an unknown session gets.
 *
 * @param db transaction or client — the condition is evaluated where the caller
 *   stands, so that it sees its own, not yet visible deletion of the
 *   membership.
 * @returns 1 if the account was deleted, otherwise 0.
 */
export async function deleteHomelessAccount(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  const { count } = await db.user.deleteMany({
    // Deliberately **not** tenant-scoped, and this is the one query of its
    // callers that may not be: `user` carries no `tenant_id`, and the question
    // being asked is precisely „is this row still somebody else's?". Counting
    // only one organisation's memberships would delete somebody another organisation is still
    // holding.
    where: { id: userId, isSuperadmin: false, memberships: { none: {} } },
  });
  return count;
}

/**
 * **The same rule, asked one last time — without a candidate list** (a review finding).
 *
 * `where` is the `where` of {@link deleteHomelessAccount} **minus the one
 * condition that comes from a list**: `id`. Both domain conditions stay
 * standing word for word, and precisely for that reason this here is not a
 * third rule, but the same one without the detour via „wen fragen wir".
 *
 * ## Why this way is needed at all
 *
 * The purge deletes the organisation and the accounts in **two separate
 * statements**: the organisation's cascade commits, and only afterwards does
 * the `DELETE` on `user` follow. If anything aborts in between — loss of
 * connection, `SIGKILL`, a thrown exception —, then the next run no longer
 * lists the organisation (it is gone) and would **never again** get to these
 * accounts via its candidate list. There would be no path back: `user` carries
 * no `tenant_id`, no listing shows a person without a membership, and the login
 * demands none. The state this rule is meant to end would be permanent — and
 * invisible. A reconciliation that asks the question globally does not have
 * this gap: it finds what is there, instead of remembering what was to be
 * looked for.
 *
 * ## What that takes along, and that this is the decision
 *
 * An account that has become homeless by **some other way** is deleted here as
 * well — it need never have been in a deleted organisation. That is intended
 * and part of the rule: an account without a membership and without a superadmin
 * right has no place any more, and **both** doors (purge of the organisation
 * and *Person entfernen*) lead into exactly this state. Since then
 * „Nicht-Superadmin ohne Mitgliedschaft" is not a reachable lasting state at
 * all any more, but a residue — and a residue is what a reconciliation clears
 * up.
 *
 * ## The precondition that makes this race-free
 *
 * There is **no** window of time in which a freshly created account **without a
 * superadmin right** stands there without a membership. The places that produce
 * a `user` row have been **four** since ADR-0022:
 *
 * | Place | Why it loses nothing here |
 * |---|---|
 * | {@link ScopedMembershipDelegate.createLocal} | account **and** membership in *one* transaction |
 * | {@link ScopedMembershipDelegate.createOidcInvitation} | the same transaction |
 * | `AdminRepository.createTenant` | the same transaction (first administrator of a new organisation) |
 * | `createFirstSuperadmin` (`setup/first-superadmin.ts`) | **`isSuperadmin: true`** — the condition below takes it out |
 *
 * Before the commit this `DELETE` does not see the row, after the commit it
 * sees the membership. An unredeemed invitation is therefore no special case
 * and no victim: it *has* a membership for as long as its organisation lives.
 *
 * **The fourth place holds the property for a different reason**, and that is
 * why it stands written out here instead of running along in the enumeration:
 * the setup may leave an organisation out (`input.tenant === null`), so it then
 * creates an account **without** a membership — and this `DELETE` would go past
 * that if it did not except `is_superadmin`. Whoever ever draws the exception
 * below more narrowly deletes the freshly set-up superadministrator of an
 * installation that has no organisation yet.
 *
 * If the property were lost — an account without a superadmin right that is
 * first created and only afterwards assigned to an organisation —, then this
 * reconciliation would delete it in between. It is thus the condition under
 * which the statement here may stand, and it belongs to every future change at
 * the four places named.
 *
 * @param db transaction or client.
 * @returns number of deleted accounts.
 */
export async function deleteHomelessAccounts(
  db: Prisma.TransactionClient,
): Promise<number> {
  const { count } = await db.user.deleteMany({
    // Not tenant-scoped, for the reason `deleteHomelessAccount` names — and
    // here additionally without `id`: that is the whole difference.
    where: { isSuperadmin: false, memberships: { none: {} } },
  });
  return count;
}
