import type { SettingIssues } from '../settings/SettingsControls';
import { ApiError } from '../../api/http';
import {
  useSaveSystemMailSettings,
  useSystemMailSettings,
} from '../../api/system-settings';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import {
  systemMailDraftOf,
  systemMailWriteOf,
  type SystemMailDraft,
} from '../system-settings/system-mail-draft';

/**
 * **What the three mail steps of the wizard have in common** — step 2
 * (base address), step 3 (mail server) and step 4 (addresses).
 *
 * All three write **the same document**: `system_setting`'s mail half
 * with **one** counter (`mail_revision`). One write per step is
 * therefore no special case but the normal sequence of three saves
 * of the same page — each names the counter state the previous one left
 * behind. That this works out without one step knowing about the next is down
 * to `useSaveSystemMailSettings`: the answer replaces the cache entry, and the
 * next step builds its draft from it.
 *
 * ⚠️ **Every write is a full replacement** (`updateSystemMailSettingsRequestSchema`
 * knows no patch). A step that knew only „its" field and filled the others
 * with empty values would therefore delete what the previous one has just set.
 * That is exactly what the shared draft protects against: it carries **all**
 * fields, each step shows only its own, and what is written is always the
 * whole document.
 */

export type MailStepState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly draft: SystemMailDraft;
      readonly setDraft: (next: SystemMailDraft) => void;
      readonly issues: SettingIssues;
      /** Whether an SMTP password is stored — see `SystemMailServerCard`. */
      readonly hadPassword: boolean;
      readonly isSaving: boolean;
      /** A refusal of the last save attempt, or `null`. */
      readonly errorMessage: string | null;
      /** Saves the **whole** document and calls `onSaved` afterwards. */
      readonly save: (onSaved: () => void) => void;
    };

const MISSING_MAIL_SUBJECT = {
  changed: 'Der Mailserver und die Basis-Adresse wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

export interface MailStepOptions {
  /**
   * What is to go into the draft before anybody has typed anything.
   *
   * The one caller is step 2: the base address is pre-filled from
   * `window.location.origin`. As a function and not as a value, so that
   * it sees the loaded document — only what is **empty** is pre-filled,
   * otherwise a second visit to the step would overwrite a stored
   * value with the browser's address.
   */
  readonly prefill?: (draft: SystemMailDraft) => SystemMailDraft;
}

export function useMailStep(options: MailStepOptions = {}): MailStepState {
  const mail = useSystemMailSettings();
  const save = useSaveSystemMailSettings();

  const document = mail.data;
  const baseline =
    document === undefined
      ? undefined
      : (options.prefill ?? identity)(systemMailDraftOf(document.values));

  // The same key as in the tab: there is exactly one system row.
  const { draft, setDraft } = useServerDraft<SystemMailDraft>(
    'system-mail',
    baseline,
  );

  if (mail.isPending) {
    return { kind: 'loading' };
  }
  if (document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        mail.error instanceof ApiError && mail.error.status === 403
          ? 'Diese Einstellung ist Superadmins vorbehalten. Bitte melde dich neu an.'
          : 'Die Mail-Einstellungen konnten nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    draft,
    setDraft,
    issues: fieldIssues(save.error),
    hadPassword:
      document.values.smtp !== null && document.values.smtp.authUser !== null,
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MISSING_MAIL_SUBJECT)
      : null,
    save: (onSaved: () => void): void => {
      save.mutate(systemMailWriteOf(draft, document.lock), {
        onSuccess: onSaved,
      });
    },
  };
}

function identity(draft: SystemMailDraft): SystemMailDraft {
  return draft;
}
