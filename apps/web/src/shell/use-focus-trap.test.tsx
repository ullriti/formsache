import { render, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';

import { useFocusTrap } from './use-focus-trap';

/**
 * The focus trap of the overlays — **what is measured is where the focus stands**.
 *
 * That is the point at which this requirement differs from „die Aktion geschah":
 * that a key press arrived says nothing about whether the
 * editor stands in the field afterwards or on the page behind it. Every
 * assurance here therefore reads `document.activeElement`.
 *
 * **The finding this file holds fast** : `FOCUSABLE` did not know
 * `input`, `textarea`, `select` and `iframe`. Four overlays carried exactly
 * such elements — `TemplateDrawer` (rename field), `TemplateSavePrompt`
 * (name of the template), `AiFormDialog` (description and title) and the
 * detail window of the mail log (the `<iframe>` with the mail text).
 *
 * The damage is not „ein Element wird übersprungen": the cage is built *out of*
 * this list. An element it does not know is not only passed over on the
 * wrap-around — it is **unreachable**, because the wrapping takes hold at the wrong
 * element and tears the focus past it.
 *
 * **Rebuilds instead of the real overlays**, and that is intentional: the fault
 * sits in the hook, not in the four views, and a test that mounts `AiFormDialog`
 * would test its queries, states and network layer along with it. The
 * rebuilds have the shape of the real panels — that of the dialogue with a
 * `<textarea>` in the middle, that of the log with an `<iframe>` at the end.
 */

/** A panel in the shape of `AiFormDialog`: button, text area, field, button. */
function DialogShapedPanel() {
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: () => undefined,
  });

  return (
    <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog">
      <button type="button">Schließen</button>
      <textarea aria-label="Beschreibung" />
      <input aria-label="Titel" />
      <button type="button">Erstellen</button>
    </div>
  );
}

/** A panel whose **last** control is a field. */
function FieldLastPanel() {
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: () => undefined,
  });

  return (
    <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog">
      <button type="button">Schließen</button>
      <textarea aria-label="Beschreibung" />
    </div>
  );
}

/** The shape of the mail log panel: the mail text in an `<iframe>`. */
function FrameLastPanel() {
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: () => undefined,
  });

  return (
    <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog">
      <button type="button">Schließen</button>
      <iframe title="Nachricht" srcDoc="<p>Hallo</p>" />
    </div>
  );
}

/** A panel with a `<select>` and a switched-off field. */
function SelectPanel() {
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: () => undefined,
  });

  return (
    <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog">
      <button type="button">Schließen</button>
      <input type="hidden" name="csrf" value="x" />
      <input aria-label="Gesperrt" disabled />
      <select aria-label="Auswahl">
        <option>eins</option>
      </select>
    </div>
  );
}

/**
 * A panel next to a button **outside** — the proof that the cage
 * holds. Without something outside, „der Fokus blieb drin" is no statement.
 */
function PanelBesideOutsideButton() {
  const outside = useRef<HTMLButtonElement>(null);
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: () => undefined,
  });

  return (
    <>
      <button type="button" ref={outside}>
        Draußen
      </button>
      <div ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="dialog">
        <button type="button">Schließen</button>
        <textarea aria-label="Beschreibung" />
      </div>
    </>
  );
}

describe('useFocusTrap – Felder gehören in den Käfig ', () => {
  it('läuft vom letzten Feld auf das erste Bedienelement um', () => {
    const { getByLabelText, getByRole } = render(<FieldLastPanel />);
    const field = getByLabelText('Beschreibung');
    const close = getByRole('button', { name: 'Schließen' });

    field.focus();
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(field, { key: 'Tab' });

    // **Measured, not inferred.** Before the repair `FOCUSABLE` did not know the
    // `<textarea>`, took the close button for the last element and
    // let Tab through here unhindered — the focus left the panel to the
    // rear, onto the page behind it.
    expect(document.activeElement).toBe(close);
  });

  it('läuft vom iframe des Versandprotokolls um statt an ihm vorbei', () => {
    const { getByTitle, getByRole } = render(<FrameLastPanel />);
    const frame = getByTitle('Nachricht');
    const close = getByRole('button', { name: 'Schließen' });

    frame.focus();
    expect(document.activeElement).toBe(frame);

    fireEvent.keyDown(frame, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('reißt Shift+Tab nicht mehr aus der Mitte an das Ende', () => {
    const { getByLabelText, getByRole } = render(<DialogShapedPanel />);
    const field = getByLabelText('Beschreibung');

    field.focus();
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });

    /*
      Before the repair the `<textarea>` stood in no list, `indexOf`
      delivered `-1`, and `index <= 0` made „du stehst am Anfang" out of that — the
      focus jumped to **Erstellen**, the last button. Going one line back out of the
      field therefore landed at the other end of the dialogue.

      Now the field is in its place, the hook does not intervene, and the
      browser makes the ordinary step — in jsdom that means: the focus
      stays where it is. What is measured is therefore that it does **not** stand on
      „Erstellen".
    */
    expect(document.activeElement).not.toBe(
      getByRole('button', { name: 'Erstellen' }),
    );
    expect(document.activeElement).toBe(field);
  });

  it('behandelt das Feld in der Mitte als gewöhnliche Zwischenstation', () => {
    const { getByLabelText, getByRole } = render(<DialogShapedPanel />);
    const title = getByLabelText('Titel');

    title.focus();
    fireEvent.keyDown(title, { key: 'Tab' });

    // Not the last element, so no wrap-around: the hook lets the browser
    // go. Before the repair „Erstellen" was the last one for it *and*
    // `indexOf(title)` was `-1`, which by chance likewise did not wrap — the
    // case is here so that the repair does not turn it into a wrap-around.
    expect(document.activeElement).toBe(title);
    expect(document.activeElement).not.toBe(
      getByRole('button', { name: 'Schließen' }),
    );
  });

  it('läuft vom select um und übergeht verstecktes wie abgeschaltetes', () => {
    const { getByLabelText, getByRole } = render(<SelectPanel />);
    const select = getByLabelText('Auswahl');
    const close = getByRole('button', { name: 'Schließen' });

    select.focus();
    fireEvent.keyDown(select, { key: 'Tab' });

    // The `<select>` is the last element, so it wraps around — namely onto
    // the close button. If `input[type="hidden"]` or the
    // switched-off field stood in the list, the focus would land there: `focus()` on
    // both is a no-op, the focus would fall onto `<body>`, and the next tab
    // would begin at the head of the page — exactly the damage this hook
    // is meant to prevent.
    expect(document.activeElement).toBe(close);
  });

  it('lässt den Fokus nicht aus dem Panel heraus', () => {
    const { getByLabelText, getByRole } = render(<PanelBesideOutsideButton />);
    const field = getByLabelText('Beschreibung');
    const outside = getByRole('button', { name: 'Draußen' });

    field.focus();
    fireEvent.keyDown(field, { key: 'Tab' });

    expect(document.activeElement).not.toBe(outside);
    expect(document.activeElement).toBe(
      getByRole('button', { name: 'Schließen' }),
    );
  });
});
