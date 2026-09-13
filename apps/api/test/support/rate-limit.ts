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
 * below warns about: the reach for `timeoutIds` is an assumption about a
 * foreign library, and that one wants to stand in **one** place, so that it
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
export function resetRateLimit(app: TestApp): void {
  const storage = app.app.get<ThrottlerStorageService>(ThrottlerStorage);
  for (const record of storage.storage.values()) {
    record.isBlocked = false;
    record.blockExpiresAt = 0;
    for (const throttler of record.totalHits.keys()) {
      record.totalHits.set(throttler, 0);
    }
  }
  cancelExpirationTimers(storage);
}

/**
 * Cancels the pending decrement timers of the in-memory throttler storage.
 *
 * `timeoutIds` is private to `ThrottlerStorageService` and reached through a
 * cast, which is a liberty a test may take and production code may not. The
 * shape is asserted rather than assumed: if a future version of the library
 * renames or drops the field, this fails loudly here instead of quietly
 * reintroducing the drift it exists to prevent.
 *
 * Why at all: the storage schedules one timer per hit that counts down exactly
 * the record it belongs to. A hit from an early case whose sixty seconds
 * expire **after** a later reset would count down a counter that already
 * stands at zero — the number would go negative, the suite would stop
 * limiting, and the cases over the limit would turn red for a timing reason
 * without anything being wrong on the server. This is the library's
 * `clearExpirationTimes`, which it does not hand out.
 */
function cancelExpirationTimers(storage: ThrottlerStorageService): void {
  const { timeoutIds } = storage as unknown as {
    timeoutIds: Map<string, NodeJS.Timeout[]> | undefined;
  };
  if (!(timeoutIds instanceof Map)) {
    throw new Error(
      'ThrottlerStorageService no longer keeps its expiration timers in `timeoutIds` — the reset in this suite has to be rewritten',
    );
  }
  for (const [throttler, timers] of timeoutIds) {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timeoutIds.set(throttler, []);
  }
}
