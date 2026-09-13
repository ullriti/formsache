import type { NotificationTemplate } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveSystemNotificationTemplates,
  useSystemNotificationTemplates,
} from '../../api/system-settings';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';

/**
 * **Loading, draft, saving of the notification templates** — once, for the two
 * places where {@link NotificationTemplatesEditor} stands: the *Vorlagen* tab
 * and step 5 of the setup wizard.
 *
 * The same split as with the AI (`use-system-ai.ts`) and for the same reason:
 * what both have to do alike lives here; what they do differently — save bar
 * versus „Weiter" — stays outside.
 */

export type SystemTemplatesState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly templates: readonly NotificationTemplate[];
      readonly setTemplates: (next: readonly NotificationTemplate[]) => void;
      /** Whether the row decides, or whether the shipped state is on show. */
      readonly decided: boolean;
      readonly issues: SettingIssues;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved: () => void) => void;
    };

const MISSING_TEMPLATES_SUBJECT = {
  changed: 'Die Vorlagen wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

/** There is exactly one system row — the same reason as with the mail tab. */
const TEMPLATES_DRAFT_KEY = 'system-notification-templates';

export function useSystemTemplates(): SystemTemplatesState {
  const query = useSystemNotificationTemplates();
  const save = useSaveSystemNotificationTemplates();

  const document = query.data;
  const { draft, setDraft, beginSave } = useServerDraft<
    readonly NotificationTemplate[]
  >(TEMPLATES_DRAFT_KEY, document?.templates);

  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        query.error instanceof ApiError && query.error.status === 403
          ? 'Diese Ansicht ist Superadmins vorbehalten.'
          : 'Die Vorlagen konnten nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    templates: draft,
    setTemplates: setDraft,
    decided: document.decided,
    issues: fieldIssues(save.error),
    /**
     * **What is compared is the document, not a count of what was typed.**
     *
     * A comparison via `JSON.stringify` really is the honest one here: the
     * templates are a document of strings, booleans and lists thereof, in fixed
     * key order — the entries arise either from the server document or from the
     * same literal form in the editor. There is no number with two spellings
     * and no date here.
     *
     * ⚠️ **`!decided` stands in front of it, and a blocking finding hung on
     * that.** As long as the row does not decide — no row, or one whose content
     * cannot be read —, the server delivers the *shipped state* as `templates`.
     * The comparison alone was then inevitably `false`: the save bar disabled
     * the button and wrote „Gespeichert" above it, although nothing had been
     * saved. That made precisely the promise fail that
     * `system-notification-templates-admin.service.ts` gives — that this tab is
     * the one place where a broken document can be repaired. Through the setup
     * wizard it still worked; a running installation only never sees that
     * again.
     *
     * Saving is therefore **always** offered in this state, even when nobody
     * has touched a field — it is the operation that turns the shipped state
     * into this installation's decision.
     */
    dirty:
      !document.decided ||
      JSON.stringify(draft) !== JSON.stringify(document.templates),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MISSING_TEMPLATES_SUBJECT)
      : null,
    save: (onSaved: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { templates: draft, lock: document.lock },
        {
          onSuccess: () => {
            adopt();
            onSaved();
          },
        },
      );
    },
  };
}
