import {
  parseSuperadminList,
  superadminAddedSchema,
  type SuperadminAdded,
  type SuperadminList,
  type SuperadminPromote,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';
import { SESSION_QUERY_KEY } from './session';

/**
 * **Who carries the system administration of this installation** (ADR-0029) —
 * behind `GET`/`POST /api/admin/superadmins` and
 * `DELETE /api/admin/superadmins/:id`.
 *
 * Routes of their own under `/admin/`, like the organisation overview next to
 * it and for the same reason: it is administration of the *installation*, not
 * of an organisation. The guard chain this module answers to stands in
 * `SuperadminsController` — `SessionGuard`, `SuperadminGuard`, nothing else.
 */

/** One cache entry for the whole list — an appointment refreshes it. */
export const SUPERADMINS_QUERY_KEY = ['admin', 'superadmins'] as const;

export function useSuperadmins(): UseQueryResult<SuperadminList> {
  return useQuery({
    queryKey: SUPERADMINS_QUERY_KEY,
    queryFn: async () =>
      parseSuperadminList(
        await requestJson('/admin/superadmins', { method: 'GET' }),
      ),
  });
}

/**
 * **„Zum Superadministrator ernennen"** — `POST /admin/superadmins`.
 *
 * `retry: false` like every write of this application that can fail on a
 * uniqueness: a repetition of the same request would fail just the same, and
 * the 409 already names what is going on („verwaltet das System bereits").
 *
 * **And the session with it**: `isSuperadmin` stands in `GET /auth/me` and
 * decides whether the shell shows the entry *Systemverwaltung* at all. Whoever
 * affects themselves — the regular case for the withdrawal below — would otherwise
 * see a navigation that belongs to a session which no longer exists in that
 * form. The same reasoning that `api/admin.ts` gives for creating and deleting
 * an organisation.
 */
export function usePromoteSuperadmin(): UseMutationResult<
  SuperadminAdded,
  Error,
  SuperadminPromote
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (request: SuperadminPromote) =>
      superadminAddedSchema.parse(
        await requestJson('/admin/superadmins', {
          method: 'POST',
          body: request,
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SUPERADMINS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]);
    },
  });
}

/**
 * **Withdrawing the appointment** — `DELETE /admin/superadmins/:userId`.
 *
 * No body and no typed confirmation: the confirmation prompt stands in the
 * surface (`SystemSuperadminsTab`), where it can tell „yourself" from
 * „somebody else". The two refusals the server has — the last
 * superadministrator, and an account without an organisation — come as a 409
 * with their own sentence; `actionErrorMessage` shows it instead of
 * formulating it a second time here.
 */
export function useDemoteSuperadmin(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (userId: string) =>
      requestVoid(`/admin/superadmins/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SUPERADMINS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]);
    },
  });
}
