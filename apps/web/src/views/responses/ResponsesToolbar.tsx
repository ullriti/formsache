import type { ReactElement } from 'react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { ResponseColumn } from '@formsache/shared';
import { RETIRED_COLUMN_NOTE } from '@formsache/shared';

import { useDismiss } from './use-dismiss';

/**
 * Toolbar of the responses view (Handoff): full-text search, a reset while
 * a term is active, the row count and the „⚙ Felder" column menu.
 *
 * The column menu is a **popover** anchored to the toolbar, as the prototype
 * draws it — an inline block would push the table down every time somebody
 * looks at the column list. It is anchored to the toolbar rather than to its
 * own button so its right edge can never leave the viewport: below the
 * breakpoint the button wraps into a narrow row, and a menu anchored there
 * would reach past the left edge and tilt the whole page sideways (B12).
 *
 * Questions that are no longer asked get a **group of
 * their own** at the end, under a heading that names them. Mixed into the list
 * they would look like fields somebody forgot to switch on; separated, the
 * list still reads like today's form and the retired ones are plainly what
 * they are — a `role="group"` with its own label, so a screen reader hears the
 * distinction instead of only seeing it.
 */
export function ResponsesToolbar({
  search,
  onSearchChange,
  count,
  isFiltered,
  columns,
  shownKeys,
  onToggleColumn,
}: {
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly count: number;
  readonly isFiltered: boolean;
  readonly columns: readonly ResponseColumn[];
  readonly shownKeys: ReadonlySet<string>;
  readonly onToggleColumn: (key: string, checked: boolean) => void;
}): ReactElement {
  const [isOpen, setOpen] = useState(false);
  const menuId = useId();
  const titleId = useId();
  const retiredTitleId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const active = useMemo(
    () => columns.filter((column) => !column.retired),
    [columns],
  );
  const retired = useMemo(
    () => columns.filter((column) => column.retired),
    [columns],
  );

  // A popover that only closes through its own button is a trap for anyone who
  // clicks past it, so Escape and a click outside close it as well. Shared with
  // the export menu since no. 27 gave this view a second popover — one written
  // contract instead of two that can drift.
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  // The trigger gets the focus back after escape (a review finding).
  useDismiss(isOpen, areaRef, close, triggerRef);

  return (
    <div className="responses__toolbar" ref={areaRef}>
      <input
        type="search"
        className="responses__search"
        placeholder="Antworten durchsuchen"
        aria-label="Antworten durchsuchen"
        value={search}
        onChange={(event) => {
          onSearchChange(event.target.value);
        }}
      />

      {isFiltered ? (
        <button
          type="button"
          className="responses__button responses__button--quiet"
          onClick={() => {
            onSearchChange('');
          }}
        >
          Zurücksetzen
        </button>
      ) : null}

      <span className="responses__count" role="status">
        {count === 1 ? '1 Antwort' : `${String(count)} Antworten`}
      </span>

      <button
        ref={triggerRef}
        type="button"
        className="responses__button"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => {
          setOpen((open) => !open);
        }}
      >
        ⚙ Felder
        <span className="responses__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen ? (
        <div
          className="responses__fields-menu"
          id={menuId}
          role="group"
          aria-labelledby={titleId}
        >
          <p className="responses__fields-title" id={titleId}>
            Angezeigte Spalten ({shownKeys.size})
          </p>
          {active.map((column) => (
            <ColumnToggle
              key={column.key}
              column={column}
              checked={shownKeys.has(column.key)}
              onToggle={onToggleColumn}
            />
          ))}

          {retired.length === 0 ? null : (
            <div role="group" aria-labelledby={retiredTitleId}>
              {/*
                The same wording as the column header and the CSV header, from
                the one constant in `@formsache/shared` — three surfaces, one text.
              */}
              <p
                className="responses__fields-title responses__fields-title--retired"
                id={retiredTitleId}
              >
                {RETIRED_COLUMN_NOTE}
              </p>
              {retired.map((column) => (
                <ColumnToggle
                  key={column.key}
                  column={column}
                  checked={shownKeys.has(column.key)}
                  onToggle={onToggleColumn}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One checkbox of the field menu.
 *
 * Extracted only because the menu now renders the same row in two groups —
 * the active columns and the retired ones — and two copies of a `<label>` with
 * a checkbox in it is exactly how the two lists start to drift apart.
 */
function ColumnToggle({
  column,
  checked,
  onToggle,
}: {
  readonly column: ResponseColumn;
  readonly checked: boolean;
  readonly onToggle: (key: string, checked: boolean) => void;
}): ReactElement {
  return (
    <label className="responses__fields-item">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onToggle(column.key, event.target.checked);
        }}
      />
      <span>{column.label}</span>
    </label>
  );
}
