import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

import './wizard.css';

/**
 * **The frame of a setup wizard** — a form flow that leads once
 * through a series of decisions and, at every step, says
 * *what does not work without it*.
 *
 * It stands in a directory of its own and not with the initial commissioning,
 * because there are to be **two** wizards: that of the installation
 * (`views/SetupView.tsx` with the steps in `views/setup/`) and that of a freshly created
 * organisation. Both lead through foreign settings pages, both may be
 * skipped, both have to say where one stands. What distinguishes them
 * are the steps — and exactly those are a parameter here.
 *
 * ## What this frame decides, and what not
 *
 * It decides **frame, progress display, focus guidance and the three
 * buttons**. It does **not** decide what a step does, whether it
 * has saved, whether it may right now: the content comes as `children`, the
 * primary button as {@link WizardAction}. A frame that also knew
 * how saving works would no longer be one — it would be the first wizard with a
 * parameter for the second.
 *
 * ## Three accessibility promises that stand here and not per step
 *
 * 1. **The position is text.** „Schritt 3 von 7" stands there written out, and
 *    the step list marks the current one with `aria-current="step"`. A
 *    progress bar alone tells a screen reader nothing.
 * 2. **No state via colour alone.** Done, skipped and open each carry
 *    a **word** (`WIZARD_STATUS_LABELS`); the colour is the addition.
 * 3. **The focus moves along.** At every change of step the
 *    heading of the new step gets the focus (`tabIndex={-1}`). Without that it would stay
 *    on the button „Weiter", which by then submits a different step
 *    — the flow would have jumped on invisibly for someone with a keyboard or a
 *    screen reader.
 */

/** How far a step is — **never** shown as colour alone. */
export type WizardStepStatus = 'open' | 'done' | 'skipped';

export const WIZARD_STATUS_LABELS: Record<WizardStepStatus, string> = {
  open: 'offen',
  done: 'erledigt',
  skipped: 'übersprungen',
};

export interface WizardStepMeta {
  readonly key: string;
  /** The heading of the step — short, it also stands in the list. */
  readonly title: string;
  /**
   * **What does not work without this step** — one sentence, and a
   * required field.
   *
   * The reason why it is not an optional field: a skippable step
   * without this sentence is a step that one skips without knowing what
   * one gives up. If it stands in the type, a new step cannot forget it.
   */
  readonly consequence: string;
  /** Whether this step offers „Überspringen". */
  readonly skippable: boolean;
  readonly status: WizardStepStatus;
  /**
   * **Ob man von hier aus zu diesem Schritt springen darf**
   * (Review-Runde 3 Nr. 6).
   *
   * Der Befund: „Man kann oben über die Breadcrumbs nicht navigieren. Das
   * wäre intuitiv." Er stimmt — die Liste sah aus wie eine Wegmarkierung und
   * war eine Beschriftung. Wer in Schritt 6 merkt, dass die Mailadresse aus
   * Schritt 4 falsch ist, musste dreimal „Zurück" drücken und danach dreimal
   * „Weiter".
   *
   * **Ein Pflichtfeld und kein `?`**, aus demselben Grund wie
   * {@link consequence}: es gibt genau einen Schritt in dieser Anwendung, der
   * nicht wiederholbar ist (der erste der Erstinbetriebnahme legt das Konto
   * an, und `POST /api/setup` antwortet danach 404). Diese Ausnahme darf
   * nicht die Vorgabe eines Feldes sein, das man vergessen kann — der nächste
   * Assistent hätte sonst still eine Liste, die nirgendwohin führt.
   */
  readonly reachable: boolean;
}

