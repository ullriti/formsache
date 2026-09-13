import { ApiError } from '../../api/http';
import { useSaveTenantSmtp, useTenantSmtp } from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';
import {
  FRESH_MAIL_IDENTITY_DRAFT,
  mailIdentityDirty,
  mailIdentityDraftOf,
  mailIdentityWriteOf,
  type MailIdentityDraft,
} from './mail-identity-draft';

/**
 * **An organisation's mail server as state** — the tab
 * *Mailversand* and the second step of the organisation wizard read and
 * write it through this one hook (ADR-0025).
 *
 * What it holds together is more than the loading: the three special cases of this
 * document stand there exactly once instead of ageing separately in two
 * views.
 *
 * 1. **The unreadable row** (500 from `smtp-config.service.ts`) is not a
 *    load error but the repair case: the draft starts on
 *    `FRESH_MAIL_IDENTITY_DRAFT`, `dirty` is true, and the `PUT` stays
 *    reachable — without this branch a broken row could only be healed
 *    by SQL.
 * 2. **The changed user name without a new password** is caught before sending,
 *    so that the refusal stands at the field instead of coming back as a 400.
 * 3. **A 403 is information about the role**: the route demands
 *    `canManageSettings` **and** `canViewResponses`.
 */
export type TenantSmtpState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly draft: MailIdentityDraft;
      readonly setDraft: (next: MailIdentityDraft) => void;
      readonly issues: SettingIssues;
      /** Whether the stored row is unreadable — the repair case. */
      readonly unreadable: boolean;
      /** Whether an SMTP password is stored. */
      readonly hadPassword: boolean;
      /**
       * The refusal at the field „Benutzername", or `undefined` — see no. 2
       * above. It blocks the saving at the same time.
       */
      readonly usernameIssue: string | undefined;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved?: () => void) => void;
    };

const MAIL_SAVE_SUBJECT = {
  changed: 'Der Mailversand dieser Organisation wurde',
  forbidden:
    'Diese Rolle darf den Mailversand dieser Organisation nicht ändern.',
};

const USERNAME_WITHOUT_PASSWORD =
  'Der Benutzername wurde geändert. Ohne ein neues Passwort lässt sich das nicht speichern.';

export function useTenantSmtpState(tenantId: string): TenantSmtpState {
  const identity = useTenantSmtp(tenantId);
  const save = useSaveTenantSmtp();

  const config = identity.data;
  const unreadable =
    identity.isError &&
    identity.error instanceof ApiError &&
    identity.error.status === 500;

  const { draft, setDraft, beginSave } = useServerDraft<MailIdentityDraft>(
    tenantId,
    config !== undefined
      ? mailIdentityDraftOf(config)
      : unreadable
        ? FRESH_MAIL_IDENTITY_DRAFT
        : undefined,
  );

  if (identity.isPending) {
    return { kind: 'loading' };
  }

  if (config === undefined && !unreadable) {
    return {
      kind: 'failed',
      message:
        identity.error instanceof ApiError && identity.error.status === 403
          ? 'Diese Rolle darf den Mailversand dieser Organisation nicht sehen.'
          : 'Der Mailversand konnte nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  if (draft === null) {
    return { kind: 'loading' };
  }

  const issues = fieldIssues(save.error);
  const storedAuth = config?.smtp?.auth ?? null;
  const hadPassword = storedAuth?.passwordSet ?? false;
  const usernameChangedWithoutNewPassword =
    draft.enabled &&
    draft.authEnabled &&
    storedAuth !== null &&
    hadPassword &&
    draft.password.kind === 'keep' &&
    draft.user.trim() !== storedAuth.user;

  return {
    kind: 'ready',
    draft,
    setDraft,
    issues,
    unreadable,
    hadPassword,
    usernameIssue:
      issues['smtp.auth.user'] ??
      (usernameChangedWithoutNewPassword
        ? USERNAME_WITHOUT_PASSWORD
        : undefined),
    // `config === undefined` covers the repair case: nothing here reproduces
    // what is stored, so every draft — the untouched one included —
    // is a repair waiting to be saved.
    dirty: config === undefined ? true : mailIdentityDirty(config, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MAIL_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      if (usernameChangedWithoutNewPassword) {
        // Caught at the field above; sending it out would only exchange a clear
        // reason for the server's 400.
        return;
      }
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: mailIdentityWriteOf(draft) },
        {
          onSuccess: () => {
            adopt();
            onSaved?.();
          },
        },
      );
    },
  };
}
