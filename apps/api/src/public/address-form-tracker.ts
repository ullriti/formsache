import { clientAddress } from '../common/client-address';
import { isPublicSlug } from './public-slug';

/**
 * **Address ⊕ form**, as a counter key — the shape of the requirement
 * (bullets 4 and 5), generalised so a second route can have one (ADR-0014
 * no. 8).
 *
 * The password gate had this to itself until file uploads needed
 * the same key. The ADR says „der Tracker wird **verallgemeinert, nicht
 * kopiert**", and the reason is not tidiness: what makes this key safe is an
 * argument — the per-address ceiling, the shared overflow bucket, the collapse
 * of unusable addresses — and a second copy of that argument is a second thing
 * that has to stay true. Here it is one, and both routes inherit it.
 *
 * ## Why both dimensions
 *
 * **Per address**, because that is the only handle a public route has on „who".
 * Which part of an address counts is {@link clientAddress}'s question, and the
 * answer is „an IPv4 address whole, an IPv6 address as its /64" — otherwise the
 * per-address half is free for anybody with a single IPv6 line.
 *
 * **Per form**, because two forms of one organisation are two independent gates: a
 * participant who fumbled the word of the Bestandsmeldung must not arrive at
 * the Jahrestagung registration already used up, and somebody re-uploading a scan
 * to one form must not spend another form's allowance.
 *
 * And the direction this must **not** be keyed is the form alone — see
 * `public-forms.rate-limit.ts`. A counter that closes a form for everybody is a
 * weapon anyone can pick up: a stranger would switch off an organisation's registration
 * from a single laptop, which is the lever bullet 5 forbids and ADR-0014 no. 7
 * repeats for the upload.
 *
 * ## The slug is caller-written, so it is not used raw — and not without a
 * ceiling either
 *
 * Whatever stands in the path arrives here and becomes part of a key in the
 * throttler's in-memory store. Two things follow, and only the first of them
 * was ever obvious:
 *
 * 1. **An address that cannot name a form** is collapsed into one shared bucket
 *    instead of minting a record of its own. {@link isPublicSlug} bounds length
 *    and alphabet, so a malformed address allocates nothing.
 * 2. **A well-formed address that names no form allocates all the same.**
 *    `isPublicSlug` checks spelling, not existence — 22 invented characters of
 *    base64url pass it. And because the counter is keyed *per slug*, a caller
 *    who never repeats one is never throttled: every request mints a fresh
 *    record and a fresh expiry timer, at whatever rate the network carries. „A
 *    rate limiter that can be made to allocate is a rate limiter that has become
 *    the attack" was written for case 1 and was not true of case 2.
 *
 * So the number of *distinct forms* one address may hold buckets for is capped
 * ({@link FORMS_PER_ADDRESS}); beyond it the attempts of that address share one
 * overflow bucket. The ceiling is **per address**, so it is not the lever
 * bullet 5 forbids: nobody can spend somebody else's allowance, and no traffic
 * from outside can make a form unreachable for anyone but the address it came
 * from.
 *
 * What is left is a caller who exhausts *their own* allowance — a real cost only
 * for a shared NAT, which is why the number is far above any honest use: nobody
 * fills in thirty-two different forms of this installation within a minute.
 *
 * ## One bookkeeping, not one per route
 *
 * The allowances below are shared by every tracker built here, and that is
 * deliberate. The ceiling is a bound on **what one address can cost this
 * process**, so splitting it per route would multiply exactly the number it
 * exists to bound. The throttler's own counters stay separate — they are keyed
 * by the string this function returns *and* by the route's own limit, which is
 * what keeps the gate's ten a minute and the upload's ten a minute from being
 * one budget.
 */

/** Separates the two parts. Neither an address key nor a slug can contain it. */
const KEY_SEPARATOR = '\u0000';

/** The one bucket every unusable address shares. */
const NO_FORM = 'no-such-form';

