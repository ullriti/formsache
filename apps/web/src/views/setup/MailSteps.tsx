import type { ReactElement, ReactNode } from 'react';

import { useSession } from '../../api/session';
import { useSendSystemTestMail } from '../../api/system-settings';
import { TestMailCard } from '../settings/TestMailCard';
import {
  SystemAddressesCard,
  SystemBaseUrlCard,
  SystemMailServerCard,
} from '../system-settings/SystemMailCards';
import { WizardFrame, type WizardStepMeta } from '../../wizard';
import { useMailStep, type MailStepState } from './use-mail-step';

/**
 * **Steps 2 to 4 of the setup wizard** — base address,
 * mail server, addresses.
 *
 * They show **the same cards** that the tab *Mailserver* of the
 * system administration shows (`SystemMailCards.tsx`), and write the same
 * document over the same route. What the wizard adds is the
 * order, the sentence „what does not work without this step" and the
 * skipping; nothing is copied.
 */

/** What each of these three steps gets from its host. */
export interface SetupStepProps {
  readonly steps: readonly WizardStepMeta[];
  readonly index: number;
  /**
   * „Zurück", or `undefined` — **and `undefined` is not an edge case.**
   *
   * Step 1 creates the account, and after that `POST /api/setup` no longer
   * exists: the route answers 404 as soon as the installation has a `user`
   * row. A „Zurück" out of step 2 therefore led to a mask out of which
   * no way forward leads any more — the wizard would have locked somebody in,
   * exactly what `SetupView` rules out. The host gives a function here from
   * step 3 onwards and nothing before that (`SetupView.tsx`).
   */
  readonly onBack?: (() => void) | undefined;
  /**
   * Zu einem beliebigen (wiederholbaren) Schritt springen — die Schrittliste
   * oben ist seit Review-Runde 3 Nr. 6 bedienbar. Die Begründung, warum
   * Schritt 1 dabei ausgenommen bleibt, steht in `setup/steps.ts`.
   */
  readonly onJump: (index: number) => void;
  readonly onDone: () => void;
  readonly onSkip: () => void;
}

/**
 * The shared body: load, fail, or show the cards and on the
 * next click save the **whole** document.
 *
 * The main button always saves, even when nothing was changed — a
 * full replacement with the same values has no consequences, and the
 * alternative would be a „Weiter" that does two different things depending on
 * the state.
 */
function MailStepFrame({
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
  state,
  children,
}: SetupStepProps & {
  readonly state: MailStepState;
  readonly children: (
    ready: Extract<MailStepState, { kind: 'ready' }>,
  ) => ReactNode;
}): ReactElement {
  return (
    <WizardFrame
      title="Erste Einrichtung"
      steps={steps}
      currentIndex={index}
      primary={{
        label:
          state.kind === 'ready' && state.isSaving
            ? 'Wird gespeichert…'
            : 'Speichern und weiter',
        onClick: () => {
          if (state.kind === 'ready') {
            state.save(onDone);
          }
        },
        disabled: state.kind !== 'ready' || state.isSaving,
      }}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      error={
        state.kind === 'failed'
          ? state.message
          : state.kind === 'ready'
            ? state.errorMessage
            : null
      }
    >
      {state.kind === 'loading' ? (
        <p className="settings__state" role="status">
          Einstellungen werden geladen…
        </p>
      ) : state.kind === 'failed' ? null : (
        children(state)
      )}
    </WizardFrame>
  );
}

/**
 * ⚠️ **Step 2 pre-fills the base address from the URL it was called under** —
 * and still puts it up for confirmation.
 *
 * `window.location.origin` is exactly right in the vast majority of
 * installations, and it is the only piece of information in this wizard that
 * the application can find out about itself. Taking it over **blindly**
 * would be wrong nonetheless: behind a reverse proxy the address the
 * browser sees is not necessarily the one under which the installation is
 * reachable from outside — and a wrong value here produces links that point
 * nowhere in every mail and cannot be recalled.
 *
 * Hence: pre-filled, visible, changeable, and with a sentence at the field
 * that says exactly that. What is more, only what is **empty** is pre-filled —
 * a second visit to this step overwrites no stored value.
 */
