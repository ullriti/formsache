import type { ReactElement } from 'react';
import type { Question } from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBuilderStore } from './builder-store';
import { QuestionProperties } from './QuestionProperties';

/**
 * „Maximale Sterne" of a Bewertung — found during a review.
 *
 * The field used to be controlled straight off `question.max`: clearing the
 * box computed `Number('') === 0`, which is finite, so the very next line
 * clamped it back to `2` before a second keystroke could land, and typing a
 * new maximum by first clearing the box was not possible at all.
 */

const PAGE_ID = '019fe200-0000-7000-8000-0000000000b1';
const RATING_ID = '019fe200-0000-7000-8000-0000000000b2';

function ratingQuestion(max: number): Question {
  return {
    id: RATING_ID,
    label: 'Zufriedenheit',
    hint: null,
    required: false,
    width: 'full',
    type: 'rating',
    max,
  };
}

/** Renders the panel bound to the live store question, like `BuilderView` does. */
function Harness(): ReactElement | null {
  const question = useBuilderStore((state) =>
    state.pages
      .flatMap((page) => page.questions)
      .find((entry) => entry.id === RATING_ID),
  );
  if (question === undefined) {
    return null;
  }
  return <QuestionProperties question={question} />;
}

function starsInput(): HTMLInputElement {
  return screen.getByLabelText('Maximale Sterne');
}

describe('QuestionProperties – Maximale Sterne', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-1',
      title: 'Testformular',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [ratingQuestion(5)],
          },
        ],
      },
      revision: 1,
    });
  });

  it('lets the box be emptied without snapping to 2 first', () => {
    render(<Harness />);

    fireEvent.change(starsInput(), { target: { value: '' } });

    expect(starsInput()).toHaveProperty('value', '');
    // Nothing was committed yet — the stored maximum is still the one the
    // question started with.
    expect(
      useBuilderStore
        .getState()
        .pages.flatMap((page) => page.questions)
        .find((q) => q.id === RATING_ID),
    ).toMatchObject({ max: 5 });
  });

  it('lets a new maximum be typed after clearing the box, digit by digit', () => {
    render(<Harness />);

    fireEvent.change(starsInput(), { target: { value: '' } });
    fireEvent.change(starsInput(), { target: { value: '1' } });
    // „1" alone is out of range and not yet committed — typing continues.
    expect(starsInput()).toHaveProperty('value', '1');
    fireEvent.change(starsInput(), { target: { value: '10' } });

    expect(starsInput()).toHaveProperty('value', '10');
    expect(
      useBuilderStore
        .getState()
        .pages.flatMap((page) => page.questions)
        .find((q) => q.id === RATING_ID),
    ).toMatchObject({ max: 10 });
  });

  it('snaps an empty box back to the last valid value on blur', () => {
    render(<Harness />);

    fireEvent.change(starsInput(), { target: { value: '' } });
    fireEvent.blur(starsInput());

    expect(starsInput()).toHaveProperty('value', '5');
  });
});

/* --- The Veranstaltungen in the properties panel --------------- */

const EVENT_ID = '019fe200-0000-7000-8000-0000000000b3';

function eventQuestion(): Question {
  return {
    id: EVENT_ID,
    label: 'Veranstaltungen',
    hint: null,
    required: false,
    width: 'full',
    type: 'event',
    events: [
      {
        key: 'sommerfest',
        label: 'Sommerfest',
        when: 'Fr, 19:00',
        capacity: 120,
        showRemaining: false,
      },
      {
        key: 'stadtfest',
        label: 'Stadtfest',
        when: 'Sa, 20:00',
        capacity: 80,
        showRemaining: false,
      },
      {
        key: 'festzug',
        label: 'Festzug / Umzug',
        when: null,
        capacity: null,
        showRemaining: false,
      },
    ],
  };
}

function EventHarness(): ReactElement | null {
  const question = useBuilderStore((state) =>
    state.pages
      .flatMap((page) => page.questions)
      .find((entry) => entry.id === EVENT_ID),
  );
  if (question === undefined) {
    return null;
  }
  return <QuestionProperties question={question} />;
}

/** The stored Veranstaltungen of the question, straight out of the store. */
function storedEvents(): readonly { key: string; label: string }[] {
  const question = useBuilderStore
    .getState()
    .pages.flatMap((page) => page.questions)
    .find((entry) => entry.id === EVENT_ID);
  return question?.type === 'event' ? question.events : [];
}

/**
 * **The tile editor**  — creating, reordering, removing,
 * and the switch that is left to the editor.
 *
 * The claim that carries the most is the third one: the `key` is what the
 * stored answer, the export column **and** the `event_registration` rows are
 * keyed by, so a reorder that rewrote entries in place would orphan every
 * registration already taken — silently, and only visibly once somebody looked
 * at the registration state.
 */