/**
 * How many distinct forms one address may hold a bucket for.
 *
 * Generous on purpose. It has to sit far above what an organisation's office behind one
 * address does in a minute — a handful of forms at most — while still turning
 * „unbounded" into a constant. Thirty-two buckets per address is what a single
 * caller can cost the store, whatever they send.
 */
const FORMS_PER_ADDRESS = 32;

/** Where the attempts of an address that went past its ceiling are counted. */
const OVERFLOW_FORM = 'too-many-forms';

/**
 * How long an address is remembered here.
 *
 * The throttler's own window is a minute for both routes that use this, so an
 * address whose records have all expired has nothing left to be attributed to
 * it. Twice the window, so the bookkeeping never forgets an address whose
 * bucket is still alive.
 */
const REMEMBER_MS = 120_000;

/** At most one sweep a second, whatever the traffic. */
const SWEEP_EVERY_MS = 1_000;

interface Allowance {
  readonly forms: Set<string>;
  seenAt: number;
}

/**
 * Which forms each address already has a bucket for.
 *
 * Bounded twice over: by {@link FORMS_PER_ADDRESS} in width and by
 * {@link REMEMBER_MS} in time, and its keys are {@link clientAddress} keys — so
 * an attacker on one IPv6 line is **one** entry here rather than 2^64.
 *
 * Module state rather than a provider, because `@Throttle` takes a plain
 * function and the throttler's own store is module state for the same reason.
 * `reset()` exists for the tests that need a clean slate.
 */
const allowances = new Map<string, Allowance>();
let sweptAt = 0;

function sweep(now: number): void {
  if (now - sweptAt < SWEEP_EVERY_MS) {
    return;
  }
  sweptAt = now;
  for (const [address, allowance] of allowances) {
    if (now - allowance.seenAt > REMEMBER_MS) {
      allowances.delete(address);
    }
  }
}

function formOf(req: Record<string, unknown>): string {
  const params: unknown = req.params;
  if (typeof params !== 'object' || params === null) {
    return NO_FORM;
  }
  const slug: unknown = (params as Record<string, unknown>).slug;
  return isPublicSlug(slug) ? slug : NO_FORM;
}

/**
 * The form part of the key, or the overflow bucket once this address has held
 * buckets for {@link FORMS_PER_ADDRESS} distinct forms.
 *
 * A form the address already counts against stays its own bucket for as long as
 * the address keeps appearing — otherwise somebody halfway through the word of a
 * real form could be pushed into the overflow by their own later typos.
 */
function formWithinAllowance(
  address: string,
  form: string,
  now: number,
): string {
  if (form === NO_FORM) {
    return form;
  }
  sweep(now);

  const allowance = allowances.get(address);
  if (allowance === undefined) {
    allowances.set(address, { forms: new Set([form]), seenAt: now });
    return form;
  }
  allowance.seenAt = now;
  if (allowance.forms.has(form)) {
    return form;
  }
  if (allowance.forms.size >= FORMS_PER_ADDRESS) {
    return OVERFLOW_FORM;
  }
  allowance.forms.add(form);
  return form;
}

/**
 * The key for one request: `<address>\0<form>`.
 *
 * Exported for the two `@Throttle` decorators that use it and for the quota of
 * the upload (`upload-quota.ts`), which counts over the *same* pair and must
 * not invent a second way of naming it.
 */
export function addressFormKey(req: Record<string, unknown>): string {
  const address = clientAddress(req);
  const form = formWithinAllowance(address, formOf(req), Date.now());
  return `${address}${KEY_SEPARATOR}${form}`;
}

/** Forgets every address — for tests that need to start from nothing. */
export function resetAddressFormAllowances(): void {
  allowances.clear();
  sweptAt = 0;
}

export const ADDRESS_FORM_LIMITS = {
  formsPerAddress: FORMS_PER_ADDRESS,
  overflowForm: OVERFLOW_FORM,
  noForm: NO_FORM,
  keySeparator: KEY_SEPARATOR,
} as const;
