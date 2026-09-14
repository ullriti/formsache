import { useState, type ReactElement } from 'react';

import { useCreateTenant } from '../../api/admin';
import { CreateTenantForm } from '../superadmin/CreateTenantForm';
import { WizardFrame } from '../../wizard';
import type { SetupStepProps } from './MailSteps';

/**
 * **Step 7 — the first organisation.**
 *
 * ## Why this no longer does `POST /api/setup`
 *
 * The setup route still accepts a `tenant`, and the wizard nevertheless always
 * sends `null` there (see `AccessStep`). The reason is not frugality, but
 * **one** mask for one thing: here stands the same form that „+ Neue
 * Organisation" shows in the system administration, calls the same route and
 * creates the same three groups. Two ways would be two places at which the
 * defaults of a new organisation could differ — and the second would be the one
 * nobody maintains, because one sees it once in the life of an installation.
 *
 * It is at the same time what makes this step **independent** of the invitation
 * mail that is currently being worked on: whether the first administrator gets a
 * typed password or an invitation link is decided by `CreateTenantForm` with
 * `tenantCreateSchema` — this step sees nothing of that.
 *
 * ## „Mich selbst als ersten Administrator eintragen"
 *
 * Exactly the case this switch stands in the form for: the superadministrator
 * just created is signed in, wants to use the organisation themselves afterwards,
 * and `admin: null` tells the server to take the id from the session. Nothing at
 * all is typed then.
 *
 * ## The hint at the end
 *
 * If an organisation is created here, the wizard ends with the sentence that a
 * setup step **of its own** is outstanding for it — appearance, mail sending,
 * permissions. The wizard for that is built on the same scaffolding
 * (`src/wizard/`); this step only remembers whether there is an organisation to
 * mention.
 */
export function TenantStep({
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: SetupStepProps): ReactElement {
  const create = useCreateTenant();
  /**
   * Whether the form is currently open.
   *
   * It starts **closed**, with a paragraph in front of it: this step is
   * skippable, and a form that jumps at one right away reads like an obligation.
   * „Überspringen" lies next to it and does the same as „später".
   */
  const [open, setOpen] = useState(false);

  return (
    <WizardFrame
      title="Erste Einrichtung"
      steps={steps}
      currentIndex={index}
      primary={
        open
          ? {
              label: 'Weiter ohne Organisation',
              onClick: onSkip,
              disabled: create.isPending,
            }
          : {
              label: 'Organisation anlegen',
              onClick: () => {
                setOpen(true);
              },
            }
      }
      onBack={onBack}
      onJump={onJump}
      onSkip={open ? undefined : onSkip}
    >
      {/*
        **Was hier steht, steht sonst nirgends** (Review-Runde 5, Nachtrag).
        Dieser Absatz sagte bis dahin denselben Satz wie die Zeile über ihm
        („Ohne eine Organisation kann niemand ein Formular anlegen",
        `steps.ts`), nur in anderer Reihenfolge. Übrig bleibt das, was die
        Zeile nicht sagen kann, weil es keine Folge des Auslassens ist: dass
        das Auslassen erlaubt ist und wo man es nachholt.
      */}
      <p className="settings__note">
        Ein Superadministrator ohne Organisation ist ein gültiger Endzustand;
        Organisationen lassen sich jederzeit später unter{' '}
        <em>Verwaltung → System → Organisationen</em> anlegen.
      </p>

      {open ? (
        <CreateTenantForm
          create={create}
          onCreated={onDone}
          onCancel={() => {
            setOpen(false);
            create.reset();
          }}
        />
      ) : null}
    </WizardFrame>
  );
}
