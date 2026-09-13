import {
  parseDeletedTenantList,
  parseTenantOverview,
  tenantOverviewRowSchema,
  type DeletedTenantList,
  type TenantCreate,
  type TenantOverview,
  type TenantOverviewRow,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';
import { SESSION_QUERY_KEY } from './session';

/**
 * Server state of the superadmin overview.
 *
 * Behind `GET`/`POST /api/admin/tenants` — routes of their own, and
 * deliberately not a parameter bolted onto `/api/tenant/…`: that surface
 * carries no tenant in its path on purpose, and the
 * superadmin overview is the one place in this application that has to
 * address a foreign Organisation. See `AdminTenantsController` for the guard chain
 * this client answers to (`SessionGuard`, `SuperadminGuard` — no
 * `TenantScopeGuard`, because this surface belongs to no organisation).
 */

/** One cache entry for the whole table, so a create can refresh it in place. */
export const TENANT_OVERVIEW_QUERY_KEY = ['admin', 'tenants'] as const;

/** The KPI tiles and the table of every organisation. Unconditional, like the system layer. */
export function useTenantOverview(): UseQueryResult<TenantOverview> {
  return useQuery({
    queryKey: TENANT_OVERVIEW_QUERY_KEY,
    queryFn: async () =>
      parseTenantOverview(
        await requestJson('/admin/tenants', { method: 'GET' }),
      ),
  });
}

/**
 * „+ Neue Organisation" .
 *
 * `retry: false`, like every write in this application that can fail on a
 * uniqueness conflict: repeating the same request would only fail the same
 * way again, and the 409 already names the field to fix.
 *
 * Refetches the whole overview afterwards rather than splicing the new row in
 * by hand — the KPI totals are sums over every row (`AdminService.overview`),
 * and a client-side sum kept next to the server's is the second place that
 * number can drift.
 *
 * **And the session with it.** Creating an organisation with one's own address as the
 * first admin creates a `membership` — the
 * only decided way a superadmin gets into a new Organisation at all. Memberships live
 * in `GET /auth/me`, not in this module's overview: without invalidating the
 * session query the fresh row reads „Kein Mitglied in dieser Organisation" and offers
 * neither „Wechseln" nor „Verwalten", and the organisation switcher in the header does
 * not know the organisation either — the decided way looks like a failure at the moment
 * it succeeded. The same reasoning `tenant-admin.ts` gives for
 * invalidating the session on every member and group write.
 */
export function useCreateTenant(): UseMutationResult<
  TenantOverviewRow,
  Error,
  TenantCreate
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (request: TenantCreate) =>
      tenantOverviewRowSchema.parse(
        await requestJson('/admin/tenants', { method: 'POST', body: request }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: TENANT_OVERVIEW_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]);
    },
  });
}

/**
 * **„Gelöschte Organisationen"** — the section of this same overview a deleted Organisation
 * comes back from. `GET /admin/tenants/deleted`.
 *
 * **Its own query key, `['admin', 'tenants', 'deleted']`, deliberately a
 * child of {@link TENANT_OVERVIEW_QUERY_KEY}.** TanStack Query matches a key
 * as a prefix, so invalidating the shorter key already reaches this one — the
 * rule `api/trash.ts` and `api/form-members.ts` both spell out for the same
 * shape. `useDeleteTenant` and `useRestoreTenant` below invalidate only the
 * parent key, once, and both lists refetch.
 */
export const DELETED_TENANTS_QUERY_KEY = [
  ...TENANT_OVERVIEW_QUERY_KEY,
  'deleted',
] as const;

export function useDeletedTenants(): UseQueryResult<DeletedTenantList> {
  return useQuery({
    queryKey: DELETED_TENANTS_QUERY_KEY,
    queryFn: async () =>
      parseDeletedTenantList(
        await requestJson('/admin/tenants/deleted', { method: 'GET' }),
      ),
  });
}

