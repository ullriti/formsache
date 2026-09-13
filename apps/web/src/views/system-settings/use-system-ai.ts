import type { SystemAiSettings } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveSystemAiSettings,
  useSystemAiSettings,
} from '../../api/system-settings';
import { useServerDraft } from '../../hooks/use-server-draft';
import { saveErrorMessage } from '../api-messages';
import {
  systemAiDirty,
  systemAiDraftOf,
  systemAiWriteOf,
  type SystemAiDraft,
} from './system-ai-draft';

/**
 * **Loading, draft, saving of the AI configuration** — once, for the two places
 * at which {@link SystemAiCard} stands: the tab *KI* and step 6 of the setup
 * wizard.
 *
 * What lies here is exactly what the two have to do **alike**: holding the draft
 * against the loaded document (`useServerDraft`, so that a response does not
 * overwrite what has been typed in the meantime), sending the lock along and
 * translating the refusal into a sentence. What they do **differently** stays
 * outside: the tab hangs a `SettingsSaveBar` below it, the wizard makes the
 * saving its „Weiter".
 */

export type SystemAiState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly draft: SystemAiDraft;
      readonly setDraft: (next: SystemAiDraft) => void;
      readonly stored: SystemAiSettings;
      readonly gap: 'apiKey' | null;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      /** Saves and calls `onSaved` afterwards — the draft is then the basis. */
      readonly save: (onSaved: () => void) => void;
    };

const MISSING_AI_SUBJECT = {
  changed: 'Die KI-Einstellungen wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

/** There is exactly one system row — the same reason as with the mail tab. */
const SYSTEM_AI_DRAFT_KEY = 'system-ai';

export function useSystemAi(): SystemAiState {
  const query = useSystemAiSettings();
  const save = useSaveSystemAiSettings();

  const document = query.data;
  const { draft, setDraft, beginSave } = useServerDraft<SystemAiDraft>(
    SYSTEM_AI_DRAFT_KEY,
    document === undefined ? undefined : systemAiDraftOf(document.values),
  );

  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        query.error instanceof ApiError && query.error.status === 403
          ? 'Diese Ansicht ist Superadmins vorbehalten.'
          : 'Die KI-Einstellungen konnten nicht geladen werden.',
    };
  }

  return {
    kind: 'ready',
    draft,
    setDraft,
    stored: document.values,
    gap: document.gap,
    dirty: systemAiDirty(document.values, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MISSING_AI_SUBJECT)
      : null,
    save: (onSaved: () => void): void => {
      const adopt = beginSave();
      save.mutate(systemAiWriteOf(draft, document.lock), {
        onSuccess: () => {
          adopt();
          onSaved();
        },
      });
    },
  };
}
