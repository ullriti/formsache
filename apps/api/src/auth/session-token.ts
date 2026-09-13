import { createHash, randomBytes } from 'node:crypto';

/**
 * Minting and digesting session tokens (ADR-0005).
 *
 * The rule the rest of the auth module rests on: **the raw token exists only
 * in the response and in the browser.** What reaches the database is its
 * SHA-256 digest, so a database dump — or a leaked backup, or a `SELECT` by
 * someone with read access — cannot be replayed as a login.
 */

/**
 * 32 bytes of CSPRNG output, i.e. 256 bits. Far past the point where guessing
 * is worth attempting, and short enough to stay well inside any cookie size
 * limit once base64url-encoded (43 characters).
 */
const TOKEN_BYTES = 32;

/**
 * base64url, not hex: same entropy in two thirds of the characters, and the
 * alphabet contains nothing a cookie value has to escape (RFC 6265 forbids
 * `;`, `,`, `"`, `\` and whitespace — base64url uses none of them). Node emits
 * it without `=` padding.
 */
export function mintSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 of the token, as raw bytes for the `Bytes` column.
 *
 * Deliberately *not* Argon2id: the input is full-entropy random, so there is
 * no dictionary to slow an attacker down, and a KDF on every request would be
 * a cheap CPU-exhaustion vector instead. A per-row salt is impossible anyway —
 * the lookup happens *by* this digest, which is what keeps it a single indexed
 * read (`schema.prisma`, model `Session`).
 */
export function digestSessionToken(token: string): Uint8Array<ArrayBuffer> {
  // `Uint8Array.from` rather than the `Buffer` the hash returns: a `Buffer` is
  // typed over `ArrayBufferLike`, which may be a `SharedArrayBuffer`, and
  // Prisma's `Bytes` column insists on a plain `ArrayBuffer`. Copying 32 bytes
  // is cheaper than the cast it would otherwise take.
  return Uint8Array.from(createHash('sha256').update(token, 'utf8').digest());
}
