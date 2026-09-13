import type { ReactElement } from 'react';

import { useSendTestMail } from '../../api/tenant-admin';
import type { WizardStepMeta } from '../../wizard';
import { TestMailCard } from '../settings/TestMailCard';
import { MailIdentityFields } from '../tenant-admin/MailIdentityFields';
import {
  TenantBaseUrlFields,
  TenantReplyToFields,
} from '../tenant-admin/TenantAddressCards';
import { TenantAiFields } from '../tenant-admin/TenantAiFields';
import { TenantAppearanceCards } from '../tenant-admin/TenantAppearanceCards';
import { TenantFormDefaultsCards } from '../tenant-admin/TenantFormDefaultsCards';
import { TenantOidcFields } from '../tenant-admin/TenantOidcFields';
import { useTenantAiState } from '../tenant-admin/use-tenant-ai';
import {
  useTenantBaseUrlState,
  useTenantReplyToState,
} from '../tenant-admin/use-tenant-addresses';
import { useTenantBrandingState } from '../tenant-admin/use-tenant-branding';
import { useTenantFormDefaultsState } from '../tenant-admin/use-tenant-form-defaults';
import { useTenantOidcState } from '../tenant-admin/use-tenant-oidc';
import { useTenantSmtpState } from '../tenant-admin/use-tenant-smtp';
import { SkippedStepNotice, TenantStepFrame } from './TenantStepFrame';
import { TenantLegalCards } from '../tenant-admin/TenantLegalTab';
import { useTenantLegalPages } from '../tenant-admin/use-tenant-legal';

/**
 * **The steps that carry one document each** — Erscheinungsbild, Mailserver,
 * Adressen, Formular-Standards, SSO, KI (ADR-0025).
 *
 * They show **the same cards** that the tabs of the organisation administration
 * show, and write the same documents over the same routes. What the
 * assistant adds is the order, the sentence „was ohne diesen Schritt
 * nicht geht" and the skipping; nothing is copied — the fields
 * stand in `views/tenant-admin/`, the state in the hooks beside them.
 *
 * ## Why the main button is called „Speichern und weiter" here
 *
 * Because each of these steps has **one** document with **one** saving
 * operation. Where that is not so — groups and persons are lists in which every
 * row is saved for itself —, the button is called „Weiter" and the cards
 * keep their own buttons (`ListSteps.tsx`). The difference is not
 * cosmetics: a „Speichern und weiter" above a list would have to claim it
 * knew what of ten rows is to be written.
 */

/** What every step gets from the host. */
export interface TenantStepProps {
  readonly tenantId: string;
  readonly tenantName: string;
  /**
   * The short name — it sits in the public addresses of the legal texts
   * of this organisation (`/o/<kurzname>/…`). Only step 8 reads it; it stands
   * in the common properties nevertheless, so that one step does not need a
   * second way to the session.
   */
  readonly tenantShortName: string;
  readonly steps: readonly WizardStepMeta[];
  readonly index: number;
  readonly onBack: (() => void) | undefined;
  /**
   * Zu einem Schritt der Liste oben springen (Review-Runde 3 Nr. 6). Hier
   * ohne Ausnahme erreichbar — siehe `tenant-setup/steps.ts`.
   */
  readonly onJump: (index: number) => void;
  readonly onDone: () => void;
  readonly onSkip: () => void;
}

/** „Speichern und weiter", or what stands there in the meantime. */
function savingLabel(isSaving: boolean): string {
  return isSaving ? 'Wird gespeichert…' : 'Speichern und weiter';
}

/** Step 1 — logo, name and colours, with the contrast hints. */
export function AppearanceStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  const state = useTenantBrandingState(tenantId);

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={
        state.kind === 'ready' ? savingLabel(state.isSaving) : 'Weiter'
      }
      primaryDisabled={state.kind === 'ready' && state.isSaving}
      onPrimary={() => {
        if (state.kind === 'ready') {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          Erscheinungsbild wird geladen…
        </p>
      ) : state.kind === 'failed' ? null : (
        <TenantAppearanceCards
          tenantId={tenantId}
          document={state.document}
          draft={state.draft}
          setDraft={state.setDraft}
          issues={state.issues}
        />
      )}
    </TenantStepFrame>
  );
}