export interface WizardAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export interface WizardFrameProps {
  /** The heading of the whole flow, for instance „Erste Einrichtung". */
  readonly title: string;
  /** A paragraph under the title — what this flow does as a whole. */
  readonly intro?: ReactNode;
  /** Something above the title, for instance the product mark. */
  readonly banner?: ReactNode;
  readonly steps: readonly WizardStepMeta[];
  /** Which step is up right now — an index into {@link steps}. */
  readonly currentIndex: number;
  readonly primary: WizardAction;
  /*
    Hier stand `secondary` — eine zweite Handlung neben dem Hauptknopf, die es
    für genau einen Fall gab: der Mailserver-Schritt bot ein „Speichern" ohne
    Weitergehen an, damit die Testmail daneben etwas zu prüfen hatte
    (Review-Runde 3 Nr. 2).

    Sie ist fort, weil ihr Anlass fort ist: seit Review-Runde 4 Nr. 3 speichert
    die Testmail-Karte selbst („Speichern und Testmail senden",
    `TestMailCard.saveFirst`). Ein Knopf am Rahmen, den kein Schritt mehr
    setzt, wäre ein Angebot an den nächsten Assistenten, das niemand geprüft
    hat.
  */
  /** „Zurück", or `undefined` at the first step. */
  readonly onBack?: (() => void) | undefined;
  /**
   * Zu einem Schritt springen — die Schrittliste wird dadurch bedienbar
   * (Review-Runde 3 Nr. 6).
   *
   * Optional, damit ein Assistent ohne freie Navigation denkbar bleibt; ohne
   * diese Funktion bleibt die Liste, was sie war: eine Anzeige. Welche
   * Schritte anspringbar sind, entscheidet {@link WizardStepMeta.reachable}
   * und nicht diese Funktion — sie wird für einen nicht erreichbaren Schritt
   * gar nicht erst aufgerufen.
   */
  readonly onJump?: ((index: number) => void) | undefined;
  /**
   * „Überspringen", or `undefined`.
   *
   * Separate from {@link WizardStepMeta.skippable}: that one says that a
   * step **is** skippable (and therefore also stands in the list), this one
   * is the action. A step that is currently loading can be skippable and
   * still not offer the action yet.
   */
  readonly onSkip?: (() => void) | undefined;
  /**
   * Eine Ablehnung über den Schaltflächen — oder nichts
   * (Review-Runde 4 Nr. 1).
   *
   * ⚠️ **„Nichts" heißt hier mehr als `undefined`.** Der Befund lautete: „Die
   * Fehlerzeile wird immer angezeigt, auch wenn kein Inhalt." Er stimmte, und
   * die Ursache lag nicht am Aufrufer: alle sechs Schritte des
   * Organisations-Assistenten reichen `null` herein, wenn es nichts zu melden
   * gibt (`state.errorMessage` ist `string | null`), und `null` ist ein
   * gültiger `ReactNode`. Die Prüfung `error === undefined` ließ ihn durch —
   * übrig blieb ein leerer roter Kasten mit Rahmen und Innenabstand, den
   * niemand wegbekam.
   *
   * Deshalb entscheidet {@link hasContent} und nicht ein Vergleich mit
   * `undefined`. Ein Rahmen, der einen Fehler behauptet, wo keiner ist, ist
   * dieselbe Art von Falschauskunft wie ein Zustand, der nur als Farbe
   * dasteht.
   */
  readonly error?: ReactNode;
  /**
   * Whether this frame is **the** main region of the page. Default: yes.
   *
   * The initial commissioning stands alone on an empty page, so it is
   * `<main>`. The wizard of an organisation (ADR-0025) stands **in** the
   * signed-in shell, and that already has its `<main>` — a second one would be
   * a second main region on the same page, that is exactly the sort of
   * false information to a screen reader that this frame otherwise
   * stands against (the shell's skip link points to the one that exists).
   *
   * It changes **only** the element, not the appearance: the class stays
   * `wizard`.
   */
  readonly standalone?: boolean;
  readonly children: ReactNode;
}

/**
 * Ob dieser Knoten etwas anzuzeigen hat.
 *
 * `undefined`, `null` und `false` sind die drei Arten, auf die React „nichts"
 * schreibt, und alle drei kommen hier an: `undefined` von einem Aufrufer, der
 * die Eigenschaft weglässt, `null` von einem `string | null`, `false` von
 * einem `bedingung && <p/>`. Ein Leerstring zählt mit — er ergibt ein Kästchen
 * ohne Text, und genau das war der Befund.
 *
 * Ein Feld (`<>{a}{b}</>` als Array) wird nicht aufgedröselt: sobald ein
 * Aufrufer Bausteine zusammensetzt, ist die Aussage „hier steht ein Fehler"
 * seine und nicht die dieser Prüfung.
 */
function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

