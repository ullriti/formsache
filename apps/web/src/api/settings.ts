import {
  EMPTY_LEGAL_DOCUMENT,
  completeFormSettingsSchema,
  completeTenantSettingsSchema,
  formSettingsPatchSchema,
  legalDocumentSchema,
  settingsOverriddenSchema,
  type FormSettings,
  type LegalDocument,
  type PartialFormSettings,
  type PartialTenantFormSettings,
  type SettingsOverridden,
  type TenantFormSettings,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { requestJson } from './http';

/**
 * Server state of the form settings and the organisation's form standards
 *  — TanStack Query only, like `forms.ts` next door.
 *
 * ## Why the envelope is described here and not in `@formsache/shared`
 *
 * The field shapes, the bounds and the cross-field rules all come from
 * `form-settings.ts`; what is added below is only *which document sits next to
 * which*. The server states the same envelope in
 * `apps/api/src/settings/settings-wire.ts` as TypeScript interfaces, because it
 * produces them and has nothing to validate on the way out. The client has to
 * parse — foreign data arrives as `unknown` (`CONTRIBUTING.md`) — so it needs a
 * schema, and this is the seam where one is missing from the shared package.
 * **Worth lifting into `@formsache/shared` when the wire grows**, which it is about
 * to: the settings get their own `revision` (Konzept no. 21).
 *
 * ## The envelope is deliberately not strict
 *
 * `z.object` strips unknown keys instead of refusing them. That is what lets
 * this client run against a server that has already grown `revision` and
 * against one that has not — the alternative would be a frontend that breaks
 * the moment the backend ships a purely additive field.
 *
 * ## Why the settings documents are parsed as *complete* ones
 *
 * `completeFormSettingsSchema`, not the schema that fills gaps. The
 * bottom layer of the inheritance is a **row in the server's database**, and
 * this client has no access to it and must not invent one: a schema that filled
 * a missing key from the shipped constant would quietly show a value the server
 * never computed, and would go on doing so for as long as the two disagreed.
 * `tenantDefaults` and `effective` are complete by contract — the server runs
 * `effectiveSettings()` over both layers — so a truncated document is a
 * server that regressed, and hearing about it at load time is the point.
 *
 * `values` is the exception and stays partial: it is the form's *own* document,
 * and only the sections it has taken over carry keys.
 */

/**
 * Optimistic-locking counter of a settings document (Konzept no. 21).
 *
 * **Required, both ways.** The server refuses a write without it, and this
 * client refuses to render a document without it — an optional lock is one that
 * gets forgotten, and the loss it guards against here is section-shaped: two
 * editors who never see each other delete each other's whole sections, access
 * word included. Parsing it as required means a server that stopped sending it
 * fails at load time, where somebody notices, rather than at save time.
 */
const revisionSchema = z.number().int().positive();

const formSettingsResponseSchema = z.object({
  overridden: settingsOverriddenSchema,
  /** Only the sections the form has taken over carry keys here. */
  values: formSettingsPatchSchema,
  tenantDefaults: completeTenantSettingsSchema,
  /** `effectiveSettings()` as the **server** computed it — the one merge. */
  effective: completeFormSettingsSchema,
  revision: revisionSchema,
  /**
   * The revision of the **organisation's standards** this page was built from.
   *
   * A second counter, and not redundancy: switching a section on *copies* the
   * values that apply right now, so a standard that moved between loading and
   * saving would hand the editor values they never saw. The server compares it
   * only for a write that switches something on.
   */
  tenantRevision: revisionSchema,
  /**
   * The privacy notice of this form (ADR-0028 no. 4).
   *
   * `.prefault(EMPTY_LEGAL_DOCUMENT)` — and that is the right direction
   * here, unlike with `revision` above: a server that is one version
   * behind does not send the field, and „nichts hinterlegt" is exactly
   * the statement that is true then. The page would otherwise show no
   * settings at all, because the whole document failed to parse — a
   * high price for a field that has no effect without an entry.
   */
  privacyNotice: legalDocumentSchema.prefault(EMPTY_LEGAL_DOCUMENT),
});

export interface FormSettingsDocument {
  readonly overridden: SettingsOverridden;
  readonly values: PartialFormSettings;
  readonly tenantDefaults: TenantFormSettings;
  readonly effective: FormSettings;
  readonly revision: number;
  readonly tenantRevision: number;
  readonly privacyNotice: LegalDocument;
}

/**
 * The organisation's standards — **one document**, since review finding 10.
 *
 * There were four: which sections are taken over, what stands in them, what a
 * section not taken over falls back to, and what follows from that. Without the switch
 * „Vorgabe ⇄ Angepasst" they coincide — the organisation has a
 * complete set of values, and that stands here.
 *
 * **`TenantFormSettings` and not `FormSettings`** (ADR-0011, continuation
 * 2026-08-14): an organisation has no *Verfügbarkeit*, and the schema says
 * so, instead of the page having to remember it.
 */
const tenantFormDefaultsResponseSchema = z.object({
  /** Complete: every form of this organisation inherits exactly that. */
  values: completeTenantSettingsSchema,
  revision: revisionSchema,
});

export interface TenantFormDefaultsDocument {
  readonly values: TenantFormSettings;
  readonly revision: number;
}

export function formSettingsQueryKey(formId: string): readonly string[] {
  return ['form-settings', formId];
}

/**
 * Cache key of the organisation's standards — **scoped to the organisation**.
 *
 * The endpoint names no tenant in its path: it always answers for the active
 * session. A single unscoped key would therefore hand tenant B the document of
 * tenant A on the first render after a switch, and the page would offer to save
 * one organisation's values into the other's standards.
 */
export function tenantFormDefaultsQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-form-defaults', tenantId ?? 'none'];
}

