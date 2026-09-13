import type { Question } from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FillIn, type FillInForm, type SubmitController } from './FillIn';

/**
 * **The page change is announced, and the focus goes with it** .
 *
 * Two assertions, **separate**: the announcement and the focus. A single
 * line about both would be too coarse — the decision consists of two halves,
 * and an implementation that only announces has to go red here without the
 * announcement line going with it.
 *
 * What is measured is what lands in the accessibility tree: the `role="status"`
 * region and `document.activeElement`. No class, no colour — `public__page-title`
 * is font size, and `public__page-progress-fill` is a filled area.
 * A screen reader sees neither.
 *
 * The pages are deliberately named differently **and** carry their number in the
 * announced sentence: a live region speaks the same text only once, and the
 * third case below hangs on exactly that.
 */

const PAGE_ONE = '019ff900-0000-7000-8000-0000000000a1';
const PAGE_TWO = '019ff900-0000-7000-8000-0000000000a2';
const FIRST_QUESTION = '019ff900-0000-7000-8000-0000000000b1';
const SECOND_QUESTION = '019ff900-0000-7000-8000-0000000000b2';

function textQuestion(id: string, label: string): Question {
  return {
    id,
    label,
    hint: null,
    // Nothing is mandatory: „Weiter" must not get stuck on a validation at
    // this point, otherwise the case does not measure the change at all.
    required: false,
    width: 'full',
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function twoPageForm(): FillInForm {
  return {
    title: 'Jahrestagung 2026',
    display: {
      showProgress: true,
      showPageNumbers: true,
      showRequiredHint: false,
    },
    eventSeats: [],
    definition: {
      pages: [
        {
          id: PAGE_ONE,
          title: 'Mitgliedschaft',
          description: null,
          questions: [textQuestion(FIRST_QUESTION, 'Organisation')],
        },
        {
          id: PAGE_TWO,
          title: 'Verpflegung',
          description: null,
          questions: [textQuestion(SECOND_QUESTION, 'Unverträglichkeiten')],
        },
      ],
    },
  };
}

const idleSubmit: SubmitController = {
  isPending: false,
  isError: false,
  error: undefined,
  mutate: vi.fn(),
};

/**
 * The form's live region — **looked up by role, never by text**.
 *
 * `getByText('Seite 2 von 2')` would stay green if the sentence stood in a mute
 * `<span>`; the assertion would then be one about the screen output,
 * which exists here anyway (`showPageNumbers`).
 */
function liveRegion(): HTMLElement {
  return screen.getByRole('status');
}

describe('Seitenwechsel beim Ausfüllen – die Ansage ', () => {
  it('meldet die neue Seite in einer role="status"-Region, die vorher schon da ist', () => {
    render(<FillIn form={twoPageForm()} submit={idleSubmit} />);

    // **There beforehand and empty.** A live region that comes into being only
    // together with its text is new in the accessibility tree when the text arrives — and is
    // then often not announced at all. Without this line the rest would also be green for
    // a region nobody hears.
    expect(liveRegion().textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(
      liveRegion().textContent,
      'Nach „Weiter" muss der Wechsel angesagt werden. Der Fortschrittsbalken ' +
        'trägt zwar aria-valuetext, ist aber keine Live-Region: er sagt seinen ' +
        'Stand nur, wer ihn anfährt.',
    ).toBe('Seite 2 von 2 · Verpflegung');

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

    expect(
      liveRegion().textContent,
      '„Zurück" gehört genauso dazu — der Weg zurück ist derselbe Wechsel.',
    ).toBe('Seite 1 von 2 · Mitgliedschaft');
  });

  it('sagt beim erneuten Wechsel auf dieselbe Seite einen anderen Satz als zuletzt', () => {
    render(<FillIn form={twoPageForm()} submit={idleSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const first = liveRegion().textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    const between = liveRegion().textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const second = liveRegion().textContent;

    /*
      **The live-region trap.** The same text twice in a row is not spoken
      the second time. Here the text changes at every
      step, because it carries the page number — `first` and `second` are
      equal, but `between` lies in between, so every announcement differs from its
      **predecessor**. An announcement without a number („die Seite hat
      gewechselt") would be the same sentence three times and mute twice.
    */
    expect(first).not.toBe(between);
    expect(between).not.toBe(second);
  });
});

describe('Seitenwechsel beim Ausfüllen – der Fokus ', () => {
  it('setzt den Fokus auf die Überschrift der neuen Seite', () => {
    render(<FillIn form={twoPageForm()} submit={idleSubmit} />);

    // On opening **nothing** is focused: nothing has changed, and a
    // jump to the heading would displace the entry into the form.
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    const heading = screen.getByRole('heading', {
      name: 'Verpflegung',
      level: 2,
    });
    expect(
      document.activeElement,
      'Ohne den Fokuswechsel steht der Bedienende weiter am Knopf der alten ' +
        'Seite und muss sich selbst zum neuen Inhalt tabben.',
    ).toBe(heading);
  });

  it('nimmt den Fokus auch auf dem Weg zurück mit', () => {
    render(<FillIn form={twoPageForm()} submit={idleSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Mitgliedschaft', level: 2 }),
    );
  });

  it('hält die Überschrift aus der Tab-Reihenfolge heraus', () => {
    render(<FillIn form={twoPageForm()} submit={idleSubmit} />);

    // `-1`, not `0`: focusable on demand, but not a station nobody has
    // headed for — on every page of every form.
    expect(
      screen
        .getByRole('heading', { name: 'Mitgliedschaft', level: 2 })
        .getAttribute('tabindex'),
    ).toBe('-1');
  });
});
