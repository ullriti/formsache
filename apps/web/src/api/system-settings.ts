import {
  parseTestMailResult,
  systemAiSettingsResponseSchema,
  systemMailSettingsSchema,
  type AiProvider,
  type AiRegion,
  type SystemAiSettingsResponse,
  type SystemMailSettings,
  type SystemSmtpWrite,
  type TestMailResult,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { requestJson } from './http';
import { SESSION_QUERY_KEY } from './session';
import type { TestMailVariables } from './tenant-admin';

/**
 * Server state of what the **installation** decides — its mail server, its own
 * address and its KI, behind the superadmin guard.
 *
 * The envelope is described here for the same reason `settings.ts` describes
 * its own: foreign data arrives as `unknown` and has to be parsed
 * (`CONTRIBUTING.md`), while the server produces it and states it as TypeScript
 * interfaces in `apps/api/src/system-settings/system-settings-wire.ts`. What is
 * added below is only *which document sits next to which* — every field shape
 * and every cross-field rule comes from `@formsache/shared`.
 *
 * `z.object`, not `z.strictObject`: an additive field on the server must not
 * break this client, exactly as next door.
 *
 * **The *Formular-Standards* document is gone from here** (ADR-0011,
 * continuation 2026-08-14; review finding 9), and with it `reach` — the count
 * of „gilt für N Organisationen und M Formulare" that this page showed before
 * saving. There is no installation-wide settings layer any more, so there is
 * nothing that reaches across organisations and nothing to announce.
 */

/** The optimistic-lock counter — required, as always. */
const revisionSchema = z.number().int().positive();

// ---------------------------------------------------------------------------
// The installation's mail server and base address
// ---------------------------------------------------------------------------

/**
 * The document the *Mailserver & Basis-Adresse* page is built from.
 *
 * `values` goes through `systemMailSettingsSchema` unmodified — the shape
 * that keeps the password out is an allow list built once, in
 * `@formsache/shared`, and restating it here would be a second copy of the same
 * promise (see the file-level comment above for why the same rule applies to
 * `systemFormSettingsSchema`).
 */
const systemMailSettingsResponseSchema = z.object({
  values: systemMailSettingsSchema,
  /**
   * The optimistic lock — `mail_revision`, its own
   * counter next to `revisionSchema` above; see the API's own comment
   * (`system-settings-wire.ts`) for why it is not the row's `updated_at`.
   * Never `null`, even on a fresh installation — the same convention
   * `revisionSchema` follows.
   */
  lock: revisionSchema,
});

export interface SystemMailSettingsDocument {
  readonly values: SystemMailSettings;
  readonly lock: number;
}

/** One key, so the write can refresh the page's document in place. */
export const SYSTEM_MAIL_SETTINGS_QUERY_KEY: readonly string[] = [
  'system-mail-settings',
];

/**
 * The installation's mail server and base address, its lock — unconditional:
 * this document belongs to no tenant, so a caller who is not a superadmin gets
 * a 403 and the view says so.
 */
export function useSystemMailSettings(): UseQueryResult<SystemMailSettingsDocument> {
  return useQuery({
    queryKey: SYSTEM_MAIL_SETTINGS_QUERY_KEY,
    queryFn: async () =>
      systemMailSettingsResponseSchema.parse(
        await requestJson('/admin/system-settings/mail', { method: 'GET' }),
      ),
  });
}

export interface SaveSystemMailSettingsVariables {
  readonly smtp: SystemSmtpWrite | null;
  readonly publicBaseUrl: string | null;
  /**
   * The system-wide default for `Reply-To`, or `null`.
   *
   * Next to `smtp`, not inside it: the block is indivisible because it carries
   * a secret — a reply address is none and has to be settable even when `smtp`
   * is `null`.
   */
  readonly replyTo: string | null;
  /**
   * Where an operations alert goes, or `null` for „niemand".
   *
   * ⚠️ Without this field the column had **no** write path, and the watchdog
   * reached nobody on any real installation — a review found it.
   */
  readonly opsAlertEmail: string | null;
  /** The lock this superadmin started from. */
  readonly lock: number;
}

/**
 * Writes the installation's mail server and base address.
 *
 * `retry: false` for the reason every settings write in this application has
 * it: a 409 means somebody else saved this same document in the meantime, and
 * repeating the request would either fail again or silently overwrite what
 * the lock exists to protect.
 */
export function useSaveSystemMailSettings(): UseMutationResult<
  SystemMailSettingsDocument,
  Error,
  SaveSystemMailSettingsVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (variables: SaveSystemMailSettingsVariables) =>
      systemMailSettingsResponseSchema.parse(
        await requestJson('/admin/system-settings/mail', {
          method: 'PUT',
          body: variables,
        }),
      ),
    onSuccess: (document) => {
      queryClient.setQueryData(SYSTEM_MAIL_SETTINGS_QUERY_KEY, document);
    },
  });
}

