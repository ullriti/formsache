import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import type {
  AnswerValue,
  TableColumn,
  TableCellValue,
  TableQuestion,
} from '@formsache/shared';
import { tableCanGrow } from '@formsache/shared';

import {
  addTableRow,
  asTable,
  canAddTableRow,
  canRemoveTableRow,
  removeTableRow,
  setTableCell,
} from './table-answer';

/**
 * Die Tabellen-Frage in der Ausfüllansicht.
 *
 * A component of its own rather than a branch in `FieldInput`'s `Control`
 * switch, for the reason `FileField` and `EventField` are: it has to remember
 * something across renders, and a `case` cannot hold a hook. What it remembers
 * is described at {@link useRowIds} — it is the whole point of the package.
 *
 * The prototype has this grid as **pure decoration**: its cells carry no
 * `value` and no handler at all. Every cell here is bound, and the
 * grid can also grow.
 */
export function TableField({
  question,
  value,
  onChange,
}: {
  readonly question: TableQuestion;
  readonly value: AnswerValue | undefined;
  readonly onChange: (value: AnswerValue) => void;
}): ReactElement {
  const answer = asTable(value, question);
  const { ids: rowIds, dropAt } = useRowIds(answer.cells.length);

  /**
   * What the live region below says.
   *
   * **Adding and removing a row changes how many fields there are** — the one
   * kind of change nobody notices who is not looking at it. Both buttons used
   * to be silent: „+ Zeile" grew the grid, „Entfernen" shrank it, and
   * the only feedback either gave was the grid itself. Somebody filling this in
   * by keyboard pressed „+ Zeile", heard nothing, and had no way of knowing
   * whether the press had landed short of tabbing forward to find out.
   *
   * **The count is part of the sentence, and that is not decoration.** A live
   * region that receives the *same* string twice announces it once: „Zeile
   * hinzugefügt" pressed twice in a row would be spoken once. The row number
   * and the new total make each announcement differ from the one before it,
   * which is what makes the second press audible at all.
   */
  const [announcement, setAnnouncement] = useState('');

  const canAdd = canAddTableRow(question, answer);
  const canRemove = canRemoveTableRow(question, answer);

  /*
   * Whether this question has a Zeilen-Spalte at all — asked at the *question*,
   * not at `canAdd`/`canRemove`.
   *
   * A column that comes and goes as rows are added would move the grid sideways
   * under the thumb it is being filled in with, so the answer must not enter
   * here. What does is {@link tableCanGrow}, and it is the **same** function the
   * Live-Vorschau asks: two views of one question that answered this
   * differently would be two forms.
   *
   * It excludes one more state than „`addRows` is set" does, and that state is
   * reachable: Startzeilen already at the Obergrenze (`rows: 20, maxRows: 20`).
   * There `canAdd` and `canRemove` are permanently `false`, so the column would
   * be an empty `<th>` over a column of empty `<td>`s — a grid one cell wider
   * for nothing. A table without `addRows` is the same state by another route
   * (its limit *is* its start row count), so nothing an older form renders changes.
   */
  const growable = tableCanGrow(question);

  return (
    <>
      <div className="field__scroll">
        <table className="field__grid">
          <thead>
            <tr>
              {question.columns.map((column) => (
                <th scope="col" key={column.key}>
                  {column.label}
                </th>
              ))}
              {growable ? (
                <th scope="col" className="field__grid-action" />
              ) : null}
            </tr>
          </thead>
          <tbody>
            {answer.cells.map((row, rowIndex) => (
              /*
                **The key is the row's own id, never `rowIndex`** — the one
                thing this component keeps state for.

                With an index key React matches the *positions*, so removing the
                middle of three rows keeps DOM rows 1 and 2 and destroys row 3:
                the surviving values are re-rendered into nodes that belonged to
                other rows, and the node the participant was typing in is the
                one that goes. Focus lands on `<body>`, and anything the DOM
                holds that React does not — a text selection, an open dropdown,
                a half-composed IME word — goes with it. With the id, React
                removes the row that was actually removed and moves the rest.
              */
              <tr key={rowIds[rowIndex]}>
                {question.columns.map((column) => (
                  <td key={column.key}>
                    <TableCell
                      column={column}
                      cell={row[column.key]}
                      // 1-based, because it is the row a participant counts
                      // — and the same number the export column is named
                      // after (`… (Zeile 2)`). It is the row's *position*,
                      // so it renumbers when a row above is removed, which
                      // is what somebody looking at the screen sees.
                      label={`${column.label}, Zeile ${String(rowIndex + 1)}`}
                      onChange={(cell) => {
                        onChange(
                          setTableCell(answer, rowIndex, column.key, cell),
                        );
                      }}
                    />
                  </td>
                ))}
                {growable ? (
                  <td className="field__grid-action">
                    {canRemove ? (
                      // Named per row, the way `FileField` names its button
                      // per file and for the same reason: a column of
                      // identical „Entfernen" buttons tells a screen reader
                      // nothing about which removes which. The visible word
                      // is contained in the name, so voice control still
                      // reaches it by „Entfernen" (WCAG 2.5.3).
                      <button
                        type="button"
                        className="field__row-remove"
                        aria-label={`Entfernen: Zeile ${String(rowIndex + 1)}`}
                        onClick={() => {
                          dropAt(rowIndex);
                          onChange(removeTableRow(answer, rowIndex));
                          setAnnouncement(
                            rowCountMessage(
                              `Zeile ${String(rowIndex + 1)} entfernt`,
                              answer.cells.length - 1,
                            ),
                          );
                        }}
                      >
                        Entfernen
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        **Gone at the Obergrenze, not greyed out**
        — the form this application chose for every control that stops being possible. A
        `disabled` button is a promise with no way to keep it: it says „hier
        ginge etwas" and answers no click, and on a touch screen it does not
        even carry a tooltip to explain itself.

        Outside `.field__scroll`, so it stays reachable on a narrow screen where
        the grid itself scrolls sideways. Its accessible name is the plain
        „+ Zeile": it sits inside the `role="group"` that carries the question
        text, which is the same thing that names the cells.
      */}
      {canAdd ? (
        <button
          type="button"
          className="field__row-add"
          onClick={() => {
            onChange(addTableRow(answer));
            setAnnouncement(
              rowCountMessage(
                `Zeile ${String(answer.cells.length + 1)} hinzugefügt`,
                answer.cells.length + 1,
              ),
            );
          }}
        >
          + Zeile
        </button>
      ) : null}

      {/*
        **Rendered unconditionally, empty until there is something to say** —
        the rule this application already follows for the builder's publish
        state: a `role="status"` element that only appears together with its
        text is frequently not announced at all, because the live region is new
        to the accessibility tree at the moment the text arrives.

        Inside the question's `role="group"` (`FieldInput` wraps every table
        in one), so the announcement belongs to *this* question rather than to
        whichever grid on the page was touched last — the same reasoning
        `QuestionCard` gives for one region per card instead of one per canvas.

        Gated on `growable` and **not** on `canAdd`/`canRemove`: those two swing
        with the answer — „+ Zeile" is gone at the Obergrenze, „Entfernen" at
        the Startzeilenzahl — so a region tied to either would vanish at exactly
        the moment it had something to report. `growable` is a property of the
        *question* and does not move while the grid is being filled in, which is
        what makes „the region was already there" true.
      */}
      {growable ? (
        <span className="visually-hidden" role="status">
          {announcement}
        </span>
      ) : null}
    </>
  );
}

/** „Zeile 3 hinzugefügt, 3 Zeilen" — the sentence both buttons announce with. */
function rowCountMessage(what: string, rows: number): string {
  return `${what}, ${String(rows)} ${rows === 1 ? 'Zeile' : 'Zeilen'}`;
}

/**
 * A stable identity per row, for as long as the row is on screen.
 *
 * **Local, and deliberately not on the wire.** The stored answer is a
 * positional array (`{ cells: [...] }`) and stays one — ids in the document
 * would be a change to every answer ever filed, on both sides of the wire, for
 * something only React needs. So the list is derived from the answer's row
 * *count* here and never travels.
 *
 * A ref rather than state, because nothing about it triggers a render: the
 * answer already does that. Reading and writing it while rendering is the
 * pointer-drag machinery's pattern in `builder/` (ADR-0002), and the
 * reconciliation below is idempotent, so a double-invoked render under
 * `StrictMode` produces the same list.
 *
 * **Appending is derivable, removing is not** — which is why only `dropAt`
 * exists. A longer answer can only have grown at the end, so the reconciliation
 * covers „+ Zeile", a draft loading with more rows than the form starts with,
 * and a version that raised the row count. A *shorter* one is ambiguous:
 * truncating from the end is right for „the form lost a row" and wrong for
 * „the participant removed the middle one", and nothing in the count says
 * which happened. The remove handler therefore says so itself.
 */
function useRowIds(count: number): {
  /** One id per row, in the answer's own order. */
  readonly ids: readonly string[];
  /** Forget the id at this position, because that row is being removed. */
  readonly dropAt: (index: number) => void;
} {
  const ids = useRef<string[]>([]);

  if (ids.current.length > count) {
    ids.current = ids.current.slice(0, count);
  }
  while (ids.current.length < count) {
    ids.current.push(freshRowId());
  }

  return {
    ids: ids.current,
    dropAt: (index: number) => {
      ids.current = ids.current.filter((_, position) => position !== index);
    },
  };
}

let rowIdCounter = 0;

/**
 * The next row id — unique within one grid, which is all a React key needs.
 *
 * A counter rather than `crypto.randomUUID()`: these never leave the browser,
 * never name anything a person or a server sees, and a readable `row-7` in the
 * React tree is worth more here than 128 bits of entropy nobody reads.
 */
function freshRowId(): string {
  rowIdCounter += 1;
  return `row-${String(rowIdCounter)}`;
}

/**
 * One table cell, in the shape its column's Zelltyp calls for.
 *
 * Every branch stores `undefined` for „leer" rather than `''`, `false` or
 * `null` — see {@link setTableCell} for what that single spelling buys.
 */
function TableCell({
  column,
  cell,
  label,
  onChange,
}: {
  readonly column: TableColumn;
  readonly cell: TableCellValue | undefined;
  readonly label: string;
  readonly onChange: (cell: TableCellValue | undefined) => void;
}): ReactElement {
  switch (column.type) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={cell === true}
          onChange={(event) => {
            onChange(event.target.checked ? true : undefined);
          }}
        />
      );

    case 'number':
      return (
        <input
          className="field__control"
          type="number"
          aria-label={label}
          value={typeof cell === 'number' ? cell : ''}
          onChange={(event) => {
            onChange(
              event.target.value === ''
                ? undefined
                : event.target.valueAsNumber,
            );
          }}
        />
      );

    case 'select':
      return (
        <select
          className="field__control"
          aria-label={label}
          value={typeof cell === 'string' ? cell : ''}
          onChange={(event) => {
            onChange(
              event.target.value === '' ? undefined : event.target.value,
            );
          }}
        >
          <option value="">—</option>
          {column.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );

    case 'text':
      return (
        <input
          className="field__control"
          aria-label={label}
          value={typeof cell === 'string' ? cell : ''}
          onChange={(event) => {
            onChange(
              event.target.value === '' ? undefined : event.target.value,
            );
          }}
        />
      );
  }
}
