import type { ReactElement } from 'react';
import type { FormDefinition, Question } from '@formsache/shared';
import { formDefinitionSchema, tableRowLimit } from '@formsache/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { selectedQuestion, useBuilderStore } from './builder-store';
import { QuestionCanvas } from './QuestionCanvas';
import { QuestionProperties } from './QuestionProperties';

/**
 * „Zeilen ergänzbar" in the editor — the requirement, Konzept no. 76.
 *
 * Everything here is measured on the **rendered** panel and the **rendered**
 * preview, never on a store call: the requirement is about what an editor sees
 * after ticking a box, and a test that wrote `addRows` into the store itself
 * would stay green with the checkbox unwired.
 */

type TableQuestion = Extract<Question, { type: 'table' }>;

const PAGE_ID = '019ff100-0000-7000-8000-0000000000a1';
const TABLE_ID = '019ff100-0000-7000-8000-0000000000b1';
const TEXT_ID = '019ff100-0000-7000-8000-0000000000b2';
const SECOND_TABLE_ID = '019ff100-0000-7000-8000-0000000000b3';
const SWAPPED_ID = '019ff100-0000-7000-8000-0000000000c1';
const SWAPPED_BACK_ID = '019ff100-0000-7000-8000-0000000000c2';

function tableQuestion(overrides: Partial<TableQuestion> = {}): TableQuestion {
  return {
    id: TABLE_ID,
    label: 'Begleitpersonen',
    hint: null,
    required: false,
    width: 'full',
    type: 'table',
    columns: [
      { key: 'spalte-1', label: 'Name', type: 'text' },
      { key: 'spalte-2', label: 'Organisation', type: 'text' },
    ],
    rows: 2,
    ...overrides,
  };
}

const textQuestion: Question = {
  id: TEXT_ID,
  label: 'Anreise',
  hint: null,
  required: false,
  width: 'full',
  type: 'text',
  minLength: null,
  maxLength: null,
  pattern: null,
};

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
function load(definitionToLoad: FormDefinition): void {
  useBuilderStore.getState().reset();
  useBuilderStore.getState().load({
    id: 'form-a3',
    title: 'Testformular',
    definition: definitionToLoad,
    revision: 1,
  });
  const first = definitionToLoad.pages[0]?.questions[0];
  if (first === undefined) {
    throw new Error('Das Testdokument hat keine Frage.');
  }
  useBuilderStore.getState().selectQuestion(first.id);
}

/** The only question the document has, as the store holds it **now**. */
function current(): Question {
  const question = useBuilderStore
    .getState()
    .pages.flatMap((page) => page.questions)[0];
  if (question === undefined) {
    throw new Error('Der Entwurf hat keine Frage mehr.');
  }
  return question;
}

/** The same question, narrowed — throws rather than silently asserting. */
function currentTable(): TableQuestion {
  const question = current();
  if (question.type !== 'table') {
    throw new Error(`Die Frage ist eine „${question.type}", keine Tabelle.`);
  }
  return question;
}

/**
 * Canvas and properties panel side by side — the pair `BuilderView` mounts,
 * so the preview reacts to the real control rather than to a store call.
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

function growthSwitch(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Zeilen ergänzbar');
}

function startRowsBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Startzeilen');
}

function rowLimitBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Obergrenze');
}

/** The „+ Zeile" button of the **preview**, or `null` when it is not drawn. */
function previewAddRow(): HTMLElement | null {
  return screen.queryByText('+ Zeile');
}

