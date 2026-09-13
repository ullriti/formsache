import type { ReactElement } from 'react';
import type { FormDefinition } from '@formsache/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { selectedQuestion, useBuilderStore } from './builder-store';
import { QuestionCanvas } from './QuestionCanvas';
import { QuestionProperties } from './QuestionProperties';

/**
 * The card's own mark for a *Bedingte Anzeige* — the requirement.
 *
 * The handoff's prototype has no such mark at all (`questionVisible` decides
 * silently); the requirement adds it in as many words, because an editor
 * who scrolls the canvas looking for a field missing from the fill-in view
 * has nothing else here to point at the reason. *Reproduction* named by the
 * requirement: remove the mark and this file is what goes red.
 */

const PAGE_ID = '019fe800-0000-7000-8000-0000000000a1';
const SOURCE_ID = '019fe800-0000-7000-8000-0000000000b1';
const PLAIN_ID = '019fe800-0000-7000-8000-0000000000b2';
const CONDITIONAL_ID = '019fe800-0000-7000-8000-0000000000b3';

function definition(): FormDefinition {
  return {
    pages: [
      {
        id: PAGE_ID,
        title: 'Seite 1',
        description: null,
        questions: [
          {
            id: SOURCE_ID,
            label: 'Anreise',
            hint: null,
            required: false,
            width: 'full',
            type: 'text',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            id: PLAIN_ID,
            label: 'Vorname',
            hint: null,
            required: false,
            width: 'full',
            type: 'text',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            id: CONDITIONAL_ID,
            label: 'Kennzeichen',
            hint: null,
            required: false,
            width: 'full',
            type: 'text',
            minLength: null,
            maxLength: null,
            pattern: null,
            visibleIf: { questionId: SOURCE_ID, operator: 'filled' },
          },
        ],
      },
    ],
  };
}

/**
 * The card carrying `label`, found by the card's own test hook rather than by
 * `closest('li')`: the tag is a layout choice, and a test that depends on it
 * breaks the day the card becomes something else. Review finding 6 of the
 * conditional-visibility review — the mark was the only new element without a
 * stable handle.
 */
function cardFor(label: string): HTMLElement {
  const card = screen
    .getByText(label)
    .closest<HTMLElement>('[data-testid="question-card"]');
  if (card === null) {
    throw new Error(`Keine Karte um „${label}" gefunden.`);
  }
  return card;
}

/** The condition mark of that card, or `null` when it carries none. */
function badgeOf(label: string): HTMLElement | null {
  return within(cardFor(label)).queryByTestId('question-condition-badge');
}

/**
 * Canvas and properties panel, side by side — the same pair `BuilderView`
 * mounts. Needed for the toggle-off case: the mark has to react to an edit
 * made through the real control (`ConditionEditor`'s switch), not to a raw
 * store call the store's own subscription might not have flushed into the
 * DOM before the next assertion runs.
 */
function Harness(): ReactElement {
  const selected = useBuilderStore(selectedQuestion);
  return (
    <>
      <QuestionCanvas />
      {selected === undefined ? null : (
        <QuestionProperties question={selected} />
      )}
    </>
  );
}

beforeEach(() => {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: 'form-4',
    title: 'Testformular',
    definition: definition(),
    revision: 1,
  });
});

/**
 * **A saved question can be opened without a mouse** (a review finding, WCAG 2.1.1 level A).
 *
 * `selectQuestion` hung on the `onClick` of the `<li>` alone, and the `<li>`
 * was neither focusable nor did it have a role. Whoever uses no mouse could
 * not get at the caption, the options, the required flag and the Bedingte
 * Anzeige of an **already saved** question — the properties only open for the
 * *selected* one.
 *
 * Why that stayed unnoticed for four milestones: on **creation** `addQuestion`
 * selects the new question itself, and `keyboard-flow.spec.ts` creates its
 * questions in the same case. The path an editor takes the day after —
 * open the form, edit an existing question — occurred in no case at all.
 *
 * *Counter-check:* make the type mark a `<span>` again → both cases below go
 * red, all the others of this file stay green.
 */
