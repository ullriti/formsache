import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import type { ResponseColumn } from '@formsache/shared';
import { RETIRED_COLUMN_NOTE, SUBMITTED_AT_COLUMN } from '@formsache/shared';

import { AttachmentLinks } from './AttachmentLinks';
import type { Row, SortState } from './response-rows';
import { ariaSortFor } from './response-rows';

/**
 * The Mehrfachauswahl of the requirement, as the table sees it.
 *
 * `undefined` when nobody may act on a selection: the only bulk action is
 * „Löschen", so a column of tick boxes without `canBuild` would be an
 * affordance leading nowhere — the same „hidden, not disabled" convention the
 * rest of this view follows for a control nobody may press.
 */
export interface RowSelection {
  /** Ids of the **rendered** rows that are ticked. */
  readonly selected: ReadonlySet<string>;
  readonly onToggleRow: (id: string, checked: boolean) => void;
  /** „alle" — over exactly the rows this table is rendering right now. */
  readonly onToggleAll: (checked: boolean) => void;
}

/**
 * The responses table (Handoff).
 *
 * ## Why the table owns its scroll box
 *
 * The card around the table is the scroll container in **both** axes. That is
 * what makes the sticky header actually stick: `position: sticky` follows the
 * nearest scrolling ancestor, so a table that leaves the sideways scrolling to
 * a wrapper and the vertical scrolling to the page ends up with a header that
 * scrolls away with everything else. It also keeps a form with thirty columns
 * from widening the page — the page body never scrolls
 * sideways, the card does.
 *
 * ## Mobile: still a table
 *
 * Below the breakpoint this stays a table that scrolls sideways, with the
 * first column pinned (see `responses-view.css`). A card-per-response list was
 * the obvious alternative and was rejected: reading one answer in full is what
 * the detail slide-in is for, while the table exists to *compare* answers
 * across rows — a stack of cards cannot do that at any width. Pinning the
 * identity column is what keeps the sideways scrolling usable on a phone,
 * because the row one is reading never loses its name.
 *
 * ## Retired columns say so, in words
 *
 * A column of a question that is no longer asked is
 * shown like any other and carries a note under its label. It has to be words
 * and not merely a paler heading: an empty cell in a newer row otherwise reads
 * as „nicht ausgefüllt", when what it means is „danach nicht mehr gefragt" —
 * two different statements, and only one of them is about the participant.
 *
 * The note sits **outside** the sort button on purpose. The button carries an
 * `aria-label`, which replaces everything nested inside it; putting the note
 * in the `<th>` instead makes it part of the header cell's accessible name, so
 * a screen reader announces it with the column rather than losing it.
 */
