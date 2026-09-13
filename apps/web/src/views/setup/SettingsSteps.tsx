import type { ReactElement, ReactNode } from 'react';

import { NotificationTemplatesEditor } from '../system-settings/NotificationTemplatesEditor';
import { SystemLegalCards } from '../system-settings/SystemLegalTab';
import { useSystemLegalPages } from '../system-settings/use-system-legal';
import { SystemAiCard } from '../system-settings/SystemAiCard';
import { useSystemAi } from '../system-settings/use-system-ai';
import { useSystemTemplates } from '../system-settings/use-system-templates';
import { WizardFrame, type WizardStepMeta } from '../../wizard';
import type { SetupStepProps } from './MailSteps';

/**
 * **Steps 5, 6 and 7 of the setup wizard** — notification templates, AI and the
 * legal statements.
 *
 * All three show exactly what the corresponding tab of the system
 * administration shows, and talk to the same route through the same hooks
 * (`use-system-templates.ts`, `use-system-ai.ts`, `use-system-legal.ts`). What
 * the wizard contributes:
 * the order, the sentence „what does not work without this step", the skipping —
 * and that „Weiter" saves instead of putting a second button next to it.
 */

/**
 * The shared body of the two steps: load, fail, or show the content and save on
 * the next click.
 *
 * Almost the same as that of the three mail steps and nevertheless a second one:
 * that one hangs on `MailStepState` and its `hadPassword`/`dirty`, this one on
 * two other states. A shared one would be a generic one over three union types —
 * more component than saving.
 */
function SettingsStepFrame({
  steps,
  index,
  onBack,
  onJump,
  onDone,
  onSkip,
  status,
  children,
}: {
  readonly steps: readonly WizardStepMeta[];
  readonly index: number;
  /** „Zurück", or `undefined` — why, stands at `SetupStepProps`. */
  readonly onBack?: (() => void) | undefined;
  /** Zur Schrittliste springen — siehe `SetupStepProps`. */
  readonly onJump: (index: number) => void;
  readonly onDone: () => void;
  readonly onSkip: () => void;
  readonly status:
    | { readonly kind: 'loading' }
    | { readonly kind: 'failed'; readonly message: string }
    | {
        readonly kind: 'ready';
        readonly isSaving: boolean;
        readonly errorMessage: string | null;
        readonly save: (onSaved: () => void) => void;
      };
  readonly children: ReactNode;
}): ReactElement {
  return (
    <WizardFrame
      title="Erste Einrichtung"
      steps={steps}
      currentIndex={index}
      primary={{
        label:
          status.kind === 'ready' && status.isSaving
            ? 'Wird gespeichert…'
            : 'Speichern und weiter',
        onClick: () => {
          if (status.kind === 'ready') {
            status.save(onDone);
          }
        },
        disabled: status.kind !== 'ready' || status.isSaving,
      }}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      error={
        status.kind === 'failed'
          ? status.message
          : status.kind === 'ready'
            ? status.errorMessage
            : null
      }
    >
      {status.kind === 'loading' ? (
        <p className="settings__state" role="status">
          Einstellungen werden geladen…
        </p>
      ) : status.kind === 'failed' ? null : (
        children
      )}
    </WizardFrame>
  );
}

/** Step 5 — the templates a notification starts from. */
export function TemplatesStep(props: SetupStepProps): ReactElement {
  const state = useSystemTemplates();

  return (
    <SettingsStepFrame {...props} status={state}>
      {state.kind === 'ready' ? (
        <NotificationTemplatesEditor
          templates={state.templates}
          decided={state.decided}
          issues={state.issues}
          onChange={state.setTemplates}
        />
      ) : null}
    </SettingsStepFrame>
  );
}

/**
 * Step 6 — the AI.
 *
 * ⚠️ **The only step that raises a legal question.** As soon as a provider
 * stands in this form for the first time, the card shows the five preconditions
 * from `@formsache/shared` — *before* saving, because afterwards the decision
 * has been made. What holds beyond that stands in the data protection chapter of
 * the knowledge base and is **linked and not transcribed**: a second version of
 * data protection conditions is the one that nobody keeps up to date.
 *
 * **The step itself adds no paragraph of its own any more** (Review-Runde 5,
 * Nachtrag). It carried one that said „abwesend, läuft vollständig ohne sie,
 * datenschutzrechtliche Vorbedingungen" — the same three statements that the
 * sentence above it (`steps.ts`) and the card below it already made. What only
 * stood there was the pointer to the knowledge base; it has moved to the
 * preconditions of the card (`SystemAiCard.tsx`), where it belongs: the tab
 * shows the same list and had no pointer at all.
 */
export function AiStep(props: SetupStepProps): ReactElement {
  const state = useSystemAi();

  return (
    <SettingsStepFrame {...props} status={state}>
      {state.kind === 'ready' ? (
        <SystemAiCard
          draft={state.draft}
          setDraft={state.setDraft}
          stored={state.stored}
          gap={state.gap}
        />
      ) : null}
    </SettingsStepFrame>
  );
}

/**
 * Step 7 — **the legal statements of the installation** (ADR-0028).
 *
 * It shows the same editor as the tab *Rechtstexte* of the system
 * administration and talks through the same hook to the same route
 * (`use-system-legal.ts`). What the wizard contributes is the order and the
 * sentence that stands above it — **and nothing else** (Review-Runde 5,
 * Nachtrag): the paragraph that stood here said a third time what the sentence
 * above and the lead card of the editor already say. Why the footer links the
 * pages even when nothing is stored is a decision and is written down as one
 * (`docs/legal/README.md`, table of the rejected alternatives), not repeated on
 * the screen of whoever is filling them in.
 *
 * ⚠️ **Skippable like everything after step 1, and that is a decision with a
 * justification.** This repository has decided the same question twice
 * (ADR-0022 §1, ADR-0025 §1) and both times against the compulsion: „eine
 * Installation, die man erst betreiben kann, wenn ein Mailserver eingetragen
 * ist, zwingt zu erfundenen Werten". For a legal text that holds **doubly** — an
 * invented imprint is exactly the wrong end state. The pressure comes instead
 * from three places that read the *actual* state: the sentence here, the list of
 * open items and the hint when publishing a form.
 */
export function LegalStep(props: SetupStepProps): ReactElement {
  const state = useSystemLegalPages();

  return (
    <SettingsStepFrame {...props} status={state}>
      {state.kind === 'ready' ? (
        /*
          The field messages of the refused write travel along here too: the
          step saves through the same hook as the tab, so a 400 has to mark
          the same field in both places — one editor, one behaviour
          (ADR-0028 no. 9).
        */
        <SystemLegalCards
          pages={state.pages}
          aiActive={state.aiActive}
          issues={state.issues}
          onChange={state.setPages}
        />
      ) : null}
    </SettingsStepFrame>
  );
}
