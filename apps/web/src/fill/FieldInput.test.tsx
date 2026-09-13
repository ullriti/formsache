import { useState } from 'react';

import type {
  AnswerValue,
  ChoiceQuestion,
  PublicEventSeats,
  Question,
} from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FieldInput } from './FieldInput';

/**
 * The „Sonstiges" free text of a **dropdown** (a review finding).
 *
 * The builder offers the entry for every choice type; the fill-in view rendered
 * the text box for `radio` and `checkbox` only. In the Dachorganisation's own form the entry
 * reads „Nicht Mitglied der Dachorganisation – Name der Organisation", so a non-member picked a
 * control that promised to take the name of their Organisation and nothing arrived —
 * the submission was accepted with `{"values": [], "other": ""}` and the export
 * showed an empty cell.
 *
 * What is asserted here is the *wiring*: which controls appear and what the
 * click hands over. What the values themselves come out as is
 * `choice-answer.test.ts` — a calculation belongs in a calculation's test, not
 * in jsdom (`CONTRIBUTING.md`).
 */

const OTHER_LABEL =
  'Nicht Mitglied der Dachorganisation – Name der Organisation';
const FREE_TEXT_LABEL = `${OTHER_LABEL}: Freitext`;
const OTHER_TEXT = 'Schachverein Nord';

function choiceQuestion(
  type: 'select' | 'radio' | 'checkbox',
  overrides: Partial<{ required: boolean; otherLabel: string | null }> = {},
): ChoiceQuestion {
  const base = {
    id: '019fe600-0000-7000-8000-0000000000c1',
    label: 'Organisation',
    hint: null,
    required: true,
    width: 'full',
    options: [
      { value: 'nord', label: 'Nord' },
      { value: 'sued', label: 'Süd' },
    ],
    allowOther: true,
    otherLabel: OTHER_LABEL,
    ...overrides,
  } satisfies Omit<Extract<ChoiceQuestion, { type: 'select' }>, 'type'>;

  // Spelled out per branch: `type` as a union would leave the literal
  // unassignable to the discriminated union it discriminates.
  switch (type) {
    case 'select':
      return { ...base, type: 'select' };
    case 'radio':
      return { ...base, type: 'radio' };
    case 'checkbox':
      return {
        ...base,
        type: 'checkbox',
        minSelected: null,
        maxSelected: null,
      };
  }
}

/**
 * The field with the state a real form gives it.
 *
 * `FieldInput` is controlled, and an uncontrolled harness would let the first
 * assertion pass on a component that never re-renders — exactly the class of
 * bug this file is about.
 */
function Harness({
  question,
  onValue,
}: {
  readonly question: ChoiceQuestion;
  readonly onValue: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  return (
    <FieldInput
      question={question}
      value={value}
      error={undefined}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

function selectEntry(label: string): void {
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: labelToValue(label) },
  });
}

/** The `value` of the `<option>` carrying `label` — read off the DOM, not guessed. */
function labelToValue(label: string): string {
  const option = screen
    .getAllByRole('option')
    .find((entry) => entry.textContent === label);
  if (!(option instanceof HTMLOptionElement)) {
    throw new Error(`Keine Option mit der Beschriftung „${label}".`);
  }
  return option.value;
}

describe('FieldInput – „Sonstiges" in a dropdown', () => {
  it('offers no free-text box before the entry is chosen', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('select')} onValue={onValue} />);

    expect(screen.queryByLabelText(FREE_TEXT_LABEL)).toBeNull();
  });

  it('reveals a free-text box named after the entry, and submits what is typed', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('select')} onValue={onValue} />);

    selectEntry(OTHER_LABEL);

    const box = screen.getByLabelText(FREE_TEXT_LABEL);
    fireEvent.change(box, { target: { value: OTHER_TEXT } });

    expect(onValue).toHaveBeenLastCalledWith({ values: [], other: OTHER_TEXT });
  });

  it('keeps the free-text box inside its own field, so it stacks instead of widening it', () => {
    const onValue = vi.fn();
    const { container } = render(
      <Harness question={choiceQuestion('select')} onValue={onValue} />,
    );

    selectEntry(OTHER_LABEL);

    // One `.field` — the box is a child of it, not a sibling. `.field` is a
    // column, so the second control stacks and cannot widen the row `rowsOf`
    // put the question in.
    expect(container.querySelectorAll('.field')).toHaveLength(1);
    expect(
      container
        .querySelector('.field')
        ?.contains(screen.getByLabelText(FREE_TEXT_LABEL)),
    ).toBe(true);
  });

  /**
   * Point 2: picking a real option afterwards **drops** the text and takes the
   * box off screen — the same thing the radio branch has always done.
   */
  it('drops the typed text when a real option is picked afterwards', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('select')} onValue={onValue} />);

    selectEntry(OTHER_LABEL);
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    selectEntry('Süd');

    expect(onValue).toHaveBeenLastCalledWith({
      values: ['sued'],
      other: null,
    });
    expect(screen.queryByLabelText(FREE_TEXT_LABEL)).toBeNull();
  });

  it('falls back to the handoff caption when the editor set none', () => {
    const onValue = vi.fn();
    render(
      <Harness
        question={choiceQuestion('select', { otherLabel: null })}
        onValue={onValue}
      />,
    );

    selectEntry('Sonstiges');

    expect(screen.getByLabelText('Sonstiges: Freitext')).toBeDefined();
  });

  /**
   * The radio branch is the reference the select branch was made to match; it
   * now runs through the same component, so this pins the behaviour both share.
   */
  it('keeps the radio branch working through the same component', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('radio')} onValue={onValue} />);

    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });

    expect(onValue).toHaveBeenLastCalledWith({ values: [], other: OTHER_TEXT });
  });
});

/**
 * Who **carries the question text** — the one thing that decides whether a
 * question is announced at all.
 *
 * `rendersAsGroup` sorts every type into „one control" or „a group of them",
 * and the two halves are named in opposite ways: a single control by a
 * `<label htmlFor>`, a group by `role="group"` + `aria-labelledby`. Sorting
 * alone proves nothing, though — what matters is that the name really arrives,
 * and that is exactly what went missing and would go missing again
 * for every multi-part type. Asked by the **name**, so that moving a
 * type from one half to the other turns this file red instead of silently
 * dropping its label.
 */
