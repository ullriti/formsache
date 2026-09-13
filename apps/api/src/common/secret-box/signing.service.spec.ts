import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from './secret-box-key';
import { SecretBoxService } from './secret-box.service';
import { SigningService } from './signing.service';

/**
 * The requirement — the signer behind the start token.
 *
 * Keys are minted per test and never written down: no key material belongs in
 * the repository, and that includes its tests (proof 2).
 */
function newKey(): Buffer {
  return randomBytes(SECRET_BOX_KEY_BYTES);
}

const PURPOSE = 'public.start-token';

describe('SigningService', () => {
  it('accepts its own signature', () => {
    const signing = new SigningService(newKey());
    const message = 's1.mfa1b2c3\u0000AbCdEf123456';

    expect(
      signing.verify(PURPOSE, message, signing.sign(PURPOSE, message)),
    ).toBe(true);
  });

  it('refuses a signature for a different message', () => {
    const signing = new SigningService(newKey());

    expect(
      signing.verify(PURPOSE, 'anderes', signing.sign(PURPOSE, 'eines')),
    ).toBe(false);
  });

  it('refuses a signature made under a different key', () => {
    const message = 's1.mfa1b2c3';
    const signature = new SigningService(newKey()).sign(PURPOSE, message);

    expect(
      new SigningService(newKey()).verify(PURPOSE, message, signature),
    ).toBe(false);
  });

  it.each([
    ['a value of the wrong length', 'zu-kurz'],
    ['an empty value', ''],
    ['a value that is not base64url at all', '???'],
  ])('refuses %s without throwing', (_name, signature) => {
    expect(
      new SigningService(newKey()).verify(PURPOSE, 'egal', signature),
    ).toBe(false);
  });

  it('produces the same signature for the same key and message', () => {
    const key = newKey();
    const message = 's1.mfa1b2c3\u0000AbCdEf123456';

    expect(new SigningService(key).sign(PURPOSE, message)).toBe(
      new SigningService(key).sign(PURPOSE, message),
    );
  });

  /**
   * **The signing key is not the encryption key.**
   *
   * The whole justification for hanging this off `SECRET_BOX_KEY` instead of a
   * variable of its own is that the derivation is one-way and
   * purpose-separated. Asserted rather than argued: an HMAC taken with the raw
   * key must not match the one this service produces, or key separation is a
   * comment.
   */
  it('never signs with the raw key it was given', () => {
    const key = newKey();
    const message = 's1.mfa1b2c3';

    expect(new SigningService(key).sign(PURPOSE, message)).not.toBe(
      createHmac('sha256', key).update(message, 'utf8').digest('base64url'),
    );
  });

  /**
   * The other half of the same claim, from the outside: two objects built on
   * the same key serve two different roles, and neither can stand in for the
   * other. `SecretBoxService` seals with AES-GCM under the raw key; a value it
   * produced is not something the signer accepts, and vice versa.
   */
  it('shares a key with the cipher without sharing an output', () => {
    const key = newKey();
    const sealed = new SecretBoxService(key).seal('Zugangswort', 'ctx');

    expect(sealed).not.toContain(
      new SigningService(key).sign(PURPOSE, 'Zugangswort'),
    );
  });

  /**
   * Nothing that prints this object prints key material — the two hooks are
   * needed separately because different printers use different ones (the same
   * reasoning as `SecretBoxService`).
   */
  it('redacts its subkeys in both printers', () => {
    const signing = new SigningService(newKey());

    expect(JSON.stringify(signing)).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
    expect(JSON.stringify(signing)).toContain('[redacted]');
    expect(inspect(signing)).toBe('SigningService { subkeys: [redacted] }');
  });

  /**
   * That every *declared* purpose gets a subkey is a **compile-time** promise
   * since `SIGNING_PURPOSES` is derived from `satisfies Record<SigningPurpose,
   * true>` — this test cannot make it, and it used to pretend otherwise: it
   * calls the one purpose it knows by name, so a second member added to the
   * union and forgotten in the list left it green and produced a 500 on the
   * public route. The proof is `pnpm typecheck`; what remains here is that the
   * constructor really fills the map for the purpose it was given.
   */
  it('signs the declared purpose without falling into the empty-map branch', () => {
    const signing = new SigningService(newKey());

    expect(() => signing.sign(PURPOSE, 'x')).not.toThrow();
  });
});
