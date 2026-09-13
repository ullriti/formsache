import { expect } from 'vitest';

/**
 * **The shared shape of the two wall-clock proofs — and the measurement the
 * bound below is derived from.**
 *
 * Two tests promise „the same order of time" for two code paths that must not
 * be distinguishable from outside:
 *
 * - `test/auth/auth.spec.ts` — an unknown address against a wrong password
 *   (account enumeration).
 * - `test/public/password-gate.spec.ts` — a wrong word against a word offered
 *   at an address that leads nowhere (form enumeration).
 *
 * They lived as two hand-written copies of the same five-pair loop, and the
 * copies were already drifting in their comments. They share this helper so a
 * bound moved for one is moved for both.
 *
 * ## Why the bound is what it is
 *
 * The old shape — five interleaved pairs, median of five, bounds 0.5× and 2× —
 * went red in CI on `ac6b208` with a ratio of 2.18, on a commit that touched
 * nothing near either path, after six green runs on a quiet machine. So the
 * distribution was measured instead of guessed: 50 repetitions of the whole
 * loop per regime, then every window of consecutive pairs evaluated as if it
 * had been a test run (≈240 windows per regime). Ratio of the two medians,
 * min…max:
 *
 * | regime                              | 5 pairs, no warm-up | 15 pairs + warm-up |
 * |-------------------------------------|---------------------|--------------------|
 * | one spec file alone, idle machine   | 0.90 … 1.09         | 0.92 … 1.06        |
 * | inside the full API suite (as CI)   | 0.58 … **2.22**     | 0.86 … 1.14        |
 * | full suite + 4 bursty CPU loaders   | 0.43 … 1.80         | 0.72 … 1.42        |
 * | ~3 suites at once, load average 30  | 0.20 … **3.38**     | 0.52 … 1.84        |
 *
 * (Public gate ≈5 ms a request, login ≈28 ms; the table merges both, the wider
 * of the two per cell. Full numbers: `docs/worklog/2026-08-06-timing-tests.md`.)
 *
 * Three readings follow.
 *
 * **The old bound was inside the noise, not outside it.** 2.22 in the plain
 * CI regime is the failure CI saw; nothing was wrong with the server. A test
 * that goes red for a reason outside its subject teaches everyone to re-run
 * it, and then it protects nothing at all.
 *
 * **The first pair is the expensive one.** The single worst CI-regime window
 * above (2.22) drops to 1.62 when the first pair is discarded — first request
 * into a route, cold JIT, cold connection. It is now a warm-up pair and does
 * not count.
 *
 * **Sixteen measurements cost nothing and buy most of the robustness.** A
 * burst that catches two or three samples cannot move the median of fifteen
 * the way it moves the median of five. Fifteen pairs cost ≈0.1 s at the
 * public gate and ≈0.9 s at the login (Argon2id at 19 MiB, twice a pair).
 *
 * The factor is then chosen with margin against the *worst* regime measured,
 * not against the expected one: 3× leaves ≈1.7× of headroom over the 1.84 of
 * a machine under three simultaneous suites, which is well past anything CI
 * does.
 */
const WARM_UP_PAIRS = 1;
const MEASURED_PAIRS = 15;

/**
 * How far the two medians may sit apart before the test calls it a difference.
 *
 * **What this no longer claims.** The old 0.5×/2× promised a sharpness the
 * measurement never had: at the public gate a request costs ≈5 ms, of which
 * the compared work is a decryption and two MACs in the microseconds. Even
 * idle, that test could not have seen a skipped decryption, and under CI load
 * the two medians drift by up to 3.6 ms in absolute terms — the size of the
 * whole request. At 3× the tests assert what they can actually carry: **no
 * gross asymmetry** — one path doing categorically different work, such as an
 * early return that skips the verification entirely (the login answers an
 * unknown address in a small fraction of the time without its dummy hash), or
 * a whole extra round trip. An added query of ≈1 ms was never within reach and
 * is not within reach now.
 *
 * **The deterministic proof next to each of these is the real one.** The clock
 * is the weaker witness and it is honest to say so:
 * `src/auth/auth.service.spec.ts` asserts that the dummy verification runs
 * when there is no user, and the password gate's neighbouring test counts the
 * decryptions and MACs of both paths. Those fail unambiguously. Do not tighten
 * the bound here to compensate for a gap there — write the counting test.
 *
 * Bounded on **both** sides, unchanged: an oracle does not care which
 * direction it points in, and a path made noticeably *slower* is just as
 * readable with a stopwatch.
 */
const SAME_ORDER_FACTOR = 3;

/** Median of an odd-sized sample, without disturbing the caller's array. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((first, second) => first - second);
  return sorted[(sorted.length - 1) / 2] ?? 0;
}

export interface TimingComparison {
  /** Median duration of the reference path, in milliseconds. */
  reference: number;
  /** Median duration of the path that must not be distinguishable from it. */
  candidate: number;
}

/**
 * Times two paths **interleaved**, one pair at a time, and returns the medians.
 *
 * Interleaved is what keeps this from measuring the machine: timing fifteen of
 * one and then fifteen of the other compares two moments, and a build running
 * on the other cores during the first batch and not the second moves the ratio
 * without anything about the server having changed. Within a pair both
 * requests meet the same machine, so load largely cancels out of the ratio
 * instead of accumulating in it.
 *
 * `beforePair` runs before each pair — the login uses it to clear the rate
 * limiter, whose bucket is smaller than this many attempts.
 */
export async function compareInterleaved(
  measureReference: () => Promise<number>,
  measureCandidate: () => Promise<number>,
  beforePair: () => void | Promise<void> = () => undefined,
): Promise<TimingComparison> {
  const reference: number[] = [];
  const candidate: number[] = [];

  for (let pair = 0; pair < WARM_UP_PAIRS + MEASURED_PAIRS; pair += 1) {
    await beforePair();
    const first = await measureReference();
    const second = await measureCandidate();
    // The warm-up pair is timed like any other and then thrown away: it is the
    // one that pays for the cold route, and keeping it skewed the median.
    if (pair >= WARM_UP_PAIRS) {
      reference.push(first);
      candidate.push(second);
    }
  }

  return { reference: median(reference), candidate: median(candidate) };
}

/** Asserts the two medians sit within `SAME_ORDER_FACTOR` of each other. */
export function expectSameOrderOfTime({
  reference,
  candidate,
}: TimingComparison): void {
  expect(candidate).toBeGreaterThan(reference / SAME_ORDER_FACTOR);
  expect(candidate).toBeLessThan(reference * SAME_ORDER_FACTOR);
}