/**
 * „Testmail senden" at **system level** (finding 29a).
 *
 * A route of its own and therefore a hook of its own, no flag on the
 * organisation hook: **which block is checked is decided by the server at the
 * address** (`POST /admin/system-settings/mail/test` demands `'system'`,
 * `POST /tenant/smtp/test` demands `'tenant'`), and not by a field that a
 * client could send along. A shared hook with `source: 'system' | 'tenant'` in
 * the body would be exactly the construction in which a caller with
 * `can_manage_settings` of an organisation selected the system block.
 *
 * The body is the same as next door ({@link TestMailVariables}) — the same
 * schema, the same assurance: a checked address or `null` for „an mich
 * selbst", and no transport field.
 *
 * Not cached: an action, not a document.
 */
export function useSendSystemTestMail(): UseMutationResult<
  TestMailResult,
  Error,
  TestMailVariables
> {
  return useMutation({
    retry: false,
    mutationFn: async (variables: TestMailVariables) =>
      parseTestMailResult(
        await requestJson('/admin/system-settings/mail/test', {
          method: 'POST',
          body: variables,
        }),
      ),
  });
}

/**
 * The KI configuration of the installation.
 *
 * A key of its own next to the mail document, no shared one: the two lie in the
 * same row but have **own** counters (`ai_revision` next to `mail_revision`),
 * and a shared cache entry would make one lock out of two.
 */
export const SYSTEM_AI_SETTINGS_QUERY_KEY: readonly string[] = [
  'system-settings',
  'ai',
];

export function useSystemAiSettings(): UseQueryResult<SystemAiSettingsResponse> {
  return useQuery({
    queryKey: SYSTEM_AI_SETTINGS_QUERY_KEY,
    queryFn: async () =>
      systemAiSettingsResponseSchema.parse(
        await requestJson('/admin/system-settings/ai', { method: 'GET' }),
      ),
  });
}

export interface SaveSystemAiSettingsVariables {
  readonly enabled: boolean;
  readonly provider: AiProvider | null;
  readonly model: string | null;
  readonly region: AiRegion;
  /**
   * Three states (`aiApiKeyWriteSchema`): **absent** → leave the stored one
   * standing · string → replace · `null` → remove.
   *
   * The first one is the reason why this page manages without the stored value
   * — and the value is the one thing it must never have.
   */
  readonly apiKey?: string | null;
  readonly lock: number;
}

export function useSaveSystemAiSettings(): UseMutationResult<
  SystemAiSettingsResponse,
  Error,
  SaveSystemAiSettingsVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (variables: SaveSystemAiSettingsVariables) =>
      systemAiSettingsResponseSchema.parse(
        await requestJson('/admin/system-settings/ai', {
          method: 'PUT',
          body: variables,
        }),
      ),
    onSuccess: (document) => {
      queryClient.setQueryData(SYSTEM_AI_SETTINGS_QUERY_KEY, document);
      // The menu entry „✦ KI-Formular" hangs off the session payload, and the
      // availability changes with **this** write — without this line the menu
      // would stay standing until the next load and would contradict the
      // route.
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}
