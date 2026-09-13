import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACCESS_ATTEMPT_LIMITS,
  accessAttemptTracker,
  resetAccessAttemptAllowances,
} from './access-attempt-tracker';

/**
 * The requirement, bullets 4 and 5 — the **key** the password gate counts by.
 *
 * The behaviour is proved end to end in `test/public/password-gate.spec.ts`,
 * where two addresses walk up to the same form. This file is the cheap,
 * deterministic half: it states the three properties of the key itself, so a
 * change to it fails here in milliseconds rather than in a suite that has to
 * spend ten HTTP requests to notice.
 */

function req(
  ip: string,
  slug?: string,
  ips: string[] = [],
): Record<string, unknown> {
  return { ip, ips, params: slug === undefined ? {} : { slug } };
}

describe('accessAttemptTracker', () => {
  // The per-address bookkeeping below is module state, so each test starts from
  // nothing rather than from whatever the previous one allocated.
  beforeEach(() => {
    resetAccessAttemptAllowances();
  });

  /**
   * **Bullet 5, at its source.** Two callers on one form must never share a
   * bucket — otherwise a stranger's wrong guesses close the Jahrestagung
   * registration of a whole organisation, which is the lever this rule forbids.
   */
  it('separates two addresses on the same form', () => {
    expect(accessAttemptTracker(req('198.51.100.1', 'AbCdEf'))).not.toBe(
      accessAttemptTracker(req('198.51.100.2', 'AbCdEf')),
    );
  });

  /**
   * **Bullet 4, the second dimension.** One caller's two forms are two gates:
   * fumbling the word of the Bestandsmeldung must not spend the attempts
   * for the Jahrestagung registration.
   */
  it('separates two forms for the same address', () => {
    expect(accessAttemptTracker(req('198.51.100.1', 'AbCdEf'))).not.toBe(
      accessAttemptTracker(req('198.51.100.1', 'GhIjKl')),
    );
  });

  it('gives the same caller on the same form the same bucket', () => {
    expect(accessAttemptTracker(req('198.51.100.1', 'AbCdEf'))).toBe(
      accessAttemptTracker(req('198.51.100.1', 'AbCdEf')),
    );
  });

  /**
   * `TRUST_PROXY_HOPS` decides which address is counted, and Express expresses
   * that decision through `req.ips`: it is populated only for hops the
   * application was told to trust. Believing the header regardless would hand
   * every caller a fresh bucket per request and turn the limit off.
   */
  it('counts the forwarded address only when Express filled it in', () => {
    expect(
      accessAttemptTracker(req('10.0.0.1', 'AbCdEf', ['203.0.113.9'])),
    ).toContain('203.0.113.9');
    expect(accessAttemptTracker(req('10.0.0.1', 'AbCdEf'))).toContain(
      '10.0.0.1',
    );
  });

  /**
   * **An address nobody could have been given shares one bucket.**
   *
   * The slug arrives from the URL, so without this every invented address would
   * mint a record of its own in the throttler's in-memory store — a rate
   * limiter that can be made to allocate has become the attack it was meant to
   * bound. Real addresses still get their own bucket, which is what the tests
   * above check.
   */
  it.each([
    ['a NUL byte', 'AbCd\u0000Ef'],
    ['a dot', 'AbCd.Ef'],
    ['a slug past the length bound', 'x'.repeat(400)],
    ['no slug at all', undefined],
  ])('collapses %s into one shared bucket', (_name, slug) => {
    // One fixed reference, itself outside the alphabet: the claim is that all
    // four land in the *same* bucket, not merely that each is not a real one.
    expect(accessAttemptTracker(req('198.51.100.1', slug))).toBe(
      accessAttemptTracker(req('198.51.100.1', '!!unmöglich!!')),
    );
  });

  /**
   * …and that shared bucket is **not** the bucket of some real form, which
   * would be the amusing way of reintroducing the form-wide lock: guess at an
   * address that collapses, and the form it collapses onto is closed.
   */
  it('does not collapse onto a real address', () => {
    expect(accessAttemptTracker(req('198.51.100.1', 'AbCd.Ef'))).not.toBe(
      accessAttemptTracker(req('198.51.100.1', 'AbCdEf')),
    );
  });

  /**
   * **What the promise above did not cover.**
   *
   * „A rate limiter that can be made to allocate is a rate limiter that has
   * become the attack" was written for *malformed* slugs, and only those were
   * collapsed. `isPublicSlug` checks alphabet and length, **not existence** — so
   * a caller sending twenty-two invented base64url characters got a bucket of
   * their own every time, was never throttled (the counter is keyed per slug and
   * they never repeat one), and grew the throttler's in-memory store one record
   * and one expiry timer per request, at whatever rate the network carries.
   *
   * The ceiling is per address, which is what keeps it from becoming the lever
   * bullet 5 forbids — the second test below is that half.
   */
  describe('the ceiling on what one address may allocate', () => {
    /** Well-formed, and no form ever had it. */
    const invented = (n: number): string =>
      `Zz${String(n).padStart(20, '0')}`.slice(0, 22);

    const formPart = (key: string): string =>
      key.split(ACCESS_ATTEMPT_LIMITS.keySeparator)[1] ?? '';

    it('stops minting buckets once an address has had its share', () => {
      const { formsPerAddress, overflowForm } = ACCESS_ATTEMPT_LIMITS;
      const buckets = new Set<string>();

      for (let n = 0; n < formsPerAddress * 20; n += 1) {
        buckets.add(
          formPart(accessAttemptTracker(req('198.51.100.1', invented(n)))),
        );
      }

      // The allowance, plus the one bucket every attempt beyond it shares.
      expect(buckets.size).toBe(formsPerAddress + 1);
      expect(buckets.has(overflowForm)).toBe(true);
    });

    /**
     * **Bullet 5 again, one level down.** A ceiling somebody else can spend for
     * you is the form-wide lock with an extra step.
     */
    it('leaves every other address a full allowance of its own', () => {
      const { formsPerAddress, overflowForm } = ACCESS_ATTEMPT_LIMITS;
      for (let n = 0; n < formsPerAddress * 5; n += 1) {
        accessAttemptTracker(req('198.51.100.1', invented(n)));
      }

      expect(
        formPart(accessAttemptTracker(req('198.51.100.2', invented(3)))),
      ).toBe(invented(3));
      expect(
        formPart(accessAttemptTracker(req('198.51.100.2', invented(9_999)))),
      ).not.toBe(overflowForm);
    });

    /**
     * A form the address already counts against keeps its own bucket. Without
     * it, somebody mistyping the word of a *real* form a few times could push
     * themselves into the shared bucket and meet a limit they never spent.
     */
    it('never demotes a form the address already had', () => {
      const { formsPerAddress } = ACCESS_ATTEMPT_LIMITS;
      const real = invented(0);

      expect(formPart(accessAttemptTracker(req('198.51.100.1', real)))).toBe(
        real,
      );
      for (let n = 1; n < formsPerAddress * 3; n += 1) {
        accessAttemptTracker(req('198.51.100.1', invented(n)));
      }

      expect(formPart(accessAttemptTracker(req('198.51.100.1', real)))).toBe(
        real,
      );
    });

    /**
     * The bookkeeping is keyed by the **address key**, so an attacker on one
     * IPv6 line is one caller with one allowance rather than 2^64 of them
     * (`common/client-address.ts`). Without that, the ceiling would be as free
     * to walk around as the rate limit itself.
     */
    it('counts a whole IPv6 /64 as the single caller it is', () => {
      const { formsPerAddress, overflowForm } = ACCESS_ATTEMPT_LIMITS;

      for (let n = 0; n < formsPerAddress; n += 1) {
        accessAttemptTracker(
          req(`2001:db8:1234:5678::${n.toString(16)}`, invented(n)),
        );
      }

      expect(
        formPart(
          accessAttemptTracker(
            req('2001:db8:1234:5678::ffff', invented(9_999)),
          ),
        ),
      ).toBe(overflowForm);
      // …and the neighbouring /64 is a different caller, untouched by all of it.
      expect(
        formPart(
          accessAttemptTracker(req('2001:db8:1234:5679::1', invented(9_999))),
        ),
      ).toBe(invented(9_999));
    });
  });
});
