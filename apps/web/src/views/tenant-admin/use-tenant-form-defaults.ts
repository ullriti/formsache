import type {
  PartialTenantFormSettings,
  TenantFormSettings,
} from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveTenantFormDefaults,
  useTenantFormDefaults,
} from '../../api/settings';
import { useServerDraft } from '../../hooks/use-server-draft';
import {
  fieldIssues,
  saveErrorMessage,
  TENANT_DEFAULTS_SUBJECT,
} from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';
import {
  isTenantDirty,
  shownTenantValues,
  withTenantValue,
} from '../settings/settings-draft';

/**
 * **The form standards of an organisation as state.**
 *
 * Two hosts since ADR-0025: the *Formular-Standards* page and the sixth step
 * of the organisation assistant. The section cards themselves are shared
 * anyway (`settings/SettingsSectionCard.tsx`, `SettingsSectionFields.tsx`) —
 * what is shared here is what stands around them: the draft as a **patch**,
 * the revision of the load and the refusals.
 *
 * ⚠️ **The draft is a patch, not a second set of values.** Only what was typed
 * stands in it, and precisely that goes onto the wire: two people editing
 * different sections do not overwrite each other with it. The key is the
 * organisation — without it the draft of the previous one would stay behind
 * when switching in the header, while the document already belongs to the new
 * one (`use-server-draft.ts`).
 */
export type TenantFormDefaultsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      /** What the fields show: what is stored, overlaid by what was typed. */
      readonly values: TenantFormSettings;
      readonly issues: SettingIssues;
      /** Takes a change of a section over into the patch. */
      readonly change: (next: PartialTenantFormSettings) => void;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved?: () => void) => void;
    };

export function useTenantFormDefaultsState(
  tenantId: string | undefined,
): TenantFormDefaultsState {
  const defaults = useTenantFormDefaults(tenantId);
  const save = useSaveTenantFormDefaults();

  const document = defaults.data;

  const { draft, setDraft, beginSave } =
    useServerDraft<PartialTenantFormSettings>(
      tenantId,
      document === undefined ? undefined : {},
    );

  if (defaults.isPending) {
    return { kind: 'loading' };
  }

  if (document === undefined || draft === null || tenantId === undefined) {
    return {
      kind: 'failed',
      message:
        defaults.error instanceof ApiError && defaults.error.status === 403
          ? 'Diese Rolle darf die Formular-Standards dieser Organisation nicht sehen.'
          : 'Die Formular-Standards konnten nicht geladen werden.',
    };
  }

  return {
    kind: 'ready',
    values: shownTenantValues(document.values, draft),
    issues: fieldIssues(save.error),
    change: (next) => {
      setDraft(withTenantValue(draft, next));
    },
    dirty: isTenantDirty(document.values, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, TENANT_DEFAULTS_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      // The answer is the new basis — unless something was typed while it was
      // in flight; then what stands on the screen wins.
      const adopt = beginSave();
      save.mutate(
        {
          tenantId,
          // Only what was typed. The server lays it onto the stored document.
          values: draft,
          // The revision of the load this page stands on, never a fresher
          // one: sending back what this person has not seen would be exactly
          // the silent overwriting the check exists against.
          revision: document.revision,
        },
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
