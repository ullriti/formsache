import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WizardFrame, type WizardStepMeta } from './index';

/**
 * **The frame of the setup wizards** (ADR-0022, continuation
 * 2026-08-18).
 *
 * What is measured is what the frame **promises** — the three properties it
 * exists for, so that a single step does not have to decide them anew each
 * time:
 *
 * 1. The position stands there as **text**, not only as a bar.
 * 2. States carry a **word**, not only a colour.
 * 3. The **focus** moves to the new heading on a change of step.
 *
 * *Reproduction for the third:* remove the effect → the focus case goes red,
 * and the focus would stay on „Weiter", which by then submits something else.
 */

function steps(): WizardStepMeta[] {
  return [
    {
      key: 'eins',
      title: 'Erster Schritt',
      consequence: 'Ohne ihn geht nichts.',
      skippable: false,
      status: 'done',
      // Der eine nicht wiederholbare Schritt der Anwendung — die
      // Erstinbetriebnahme legt in ihm das Konto an. Er steht hier als der
      // Fall, den die Navigation **nicht** anbieten darf.
      reachable: false,
    },
    {
      key: 'zwei',
      title: 'Zweiter Schritt',
      consequence: 'Ohne ihn fehlt etwas.',
      skippable: true,
      status: 'open',
      reachable: true,
    },
    {
      key: 'drei',
      title: 'Dritter Schritt',
      consequence: 'Ohne ihn fehlt etwas anderes.',
      skippable: true,
      status: 'skipped',
      reachable: true,
    },
  ];
}

function renderFrame(
  currentIndex: number,
  overrides: Partial<Parameters<typeof WizardFrame>[0]> = {},
) {
  return render(
    <WizardFrame
      title="Erste Einrichtung"
      steps={steps()}
      currentIndex={currentIndex}
      primary={{ label: 'Weiter', onClick: () => undefined }}
      {...overrides}
    >
      <p>Inhalt</p>
    </WizardFrame>,
  );
}

describe('WizardFrame', () => {
  it('nennt die Position ausgeschrieben', () => {
    renderFrame(1);

    expect(screen.getByText('Schritt 2 von 3')).toBeDefined();
  });

  it('markiert den aktuellen Schritt als solchen und die anderen mit einem Wort', () => {
    renderFrame(1);

    // `span`, because the heading of the step carries the same text.
    const current = screen
      .getByText('Zweiter Schritt', { selector: 'span' })
      .closest('li');
    expect(current?.getAttribute('aria-current')).toBe('step');

    // Not a pure colour signal: „erledigt" and „übersprungen" are there.
    expect(screen.getByText('erledigt')).toBeDefined();
    expect(screen.getByText('übersprungen')).toBeDefined();
  });

  it('sagt an jedem Schritt, was ohne ihn nicht geht', () => {
    renderFrame(1);

    expect(screen.getByText(/Ohne ihn fehlt etwas\./u)).toBeDefined();
  });

  /**
   * The focus follows the step. Without that a change would be invisible for
   * somebody with a keyboard or a screen reader — and the focus would stand on
   * a button that by then submits a different step.
   */
  it('setzt den Fokus beim Schrittwechsel auf die neue Überschrift', () => {
    const view = renderFrame(1);
    expect(document.activeElement?.textContent).toBe('Zweiter Schritt');

    view.rerender(
      <WizardFrame
        title="Erste Einrichtung"
        steps={steps()}
        currentIndex={2}
        primary={{ label: 'Weiter', onClick: () => undefined }}
      >
        <p>Inhalt</p>
      </WizardFrame>,
    );

    expect(document.activeElement?.textContent).toBe('Dritter Schritt');
  });

  it('zeigt „Zurück" und „Überspringen" nur, wenn es sie gibt', () => {
    renderFrame(1);
    expect(screen.queryByRole('button', { name: 'Zurück' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Überspringen' })).toBeNull();

    const back = vi.fn();
    const skip = vi.fn();
    renderFrame(1, { onBack: back, onSkip: skip });

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(screen.getByRole('button', { name: 'Überspringen' }));

    expect(back).toHaveBeenCalledOnce();
    expect(skip).toHaveBeenCalledOnce();
  });

  /**
   * **Die Schrittliste ist eine Navigation** (Review-Runde 3 Nr. 6): „Man kann
   * oben über die Breadcrumbs nicht navigieren. Das wäre intuitiv."
   *
   * Gemessen wird beides, und das zweite ist das wichtigere: dass ein
   * **nicht wiederholbarer** Schritt keine Schaltfläche bekommt. Er steht
   * weiterhin in der Liste — sonst zerrisse die Zählung „Schritt 2 von 3" —,
   * nur führt dorthin kein Weg. Der eine Fall in dieser Anwendung ist der
   * erste Schritt der Erstinbetriebnahme: er legt das Konto an, und
   * `POST /api/setup` antwortet danach 404.
   */
  it('lässt die Schritte anspringen — außer den nicht wiederholbaren', () => {
    const jump = vi.fn();
    renderFrame(1, { onJump: jump });

    fireEvent.click(screen.getByRole('button', { name: /Dritter Schritt/u }));
    expect(jump).toHaveBeenCalledExactlyOnceWith(2);

    // Der aktuelle Schritt ist kein Ziel — ein Sprung auf sich selbst wäre
    // eine Schaltfläche, die nichts tut.
    expect(
      screen.queryByRole('button', { name: /Zweiter Schritt/u }),
    ).toBeNull();
    // Und der nicht wiederholbare erst recht nicht.
    expect(
      screen.queryByRole('button', { name: /Erster Schritt/u }),
    ).toBeNull();
  });

  /**
   * Ohne `onJump` bleibt die Liste, was sie war: eine Anzeige. Ein Assistent
   * ohne freie Navigation bleibt damit denkbar, und die Liste wächst nicht
   * still zu Schaltflächen, die niemand verdrahtet hat.
   */
  it('bleibt ohne onJump eine reine Anzeige', () => {
    renderFrame(1);

    expect(
      screen.queryByRole('button', { name: /Dritter Schritt/u }),
    ).toBeNull();
  });

  /**
   * **Die Fehlerzeile nur, wenn sie etwas zu sagen hat**
   * (Review-Runde 4 Nr. 1: „Wizard Error Zeile wird immer angezeigt auch wenn
   * kein Inhalt").
   *
   * *Reproduktion:* `hasContent` durch `error === undefined` ersetzen → der
   * `null`-Fall wird rot. Genau so stand es da, und genau so reichen die
   * Schritte des Organisations-Assistenten ihren Zustand herein: `null`, wenn
   * es nichts zu melden gibt.
   */
  it('zeigt die Fehlerzeile nur bei Inhalt', () => {
    for (const nothing of [undefined, null, false, '']) {
      const view = renderFrame(1, { error: nothing });
      expect(screen.queryByRole('alert')).toBeNull();
      view.unmount();
    }

    renderFrame(1, { error: 'Das hat nicht geklappt.' });
    expect(screen.getByRole('alert').textContent).toBe(
      'Das hat nicht geklappt.',
    );
  });

  /**
   * Loud instead of silent: a wizard without a step at this position would be
   * an empty page on which „Weiter" would do something.
   */
  it('wirft, wenn es an dieser Position keinen Schritt gibt', () => {
    expect(() => renderFrame(9)).toThrow(/keinen Schritt/u);
  });
});