/**
 * The four documents the settings page of one form is built from.
 *
 * `enabled` since the requirement, and for the reason `useForms` already
 * carries one: the Testmodus renders for `canBuild` alone, while this route
 * requires `canManageFormSettings` — asking anyway would turn a state the view can
 * explain („dieses Recht fehlt") into a 403 it cannot. Defaults to `true`, so
 * the settings page itself is unchanged.
 */
export function useFormSettings(
  formId: string,
  enabled = true,
): UseQueryResult<FormSettingsDocument> {
  return useQuery({
    queryKey: formSettingsQueryKey(formId),
    enabled,
    queryFn: async () =>
      formSettingsResponseSchema.parse(
        await requestJson(`/forms/${encodeURIComponent(formId)}/settings`, {
          method: 'GET',
        }),
      ),
  });
}

export interface SaveFormSettingsVariables {
  readonly formId: string;
  /**
   * **All four switches, every time** — never only the one that changed.
   *
   * `PUT` replaces the whole switch document: a section the request does not
   * mention is a section that goes back to following the organisation, and going back
   * *discards* that section's values (`setSectionOverride`). A client that
   * "optimised away" the three unchanged booleans would therefore delete a
   * deadline and an access word with a 200 and no warning — a review
   * reproduced exactly that against the live route. `SettingsOverridden` is the
   * schema's **output** type, so all four keys are required and the compiler
   * refuses the partial write; `withSection()` spreads the previous document
   * for the same reason.
   */
  readonly overridden: SettingsOverridden;
  /** A patch: only the fields the editor changed, of unlocked sections only. */
  readonly values: PartialFormSettings;
  /** The revision this editor started from — echoed back unchanged. */
  readonly revision: number;
  /** The standards revision of the same load — see the response schema. */
  readonly tenantRevision: number;
  /**
   * The privacy notice of this form — **always whole**, never a patch.
   *
   * The same full-replacement rule as `overridden` above and for the same
   * reason: the document has two halves that have to stay standing beside
   * each other (template and own text), and a client that sent only the changed
   * one deleted the other.
   */
  readonly privacyNotice: LegalDocument;
}

