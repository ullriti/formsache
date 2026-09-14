import {
  groupDetailSchema,
  groupListSchema,
  oidcConfigSchema,
  parseMailIdentityConfig,
  parseTenantAiSwitch,
  parseTenantBaseUrl,
  parseTenantBrandingSettings,
  parseTenantReplyTo,
  parseTestMailResult,
  tenantBrandingSettingsSchema,
  tenantMemberListSchema,
  tenantMemberCreatedSchema,
  tenantMemberSchema,
  tenantNotificationTemplatesResponseSchema,
  type GroupDetail,
  type GroupList,
  type GroupWrite,
  type MailIdentityConfig,
  type MailIdentityWrite,
  type NotificationTemplate,
  type OidcConfig,
  type OidcConfigWrite,
  parseSessionRevocation,
  type SessionRevocation,
  type TenantAiSwitch,
  type TenantBaseUrl,
  type TenantBaseUrlWrite,
  type TenantBrandingSettings,
  type TenantBrandingWrite,
  type TenantMember,
  type TenantMemberCreated,
  type TenantMemberCreate,
  type TenantMemberList,
  type TenantMemberUpdate,
  type TenantNotificationTemplatesResponse,
  type TenantReplyTo,
  type TenantReplyToWrite,
  type TestMailResult,
  type UpdateTenantAiSwitchRequest,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import { csrfHeaders, requestJson, requestUpload, requestVoid } from './http';
import { SESSION_QUERY_KEY } from './session';

/**
 * Server state of the tenant administration — TanStack Query only, like `settings.ts` and
 * `system-settings.ts` next door.
 *
 * Every shape, every bound and every cross-field rule lives in
 * `@formsache/shared` (`branding.ts`, `tenant-admin.ts`); what is added here is
 * only *which document sits next to which* and *which query key it is cached
 * under* — the wire contract is not restated (`CONTRIBUTING.md`).
 *
 * ## Why every query key carries the organisation, although no route does
 *
 * None of the routes behind this module take a tenant id in their path — the
 * server always resolves the session's *active* Organisation (the requirement's
 * design, repeated for branding, OIDC, users and groups). A single unscoped
 * cache key would therefore hand Organisation B the branding, members or groups of
 * Organisation A for one render after a switch, and „Speichern" would write one
 * organisation's colours into the other's row — the exact bug `tenantFormDefaultsQueryKey`
 * was written to close. Every hook below repeats that shape.
 *
 * ## Why a save invalidates the session query
 *
 * `AppShell` reads the active theme from `GET /auth/me`'s `memberships`, not
 * from this module's own branding query — the header, the stripe and every
 * `--tenant-*` axis are painted from the session. A branding save that only
 * updated its own cache entry would show the new colours on the
 * *Erscheinungsbild*-tab and the old ones everywhere else until the next
 * reload, which is the opposite of the handoff's „Änderungen werden sofort
 * übernommen". A group save gets the same treatment for the same reason one
 * layer down: the evidence asks for the *server* to enforce a
 * revoked permission without a new login, and the navigation entries this
 * session already rendered should not keep showing one it no longer has.
 */

function invalidateSession(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
}

// ---------------------------------------------------------------------------
// Branding — Erscheinungsbild & Login, colour half
// ---------------------------------------------------------------------------

export function tenantBrandingQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-branding', tenantId ?? 'none'];
}

