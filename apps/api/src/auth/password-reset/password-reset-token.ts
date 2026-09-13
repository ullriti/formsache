import { createHash, randomUUID } from 'node:crypto';

import type { SigningService } from '../../common/secret-box/signing.service';

/**
 * How a reset link comes about and how it is found again (ADR-0020).
 *
 * ## The one rule
 *
 * **The token stands in no column of this database.** What is stored is its
 * SHA-256 (`password_reset.token_hash`); the value itself is
 * `HMAC-SHA256(subkey, id)` over the id of the same row — that is,
 * **recoverable** from the row plus the installation key, and from nothing
 * without the key.
 *
 * That is no gimmick but the answer to a concrete attack surface: the mail goes
 * over the queue (ADR-0004), and its body is frozen at enqueue time and
 * **displayed** later — `mailLogDetailSchema` carries `bodyText`, the mail log
 * shows it behind `can_manage_form_settings` + `can_view_responses`. If the link
 * stood there, this read view would be a way to every local account whose reset
 * mail has landed in this organisation — past `can_manage_users` and not
 * stopping at the system administration.
 * Because the token is recoverable, the stored body carries only a
 * mark (`PASSWORD_RESET_LINK_MARK`), and the address comes into being only at
 * the moment of delivery.
 *
 * ## What that costs and brings compared with „nur den Hash speichern"
 *
 * | What leaks | pure random value, hash stored | this procedure |
 * |---|---|---|
 * | database dump | token not derivable | token not derivable |
 * | signing key | — | useless without row ids |
 * | both | token not derivable | token derivable (open rows only, max. 1 h) |
 * | `mail_log` read view | **token in clear text** | nothing |
 *
 * The third row is the price, the fourth the gain — and the fourth describes a
 * view this product actually has, while the third describes an attacker who
 * already holds database *and* environment and can therefore issue sessions
 * anyway.
 *
 * ## Why the id is passed along
 *
 * Hash and id have to come from one hand: an id handed out by the database would
 * yield a row whose hash belongs to a different value — the link would be valid,
 * the sending would build another one, and nothing would turn red.
 * `password_reset.id` therefore deliberately carries **no** `@default`
 * (`schema.prisma`), and {@link mintPasswordResetToken} is the only place that
 * produces both values.
 */

/** A freshly minted reset row, before it is written. */
export interface MintedPasswordReset {
  /** The row's id — **and** the message that is signed over. */
  readonly id: string;
  /** The value for the link. Leaves the process only into the mail. */
  readonly token: string;
  /** What goes into the column. */
  readonly tokenHash: Uint8Array<ArrayBuffer>;
}

/**
 * Id, token and hash in one go.
 *
 * `randomUUID()` and not the `uuid(7)` default of the other tables: here the id
 * is the signed message, so it has to stand **before** the write. That it thus
 * becomes random rather than time-ordered is no loss for this table — it is
 * never sorted — and a small gain for security: an id one could guess from a
 * timestamp would be half the message.
 */
export function mintPasswordResetToken(
  signing: SigningService,
): MintedPasswordReset {
  const id = randomUUID();
  const token = signing.sign('auth.password-reset', id);
  return { id, token, tokenHash: digestPasswordResetToken(token) };
}

/**
 * The token of a known row once more — the way of the sending.
 *
 * The same function as at minting, deliberately under a name of its own: here
 * nothing is produced but something is **recovered**, and the caller should see
 * on reading which of the two they are doing.
 */
export function recoverPasswordResetToken(
  signing: SigningService,
  id: string,
): string {
  return signing.sign('auth.password-reset', id);
}

/**
 * SHA-256 of the token, as raw bytes for the `Bytes` column.
 *
 * Not Argon2id, and for the same reason as with the sessions
 * (`session-token.ts`): the input is full entropy, there is no dictionary to
 * slow down, and the lookup path **is** this digest — a salt per row would rule
 * the index out.
 */
export function digestPasswordResetToken(
  token: string,
): Uint8Array<ArrayBuffer> {
  // `Uint8Array.from` instead of the hash function's `Buffer` — the same
  // reasoning as in `session-token.ts`: Prisma's `Bytes` demands a real
  // `ArrayBuffer`.
  return Uint8Array.from(createHash('sha256').update(token, 'utf8').digest());
}
