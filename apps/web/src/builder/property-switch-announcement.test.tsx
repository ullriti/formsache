import type { ReactElement } from 'react';
import type { FormDefinition, Question } from '@formsache/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { selectedQuestion, useBuilderStore } from './builder-store';
import { QuestionProperties } from './QuestionProperties';

/**
 * **What a switch in the properties column changes is announced**
 * (remainder from the requirement).
 *
 * `QuestionPreview` stays under `aria-hidden` — the preview is a duplication of
 * what has just been set in this column, and without `aria-hidden` a screen
 * reader would read every question twice. The price for that is that a switch
 * whose whole effect lies *in* the preview has no feedback at all. What is
 * measured is therefore the announcement of the **state change**, not the
 * content of the preview.
 *
 * ## What is not measured here
 *
 * No class and no `checked`. An `expect(box.checked).toBe(true)` would stay
 * green if the announcement disappeared without replacement — it is the
 * assertion about the checkbox, not about what it brought about. What is
 * measured is the `role="status"` region and its text.
 */

const PAGE_ID = '019ff800-0000-7000-8000-0000000000a1';
const QUESTION_ID = '019ff800-0000-7000-8000-0000000000b1';

function definition(question: Question): FormDefinition {
  return {
    pages: [
      {
        id: PAGE_ID,
        title: 'Seite 1',
        description: null,
        questions: [question],
      },
    ],
  };
}

/** Loads a one-question document and selects that question, as the UI does. */
function load(question: Question): void {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: 'form-nr-92',
    title: 'Testformular',
    definition: definition(question),
    revision: 1,
  });
  useBuilderStore.getState().selectQuestion(question.id);
}

/** Renders the panel bound to the live store question, like `BuilderView` does. */
function Harness(): ReactElement | null {
  const question = useBuilderStore(selectedQuestion);
  if (question === undefined) {
    return null;
  }
  return <QuestionProperties question={question} />;
}

/**
 * The panel's live region — **found via the role**.
 *
 * The panel container carries no `role`, the region is the only `role="status"`
 * inside it. Via a class the assertion would be one about styling; via the text
 * it would be circular.
 */
function liveRegion(): HTMLElement {
  return within(screen.getByTestId('props-host')).getByRole('status');
}

function panel(question: Question): void {
  load(question);
  render(
    <div data-testid="props-host">
      <Harness />
    </div>,
  );
}

/** Flips the named switch and returns what is announced afterwards. */
function toggle(label: string): string {
  fireEvent.click(screen.getByLabelText(label));
  return liveRegion().textContent;
}

const BASE = {
  id: QUESTION_ID,
  label: 'Begleitpersonen',
  hint: null,
  required: false,
  width: 'full',
} as const;

const tableQuestion: Question = {
  ...BASE,
  type: 'table',
  columns: [
    { key: 'spalte-1', label: 'Name', type: 'text' },
    { key: 'spalte-2', label: 'Organisation', type: 'text' },
  ],
  rows: 2,
};

const numberQuestion: Question = {
  ...BASE,
  label: 'Anzahl Betten',
  type: 'number',
  min: null,
  max: null,
  integer: false,
};

const matrixQuestion: Question = {
  ...BASE,
  label: 'Bewertung der Veranstaltungen',
  type: 'matrix',
  rows: [{ value: 'zeile-1', label: 'Sommerfest' }],
  columns: [{ value: 'spalte-1', label: 'gut' }],
  multiple: false,
};

const selectQuestion: Question = {
  ...BASE,
  label: 'Organisation',
  type: 'select',
  options: [{ value: 'option-1', label: 'Alte Breslauer' }],
  allowOther: false,
  otherLabel: null,
};

