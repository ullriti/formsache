import type { SystemLegalPages } from '@formsache/shared';

import { ApiError } from '../../api/http';
import { useSaveSystemLegal, useSystemLegal } from '../../api/legal';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';

/**
 * **Loading, draft, saving of the installation's legal texts** — once, for the
 * two places where the editor stands: the *Rechtstexte* tab and the step of
 * the first-time setup.
 *
 * The same split as `use-system-templates.ts` and for the same reason: what
 * both have to do alike lies here; what they do differently — save bar versus
 * „Weiter" — stays outside.
 */

export type SystemLegalState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly pages: SystemLegalPages;
      readonly setPages: (next: SystemLegalPages) => void;
      /**
       * Ob die KI-Funktion der Installation eingerichtet ist — die eine
       * Bedingung der Vorlagen, die aus der Konfiguration kommt
       * (Review-Runde 5 Nr. 2).
       */
      readonly aiActive: boolean;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      /**
       * The field messages of a refused write, **under the paths of the
       * request** (`pages.<seite>.custom`, `pages.<seite>.fills.<SCHLÜSSEL>`).
       *
       * Not shortened here: which page a message belongs to is what the three
       * cards on the screen are told apart by, and `issuesUnder` is what each
       * of them shortens with (ADR-0028 no. 9).
       */
      readonly issues: SettingIssues;
      readonly save: (onSaved: () => void) => void;
    };

const MISSING_LEGAL_SUBJECT = {
  changed: 'Die Rechtstexte wurden',
  forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
};

/** There is exactly one system row — the same reason as with the mail tab. */
const LEGAL_DRAFT_KEY = 'system-legal';

export function useSystemLegalPages(): SystemLegalState {
  const query = useSystemLegal();
  const save = useSaveSystemLegal();

  const document = query.data;
  const { draft, setDraft, beginSave } = useServerDraft<SystemLegalPages>(
    LEGAL_DRAFT_KEY,
    document?.pages,
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
          : 'Die Rechtstexte konnten nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    pages: draft,
    setPages: setDraft,
    /*
      Aus der **geladenen** Antwort und nicht aus dem Entwurf: es ist keine
      Angabe dieser Seite, sondern ein Zustand der Installation. Ein Entwurf
      kann ihn nicht ändern, und `useServerDraft` trägt ihn deshalb auch nicht.
    */
    aiActive: document.aiActive,
    /**
     * What is compared is the document, not a count of what was typed — the
     * same reasoning as with the templates: it is a document made of strings,
     * truth values and maps of those in fixed key order, without a number
     * that has two spellings and without a date.
     *
     * ⚠️ **No `!decided` in front of it**, unlike with the templates. The
     * difference is real: there the server serves the *shipped state* on an
     * unreadable row, and without that addition the save bar would claim
     * „Gespeichert" about something that is not saved. Here it serves
     * **empty documents** on an unreadable row — and those cannot be told
     * apart from „nothing stored", because that is what they actually are.
     * There is no shipped state that one could mistakenly take for saved.
     */
    dirty: JSON.stringify(draft) !== JSON.stringify(document.pages),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MISSING_LEGAL_SUBJECT)
      : null,
    issues: fieldIssues(save.error),
    save: (onSaved: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { pages: draft, lock: document.lock },
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
