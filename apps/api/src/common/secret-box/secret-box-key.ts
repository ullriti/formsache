/**
 * The key material behind `SecretBoxService` — and the only place that turns
 * the configured string into bytes.
 *
 * It is a module of its own, separate from the cipher, so the check can run at
 * **startup**: `loadEnv()` in `src/config/env.ts` calls it before Nest is even
 * created. A key that is missing, truncated or mistyped has to stop the
 * deployment there. The alternative — noticing at the first `seal()` — means a
 * server that looks healthy until somebody switches on password protection,
 * and by then the only ways out are a 500 or, far worse, a fallback that
 * writes the access word in clear text. That fallback does not exist, on
 * purpose: it is the failure nobody would notice.
 */

/**
 * AES-256 takes a 256-bit key. Exactly 32 bytes, no other length is accepted —
 * Node would happily reject a wrong length itself, but only once something is
 * being encrypted, which is hours too late (see above).
 */
export const SECRET_BOX_KEY_BYTES = 32;

/**
 * DI token for the **decoded** key.
 *
 * A symbol, like `API_ENV`, so it cannot collide with a string token. It is
 * provided by `SecretBoxModule` and deliberately **not** exported from it:
 * outside this folder nothing has any business holding raw key bytes, and a
 * token that cannot be injected cannot end up in a log line by accident.
 */
export const SECRET_BOX_KEY = Symbol('SECRET_BOX_KEY');

/**
 * base64 of 32 bytes is 44 characters with padding or 43 without. Both the
 * standard (`+/`) and the URL-safe (`-_`) alphabet are accepted, because
 * `openssl rand -base64 32` and `node -e "…base64url"` are both plausible ways
 * to produce one and neither is wrong.
 */
const KEY_PATTERN = /^[A-Za-z0-9+/_-]{43}=?$/;

/** Written into every failure below, because "invalid" without a fix is noise. */
const GENERATE_HINT = 'generate one with: openssl rand -base64 32';

/**
 * Decodes the configured key.
 *
 * **The thrown message never contains the configured value.** It is the secret
 * itself, and a startup error is the single most likely thing in the whole
 * application to be pasted into a chat, an issue or a log aggregator.
 */
export function decodeSecretBoxKey(configured: string): Buffer {
  const trimmed = configured.trim();
  if (!KEY_PATTERN.test(trimmed)) {
    throw new Error(
      `SECRET_BOX_KEY must be ${String(SECRET_BOX_KEY_BYTES)} bytes in base64 ` +
        `(43 or 44 characters) — ${GENERATE_HINT}`,
    );
  }
  const key = Buffer.from(trimmed, 'base64');
  // Belt and braces: the pattern fixes the character count, this fixes the
  // byte count. They can only disagree if the pattern is ever loosened, and
  // then this line is the one that still holds.
  if (key.length !== SECRET_BOX_KEY_BYTES) {
    throw new Error(
      `SECRET_BOX_KEY decodes to ${String(key.length)} bytes, expected ` +
        `${String(SECRET_BOX_KEY_BYTES)} — ${GENERATE_HINT}`,
    );
  }
  return key;
}
