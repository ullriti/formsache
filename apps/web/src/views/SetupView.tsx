import { useState, type ReactElement } from 'react';

import type { WizardStepStatus } from '../wizard';
import { AccessStep } from './setup/AccessStep';
import { AddressesStep, BaseUrlStep, MailServerStep } from './setup/MailSteps';
import { AiStep, LegalStep } from './setup/SettingsSteps';
import { SetupComplete } from './setup/SetupComplete';
import { TenantStep } from './setup/TenantStep';
import { SETUP_STEPS, wizardSteps } from './setup/steps';

import './settings-view.css';

/**
 * **First-time setup** (ADR-0022, continuation 2026-08-18) — what an
 * installation shows as long as it has not a single account.
 *
 * It stands in the place of the sign-in, not behind it: there is nobody
 * who could sign in. What comes into being here was until 2026-08-18 **one
 * form** (access, optionally an organisation, then a reload) and is now an
 * **assistant** that leads once through all the system settings and says at every
 * step what does not work without it.
 *
 * ## Guiding, but skippable
 *
 * The user's decision, and it shapes every line here: **every** step
 * except the first one can be skipped. Nobody is blocked — and
 * nobody forgets it quietly, because the system administration afterwards keeps a list
 * of open items. That list reads the **actual state**
 * (`views/system-settings/open-items.ts`) and not what was skipped
 * here: a marker would drift apart as soon as somebody added the setting
 * elsewhere.
 *
 * ## The break in the middle: after step 1 there is a session
 *
 * Step 1 calls `POST /api/setup` — the one unprotected route that creates a
 * superadministrator as long as the installation has zero rows in `user`,
 * checked in the same transaction as the write and behind
 * `pg_advisory_xact_lock`. **This route is unchanged**, including its
 * promise not to issue a session (ADR-0022 no. 2).
 *
 * Steps 2 to 7, by contrast, are perfectly ordinary, signed-in
 * system-settings routes behind `SuperadminGuard`. The session in between
 * comes into being through an **ordinary sign-in** with the credentials just
 * typed (`AccessStep`) — not by the setup route being allowed more
 * than before. The setup thereby remains *one* protected call and
 * does not fall apart into several unprotected ones.
 *
 * **That is why „Zurück" never leads to step 1.** It is the only step
 * of this flow that cannot be repeated — the route it calls
 * does not exist after it. A „Zurück" out of step 2 would land on a
 * form with no way forward; it is therefore only offered from step 3 on (see
 * `onBack` below).
 *
 * ## Why the state lies here and not in a router
 *
 * There is no address for this flow, and there is not meant to be one (ADR-0022
 * no. 1): an address would be one that can be called up when it no longer does
 * anything. The step is therefore `useState` in this component, and the frame
 * (`src/wizard/`) knows nothing of routes — so that the same frame can carry the
 * organisation assistant, which will have an address.
 */
export function SetupView(): ReactElement {
  const [index, setIndex] = useState(0);
  const [statuses, setStatuses] = useState<readonly WizardStepStatus[]>(() =>
    SETUP_STEPS.map(() => 'open' as const),
  );

  const advance = (status: WizardStepStatus): void => {
    setStatuses((previous) =>
      previous.map((entry, position) => (position === index ? status : entry)),
    );
    setIndex(index + 1);
  };

  const steps = wizardSteps(statuses);
  const common = {
    steps,
    index,
    /**
     * **There is a „Zurück" only from step 3 on** — not from step 2.
     *
     * The obvious expression („alles außer dem ersten Schritt darf zurück")
     * was the trap: step 1 creates the account, and `POST /api/setup`
     * answers 404 afterwards as long as the installation has a `user` row.
     * Whoever went back out of step 2 stood before `AccessStep`, got
     * `ALREADY_MESSAGE` to look at there and could get no further forward: `onDone()` is
     * never called in that branch. The only way out was a reload — that is,
     * exactly the locking-in that the head of this file rules out.
     *
     * `index <= 1` and not `index === 0`: the comparison points at the
     * step „Zurück" **would lead to**, and that is the one that cannot be
     * repeated. The same handling as in `TenantSetupView`, only one place
     * fewer there, because no step there is one-off.
     */
    onBack:
      index <= 1
        ? undefined
        : () => {
            setIndex(index - 1);
          },
    /**
     * **Die Schrittliste oben navigiert** (Review-Runde 3 Nr. 6).
     *
     * Dieselbe Ausnahme wie bei „Zurück", und aus demselben Grund: Schritt 1
     * ist nicht wiederholbar. Sie steht hier aber nicht noch einmal als
     * Bedingung — `wizardSteps` setzt `reachable: index > 0`, und der Rahmen
     * ruft diese Funktion für einen nicht erreichbaren Schritt gar nicht auf.
     * Zwei Stellen mit derselben Regel wären die zwei, von denen eine
     * irgendwann falsch wird.
     *
     * ⚠️ **Ein Sprung speichert nicht.** Das ist keine Nachlässigkeit,
     * sondern der Unterschied zu „Speichern und weiter": wer die Liste
     * benutzt, will woandershin und nicht diesen Schritt abschließen. Was in
     * den Mail-Schritten getippt wurde, überlebt den Sprung trotzdem — die
     * drei teilen sich einen Entwurf (`useServerDraft` in `use-mail-step.ts`),
     * und der hängt nicht an der Ansicht.
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

  if (index >= SETUP_STEPS.length) {
    return (
      <SetupComplete
        tenantCreated={statuses[SETUP_STEPS.length - 1] === 'done'}
        skipped={statuses.filter((status) => status === 'skipped').length}
      />
    );
  }

  switch (SETUP_STEPS[index]?.key) {
    case 'access':
      // Without „Zurück" and without „Überspringen": before this step there is nothing,
      // and without it nothing works.
      return <AccessStep steps={steps} index={index} onDone={common.onDone} />;
    case 'base-url':
      return <BaseUrlStep {...common} />;
    case 'mail':
      return <MailServerStep {...common} />;
    case 'addresses':
      return <AddressesStep {...common} />;
    case 'ai':
      return <AiStep {...common} />;
    case 'legal':
      return <LegalStep {...common} />;
    default:
      return <TenantStep {...common} />;
  }
}