export interface TenantDeleteVariables {
  readonly tenantId: string;
  /** The organisation's own `name`, typed by hand — checked against it on the server. */
  readonly confirmName: string;
}

/**
 * **Deleting an organisation — into the trash, 30 days** . `DELETE /admin/tenants/:tenantId`, body `{ confirmName }`.
 *
 * **The comparison is the server's, not this hook's.** `confirmName` travels
 * as typed; a mismatch answers 409 with `TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE`
 * (`@formsache/shared`), which `actionErrorMessage` already reads off `error.detail`
 * for every 409 in this application — nothing here compares the two strings
 * itself. The dialog that collects the value is UX, never the boundary
 * (`CONTRIBUTING.md`).
 *
 * **And the session with it** — the same reasoning `useCreateTenant` above
 * gives, for the direction that actually takes something away.
 *
 * „Löschen" sits on **every** row of the overview, including the one marked
 * „✓ Aktiv", and the server does not refuse that one. Deleting the organisation the
 * session is currently scoped to withdraws the membership that scope rests on:
 * from that moment every tenant-bound request behind this screen answers 403,
 * while the header, the logo, the organisation switcher and every permission the
 * shell reads still come from a `GET /auth/me` answered before the delete.
 * Invalidating only the overview left the surface showing an organisation that no
 * longer exists for this session — the client half of the requirement
 * the evidence, enforced on the server and unmentioned here.
 */
export function useDeleteTenant(): UseMutationResult<
  void,
  Error,
  TenantDeleteVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ tenantId, confirmName }: TenantDeleteVariables) =>
      requestVoid(`/admin/tenants/${encodeURIComponent(tenantId)}`, {
        method: 'DELETE',
        body: { confirmName },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: TENANT_OVERVIEW_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]);
    },
  });
}

/**
 * **Bringing a deleted organisation back** .
 * `POST /admin/tenants/:tenantId/restore` — no confirmation to type, the same
 * reasoning `api/trash.ts` gives for every restore in this application: a
 * hurdle in front of the way back turns a mistake into a permanent one.
 *
 * **The session is invalidated here too**, for the mirror image of the reason
 * `useDeleteTenant` gives: bringing an organisation back gives its memberships back with
 * it, so whoever was locked out of their own scope by the delete gets the
 * header, the switcher and their permissions returned without a reload.
 */
export function useRestoreTenant(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (tenantId: string) =>
      requestVoid(`/admin/tenants/${encodeURIComponent(tenantId)}/restore`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: TENANT_OVERVIEW_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]);
    },
  });
}

/** What {@link useSetAiQuota} needs: which Organisation, and the new number. */
export interface AiQuotaVariables {
  readonly tenantId: string;
  readonly monthlyCallLimit: number;
}

/**
 * **Setting the AI quota of an organisation**  —
 * `PUT /admin/tenants/:tenantId/ai-quota`.
 *
 * It lies in *this* module and not in `api/tenant-admin.ts`, because it is the
 * question of the operator and not that of the organisation: an
 * organisation admin who could raise their own budget would be a cost lever
 * without a guard. What an organisation **reads** about itself stands in
 * `api/ai-forms.ts`.
 *
 * **The session is not invalidated here**, unlike at deleting and
 * bringing back: no membership and no right changes, only a number.
 * What changes is the overview — and `aiFormsAvailable` stays what it
 * was, because it means the *key* of the installation and not the budget
 * of an organisation (`sessionUserSchema`).
 */
export function useSetAiQuota(): UseMutationResult<
  void,
  Error,
  AiQuotaVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ tenantId, monthlyCallLimit }: AiQuotaVariables) =>
      requestVoid(`/admin/tenants/${encodeURIComponent(tenantId)}/ai-quota`, {
        method: 'PUT',
        body: { monthlyCallLimit },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: TENANT_OVERVIEW_QUERY_KEY,
      });
    },
  });
}