describe('FieldInput – the question text reaches the control', () => {
  // These three ask what is on screen, not what a click hands over.
  const ignored = vi.fn();

  it('names a radio group as a group', () => {
    render(<Harness question={choiceQuestion('radio')} onValue={ignored} />);

    expect(screen.getByRole('group', { name: 'Organisation' })).toBeDefined();
  });

  it('names a checkbox group as a group', () => {
    render(<Harness question={choiceQuestion('checkbox')} onValue={ignored} />);

    expect(screen.getByRole('group', { name: 'Organisation' })).toBeDefined();
  });

  /**
   * The deliberate other half: a dropdown stays **one** control, because the
   * `<select>` itself carries the id the label points at. Asked by the name on
   * purpose — a bare `getByRole('combobox')` would keep passing if `select`
   * were moved into the group half, where the label would point at an id no
   * element carries and the „Organisation" would never be read out.
   */
  it('names a dropdown through its own label, and builds no group around it', () => {
    render(<Harness question={choiceQuestion('select')} onValue={ignored} />);

    expect(
      screen.getByRole('combobox', { name: 'Organisation' }),
    ).toBeDefined();
    expect(screen.queryByRole('group')).toBeNull();
  });
});

/**
 * The checkbox branch — the only one that **carries `other` along** while ticks
 * come and go, and the one that had no test at all. Select and radio replace the
 * whole answer on every click; here a tick has to leave the free text where it
 * is, and the free text has to leave the ticks where they are. That is two
 * directions of one rule, and neither was pinned.
 */
/**
 * Bewertung — the prototype's stars are a plain `<span
 * onClick>`, reachable by mouse only; this component renders `max` native
 * `<input type="radio">` instead, so what is asserted here is exactly the gap
 * that closes: a real, named, keyboard-reachable control, not merely a click
 * handler that happens to work.
 */
type RatingQuestion = Extract<Question, { type: 'rating' }>;

function ratingQuestion(
  overrides: Partial<RatingQuestion> = {},
): RatingQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c2',
    label: 'Zufriedenheit',
    hint: null,
    required: false,
    width: 'full',
    type: 'rating',
    max: 5,
    ...overrides,
  };
}

function RatingHarness({
  question,
  onValue,
}: {
  readonly question: RatingQuestion;
  readonly onValue: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  return (
    <FieldInput
      question={question}
      value={value}
      error={undefined}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('FieldInput – Bewertung (rating)', () => {
  /** The evidence, word for word: the third star stores `3`. */
  it('stores 3 when the third star is clicked', () => {
    const onValue = vi.fn();
    render(<RatingHarness question={ratingQuestion()} onValue={onValue} />);

    fireEvent.click(screen.getByRole('radio', { name: '3 von 5 Sternen' }));

    expect(onValue).toHaveBeenLastCalledWith(3);
  });

  /**
   * Every star has its own accessible name — a screen reader announces
   * „3 von 5 Sternen", never a bare „★" the glyph alone would give it.
   */
  it('names every star with its position and the question’s own max', () => {
    render(
      <RatingHarness question={ratingQuestion({ max: 3 })} onValue={vi.fn()} />,
    );

    expect(
      screen.getByRole('radio', { name: '1 von 3 Sternen' }),
    ).toBeDefined();
    expect(
      screen.getByRole('radio', { name: '2 von 3 Sternen' }),
    ).toBeDefined();
    expect(
      screen.getByRole('radio', { name: '3 von 3 Sternen' }),
    ).toBeDefined();
  });

  /**
   * Real `<input type="radio">` elements, not the prototype's `<span
   * onClick>`: `getByRole('radio', …)` only succeeds on an actual form
   * control, and sharing one `name` is what makes a browser move the
   * selection with the arrow keys on its own — the native behaviour this
   * view relies on instead of reimplementing it.
   */
  it('is a real radio group a keyboard can operate, not a row of click targets', () => {
    render(<RatingHarness question={ratingQuestion()} onValue={vi.fn()} />);

    const stars = screen.getAllByRole('radio');
    expect(stars).toHaveLength(5);

    const names = new Set(stars.map((star) => (star as HTMLInputElement).name));
    expect(names.size).toBe(1);

    stars[0]?.focus();
    expect(document.activeElement).toBe(stars[0]);
  });

  it('names the group like a radio question, so the question text is announced', () => {
    render(
      <RatingHarness
        question={ratingQuestion({ label: 'Zufriedenheit' })}
        onValue={vi.fn()}
      />,
    );

    expect(screen.getByRole('group', { name: 'Zufriedenheit' })).toBeDefined();
  });

  /**
   * Clicking star *i* fills stars 1..i, not just the one clicked (Handoff:
   * „Klick auf Position i setzt den Wert i+1"). Read off the glyph, which is
   * the one thing a participant actually sees.
   */
  it('fills every star up to the one clicked, not only that one', () => {
    const { container } = render(
      <RatingHarness question={ratingQuestion()} onValue={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('radio', { name: '3 von 5 Sternen' }));

    const glyphs = [...container.querySelectorAll('.field__rating-glyph')].map(
      (glyph) => glyph.textContent,
    );
    expect(glyphs).toStrictEqual(['★', '★', '★', '☆', '☆']);
  });

  /**
   * A review finding: a native radio cannot be unchecked by clicking
   * it again, so an *optional* rating had no way back to "keine Angabe" once
   * a star was picked — not even by mouse. A labelled, keyboard-reachable
   * button rather than "click the selected star again": it is announced, it
   * is discoverable, and it needs no gesture the handoff never showed.
   */
  it('offers no reset before anything is picked, and one afterwards', () => {
    render(<RatingHarness question={ratingQuestion()} onValue={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '3 von 5 Sternen' }));

    expect(screen.getByRole('button', { name: 'Zurücksetzen' })).toBeDefined();
  });

  it('clears the rating back to unanswered on reset, not to a star value', () => {
    const onValue = vi.fn();
    render(<RatingHarness question={ratingQuestion()} onValue={onValue} />);

    fireEvent.click(screen.getByRole('radio', { name: '3 von 5 Sternen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurücksetzen' }));

    expect(onValue).toHaveBeenLastCalledWith(null);
    expect(
      screen
        .getAllByRole('radio')
        .every((star) => !(star as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull();
  });
});

describe('FieldInput – „Sonstiges" in a checkbox list', () => {
  it('reveals the box on ticking and takes the typed text with the ticks', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('checkbox')} onValue={onValue} />);

    expect(screen.queryByLabelText(FREE_TEXT_LABEL)).toBeNull();

    fireEvent.click(screen.getByLabelText('Nord'));
    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord'],
      other: null,
    });

    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord'],
      other: '',
    });

    // The free text is written next to the tick, not instead of it — a checkbox
    // list is the one place where both are an answer at the same time.
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord'],
      other: OTHER_TEXT,
    });
  });

  it('keeps the typed text when another option is unticked', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('checkbox')} onValue={onValue} />);

    fireEvent.click(screen.getByLabelText('Nord'));
    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    fireEvent.click(screen.getByLabelText('Nord'));

    expect(onValue).toHaveBeenLastCalledWith({ values: [], other: OTHER_TEXT });
    expect(screen.getByLabelText(FREE_TEXT_LABEL)).toHaveProperty(
      'value',
      OTHER_TEXT,
    );
  });

  /**
   * Unticking „Sonstiges" drops the text. That is deliberate rather than
   * regrettable: the box is gone from the screen, and an answer still carrying
   * a free text nobody can see is what turns up in the export as a sentence the
   * participant thought they had removed.
   */
  it('drops the typed text when „Sonstiges" itself is unticked', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('checkbox')} onValue={onValue} />);

    fireEvent.click(screen.getByLabelText('Nord'));
    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    fireEvent.click(screen.getByLabelText(OTHER_LABEL));

    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord'],
      other: null,
    });
    expect(screen.queryByLabelText(FREE_TEXT_LABEL)).toBeNull();

    // And it stays dropped: ticking again offers an empty box rather than
    // resurrecting a sentence the participant took back.
    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    expect(screen.getByLabelText(FREE_TEXT_LABEL)).toHaveProperty('value', '');
  });

  /**
   * The other direction, and the one a fixed `other: null` in the option branch
   * would break: the free text is written **first**, and ticking options after
   * it must not wipe it. Written in this order on purpose — a participant who
   * fills the box before finishing the list is the ordinary case, not an edge
   * one.
   */
  it('keeps the free text while options are ticked after it', () => {
    const onValue = vi.fn();
    render(<Harness question={choiceQuestion('checkbox')} onValue={onValue} />);

    fireEvent.click(screen.getByLabelText(OTHER_LABEL));
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });

    fireEvent.click(screen.getByLabelText('Nord'));
    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord'],
      other: OTHER_TEXT,
    });

    fireEvent.click(screen.getByLabelText('Süd'));
    expect(onValue).toHaveBeenLastCalledWith({
      values: ['nord', 'sued'],
      other: OTHER_TEXT,
    });
    expect(screen.getByLabelText(FREE_TEXT_LABEL)).toHaveProperty(
      'value',
      OTHER_TEXT,
    );
  });
});

