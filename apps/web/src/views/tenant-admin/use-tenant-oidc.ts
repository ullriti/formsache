import type { OidcConfig } from '@formsache/shared';

import { ApiError } from '../../api/http';
import { useOidcConfig, useSaveOidcConfig } from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';
import {
  oidcDirty,
  oidcDraftOf,
  oidcWriteOf,
  type OidcDraft,
} from './tenant-admin-draft';

/**
 * **The sign-in of an organisation as a state** (OIDC / SSO).
 *
 * ## The one state the other settings do not have: `absent`
 *
 * `OidcConfigController` demands `canManageSettings` **and**
 * `canManageUsers`. Whoever has only the first gets a 403 here — and that is
 * **no loading error** but the expected form of „may change the colours, not
 * the sign-in". The tab then shows nothing (instead of a
 * greyed-out block promising a save nobody is allowed to make);
 * the wizard skips the step visibly, with the reason.
 *
 * Every **other** refusal — a 500, a broken connection, a proxy
 * in between — is temporary and is said, not rendered as an
 * absence: that would otherwise tell an administrator that their rights had
 * changed.
 */
export type TenantOidcState =
  | { readonly kind: 'loading' }
  /** 403 — this role may not see the sign-in. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly config: OidcConfig;
      readonly draft: OidcDraft;
      readonly setDraft: (next: OidcDraft) => void;
      readonly issues: SettingIssues;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved?: () => void) => void;
    };

const OIDC_SAVE_SUBJECT = {
  changed: 'Die Anmeldung wurde',
  forbidden: 'Diese Rolle darf die Anmeldung dieser Organisation nicht ändern.',
};

export function useTenantOidcState(tenantId: string): TenantOidcState {
  const oidc = useOidcConfig(tenantId);
  const save = useSaveOidcConfig();

  const config = oidc.data;

  const { draft, setDraft, beginSave } = useServerDraft<OidcDraft>(
    tenantId,
    config === undefined ? undefined : oidcDraftOf(config),
  );

  if (oidc.isPending) {
    return { kind: 'loading' };
  }

  if (config === undefined || draft === null) {
    if (oidc.error instanceof ApiError && oidc.error.status === 403) {
      return { kind: 'absent' };
    }
    return {
      kind: 'failed',
      message:
        'Die Anmeldung dieser Organisation konnte nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    config,
    draft,
    setDraft,
    issues: fieldIssues(save.error),
    dirty: oidcDirty(config, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, OIDC_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: oidcWriteOf(draft) },
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