export function WizardFrame({
  title,
  intro,
  banner,
  steps,
  currentIndex,
  primary,
  onBack,
  onJump,
  onSkip,
  error,
  standalone = true,
  children,
}: WizardFrameProps): ReactElement {
  const current = steps[currentIndex];
  const headingRef = useRef<HTMLHeadingElement>(null);

  /**
   * The focus follows the step.
   *
   * Depending on the **index**, not on the heading: two steps may be
   * called the same, and a change is a change. `preventScroll` deliberately
   * not — whoever has just scrolled to the end of a long step should
   * start at the top on the next one.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, [currentIndex]);

  if (current === undefined) {
    // Unreachable as long as the caller derives its index from `steps.length`
    // — and loud instead of silent, because a wizard without a step would be an
    // empty page on which „Weiter" would do something.
    throw new Error(
      `Der Assistent hat keinen Schritt an Position ${String(currentIndex)}.`,
    );
  }

  const position = `Schritt ${String(currentIndex + 1)} von ${String(steps.length)}`;

  const Root = standalone ? 'main' : 'div';

  return (
    <Root className="wizard">
      <div className="wizard__card">
        <div className="wizard__stripe" />
        <div className="wizard__body">
          {banner === undefined ? null : (
            <p className="wizard__banner">{banner}</p>
          )}
          <h1 className="wizard__title">{title}</h1>
          {intro === undefined ? null : (
            <p className="wizard__intro">{intro}</p>
          )}

          {/*
            **Seit Review-Runde 3 Nr. 6 ist das wirklich eine Navigation** —
            vorher stand hier der Satz „A navigation this is **not**", und
            genau das war der Befund: die Liste sah aus wie eine
            Wegmarkierung und war eine Beschriftung.

            Sie ist es jetzt, mit einer Ausnahme, die geblieben ist: ein
            Schritt, der sich nicht wiederholen lässt, ist kein Ziel
            ({@link WizardStepMeta.reachable}). Er steht weiterhin als Text
            da — weglassen hieße, die Zählung „Schritt 3 von 8" zu
            zerreißen —, nur ohne Schaltfläche.

            `<nav>` mit Namen, weil ein Bildschirmleser sonst eine zweite
            unbenannte Navigation neben der der Anwendung hört. Das `<ol>`
            bleibt, und `aria-current="step"` auch: es ist weiterhin die
            Auskunft „hier stehst du".
          */}
          <nav className="wizard__nav" aria-label="Schritte des Assistenten">
            <ol className="wizard__steps">
              {steps.map((step, index) => {
                const current = index === currentIndex;
                const body = (
                  <>
                    <span className="wizard__step-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="wizard__step-title">{step.title}</span>
                    {/*
                      The word next to the state — not instead of the colour,
                      but *before* it. The current step needs none:
                      `aria-current` says it, and „offen" next to it would be
                      a second piece of information about the same row.
                    */}
                    {current ? null : (
                      <span className="wizard__step-status">
                        {WIZARD_STATUS_LABELS[step.status]}
                      </span>
                    )}
                  </>
                );
                const jumpable =
                  onJump !== undefined && step.reachable && !current;
                return (
                  <li
                    key={step.key}
                    className={
                      current
                        ? 'wizard__step wizard__step--current'
                        : `wizard__step wizard__step--${step.status}`
                    }
                    aria-current={current ? 'step' : undefined}
                  >
                    {jumpable ? (
                      <button
                        type="button"
                        className="wizard__step-jump"
                        onClick={() => {
                          onJump(index);
                        }}
                      >
                        {body}
                        {/*
                          Nur für Bildschirmleser: sichtbar sagt die
                          Schaltfläche „4 Adressen offen", und daraus geht
                          nicht hervor, dass ein Klick dorthin führt.
                        */}
                        <span className="wizard__step-hint">
                          — zu diesem Schritt springen
                        </span>
                      </button>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>

          <section
            className="wizard__step-panel"
            aria-labelledby={`wizard-step-${current.key}`}
          >
            <p className="wizard__position" role="status">
              {position}
            </p>
            <h2
              className="wizard__step-heading"
              id={`wizard-step-${current.key}`}
              ref={headingRef}
              tabIndex={-1}
            >
              {current.title}
            </h2>
            <p className="wizard__consequence">
              <span aria-hidden="true">ⓘ </span>
              {current.consequence}
            </p>

            <div className="wizard__content">{children}</div>

            {hasContent(error) ? (
              <p className="wizard__error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="wizard__actions">
              {onBack === undefined ? null : (
                <button type="button" className="wizard__back" onClick={onBack}>
                  Zurück
                </button>
              )}
              <span className="wizard__spacer" />
              {onSkip === undefined ? null : (
                <button type="button" className="wizard__skip" onClick={onSkip}>
                  Überspringen
                </button>
              )}
              <button
                type="button"
                className="wizard__primary"
                disabled={primary.disabled ?? false}
                onClick={primary.onClick}
              >
                {primary.label}
              </button>
            </div>
          </section>
        </div>
      </div>
    </Root>
  );
}