describe('QuestionProperties – Veranstaltungen', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-2',
      title: 'Jahrestagung',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [eventQuestion()],
          },
        ],
      },
      revision: 1,
    });
  });

  it('moves an entry with ↑/↓ and keeps every key with its entry', () => {
    render(<EventHarness />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Veranstaltung 3 nach oben' }),
    );
    expect(storedEvents().map((entry) => entry.key)).toStrictEqual([
      'sommerfest',
      'festzug',
      'stadtfest',
    ]);
    // The captions travelled with their keys — a reorder that swapped the
    // *labels* would leave this list looking right and every registration
    // pointing at the wrong Veranstaltung.
    expect(storedEvents().map((entry) => entry.label)).toStrictEqual([
      'Sommerfest',
      'Festzug / Umzug',
      'Stadtfest',
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Veranstaltung 1 nach unten' }),
    );
    expect(storedEvents().map((entry) => entry.key)).toStrictEqual([
      'festzug',
      'sommerfest',
      'stadtfest',
    ]);
  });

  /** The ends are dead ends — and they say so before they are pressed. */
  it('disables the moves that would fall off the list', () => {
    render(<EventHarness />);

    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Veranstaltung 1 nach oben',
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Veranstaltung 3 nach unten',
      }).disabled,
    ).toBe(true);
  });

  it('appends a Veranstaltung and removes one by its position', () => {
    render(<EventHarness />);

    fireEvent.click(screen.getByRole('button', { name: '+ Veranstaltung' }));
    expect(storedEvents().map((entry) => entry.label)).toStrictEqual([
      'Sommerfest',
      'Stadtfest',
      'Festzug / Umzug',
      'Neue Veranstaltung',
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Veranstaltung 2 entfernen' }),
    );
    expect(storedEvents().map((entry) => entry.key)).toStrictEqual([
      'sommerfest',
      'festzug',
      'veranstaltung-4',
    ]);
  });

  /**
   * „Ohne Grenze" is a switch, never an empty box: emptying a bound is how
   * “unlimited” and “I have not entered the number yet” become one
   * state, and the schema refuses the second of them.
   */
  it('clears the Obergrenze with „ohne Grenze" and puts one back on untick', () => {
    render(<EventHarness />);

    const box = screen.getByLabelText<HTMLInputElement>(
      'Veranstaltung 1: Obergrenze',
    );
    expect(box.value).toBe('120');

    fireEvent.click(screen.getByLabelText('Veranstaltung 1: ohne Grenze'));
    expect(screen.queryByLabelText('Veranstaltung 1: Obergrenze')).toBeNull();

    fireEvent.click(screen.getByLabelText('Veranstaltung 1: ohne Grenze'));
    expect(
      screen.getByLabelText<HTMLInputElement>('Veranstaltung 1: Obergrenze')
        .value,
    ).toBe('50');
  });

  /**
   * The requirement — the switch is **per Veranstaltung** and off by default. The
   * figure is a statement about an organisation's registration state and leaves the house
   * without a session, so it is the editor's decision and not the default.
   */
  it('switches „Restplätze anzeigen" for one Veranstaltung only', () => {
    render(<EventHarness />);

    fireEvent.click(
      screen.getByLabelText('Veranstaltung 2: Restplätze anzeigen'),
    );

    const question = useBuilderStore
      .getState()
      .pages.flatMap((page) => page.questions)
      .find((entry) => entry.id === EVENT_ID);
    expect(
      question?.type === 'event'
        ? question.events.map((entry) => entry.showRemaining)
        : [],
    ).toStrictEqual([false, true, false]);
  });
});

/**
 * **The rejection belongs to the question at which it arose** (review finding 17).
 *
 * `issue` is the sibling case of the live region next to it, which already
 * withdrew its sentence on a change of question: the panel is not rebuilt per
 * question (`BuilderView` renders it without a `key`), so a message that
 * `questionSchema` passed about the one question stayed standing over the next
 * — in a `role="alert"` region, that is, one that asserts something.
 */