type InfoQuestion = Extract<Question, { type: 'info' }>;

function infoQuestion(overrides: Partial<InfoQuestion> = {}): InfoQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c3',
    label: 'Bitte in Blockschrift ausfüllen.',
    hint: null,
    required: false,
    width: 'full',
    type: 'info',
    ...overrides,
  };
}

describe('FieldInput – Infotext', () => {
  /** the evidence: rendered, and as the callout — not as a labelled field. */
  it('renders label and hint together, and no form control', () => {
    const { container } = render(
      <FieldInput
        question={infoQuestion({
          label: 'Bitte pünktlich erscheinen.',
          hint: 'Einlass ab 18 Uhr.',
        })}
        value={undefined}
        error={undefined}
        onChange={vi.fn()}
      />,
    );

    // `getByText` throws when nothing matches, which is the assertion:
    // label and hint appear concatenated, in one node.
    screen.getByText('Bitte pünktlich erscheinen. Einlass ab 18 Uhr.');
    // No `.field` structure at all — an `info` has no label element to point
    // a control at and nothing to invalidate.
    expect(container.querySelector('.field')).toBeNull();
    expect(container.querySelector('input, textarea, select')).toBeNull();
  });

  it('renders just the label when there is no hint', () => {
    render(
      <FieldInput
        question={infoQuestion({ label: 'Nur die Beschriftung.', hint: null })}
        value={undefined}
        error={undefined}
        onChange={vi.fn()}
      />,
    );

    screen.getByText('Nur die Beschriftung.');
  });
});

type AddressQuestion = Extract<Question, { type: 'address' }>;

function addressQuestion(
  overrides: Partial<AddressQuestion> = {},
): AddressQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c4',
    label: 'Anschrift',
    hint: null,
    required: false,
    width: 'full',
    type: 'address',
    ...overrides,
  };
}

