/**
 * **The scaffolding for setup wizards** — the one door in.
 *
 * There is one wizard today (the first commissioning of the installation,
 * `views/SetupView.tsx`) and there is to be a second (that
 * of a freshly created Organisation). So that the second does not copy half of
 * the first, the frame lives here and is used from here:
 *
 * ```tsx
 * const STEPS = [
 *   { key: 'name', title: 'Name', consequence: '…', skippable: false },
 *   …
 * ] as const;
 *
 * <WizardFrame
 *   title="Organisation einrichten"
 *   steps={STEPS.map((step, index) => ({ ...step, status: statusOf(index) }))}
 *   currentIndex={index}
 *   primary={{ label: 'Weiter', onClick: save, disabled: saving }}
 *   onBack={index === 0 ? undefined : back}
 *   onSkip={STEPS[index].skippable ? skip : undefined}
 * >
 *   {content}
 * </WizardFrame>
 * ```
 *
 * What the frame brings along stands at {@link WizardFrame}: progress display
 * as **text**, focus handling on a step change, states as a **word** rather
 * than as a colour, and the three buttons always in the same arrangement. What it
 * deliberately does not bring along is the saving: that belongs to the step, and a
 * scaffolding that knew about it would be the first wizard with a parameter for the
 * second.
 */
export {
  WIZARD_STATUS_LABELS,
  WizardFrame,
  type WizardAction,
  type WizardFrameProps,
  type WizardStepMeta,
  type WizardStepStatus,
} from './WizardFrame';
