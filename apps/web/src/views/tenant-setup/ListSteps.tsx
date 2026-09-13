import type { ReactElement } from 'react';

import { TenantMembersTab } from '../tenant-admin/TenantMembersTab';
import { TenantStepFrame } from './TenantStepFrame';
import type { TenantStepProps } from './SettingsSteps';

/**
 * **The two steps that are not documents** — groups and people
 * (ADR-0025).
 *
 * ## Why the primary button here is called „Weiter"
 *
 * Because there is nothing that a single button could save. A group
 * is a document of its own with a save bar of its own
 * (`TenantGroupsEditor`), an invitation is a `POST` that happens immediately,
 * and a role change a `PUT` per row. A „Speichern und weiter"
 * above that would have to claim it knew which of ten rows are to be
 * written — and would be wrong the moment someone has touched two of
 * them.
 *
 * They are nonetheless **two** steps and not one: "who is on board?" and
 * "what may a role do?" are two questions, and a step that asks both at
 * once is the step people skip. Both show the same
 * view as the *Nutzerrechte* tab, only one half of it each
 * (`TenantMembersTab`'s `sections`).
 *
 * ⚠️ Both need `canManageUsers`; whoever does not have it does not even
 * see them — the wizard visibly skips them beforehand (`steps.ts`).
 */

/** Step 4 — adjust the three default groups or create a fourth. */
export function GroupsStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
  currentUserId,
}: TenantStepProps & { readonly currentUserId: string }): ReactElement {
  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel="Weiter"
      onPrimary={onDone}
    >
      {/*
        Dass die drei Standardgruppen bereits stehen, sagt die Zeile über dem
        Schritt (`steps.ts`); hier steht nur noch, warum der Knopf unten
        anders heißt als in den übrigen Schritten (Review-Runde 5, Nachtrag).
      */}
      <p className="settings__notice">
        Was du hier änderst, wirkt sofort —{' '}
        <strong>jede Gruppe speichert für sich</strong>, deshalb steht unten
        „Weiter" und nicht „Speichern und weiter".
      </p>
      <TenantMembersTab
        tenantId={tenantId}
        currentUserId={currentUserId}
        sections="groups"
      />
    </TenantStepFrame>
  );
}

/** Step 5 — invite further people into this organization. */
export function PeopleStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
  currentUserId,
}: TenantStepProps & { readonly currentUserId: string }): ReactElement {
  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel="Weiter"
      onPrimary={onDone}
    >
      <p className="settings__notice">
        Wer hinzugefügt wird, bekommt eine Einladung per E-Mail und vergibt sein
        Passwort selbst. <strong>Jede Person wird sofort angelegt</strong>,
        deshalb steht unten „Weiter" und nicht „Speichern und weiter".
      </p>
      <p className="settings__notice">
        Die Einladung geht über den Mailserver der <strong>Installation</strong>
        , nicht über den dieser Organisation — sonst bekäme ein Relay, das hier
        jemand einträgt, die Vollmacht über ein fremdes Konto im Klartext.
        Deshalb hängt dieser Schritt nicht am Mailserver aus Schritt 2: hat die
        Installation keinen, sagt die Anwendung das beim Anlegen und legt gar
        nichts an.
      </p>
      <TenantMembersTab
        tenantId={tenantId}
        currentUserId={currentUserId}
        sections="people"
      />
    </TenantStepFrame>
  );
}
