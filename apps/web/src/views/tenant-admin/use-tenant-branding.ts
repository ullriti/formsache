import type { TenantBrandingSettings } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveTenantBranding,
  useTenantBranding,
} from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';
import {
  brandingDirty,
  brandingDraftOf,
  brandingWriteOf,
  type BrandingDraft,
} from './tenant-admin-draft';

/**
 * **The appearance as state** — load, type, save, in one hook instead of twice
 * in two views.
 *
 * Two hosts: the *Erscheinungsbild & Login* tab and the first step of the
 * organisation wizard (ADR-0025). The same split that
 * `views/setup/use-mail-step.ts` has for the instance side — and the same
 * reason: the two must not learn separately what a refusal looks like or when
 * „Speichern" is locked.
 *
 * What is **not** decided here is the presentation: the tab hangs a
 * `SettingsSaveBar` underneath, the wizard the main button of its frame. Both
 * call the same {@link TenantBrandingState.save}.
 */
export type TenantBrandingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly document: TenantBrandingSettings;
      readonly draft: BrandingDraft;
      readonly setDraft: (
        next: BrandingDraft | ((previous: BrandingDraft) => BrandingDraft),
      ) => void;
      readonly issues: SettingIssues;
      /** Whether a save would change anything at all. */
      readonly dirty: boolean;
      readonly isSaving: boolean;
      /** The refusal of the last save attempt, or `null`. */
      readonly errorMessage: string | null;
      /** Saves and then calls `onSaved` — the wizard then moves on. */
      readonly save: (onSaved?: () => void) => void;
    };

const BRANDING_SAVE_SUBJECT = {
  changed: 'Das Erscheinungsbild wurde',
  forbidden:
    'Diese Rolle darf das Erscheinungsbild dieser Organisation nicht ändern.',
};

export function useTenantBrandingState(tenantId: string): TenantBrandingState {
  const branding = useTenantBranding(tenantId);
  const save = useSaveTenantBranding();

  const document = branding.data;

  const { draft, setDraft, beginSave } = useServerDraft<BrandingDraft>(
    tenantId,
    document === undefined ? undefined : brandingDraftOf(document),
  );

  if (branding.isPending) {
    return { kind: 'loading' };
  }

  if (document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        branding.error instanceof ApiError && branding.error.status === 403
          ? 'Diese Rolle darf das Erscheinungsbild dieser Organisation nicht ändern.'
          : 'Das Erscheinungsbild konnte nicht geladen werden.',
    };
  }

  return {
    kind: 'ready',
    document,
    draft,
    setDraft,
    issues: fieldIssues(save.error),
    dirty: brandingDirty(document, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, BRANDING_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: brandingWriteOf(draft, document.revision) },
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
