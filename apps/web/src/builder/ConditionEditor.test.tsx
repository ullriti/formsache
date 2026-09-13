import type { ReactElement } from 'react';
import type {
  FormDefinition,
  Question,
  QuestionCondition,
} from '@formsache/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBuilderStore } from './builder-store';
import { QuestionProperties } from './QuestionProperties';

/**
 * *Bedingte Anzeige* in the properties panel — the requirement.
 *
 * The one evaluation (`visibleQuestionIds`) is tested in
 * `packages/shared/src/condition.test.ts`; what belongs here is what only the
 * panel can be asked: which questions the picklist offers, which operators
 * follow the chosen source's type, that the store never holds a half-finished
 * condition, and that a condition pointing nowhere is shown as one.
 */

const PAGE_A = '019fe700-0000-7000-8000-0000000000a1';
const PAGE_B = '019fe700-0000-7000-8000-0000000000a2';
const INFO_ID = '019fe700-0000-7000-8000-0000000000b1';
const FIRST_NAME_ID = '019fe700-0000-7000-8000-0000000000b2';
const AGE_ID = '019fe700-0000-7000-8000-0000000000b3';
const ORG_QUESTION_ID = '019fe700-0000-7000-8000-0000000000b4';
const FILE_ID = '019fe700-0000-7000-8000-0000000000b5';
const TARGET_ID = '019fe700-0000-7000-8000-0000000000b6';
const LAST_NAME_ID = '019fe700-0000-7000-8000-0000000000b7';

/**
 * Two pages of questions ahead of `TARGET_ID` — one of every kind that
 * matters for picking a condition source: an excluded type (`info`), two
 * numeric-ish and text sources, a
 * choice source with its own options, another excluded type (`file`), and —
 * on a second page, **after** the target — a question that must never appear
 * as a source at all (the requirement: „eine vorherige Frage").
 */