function AddressHarness({
  question,
  onValue,
}: {
  readonly question: AddressQuestion;
  readonly onValue: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  return (
    <FieldInput
      question={question}
      value={value}
      error={undefined}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('FieldInput – Adresse', () => {
  it('renders the four subfields, named by their own label', () => {
    render(<AddressHarness question={addressQuestion()} onValue={vi.fn()} />);

    expect(screen.getByLabelText('Straße & Hausnummer')).toBeDefined();
    expect(screen.getByLabelText('PLZ')).toBeDefined();
    expect(screen.getByLabelText('Ort')).toBeDefined();
    expect(screen.getByLabelText('Land')).toBeDefined();
  });

  /**
   * The one thing `rendersAsGroup` exists to guarantee for a multi-part type
   * (closed again for Adresse): the question text reaches
   * screen readers as the name of the *group*, not as the name of one
   * subfield by accident.
   */
  it('names the group like a radio question, so the question text is announced', () => {
    render(
      <AddressHarness
        question={addressQuestion({ label: 'Rechnungsadresse' })}
        onValue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('group', { name: 'Rechnungsadresse' }),
    ).toBeDefined();
  });

  /**
   * Default „Deutschland", overwritable — shown before anything is typed,
   * and it is what the untouched field would submit.
   */
  it('shows Land pre-filled with Deutschland before anything is typed', () => {
    render(<AddressHarness question={addressQuestion()} onValue={vi.fn()} />);

    expect(screen.getByLabelText('Land')).toHaveProperty(
      'value',
      'Deutschland',
    );
  });

  it('merges one subfield onto the others, carrying the Land default along', () => {
    const onValue = vi.fn();
    render(<AddressHarness question={addressQuestion()} onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Straße & Hausnummer'), {
      target: { value: 'Musterstraße 12' },
    });

    // Touching *one* field bakes the Land default into what would
    // be submitted, not only into what is displayed.
    expect(onValue).toHaveBeenLastCalledWith({
      street: 'Musterstraße 12',
      zip: '',
      city: '',
      country: 'Deutschland',
    });

    fireEvent.change(screen.getByLabelText('PLZ'), {
      target: { value: '01067' },
    });
    expect(onValue).toHaveBeenLastCalledWith({
      street: 'Musterstraße 12',
      zip: '01067',
      city: '',
      country: 'Deutschland',
    });
  });

  it('lets Land be overwritten, and keeps exactly what was typed', () => {
    const onValue = vi.fn();
    render(<AddressHarness question={addressQuestion()} onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Land'), {
      target: { value: 'Österreich' },
    });

    expect(onValue).toHaveBeenLastCalledWith({
      street: '',
      zip: '',
      city: '',
      country: 'Österreich',
    });
  });

  it('lets Land be cleared, and does not resurrect the default once touched', () => {
    const onValue = vi.fn();
    render(<AddressHarness question={addressQuestion()} onValue={onValue} />);

    const land = screen.getByLabelText('Land');
    fireEvent.change(land, { target: { value: '' } });

    expect(onValue).toHaveBeenLastCalledWith({
      street: '',
      zip: '',
      city: '',
      country: '',
    });
    expect(land).toHaveProperty('value', '');
  });

  /**
   * A review finding, measured on the write path: typing a character
   * into an optional address and deleting it again used to store
   * `{street:'', zip:'', city:'', country:'Deutschland'}` — three empty
   * subfields plus the untouched Land default — which `isBlankAnswer` reads
   * as answered, so a participant who touched nothing meaningful still
   * produced a row in the export.
   */
  it('resets to unanswered instead of leaving the baked-in Land default behind', () => {
    const onValue = vi.fn();
    render(<AddressHarness question={addressQuestion()} onValue={onValue} />);

    const street = screen.getByLabelText('Straße & Hausnummer');
    fireEvent.change(street, { target: { value: 'X' } });
    expect(onValue).toHaveBeenLastCalledWith({
      street: 'X',
      zip: '',
      city: '',
      country: 'Deutschland',
    });

    fireEvent.change(street, { target: { value: '' } });

    expect(onValue).toHaveBeenLastCalledWith(null);
    // And the Land box shows the default again, exactly as an untouched
    // question would — not an empty box the reset left behind.
    expect(screen.getByLabelText('Land')).toHaveProperty(
      'value',
      'Deutschland',
    );
  });

  /**
   * The counter-case: once Land carries a *real*, deliberately typed value,
   * clearing an unrelated subfield again must not throw that away — the
   * reset above only fires while Land still says exactly the untouched
   * default (`isBlankAnswer`'s own "Land auf sich allein gestellt ist eine
   * Antwort" stays true here, unaffected by this finding).
   */
  it('keeps an explicit Land when a different subfield is cleared back to empty', () => {
    const onValue = vi.fn();
    render(<AddressHarness question={addressQuestion()} onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Land'), {
      target: { value: 'Österreich' },
    });
    const street = screen.getByLabelText('Straße & Hausnummer');
    fireEvent.change(street, { target: { value: 'X' } });
    fireEvent.change(street, { target: { value: '' } });

    expect(onValue).toHaveBeenLastCalledWith({
      street: '',
      zip: '',
      city: '',
      country: 'Österreich',
    });
  });
});

type MatrixQuestion = Extract<Question, { type: 'matrix' }>;
type TableQuestion = Extract<Question, { type: 'table' }>;

function matrixQuestion(
  overrides: Partial<MatrixQuestion> = {},
): MatrixQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c5',
    label: 'Bewerte folgende Punkte',
    hint: null,
    required: false,
    width: 'full',
    type: 'matrix',
    rows: [
      { value: 'organisation', label: 'Organisation' },
      { value: 'programm', label: 'Programm' },
    ],
    columns: [
      { value: 'sehr-gut', label: 'Sehr gut' },
      { value: 'gut', label: 'Gut' },
    ],
    multiple: false,
    ...overrides,
  };
}

function tableQuestion(overrides: Partial<TableQuestion> = {}): TableQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c6',
    label: 'Begleitpersonen',
    hint: null,
    required: false,
    width: 'full',
    type: 'table',
    columns: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'anzahl', label: 'Anzahl', type: 'number' },
      {
        key: 'kategorie',
        label: 'Kategorie',
        type: 'select',
        options: [
          { value: 'gast', label: 'Gast' },
          { value: 'partner', label: 'Partner/in' },
        ],
      },
      { key: 'vegetarisch', label: 'Vegetarisch', type: 'checkbox' },
    ],
    rows: 2,
    ...overrides,
  };
}

