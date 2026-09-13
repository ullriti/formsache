import { describe, expect, it } from 'vitest';

import { addressKey, clientAddress } from './client-address';

/**
 * **Which address a rate limit counts** (`CONTRIBUTING.md`).
 *
 * The arithmetic every limiter in this application is justified with — „14 400
 * Versuche am Tag von einer Adresse" — holds only if „eine Adresse" is a bound
 * on the caller. On IPv4 it is. On IPv6 a single line is handed a /64, so the
 * unaggregated address is 2^64 buckets from one contract and the limit is no
 * limit at all.
 *
 * The tests below are therefore about one property: **the same caller keys the
 * same, a different caller keys differently, and „the same caller" means a /64
 * on IPv6 and a host on IPv4.**
 */
describe('addressKey (IPv6 aggregation)', () => {
  it('leaves an IPv4 address exactly as it is', () => {
    expect(addressKey('198.51.100.7')).toBe('198.51.100.7');
    expect(addressKey('198.51.100.8')).not.toBe(addressKey('198.51.100.7'));
  });

  /**
   * Node hands an IPv4 peer on a dual-stack socket to Express as
   * `::ffff:198.51.100.7`. That is **one host**, not a /64 of them, and
   * truncating it would put the whole documentation range into one bucket.
   */
  it.each([
    ['::ffff:198.51.100.7'],
    ['::FFFF:198.51.100.7'],
    ['::ffff:0:198.51.100.7'],
    ['::198.51.100.7'],
  ])('reads %s as the IPv4 address it is', (mapped) => {
    expect(addressKey(mapped)).toBe('198.51.100.7');
  });

  /**
   * **The finding itself.** Two addresses out of one /64 — which is what one
   * subscriber holds — have to land in one bucket, or the limit is per attempt.
   */
  it('collapses a whole /64 into one key', () => {
    const keys = [
      '2001:db8:1234:5678::1',
      '2001:db8:1234:5678::2',
      '2001:db8:1234:5678:aaaa:bbbb:cccc:dddd',
      '2001:0db8:1234:5678:0000:0000:0000:0001',
    ].map(addressKey);

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('2001:db8:1234:5678::/64');
  });

  /**
   * …and no further than that. A /64 is the smallest block an operator assigns
   * as a unit; aggregating a /48 or a /32 would start counting an ISP's
   * unrelated customers together, which is the failure in the other direction.
   */
  it('keeps two different /64s apart', () => {
    expect(addressKey('2001:db8:1234:5678::1')).not.toBe(
      addressKey('2001:db8:1234:5679::1'),
    );
    expect(addressKey('2001:db8:1234:5678::1')).not.toBe(
      addressKey('2001:db9:1234:5678::1'),
    );
  });

  it('handles the compressed forms an address can be written in', () => {
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    // A zone id and brackets belong to the notation, not to the address.
    expect(addressKey('[2001:db8:1234:5678::1]')).toBe(
      '2001:db8:1234:5678::/64',
    );
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  /**
   * **An address this cannot read is returned whole**, never collapsed into a
   * shared bucket: a value we do not understand must not be able to put
   * unrelated callers into one counter.
   */
  it.each([['unknown'], ['2001:db8::1::2'], ['nonsense'], ['']])(
    'passes %s through untouched',
    (raw) => {
      expect(addressKey(raw)).toBe(raw);
    },
  );
});

describe('clientAddress (which address is believed)', () => {
  /**
   * Unchanged from the tracker this was lifted out of, and it is the half that
   * must not move: `req.ips` is populated by Express **only** for the hops
   * `TRUST_PROXY_HOPS` says may report a caller. Believing `X-Forwarded-For`
   * otherwise would hand every caller a fresh bucket per request.
   */
  it('prefers the trusted forwarded address', () => {
    expect(
      clientAddress({ ips: ['2001:db8:1234:5678::9'], ip: '10.0.0.1' }),
    ).toBe('2001:db8:1234:5678::/64');
  });

  it('falls back to the peer when nothing is trusted', () => {
    expect(clientAddress({ ips: [], ip: '198.51.100.7' })).toBe('198.51.100.7');
  });

  it('answers something rather than nothing for a request with no address', () => {
    expect(clientAddress({})).toBe('unknown');
  });
});
