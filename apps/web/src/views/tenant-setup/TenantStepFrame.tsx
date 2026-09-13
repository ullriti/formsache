import type { ReactElement, ReactNode } from 'react';

import { DASHBOARD_PATH } from '../../router/routes';
import { navigate } from '../../router/use-route';
import { WizardFrame, type WizardStepMeta } from '../../wizard';

/**
 * **The frame of every step of the organisation setup** (ADR-0025).
 *
 * It fills three things into `WizardFrame` that are the same in all eight
 * steps, and nothing else:
 *
 * 1. **`standalone={false}`** — the assistant stands in the signed-in shell,
 *    and that one has its main region already. A second one would be a false
 *    statement to every screen reader.
 * 2. **The way out.** „Später einrichten" stands in every step, not only at
 *    the end: this assistant must lock nobody in, and the header line
 *    above it is there, to be sure, but it is no invitation. What stays open
 *    stands afterwards on the dashboard of this organisation — that is why
 *    leaving is no loss and is not confirmed either.
 * 3. **The name of the organisation in the title.** Whoever administers
 *    several has to know without looking which one they are setting up.
 */
export interface TenantStepFrameProps {
  readonly tenantName: string;
  readonly steps: readonly WizardStepMeta[];
  readonly currentIndex: number;
  /** „Zurück", or `undefined` at the first step. */
  readonly onBack?: (() => void) | undefined;
  /** Zu einem Schritt der Liste oben springen (Review-Runde 3 Nr. 6). */
  readonly onJump?: ((index: number) => void) | undefined;
  readonly onSkip: () => void;
  readonly primaryLabel: string;
  readonly primaryDisabled?: boolean;
  readonly onPrimary: () => void;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}

export function TenantStepFrame({
  tenantName,
  steps,
  currentIndex,
  onBack,
  onJump,
  onSkip,
  primaryLabel,
  primaryDisabled = false,
  onPrimary,
  error,
  children,
}: TenantStepFrameProps): ReactElement {
  return (
    <WizardFrame
      standalone={false}
      title="Organisation einrichten"
      banner={tenantName}
      intro={
        <>
          Diese Einrichtung führt einmal durch alle Einstellungen dieser
          Organisation und sagt bei jedem Schritt, was ohne ihn nicht geht.
          Jeder Schritt lässt sich überspringen; was offen bleibt, steht danach
          auf dem Dashboard dieser Organisation.{' '}
          <button
            type="button"
            className="settings__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Später einrichten
          </button>
        </>
      }
      steps={steps}
      currentIndex={currentIndex}
      primary={{
        label: primaryLabel,
        onClick: onPrimary,
        disabled: primaryDisabled,
      }}
      onBack={onBack}
      onJump={onJump}
      onSkip={onSkip}
      error={error}
    >
      {children}
    </WizardFrame>
  );
}

/**
 * **A step that does not exist for this session** — visibly skipped
 * instead of shown as a broken form (ADR-0025 no. 5).
 *
 * Two occasions, and both need the same handling:
 *
 * - **A missing right.** The eight steps hang on different
 *   rights; whoever may change the colours may therefore not yet assign
 *   roles. Instead of a form that says 403 on saving, what stands here is
 *   which right is missing and who can give it.
 * - **A feature the installation does not have.** Without an AI provider
 *   the AI switch of this organisation is without effect.
 *
 * The main button is therefore called „Weiter" and not „Speichern und weiter":
 * there is nothing to save. „Überspringen" the frame offers nonetheless — the
 * two lead to the same place here, and taking a button away because it does
 * the same as the one next to it would make the flow irregular.
 */
export function SkippedStepNotice({
  reason,
}: {
  readonly reason: ReactNode;
}): ReactElement {
  return (
    <section className="settings-card">
      <div className="settings-card__body">
        <p className="settings__state" role="status">
          {reason}
        </p>
      </div>
    </section>
  );
}