function definition(): FormDefinition {
  return {
    pages: [
      {
        id: PAGE_A,
        title: 'Seite 1',
        description: null,
        questions: [
          {
            id: INFO_ID,
            label: 'Hinweis',
            hint: null,
            required: false,
            width: 'full',
            type: 'info',
          },
          {
            id: FIRST_NAME_ID,
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
            id: AGE_ID,
            label: 'Alter',
            hint: null,
            required: false,
            width: 'full',
            type: 'number',
            min: null,
            max: null,
            integer: true,
          },
          {
            id: ORG_QUESTION_ID,
            label: 'Organisation',
            hint: null,
            required: false,
            width: 'full',
            type: 'select',
            options: [
              { value: 'nord', label: 'Nord' },
              { value: 'sued', label: 'Süd' },
            ],
            allowOther: false,
            otherLabel: null,
          },
          {
            id: FILE_ID,
            label: 'Anhang',
            hint: null,
            required: false,
            width: 'full',
            type: 'file',
            maxFiles: 1,
          },
          {
            id: TARGET_ID,
            label: 'Kennzeichen',
            hint: null,
            required: false,
            width: 'full',
            type: 'text',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
      {
        id: PAGE_B,
        title: 'Seite 2',
        description: null,
        questions: [
          {
            id: LAST_NAME_ID,
            label: 'Nachname',
            hint: null,
            required: false,
            width: 'full',
            type: 'text',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}

/** Renders the panel bound to the live store question, like `BuilderView` does. */
function Harness({ id }: { readonly id: string }): ReactElement | null {
  const question = useBuilderStore((state) =>
    state.pages
      .flatMap((page) => page.questions)
      .find((entry) => entry.id === id),
  );
  if (question === undefined) {
    return null;
  }
  return <QuestionProperties question={question} />;
}

function storedQuestion(id: string): Question | undefined {
  return useBuilderStore
    .getState()
    .pages.flatMap((page) => page.questions)
    .find((entry) => entry.id === id);
}

function toggle(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('switch', {
    name: 'Bedingte Anzeige',
  });
}

function sourceSelect(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>('Frage');
}

function operatorSelect(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>('Bedingung');
}

function optionTexts(select: HTMLSelectElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);
}

beforeEach(() => {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: 'form-3',
    title: 'Testformular',
    definition: definition(),
    revision: 1,
  });
});

describe('QuestionProperties – Bedingte Anzeige ', () => {
  it('offers only earlier, answerable questions as Quellfrage — never info/file and never a later one', () => {
    render(<Harness id={TARGET_ID} />);

    fireEvent.click(toggle());

    expect(optionTexts(sourceSelect())).toStrictEqual([
      'Vorname',
      'Alter',
      'Organisation',
    ]);
  });

  it('disables the switch when no earlier, eligible question exists', () => {
    // `Vorname` itself has only the Infotext ahead of it, which is excluded
    // as a source — there is nothing to switch the toggle *on to*.
    render(<Harness id={FIRST_NAME_ID} />);

    expect(toggle().disabled).toBe(true);
  });

  it('writes a complete condition on toggle-on and the absent key on toggle-off', () => {
    render(<Harness id={TARGET_ID} />);

    fireEvent.click(toggle());
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'filled',
    });

    fireEvent.click(toggle());
    expect(storedQuestion(TARGET_ID)?.visibleIf).toBeUndefined();
  });

  it('changes the operator list with the type of the chosen source', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());

    // `Vorname` — free text without options: „enthält" is offered,
    // „größer/kleiner als" is not.
    expect(optionTexts(operatorSelect())).toStrictEqual([
      'ist gleich',
      'ist nicht',
      'ist ausgefüllt',
      'ist leer',
      'enthält',
    ]);

    fireEvent.change(sourceSelect(), { target: { value: AGE_ID } });
    // `Alter` — Zahl: „größer/kleiner als" appear, „enthält" does not.
    expect(optionTexts(operatorSelect())).toStrictEqual([
      'ist gleich',
      'ist nicht',
      'ist ausgefüllt',
      'ist leer',
      'größer als',
      'kleiner als',
    ]);

    fireEvent.change(sourceSelect(), { target: { value: ORG_QUESTION_ID } });
    // `Organisation` — Auswahl with options: neither „enthält" nor „größer/kleiner als".
    expect(optionTexts(operatorSelect())).toStrictEqual([
      'ist gleich',
      'ist nicht',
      'ist ausgefüllt',
      'ist leer',
    ]);
  });

  it('offers the source’s own options as the Vergleichswert for a choice source, defaulting to the first', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());
    fireEvent.change(sourceSelect(), { target: { value: ORG_QUESTION_ID } });
    fireEvent.change(operatorSelect(), { target: { value: 'equals' } });

    const value = screen.getByLabelText<HTMLSelectElement>('Vergleichswert');
    expect(optionTexts(value)).toStrictEqual(['Nord', 'Süd']);
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: ORG_QUESTION_ID,
      operator: 'equals',
      value: 'nord',
    });

    fireEvent.change(value, { target: { value: 'sued' } });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: ORG_QUESTION_ID,
      operator: 'equals',
      value: 'sued',
    });
  });

  it('keeps a typed Vergleichswert across a switch between value-carrying operators', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());
    fireEvent.change(operatorSelect(), { target: { value: 'equals' } });

    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: 'Klaus' },
    });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'equals',
      value: 'Klaus',
    });

    fireEvent.change(operatorSelect(), { target: { value: 'notEquals' } });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'notEquals',
      value: 'Klaus',
    });
  });

  it('renders no Vergleichswert control for „ist ausgefüllt"/„ist leer"', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());

    expect(screen.queryByLabelText('Vergleichswert')).toBeNull();

    fireEvent.change(operatorSelect(), { target: { value: 'empty' } });
    expect(screen.queryByLabelText('Vergleichswert')).toBeNull();
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'empty',
    });
  });

  /**
   * Review finding 1 of the conditional-visibility review, and the sharpest
   * of the six: the panel used to fill an empty Vergleichswert with a single
   * space so that *something* parsed. It parsed and meant the opposite —
   * „ist gleich ␣" over a Freitextquelle holds while the source is
   * **unanswered** (`equalsReading` trims both sides), so the question
   * appeared exactly when the editor's sentence said it should not. Nothing
   * on screen said so, and the form was publishable.
   *
   * *Reproduction*: switch to „ist gleich" and type nothing.
   */
  it('writes no condition while the Vergleichswert is still empty', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());
    fireEvent.change(operatorSelect(), { target: { value: 'equals' } });

    // The panel shows the picked operator and an empty box …
    expect(operatorSelect().value).toBe('equals');
    expect(
      screen.getByLabelText<HTMLInputElement>('Vergleichswert').value,
    ).toBe('');
    // … and says that this is not stored yet …
    //
    // Searched over the text and the **role** checked afterwards, not the
    // other way round: since Konzept no. 92 this panel carries a second
    // `role="status"` region (the announcement of the properties switches),
    // and `getByRole('status')` would find both. The role stays part of the
    // assertion — the sentence has to be announced, not merely stand there.
    const hint = screen.getByText(/erst gespeichert/u);
    expect(hint.getAttribute('role')).toBe('status');
    // … while the document keeps the last condition that parsed. Never a
    // placeholder value, and never an `equals` without one.
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'filled',
    });

    // A space is not a value either — that is the exact document the old
    // Vorgabewert produced.
    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: ' ' },
    });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'filled',
    });

    // Typing one commits, and the hint goes.
    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: 'Bahn' },
    });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'equals',
      value: 'Bahn',
    });
    // The hint is gone — what is asked for is *this* sentence, not "any
    // role=status": the announcement region of the properties switches stands
    // here unconditionally and is empty, and that is exactly as intended.
    expect(screen.queryByText(/erst gespeichert/u)).toBeNull();
  });

  it('keeps the last stored Vergleichswert when the box is emptied again', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());
    fireEvent.change(operatorSelect(), { target: { value: 'equals' } });
    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: 'Bahn' },
    });

    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: '' },
    });

    // The box is empty (the editor is retyping), the document is not.
    expect(
      screen.getByLabelText<HTMLInputElement>('Vergleichswert').value,
    ).toBe('');
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: FIRST_NAME_ID,
      operator: 'equals',
      value: 'Bahn',
    });
  });

  it('writes a numeric Vergleichswert for „größer als"/„kleiner als"', () => {
    render(<Harness id={TARGET_ID} />);
    fireEvent.click(toggle());
    fireEvent.change(sourceSelect(), { target: { value: AGE_ID } });
    fireEvent.change(operatorSelect(), { target: { value: 'greaterThan' } });

    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: AGE_ID,
      operator: 'greaterThan',
      value: 0,
    });

    fireEvent.change(screen.getByLabelText('Vergleichswert'), {
      target: { value: '18' },
    });
    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: AGE_ID,
      operator: 'greaterThan',
      value: 18,
    });
  });
});