describe('die Live-Vorschau zeigt „+ Zeile"', () => {
  it('draws no „+ Zeile" while the switch is off', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    expect(growthSwitch().checked).toBe(false);
    expect(previewAddRow()).toBeNull();
    // …and there is no Obergrenze to type into either: „ergänzbar" and its
    // ceiling are one decision, and a box for a limit nobody can reach would
    // be half of a state `tableRowGrowthSchema` refuses to spell.
    expect(screen.queryByLabelText('Obergrenze')).toBeNull();
  });

  it('draws „+ Zeile" the moment „Zeilen ergänzbar" is ticked', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());

    expect(previewAddRow()).not.toBeNull();
    expect(currentTable().addRows).toStrictEqual({ maxRows: 20 });
  });

  it('takes the ceiling beside it from the Obergrenze, not from the Startzeilen', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    fireEvent.change(rowLimitBox(), { target: { value: '6' } });

    // Startzeilen 2, Obergrenze 6 — the two numbers differ, which is the only
    // arrangement in which reading the wrong one is visible at all.
    expect(currentTable().rows).toBe(2);
    expect(screen.getByText('bis 6 Zeilen')).toBeDefined();
  });

  /**
   * The state in which „ergänzbar" and „hier kommt ein Knopf" come apart: the
   * Obergrenze cannot exceed `TABLE_ROWS_MAX`, so a table that *starts* at
   * that many rows has no room left however the switch stands. The fill-in
   * view draws nothing there (`canAddTableRow`), and a preview that drew a
   * button anyway would promise a control no participant is ever offered.
   */
  it('draws no „+ Zeile" when the Obergrenze leaves no room', () => {
    load(definition(tableQuestion({ rows: 20 })));
    render(<Harness />);

    fireEvent.click(growthSwitch());

    expect(currentTable().addRows).toStrictEqual({ maxRows: 20 });
    expect(tableRowLimit(currentTable())).toBe(currentTable().rows);
    expect(previewAddRow()).toBeNull();
  });

  it('takes „+ Zeile" away again when the switch is turned off', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    expect(previewAddRow()).not.toBeNull();

    fireEvent.click(growthSwitch());

    expect(previewAddRow()).toBeNull();
    // **The key is gone, not present-and-undefined.** „Nicht ergänzbar" has
    // exactly one spelling (`form-schema.ts`); a second one would make a
    // switch turned on and off again report as something to publish.
    expect(Object.hasOwn(currentTable(), 'addRows')).toBe(false);
  });
});

describe('Startzeilen und Obergrenze', () => {
  it('carries the Obergrenze up when the Startzeilen pass it', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    fireEvent.change(rowLimitBox(), { target: { value: '3' } });
    expect(currentTable().addRows).toStrictEqual({ maxRows: 3 });

    fireEvent.change(startRowsBox(), { target: { value: '7' } });

    // A ceiling below the floor is a document `tableQuestionWithBounds`
    // refuses, so the alternative to carrying it up is a Startzeilen box that
    // silently stops working.
    expect(currentTable().rows).toBe(7);
    expect(currentTable().addRows).toStrictEqual({ maxRows: 7 });
    // The box shows the number that was written, not the one it was mounted
    // with — derived state is adjusted during render rather than remounted.
    expect(rowLimitBox().value).toBe('7');
  });

  it('leaves the Obergrenze alone when the Startzeilen stay below it', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    fireEvent.change(rowLimitBox(), { target: { value: '9' } });
    fireEvent.change(startRowsBox(), { target: { value: '4' } });

    expect(currentTable().addRows).toStrictEqual({ maxRows: 9 });
  });

  it('never commits an Obergrenze under the Startzeilen', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    fireEvent.change(rowLimitBox(), { target: { value: '9' } });
    fireEvent.change(startRowsBox(), { target: { value: '5' } });
    fireEvent.change(rowLimitBox(), { target: { value: '3' } });

    // The draft shows what was typed — the box is not fighting the keyboard —
    // but nothing below the Startzeilen reaches the document.
    expect(rowLimitBox().value).toBe('3');
    expect(currentTable().addRows).toStrictEqual({ maxRows: 9 });

    fireEvent.blur(rowLimitBox());
    expect(rowLimitBox().value).toBe('9');
  });

  it('never commits an Obergrenze above TABLE_ROWS_MAX', () => {
    load(definition(tableQuestion()));
    render(<Harness />);

    fireEvent.click(growthSwitch());
    fireEvent.change(rowLimitBox(), { target: { value: '5' } });
    fireEvent.change(rowLimitBox(), { target: { value: '25' } });

    expect(currentTable().addRows).toStrictEqual({ maxRows: 5 });
  });
});

