import {
  ThrottlerStorage,
  type ThrottlerStorageService,
} from '@nestjs/throttler';

import type { TestApp } from './create-test-app';

/**
 * **Reset the counter of a rate limit** — for suites that use a limited route
 * more often than a human would in a minute.
 *
 * ## Why this exists as a helper and not in every file
 *
 * The version first stood in `test/auth/auth.spec.ts`, because the login was
 * the first limited route. Since the invitation routes carry a limit
 * (`INVITATION_MAIL_RATE_LIMIT`, security finding 2), it needs a second
 * suite — and two versions of it would be exactly the duplication the docblock
 * below warns about: how the storage forgets its hits is an assumption about
 * a foreign library, and that one wants to stand in **one** place, so that it
 * fails loudly in one place.
 *
 * ## What the caller needs to know
 *
 * The helper belongs in a `beforeEach`, not in a single case: the limit counts
 * per origin address, and every request of a suite comes from the same
 * loopback address. Without it a suite is **one** caller with dozens of
 * attempts per minute, and what turns red is the case that happens to run
 * eleventh.
 *
 * A suite that **measures** the limit resets beforehand and then pushes over
 * the boundary within one case — that way its number does not depend on what
 * the cases before it used up.
 */
export async function resetRateLimit(app: TestApp): Promise<void> {
  const storage = app.app.get<ThrottlerStorageService>(ThrottlerStorage);
  await forgetEveryHit(storage);
}

/**
 * Empties the in-memory throttler storage through its one public way to do so.
 *
 * Zeroing `totalHits` on the records is **not** enough since
 * `@nestjs/throttler` 6.7: the storage keeps the expiry time of every hit in a
 * private `hitExpirations` map and recounts `totalHits` from it on the next
 * request, so a zeroed counter would spring back to where it stood.
 * `onApplicationShutdown()` clears both maps — and it is public, so no cast
 * into the library's internals is needed. It also stops the eviction sweep;
 * the storage restarts that on its next `increment`.
 *
 * The reset is **measured** rather than assumed, and measured by behaviour,
 * not by the public `storage` map alone — that map could be empty while the
 * private hits survive, which is exactly the failure above. Every counter that
 * held hits before the reset is hit once more, and each must count that hit as
 * its first: if a future version keeps state across the shutdown, this fails
 * loudly here instead of turning the case that happens to run eleventh red
 * for no reason on the server. The probe hits are cleared again afterwards.
 *
 * (Up to 6.5 the storage scheduled one decrement timer per hit instead, which
 * a reset had to cancel by reaching into the private `timeoutIds`. 6.7 has no
 * such timers, so a hit from an early case can no longer count down a counter
 * that a later reset has already zeroed.)
 */
async function forgetEveryHit(storage: ThrottlerStorageService): Promise<void> {
  const counters = [...storage.storage].flatMap(([key, record]) =>
    [...record.totalHits.keys()].map((throttler) => ({ key, throttler })),
  );
  storage.onApplicationShutdown();

  const kept: string[] = [];
  for (const { key, throttler } of counters) {
    const probe = await storage.increment(key, 60_000, 2, 0, throttler);
    if (probe.totalHits !== 1) {
      kept.push(`${throttler}:${key}`);
    }
  }
  storage.onApplicationShutdown();

  if (kept.length > 0 || storage.storage.size !== 0) {
    throw new Error(
      `ThrottlerStorageService kept hits across onApplicationShutdown() (${kept.join(', ')}) — the reset in this suite has to be rewritten`,
    );
  }
}