/**
 * Step 2 — the mail server of this organisation, with a test mail on the
 * spot.
 *
 * ⚠️ **The most important step of the assistant**, and the card says it itself:
 * as long as the switch is off, the sentence „Ohne eigenen Mailserver
 * verschickt diese Organisation nichts" stands above the fields.
 *
 * Die Testmail prüft den **gespeicherten** Block — und speichert dafür selbst,
 * statt sich zu sperren (Review-Runde 4 Nr. 3, `TestMailCard.saveFirst`). Der
 * Knopf heißt deshalb „Speichern und Testmail senden"; der Schritt bleibt
 * dabei stehen, im Unterschied zum „Speichern und weiter" darunter.
 */
export function MailStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
  currentUserEmail,
}: TenantStepProps & {
  readonly currentUserEmail: string;
}): ReactElement {
  const state = useTenantSmtpState(tenantId);
  const testMail = useSendTestMail();

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={
        state.kind === 'ready' ? savingLabel(state.isSaving) : 'Weiter'
      }
      primaryDisabled={state.kind === 'ready' && state.isSaving}
      onPrimary={() => {
        if (state.kind === 'ready') {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          Mailversand wird geladen…
        </p>
      ) : state.kind === 'failed' ? null : (
        <>
          <section
            className="settings-card"
            aria-labelledby="tenant-setup-mail-heading"
          >
            <header className="settings-card__head">
              <div className="settings-card__text">
                <h2
                  className="settings-card__heading"
                  id="tenant-setup-mail-heading"
                >
                  Mailversand
                </h2>
                <p className="settings-card__hint">
                  Über diesen Server verschickt diese Organisation ihre E-Mails.
                  Host, Port, Verschlüsselung, Anmeldung und Absenderadresse
                  gehören zusammen — ein halb ausgefüllter Block lässt sich
                  nicht speichern.
                </p>
              </div>
            </header>
            <div className="settings-card__body">
              <MailIdentityFields
                draft={state.draft}
                setDraft={state.setDraft}
                issues={state.issues}
                unreadable={state.unreadable}
                hadPassword={state.hadPassword}
                usernameIssue={state.usernameIssue}
              />
            </div>
          </section>

          <TestMailCard
            heading="Testmail"
            headingId="tenant-setup-mail-test-heading"
            hint={
              <>
                Prüft den Mailversand dieser Organisation mit einer echten
                E-Mail. Geprüft wird immer, was <strong>gespeichert</strong> ist
                — deshalb speichert der Knopf zuerst und sendet danach. Der
                Schritt bleibt dabei stehen.
              </>
            }
            currentUserEmail={currentUserEmail}
            blockedReason={null}
            saveFirst={{
              run: (onSaved) => {
                state.save(onSaved);
              },
              pending: state.isSaving,
            }}
            // Immer protokolliert: diese Route läuft im Bereich einer
            // Organisation, und deren Versandprotokoll gibt es damit auch.
            logged
            send={testMail}
            forbiddenMessage="Diese Rolle darf keine Testmail senden."
          />
        </>
      )}
    </TenantStepFrame>
  );
}

/**
 * Step 3 — base address and reply address.
 *
 * **Two documents, one button.** They stay two routes (ADR-0013 no. 3: the
 * address does not belong in the indivisible SMTP block), but they stand on
 * one page and are decided together. The button therefore saves
 * both and goes on only when **both** are through — otherwise the
 * flow would hang on the question which of the two refusals wins.
 */
