import type {
  EmailChange,
  LoginRequest,
  PasswordChange,
  SessionRevocation,
  SessionUser,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  changeOwnEmail,
  changeOwnPassword,
  confirmPasswordReset,
  fetchSessionUser,
  login,
  logout,
  requestPasswordReset,
  revokeOtherSessions,
  switchTenant,
  updateProfile,
} from './auth';

/**
 * Server state of the session, owned by TanStack Query alone.
 *
 * There is deliberately no second copy of "who is signed in" in a component
 * state or a Zustand store: the session lives in an httpOnly cookie, so the
 * only thing the app can know about it is what `GET /api/auth/me` last said.
 * A mirrored flag could disagree with the server, and the disagreement would
 * always be in the dangerous direction — a UI that shows an admin shell to
 * someone whose session the server already dropped.
 */

/** Cache key of the session query. One key, so invalidation is unambiguous. */
export const SESSION_QUERY_KEY = ['auth', 'session'] as const;

/** `null` data means "no session"; `isError` means "we could not find out". */
export function useSession(): UseQueryResult<SessionUser | null> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSessionUser,
  });
}

export function useLogin(): UseMutationResult<
  SessionUser,
  Error,
  LoginRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: login,
    onSuccess: async (user) => {
      // The login response already carries the parsed user, so the shell can
      // render without a second round trip …
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      // … but `/auth/me` stays the authority. If the cookie did not stick,
      // this refetch flips the app back to the login view instead of showing
      // a session that does not exist.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

/**
 * Ends all **other** sessions (a review finding).
 *
 * Without `invalidate`: one's own session is untouched, nothing changes
 * that this page displays. What changes is the state of foreign browsers —
 * and the number in the answer is the only thing of that which arrives here.
 */
export function useRevokeOtherSessions(): UseMutationResult<
  SessionRevocation,
  Error,
  void
> {
  return useMutation({ retry: false, mutationFn: revokeOtherSessions });
}

/**
 * Switches the active tenant.
 *
 * `invalidateQueries()` without a key — everything, on purpose. The active
 * tenant is the scope of *every* domain query, so after a switch there is no
 * cached answer that is still about the right Organisation. Invalidating only the
 * session key would leave a form list of the previous tenant on screen, which
 * is the exact failure the tenant boundary exists to prevent: harmless in the
 * database, misleading on the screen.
 */
export function useSwitchTenant(): UseMutationResult<
  SessionUser,
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: switchTenant,
    onSuccess: async (user) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      await queryClient.invalidateQueries();
    },
  });
}

/**
 * Changes one's own name and writes the answer into the cache
 * (finding 12).
 *
 * `setQueryData` **and** `invalidateQueries`, as on login and for
 * the same reason: the answer carries the fresh user, so that the header
 * is right at once — and `/auth/me` remains the authority that confirms it.
 */
export function useUpdateProfile(): UseMutationResult<
  SessionUser,
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: updateProfile,
    onSuccess: async (user) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

/**
 * Changes one's own e-mail address (finding 8).
 *
 * Exactly like {@link useUpdateProfile}, and for the same reason: the answer
 * carries the fresh user, so that the header („Angemeldet als …") is at once
 * right — and `/auth/me` remains the authority that confirms it.
 */
export function useChangeOwnEmail(): UseMutationResult<
  SessionUser,
  Error,
  EmailChange
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: changeOwnEmail,
    onSuccess: async (user) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

/**
 * Changes one's own password (finding 12, ADR-0020).
 *
 * Without `invalidate`, although the change ends every session: the answer
 * brings the replacement cookie along, the browser takes it over, and about what
 * `/auth/me` says nothing changes — it is the same person. An
 * `invalidateQueries()` would be a round through all views for an answer
 * that was settled beforehand.
 */
export function useChangeOwnPassword(): UseMutationResult<
  SessionRevocation,
  Error,
  PasswordChange
> {
  return useMutation({ retry: false, mutationFn: changeOwnPassword });
}

/**
 * Requests a reset link (ADR-0020).
 *
 * `retry: false`, as with every mutation here — and here with a weight of its
 * own: a silent second attempt would consume the quota of this
 * address (three per hour) without anybody having wanted it.
 */
export function useRequestPasswordReset(): UseMutationResult<
  void,
  Error,
  string
> {
  return useMutation({ retry: false, mutationFn: requestPasswordReset });
}

/** Redeems a reset link (ADR-0020). */
export function useConfirmPasswordReset(): UseMutationResult<
  void,
  Error,
  { readonly token: string; readonly password: string }
> {
  return useMutation({
    retry: false,
    mutationFn: ({ token, password }: { token: string; password: string }) =>
      confirmPasswordReset(token, password),
  });
}
