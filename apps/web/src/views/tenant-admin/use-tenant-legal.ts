import type { TenantLegalPages } from '@formsache/shared';

import { ApiError } from '../../api/http';
import { useSaveTenantLegal, useTenantLegal } from '../../api/legal';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';

/**
 * **Loading, drafting, saving the legal texts of an organisation** — once,
 * for the two places the editor stands in: the tab *Rechtstexte*
 * and the step of the initial setup (ADR-0025, ADR-0028).
 *
 * The id of the organisation is the key of the draft, not only that
 * of the query — and that is no formality: `use-server-draft.ts` writes
 * out what happens without it, and it has happened once before in this
 * project. Whoever types in organisation A, switches to B and comes back would
 * otherwise have A's old entries lying over a freshly loaded document with a
 * **newer** lock — and would thereby save silently over somebody else's change.
 */

export type TenantLegalState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly pages: TenantLegalPages;
      readonly setPages: (next: TenantLegalPages) => void;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      /**
       * The field messages of a refused write, **under the paths of the
       * request** (`pages.<seite>.custom`, `pages.<seite>.fills.<SCHLÜSSEL>`).
       *
       * Not shortened here: which page a message belongs to is what the two
       * cards on the screen are told apart by, and `issuesUnder` is what each
       * of them shortens with (ADR-0028 no. 9).
       */
      readonly issues: SettingIssues;
      readonly save: (onSaved: () => void) => void;
    };

const MISSING_LEGAL_SUBJECT = {
  changed: 'Die Rechtstexte wurden',
  forbidden: 'Dafür fehlt dir das Recht „Einstellungen verwalten".',
};

export function useTenantLegalPages(
  tenantId: string | undefined,
): TenantLegalState {
  const query = useTenantLegal(tenantId);
  const save = useSaveTenantLegal();

  const document = query.data;
  const { draft, setDraft, beginSave } = useServerDraft<TenantLegalPages>(
    tenantId,
    document?.pages,
  );

  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (tenantId === undefined || document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        query.error instanceof ApiError && query.error.status === 403
          ? 'Dafür fehlt dir das Recht „Einstellungen verwalten".'
          : 'Die Rechtstexte konnten nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    pages: draft,
    setPages: setDraft,
    dirty: JSON.stringify(draft) !== JSON.stringify(document.pages),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, MISSING_LEGAL_SUBJECT)
      : null,
    issues: fieldIssues(save.error),
    save: (onSaved: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, pages: draft, lock: document.lock },
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