/** Without a scoped tenant the query stays idle — the view asks for one first. */
export function useTenantBranding(
  tenantId: string | undefined,
): UseQueryResult<TenantBrandingSettings> {
  return useQuery({
    queryKey: tenantBrandingQueryKey(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () =>
      parseTenantBrandingSettings(
        await requestJson('/tenant/branding', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantBrandingVariables {
  /** The organisation the page was showing — only decides which cache entry updates. */
  readonly tenantId: string;
  readonly write: TenantBrandingWrite;
}

export function useSaveTenantBranding(): UseMutationResult<
  TenantBrandingSettings,
  Error,
  SaveTenantBrandingVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveTenantBrandingVariables) =>
      tenantBrandingSettingsSchema.parse(
        await requestJson('/tenant/branding', {
          method: 'PUT',
          body: write,
        }),
      ),
    onSuccess: async (document, { tenantId }) => {
      queryClient.setQueryData(tenantBrandingQueryKey(tenantId), document);
      await invalidateSession(queryClient);
    },
  });
}

export interface UploadTenantLogoVariables {
  /** The organisation the page was showing — only decides which cache entry updates. */
  readonly tenantId: string;
  readonly file: File;
}

/**
 * **Das eigene Logo hochladen** .
 *
 * The answer is the whole branding document, not a reference, because the
 * upload **is** the replacement on the server: `logo_ref` and
 * `branding_revision` have both moved by the time this resolves
 * (`TenantLogoService`). Writing the answer into the cache is therefore not a
 * convenience — a tab that kept the previous revision would answer 409 on its
 * next colour save, for a change the same admin had just made.
 *
 * The session is invalidated with it, exactly as the colour save does: the
 * header's `TenantMark` renders the logo out of the session payload, so
 * skipping that leaves the new logo on the tab and the old one on every other
 * page until a reload.
 */
export function useUploadTenantLogo(): UseMutationResult<
  TenantBrandingSettings,
  Error,
  UploadTenantLogoVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ file }: UploadTenantLogoVariables) =>
      tenantBrandingSettingsSchema.parse(
        // **With the CSRF header**, unlike the public upload: this route rides
        // a session, so it is not `@CsrfExempt()` (ADR-0014 no. 14).
        await requestUpload('/tenant/branding/logo', file, csrfHeaders()),
      ),
    onSuccess: async (document, { tenantId }) => {
      queryClient.setQueryData(tenantBrandingQueryKey(tenantId), document);
      await invalidateSession(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// OIDC — Erscheinungsbild & Login, identity half
// ---------------------------------------------------------------------------

export function tenantOidcQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-oidc', tenantId ?? 'none'];
}

/**
 * The organisation's identity-provider configuration.
 *
 * A 403 here (only `canManageSettings`, not `canManageUsers`) is not treated
 * as a load failure by the query itself — `TenantOidcSection` reads
 * `isError`/`error` and renders the block **absent** rather than disabled
 * (the controller's own comment on this asymmetry).
 */
export function useOidcConfig(
  tenantId: string | undefined,
): UseQueryResult<OidcConfig> {
  return useQuery({
    queryKey: tenantOidcQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      oidcConfigSchema.parse(
        await requestJson('/tenant/oidc', { method: 'GET' }),
      ),
  });
}

export interface SaveOidcConfigVariables {
  readonly tenantId: string;
  readonly write: OidcConfigWrite;
}

export function useSaveOidcConfig(): UseMutationResult<
  OidcConfig,
  Error,
  SaveOidcConfigVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveOidcConfigVariables) =>
      oidcConfigSchema.parse(
        await requestJson('/tenant/oidc', { method: 'PUT', body: write }),
      ),
    onSuccess: async (document, { tenantId }) => {
      queryClient.setQueryData(tenantOidcQueryKey(tenantId), document);
      // Switching SSO on or off changes which auth option „Person hinzufügen"
      // may offer, and the login screen's own provider list, so the members
      // tab has to see this write too.
      await queryClient.invalidateQueries({
        queryKey: tenantOidcQueryKey(tenantId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// SMTP — Mailversand (ADR-0013, ADR-0023)
// ---------------------------------------------------------------------------

export function tenantSmtpQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-smtp', tenantId ?? 'none'];
}

/**
 * The mail server of this organisation — `{ smtp: null }` for „noch keiner
 * eingetragen" or the complete block (ADR-0023; until then `null` was the
 * inheritance from the system, and that is exactly what has been abolished).
 *
 * **A 500 here is not a load failure like any other** (a review finding on
 * `smtp-config.service.ts`): the stored block does not match the wire
 * contract, and the route refuses to guess at it rather than showing „noch
 * keiner eingetragen" for an organisation whose stored block would in fact
 * make every row `failed` (ADR-0013 no. 4,
 * *fail closed*). `MailIdentityCard` reads `isError`/`error` itself and
 * renders a repair form rather than only an error banner — the `PUT` stays
 * reachable on purpose.
 *
 * `retry: false`, like every other document-shaped query in this module: a
 * 403 or the 500 above would otherwise be retried against an unchanged
 * answer before the view ever sees it.
 */
export function useTenantSmtp(
  tenantId: string | undefined,
): UseQueryResult<MailIdentityConfig> {
  return useQuery({
    queryKey: tenantSmtpQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      parseMailIdentityConfig(
        await requestJson('/tenant/smtp', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantSmtpVariables {
  readonly tenantId: string;
  readonly write: MailIdentityWrite;
}

/**
 * Replaces the block — the **whole** document, never a field of it
 * . No `lock`/revision: `mailIdentityWriteSchema` carries none,
 * the same last-write-wins shape `useSaveOidcConfig` already has for the
 * organisation's other single-document block.
 */
export function useSaveTenantSmtp(): UseMutationResult<
  MailIdentityConfig,
  Error,
  SaveTenantSmtpVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveTenantSmtpVariables) =>
      parseMailIdentityConfig(
        await requestJson('/tenant/smtp', { method: 'PUT', body: write }),
      ),
    onSuccess: (document, { tenantId }) => {
      queryClient.setQueryData(tenantSmtpQueryKey(tenantId), document);
    },
  });
}

/**
 * What a „Testmail senden" sends along — **one address or none at all**.
 *
 * `null` means „to my own address" and is what the button sends without any
 * further doing. The request carries no more: `testMailRequestSchema` is a
 * `strictObject` with exactly this one field, so there is no field into which
 * this client could accidentally write a host or a password. What is addressed
 * is always the **stored** block, never the draft on screen —
 * `MailIdentityCard` locks the button on `dirty` for exactly that reason,
 * rather than this hook quietly sending a draft.
 */
export interface TestMailVariables {
  readonly recipientEmail: string | null;
}

/**
 * „Testmail senden" via the block **of this organisation** (own or inherited).
 *
 * Not cached — this is an action, not a document. The system variant is in
 * `api/system-settings.ts` and is deliberately a second hook on a second
 * route: which identity is checked is decided by the server at the route and
 * not at a field this client could send along.
 */
export function useSendTestMail(): UseMutationResult<
  TestMailResult,
  Error,
  TestMailVariables
> {
  return useMutation({
    retry: false,
    mutationFn: async (variables: TestMailVariables) =>
      parseTestMailResult(
        await requestJson('/tenant/smtp/test', {
          method: 'POST',
          body: variables,
        }),
      ),
  });
}

// ---------------------------------------------------------------------------
// Base address — Mailversand, Basis-Adresse-Abschnitt (ADR-0013 no. 3)
// ---------------------------------------------------------------------------

export function tenantBaseUrlQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-base-url', tenantId ?? 'none'];
}

/**
 * The organisation's own base address — `{ baseUrl: string | null }`, `null` for
 * „keine eigene, die Systemvorgabe gilt" .
 *
 * Its own query, not folded into {@link useTenantSmtp}: ADR-0013 no. 3 draws
 * that line for the route, and a single cache entry for two documents that
 * save independently would invalidate one every time the other's mutation
 * touched the query key.
 */
export function useTenantBaseUrl(
  tenantId: string | undefined,
): UseQueryResult<TenantBaseUrl> {
  return useQuery({
    queryKey: tenantBaseUrlQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      parseTenantBaseUrl(
        await requestJson('/tenant/base-url', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantBaseUrlVariables {
  readonly tenantId: string;
  readonly write: TenantBaseUrlWrite;
}

/**
 * Replaces the organisation's own base address, or clears it (`baseUrl: null`). No
 * `lock`/revision: `tenantBaseUrlWriteSchema` carries none, the same
 * last-write-wins shape {@link useSaveTenantSmtp} and {@link useSaveOidcConfig}
 * already have for the organisation's other single-document writes.
 */
export function useSaveTenantBaseUrl(): UseMutationResult<
  TenantBaseUrl,
  Error,
  SaveTenantBaseUrlVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveTenantBaseUrlVariables) =>
      parseTenantBaseUrl(
        await requestJson('/tenant/base-url', { method: 'PUT', body: write }),
      ),
    onSuccess: (document, { tenantId }) => {
      queryClient.setQueryData(tenantBaseUrlQueryKey(tenantId), document);
    },
  });
}

// ---------------------------------------------------------------------------
// Reply address of the organisation
// ---------------------------------------------------------------------------

export function tenantReplyToQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-reply-to', tenantId ?? 'none'];
}

/**
 * The reply address of this organisation — `{ replyTo: string | null }`, `null` for
 * „keine eigene, die Systemvorgabe gilt" .
 *
 * A query of its own, not folded into {@link useTenantSmtp}, and for the same
 * reason {@link useTenantBaseUrl} names: the SMTP block is indivisible
 * *because it carries a secret* — a field that could only be saved together
 * with it would be unreachable without an SMTP password.
 */
export function useTenantReplyTo(
  tenantId: string | undefined,
): UseQueryResult<TenantReplyTo> {
  return useQuery({
    queryKey: tenantReplyToQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      parseTenantReplyTo(
        await requestJson('/tenant/reply-to', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantReplyToVariables {
  readonly tenantId: string;
  readonly write: TenantReplyToWrite;
}

/**
 * Replaces the organisation's reply address, or clears it (`replyTo: null`).
 * No `lock`: the same last-write-wins shape
 * {@link useSaveTenantBaseUrl} has.
 */
export function useSaveTenantReplyTo(): UseMutationResult<
  TenantReplyTo,
  Error,
  SaveTenantReplyToVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveTenantReplyToVariables) =>
      parseTenantReplyTo(
        await requestJson('/tenant/reply-to', { method: 'PUT', body: write }),
      ),
    onSuccess: (document, { tenantId }) => {
      queryClient.setQueryData(tenantReplyToQueryKey(tenantId), document);
    },
  });
}

// ---------------------------------------------------------------------------
// Users — Nutzerrechte (Tenant-Ebene)
// ---------------------------------------------------------------------------

export function tenantMembersQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-members', tenantId ?? 'none'];
}

export function useTenantMembers(
  tenantId: string | undefined,
): UseQueryResult<TenantMemberList> {
  return useQuery({
    queryKey: tenantMembersQueryKey(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () =>
      tenantMemberListSchema.parse(
        await requestJson('/tenant/users', { method: 'GET' }),
      ),
  });
}

/**
 * Refreshes everything a member or group write can change: the member list
 * itself, the group cards' `memberCount` (a person moved or was added/removed)
 * and, since a permission change applies without a new login, the caller's own session.
 */
async function invalidateMembersAndGroups(
  queryClient: QueryClient,
  tenantId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: tenantMembersQueryKey(tenantId),
    }),
    queryClient.invalidateQueries({ queryKey: tenantGroupsQueryKey(tenantId) }),
    invalidateSession(queryClient),
  ]);
}

