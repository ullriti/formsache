import {
  ADDRESS_FORM_LIMITS,
  addressFormKey,
  resetAddressFormAllowances,
} from './address-form-tracker';

/**
 * The bucket a password-gate attempt is counted in — **address ⊕ form**
 * (bullets 4 and 5).
 *
 * Handed to `@Throttle` on the route rather than to a second
 * `ThrottlerModule.forRoot`, and that is not a style question: `ThrottlerModule`
 * is `@Global()`, a second `forRoot` *replaces* the first one's configuration,
 * and that is how a past change silently deleted the login's rate limit. There is one
 * registration (`common/rate-limit.module.ts`), the registered default stays the
 * strict one, and a route that wants different numbers — or, here, a different
 * key — says so on itself.
 *
 * **The key itself moved to `address-form-tracker.ts` later**, because the
 * upload of ADR-0014 no. 8 needs the same one and the ADR asks for the tracker
 * to be *generalised, not copied*: what makes this key safe is an argument — the
 * per-address ceiling, the overflow bucket, the collapse of unusable addresses —
 * and a second copy of an argument is a second thing that has to stay true.
 *
 * This file stays as the name the gate is wired under, and the whole of it is
 * now three lines that forward. The security proofs point at this
 * module (`access-attempt-tracker.spec.ts`, `test/public/password-gate.spec.ts`),
 * and they keep pointing at the shipped behaviour: they exercise the generalised
 * key through the gate's own door, which is the direction that has to stay
 * measured. „Ich habe den Test angepasst" would have been the wrong move here
 * (ADR-0014 „Consequences").
 */
export function accessAttemptTracker(req: Record<string, unknown>): string {
  return addressFormKey(req);
}

/** Forgets every address — for tests that need to start from nothing. */
export const resetAccessAttemptAllowances = resetAddressFormAllowances;

export const ACCESS_ATTEMPT_LIMITS = ADDRESS_FORM_LIMITS;