/**
 * **The draft of the Obergrenze belongs to exactly one table.**
 *
 * „Obergrenze" is staged in a local `draft`, because typing „12" over a „3"
 * passes through „1" and a box that clamped every keystroke would swallow the
 * second digit. That draft is state of a *component*, and the properties panel
 * is one component for whichever question is selected — so without
 * `TableRowGrowth`'s `key={question.id}` the box is not remounted when the
 * selection moves, and the leftover text stays on screen over somebody else's
 * question.
 *
 * **The two tables below carry the same Obergrenze on purpose.** The derived
 * `shown !== maxRows` adjustment inside the field catches the case where the
 * numbers differ and hides the bug; with one number on both, the `key` is the
 * only thing standing between the draft and the next question. That is why the
 * existing tests in this file stayed green with the `key` deleted: none of them
 * had a second table at all.
 *
 * *Reproduction:* delete `key={question.id}` from `<TableRowGrowth>` in
 * `QuestionProperties.tsx` — the box shows „25" over the second table.
 */
describe('zwei Tabellen im selben Dokument', () => {
  function twoTables(): FormDefinition {
    return {
      pages: [
        {
          id: PAGE_ID,
          title: 'Seite 1',
          description: null,
          questions: [
            tableQuestion({ addRows: { maxRows: 8 } }),
            tableQuestion({
              id: SECOND_TABLE_ID,
              label: 'Gäste',
              addRows: { maxRows: 8 },
            }),
          ],
        },
      ],
    };
  }

  /** The table with this id, as the store holds it **now**. */
  function tableById(id: string): TableQuestion {
    const question = useBuilderStore
      .getState()
      .pages.flatMap((page) => page.questions)
      .find((candidate) => candidate.id === id);
    if (question?.type !== 'table') {
      throw new Error(`Im Entwurf steht keine Tabelle mit der ID ${id}.`);
    }
    return question;
  }

  /** Selects a question the way clicking its card does. */
  function select(id: string): void {
    act(() => {
      useBuilderStore.getState().selectQuestion(id);
    });
  }

  it('keeps an unconfirmed Obergrenze off the next Tabelle', () => {
    load(twoTables());
    render(<Harness />);

    // „25" is above TABLE_ROWS_MAX, so it stays a draft: the box shows what was
    // typed — it is not fighting the keyboard — and the document keeps its 8.
    fireEvent.change(rowLimitBox(), { target: { value: '25' } });
    expect(rowLimitBox().value).toBe('25');
    expect(tableById(TABLE_ID).addRows).toStrictEqual({ maxRows: 8 });

    select(SECOND_TABLE_ID);

    // The second table's own Obergrenze, and nothing of the first one's
    // half-typed number. Both are 8, so a box showing „25" here is showing text
    // that belongs to a question that is no longer selected.
    expect(rowLimitBox().value).toBe('8');
    expect(startRowsBox().value).toBe('2');
    expect(tableById(SECOND_TABLE_ID).addRows).toStrictEqual({ maxRows: 8 });
  });

  /**
   * And back again: the first table shows its **document** value again, not
   * the draft it was left with. A draft that survived the round trip would be
   * the same leak in the other direction.
   */
  it('shows the first Tabelle its stored Obergrenze on the way back', () => {
    load(twoTables());
    render(<Harness />);

    fireEvent.change(rowLimitBox(), { target: { value: '25' } });
    select(SECOND_TABLE_ID);
    select(TABLE_ID);

    expect(rowLimitBox().value).toBe('8');
  });
});

/**
 * **Legacy data stays readable** — the yield of the requirement.
 *
 * The document below is a **JSON text**, parsed at run time. A TypeScript
 * literal would be dragged along by the compiler the day `addRows` became
 * mandatory — it would simply grow the field and stay green — and would
 * therefore prove nothing about the documents already sitting in
 * `form.draft_schema`. This string is what a stored form without `addRows`
 * looks like.
 *
 * *Reproduction:* drop the `.optional()` from `addRows` in
 * `packages/shared/src/form-schema.ts` — the parse below fails and every test
 * in this block goes red, together with the equivalent legacy-form fixtures
 * across the repo.
 */
