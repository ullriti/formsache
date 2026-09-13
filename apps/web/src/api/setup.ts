import type { SetupRequest, SetupState } from '@formsache/shared';
import { parseSetupState } from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';

/**
 * The initial setup (ADR-0022) — the third state before the login.
 *
 * As long as the installation has not a single account, `App.tsx` shows a setup
 * instead of the login. What decides that is exclusively the
 * server's answer: there is no second source here and no flag that the
 * browser remembers. Whether an installation is set up is known by the database
 * and by nobody else — and the view must not be wrong about it, because both
 * errors are expensive: a setup mask over a running installation
 * is a fright, a login mask over an empty installation is a
 * dead end.
 */

/** Cache key of the state question. One, so that invalidation is unambiguous. */
export const SETUP_QUERY_KEY = ['setup', 'state'] as const;

/** Whether the application should show the setup instead of the login. */
export async function fetchSetupState(): Promise<SetupState> {
  return parseSetupState(await requestJson('/setup', { method: 'GET' }));
}

/**
 * Sets up. Answers 204 — **nothing** comes back, not even a session.
 *
 * That is why the login stands afterwards and not the dashboard, and that is the
 * pleasant side of a security decision: the most dangerous route of this
 * application issues no session, and whoever has set up sees at once
 * that their credentials work.
 */
export async function runSetup(request: SetupRequest): Promise<void> {
  await requestVoid('/setup', { method: 'POST', body: request });
}

export interface SetupStateOptions {
  /**
   * Only ask when the question is actually pending.
   *
   * `App.tsx` switches it on as soon as the session check says "no session".
   * Whoever is logged in therefore pays nothing for this route — and a
   * session check that has *failed* leads to the login with a notice
   * and not here: out of "we don't know" no setup mask may
   * grow.
   */
  readonly enabled: boolean;
}

export function useSetupState(
  options: SetupStateOptions = { enabled: true },
): UseQueryResult<SetupState> {
  return useQuery({
    queryKey: SETUP_QUERY_KEY,
    queryFn: fetchSetupState,
    enabled: options.enabled,
    /**
     * The answer changes exactly once in the life of an installation, and
     * this one change is triggered and invalidated here ({@link useRunSetup}).
     * Without `staleTime` every window switch would ask anew — a round trip for an
     * answer that is settled.
     */
    staleTime: Infinity,
    /**
     * No second attempt on an answer with a status. And a failure
     * here expressly does **not** mean "then just set up": the view
     * falls back to the login, because a form that wants to create the first
     * superadministrator is the last thing anyone should see after an
     * unclear server error.
     */
    retry: false,
  });
}

/**
 * Carries out the setup.
 *
 * **Without `onSuccess`, and that is the deliberate half.** The obvious move
 * would be `invalidateQueries` on {@link SETUP_QUERY_KEY} — only the effect
 * of that is not "the view is now up to date", but: `App.tsx` gets
 * `setupRequired: false`, swaps the setup for the login and
 * **thereby tears away the confirmation** that the mask was just about to show.
 * Whoever has just created an account would stand without a sentence about it
 * before a login mask and would have to guess whether it worked.
 *
 * The transition is therefore made by the confirmation itself, with a full reload
 * (`SetupView`): the setup is the one moment in the life of an
 * installation in which *everything* the browser knows about it is stale —
 * and a reload is more honest for that than a selection of invalidated queries.
 *
 * No `setQueryData` least of all: a self-set
 * `{ setupRequired: false }` would be a claim by the browser about the state
 * of an installation — the same sort of claim that expressly does not exist
 * about the session.
 *
 * `retry: false`, as with every mutation here, and here with its own weight:
 * a silent second attempt would consume one of the ten calls per minute on
 * a route that only succeeds once anyway.
 */
export function useRunSetup(): UseMutationResult<void, Error, SetupRequest> {
  return useMutation({
    retry: false,
    mutationFn: runSetup,
  });
}
