import { useState, type ReactElement } from 'react';
import type { Permissions } from '@formsache/shared';

import type { WizardStepStatus } from '../../wizard';
import { PERMISSION_LABELS } from '../permission-labels';
import { GroupsStep, PeopleStep } from './ListSteps';
import {
  AddressesStep,
  AiStep,
  AppearanceStep,
  FormDefaultsStep,
  LegalStep,
  MailStep,
  OidcStep,
  type TenantStepProps,
} from './SettingsSteps';
import { TenantSetupComplete } from './TenantSetupComplete';
import { SkippedStepNotice, TenantStepFrame } from './TenantStepFrame';
import { TENANT_SETUP_STEPS, stepPermitted, tenantWizardSteps } from './steps';

import '../settings-view.css';

/**
 * **The initial setup of an organisation** (ADR-0025) — eight steps through all
 * the settings an organisation has, each one skippable.
 *
 * ## Why this here is an address and the initial commissioning is not
 *
 * The initial commissioning is a *state before the sign-in*: there is nothing to
 * navigate, no session, no second page (ADR-0022 no. 1). Here the opposite is
 * the case — there is a session, a header, a dashboard and eight settings pages
 * to which this flow leads. An address (`/admin/setup`) is therefore
 * right: it can be left, found again, sent to a colleague and operated with the
 * back button.
 *
 * ## Nobody is forced in here
 *
 * There is **no** redirect into this flow. Whoever gets an organisation newly
 * created finds an invitation on its dashboard (`TenantOpenItems`); whoever does
 * not want it does not click it. In every step there is moreover „Später
 * einrichten" (`TenantStepFrame`). The reason is the promise from the
 * commission: the wizard must not lock anybody in — and a flow that one gets out
 * of only by clicking through does exactly that.
 *
 * ## The progress lives in this component and nowhere else
 *
 * `useState`, no marker on the server. What the wizard has **experienced** is a
 * past; what is missing is a question to the present, and that is answered by
 * the list of open items from the documents themselves (`open-items.ts`,
 * ADR-0022 no. 5 in the same matter). A saved progress would be exactly the
 * marker that both ADRs rule out.
 */
export interface TenantSetupViewProps {
  /** The active organisation, or `undefined` if none is chosen. */
  readonly tenantId?: string | undefined;
  readonly tenantName?: string | undefined;
  /** The short name — for the addresses of the legal pages in step 8. */
  readonly tenantShortName?: string | undefined;
  /**
   * The permissions of this person **in this organisation**, the way the server
   * has reported them — never a locally remembered or most broadly held
   * selection.
   *
   * They decide **nothing** here except the display: every route asks its own
   * guard. What they prevent is a form that looks like a form and says 403 on
   * saving.
   */
  readonly permissions: Permissions;
  /** For the member list — who „Sie" is. */
  readonly currentUserId: string;
  /** For the test mail in step 2 — where it goes without an entry. */
  readonly currentUserEmail: string;
}

export function TenantSetupView({
  tenantId,
  tenantName,
  tenantShortName,
  permissions,
  currentUserId,
  currentUserEmail,
}: TenantSetupViewProps): ReactElement {
  const [index, setIndex] = useState(0);
  const [statuses, setStatuses] = useState<readonly WizardStepStatus[]>(() =>
    TENANT_SETUP_STEPS.map(() => 'open' as const),
  );

  if (
    tenantId === undefined ||
    tenantName === undefined ||
    tenantShortName === undefined
  ) {
    return (
      <div className="settings">
        <p className="settings__state" role="status">
          Bitte zuerst eine Organisation auswählen.
        </p>
      </div>
    );
  }

  const advance = (status: WizardStepStatus): void => {
    setStatuses((previous) =>
      previous.map((entry, position) => (position === index ? status : entry)),
    );
    setIndex(index + 1);
  };

  const steps = tenantWizardSteps(statuses, permissions);
  const current = TENANT_SETUP_STEPS[index];

  if (current === undefined) {
    return (
      <TenantSetupComplete
        tenantName={tenantName}
        skipped={steps.filter((step) => step.status === 'skipped').length}
      />
    );
  }

  const common: TenantStepProps = {
    tenantId,
    tenantName,
    tenantShortName,
    steps,
    index,
    onBack:
      index === 0
        ? undefined
        : () => {
            setIndex(index - 1);
          },
    /**
     * **Die Schrittliste oben navigiert** (Review-Runde 3 Nr. 6) — hier ohne
     * Ausnahme: kein Schritt dieses Assistenten ist einmalig, jeder ist eine
     * gewöhnliche, angemeldete Einstellung dieser Organisation.
     *
     * Ein Sprung speichert nicht; wer einen Schritt abschließen will, drückt
     * weiterhin „Speichern und weiter".
     */
    onJump: (target: number): void => {
      setIndex(target);
    },
    onDone: () => {
      advance('done');
    },
    onSkip: () => {
      advance('skipped');
    },
  };

  /**
   * **A step that this role may not do is shown and skipped** — not left out and
   * not as a form.
   *
   * Left out (that is, not passed through at all) would be the more convenient
   * variant and the worse one: the step list names it anyway, and whoever sees
   * it there and never reaches it does not know why. Here the reason stands, and
   * the count „Schritt 4 von 8" stays the one that stands in the list.
   */
  if (!stepPermitted(current, permissions)) {
    return (
      <TenantStepFrame
        tenantName={tenantName}
        steps={steps}
        currentIndex={index}
        onBack={common.onBack}
        onSkip={common.onSkip}
        primaryLabel="Weiter"
        onPrimary={common.onSkip}
      >
        <SkippedStepNotice
          reason={`Dieser Schritt braucht ${describePermissions(current.requires)}. Deine Rolle in dieser Organisation hat das nicht — er wird übersprungen. Wer die Rechte hat, kann ihn jederzeit in der Organisationsverwaltung nachholen.`}
        />
      </TenantStepFrame>
    );
  }

  switch (current.key) {
    case 'appearance':
      return <AppearanceStep {...common} />;
    case 'mail':
      return <MailStep {...common} currentUserEmail={currentUserEmail} />;
    case 'addresses':
      return <AddressesStep {...common} />;
    case 'groups':
      return <GroupsStep {...common} currentUserId={currentUserId} />;
    case 'people':
      return <PeopleStep {...common} currentUserId={currentUserId} />;
    case 'form-defaults':
      return <FormDefaultsStep {...common} />;
    case 'oidc':
      return <OidcStep {...common} />;
    case 'legal':
      return <LegalStep {...common} />;
    default:
      return <AiStep {...common} />;
  }
}

/**
 * The permissions of a step, named the way they are called in the permission
 * administration — from `PERMISSION_LABELS`, so that no second naming comes into
 * being here.
 */
function describePermissions(required: readonly (keyof Permissions)[]): string {
  const names = required.map((permission) => {
    const label = PERMISSION_LABELS.find((entry) => entry.key === permission);
    return `„${label?.label ?? permission}"`;
  });
  const last = names[names.length - 1] ?? '';
  if (names.length <= 1) {
    return `das Recht ${last}`;
  }
  return `die Rechte ${names.slice(0, -1).join(', ')} und ${last}`;
}
