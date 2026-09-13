import { formDefinitionSchema, type FormDefinition } from '@formsache/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBuilderStore } from './builder-store';
import { PageList } from './PageList';
import { QuestionCanvas } from './QuestionCanvas';

/**
 * Switching pages and renaming them — two gestures that used to be one.
 *
 * Reported: „Seitenwechsel funktioniert nur durch den Klick auf den
 * Seitentitel, dadurch wechselt das Feld aber immer gleich in den
 * Editiermodus." The row carried a text input, so the only part of it that
 * reacted to a click was the one part that also started renaming.
 *
 * The prototype settles it (design-handoff, page list): the row *is* the
 * switch, and the page title is edited in the canvas header. These tests hold
 * both halves of that split in place.
 */

const P1 = '019fe100-0000-7000-8000-0000000000c1';
const P2 = '019fe100-0000-7000-8000-0000000000c2';
const P3 = '019fe100-0000-7000-8000-0000000000c3';

function definition(): FormDefinition {
  return formDefinitionSchema.parse({
    pages: [
      { id: P1, title: 'Stammdaten', questions: [] },
      { id: P2, title: 'Veranstaltungen', questions: [] },
      { id: P3, title: 'Abschluss', questions: [] },
    ],
  });
}

function activeIndex(): number {
  return useBuilderStore.getState().activePageIndex;
}

/** The row's switch — named by its title and its position, like the handoff. */
function row(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('page list', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-1',
      title: 'Testformular',
      definition: definition(),
      revision: 1,
    });
  });

  it('switches the page on a click anywhere on the row', () => {
    render(<PageList />);

    fireEvent.click(row(/Veranstaltungen/u));

    expect(activeIndex()).toBe(1);
  });

  /**
   * The reported bug itself: the title is text, not a field. Clicking it
   * switches the page like the rest of the row and starts no rename.
   */
  it('switches the page on a click on the title, without renaming', () => {
    render(<PageList />);

    fireEvent.click(screen.getByText('Abschluss'));

    expect(activeIndex()).toBe(2);
    expect(screen.queryByLabelText(/^Titel von/u)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /**
   * The row's own controls keep their own effect. A delete that also switched
   * to the page it just removed would be the same conflation in the other
   * direction — so the deleted row is *not* the active one, and the page being
   * edited has to survive the index shift underneath it.
   */
  it('deletes from a row without changing which page is edited', () => {
    useBuilderStore.getState().selectPage(2);
    render(<PageList />);

    fireEvent.click(screen.getByRole('button', { name: 'Seite 2 löschen' }));

    const state = useBuilderStore.getState();
    expect(state.pages.map((page) => page.id)).toStrictEqual([P1, P3]);
    expect(state.pages[state.activePageIndex]?.title).toBe('Abschluss');
  });

  /**
   * Operable without a mouse, and without nesting one control inside another:
   * grip, switch and delete are siblings in the row, so the switch is a real
   * `<button>` a browser activates with Enter and Space by itself.
   */
  it('exposes the switch as a focusable button of its own', () => {
    render(<PageList />);

    const item = row(/Veranstaltungen/u);
    expect(item.tagName).toBe('BUTTON');
    expect(within(item).queryByRole('button')).toBeNull();

    item.focus();
    expect(document.activeElement).toBe(item);
  });

  it('marks the active row for assistive technology', () => {
    render(<PageList />);

    expect(row(/Stammdaten/u).getAttribute('aria-current')).toBe('page');
    expect(row(/Abschluss/u).getAttribute('aria-current')).toBeNull();
  });

  /**
   * Renaming, where the prototype puts it: the page title of the canvas
   * header. It is a deliberate second gesture — the editor switches to the
   * page and edits its title there — instead of a side effect of aiming at the
   * row.
   */
  it('renames the active page from the canvas header', () => {
    useBuilderStore.getState().selectPage(1);
    render(<QuestionCanvas />);

    fireEvent.change(screen.getByLabelText('Titel von Seite 2'), {
      target: { value: 'Sommerfest' },
    });

    expect(useBuilderStore.getState().pages[1]?.title).toBe('Sommerfest');
    expect(useBuilderStore.getState().isDirty).toBe(true);
  });
});
