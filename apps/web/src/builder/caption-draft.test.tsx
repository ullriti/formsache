import type { ReactElement } from 'react';
import type { Question, QuestionType } from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBuilderStore } from './builder-store';
import { createQuestion } from './question-defaults';
import { QuestionProperties } from './QuestionProperties';

/**
 * **Review finding 22: text fields could not be emptied completely.**
 *
 * Every field of the properties panel is controlled out of the store, and the
 * store only accepted what `questionSchema` let through. For every mandatory
 * caption `safeParse` therefore failed at exactly the **last** character: the
 * store stayed put, React drew the old value back, and the field snapped back.
 * A question text could not be rewritten because it could not be deleted.
 *
 * Every test here makes the same three measurements on one of the affected
 * fields, and all three are necessary:
 *
 * 1. **The field stays empty** — the regression evidence. Before, the old text
 *    stood in it again immediately after deleting.
 * 2. **The document keeps the old caption** — the emptiness is an intermediate
 *    state of the editing, not a state of the form. A test that only checked
 *    (1) would stay green if somebody removed `min(1)` from the shared schema
 *    and the form were saved with an empty question text.
 * 3. **Typing on arrives** — the actual purpose: delete and rewrite.
 */

const PAGE_ID = '019fe700-0000-7000-8000-0000000000a1';
const QUESTION_ID = '019fe700-0000-7000-8000-0000000000b1';

