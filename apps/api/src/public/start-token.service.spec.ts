import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from '../common/secret-box/secret-box-key';
import { SigningService } from '../common/secret-box/signing.service';
import { StartTokenService } from './start-token.service';

/**
 * The requirement — the start token, from the inside.
 *
 * The enforcement itself (how long is „too long", what a refusal looks like,
 * that no row is written) is an integration concern and lives in
 * `test/public/submission-gate.spec.ts`. What is checked here is the one thing
 * the requirement phrases as a property of the token: **the signature is
 * verified, the content is not believed.**
 */
function newService(): StartTokenService {
  return new StartTokenService(
    new SigningService(randomBytes(SECRET_BOX_KEY_BYTES)),
  );
}

const SLUG = 'AbCdEf123456789012';
const OTHER_SLUG = 'ZyXwVu987654321098';

describe('StartTokenService', () => {
  it('reads back the instant it minted a token with', () => {
    const service = newService();
    const issuedAt = new Date('2026-07-28T09:15:00.000Z');

    expect(service.issuedAt(service.issue(SLUG, issuedAt), SLUG)).toStrictEqual(
      issuedAt,
    );
  });

  it('mints a different token for a different instant', () => {
    const service = newService();

    expect(service.issue(SLUG, new Date(1_000))).not.toBe(
      service.issue(SLUG, new Date(2_000)),
    );
  });

  /**
   * The binding to the form. Without it a token minted on any open form would
   * be a permanent pass for every other one — including forms whose time limit
   * is the only thing standing between them and an unhurried afternoon.
   */
  it('refuses a token minted for another form', () => {
    const service = newService();

    expect(
      service.issuedAt(service.issue(OTHER_SLUG, new Date()), SLUG),
    ).toBeNull();
  });

  it('refuses a token minted under another key', () => {
    const foreign = newService().issue(SLUG, new Date());

    expect(newService().issuedAt(foreign, SLUG)).toBeNull();
  });

  /**
   * **The rewritten instant** — the case the requirement means by „der Inhalt
   * wird nicht geglaubt". The payload alone says the attempt started a moment
   * ago; only the signature says otherwise.
   */
  it('refuses a token whose instant was moved after signing', () => {
    const service = newService();
    const stale = service.issue(SLUG, new Date(Date.now() - 3_600_000));
    const [version = '', , signature = ''] = stale.split('.');

    const rewritten = `${version}.${Date.now().toString(36)}.${signature}`;

    expect(service.issuedAt(rewritten, SLUG)).toBeNull();
  });

  it('refuses a token with one character of its signature changed', () => {
    const service = newService();
    const token = service.issue(SLUG, new Date());
    const [version = '', instant = '', signature = ''] = token.split('.');
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;

    expect(
      service.issuedAt(`${version}.${instant}.${flipped}`, SLUG),
    ).toBeNull();
  });

  it.each([
    ['an empty string', ''],
    ['a token with too few parts', 's1.mfa1b2c3'],
    ['a token with too many parts', 's1.mfa1b2c3.sig.extra'],
    ['an unknown format version', 's9.mfa1b2c3.sig'],
    ['a hand-built token', 's1.mfa1b2c3.ZGFzLWlzdC1rZWluZS1zaWduYXR1cg'],
    ['something that is not a token at all', 'guten tag'],
  ])('refuses %s', (_name, token) => {
    expect(newService().issuedAt(token, SLUG)).toBeNull();
  });

  /**
   * The branch **after** the MAC: an instant that is signed and still not one
   * of ours.
   *
   * It cannot be reached from outside — the signature is checked first — so the
   * token here is signed with the very key the service holds, which means this
   * test has to know the message format. That is deliberate, and it is the only
   * place that format is known outside `start-token.service.ts`: the point is
   * precisely to get *past* the signature and watch the payload be refused
   * anyway.
   *
   * `0mfa1b2c3` is a plausible edit — a leading zero — that base 36 parses
   * happily and that does not round-trip. Without the round-trip check the
   * token would be accepted carrying a silently different instant.
   */
  it('refuses a signed instant that does not round-trip', () => {
    const signing = new SigningService(randomBytes(SECRET_BOX_KEY_BYTES));
    const service = new StartTokenService(signing);
    const sign = (body: string): string =>
      `${body}.${signing.sign('public.start-token', `${body}\u0000${SLUG}`)}`;

    // The premise: a token built this way really is accepted — otherwise the
    // assertion below would prove nothing about the payload check.
    expect(service.issuedAt(sign('s1.mfa1b2c3'), SLUG)).not.toBeNull();

    expect(service.issuedAt(sign('s1.0mfa1b2c3'), SLUG)).toBeNull();
  });

  /**
   * The reload gap, at the level it is created: two reads are two attempts.
   * The user-visible consequence is stated where the editor sets the switch
   * (`SettingsSectionFields.tsx`), and it is decided —
   * this is only the mechanism behind it.
   */
  it('mints a fresh token for every read', () => {
    const service = newService();

    expect(service.issue(SLUG, new Date(1_000))).not.toBe(
      service.issue(SLUG, new Date(1_001)),
    );
  });

  /** The token carries no identifier of the form it belongs to. */
  it('does not carry the address it is bound to', () => {
    expect(newService().issue(SLUG, new Date())).not.toContain(SLUG);
  });
});
