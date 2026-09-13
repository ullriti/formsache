import type { ReactElement } from 'react';
import type { Permissions } from '@formsache/shared';

import { ApiError } from '../../api/http';
import { useTenantLegal } from '../../api/legal';
import { useTenantGroups, useTenantSmtp } from '../../api/tenant-admin';
import { TENANT_SETUP_PATH } from '../../router/routes';
import { navigate } from '../../router/use-route';
import { OpenItemsList } from '../open-items/OpenItemsList';
import { tenantOpenItems } from './open-items';

import '../open-items/open-items.css';

/**
 * **What stands on the dashboard of an organisation about its setup**
 * (ADR-0025 no. 4) — either an invitation into the assistant **or** the
 * list of open items. Never both.
 *
 * ## The difference between "new" and "running", read from the state
 *
 * An organisation **without a single form** is new; one with
 * forms is running. That is the whole distinction, and it is deliberately
 * no question after a timestamp or a marker "assistant seen":
 * both would describe a past, and both would drift apart as soon as
 * somebody enters the settings elsewhere afterwards.
 *
 * What hangs on it:
 *
 * - **New and something is missing** → the invitation. Whoever has just
 *   received an organisation shall be able to walk through its settings once
 *   guided, without searching for them.
 * - **Running and something is missing** → only the list. To put a setup
 *   assistant in front of an organisation that has been operating forms for
 *   months would be intrusive and wrong on top of that: it *is* set up, it
 *   lacks a single item, and that one is settled at its setting.
 * - **Nothing is missing** → nothing. No "✓ all done": a permanent line
 *   that always says the same is a line that one stops reading.
 *
 * ⚠️ **Nobody is redirected.** The invitation is a button, not a switch —
 * the assistant must lock nobody in, and whoever does not want it does not
 * click it (ADR-0025 no. 3).
 *
 * ## Why the rights stand here and not only at the routes
 *
 * The items of this list read documents that demand different rights.
 * Without a pre-filter every editor's dashboard would ask two routes that
 * answer them 403 — information they do not get, about settings
 * they could not change. The filter is **display and no boundary**:
 * the guards keep deciding themselves, and a role that slipped through here
 * would get nothing from the routes (`CONTRIBUTING.md`).
 */
export function TenantOpenItems({
  tenantId,
  permissions,
  hasForms,
}: {
  /** The active organisation, or `undefined` — then nothing stands here. */
  readonly tenantId: string | undefined;
  /** The rights of this person in this organisation. */
  readonly permissions: Permissions | undefined;
  /**
   * Whether this organisation already has forms, or `undefined` as long as
   * nobody knows.
   *
   * `undefined` counts as **"running"**: out of "we do not know" no
   * invitation into an assistant may be made — the same direction in which
   * the first commissioning already resolves its uncertainty (ADR-0022 no. 1).
   */
  readonly hasForms: boolean | undefined;
}): ReactElement | null {
  const mayReadMail =
    permissions !== undefined &&
    permissions.canManageSettings &&
    permissions.canViewResponses;
  const mayReadGroups = permissions?.canManageUsers ?? false;

  const smtp = useTenantSmtp(
    tenantId !== undefined && mayReadMail ? tenantId : undefined,
  );
  const groups = useTenantGroups(
    tenantId !== undefined && mayReadGroups ? tenantId : undefined,
  );
  /*
    The legal texts hang on `canManageSettings` alone — the same guard that
    `PUT /tenant/legal` demands, and expressly **not** additionally
    `canViewResponses` like the mail block: a legal text carries no
    answer data (`tenant-legal.controller.ts`).
  */
  const legal = useTenantLegal(
    tenantId !== undefined && (permissions?.canManageSettings ?? false)
      ? tenantId
      : undefined,
  );

  const items = tenantOpenItems({
    smtp: smtp.data,
    smtpUnreadable:
      smtp.isError &&
      smtp.error instanceof ApiError &&
      smtp.error.status === 500,
    groups: groups.data,
    legal: legal.data?.pages,
  });

  if (tenantId === undefined || items.length === 0) {
    return null;
  }

  /*
    **Eine Liste, zwei Rahmen** (Review-Runde 3 Nr. 7).

    Bis hierher gab es zwei: die Einladung für eine neue Organisation hatte
    ihre eigene, abgeschriebene Fassung der Punkte — und in der fehlte je
    Zeile der Sprungknopf. Wer „Keine Rechtstexte dieser Organisation
    hinterlegt" las und auf „Einrichtung starten" drückte, landete bei
    Schritt 1 (Erscheinungsbild) und musste sich bis Schritt 8 durchklicken,
    obwohl in der Zeile stand, worum es geht.

    Jetzt trägt **jede** Zeile ihren Weg zur Einstellung, in beiden Rahmen —
    das ist der Weg, den der Befund selbst als den besseren benennt („bzw.
    vermutlich noch besser: direkt in den Tenant-Einstellungen"). Der
    Assistent bleibt als Angebot darunter stehen, für den Fall, für den er
    gedacht ist: einmal geführt durch **alles**, nicht zurück zu einem Punkt.
  */
  if (hasForms === false) {
    return (
      <OpenItemsList
        heading="Diese Organisation ist noch nicht fertig eingerichtet"
        headingId="tenant-setup-invite"
        intro={
          <>
            {items.length === 1
              ? 'Ein Punkt fehlt noch, und ohne ihn geht etwas nicht. '
              : `${String(items.length)} Punkte fehlen noch, und ohne sie geht etwas nicht. `}
            Jeder Punkt führt direkt zu seiner Einstellung.
          </>
        }
        items={items}
        footer={
          <div className="open-items__item">
            <div className="open-items__text">
              <p className="open-items__consequence">
                Oder einmal geführt durch <em>alle</em> Einstellungen dieser
                Organisation — auch durch die, die hier nicht stehen, weil ohne
                sie nichts fehlt. Die Einrichtung lässt sich jederzeit
                verlassen.
              </p>
            </div>
            <button
              type="button"
              className="settings__secondary"
              onClick={() => {
                navigate(TENANT_SETUP_PATH);
              }}
            >
              Einrichtung starten
            </button>
          </div>
        }
      />
    );
  }

  return (
    <OpenItemsList
      heading="Offene Punkte dieser Organisation"
      headingId="tenant-open-items-heading"
      intro="Diese Liste liest den tatsächlichen Zustand dieser Organisation. Sie verschwindet von selbst, sobald ein Punkt erledigt ist — egal, wo er erledigt wurde."
      items={items}
    />
  );
}
