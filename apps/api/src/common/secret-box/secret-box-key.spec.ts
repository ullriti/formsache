import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SECRET_BOX_KEY_BYTES, decodeSecretBoxKey } from './secret-box-key';

/**
 * Every key in this file is minted at runtime. No key material belongs in the
 * repository — a constant here would be as copy-pasteable into a deployment as
 * a real one (proof 2).
 */
function newKey(encoding: 'base64' | 'base64url' = 'base64'): string {
  return randomBytes(SECRET_BOX_KEY_BYTES).toString(encoding);
}

describe('decodeSecretBoxKey', () => {
  it('accepts a freshly generated key in either base64 alphabet', () => {
    expect(decodeSecretBoxKey(newKey())).toHaveLength(SECRET_BOX_KEY_BYTES);
    expect(decodeSecretBoxKey(newKey('base64url'))).toHaveLength(
      SECRET_BOX_KEY_BYTES,
    );
  });

  // Editors and `.env` files add these; a key that fails only because of a
  // trailing newline would be diagnosed as "wrong key" for an afternoon.
  it('tolerates surrounding whitespace', () => {
    const key = newKey();
    expect(decodeSecretBoxKey(`  ${key}\n`).toString('base64')).toBe(key);
  });

  it('refuses a missing key rather than inventing one', () => {
    expect(() => decodeSecretBoxKey('')).toThrow(/SECRET_BOX_KEY/);
    expect(() => decodeSecretBoxKey('   ')).toThrow(/SECRET_BOX_KEY/);
  });

  /**
   * The failure this exists for: a key that *looks* configured. 16 bytes is
   * what `openssl rand -base64 16` produces, and AES-256 would only complain
   * about it at the first `seal()` — long after the deployment reported
   * success.
   */
  it('refuses a key of the wrong length', () => {
    expect(() =>
      decodeSecretBoxKey(randomBytes(16).toString('base64')),
    ).toThrow(/32 bytes/);
    expect(() =>
      decodeSecretBoxKey(randomBytes(64).toString('base64')),
    ).toThrow(/32 bytes/);
  });

  it('refuses something that is not base64 at all', () => {
    expect(() => decodeSecretBoxKey('not a key')).toThrow(/SECRET_BOX_KEY/);
    expect(() => decodeSecretBoxKey('*'.repeat(43))).toThrow(/SECRET_BOX_KEY/);
  });

  /**
   * A startup error is the single most likely thing in this application to be
   * pasted into a chat, an issue or a log aggregator. It must therefore name
   * the variable and the fix — and **never** the value, which is the secret.
   */
  it('never repeats the configured value in the failure message', () => {
    const nearlyRight = randomBytes(31).toString('base64');
    let message = '';
    try {
      decodeSecretBoxKey(nearlyRight);
    } catch (error) {
      message =
        error instanceof Error ? `${error.message}${error.stack ?? ''}` : '';
    }
    expect(message).toContain('SECRET_BOX_KEY');
    expect(message).toContain('openssl rand -base64 32');
    expect(message).not.toContain(nearlyRight);
  });
});