export function ResponsesTable({
  caption,
  columns,
  rows,
  sort,
  onSort,
  onOpen,
  selection,
}: {
  readonly caption: string;
  readonly columns: readonly ResponseColumn[];
  readonly rows: readonly Row[];
  readonly sort: SortState;
  readonly onSort: (key: string) => void;
  readonly onOpen: (row: Row) => void;
  /** Absent when nobody may delete — see {@link RowSelection}. */
  readonly selection?: RowSelection | undefined;
}): ReactElement {
  /*
   * **„alle" means the rows this table is rendering** — `rows` is what
   * `ResponsesView` has already filtered by the search, so a form of 400
   * answers under a search that leaves three cannot have „alle" tick 400. The
   * whole of the requirement's second part lives in this one word, and it
   * lives here rather than in the view because this is the component that knows
   * what is on screen.
   */
  const allSelected =
    selection !== undefined &&
    rows.length > 0 &&
    rows.every((row) => selection.selected.has(row.id));
  const someSelected =
    selection !== undefined &&
    rows.some((row) => selection.selected.has(row.id));

  return (
    <div className="responses__table-card">
      <table className="responses__table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {selection === undefined ? null : (
              <th scope="col" className="responses__th responses__th--select">
                <SelectAllBox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={(checked) => {
                    selection.onToggleAll(checked);
                  }}
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={
                  column.retired
                    ? 'responses__th responses__th--retired'
                    : 'responses__th'
                }
                // `aria-sort` belongs on the cell, not on the button: it is
                // what tells a screen reader which column is ordered and in
                // which direction. The ▲/▼ next to the label say the same
                // thing to everyone who can see it.
                aria-sort={ariaSortFor(sort, column.key)}
              >
                {/*
                  The header is a button because sorting is an action. A
                  clickable `<th>` is reachable by mouse only.
                */}
                <button
                  type="button"
                  className="responses__sort"
                  onClick={() => {
                    onSort(column.key);
                  }}
                  aria-label={`Nach ${column.label} sortieren`}
                >
                  <span className="responses__sort-label">{column.label}</span>
                  {/*
                    Every sortable column carries an indicator, not only the
                    active one: a faint ↕ is what says "this can be sorted" —
                    without it the affordance is invisible until after the
                    first click, which is the wrong way round.
                  */}
                  {sort.key === column.key ? (
                    <span className="responses__sort-icon" aria-hidden="true">
                      {sort.direction === 1 ? '▲' : '▼'}
                    </span>
                  ) : (
                    <span
                      className="responses__sort-icon responses__sort-icon--idle"
                      aria-hidden="true"
                    >
                      ↕
                    </span>
                  )}
                </button>
                {/*
                  The one wording, imported rather than retyped: the CSV header
                  writes „Telefon (nicht mehr gefragt)" from this very constant
                  (`form-history.ts`). The file and the screen saying the same
                  thing is worth more here than a phrasing tuned to each — and
                  the casing is left to CSS, which already sets the whole header
                  in upper case.
                */}
                {column.retired ? (
                  <span className="responses__retired">
                    {RETIRED_COLUMN_NOTE}
                  </span>
                ) : null}
              </th>
            ))}
            {/* The opener column carries no label anyone needs to read. */}
            <th scope="col" className="responses__th responses__th--open">
              <span className="visually-hidden">Einzelne Antwort</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="responses__row"
              // The whole row opens the slide-in, as the handoff describes it.
              // The chevron at the end is the same action for the keyboard, so
              // this click handler adds a shortcut and never the only way in.
              onClick={() => {
                onOpen(row);
              }}
            >
              {selection === undefined ? null : (
                /*
                  `stopPropagation`: the whole row opens the detail panel, and
                  ticking a box must not do that as well — a click that both
                  selects and opens a slide-in over the table is the one
                  interaction nobody can undo by clicking again.
                */
                <td
                  className="responses__select-cell"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <label className="responses__select">
                    <input
                      type="checkbox"
                      checked={selection.selected.has(row.id)}
                      onChange={(event) => {
                        selection.onToggleRow(row.id, event.target.checked);
                      }}
                    />
                    {/*
                      Named by the submission time rather than by „Antwort
                      auswählen" repeated per row: the timestamp is the one cell
                      every row has (`renderSchemalessRow` supplies it even for
                      a row whose version is missing), so the boxes differ from
                      one another in a list a screen reader reads out linearly.
                    */}
                    <span className="visually-hidden">
                      Antwort vom {row.cells[SUBMITTED_AT_COLUMN] ?? '—'}{' '}
                      auswählen
                    </span>
                  </label>
                </td>
              )}
              {columns.map((column) => {
                const files = row.attachments[column.key];
                return (
                  <td key={column.key}>
                    {/*
                    The truncation lives on an inner element because a `td`
                    ignores `max-width` under automatic table layout — a single
                    long free-text answer would otherwise stretch its column
                    across several screens. The full value is one click away in
                    the detail panel.

                    A Datei-Upload cell shows the same names the folded cell
                    holds, but **as links** : a cell of plain
                    text would make the attachment the one answer a reader can
                    see and not reach.
                  */}
                    <span className="responses__cell">
                      {files === undefined ? (
                        row.cells[column.key]
                      ) : (
                        <AttachmentLinks files={files} />
                      )}
                    </span>
                  </td>
                );
              })}
              {/*
                A column of its own rather than the first cell doubling as the
                opener. Hanging it on the first cell tied „open this response"
                to whichever column happened to be leftmost — hide that column
                in the field menu and the detail panel became unreachable —
                and it left an empty first cell with nothing to click at all.
              */}
              <td className="responses__open-cell">
                <button
                  type="button"
                  className="responses__open"
                  onClick={() => {
                    onOpen(row);
                  }}
                >
                  <span className="visually-hidden">Ansehen</span>
                  <span aria-hidden="true">›</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The header's „alle" box.
 *
 * A component of its own for one reason: `indeterminate` is a **property** of
 * the DOM node and not an attribute, so React cannot set it from JSX — the
 * half-tick that says „einige, nicht alle" has to be written through a ref
 * after every render. Without it the box would read „nichts ausgewählt" while
 * three rows are ticked, which is the one state the header is there to
 * describe.
 */
function SelectAllBox({
  checked,
  indeterminate,
  onChange,
}: {
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactElement {
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (boxRef.current !== null) {
      boxRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label className="responses__select">
      <input
        type="checkbox"
        ref={boxRef}
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {/*
        „sichtbare" is not decoration: with a search active the box ticks the
        rows on screen and not the organisation's whole answer table, and that is the
        difference the requirement calls the most expensive mistake of its stage.
      */}
      <span className="visually-hidden">
        Alle sichtbaren Antworten auswählen
      </span>
    </label>
  );
}