/**
 * Writes the settings of one form.
 *
 * `retry: false` for the same reason as `useSaveForm`: a 409 means someone else
 * saved in the meantime, and repeating the request with the same stale revision
 * would either fail again or — once retried with a fresh one — perform exactly
 * the silent overwrite the check exists to prevent. The view reports it with
 * `isStaleRevision` and asks for a reload.
 */
export function useSaveFormSettings(): UseMutationResult<
  FormSettingsDocument,
  Error,
  SaveFormSettingsVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({
      formId,
      overridden,
      values,
      revision,
      tenantRevision,
      privacyNotice,
    }: SaveFormSettingsVariables) =>
      formSettingsResponseSchema.parse(
        await requestJson(`/forms/${encodeURIComponent(formId)}/settings`, {
          method: 'PUT',
          body: {
            overridden,
            values,
            revision,
            tenantRevision,
            privacyNotice,
          },
        }),
      ),
    onSuccess: (document, { formId }) => {
      queryClient.setQueryData(formSettingsQueryKey(formId), document);
    },
  });
}

/**
 * The organisation's form standards — the bottom of the inheritance.
 *
 * Without a scoped tenant the query stays idle: every tenant-bound route
 * answers 403 in that state, and asking anyway turns a state the app can
 * explain („bitte eine Organisation wählen") into an error it cannot.
 */
export function useTenantFormDefaults(
  tenantId: string | undefined,
): UseQueryResult<TenantFormDefaultsDocument> {
  return useQuery({
    queryKey: tenantFormDefaultsQueryKey(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () =>
      tenantFormDefaultsResponseSchema.parse(
        await requestJson('/tenant/form-defaults', { method: 'GET' }),
      ),
  });
}

/**
 * Writes the organisation's form standards.
 *
 * **Invalidates every form's settings afterwards**, not just its own cache
 * entry. A tenant standard reaches every form that has *not* taken the section
 * over (case 1), so a cached `effective` from before the write
 * is stale for reasons this query key knows nothing about — and a settings page
 * still showing the old inherited deadline would make the inheritance look
 * broken exactly where this invalidation exists to make a change's reach
 * observable.
 */
export interface SaveTenantFormDefaultsVariables {
  /**
   * The organisation whose standards these are — the one the page was showing, not
   * „whichever is active when the answer arrives". It only writes the cache
   * entry; the server scopes the write to the session either way.
   */
  readonly tenantId: string;
  /**
   * A patch: only the fields the editor changed.
   *
   * No `overridden` any more (review finding 10) — there is no section that
   * could be „nicht übernommen", and thereby also no field whose forgetting
   * would reset three sections of a whole organisation.
   *
   * `PartialTenantFormSettings` and not `PartialFormSettings`: the server
   * reads this route with `tenantSettingsWriteSchema`, which rejects *Verfügbarkeit*
   * with 400 — an organisation prescribes no deadline. A client type that
   * carries the keys promises a field the contract does not know.
   */
  readonly values: PartialTenantFormSettings;
  /** The standards revision this editor started from (Konzept no. 21). */
  readonly revision: number;
}

export function useSaveTenantFormDefaults(): UseMutationResult<
  TenantFormDefaultsDocument,
  Error,
  SaveTenantFormDefaultsVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ values, revision }: SaveTenantFormDefaultsVariables) =>
      tenantFormDefaultsResponseSchema.parse(
        await requestJson('/tenant/form-defaults', {
          method: 'PUT',
          body: { values, revision },
        }),
      ),
    onSuccess: async (document, { tenantId }) => {
      queryClient.setQueryData(tenantFormDefaultsQueryKey(tenantId), document);
      await queryClient.invalidateQueries({ queryKey: ['form-settings'] });
    },
  });
}