/** The same stateful harness the Adresse uses, for any question type. */
function GridHarness({
  question,
  onValue,
}: {
  readonly question: Question;
  readonly onValue: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  return (
    <FieldInput
      question={question}
      value={value}
      error={undefined}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('FieldInput – Matrix', () => {
  /**
   * The same trap `rendersAsGroup` exists for: a
   * multi-part type that took the `<label htmlFor>` branch would point at an
   * id no element carries, and the question text would simply never be
   * announced. Asserted through the **name of the
   * group**, not through the presence of a `<span>`.
   */
  it('names the group with the question text', () => {
    render(<GridHarness question={matrixQuestion()} onValue={vi.fn()} />);

    expect(
      screen.getByRole('group', { name: 'Bewerte folgende Punkte' }),
    ).toBeDefined();
  });

  /**
   * Every cell is a real control with its own accessible name — „Programm:
   * Gut" rather than an unlabelled radio in a table nobody can read aloud.
   * The prototype's `<span onClick>` cells have neither.
   */
  it('gives every cell a control named by its row and column', () => {
    render(<GridHarness question={matrixQuestion()} onValue={vi.fn()} />);

    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByLabelText('Programm: Gut')).toBeDefined();
  });

  /**
   * One radio group **per row**: the browser then enforces „eine Auswahl je
   * Zeile" and the arrow keys work, without a line of code here. Measured
   * through the two rows having different `name` attributes — the thing that
   * makes them separate groups.
   */
  it('puts each row in its own radio group', () => {
    render(<GridHarness question={matrixQuestion()} onValue={vi.fn()} />);

    const first = screen.getByLabelText('Organisation: Gut');
    const second = screen.getByLabelText('Programm: Gut');

    expect(first).toHaveProperty('name');
    expect((first as HTMLInputElement).name).not.toBe(
      (second as HTMLInputElement).name,
    );
  });

  it('stores the pick under its row, and replaces it on a second click', () => {
    const onValue = vi.fn();
    render(<GridHarness question={matrixQuestion()} onValue={onValue} />);

    fireEvent.click(screen.getByLabelText('Organisation: Sehr gut'));
    expect(onValue).toHaveBeenLastCalledWith({
      rows: { organisation: ['sehr-gut'] },
    });

    fireEvent.click(screen.getByLabelText('Organisation: Gut'));
    expect(onValue).toHaveBeenLastCalledWith({
      rows: { organisation: ['gut'] },
    });

    fireEvent.click(screen.getByLabelText('Programm: Gut'));
    expect(onValue).toHaveBeenLastCalledWith({
      rows: { organisation: ['gut'], programm: ['gut'] },
    });
  });

  /** „Mehrfachauswahl je Zeile" turns the cells into checkboxes that toggle. */
  it('offers checkboxes and keeps several picks when Mehrfachauswahl is on', () => {
    const onValue = vi.fn();
    render(
      <GridHarness
        question={matrixQuestion({ multiple: true })}
        onValue={onValue}
      />,
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(4);

    fireEvent.click(screen.getByLabelText('Organisation: Sehr gut'));
    fireEvent.click(screen.getByLabelText('Organisation: Gut'));
    expect(onValue).toHaveBeenLastCalledWith({
      rows: { organisation: ['sehr-gut', 'gut'] },
    });

    fireEvent.click(screen.getByLabelText('Organisation: Sehr gut'));
    expect(onValue).toHaveBeenLastCalledWith({
      rows: { organisation: ['gut'] },
    });
  });
});

describe('FieldInput – Tabelle', () => {
  it('names the group with the question text', () => {
    render(<GridHarness question={tableQuestion()} onValue={vi.fn()} />);

    expect(
      screen.getByRole('group', { name: 'Begleitpersonen' }),
    ).toBeDefined();
  });

  /**
   * The row count comes from the **question**, and every cell is a real
   * control — the prototype's cells carry no `value` and no handler at all, so
   * a table built by reading it stores nothing.
   */
  it('renders one control per cell, named by column and row number', () => {
    render(<GridHarness question={tableQuestion()} onValue={vi.fn()} />);

    for (const row of ['Zeile 1', 'Zeile 2']) {
      expect(screen.getByLabelText(`Name, ${row}`)).toBeDefined();
      expect(screen.getByLabelText(`Anzahl, ${row}`)).toBeDefined();
      expect(screen.getByLabelText(`Kategorie, ${row}`)).toBeDefined();
      expect(screen.getByLabelText(`Vegetarisch, ${row}`)).toBeDefined();
    }
  });

  it('offers the control its Zelltyp calls for', () => {
    render(<GridHarness question={tableQuestion()} onValue={vi.fn()} />);

    expect(screen.getByLabelText('Anzahl, Zeile 1')).toHaveProperty(
      'type',
      'number',
    );
    expect(screen.getByLabelText('Kategorie, Zeile 1').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Vegetarisch, Zeile 1')).toHaveProperty(
      'type',
      'checkbox',
    );
  });

  it('stores each cell under its own row and column', () => {
    const onValue = vi.fn();
    render(<GridHarness question={tableQuestion()} onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Name, Zeile 1'), {
      target: { value: 'Anna' },
    });
    expect(onValue).toHaveBeenLastCalledWith({
      cells: [{ name: 'Anna' }, {}],
    });

    fireEvent.change(screen.getByLabelText('Anzahl, Zeile 2'), {
      target: { value: '3' },
    });
    expect(onValue).toHaveBeenLastCalledWith({
      cells: [{ name: 'Anna' }, { anzahl: 3 }],
    });

    fireEvent.click(screen.getByLabelText('Vegetarisch, Zeile 1'));
    expect(onValue).toHaveBeenLastCalledWith({
      cells: [{ name: 'Anna', vegetarisch: true }, { anzahl: 3 }],
    });
  });

  /**
   * „Leer" has one spelling: clearing a cell removes it rather than storing
   * `''`, `null` or `false`. That is what keeps `isBlankAnswer` and the
   * Pflicht rule („mindestens eine Zeile ausgefüllt") reading the same thing.
   */
  it('removes a cell instead of storing an empty value', () => {
    const onValue = vi.fn();
    render(<GridHarness question={tableQuestion()} onValue={onValue} />);

    const name = screen.getByLabelText('Name, Zeile 1');
    fireEvent.change(name, { target: { value: 'Anna' } });
    fireEvent.change(name, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith({ cells: [{}, {}] });

    const tick = screen.getByLabelText('Vegetarisch, Zeile 1');
    fireEvent.click(tick);
    fireEvent.click(tick);
    expect(onValue).toHaveBeenLastCalledWith({ cells: [{}, {}] });
  });
});

/* --- „+ Zeile" in the fill-in view ------------------------------ */

/**
 * Adding rows and removing them again.
 *
 * The Obergrenze itself belongs to `@formsache/shared` (`tableRowLimit`) and the
 * refusal to the server (`TABLE_ROW_LIMIT_CODE`); what this file asks is what
 * the participant sees and what leaves the browser.
 */
describe('FieldInput – Tabelle, „+ Zeile" ', () => {
  /** `rows: 1` plus `addRows` — the shape the shared schema recommends. */
  function growingTable(maxRows = 4): TableQuestion {
    return tableQuestion({ rows: 1, addRows: { maxRows } });
  }

  /** How many cells the header row has — the grid's real column count. */
  function headerCells(): number {
    const header = screen.getAllByRole('row')[0];
    if (header === undefined) {
      throw new Error('Die Tabelle hat keine Kopfzeile.');
    }
    return header.children.length;
  }

  /**
   * A tap with the finger.
   *
   * The sequence a touch screen produces, and deliberately **without** any
   * mouse event: a handler hung on `onMouseDown`, or one that asks
   * `pointerType === 'mouse'`, never fires here. The fill-in view is the one
   * screen of this application that is mostly used on a telephone.
   */
  function tap(element: HTMLElement): void {
    fireEvent.pointerDown(element, { pointerType: 'touch', pointerId: 1 });
    fireEvent.pointerUp(element, { pointerType: 'touch', pointerId: 1 });
    fireEvent.click(element, { detail: 0 });
  }

  /**
   * The same press with the mouse — the counter-check to {@link tap}.
   *
   * It exists so the touch case can be told apart from a button that is simply
   * broken: a handler that asks `pointerType === 'mouse'` leaves this one
   * working and only the finger locked out, which is the failure the requirement
   * describes and which a pair of bare `fireEvent.click`s cannot see.
   */
  function pressWithMouse(element: HTMLElement): void {
    fireEvent.pointerDown(element, { pointerType: 'mouse', pointerId: 1 });
    fireEvent.mouseDown(element);
    fireEvent.pointerUp(element, { pointerType: 'mouse', pointerId: 1 });
    fireEvent.mouseUp(element);
    fireEvent.click(element, { detail: 1 });
  }

  function addRow(): void {
    fireEvent.click(screen.getByRole('button', { name: '+ Zeile' }));
  }

  /**
   * **Nothing about an older table changes** — not the buttons, and not the
   * width of the grid. Without `addRows` there is no action column at all, so
   * a helper that reads the columns by position reads the same thing it read
   * before this package.
   */
  /**
   * **A table whose Startzeilen are already the Obergrenze gets no
   * action column.**
   *
   * `rows: 20, maxRows: 20` is „Zeilen ergänzbar" ticked on a table that has
   * no room left — `TABLE_ROWS_MAX` is the ceiling of the Obergrenze too, so
   * the switch cannot buy a single row. Neither „+ Zeile" nor „Entfernen" can
   * ever appear, and a column drawn for them would be an empty `<th>` over
   * twenty empty `<td>`s: the grid one cell wider, for nothing, on the screen
   * that is mostly read on a telephone.
   *
   * The Live-Vorschau excludes exactly this state (`tableCanGrow`, measured in
   * `builder/table-row-growth.test.tsx`), so the two views agreeing is the
   * point — the same question answered differently on two screens is two forms.
   *
   * **The assertion is the column count**, not the absence of the buttons: the
   * buttons were already absent while the bug was there. Four columns is what
   * `tableQuestion()` declares, and nothing may be added to it.
   *
   * *Reproduction:* `growable` in `TableField.tsx` back to
   * `question.addRows !== undefined` → `headerCells()` is 5.
   */
  it('draws no Aktionsspalte when the Startzeilen are already the Obergrenze', () => {
    render(
      <GridHarness
        question={tableQuestion({ rows: 20, addRows: { maxRows: 20 } })}
        onValue={vi.fn()}
      />,
    );

    expect(headerCells()).toBe(4);
    expect(screen.getAllByRole('row')[1]?.children).toHaveLength(4);
    expect(screen.queryByRole('button', { name: '+ Zeile' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Entfernen/ })).toBeNull();
  });

  it('leaves a Tabelle without „Zeilen ergänzbar" exactly as it was', () => {
    render(<GridHarness question={tableQuestion()} onValue={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '+ Zeile' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Entfernen/ })).toBeNull();
    expect(headerCells()).toBe(4);
  });

  it('adds an empty row and keeps what is already in the grid', () => {
    const onValue = vi.fn();
    render(<GridHarness question={growingTable()} onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Name, Zeile 1'), {
      target: { value: 'Anna' },
    });
    addRow();

    expect(onValue).toHaveBeenLastCalledWith({ cells: [{ name: 'Anna' }, {}] });
    expect(screen.getByLabelText<HTMLInputElement>('Name, Zeile 1').value).toBe(
      'Anna',
    );
    expect(screen.getByLabelText('Name, Zeile 2')).toBeDefined();
  });

  /**
   * **The button is *gone*, not greyed out.**
   *
   * `queryByRole` returning `null` is the whole assertion: a `disabled` button
   * would still be in the tree and would still pass a test that only checked
   * that clicking it does nothing. This is the form this application chose for every control
   * that stops being possible.
   */
  it('takes „+ Zeile" off the screen once the Obergrenze is reached', () => {
    render(<GridHarness question={growingTable(3)} onValue={vi.fn()} />);

    addRow();
    expect(screen.getByRole('button', { name: '+ Zeile' })).toBeDefined();

    addRow();
    expect(screen.getAllByLabelText(/^Name, Zeile/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '+ Zeile' })).toBeNull();
  });

  /**
   * **The middle row goes, the others stand unshifted.**
   *
   * Measured on the answer that leaves the browser as well as on the screen:
   * a removal that only emptied the row would leave `{}` in the middle of the
   * array and put a line the participant deleted into the evaluation.
   */
  it('removes the middle row without moving the values of the others', () => {
    const onValue = vi.fn();
    render(<GridHarness question={growingTable()} onValue={onValue} />);

    addRow();
    addRow();
    for (const [row, name] of [
      ['Zeile 1', 'Anna'],
      ['Zeile 2', 'Bert'],
      ['Zeile 3', 'Carla'],
    ] as const) {
      fireEvent.change(screen.getByLabelText(`Name, ${row}`), {
        target: { value: name },
      });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Entfernen: Zeile 2' }));

    expect(onValue).toHaveBeenLastCalledWith({
      cells: [{ name: 'Anna' }, { name: 'Carla' }],
    });
    expect(screen.getByLabelText<HTMLInputElement>('Name, Zeile 1').value).toBe(
      'Anna',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Name, Zeile 2').value).toBe(
      'Carla',
    );
    expect(screen.queryByLabelText('Name, Zeile 3')).toBeNull();
  });

  /**
   * **The stable identity, at the place where one notices it.**
   *
   * The stored answer stays a positional array, so the values above would come
   * out right even if React matched the rows by their index. What would not is
   * the row itself: with an index key React keeps the DOM rows 1 and 2 and
   * destroys row *3*, so the box somebody was typing in is the one that goes —
   * focus lands on `<body>`, and with it goes everything the DOM holds and
   * React does not (a text selection, an open dropdown, a half-composed word).
   *
   * The assertion is therefore the box itself: same element, still focused,
   * now called „Zeile 2". `fireEvent.click` does not move the focus in jsdom,
   * which is exactly what makes this measurable here.
   */
  it('moves the surviving rows rather than rebuilding them', () => {
    render(<GridHarness question={growingTable()} onValue={vi.fn()} />);

    addRow();
    addRow();
    const carla = screen.getByLabelText<HTMLInputElement>('Name, Zeile 3');
    fireEvent.change(carla, { target: { value: 'Carla' } });
    carla.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Entfernen: Zeile 2' }));

    expect(screen.getByLabelText('Name, Zeile 2')).toBe(carla);
    expect(document.activeElement).toBe(carla);
    expect(carla.value).toBe('Carla');
  });

  /**
   * The floor is what the form *offers*: the Startzeilen belong to the form,
   * the rows above them to the participant. `asTable` pads back up to
   * `question.rows`, so a removal below would undo itself on the next render.
   */
  it('offers no „Entfernen" while only the Startzeilen are there', () => {
    render(
      <GridHarness
        question={tableQuestion({ rows: 2, addRows: { maxRows: 4 } })}
        onValue={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /^Entfernen/ })).toBeNull();

    addRow();
    expect(screen.getAllByRole('button', { name: /^Entfernen/ })).toHaveLength(
      3,
    );
  });

  /**
   * **Checked with the finger.**
   *
   * The two gestures side by side and in one test on purpose: the mouse press
   * is the control. „+ Zeile" is added with the mouse and the row taken away
   * with a tap that carries no mouse event at all, so an implementation that
   * only listens to the mouse fails on the *second* half while the first stays
   * green — which is what tells „touch is locked out" from „the button is
   * broken".
   */
  it('adds and removes a row on a touch screen', () => {
    const onValue = vi.fn();
    render(<GridHarness question={growingTable()} onValue={onValue} />);

    pressWithMouse(screen.getByRole('button', { name: '+ Zeile' }));
    expect(onValue).toHaveBeenLastCalledWith({ cells: [{}, {}] });

    fireEvent.change(screen.getByLabelText('Name, Zeile 2'), {
      target: { value: 'Bert' },
    });
    tap(screen.getByRole('button', { name: 'Entfernen: Zeile 2' }));

    expect(onValue).toHaveBeenLastCalledWith({ cells: [{}] });
    expect(screen.queryByLabelText('Name, Zeile 2')).toBeNull();
  });

  /** And the other way round: the finger creates a row. */
  it('adds a row on a touch screen too', () => {
    const onValue = vi.fn();
    render(<GridHarness question={growingTable()} onValue={onValue} />);

    tap(screen.getByRole('button', { name: '+ Zeile' }));

    expect(onValue).toHaveBeenLastCalledWith({ cells: [{}, {}] });
  });
});

