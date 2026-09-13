import {
  trashPurgeResultSchema,
  trashViewSchema,
  type TrashPurgeResult,
  type TrashView,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { FORMS_QUERY_KEY } from './forms';
import { requestJson, requestVoid } from './http';

/**
 * Server state of the trash (handoff
 * §Screens/Views 10).
 *
 * Behind `GET /api/trash` — `canBuild`, tenant-scoped like every other
 * `/api/forms/…` route, and one document for both sections: the list is one
 * screen, and fetching it as two queries would let the two counters disagree
 * about the moment they were read.
 *
 * The write routes live under `/api/forms/:id[/responses/:responseId]`
 * (`TrashController`/`FormsController` on the server)
 * — this module reads, deletes into the trash, restores, purges and
 * empties. „Endgültig löschen" and „Papierkorb leeren" both need `canBuild`
 * **and** `canViewResponses` — a stronger bar than
 * {@link useTrash} itself or than moving something *into* the trash in
 * the first place, so `TrashView.tsx`/`DashboardView.tsx`/
 * `ResponseDetailPanel.tsx` decide whether to render each control from the
 * permissions they already have, not from anything this module infers.
 */

export const TRASH_QUERY_KEY = ['trash'] as const;

export function useTrash(): UseQueryResult<TrashView> {
  return useQuery({
    queryKey: TRASH_QUERY_KEY,
    queryFn: async () =>
      trashViewSchema.parse(await requestJson('/trash', { method: 'GET' })),
  });
}

/**
 * **Moves a form into the trash**  —
 * `DELETE /forms/:id`, `canBuild` alone: reversible, for 30 days, by the same
 * person, which is the whole of Konzept no. 65's first half (the stronger pair
 * only applies once nothing is left to undo — the two purges and the
 * emptying further down).
 *
 * **Both directions of invalidation, both `onSuccess`.** The form leaves
 * `FORMS_QUERY_KEY` (the dashboard grid, and — being a prefix match — its own
 * responses table with it) and appears in `TRASH_QUERY_KEY` (the trash)
 * in the same instant on the server, so there is no reason to let one of the
 * two stay stale while the other refetches: unlike a restore's refusal
 * , a delete has no partial outcome to chase.
 */
export function useDeleteForm(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (formId: string) =>
      requestVoid(`/forms/${encodeURIComponent(formId)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
      ]);
    },
  });
}

export interface RestoreResponseVariables {
  readonly formId: string;
  readonly responseId: string;
}

/**
 * **Moves one answer into the trash**  —
 * `DELETE /forms/:formId/responses/:responseId`, `canBuild` **and**
 * `canViewResponses`: deleting a single answer asks for both (unlike deleting
 * the whole form above, which stays at `canBuild` alone — see
 * `FormsController.deleteForm` for why the two are not the contradiction
 * they look like).
 *
 * Same both-directions `onSuccess` as {@link useDeleteForm}.
 */
export function useDeleteResponse(): UseMutationResult<
  void,
  Error,
  RestoreResponseVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, responseId }: RestoreResponseVariables) =>
      requestVoid(
        `/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(responseId)}`,
        {
          method: 'DELETE',
        },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
      ]);
    },
  });
}

export interface DeleteResponsesVariables {
  readonly formId: string;
  readonly responseIds: readonly string[];
}

/**
 * **Moves several answers into the trash at once**  —
 * `POST /forms/:formId/responses/delete`, the „Löschen" of the action bar.
 *
 * Same guard pair as {@link useDeleteResponse}: naming twenty registrations in
 * one request is not a smaller decision than naming one, so `ResponsesView`
 * gates the bar on exactly what it gates the panel's button on.
 *
 * **The server refuses the whole call if one id is not this form's** (404, and
 * nothing written), which is why there is no partial-success shape to report
 * here — the mutation either happened or did not, like every other one in this
 * module. Same both-directions `onSuccess` as {@link useDeleteResponse}.
 */
export function useDeleteResponses(): UseMutationResult<
  void,
  Error,
  DeleteResponsesVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, responseIds }: DeleteResponsesVariables) =>
      requestVoid(`/forms/${encodeURIComponent(formId)}/responses/delete`, {
        method: 'POST',
        body: { responseIds: [...responseIds] },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
      ]);
    },
  });
}

/**
 * Takes a form back out of the trash.
 *
 * **`onSettled`, not only `onSuccess`, invalidates the trash itself.** A
 * restore that the server refuses still needs a fresh count — the row was
 * evaluated against the state at the moment of the request, and by the time
 * the refusal reaches this client something else may already have changed
 * again. Refetching only on success would let a stale badge stand next to a
 * row the view just explained is staying.
 *
 * Refetching `FORMS_QUERY_KEY` only on success (not `onSettled`): a form that
 * stayed in the trash changed nothing the dashboard shows.
 */
export function useRestoreForm(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (formId: string) =>
      requestVoid(`/forms/${encodeURIComponent(formId)}/restore`, {
        method: 'POST',
      }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

/**
 * Takes one answer back out of the trash — or the server refuses with a
 * 409 naming why (the requirement: the Antwortlimit or a Veranstaltung filled up
 * again while the answer was away). The refusal's sentence travels as a plain
 * `{ message }` body, which `ApiError.detail` already reads (`api/http.ts`) —
 * `TrashView.tsx` shows that sentence rather than composing its own, the same
 * pattern `FormMembersView` uses for the self-lockout guard.
 *
 * Same `onSettled`/`onSuccess` split as {@link useRestoreForm}. `FORMS_QUERY_KEY`
 * (`['forms']`) alone covers the form's own responses table as well: TanStack
 * Query matches a key as a **prefix**, and `responsesQueryKey(formId)` is
 * `['forms', formId, 'responses']` — invalidating the shorter key already
 * reaches it, so naming the longer one too would be the same refetch requested
 * twice (the rule `api/form-members.ts` writes out in full).
 */
export function useRestoreResponse(): UseMutationResult<
  void,
  Error,
  RestoreResponseVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, responseId }: RestoreResponseVariables) =>
      requestVoid(
        `/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(responseId)}/restore`,
        {
          method: 'POST',
        },
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

/**
 * **Physical deletion of a form** — physically, out of the trash
 * for good. `DELETE /forms/:id/permanent`, guarded on the
 * server by `canBuild` **and** `canViewResponses` — a stronger
 * bar than restoring the same row, which is why `TrashView.tsx` reads a
 * separate `canPurge` prop rather than reusing whatever gated the page.
 *
 * **Only `onSuccess` invalidates**, unlike {@link useRestoreForm}'s
 * `onSettled`: a purge either removes the row or changes nothing at all — a
 * 403, a 404 (someone else already acted on it) or the storage's 503 all
 * leave the trash exactly as it was, so there is no stale count to chase
 * the way a refused *restore* leaves one.
 */
export function usePurgeForm(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (formId: string) =>
      requestVoid(`/forms/${encodeURIComponent(formId)}/permanent`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
  });
}

/**
 * **Physical deletion of an answer**  —
 * `DELETE /forms/:formId/responses/:responseId/permanent`, same guard pair and
 * the same reasoning on `onSuccess` alone as {@link usePurgeForm}.
 */
export function usePurgeResponse(): UseMutationResult<
  void,
  Error,
  RestoreResponseVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, responseId }: RestoreResponseVariables) =>
      requestVoid(
        `/forms/${encodeURIComponent(formId)}/responses/${encodeURIComponent(responseId)}/permanent`,
        {
          method: 'DELETE',
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
  });
}

/**
 * **🗑 Papierkorb leeren** — physically, in batches of
 * {@link TRASH_PURGE_BATCH_SIZE} . `DELETE /trash`, same
 * guard pair as the two purges above.
 *
 * Answers a body, not 204 — `trashPurgeResultSchema` parses it, and
 * `TrashView.tsx` reads `remaining` to offer a second run and `failed` to say
 * what did not go. `onSuccess` always invalidates: unlike a single purge, this
 * call can never be a no-op that leaves the trash exactly as it found it
 * — even a call that purges nothing still recounts `remaining` against
 * whatever anyone else did meanwhile.
 */
export function useEmptyTrash(): UseMutationResult<
  TrashPurgeResult,
  Error,
  void
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async () =>
      trashPurgeResultSchema.parse(
        await requestJson('/trash', { method: 'DELETE' }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
  });
}
