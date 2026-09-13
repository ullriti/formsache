import {
  publicLegalFooterSchema,
  publicLegalPageSchema,
  systemLegalPagesSchema,
  tenantLegalPagesSchema,
  type PublicLegalFooter,
  type PublicLegalPage,
  type SystemLegalPage,
  type SystemLegalPages,
  type TenantLegalPage,
  type TenantLegalPages,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { requestJson } from './http';

/**
 * Server state of the legal texts (ADR-0028) — **three consumers, three
 * keys**.
 *
 * 1. The system administration writes the three pages of the installation.
 * 2. The organisation administration writes its two.
 * 3. The **public** path reads one rendered page and the footer —
 *    without a session, without a CSRF token, without anything.
 *
 * The third is the reason why the requests of the public path stand here and
 * not in `api/public-form.ts`: they belong to *this* subject and
 * not to the filling in. What they share with the fill-in path is the one
 * property that is written out there — no session is touched.
 *
 * `z.object` and not `z.strictObject`: an additional field on the server
 * must not break this client, as next door.
 */

const revisionSchema = z.number().int().positive();

const systemLegalResponseSchema = z.object({
  pages: systemLegalPagesSchema,
  lock: revisionSchema,
  /**
   * **Ob die KI-Funktion dieser Installation eingerichtet ist**
   * (Review-Runde 5 Nr. 2).
   *
   * Es steht hier, weil die Felderliste der Datenschutzerklärung davon abhängt:
   * `visibleSlots` lässt die Felder eines abgewählten Blocks weg, und solange
   * diese Seite `aiActive: false` **annahm**, waren die sieben Felder des
   * KI-Abschnitts unerreichbar — während die veröffentlichte Seite den
   * Abschnitt zeigte, weil der Server dort die Wahrheit liest.
   *
   * Nur der Wahrheitswert, kein Stück der KI-Konfiguration. Die
   * Organisationsfassung derselben Karte hat ihn nicht und kann ihn nicht
   * haben — die KI-Einstellungen sind Systemeinstellungen
   * (`TenantLegalTab.tsx`).
   */
  aiActive: z.boolean(),
});
export type SystemLegalDocument = z.infer<typeof systemLegalResponseSchema>;

const tenantLegalResponseSchema = z.object({
  pages: tenantLegalPagesSchema,
  lock: revisionSchema,
});
export type TenantLegalDocument = z.infer<typeof tenantLegalResponseSchema>;

export const SYSTEM_LEGAL_QUERY_KEY: readonly string[] = [
  'system-settings',
  'legal',
];

export function useSystemLegal(): UseQueryResult<SystemLegalDocument> {
  return useQuery({
    queryKey: SYSTEM_LEGAL_QUERY_KEY,
    queryFn: async () =>
      systemLegalResponseSchema.parse(
        await requestJson('/admin/system-settings/legal', { method: 'GET' }),
      ),
  });
}

export interface SaveSystemLegalVariables {
  /** Full replacement, no patch — the page holds the whole document. */
  readonly pages: SystemLegalPages;
  readonly lock: number;
}

/**
 * Writes the legal texts of the installation.
 *
 * `retry: false` for the reason that every write of the settings has here: a
 * 409 means that somebody else has meanwhile saved the same document, and a
 * repetition would either fail again or quietly overwrite what the lock is
 * meant to protect.
 *
 * ⚠️ Additionally everything under `['public-legal']` is invalidated: the
 * public footer carries the name of the operator from **this** document, and
 * without this line an open preview would show the old one until the next
 * load.
 */
export function useSaveSystemLegal(): UseMutationResult<
  SystemLegalDocument,
  Error,
  SaveSystemLegalVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (variables: SaveSystemLegalVariables) =>
      systemLegalResponseSchema.parse(
        await requestJson('/admin/system-settings/legal', {
          method: 'PUT',
          body: variables,
        }),
      ),
    onSuccess: (document) => {
      queryClient.setQueryData(SYSTEM_LEGAL_QUERY_KEY, document);
      void queryClient.invalidateQueries({ queryKey: ['public-legal'] });
    },
  });
}

export const TENANT_LEGAL_QUERY_KEY: readonly string[] = ['tenant', 'legal'];

export function useTenantLegal(
  tenantId: string | undefined,
): UseQueryResult<TenantLegalDocument> {
  return useQuery({
    /**
     * The id of the organisation belongs in the key, although the route
     * does not name it: the server resolves it from the session, and a
     * change of the active organisation must therefore hit a **different**
     * cache entry. Without it the new organisation would show the
     * legal texts of the old one, until something invalidates them.
     */
    queryKey: [...TENANT_LEGAL_QUERY_KEY, tenantId ?? 'none'],
    enabled: tenantId !== undefined,
    queryFn: async () =>
      tenantLegalResponseSchema.parse(
        await requestJson('/tenant/legal', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantLegalVariables {
  readonly tenantId: string;
  readonly pages: TenantLegalPages;
  readonly lock: number;
}

export function useSaveTenantLegal(): UseMutationResult<
  TenantLegalDocument,
  Error,
  SaveTenantLegalVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (variables: SaveTenantLegalVariables) =>
      tenantLegalResponseSchema.parse(
        await requestJson('/tenant/legal', {
          method: 'PUT',
          body: { pages: variables.pages, lock: variables.lock },
        }),
      ),
    onSuccess: (document, variables) => {
      queryClient.setQueryData(
        [...TENANT_LEGAL_QUERY_KEY, variables.tenantId],
        document,
      );
      void queryClient.invalidateQueries({ queryKey: ['public-legal'] });
    },
  });
}

// ---------------------------------------------------------------------------
// The public path
// ---------------------------------------------------------------------------

export const PUBLIC_LEGAL_FOOTER_QUERY_KEY: readonly string[] = [
  'public-legal',
  'footer',
];

/**
 * What the footer knows about the installation.
 *
 * `retry: false` and a silent failure: if the fetch drops out, „Betrieb dieser
 * Plattform" stands in the footer without a name — the links stay. A
 * footer that **disappears** because of a network error would be the one
 * outage this function must not have (§ 18 MStV: „ständig
 * verfügbar").
 */
export function usePublicLegalFooter(): UseQueryResult<PublicLegalFooter> {
  return useQuery({
    queryKey: PUBLIC_LEGAL_FOOTER_QUERY_KEY,
    retry: false,
    queryFn: async () =>
      publicLegalFooterSchema.parse(
        await requestJson('/public/legal', { method: 'GET' }),
      ),
  });
}

export function usePublicSystemLegalPage(
  page: SystemLegalPage,
): UseQueryResult<PublicLegalPage> {
  return useQuery({
    queryKey: ['public-legal', 'system', page],
    queryFn: async () =>
      publicLegalPageSchema.parse(
        await requestJson(`/public/legal/system/${encodeURIComponent(page)}`, {
          method: 'GET',
        }),
      ),
  });
}

export function usePublicTenantLegalPage(
  shortName: string,
  page: TenantLegalPage,
): UseQueryResult<PublicLegalPage> {
  return useQuery({
    queryKey: ['public-legal', 'tenant', shortName, page],
    queryFn: async () =>
      publicLegalPageSchema.parse(
        await requestJson(
          `/public/legal/tenant/${encodeURIComponent(shortName)}/${encodeURIComponent(page)}`,
          { method: 'GET' },
        ),
      ),
  });
}