/* --- The Veranstaltung ---------------------------------------- */

const EVENT_ID = '019ff600-0000-7000-8000-0000000000e1';

function eventQuestion(): Question {
  return {
    id: EVENT_ID,
    type: 'event',
    label: 'Veranstaltungen',
    hint: null,
    required: false,
    width: 'full',
    events: [
      {
        key: 'sommerfest',
        label: 'Sommerfest',
        when: 'Fr, 19:00',
        capacity: 120,
        showRemaining: true,
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

/** The payload's seat states for the question above, as a lookup. */
function seatStates(
  entries: readonly PublicEventSeats[],
): ReadonlyMap<string, PublicEventSeats> {
  return new Map(entries.map((entry) => [entry.eventKey, entry]));
}

function EventHarness({
  seats,
  refusedEventKey,
  initial,
  onValue,
}: {
  readonly seats?: ReadonlyMap<string, PublicEventSeats>;
  readonly refusedEventKey?: string;
  readonly initial?: AnswerValue;
  readonly onValue?: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(initial);
  return (
    <FieldInput
      question={eventQuestion()}
      value={value}
      error={undefined}
      {...(seats === undefined ? {} : { eventSeats: seats })}
      {...(refusedEventKey === undefined ? {} : { refusedEventKey })}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

/**
 * **The Kachel per Veranstaltung** .
 *
 * What is asserted here is what a participant *sees and can touch*: the badge,
 * the lock, and the number that leaves the field. The rule behind the badge —
 * which figure may travel at all — is decided in `@formsache/shared`
 * (`publicEventSeats`) and measured there; jsdom cannot tell a payload that
 * withheld a number from one that never had one.
 *
 * ⚠️ **A locked box is not a limit.** Every case below is about comfort; the
 * Obergrenze is enforced in a transaction (`event-limit.spec.ts`) and holds for
 * a caller who never rendered this component.
 */
describe('FieldInput – Veranstaltung', () => {
  it('names the group with the question text and each box with its Veranstaltung', () => {
    render(<EventHarness />);

    expect(
      screen.getByRole('group', { name: 'Veranstaltungen' }),
    ).toBeDefined();
    // Explicit `aria-label`, so the Termin and the badge inside the same
    // `<label>` do not become part of the box's **name**.
    expect(screen.getByLabelText('Stadtfest: Anzahl Personen')).toBeDefined();
  });

  it('shows „Ausgebucht" and locks the empty box', () => {
    render(
      <EventHarness
        seats={seatStates([
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: true },
        ])}
      />,
    );

    expect(screen.getByText('Ausgebucht')).toBeDefined();
    expect(
      screen.getByLabelText<HTMLInputElement>('Stadtfest: Anzahl Personen')
        .disabled,
    ).toBe(true);
    // The other two are untouched — „ausgebucht" is a statement about one
    // Veranstaltung, never about the question.
    expect(
      screen.getByLabelText<HTMLInputElement>('Sommerfest: Anzahl Personen')
        .disabled,
    ).toBe(false);
  });

  /**
   * The state reachable by lowering an Obergrenze under the registrations
   * already taken: the tile says „ausgebucht" **and** holds this participant's
   * own number. Locking it would take away the one correction the requirement
   * promises always works.
   *
   * **The way *out* of the number is part of it.**
   * „Der Kasten ist leer" is not the same statement as „diese Person hat nichts
   * angemeldet": `withSeats` drops the entry for an empty box, for a `0` and for
   * every incomplete number in between, so somebody who selects their „3" and
   * presses Backspace to type „1" passes through exactly the state the lock used
   * to fire on — and the box would be disabled under their cursor until a
   * reload, which is the reduction the requirement promises, prevented by the other door.
   */
  it('leaves a full Veranstaltung editable while it holds a number', () => {
    const onValue = vi.fn();
    render(
      <EventHarness
        initial={{ seats: { stadtfest: 3 } }}
        seats={seatStates([
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: true },
        ])}
        onValue={onValue}
      />,
    );

    const box = screen.getByLabelText<HTMLInputElement>(
      'Stadtfest: Anzahl Personen',
    );
    expect(box.disabled).toBe(false);
    expect(box.value).toBe('3');

    // Backspace over the „3" — the box is empty for one render, and the answer
    // no longer carries the Veranstaltung at all.
    fireEvent.change(box, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith({ seats: {} });
    expect(box.disabled).toBe(false);

    // The same state spelled as a number: `0` is „nicht angemeldet" too.
    fireEvent.change(box, { target: { value: '0' } });
    expect(box.disabled).toBe(false);

    // …and the reduction the whole case is about actually goes through.
    fireEvent.change(box, { target: { value: '1' } });
    expect(onValue).toHaveBeenLastCalledWith({ seats: { stadtfest: 1 } });
    expect(box.value).toBe('1');
  });

  /**
   * The other way into the same trap, and the one the seat refresh of review
   * finding 2 opens up: the box was *not* full when the page loaded, somebody
   * typed a number into it, and the payload turned „ausgebucht" underneath them
   * (the re-read after a refused submission). Their number is still on screen
   * and still theirs to lower.
   */
  it('keeps a box editable that has held a number since it was loaded', () => {
    const { rerender } = render(
      <EventHarness
        seats={seatStates([
          {
            questionId: EVENT_ID,
            eventKey: 'stadtfest',
            full: false,
            remaining: 2,
          },
        ])}
      />,
    );

    const box = screen.getByLabelText<HTMLInputElement>(
      'Stadtfest: Anzahl Personen',
    );
    fireEvent.change(box, { target: { value: '5' } });

    rerender(
      <EventHarness
        seats={seatStates([
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: true },
        ])}
      />,
    );

    expect(screen.getByText('Ausgebucht')).toBeDefined();
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: '' } });
    expect(box.disabled).toBe(false);
  });

  it('shows the figure the payload sent, and nothing where it sent none', () => {
    render(
      <EventHarness
        seats={seatStates([
          {
            questionId: EVENT_ID,
            eventKey: 'sommerfest',
            full: false,
            remaining: 20,
          },
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: false },
        ])}
      />,
    );

    expect(screen.getByText('20 frei')).toBeDefined();
    // The Stadtfest's switch is off: no badge text at all, and — the sharper
    // half — no „frei" anywhere else on the tile either.
    expect(screen.queryByText(/frei$/)).toBe(screen.getByText('20 frei'));
  });

  it('marks the Veranstaltung the server refused, and only that one', () => {
    render(
      <EventHarness
        seats={seatStates([
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: true },
        ])}
        refusedEventKey="stadtfest"
      />,
    );

    expect(
      screen
        .getByLabelText('Stadtfest: Anzahl Personen')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      screen
        .getByLabelText('Sommerfest: Anzahl Personen')
        .getAttribute('aria-invalid'),
    ).toBe('false');
  });

  /**
   * The Personenzahl, and the single spelling of „nicht angemeldet": an empty
   * box and a `0` both **remove** the entry rather than storing a number
   * (`withSeats`, and `canonicalAnswerValue` from the other side).
   */
  it('stores a Personenzahl per Veranstaltung and drops a cleared box', () => {
    const onValue = vi.fn();
    render(<EventHarness onValue={onValue} />);

    fireEvent.change(screen.getByLabelText('Sommerfest: Anzahl Personen'), {
      target: { value: '3' },
    });
    expect(onValue).toHaveBeenLastCalledWith({ seats: { sommerfest: 3 } });

    fireEvent.change(
      screen.getByLabelText('Festzug / Umzug: Anzahl Personen'),
      {
        target: { value: '2' },
      },
    );
    expect(onValue).toHaveBeenLastCalledWith({
      seats: { sommerfest: 3, festzug: 2 },
    });

    fireEvent.change(screen.getByLabelText('Sommerfest: Anzahl Personen'), {
      target: { value: '' },
    });
    expect(onValue).toHaveBeenLastCalledWith({ seats: { festzug: 2 } });

    fireEvent.change(
      screen.getByLabelText('Festzug / Umzug: Anzahl Personen'),
      {
        target: { value: '0' },
      },
    );
    expect(onValue).toHaveBeenLastCalledWith({ seats: {} });
  });
});