describe('Eigenschaften-Schalter – „Zeilen ergänzbar" ', () => {
  it('sagt den Zustandswechsel an, in einer Region, die vorher schon da ist', () => {
    panel(tableQuestion);

    // **There beforehand and empty.** A `role="status"` region that only comes
    // into being together with its text is new in the accessibility tree when
    // the text arrives, and is then frequently not announced at all.
    expect(liveRegion().textContent).toBe('');

    const on = toggle('Zeilen ergänzbar');
    expect(
      on,
      'Der Haken wirkt sich nur in der `aria-hidden`-Vorschau aus („+ Zeile"). ' +
        'Ohne Ansage drückt der Bearbeiter und hört nichts darüber, was das ' +
        'an der Frage geändert hat.',
    ).toBe(
      'Zeilen ergänzbar: ein. Beim Ausfüllen gibt es „+ Zeile“, höchstens 20 Zeilen.',
    );
  });

  it('bleibt beim zweiten und dritten Umlegen hörbar', () => {
    panel(tableQuestion);

    const first = toggle('Zeilen ergänzbar');
    const second = toggle('Zeilen ergänzbar');
    const third = toggle('Zeilen ergänzbar');

    /*
      **The live-region pitfall, and the whole reason for „ein"/„aus" in the
      sentence.** A live region that receives the same text twice in a row does
      not speak it the second time. An announcement „Zeilen ergänzbar" without
      a state would be the same sentence three times — the first press audible,
      the two following ones mute. That is exactly what the first version of
      this announcement failed on.
    */
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(second).toBe(
      'Zeilen ergänzbar: aus. Die Tabelle bleibt bei 2 Zeilen.',
    );
    // And the third press is the first sentence again — that is fine, because
    // `second` lies in between. The comparison is against the **predecessor**,
    // not against everything that has been said.
    expect(third).toBe(first);
  });

  it('lässt die Ansage der vorigen Frage nicht stehen', () => {
    panel(tableQuestion);
    toggle('Zeilen ergänzbar');

    // The panel is rendered by `BuilderView` **without a `key`**, so it
    // survives a change of selection. A sentence left standing would then
    // belong to the previous card — and at the next flip it might be word for
    // word identical with the new one and thereby mute.
    act(() => {
      useBuilderStore
        .getState()
        .addQuestion('text', '019ff800-0000-7000-8000-0000000000b2');
    });

    expect(liveRegion().textContent).toBe('');
  });
});

describe('Eigenschaften-Schalter – die übrigen drei', () => {
  it('sagt „Nur ganze Zahlen" an — den Schalter ohne jede sichtbare Wirkung', () => {
    panel(numberQuestion);

    // The hardest of the four cases: the preview does **not** show this switch
    // at all (an `<input type="number">` looks the same with and without it),
    // it only takes effect in the schema when filling in.
    expect(toggle('Nur ganze Zahlen')).toBe(
      'Nur ganze Zahlen: ein. Nachkommastellen werden beim Ausfüllen abgewiesen.',
    );
    expect(toggle('Nur ganze Zahlen')).toBe(
      'Nur ganze Zahlen: aus. Nachkommastellen sind erlaubt.',
    );
  });

  it('sagt „Mehrfachauswahl je Zeile" an — die Wirkung ist die Zellform der Vorschau', () => {
    panel(matrixQuestion);

    expect(toggle('Mehrfachauswahl je Zeile')).toBe(
      'Mehrfachauswahl je Zeile: ein. Je Zeile sind mehrere Spalten wählbar.',
    );
    expect(toggle('Mehrfachauswahl je Zeile')).toBe(
      'Mehrfachauswahl je Zeile: aus. Je Zeile ist genau eine Spalte wählbar.',
    );
  });

  it('sagt „Sonstiges" an — die Wirkung ist ein Eintrag in der Vorschau-Liste', () => {
    panel(selectQuestion);

    expect(toggle('„Sonstiges“ mit Freitext anbieten')).toBe(
      '„Sonstiges“ mit Freitext anbieten: ein. Die Auswahl bekommt einen zusätzlichen Eintrag mit Freitextfeld.',
    );
    expect(toggle('„Sonstiges“ mit Freitext anbieten')).toBe(
      '„Sonstiges“ mit Freitext anbieten: aus. Die Auswahl zeigt nur die eingetragenen Optionen.',
    );
  });
});
