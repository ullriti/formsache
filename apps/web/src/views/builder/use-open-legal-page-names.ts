import {
  TENANT_LEGAL_TEMPLATES,
  openTenantLegalPages,
} from '@formsache/shared';

import { useTenantLegal } from '../../api/legal';
import { useSession } from '../../api/session';

/**
 * **The second stage of the hint before publishing** — *what* is missing
 * (ADR-0028, open item 3).
 *
 * ## Two stages, and this is the upper one
 *
 * The hint itself no longer hangs on this hook. Whether the legal texts of
 * this organisation are finished comes out of the publish preview
 * (`publishPreviewSchema.organisationLegal`), which stands behind
 * `can_build` — the very permission that publishes — and therefore reaches
 * **everyone** who can press the button. That is what the predecessor of this
 * file, `useLegalPublishHint`, could not do: it read `GET /tenant/legal`
 * behind `can_manage_settings` and stayed silent towards exactly the person
 * the notice is for.
 *
 * What this hook adds is the **names**, and only for whoever may already have
 * them. The preview deliberately carries none — one traffic light over both
 * pages, worst state winning, „nie welche Seite" — because it answers below
 * the guard that protects the documents. Whoever holds `can_manage_settings`
 * has the documents anyway, through the very query this hook uses, and can
 * therefore be told which page it is, right where they can go and fix it.
 *
 * ## Why the query is not simply issued for everybody
 *
 * Because it would be a 403 per builder visit for an editor, over a document
 * they may not read and could not change. The permission is asked first, and
 * an editor without it gets an empty list — no error, no gap in the notice,
 * just the sentence without the page names.
 *
 * The judgement of „fertig" is the shared one (`openTenantLegalPages`), the
 * same the server folds for the preview and the same the list of open items
 * of an organisation reads. One judgement, so that the two stages of this
 * notice cannot contradict each other.
 */
export function useOpenLegalPageNames(): readonly string[] {
  const session = useSession();
  const active = session.data?.memberships.find(
    (membership) => membership.tenant.id === session.data?.activeTenantId,
  );
  const mayRead = active?.permissions.canManageSettings ?? false;

  const legal = useTenantLegal(mayRead ? active?.tenant.id : undefined);
  const pages = legal.data?.pages;

  if (pages === undefined) {
    // “We do not know” names nothing — the same direction in which the lists
    // of open items resolve their uncertainty. The stage below has already
    // said *that* something is missing; a guess here could only be wrong.
    return [];
  }

  return openTenantLegalPages(pages).map(
    (page) => TENANT_LEGAL_TEMPLATES[page].title,
  );
}
