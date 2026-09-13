/**
 * Which address a rate limit counts — **and how much of it** (`CONTRIBUTING.md`).
 *
 * Every limiter in this application keys on the caller's address: the login
 * (`auth/login-rate-limit.ts`), the public read and submit routes, and the
 * password gate of the requirement. Until this module existed, each of them
 * keyed on the address *verbatim*, and the arithmetic those files write down —
 * „14 400 Versuche am Tag von einer Adresse" — silently assumed IPv4.
 *
 * ## Why the whole IPv6 address is not an identity
 *
 * IPv4 hands out one address per host, so „per address" is a real limit and a
 * shared NAT is the only way to get more (which is why the numbers are generous
 * — `login-rate-limit.ts`, point 2). IPv6 hands **a whole /64 to a single
 * connection** as a matter of routine: every residential line, every VPS, every
 * mobile subscriber. That is 2^64 source addresses, from one contract, at no
 * cost. Keyed on the full address, a limit of ten a minute is a limit of ten a
 * minute *per attempt*, i.e. none at all — the ceiling becomes throughput, and
 * the password gate's „eine Wortliste ist keine Suche, die fertig wird" stops
 * being true.
 *
 * So the address dimension is the **prefix of a /64**: the smallest block an operator
 * assigns as a unit, and therefore the smallest thing that behaves like „one
 * caller". Coarser (a /48, a /32) would start putting unrelated customers of one
 * ISP into one bucket; finer is what this fixes.
 *
 * **This is still per address.** It is not, and must not become, a form-wide or
 * installation-wide counter — bullet 5 of the requirement forbids that lever, and
 * for good reason: a cap a stranger's traffic can reach is a cap a stranger can
 * use to switch off an organisation's registration. Narrowing *which* address is counted
 * touches only the person doing the counting-out.
 *
 * ## What is not changed here
 *
 * **Which address is believed** stays exactly as it was: `req.ips` when
 * `TRUST_PROXY_HOPS` says a proxy may report it, `req.ip` otherwise. Believing
 * `X-Forwarded-For` unconditionally would hand every caller a fresh bucket per
 * request, which is the same failure this file exists to close, one layer up.
 */

/**
 * How many 16-bit groups of an IPv6 address make up the block an operator hands
 * out as one unit. Four groups = /64.
 */
const IPV6_PREFIX_GROUPS = 4;

/**
 * An IPv4 address written in IPv6 form. Node produces `::ffff:198.51.100.7` for
 * an IPv4 peer on a dual-stack socket, and that is one host — not a /64 worth of
 * them, so it must not be truncated.
 */
const IPV4_MAPPED = /^::(?:ffff:(?:0{1,4}:)?)?(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** A single group of an IPv6 address, as written. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/**
 * The eight groups of an IPv6 address, `::` expanded — or `null` if the string
 * is not one.
 *
 * An embedded IPv4 tail (`2001:db8::198.51.100.7`) occupies two groups and is
 * left as it was written; it can only ever sit at the end, so it never reaches
 * the prefix this function exists to produce.
 */
function ipv6Groups(address: string): readonly string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (part: string): string[] =>
    part === '' ? [] : part.split(':');
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];

  const written = [...head, ...tail];
  if (
    written.some(
      (group, index) =>
        !IPV6_GROUP.test(group) &&
        // …unless it is the embedded IPv4 tail, which is allowed in last place.
        !(
          index === written.length - 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(group)
        ),
    )
  ) {
    return null;
  }

  const embeddedIpv4 = written.at(-1)?.includes('.') === true ? 1 : 0;
  const occupied = written.length + embeddedIpv4;

  if (halves.length === 1) {
    return occupied === 8 ? head : null;
  }
  if (occupied >= 8) {
    return null;
  }
  return [...head, ...Array<string>(8 - occupied).fill('0'), ...tail];
}

/**
 * The key a rate limit counts under — an IPv4 address as it stands, an IPv6
 * address reduced to its /64.
 *
 * An address this cannot read is returned unchanged rather than collapsed into
 * a shared bucket: a value we do not understand must not be able to put
 * unrelated callers into one counter, and the only thing that produces one is a
 * platform we have not met.
 */
export function addressKey(raw: string): string {
  const address = raw
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('%')[0];
  if (address === undefined || address === '' || !address.includes(':')) {
    return raw;
  }

  const mapped = IPV4_MAPPED.exec(address);
  if (mapped?.[1] !== undefined) {
    return mapped[1];
  }

  const groups = ipv6Groups(address);
  if (groups === null) {
    return raw;
  }
  return `${groups
    .slice(0, IPV6_PREFIX_GROUPS)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * The caller of a request, as every limiter in this application counts them.
 *
 * The `req.ips` / `req.ip` half mirrors the throttler library's own tracker, so
 * `TRUST_PROXY_HOPS` decides here exactly as it does everywhere else; the
 * {@link addressKey} half is what makes „per address" mean the same thing on
 * both internet protocols.
 */
export function clientAddress(req: Record<string, unknown>): string {
  const forwarded = req.ips;
  if (Array.isArray(forwarded)) {
    const [first] = forwarded as unknown[];
    if (typeof first === 'string' && first.length > 0) {
      return addressKey(first);
    }
  }
  return typeof req.ip === 'string' ? addressKey(req.ip) : 'unknown';
}
