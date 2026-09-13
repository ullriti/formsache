import {
  formMemberListSchema,
  type FormMemberList,
  type FormMemberWrite,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { FORMS_QUERY_KEY } from './forms';
import { requestJson } from './http';

/**
 * Server state of *Nutzerrechte je Formular*.
 *
 * Behind `GET`/`PUT /api/forms/:formId/members`, the fourth link of the guard
 * chain — `FormRestrictionGuard` runs on these routes too, so a person whose
 * own access to this form was revoked gets the same 404 the form itself gives
 * them (`FormPermissionController`).
 */

export function formMembersQueryKey(formId: string): readonly string[] {
  return ['form-members', formId];
}

/**
 * Everybody who works in the active Organisation, with what they may do on **this**
 * form — and the organisation's groups, so the cap selector needs no second request.
 */
export function useFormMembers(formId: string): UseQueryResult<FormMemberList> {
  return useQuery({
    queryKey: formMembersQueryKey(formId),
    queryFn: async () =>
      formMemberListSchema.parse(
        await requestJson(`/forms/${encodeURIComponent(formId)}/members`, {
          method: 'GET',
        }),
      ),
  });
}

export interface SaveFormMemberVariables {
  readonly userId: string;
  readonly write: FormMemberWrite;
}

/**
 * Stores one person's restriction — „Zugriff sperren" and „Rolle herab", and
 * nothing that adds (`formMemberWriteSchema` has no field that grants).
 *
 * Returns the **whole** list, and the answer replaces the cache in one place:
 * the server's document is what „gilt jetzt" for every row, not only the one
 * that was just written (`FormPermissionService.save` — a missing row already
 * means „keine Einschränkung", so a client that merged one row into its own
 * copy would be a second place that fact could go stale).
 *
 * ## The write also invalidates `['forms']` — one key, not `invalidateQueries()`
 *
 * (The requirement Fund 3.) `GET /forms` and `GET /forms/:id` sit behind the
 * very restriction this write changes — `FormRestriction.formFilter()` narrows
 * the list by `accessRevoked`, and `FormRestrictionGuard` answers the detail
 * route the same 404 `FormMembersView`'s own doc comment already names for the
 * members route. A write here can therefore change what those two answer for
 * the **acting** person, and until now nothing told their cache so: the
 * dashboard kept a form the next `GET /forms` would already have dropped, and
 * so did every other view of it (`useForm`), reachable a click away through
 * `FormNav` — „Formularliste und Navigation" of the finding, both fed by the
 * same two routes.
 *
 * `FORMS_QUERY_KEY` (`['forms']`) is the one key to invalidate rather than
 * `formQueryKey(formId)` (`['forms', formId]`) too: TanStack Query matches a
 * key as a **prefix**, so invalidating the shorter one already reaches the
 * longer one — a second call would be the same refetch requested twice.
 * `staleTime: 0` is this project's default (`query-client.ts`), so `['forms']`
 * itself was never actually fresh between renders — what was missing was
 * telling the *cache*, not the network, that the answer might differ now.
 *
 * This does not depend on today's guard actually letting a self-write through
 * (`SELF_LOCKOUT_MESSAGE`/`SELF_CAP_LOCKOUT_MESSAGE` in
 * `form-permission.service.ts` refuse the one path that would touch the
 * acting person's own row directly). A client mirrors what the server says,
 * never what the client assumes the server would allow (`CONTRIBUTING.md`) — a
 * relaxed guard, a future admin-acting-on-admin surface, or simply a mistaken
 * assumption in this comment must not silently reopen the finding.
 *
 * ## What is deliberately **not** invalidated here
 *
 * - **`tenantGroupsQueryKey`** (`api/tenant-admin.ts`) — the organisation's groups.
 *   `FormPermissionService.save` writes only `form_permission`; it never
 *   touches `group`, so nothing in that document can have changed. The stale
 *   bare `['tenant-groups']` key this module used to cache groups under is
 *   gone (see that module's own comment) — `FormMembersView` now reads
 *   `useTenantGroups` from `api/tenant-admin.ts` under the scoped
 *   `['tenant-groups', tenantId]` alone, so there is no second key left to
 *   even consider invalidating from here.
 * - **`SESSION_QUERY_KEY`** (`api/session.ts`) — the session carries the
 *   **tenant-wide** permissions of the membership, and a per-form restriction
 *   narrows one form, never the membership or the group behind it. The session
 *   cannot have changed, so invalidating it would be a refetch that could not
 *   answer differently.
 *
 *   This is also why `['forms']` is the **whole** fix and not half of one: since
 *   the requirement no. 3 the effective per-form rights ride on
 *   `FormSummary.permissions`, so `FormNav` and the dashboard cards read them
 *   out of the very document this invalidation refetches. When that field did
 *   not exist, `FormNav` read the session instead — and a cap that took
 *   `can_build` away on one form changed nothing anybody could see, because the
 *   session it read was right and irrelevant at once.
 */
export function useSaveFormMember(
  formId: string,
): UseMutationResult<FormMemberList, Error, SaveFormMemberVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ userId, write }: SaveFormMemberVariables) =>
      formMemberListSchema.parse(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/members/${encodeURIComponent(userId)}`,
          {
            method: 'PUT',
            body: write,
          },
        ),
      ),
    onSuccess: async (list) => {
      queryClient.setQueryData(formMembersQueryKey(formId), list);
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

/**
 * **The organisation's groups are not fetched here.**
 *
 * *Nutzerrechte je Formular* needs them twice over — the „Rechte im Überblick"
 * matrix and the second line of the role legend want the permissions that
 * `FormMemberList.groups` deliberately does not carry (`groupSummarySchema`:
 * id, name, colour, rank, `isSystem`, nothing about what a role may do). This
 * module had its own hook for that, cached under a bare `['tenant-groups']`,
 * next to `api/tenant-admin.ts`'s `['tenant-groups', tenantId]`: **one
 * document, two cache keys**. After an organisation switch the matrix showed the other
 * organisation's groups for a render, and every invalidation in `tenant-admin.ts`
 * reached one copy and never the other — the unscoped-key bug of the requirement, one page further on.
 *
 * `FormMembersView` therefore reads `useTenantGroups(activeTenantId)` from
 * `api/tenant-admin.ts`. One hook, one key.
 */