export function AddressesStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  /**
   * ⚠️ **Die Basis-Adresse ist vorbelegt — mit der, unter der diese Seite
   * gerade aufgerufen wurde** (Review-Runde 3 Nr. 5): *„Auch bei
   * Org-Einrichtung sollte per Default die Basis-Adresse ermittelt werden."*
   *
   * Derselbe Aufbau wie im Assistenten der Installation
   * (`views/setup/MailSteps.tsx`): nur was **leer** ist wird vorbelegt, der
   * Wert steht sichtbar da, lässt sich ändern, und ein Satz am Feld sagt, wo
   * er herkommt und warum man ihn prüfen soll — hinter einem Reverse-Proxy ist
   * die Adresse des Browsers nicht zwingend die, unter der die Installation
   * von außen erreichbar ist.
   *
   * ⚠️ **Und ein Unterschied zur Installation, der im Satz stehen muss:**
   * hier ist das Feld **freiwillig**. Leer heißt nicht „keine Adresse",
   * sondern „die der Installation gilt" — und das ist für die meisten
   * Organisationen das Richtige, weil eine spätere Änderung an der
   * Installation dann mitwandert. Eine eingetragene eigene Adresse ist eine
   * zweite Wahrheit, die man pflegen muss. Wer die Vorbelegung übernimmt,
   * entscheidet sich also für etwas; deshalb steht es dort.
   *
   * Seit Review-Runde 5 (Nachtrag) steht dort allerdings **nur noch das**:
   * dass ein leeres Feld die Systemvorgabe gelten lässt, sagt die Karte selbst
   * eine Zeile tiefer (`TenantAddressCards.tsx`) und die Zeile über dem
   * Schritt ein drittes Mal. Übrig bleibt hier, was beide nicht sagen — dass
   * die Adresse der Installation dann **mitwandert**.
   */
  const baseUrl = useTenantBaseUrlState(tenantId, {
    prefill: (value) => (value === '' ? window.location.origin : value),
  });
  const replyTo = useTenantReplyToState(tenantId);

  const loading = baseUrl.kind === 'loading' || replyTo.kind === 'loading';
  const failure =
    baseUrl.kind === 'failed'
      ? baseUrl.message
      : replyTo.kind === 'failed'
        ? replyTo.message
        : null;
  const ready = baseUrl.kind === 'ready' && replyTo.kind === 'ready';
  const isSaving =
    (baseUrl.kind === 'ready' && baseUrl.isSaving) ||
    (replyTo.kind === 'ready' && replyTo.isSaving);
  const saveError =
    (baseUrl.kind === 'ready' ? baseUrl.errorMessage : null) ??
    (replyTo.kind === 'ready' ? replyTo.errorMessage : null);

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={ready ? savingLabel(isSaving) : 'Weiter'}
      primaryDisabled={ready && isSaving}
      onPrimary={() => {
        if (baseUrl.kind !== 'ready' || replyTo.kind !== 'ready') {
          onSkip();
          return;
        }
        // Two writing operations, one going on: the second counts along, so that
        // the step does not count as done while one of the two
        // addresses is still on its way.
        let remaining = 2;
        const step = (): void => {
          remaining -= 1;
          if (remaining === 0) {
            onDone();
          }
        };
        baseUrl.save(step);
        replyTo.save(step);
      }}
      error={failure ?? saveError}
    >
      {loading ? (
        <p className="settings__state" role="status">
          Adressen werden geladen…
        </p>
      ) : (
        <>
          {baseUrl.kind === 'ready' ? (
            <TenantBaseUrlFields
              field={baseUrl.field}
              prefillNote="Vorbelegt mit der Adresse, unter der du diese Seite gerade aufgerufen hast. Bitte prüfen: hinter einem Reverse-Proxy ist das nicht zwingend die Adresse, unter der die Installation von außen erreichbar ist. Braucht diese Organisation keine eigene, lösche das Feld: die Adresse der Installation wandert dann mit, wenn sie sich ändert."
            />
          ) : null}
          {replyTo.kind === 'ready' ? (
            <TenantReplyToFields field={replyTo.field} />
          ) : null}
        </>
      )}
    </TenantStepFrame>
  );
}

/** Step 6 — the default settings for all forms of this organisation. */
export function FormDefaultsStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  const state = useTenantFormDefaultsState(tenantId);

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={
        state.kind === 'ready' ? savingLabel(state.isSaving) : 'Weiter'
      }
      primaryDisabled={state.kind === 'ready' && state.isSaving}
      onPrimary={() => {
        if (state.kind === 'ready') {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          Formular-Standards werden geladen…
        </p>
      ) : state.kind === 'failed' ? null : (
        <>
          {/*
            Nur noch die Ausnahme (Review-Runde 5, Nachtrag). Dass diese Werte
            für jedes Formular dieser Organisation gelten, steht in der Zeile
            über dem Schritt (`steps.ts`); hier stand es ein zweites Mal.
          */}
          <p className="settings__notice">
            In jedem Formular können einzelne Abschnitte von diesen Werten
            abweichen.
          </p>
          <TenantFormDefaultsCards
            values={state.values}
            issues={state.issues}
            onChange={state.change}
          />
        </>
      )}
    </TenantStepFrame>
  );
}

/**
 * Step 7 — the login over an outside login service.
 *
 * The step that is most likely to be skipped, and therefore the one whose
 * `consequence` says what applies **without** it: e-mail, password, invitation
 * and reset all stay in this application. What SSO brings instead, and that
 * participants fill in forms without signing in either way, says the card
 * itself — writing it in both places was the duplication of Review-Runde 5.
 * A 403 is no disturbance here but the information „diese Rolle darf die
 * Anmeldung nicht ändern" — then the step stands there as skipped.
 */