/**
 * Review finding 2 of the conditional-visibility review: the panel used to
 * fall back to the *first* eligible question whenever the stored `questionId`
 * resolved to nothing, and then described that question as if the document
 * pointed at it — „Vorname, ist gleich, nord" over a condition naming a
 * question that had been deleted. The three ways to get there are ordinary
 * builder moves (delete the source, change its type, drag it behind the
 * dependant), the card carried the same „Bedingt" as a healthy question, and
 * the first word about it was a 422 at publish time naming a question the
 * panel had never shown.
 *
 * The builder still *allows* these states — an editor is mid-edit, and the
 * publish lock is a publish gate, not an edit gate. What it may not do is
 * show them as something else.
 */
describe('QuestionProperties – eine Bedingung, die ins Leere zeigt ', () => {
  function setCondition(condition: QuestionCondition): void {
    const question = storedQuestion(TARGET_ID);
    if (question === undefined) {
      throw new Error('Zielfrage fehlt im Store.');
    }
    useBuilderStore
      .getState()
      .updateQuestion(TARGET_ID, { ...question, visibleIf: condition });
  }

  it('shows no source at all — and never a substitute — once the Quellfrage is deleted', () => {
    setCondition({ questionId: FIRST_NAME_ID, operator: 'filled' });
    useBuilderStore.getState().deleteQuestion(FIRST_NAME_ID);

    render(<Harness id={TARGET_ID} />);

    // Nothing selected: the old fallback would show „Alter" here, the first
    // remaining candidate, which the document does not name.
    expect(sourceSelect().value).toBe('');
    expect(optionTexts(sourceSelect())).toStrictEqual([
      '(Quellfrage nicht auflösbar)',
      'Alter',
      'Organisation',
    ]);
    // No operator to show either — there is no source type to read it off.
    expect(screen.queryByLabelText('Bedingung')).toBeNull();

    // The sentence is the publish refusal's own (`unresolvableConditionMessage`
    // in `@formsache/shared`), so the panel says now what the 422 would say later.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Kennzeichen');
    expect(alert.textContent).toContain('fehlt in der neuen Fassung');
  });

  it('lets the editor repair it by picking another Quellfrage', () => {
    setCondition({ questionId: FIRST_NAME_ID, operator: 'filled' });
    useBuilderStore.getState().deleteQuestion(FIRST_NAME_ID);
    render(<Harness id={TARGET_ID} />);

    fireEvent.change(sourceSelect(), { target: { value: AGE_ID } });

    expect(storedQuestion(TARGET_ID)?.visibleIf).toStrictEqual({
      questionId: AGE_ID,
      operator: 'filled',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a Quellfrage that stands behind this question', () => {
    // `Nachname` sits on page 2, after the target — the state a drag produces.
    setCondition({ questionId: LAST_NAME_ID, operator: 'filled' });

    render(<Harness id={TARGET_ID} />);

    expect(sourceSelect().value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain(
      'steht erst nach dieser Frage',
    );
  });

  it('names a stored operator the source type does not offer, instead of an empty select', () => {
    // „enthält" over a Zahl — reachable by changing the source's type, which
    // `conditionOperatorsFor` then answers differently for.
    setCondition({ questionId: AGE_ID, operator: 'contains', value: 'Bahn' });

    render(<Harness id={TARGET_ID} />);

    // The select had no selected entry at all before: `condition.operator` is
    // not among the options a Zahl offers.
    expect(operatorSelect().value).toBe('contains');
    expect(optionTexts(operatorSelect())[0]).toContain('nicht verfügbar');
    expect(screen.getByRole('alert').textContent).toContain(
      'bietet diesen Vergleich nicht an',
    );
    // Nothing to compare with an operator that does not apply.
    expect(screen.queryByLabelText('Vergleichswert')).toBeNull();
  });
});
