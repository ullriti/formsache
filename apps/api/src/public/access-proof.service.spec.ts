import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from '../common/secret-box/secret-box-key';
import { SigningService } from '../common/secret-box/signing.service';
import { AccessProofService } from './access-proof.service';

/**
 * The requirement — the access proof, from the inside.
 *
 * The gate itself (what a refusal looks like, that no row is written, that the
 * word never reaches a URL) is an integration concern and lives in
 * `test/public/password-gate.spec.ts`. What is checked here is the sentence this
 * design ends on: the proof is **signed, form-bound and short-lived**.
 */
function newService(): AccessProofService {
  return new AccessProofService(
    new SigningService(randomBytes(SECRET_BOX_KEY_BYTES)),
  );
}

const SLUG = 'AbCdEf123456789012';
const OTHER_SLUG = 'ZyXwVu987654321098';
const NOW = new Date('2026-07-28T09:15:00.000Z');
const MINUTE = 60_000;

function at(minutesAfterIssue: number): Date {
  return new Date(NOW.getTime() + minutesAfterIssue * MINUTE);
}

describe('AccessProofService', () => {
  it('accepts the proof it just minted', () => {
    const service = newService();

    expect(service.holds(service.issue(SLUG, NOW), SLUG, NOW)).toBe(true);
  });

  it('accepts nothing at all', () => {
    expect(newService().holds(undefined, SLUG, NOW)).toBe(false);
  });

  /**
   * **Form-bound.** Without it, one word learned anywhere would be a pass for
   * every protected form in the installation — including forms of other Organisationen,
   * whose words the holder never saw.
   */
  it('refuses a proof minted for another form', () => {
    const service = newService();

    expect(service.holds(service.issue(OTHER_SLUG, NOW), SLUG, NOW)).toBe(
      false,
    );
  });

  /**
   * **Signed with this installation's key.** A proof from another deployment —
   * a staging system, a second organisation's instance — is not one of ours.
   */
  it('refuses a proof minted under another key', () => {
    const foreign = newService().issue(SLUG, NOW);

    expect(newService().holds(foreign, SLUG, NOW)).toBe(false);
  });

  /**
   * **The signature is verified before the instant is believed.** These are the
   * strings somebody writes by hand when they have worked out the format from a
   * proof of their own — a fresh timestamp, an invented signature.
   */
  it.each([
    ['no separators', 'unsinn'],
    ['too few parts', 'p1.abcdefgh'],
    ['too many parts', 'p1.abcdefgh.sig.extra'],
    ['an empty signature', 'p1.abcdefgh.'],
    ['an unknown version', 'p9.abcdefgh.signature'],
    ['an empty string', ''],
  ])('refuses a proof with %s', (_name, forged) => {
    expect(newService().holds(forged, SLUG, NOW)).toBe(false);
  });

  /**
   * A **genuine** proof whose instant was edited afterwards — everything about
   * it is ours except the one number somebody wanted to change.
   *
   * Rewritten *backwards* on purpose, so it would have to be accepted as a
   * fresh proof if the content were trusted; forward-dating is covered by the
   * skew bound below.
   */
  it('refuses a genuine proof whose instant was rewritten', () => {
    const service = newService();
    const parts = service.issue(SLUG, at(-120)).split('.');
    const rewritten = [parts[0], NOW.getTime().toString(36), parts[2]].join(
      '.',
    );

    expect(service.holds(rewritten, SLUG, NOW)).toBe(false);
  });

  /**
   * **Short-lived**, and the boundary is asserted from both sides — a test that
   * only checked „two hours later is refused" would pass on a proof that lasted
   * ninety minutes, which is not what the file says.
   */
  it('opens the form for an hour and not for an hour and one minute', () => {
    const service = newService();
    const proof = service.issue(SLUG, NOW);

    expect(service.holds(proof, SLUG, at(59))).toBe(true);
    expect(service.holds(proof, SLUG, at(60))).toBe(true);
    expect(service.holds(proof, SLUG, at(61))).toBe(false);
  });

  /**
   * A little from the future is tolerated, a lot is not — the same shape the
   * start token has, and for the same reason: a proof can only carry this
   * server's own signature, so the only way to hold one from the future is a
   * clock that moved. „Negative age always passes" would mean two replicas with
   * drifted clocks stop expiring proofs entirely.
   */
  it('tolerates a small clock skew and refuses a large one', () => {
    const service = newService();

    expect(service.holds(service.issue(SLUG, at(4)), SLUG, NOW)).toBe(true);
    expect(service.holds(service.issue(SLUG, at(6)), SLUG, NOW)).toBe(false);
  });

  /**
   * The proof and the start token are two artefacts under **two** subkeys. A
   * shared key would mean a token minted for one purpose verifies as the other
   * — and the start token is handed to every caller of the read route, without
   * any gate in front of it.
   */
  it('does not accept a start token in its place', () => {
    const signing = new SigningService(randomBytes(SECRET_BOX_KEY_BYTES));
    const service = new AccessProofService(signing);
    const body = `p1.${NOW.getTime().toString(36)}`;
    const underTheOtherPurpose = signing.sign(
      'public.start-token',
      `${body}\u0000${SLUG}`,
    );

    expect(service.holds(`${body}.${underTheOtherPurpose}`, SLUG, NOW)).toBe(
      false,
    );
  });
});