export interface CreateTenantMemberVariables {
  readonly tenantId: string;
  readonly create: TenantMemberCreate;
}

export function useCreateTenantMember(): UseMutationResult<
  TenantMemberCreated,
  Error,
  CreateTenantMemberVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ create }: CreateTenantMemberVariables) =>
      tenantMemberCreatedSchema.parse(
        await requestJson('/tenant/users', { method: 'POST', body: create }),
      ),
    onSuccess: async (_member, { tenantId }) => {
      await invalidateMembersAndGroups(queryClient, tenantId);
    },
  });
}

export interface UpdateTenantMemberVariables {
  readonly tenantId: string;
  readonly userId: string;
  readonly update: TenantMemberUpdate;
}

/**
 * Role, name and address of a member (finding 12).
 *
 * Was called `useUpdateTenantMemberGroup` for as long as the body carried only
 * the group. It is the same `PUT` on the same resource — what was added are
 * fields, and the server decides which change is allowed (an address only on a
 * local account that belongs to this organisation alone).
 */
export function useUpdateTenantMember(): UseMutationResult<
  TenantMember,
  Error,
  UpdateTenantMemberVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ userId, update }: UpdateTenantMemberVariables) =>
      tenantMemberSchema.parse(
        await requestJson(`/tenant/users/${encodeURIComponent(userId)}`, {
          method: 'PUT',
          body: update,
        }),
      ),
    onSuccess: async (_member, { tenantId }) => {
      await invalidateMembersAndGroups(queryClient, tenantId);
    },
  });
}