function loadWith(question: Question): void {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: 'form-caption',
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

/** The question as it stands in the store — never the one that was rendered. */
function stored(): Question {
  const question = useBuilderStore
    .getState()
    .pages.flatMap((page) => page.questions)
    .find((entry) => entry.id === QUESTION_ID);
  if (question === undefined) {
    throw new Error('Frage nicht im Store');
  }
  return question;
}

/** The panel bound to the store's live question, as `BuilderView` renders it. */
function Panel(): ReactElement | null {
  const question = useBuilderStore((state) =>
    state.pages
      .flatMap((page) => page.questions)
      .find((entry) => entry.id === QUESTION_ID),
  );
  return question === undefined ? null : (
    <QuestionProperties question={question} />
  );
}

function of(type: QuestionType): Question {
  return createQuestion(type, QUESTION_ID);
}

/**
 * Empties the field and checks the three measurements above.
 *
 * A helper function, because six hand-written versions of the same sequence are
 * exactly the construction in which one of them forgets one of the three
 * measurements — and that would be the one that no longer catches the finding.
 */
function expectsClearable(
  fieldLabel: string,
  captionBefore: string,
  read: () => string,
): void {
  const box = screen.getByLabelText<HTMLInputElement>(fieldLabel);
  expect(box.value).toBe(captionBefore);

  fireEvent.change(box, { target: { value: '' } });

  // (1) The field stays empty — no snapping back.
  expect(screen.getByLabelText<HTMLInputElement>(fieldLabel).value).toBe('');
  // (2) The document still carries the old caption.
  expect(read()).toBe(captionBefore);
  // And it says that nothing is being written right now — on the box itself,
  // not just somewhere on the page.
  const marked = screen.getByLabelText<HTMLInputElement>(fieldLabel);
  expect(marked.getAttribute('aria-invalid')).toBe('true');
  const messageId = marked.getAttribute('aria-describedby');
  expect(messageId).not.toBeNull();
  expect(document.getElementById(messageId ?? '')?.textContent ?? '').toContain(
    'Ohne Text wird nichts gespeichert',
  );

  // (3) Typing on arrives, character by character.
  fireEvent.change(screen.getByLabelText(fieldLabel), {
    target: { value: 'N' },
  });
  expect(read()).toBe('N');
  fireEvent.change(screen.getByLabelText(fieldLabel), {
    target: { value: 'Ne' },
  });
  expect(read()).toBe('Ne');
  expect(
    screen
      .getByLabelText<HTMLInputElement>(fieldLabel)
      .getAttribute('aria-invalid'),
  ).toBe('false');
}

describe('Eigenschaften-Panel – Pflicht-Beschriftungen lassen sich leeren', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
  });

  it('Fragetext', () => {
    loadWith({ ...of('text'), label: 'Name' });
    render(<Panel />);

    expectsClearable('Fragetext', 'Name', () => stored().label);
  });

  it('Option einer Auswahl', () => {
    const question = of('select');
    loadWith(question);
    render(<Panel />);

    const first = question.type === 'select' ? question.options[0] : undefined;
    expectsClearable('Option 1', first?.label ?? '', () => {
      const current = stored();
      return current.type === 'select' ? (current.options[0]?.label ?? '') : '';
    });

    // The option's value has not moved in the process — the answers already
    // given and the column in the export hang on it.
    const current = stored();
    expect(current.type === 'select' ? current.options[0]?.value : null).toBe(
      first?.value,
    );
  });

  it('Zeile einer Matrix', () => {
    loadWith(of('matrix'));
    render(<Panel />);

    expectsClearable('Zeilen (Aussagen) 1', 'Organisation', () => {
      const current = stored();
      return current.type === 'matrix' ? (current.rows[0]?.label ?? '') : '';
    });
  });

  it('Spalte einer Matrix', () => {
    loadWith(of('matrix'));
    render(<Panel />);

    expectsClearable('Spalten (Skala) 1', 'Sehr gut', () => {
      const current = stored();
      return current.type === 'matrix' ? (current.columns[0]?.label ?? '') : '';
    });
  });

  it('Spalte einer Tabelle', () => {
    loadWith(of('table'));
    render(<Panel />);

    expectsClearable('Spalte 1', 'Spalte 1', () => {
      const current = stored();
      return current.type === 'table' ? (current.columns[0]?.label ?? '') : '';
    });
  });

  it('Bezeichnung einer Veranstaltung', () => {
    loadWith(of('event'));
    render(<Panel />);

    expectsClearable('Veranstaltung 1', 'Veranstaltung 1', () => {
      const current = stored();
      return current.type === 'event' ? (current.events[0]?.label ?? '') : '';
    });
  });

  /**
   * The special case of the finding: `otherLabel` is `nullable()`, so “empty”
   * is a **real** value there and not an intermediate state — all that was
   * missing was the mapping `'' → null`, at which `min(1)` failed. No draft, no
   * error message; the form then shows „Sonstiges" (`otherLabelOf`).
   */
  it('Beschriftung für „Sonstiges“ – leer heißt null, nicht abgelehnt', () => {
    const base = of('select');
    if (base.type !== 'select') {
      throw new Error('createQuestion lieferte keinen Auswahltyp');
    }
    loadWith({ ...base, allowOther: true, otherLabel: 'Anderes' });
    render(<Panel />);

    const box = screen.getByLabelText<HTMLInputElement>(
      'Beschriftung für „Sonstiges“',
    );
    fireEvent.change(box, { target: { value: '' } });

    expect(
      screen.getByLabelText<HTMLInputElement>('Beschriftung für „Sonstiges“')
        .value,
    ).toBe('');
    const current = stored();
    expect(
      current.type === 'select' ? current.otherLabel : 'nicht select',
    ).toBe(null);
  });

  /**
   * The draft belongs to **this** question.
   *
   * The panel is not rebuilt per question (`BuilderView` renders it without a
   * `key`), so a half-deleted question text would otherwise go on standing at
   * the next selected question — and with it the error message over a field at
   * which nobody has deleted anything.
   *
   * ⚠️ **Both questions are called „Name", and that is the whole test**
   * (review follow-up). With *different* texts the reset in `useCaptionDraft`
   * already takes hold — the store carries a different value, so the draft ends
   * of its own accord, and the `key` on the field would be uninvolved. That is
   * exactly the case its comment in `QuestionProperties.tsx` names: „zwei
   * Fragen mit gleichem Text". The sister test for the options below is built
   * the same way for the same reason.
   */
  it('nimmt einen halb gelöschten Fragetext nicht zur gleichnamigen nächsten Frage mit', () => {
    const other = '019fe700-0000-7000-8000-0000000000b2';
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-caption',
      title: 'Testformular',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [
              { ...createQuestion('text', QUESTION_ID), label: 'Name' },
              { ...createQuestion('text', other), label: 'Name' },
            ],
          },
        ],
      },
      revision: 1,
    });

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

    const view = render(<Switcher id={QUESTION_ID} />);
    fireEvent.change(screen.getByLabelText('Fragetext'), {
      target: { value: '' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Fragetext').value).toBe('');

    view.rerender(<Switcher id={other} />);

    expect(screen.getByLabelText<HTMLInputElement>('Fragetext').value).toBe(
      'Name',
    );
    expect(
      screen
        .getByLabelText<HTMLInputElement>('Fragetext')
        .getAttribute('aria-invalid'),
    ).toBe('false');
  });

  /**
   * The same for the **lists** below it — and there it is the sharper case
   * (review follow-up).
   *
   * The rows are keyed by `option.value`, and `question-defaults.ts` hands out
   * these values deterministically: **every** new select starts with
   * `option-1` / „Option 1". Two select questions therefore have the same key
   * *and* the same text row by row — the reset of `useCaptionDraft` sees no
   * difference and would not take hold. What does take hold is the `key` on
   * `TypeSpecific`.
   */
  it('nimmt eine halb gelöschte Option nicht zur nächsten Frage mit', () => {
    const other = '019fe700-0000-7000-8000-0000000000b3';
    useBuilderStore.getState().reset();
    useBuilderStore.getState().load({
      id: 'form-caption',
      title: 'Testformular',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Seite 1',
            description: null,
            questions: [
              createQuestion('select', QUESTION_ID),
              createQuestion('select', other),
            ],
          },
        ],
      },
      revision: 1,
    });

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

    const view = render(<Switcher id={QUESTION_ID} />);
    const before = screen.getByLabelText<HTMLInputElement>('Option 1').value;
    fireEvent.change(screen.getByLabelText('Option 1'), {
      target: { value: '' },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Option 1').value).toBe('');

    view.rerender(<Switcher id={other} />);

    const carried = screen.getByLabelText<HTMLInputElement>('Option 1');
    expect(carried.value).toBe(before);
    expect(carried.getAttribute('aria-invalid')).toBe('false');
  });
});
