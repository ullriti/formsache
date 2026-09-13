import { describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH } from './dummy-password-hash';
import { hashPassword, verifyPassword } from './password';

/**
 * The dummy hash carries the whole "unknown e-mail costs the same as a wrong
 * password" promise. Two ways it could quietly stop working, both checked
 * here — a service test would not notice either, because the login answers 401
 * in every one of these cases.
 */
describe('DUMMY_PASSWORD_HASH', () => {
  it('verifies false for every input, so it can never authenticate anyone', async () => {
    for (const candidate of ['', 'password', 'change-me-locally', 'admin']) {
      await expect(
        verifyPassword(DUMMY_PASSWORD_HASH, candidate),
      ).resolves.toBe(false);
    }
  });

  /**
   * The parameters are what cost the time. If `hashPassword` were raised to
   * 64 MiB and this constant stayed at 19, verifying against the dummy would
   * become the cheap path again — and the unknown e-mail would be measurable
   * once more. Compared against a freshly produced hash rather than against a
   * literal, so the two cannot drift apart.
   */
  it('uses the very parameters hashPassword produces today', async () => {
    const fresh = await hashPassword('irrelevant');
    const parametersOf = (phc: string): string =>
      phc.split('$').slice(0, 4).join('$');

    expect(parametersOf(DUMMY_PASSWORD_HASH)).toBe(parametersOf(fresh));
    expect(parametersOf(DUMMY_PASSWORD_HASH)).toBe(
      '$argon2id$v=19$m=19456,t=2,p=1',
    );
  });
});