export function BaseUrlStep(props: SetupStepProps): ReactElement {
  const state = useMailStep({
    prefill: (draft) =>
      draft.publicBaseUrl === ''
        ? { ...draft, publicBaseUrl: window.location.origin }
        : draft,
  });

  return (
    <MailStepFrame {...props} state={state}>
      {(ready) => (
        <SystemBaseUrlCard
          draft={ready.draft}
          setDraft={ready.setDraft}
          issues={ready.issues}
          prefillNote="Vorbelegt mit der Adresse, unter der du diese Seite gerade aufgerufen hast. Bitte prüfen: hinter einem Reverse-Proxy ist das nicht zwingend die Adresse, unter der die Installation von außen erreichbar ist — und ein falscher Wert erzeugt Links in Mails, die ins Leere zeigen."
        />
      )}
    </MailStepFrame>
  );
}

/**
 * Step 3 — the mail server of the instance, with a test mail on the spot.
 *
 * ## Drei Befunde treffen sich in diesem Schritt
 *
 * **Runde 3 Nr. 2: der Knopf ließ sich nicht drücken.** Die Testmail prüft,
 * was *gespeichert* ist — richtig so —, und der einzige Weg zu speichern hieß
 * „Speichern und weiter", führte also vom Knopf weg. Wer hier stand, sah eine
 * Probe, die es in diesem Schritt gar nicht gab. Die Antwort war ein
 * **„Speichern"** neben dem Hauptknopf, das hier blieb.
 *
 * **Runde 4 Nr. 3: es waren immer noch zwei Knöpfe.** *„Vielleicht den Button
 * so: ‚Speichern und Testmail senden'?"* — und das ist die richtige Auflösung.
 * Der Zweitknopf unten und der gesperrte Knopf oben waren zwei Enden einer
 * Handlung; jetzt speichert die Karte selbst und sendet danach
 * (`TestMailCard.saveFirst`). Der Sperrgrund entfällt mit ihm: es gibt keinen
 * ungespeicherten Zustand mehr, in dem das Senden falsch wäre.
 *
 * **Runde 3 Nr. 12: sie brauchte eine Organisation, die es hier nicht gibt.**
 * Die Route hing an `TenantScopeGuard`, und zwar nie wegen der Berechtigung,
 * sondern wegen der Zeile: `mail_log.tenant_id` ist `NOT NULL`. Ein
 * Superadministrator ohne Mitgliedschaft bekam 403 — ausgerechnet während der
 * Erstinbetriebnahme, wo die erste Organisation erst in Schritt 8 kommt. Die
 * Route lässt jetzt durch und **protokolliert nicht**
 * (`TestMailService.sendWithoutTenant`); die Karte schreibt genau das an den
 * Knopf, statt es zu verschweigen (`logged`).
 *
 * Damit ist der Mailserver dort prüfbar, wo man ihn einrichtet — und das war
 * der ganze Sinn dieses Schrittes.
 */
export function MailServerStep(props: SetupStepProps): ReactElement {
  const state = useMailStep();
  const testMail = useSendSystemTestMail();
  // For the default „an mich selbst", its label — and for the question whether
  // there is an organisation at all in whose mail log the attempt
  // could be filed.
  const session = useSession();
  const hasTenant =
    session.data !== null && session.data?.activeTenantId !== null;

  return (
    <MailStepFrame {...props} state={state}>
      {(ready) => (
        <>
          <SystemMailServerCard
            draft={ready.draft}
            setDraft={ready.setDraft}
            issues={ready.issues}
            hadPassword={ready.hadPassword}
          />
          <TestMailCard
            heading="Testmail"
            headingId="setup-test-mail-heading"
            hint={
              <>
                Prüft den <strong>Mailserver dieser Instanz</strong> mit einer
                echten E-Mail. Geprüft wird immer, was{' '}
                <strong>gespeichert</strong> ist — deshalb speichert der Knopf
                zuerst und sendet danach. Der Schritt bleibt dabei stehen.
              </>
            }
            currentUserEmail={session.data?.email ?? ''}
            blockedReason={null}
            saveFirst={{
              run: (onSaved) => {
                ready.save(onSaved);
              },
              pending: ready.isSaving,
            }}
            logged={hasTenant}
            send={testMail}
            forbiddenMessage="Testmail nicht möglich: Dafür braucht es Superadmin-Rechte und eine ausgewählte Organisation – in deren Versandprotokoll wird der Versuch abgelegt."
          />
        </>
      )}
    </MailStepFrame>
  );
}

/** Step 4 — reply address and operator address for operational alarms. */
export function AddressesStep(props: SetupStepProps): ReactElement {
  const state = useMailStep();

  return (
    <MailStepFrame {...props} state={state}>
      {(ready) => (
        <SystemAddressesCard
          draft={ready.draft}
          setDraft={ready.setDraft}
          issues={ready.issues}
        />
      )}
    </MailStepFrame>
  );
}