export function OidcStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  const state = useTenantOidcState(tenantId);

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={
        state.kind === 'ready' ? savingLabel(state.isSaving) : 'Weiter'
      }
      primaryDisabled={state.kind === 'ready' && state.isSaving}
      onPrimary={() => {
        if (state.kind === 'ready') {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          Anmeldung wird geladen…
        </p>
      ) : state.kind === 'absent' ? (
        <SkippedStepNotice
          reason={
            'Diese Rolle darf die Anmeldung dieser Organisation nicht ändern — ' +
            'dafür braucht es die Rechte „Einstellungen der Organisation" und ' +
            '„Nutzer verwalten". Der Schritt wird übersprungen; jemand mit beiden ' +
            'Rechten kann ihn später in der Organisationsverwaltung nachholen.'
          }
        />
      ) : state.kind === 'failed' ? null : (
        <TenantOidcFields
          config={state.config}
          draft={state.draft}
          setDraft={state.setDraft}
          issues={state.issues}
        />
      )}
    </TenantStepFrame>
  );
}

/**
 * Step 8 — this organisation's own AI switch.
 *
 * ⚠️ **If the AI is off instance-wide, the step falls away** — visibly, with the
 * reason, and without a select field whose position has no effect. What the
 * installation can do is said by `systemAvailable` from the answer of the route itself;
 * the session's `aiFormsAvailable` was no good for that, because it is the **and** of
 * both layers and does not distinguish a switched-off organisation from an
 * installation without AI.
 */
export function AiStep({
  tenantId,
  tenantName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  const state = useTenantAiState(tenantId);
  const unavailable = state.kind === 'ready' && !state.systemAvailable;
  const editable = state.kind === 'ready' && state.systemAvailable;

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={editable ? savingLabel(state.isSaving) : 'Weiter'}
      primaryDisabled={editable && state.isSaving}
      onPrimary={() => {
        if (editable) {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          KI-Einstellung wird geladen…
        </p>
      ) : state.kind === 'absent' ? (
        <SkippedStepNotice
          reason={
            'Diese Rolle darf die KI-Einstellung dieser Organisation nicht ' +
            'ändern — dafür braucht es das Recht „Einstellungen der ' +
            'Organisation".'
          }
        />
      ) : state.kind === 'failed' ? null : unavailable ? (
        <SkippedStepNotice reason="Diese Installation hat keine KI eingerichtet. Solange das so ist, gibt es für diese Organisation nichts einzustellen: die Funktion ist abwesend, und ein Schalter hier bliebe folgenlos. Der Schritt wird übersprungen." />
      ) : (
        <TenantAiFields
          choice={state.choice}
          setChoice={state.setChoice}
          systemAvailable={state.systemAvailable}
        />
      )}
    </TenantStepFrame>
  );
}

/**
 * Step 8 — **the legal texts of this organisation** (ADR-0028).
 *
 * It shows the same editor as the tab *Rechtstexte* of the
 * organisation administration and speaks through the same hook with the same route
 * (`use-tenant-legal.ts`).
 *
 * ⚠️ **Skippable like every step here, and the sentence above it is the
 * sharpest of the whole assistant** (`steps.ts`): without these details no
 * form of this organisation fulfils the duty to inform under Art. 13
 * DSGVO. It is nevertheless not enforced — ADR-0025 §1 has already decided this
 * question, and for a legal text it applies doubly: invented
 * data-protection notices are worse than none.
 *
 * **The step adds no paragraph of its own** (Review-Runde 5, Nachtrag). It
 * carried one about the footer link of every form — the third place on one
 * screen saying it, next to the sentence above and the lead card of the editor.
 */
export function LegalStep({
  tenantId,
  tenantName,
  tenantShortName,
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
}: TenantStepProps): ReactElement {
  const state = useTenantLegalPages(tenantId);

  return (
    <TenantStepFrame
      tenantName={tenantName}
      steps={steps}
      currentIndex={index}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      primaryLabel={
        state.kind === 'ready' ? savingLabel(state.isSaving) : 'Weiter'
      }
      primaryDisabled={state.kind === 'ready' && state.isSaving}
      onPrimary={() => {
        if (state.kind === 'ready') {
          state.save(onDone);
        } else {
          onSkip();
        }
      }}
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
          Rechtstexte werden geladen…
        </p>
      ) : state.kind === 'failed' ? null : (
        /*
          The field messages of the refused write travel along here too: the
          step saves through the same hook as the tab, so a 400 has to mark
          the same field in both places — one editor, one behaviour
          (ADR-0028 no. 9).
        */
        <TenantLegalCards
          pages={state.pages}
          tenantName={tenantName}
          tenantShortName={tenantShortName}
          issues={state.issues}
          onChange={state.setPages}
        />
      )}
    </TenantStepFrame>
  );
}
