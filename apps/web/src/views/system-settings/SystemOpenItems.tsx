import type { ReactElement } from 'react';

import { useTenantOverview } from '../../api/admin';
import { useSystemLegal } from '../../api/legal';
import { useSuperadmins } from '../../api/superadmins';
import { useSystemMailSettings } from '../../api/system-settings';
import { OpenItemsList } from '../open-items/OpenItemsList';
import { openItems } from './open-items';

/**
 * **The list of open items of the system administration** (ADR-0022, continuation
 * 2026-08-18).
 *
 * It is the second half of the decision *guiding, but skippable*:
 * every step of the setup wizard can be skipped, **and**
 * what stays open in the process stands here afterwards — until it is done. Without it
 * „skippable" would mean the same as „forgotten".
 *
 * ## It reads the state, not the history
 *
 * What the items arise from stands in `open-items.ts` and is a pure function:
 * the same documents that the tabs live on. This component fetches them
 * and shows the result — it decides nothing.
 *
 * ## What it costs, honestly reckoned
 *
 * Here it once stood that the queries ran "anyway". That is true for **four**
 * of the seven tabs, one each: the mail document also fetches *Mailserver*, the
 * organisation overview also *Organisationen*, the legal texts also
 * *Rechtstexte*, the superadministrators also *Superadmins* — and TanStack
 * Query merges two simultaneous observers of the same request. On
 * *Überwachung*, *Vorlagen* and *KI*, by contrast, they are four additional
 * round trips, and with the project-wide `staleTime: 0`
 * (`api/query-client.ts`) again at every change of tab.
 *
 * **That is the price and no oversight.** The alternative would be to bind the
 * queries to the tabs — then the note about the missing mail server would
 * disappear on *Vorlagen*, and the list would say something different depending on the tab.
 * Exactly that is ruled out by the paragraph below: it applies across the tabs.
 * Four GET requests on a view that only superadmins see anyway are
 * the cheaper bargain for that.
 *
 * ## It stands above the tabs and not in one of them
 *
 * Because it applies across the tabs: the missing mail server is not a
 * finding of the mail tab, but one of the installation. And because it would
 * otherwise stand exactly where one already is.
 *
 * ## The box itself does not belong to it alone
 *
 * It stands in `views/open-items/` and since ADR-0025 also carries the list of an
 * **organisation** on its dashboard. What this file keeps is that which
 * applies only to the installation: which queries it makes and how its box
 * is captioned.
 */
export function SystemOpenItems(): ReactElement | null {
  const mail = useSystemMailSettings();
  const overview = useTenantOverview();
  const legal = useSystemLegal();
  const superadmins = useSuperadmins();

  return (
    <OpenItemsList
      heading="Offene Punkte der Einrichtung"
      headingId="open-items-heading"
      intro="Diese Liste liest den tatsächlichen Zustand dieser Installation. Sie verschwindet von selbst, sobald ein Punkt erledigt ist — egal, wo er erledigt wurde."
      items={openItems({
        mail: mail.data?.values,
        tenantCount: overview.data?.totals.tenants,
        legal:
          legal.data === undefined
            ? undefined
            : { pages: legal.data.pages, aiActive: legal.data.aiActive },
        superadminCount: superadmins.data?.superadmins.length,
      })}
    />
  );
}
