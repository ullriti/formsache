import { QueryClient } from '@tanstack/react-query';

import { NetworkError } from './http';

/**
 * Builds the app's TanStack Query client.
 *
 * A factory rather than a module-level singleton, because tests need a fresh
 * cache per test — a shared client would let one test's session leak into the
 * next one.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Only a lost connection is worth a second attempt. An HTTP status is
        // an answer — repeating a 401 or a 500 only delays the view — and a
        // payload that fails the schema will fail it again just the same.
        retry: (failureCount, error) =>
          error instanceof NetworkError && failureCount < 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // Login and logout are not idempotent from the user's point of view;
        // a silent retry of a failed login would double the Argon2id cost on
        // the server for the same wrong password.
        retry: false,
      },
    },
  });
}
