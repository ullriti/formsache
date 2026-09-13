import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The two Prisma failures that are **not** programming mistakes and therefore
 * must not reach a caller as a 500.
 *
 * Everything else stays untranslated on purpose: a 500 for an unexpected
 * database error is the honest answer, and a catch-all here would turn real
 * defects into polite German.
 */

/**
 * What a caller is told when their write lost a race it is allowed to lose.
 *
 * `P2034` is what PostgreSQL's `40001` (*could not serialize access*) becomes
 * in Prisma, and it is the running cost of the `Serializable` transactions this
 * application uses where a **count** has to be right — the last administrator
 * of an organisation, and the participant limits. Under
 * `Serializable` PostgreSQL may abort *either* of two concurrent transactions
 * and expect the loser to try again; nothing was written, so „noch einmal" is
 * literally all there is to do.
 *
 * Without this translation the loser got a 500 (review finding) — an
 * answer that says „der Server ist kaputt" about a situation in which it is
 * working exactly as designed, and one an editor cannot act on.
 */
export const CONCURRENT_WRITE_MESSAGE =
  'Diese Änderung hat sich mit einer anderen überschnitten und wurde nicht ' +
  'gespeichert. Bitte noch einmal versuchen.';

/**
 * Turns a serialization failure into the readable 409, and hands anything else
 * back unchanged so a caller can `throw translateConcurrency(error)`.
 *
 * A function returning the error rather than a filter registered globally: the
 * message above is only true where **nothing** was written, which is the case
 * for a transaction PostgreSQL aborted — a global filter would say the same
 * sentence about failures where that is not known.
 */
export function translateConcurrency(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    return new ConflictException(CONCURRENT_WRITE_MESSAGE);
  }
  return error;
}

/**
 * Whether a failed write lost at a unique index (`P2002`).
 *
 * The predicate, not a translation: what a `P2002` *means* differs per call
 * site — a duplicate group name is a 409, a lost race for an OIDC invitation is
 * „read the row the winner wrote" — and only the recognition is the same
 * everywhere. It is spelled here because a hand-written
 * `instanceof … && code === 'P2002'` is two conditions of which the first is
 * easy to forget: without the `instanceof`, `error.code` on an arbitrary
 * `unknown` does not compile, and the shape that tempts a reader to reach for
 * `as` is exactly the one that starts swallowing unrelated failures.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