describe('QuestionProperties – die Ablehnung beim Fragewechsel', () => {
  const FIRST_ID = '019fe210-0000-7000-8000-0000000000c1';
  const SECOND_ID = '019fe210-0000-7000-8000-0000000000c2';

  function textQuestion(id: string, label: string): Question {
    return {
      id,
      label,
      hint: null,
      required: false,
      width: 'full',
      type: 'text',
      minLength: null,
      maxLength: null,
      pattern: null,
    };
  }

  function Switcher({ id }: { readonly id: string }): ReactElement | null {
    const question = useBuilderStore((state) =>
      state.pages
        .flatMap((page) => page.questions)
        .find((entry) => entry.id === id),
    );
    return question === undefined ? null : (
      <QuestionProperties question={question} />
    );
  }

  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-issue',
      title: 'Testformular',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [
              textQuestion(FIRST_ID, 'Name'),
              textQuestion(SECOND_ID, 'Ort'),
            ],
          },
        ],
      },
      revision: 1,
    });
  });

  it('nimmt eine abgelehnte Eingabe beim Wechsel der Frage zurück', () => {
    const view = render(<Switcher id={FIRST_ID} />);

    // A hint text beyond `HINT_MAX` — the schema refuses, the store stays put,
    // and the panel says why.
    fireEvent.change(screen.getByLabelText('Hinweistext'), {
      target: { value: 'x'.repeat(1_001) },
    });
    expect(screen.getByRole('alert')).toBeDefined();

    view.rerender(<Switcher id={SECOND_ID} />);

    expect(screen.queryByRole('alert')).toBeNull();
    // …and the second question really is on show, so that the `null` above is
    // not down to nothing being rendered any more at all.
    expect(screen.getByLabelText<HTMLInputElement>('Fragetext').value).toBe(
      'Ort',
    );
  });
});

/* --- The „Sonstiges" position (Issue #37) ----------------------- */

const OTHER_POSITION_ID = '019fe220-0000-7000-8000-0000000000d1';

function selectWithOther(
  overrides: Partial<{
    allowOther: boolean;
    otherLabel: string | null;
  }> = {},
): Question {
  return {
    id: OTHER_POSITION_ID,
    label: 'Organisation',
    hint: null,
    required: false,
    width: 'full',
    type: 'select',
    options: [{ value: 'option-1', label: 'Alte Breslauer' }],
    allowOther: true,
    otherLabel: 'Sonstiges',
    ...overrides,
  };
}

function OtherPositionHarness(): ReactElement | null {
  const question = useBuilderStore((state) =>
    state.pages
      .flatMap((page) => page.questions)
      .find((entry) => entry.id === OTHER_POSITION_ID),
  );
  return question === undefined ? null : (
    <QuestionProperties question={question} />
  );
}

function storedOtherPositionQuestion(): Question | undefined {
  return useBuilderStore
    .getState()
    .pages.flatMap((page) => page.questions)
    .find((entry) => entry.id === OTHER_POSITION_ID);
}

/**
 * The switch that decides whether „Sonstiges" opens or closes the list
 * (design handoff via Issue #37).
 *
 * Gated on `allowOther`: there is nothing to reorder around a „Sonstiges"
 * entry the question does not offer, and the switch says so by not being on
 * screen — the same reasoning `otherLabel`'s own field already follows.
 */
describe('QuestionProperties – „Sonstiges" Position', () => {
  function load(question: Question): void {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-other-position',
      title: 'Testformular',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [question],
          },
        ],
      },
      revision: 1,
    });
  }

  it('zeigt den Schalter erst, sobald „Sonstiges“ überhaupt angeboten wird', () => {
    load(selectWithOther({ allowOther: false, otherLabel: null }));
    render(<OtherPositionHarness />);

    expect(screen.queryByLabelText('„Sonstiges“ unten anzeigen')).toBeNull();

    fireEvent.click(screen.getByLabelText('„Sonstiges“ mit Freitext anbieten'));

    expect(screen.getByLabelText('„Sonstiges“ unten anzeigen')).toBeDefined();
  });

  it('steht ohne eigene Einstellung auf „zuerst" — dem Vorgabewert des Schalters', () => {
    // No `otherPosition` in the stored document at all — the state every
    // question saved before this switch existed is in, and the one
    // `otherPositionOf` reads as „first" (`form-schema.ts`).
    load(selectWithOther());
    render(<OtherPositionHarness />);

    expect(
      screen.getByLabelText<HTMLInputElement>('„Sonstiges“ unten anzeigen')
        .checked,
    ).toBe(false);
  });

  it('schreibt „first"/„last" beim Umlegen, und nur das', () => {
    load(selectWithOther());
    render(<OtherPositionHarness />);

    fireEvent.click(screen.getByLabelText('„Sonstiges“ unten anzeigen'));
    expect(storedOtherPositionQuestion()).toMatchObject({
      otherPosition: 'last',
    });

    fireEvent.click(screen.getByLabelText('„Sonstiges“ unten anzeigen'));
    expect(storedOtherPositionQuestion()).toMatchObject({
      otherPosition: 'first',
    });
  });
});