export interface RemoveTenantMemberVariables {
  readonly tenantId: string;
  readonly userId: string;
}

export function useRemoveTenantMember(): UseMutationResult<
  void,
  Error,
  RemoveTenantMemberVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ userId }: RemoveTenantMemberVariables) =>
      requestVoid(`/tenant/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async (_void, { tenantId }) => {
      await invalidateMembersAndGroups(queryClient, tenantId);
    },
  });
}

/**
 * Ends **every** session of a member (a review finding).
 *
 * No `invalidate` afterwards: the member list does not change — the person
 * stays a member, they are only signed out everywhere. The answer carries the
 * number, and the view says it.
 */
export interface SetTenantMemberPasswordVariables {
  readonly tenantId: string;
  readonly userId: string;
  readonly password: string;
}

/**
 * Sets the password of a member (finding 12).
 *
 * The answer carries the number of ended sessions — that setting it ends every
 * session is the point and not a side effect, and the number is the
 * confirmation that it took effect.
 *
 * Without `invalidate`: nothing the member list shows changes.
 */
export function useSetTenantMemberPassword(): UseMutationResult<
  SessionRevocation,
  Error,
  SetTenantMemberPasswordVariables
> {
  return useMutation({
    retry: false,
    mutationFn: async ({
      userId,
      password,
    }: SetTenantMemberPasswordVariables) =>
      parseSessionRevocation(
        await requestJson(
          `/tenant/users/${encodeURIComponent(userId)}/password`,
          { method: 'POST', body: { password } },
        ),
      ),
  });
}

export interface ResendTenantMemberInvitationVariables {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Sends a member's invitation once more (ADR-0024).
 *
 * **No field for a recipient**, and that is half the security statement of
 * this route: the mail goes to the stored address, which the server reads in
 * the same transaction. An address in the body would be a way to send a
 * capability over somebody else's account into a mailbox of one's own
 * choosing.
 *
 * Without `invalidate`: nothing the member list shows changes — the same
 * consideration as when setting a password.
 */
export function useResendTenantMemberInvitation(): UseMutationResult<
  void,
  Error,
  ResendTenantMemberInvitationVariables
> {
  return useMutation({
    retry: false,
    mutationFn: async ({ userId }: ResendTenantMemberInvitationVariables) =>
      requestVoid(`/tenant/users/${encodeURIComponent(userId)}/invitation`, {
        method: 'POST',
      }),
  });
}

export function useRevokeMemberSessions(): UseMutationResult<
  SessionRevocation,
  Error,
  RemoveTenantMemberVariables
> {
  return useMutation({
    retry: false,
    mutationFn: async ({ userId }: RemoveTenantMemberVariables) =>
      parseSessionRevocation(
        await requestJson(
          `/tenant/users/${encodeURIComponent(userId)}/revoke-sessions`,
          { method: 'POST' },
        ),
      ),
  });
}

// ---------------------------------------------------------------------------
// Groups — Gruppen & Rechte
// ---------------------------------------------------------------------------

export function tenantGroupsQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-groups', tenantId ?? 'none'];
}

export function useTenantGroups(
  tenantId: string | undefined,
): UseQueryResult<GroupList> {
  return useQuery({
    queryKey: tenantGroupsQueryKey(tenantId),
    enabled: tenantId !== undefined,
    queryFn: async () =>
      groupListSchema.parse(
        await requestJson('/tenant/groups', { method: 'GET' }),
      ),
  });
}

export interface CreateTenantGroupVariables {
  readonly tenantId: string;
  readonly write: GroupWrite;
}

export function useCreateTenantGroup(): UseMutationResult<
  GroupDetail,
  Error,
  CreateTenantGroupVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: CreateTenantGroupVariables) =>
      groupDetailSchema.parse(
        await requestJson('/tenant/groups', { method: 'POST', body: write }),
      ),
    onSuccess: async (_group, { tenantId }) => {
      await queryClient.invalidateQueries({
        queryKey: tenantGroupsQueryKey(tenantId),
      });
    },
  });
}

export interface UpdateTenantGroupVariables {
  readonly tenantId: string;
  readonly groupId: string;
  readonly write: GroupWrite;
}

export function useUpdateTenantGroup(): UseMutationResult<
  GroupDetail,
  Error,
  UpdateTenantGroupVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ groupId, write }: UpdateTenantGroupVariables) =>
      groupDetailSchema.parse(
        await requestJson(`/tenant/groups/${encodeURIComponent(groupId)}`, {
          method: 'PUT',
          body: write,
        }),
      ),
    onSuccess: async (_group, { tenantId }) => {
      // A group's colour, name or permissions travel inline on every member row
      // (`groupSummarySchema`) and on this editor's own list — both go stale in
      // the same write, and a revoked permission applies without a new login.
      await invalidateMembersAndGroups(queryClient, tenantId);
    },
  });
}

export interface RemoveTenantGroupVariables {
  readonly tenantId: string;
  readonly groupId: string;
}

export function useRemoveTenantGroup(): UseMutationResult<
  void,
  Error,
  RemoveTenantGroupVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ groupId }: RemoveTenantGroupVariables) =>
      requestVoid(`/tenant/groups/${encodeURIComponent(groupId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async (_void, { tenantId }) => {
      await queryClient.invalidateQueries({
        queryKey: tenantGroupsQueryKey(tenantId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// KI — this organisation's own switch (ADR-0015, ADR-0025)
// ---------------------------------------------------------------------------

export function tenantAiQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-ai', tenantId ?? 'none'];
}

/**
 * This organisation's own KI switch — `enabled: boolean | null` (`null` means
 * „inherits the installation's default") and, alongside it, the information
 * whether the installation has the feature at all.
 *
 * **Before ADR-0025 the route stood in not one single line of this client.**
 * It existed, it was tested, and there was no interface for it: an
 * organisation could neither switch itself off nor on again without `curl`.
 * What the assistant changes about that is in ADR-0025 no. 6 — the card exists
 * **additionally** in the Organisationsverwaltung, so that it stays findable
 * afterwards.
 *
 * `retry: false`, like every document-shaped query in this module: a 403 would
 * otherwise be retried against an unchanged answer before the view even sees
 * it.
 */
export function useTenantAiSwitch(
  tenantId: string | undefined,
): UseQueryResult<TenantAiSwitch> {
  return useQuery({
    queryKey: tenantAiQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      parseTenantAiSwitch(
        await requestJson('/ai/tenant-settings', { method: 'GET' }),
      ),
  });
}

export interface SaveTenantAiSwitchVariables {
  readonly tenantId: string;
  readonly write: UpdateTenantAiSwitchRequest;
}

/**
 * Writes the switch — **and invalidates the session**.
 *
 * That is not caution but the condition for „menu and route do not diverge":
 * `aiFormsAvailable` of the session payload carries exactly this switch
 * (`SessionFeaturesService`), and without the invalidation „✦ KI-Formular"
 * would still stand in the header after the switch-off — with a 404 behind it.
 *
 * No `lock`: `updateTenantAiSwitchRequestSchema` carries none, the same
 * last-write-wins shape as the OIDC block and the base address. A counter for
 * a single `boolean` would answer „somebody else was faster" for a change one
 * can make again in the same second.
 */
export function useSaveTenantAiSwitch(): UseMutationResult<
  TenantAiSwitch,
  Error,
  SaveTenantAiSwitchVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ write }: SaveTenantAiSwitchVariables) =>
      parseTenantAiSwitch(
        await requestJson('/ai/tenant-settings', {
          method: 'PUT',
          body: write,
        }),
      ),
    onSuccess: async (document, { tenantId }) => {
      queryClient.setQueryData(tenantAiQueryKey(tenantId), document);
      await invalidateSession(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Vorlagen — this organisation's own notification templates (ADR-0032)
// ---------------------------------------------------------------------------

/**
 * A key of its own, for the same reason {@link tenantAiQueryKey} and its
 * siblings each have one: this document has its **own** counter
 * (`notification_templates_revision`), and a shared cache entry across
 * unrelated documents would make one lock out of several.
 */
export function tenantNotificationTemplatesQueryKey(
  tenantId: string | undefined,
): readonly string[] {
  return ['tenant-notification-templates', tenantId ?? 'none'];
}

/**
 * The notification templates of this organisation (ADR-0032 — until then a
 * single installation-wide row read by every organisation alike; now each
 * organisation's own document).
 *
 * `retry: false`, like every document-shaped query in this module: a 403
 * would otherwise be retried against an unchanged answer before the view ever
 * sees it.
 */
export function useTenantNotificationTemplates(
  tenantId: string | undefined,
): UseQueryResult<TenantNotificationTemplatesResponse> {
  return useQuery({
    queryKey: tenantNotificationTemplatesQueryKey(tenantId),
    enabled: tenantId !== undefined,
    retry: false,
    queryFn: async () =>
      tenantNotificationTemplatesResponseSchema.parse(
        await requestJson('/tenant/notification-templates', {
          method: 'GET',
        }),
      ),
  });
}

export interface SaveTenantNotificationTemplatesVariables {
  readonly tenantId: string;
  /** Full replacement, no patch — the page holds the whole document. */
  readonly templates: readonly NotificationTemplate[];
  readonly lock: number;
}

/**
 * Writes the templates of this organisation.
 *
 * `retry: false` for the reason every settings write here has it: a 409 means
 * that somebody else has saved this same document in the meantime, and
 * repeating it would either fail again or silently overwrite what the lock is
 * supposed to protect.
 *
 * ⚠️ Additionally discarded is the **notification list** of this
 * organisation's forms: the templates travel along there
 * (`notificationListResponseSchema.templates`), and without this line the
 * selection dialog would offer the old ones until the next load — so exactly
 * what this write has just changed.
 */
export function useSaveTenantNotificationTemplates(): UseMutationResult<
  TenantNotificationTemplatesResponse,
  Error,
  SaveTenantNotificationTemplatesVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({
      templates,
      lock,
    }: SaveTenantNotificationTemplatesVariables) =>
      tenantNotificationTemplatesResponseSchema.parse(
        await requestJson('/tenant/notification-templates', {
          method: 'PUT',
          body: { templates, lock },
        }),
      ),
    onSuccess: (document, { tenantId }) => {
      queryClient.setQueryData(
        tenantNotificationTemplatesQueryKey(tenantId),
        document,
      );
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