const M4_FORM_JSON = `{
  "pages": [
    {
      "id": "019fe700-0000-7000-8000-0000000000a1",
      "title": "Anmeldung",
      "description": null,
      "questions": [
        {
          "id": "019fe700-0000-7000-8000-0000000000b1",
          "label": "Begleitpersonen",
          "hint": null,
          "required": false,
          "width": "full",
          "type": "table",
          "columns": [
            { "key": "spalte-1", "label": "Name", "type": "text" },
            { "key": "spalte-2", "label": "Organisation", "type": "text" }
          ],
          "rows": 3
        }
      ]
    }
  ]
}`;

/** The stored document, parsed the way the API client parses a form. */
function m4Definition(): FormDefinition {
  return formDefinitionSchema.parse(JSON.parse(M4_FORM_JSON));
}

describe('ein älteres Formular ohne die neuen Felder', () => {
  it('parses, and its Tabelle is „nicht ergänzbar"', () => {
    load(m4Definition());
    const question = currentTable();

    expect(Object.hasOwn(question, 'addRows')).toBe(false);
    expect(question.rows).toBe(3);
    // The one number three sides of the wire read. Without `addRows` it is
    // the start row count — the fixed table this legacy form has.
    expect(tableRowLimit(question)).toBe(3);
  });

  it('shows the switch off and no „+ Zeile" in the preview', () => {
    load(m4Definition());
    render(<Harness />);

    expect(growthSwitch().checked).toBe(false);
    expect(previewAddRow()).toBeNull();
    expect(startRowsBox().value).toBe('3');
  });

  it('can be made ergänzbar without being re-entered', () => {
    load(m4Definition());
    render(<Harness />);

    fireEvent.click(growthSwitch());

    // The Obergrenze starts at the ceiling the schema allows anyway, so the
    // tick alone can never produce a document `formDefinitionSchema` refuses —
    // and an „ergänzbar" that grows nothing would be a switch with no effect.
    expect(currentTable().addRows).toStrictEqual({ maxRows: 20 });
    expect(currentTable().rows).toBe(3);
    expect(previewAddRow()).not.toBeNull();
  });
});

/**
 * What a **Typwechsel** does with `addRows`.
 *
 * `changeQuestionType` builds the successor from `baseForType` and carries
 * only `label`, `hint`, `required` and `width` across — every type-specific
 * field of the predecessor is dropped, `addRows` included. The one exception
 * is the revert of Konzept no. 24: switching back to the type the question had
 * when the document was loaded restores that question wholesale, so the
 * Obergrenze comes back with it.
 */
describe('der Typwechsel und „Zeilen ergänzbar"', () => {
  it('drops the Obergrenze when the Tabelle becomes something else', () => {
    load(definition(tableQuestion({ addRows: { maxRows: 8 } })));

    useBuilderStore.getState().changeQuestionType(TABLE_ID, 'text', SWAPPED_ID);

    expect(current().type).toBe('text');
    expect(Object.hasOwn(current(), 'addRows')).toBe(false);
  });

  it('gives it back when the type is switched **back**', () => {
    load(definition(tableQuestion({ addRows: { maxRows: 8 } })));

    useBuilderStore.getState().changeQuestionType(TABLE_ID, 'text', SWAPPED_ID);
    useBuilderStore
      .getState()
      .changeQuestionType(SWAPPED_ID, 'table', SWAPPED_BACK_ID);

    // The revert restores the *origin* question, which is what makes „als wäre
    // nichts geschehen" true for the Obergrenze as well as for the columns.
    expect(currentTable().addRows).toStrictEqual({ maxRows: 8 });
    expect(currentTable().id).toBe(TABLE_ID);
  });

  it('starts a freshly retyped Tabelle as „nicht ergänzbar"', () => {
    load(definition(textQuestion));

    useBuilderStore.getState().changeQuestionType(TEXT_ID, 'table', SWAPPED_ID);

    // The default of a new table is the handoff's fixed one — a type change
    // must not hand a participant a growing table nobody asked for.
    expect(Object.hasOwn(currentTable(), 'addRows')).toBe(false);
    expect(currentTable().rows).toBe(2);
  });
});