describe('QuestionCard – die Frage ist ohne Maus erreichbar', () => {
  function openerFor(label: string): HTMLElement {
    return within(cardFor(label)).getByRole('button', {
      name: /bearbeiten$/,
    });
  }

  it('öffnet eine gespeicherte Frage über die Tastatur', () => {
    render(<Harness />);

    // Starting situation: nothing selected — exactly the state after opening
    // a saved form.
    act(() => {
      useBuilderStore.getState().selectQuestion(null);
    });
    expect(useBuilderStore.getState().selectedQuestionId).toBeNull();

    const opener = openerFor('Vorname');
    opener.focus();
    // `keyDown` + `click`, as a browser triggers it on a `<button>`: what is
    // measured is that the keyboard arrives at the target, not that jsdom
    // synthesises events.
    fireEvent.keyDown(opener, { key: 'Enter' });
    fireEvent.click(opener);

    expect(useBuilderStore.getState().selectedQuestionId).toBe(PLAIN_ID);
  });

  it('steht in der Tab-Reihenfolge und sagt an, ob die Frage offen ist', () => {
    render(<Harness />);
    act(() => {
      useBuilderStore.getState().selectQuestion(null);
    });

    const opener = openerFor('Vorname');
    // **Not** `tabIndex={-1}`: an element that only takes focus
    // programmatically would pass `focus()` and still be unreachable by tab. A
    // `<button>` without `tabindex` stands in the order by definition — what
    // is checked is that none was added.
    expect(opener.tagName).toBe('BUTTON');
    expect(opener.getAttribute('tabindex')).toBeNull();
    expect(opener.hasAttribute('disabled')).toBe(false);

    expect(opener.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(opener);
    expect(openerFor('Vorname').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('QuestionCard – Kennzeichnung der Bedingten Anzeige', () => {
  it('marks a question that has a condition, and only that one', () => {
    render(<QuestionCanvas />);

    expect(badgeOf('Kennzeichen')?.textContent).toBe('Bedingt');
    expect(badgeOf('Vorname')).toBeNull();
    expect(badgeOf('Anreise')).toBeNull();
  });

  /**
   * The mark names its Quellfrage — review finding 6 of the conditional-visibility
   * review. „Bedingt"
   * alone tells an editor that *something* governs this card but not what,
   * so the reason for a missing field is still a hunt through the panel of
   * every question. The sentence is the badge's accessible name and its
   * tooltip, so it costs no space on the card.
   */
  it('names the Quellfrage and the comparison in its accessible name', () => {
    render(<QuestionCanvas />);

    expect(
      screen.getByRole('note', {
        name: 'Bedingt: zeigt nur, wenn „Anreise" ausgefüllt ist',
      }),
    ).toBeDefined();
  });

  /**
   * Review finding 2 of the conditional-visibility review: deleting the
   * Quellfrage leaves a condition pointing nowhere, and the card used to
   * carry the very same „Bedingt" as an intact one — the mark said „hier gibt
   * es eine Bedingung" where the truth was „hier gibt es eine Bedingung, die
   * das Veröffentlichen blockiert".
   */
  it('tells a dead condition apart from an intact one', () => {
    render(<QuestionCanvas />);
    // Through `act`, so the store's subscription has reached the DOM before
    // the assertion — the same reason the harness above exists.
    act(() => {
      useBuilderStore.getState().deleteQuestion(SOURCE_ID);
    });

    const badge = badgeOf('Kennzeichen');
    expect(badge?.textContent).toBe('Bedingt (Fehler)');
    expect(badge?.getAttribute('title')).toContain(
      'fehlt in der neuen Fassung',
    );
  });

  it('removes the mark once the condition is switched off in the properties panel', () => {
    render(<Harness />);
    expect(badgeOf('Kennzeichen')).not.toBeNull();

    // Selects the card, exactly as a click on it does in the real canvas —
    // the `<li>`'s own `onClick` (`QuestionCard.tsx`).
    fireEvent.click(cardFor('Kennzeichen'));
    fireEvent.click(screen.getByRole('switch', { name: 'Bedingte Anzeige' }));

    expect(badgeOf('Kennzeichen')).toBeNull();
  });
});

/** „⧉ Duplizieren" on the card's own head. */
describe('QuestionCard – Duplizieren', () => {
  /**
   * Cards after a duplicate can carry the same label twice (the copy starts
   * out identical to its original), so this reads titles off the cards in
   * DOM order rather than through `screen.getByText`, which would refuse to
   * pick one of two.
   */
  function cardLabelsInOrder(): (string | null | undefined)[] {
    return screen
      .getAllByTestId('question-card')
      .map((card) => card.querySelector('.q-card__title')?.textContent);
  }

  it('inserts a copy directly below the original, selected, on a click', () => {
    render(<QuestionCanvas />);
    const before = useBuilderStore.getState().selectedQuestionId;

    fireEvent.click(
      screen.getByRole('button', { name: 'Frage 2 duplizieren' }),
    );

    expect(cardLabelsInOrder()).toStrictEqual([
      'Anreise',
      'Vorname',
      'Vorname',
      'Kennzeichen',
    ]);
    const selected = useBuilderStore.getState().selectedQuestionId;
    expect(selected).not.toBe(before);
    expect(selected).not.toBe(PLAIN_ID);
    expect(selected).not.toBeNull();
  });

  it('leaves other questions and their conditions untouched by an unrelated duplicate', () => {
    render(<QuestionCanvas />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Frage 2 duplizieren' }),
    );

    // „Vorname" (Frage 2) was duplicated, not „Kennzeichen" — its own mark
    // must still be there, unaffected.
    expect(badgeOf('Kennzeichen')?.textContent).toBe('Bedingt');
  });
});

/**
 * What assistive technology actually reads off a subtree: the text of every
 * node **except** the ones hidden from the accessibility tree.
 *
 * Written out here rather than asserted through `aria-hidden` attributes,
 * because the attribute is the mechanism and the announced sentence is the
 * behaviour — a card that dropped the star and kept the word would still pass
 * this, which is the point.
 */
function announcedText(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? '';
    }
    if (!(node instanceof HTMLElement)) {
      return '';
    }
    if (node.getAttribute('aria-hidden') === 'true') {
      return '';
    }
    return [...node.childNodes].map(walk).join('');
  };
  return walk(root).replace(/\s+/g, ' ').trim();
}

/**
 * The Pflicht-Markierung of a card — **found during an accessibility review**
 * (`docs/worklog/2026-08-05-m4-g1-dod-durchlauf.md`).
 *
 * It hung on `aria-label` on a `<span>` without a role, which *ARIA in HTML*
 * forbids: an element with the `generic` role takes no accessible name, so a
 * screen reader is free to announce „Stern" or nothing at all. The run
 * measured it from the other side — `getByLabel('Pflichtfeld')` matched **two**
 * elements in the builder, the checkbox in the properties panel and this star,
 * and only the role told them apart.
 *
 * *Reproduction:* put the `aria-label` back on the star and the first case
 * below goes red on the second match.
 */
describe('QuestionCard – die Pflicht-Markierung (Fund 2)', () => {
  beforeEach(() => {
    const base = definition();
    // „Vorname" set to a required field — the others stay as they are, so
    // that the third case below has anything to tell apart at all.
    const shape: FormDefinition = {
      pages: base.pages.map((page) => ({
        ...page,
        questions: page.questions.map((question) =>
          question.id === PLAIN_ID ? { ...question, required: true } : question,
        ),
      })),
    };
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-4',
      title: 'Testformular',
      definition: shape,
      revision: 1,
    });
  });

  it('says „Pflichtfeld" in what the card announces, instead of a bare star', () => {
    render(<QuestionCanvas />);

    const announced = announcedText(cardFor('Vorname'));
    expect(announced).toContain('Vorname');
    expect(announced).toContain('Pflichtfeld');
    // The star itself is decoration and stays out of the announcement — the
    // rule `fill/FieldInput.tsx` follows for the same mark.
    expect(announced).not.toContain('*');
  });

  it('leaves „Pflichtfeld" as a label to exactly one control on the canvas', () => {
    render(<QuestionCanvas />);

    // Nothing on the canvas is *labelled* „Pflichtfeld" any more: the word is
    // text, and the only thing carrying it as a name is the checkbox in the
    // properties panel, which this render does not mount.
    expect(screen.queryAllByLabelText('Pflichtfeld')).toHaveLength(0);
  });

  it('marks only the question that is required', () => {
    render(<QuestionCanvas />);

    expect(announcedText(cardFor('Anreise'))).not.toContain('Pflichtfeld');
    expect(announcedText(cardFor('Kennzeichen'))).not.toContain('Pflichtfeld');
  });
});
