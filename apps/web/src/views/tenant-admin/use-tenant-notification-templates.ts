import type { NotificationTemplate } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveTenantNotificationTemplates,
  useTenantNotificationTemplates,
} from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';

/**
 * **Loading, draft, saving of an organisation's notification templates**
 * (ADR-0032) — the same split `use-tenant-legal.ts` and `use-tenant-ai.ts`
 * make: what the tab has to do lives here, the save bar and the fields stay
 * outside.
 */

export type TenantTemplatesState =
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
  forbidden: 'Dafür fehlt dir das Recht „Einstellungen verwalten".',
};

export function useTenantTemplates(
  tenantId: string | undefined,
): TenantTemplatesState {
  const query = useTenantNotificationTemplates(tenantId);
  const save = useSaveTenantNotificationTemplates();

  const document = query.data;
  const { draft, setDraft, beginSave } = useServerDraft<
    readonly NotificationTemplate[]
  >(tenantId, document?.templates);

  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (tenantId === undefined || document === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        query.error instanceof ApiError && query.error.status === 403
          ? 'Dafür fehlt dir das Recht „Einstellungen verwalten".'
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
     * The same reasoning `use-system-templates.ts` (the predecessor of this
     * hook) wrote out: `!decided` stands in front of the comparison so that
     * saving is offered even while nothing has been typed — a fresh
     * organisation already has its own document (seeded at creation), so in
     * the running application this state only shows up for a row a raw write
     * cleared or broke, and it is exactly this page that has to be able to
     * repair it.
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
        { tenantId, templates: draft, lock: document.lock },
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
