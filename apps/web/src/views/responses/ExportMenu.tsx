import type { ReactElement } from 'react';
import { useCallback, useId, useRef, useState } from 'react';

import { useDismiss } from './use-dismiss';

/**
 * Which columns an export carries.
 *
 * `'visible'` is the view on screen, which is what the requirement promised;
 * `'all'` is the union of every published version, hidden and retired columns
 * included (no. 22) — and since Konzept no. 80 it is the **preselection** of the
 * export. Which of the two is pre-ticked is the caller's,
 * not this component's: it renders the choice it is given.
 */
export type ExportScope = 'visible' | 'all';

/** One downloadable format — a label and the address that produces it. */
export interface ExportFormat {
  readonly id: string;
  readonly label: string;
  /** Already built for the **current** scope by the caller. */
  readonly href: string;
}

/**
 * „⭳ Export" — the menu that asks which columns before it hands over a file.
 *
 * ## Why a menu and not two buttons
 *
 * Two buttons would be one control per combination, and the spec says the
 * question belongs to the **export** rather than to the format: later work adds
 * Excel and HTML, and „angezeigte oder alle" asked once per format would be the same
 * question standing there three times. Here the scope is chosen once and the
 * formats are a list under it — a third format is one more entry in
 * {@link ExportFormat}[], with nothing about this component redesigned.
 *
 * ## Why the formats stay anchors
 *
 * An export is a **download**, and the file name comes out of the
 * `Content-Disposition` header (`e2e/core-flow.spec.ts` asserts it). A button
 * that fetched in the background would either lose the name or have to rebuild
 * a file the browser already knows how to save — so `href` stays `href`, and
 * „in neuem Tab öffnen" and „Ziel speichern unter" keep working.
 *
 * ## The sentence about rows
 *
 * The choice is about columns, never about rows. No. 27 is explicit that the
 * search keeps filtering both variants, „sonst hieße ‚alle Spalten' unbemerkt
 * auch ‚alle Antworten'" — someone who filtered to one organisation and picks „alle
 * Spalten" must not be handed the whole database. The note therefore sits
 * inside the menu, between the choice and the download, and is wired to the
 * radio group with `aria-describedby` so it is *read out* on entering the
 * group rather than only visible next to it.
 *
 * ## And the sentence about the columns that are **not** in the file
 *
 * **A review finding**, and deliberately only its smaller half.
 * The default („die ersten drei Fragen plus Eingereicht am", Handoff)
 * was decided early on and tips over at a size that became possible
 * later: a later measurement found a form with **ten** column-bearing questions
 * whose untouched export carries **three** of them. Whether that default is
 * still the right one is a product decision and is **not** taken here — a
 * silently widened export is a user-visible change without a decision behind
 * it.
 *
 * What *is* fixed here is the half that is nobody's decision: until now
 * nothing on this surface said that the file leaves questions out. The two
 * counts beside the radios („(4)" against „(11)") are numbers, not a
 * statement, and they only differ once somebody compares them. This menu is
 * unavoidable — the download links live inside it — so one sentence at the
 * point of choice reaches everybody who exports, and it is wired into the same
 * `aria-describedby` as the note about rows.
 */
export function ExportMenu({
  scope,
  onScopeChange,
  visibleColumns,
  allColumns,
  totalRows,
  matchingRows,
  isFiltered,
  formats,
}: {
  readonly scope: ExportScope;
  readonly onScopeChange: (scope: ExportScope) => void;
  readonly visibleColumns: number;
  readonly allColumns: number;
  readonly totalRows: number;
  readonly matchingRows: number;
  readonly isFiltered: boolean;
  readonly formats: readonly ExportFormat[];
}): ReactElement {
  const [isOpen, setOpen] = useState(false);
  const menuId = useId();
  const titleId = useId();
  const groupId = useId();
  const noteId = useId();
  const gapId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Whether the chosen scope leaves columns out of the file — see the note
   * above.
   *
   * „Alle Spalten" leaves nothing out by definition, so the sentence appears
   * only under the default, and only while the two counts actually differ: on
   * a form whose every column is shown there is nothing to warn about, and a
   * warning that is always there is one nobody reads.
   */
  const omits = scope === 'visible' && visibleColumns < allColumns;

  const close = useCallback(() => {
    setOpen(false);
  }, []);
  // The trigger gets the focus back after Escape (a review finding).
  useDismiss(isOpen, areaRef, close, triggerRef);

  return (
    <div className="responses__export" ref={areaRef}>
      <button
        ref={triggerRef}
        type="button"
        className="responses__button responses__button--accent"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => {
          setOpen((open) => !open);
        }}
      >
        <span aria-hidden="true">⭳ </span>Export
        <span className="responses__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen ? (
        <div
          className="responses__export-menu"
          id={menuId}
          role="group"
          aria-labelledby={titleId}
        >
          <p className="responses__fields-title" id={titleId}>
            Export
          </p>

          <div
            role="radiogroup"
            aria-labelledby={groupId}
            aria-describedby={omits ? `${noteId} ${gapId}` : noteId}
          >
            <p className="responses__export-legend" id={groupId}>
              Welche Spalten?
            </p>

            {/*
              Native radios rather than buttons with `role="radio"`: the arrow
              keys, the single tab stop and the grouping all come for free and
              are the thing a hand-built group gets wrong.
            */}
            <label className="responses__fields-item">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'visible'}
                onChange={() => {
                  onScopeChange('visible');
                }}
              />
              <span>
                Angezeigte Spalten
                <span className="responses__export-count">
                  {' '}
                  ({visibleColumns})
                </span>
              </span>
            </label>

            <label className="responses__fields-item">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'all'}
                onChange={() => {
                  onScopeChange('all');
                }}
              />
              <span>
                Alle Spalten
                <span className="responses__export-count"> ({allColumns})</span>
                <span className="responses__export-hint">
                  auch ausgeblendete und nicht mehr gefragte
                </span>
              </span>
            </label>
          </div>

          {/*
            Named at the point of choice, not as a footnote. The filtered case
            gets the sharper wording, because that is the moment „alle Spalten"
            could be mistaken for „alle Antworten".
          */}
          <p className="responses__export-note" id={noteId}>
            {isFiltered
              ? `Die Auswahl betrifft nur die Spalten. Die Suche bleibt aktiv: exportiert ${rowPhrase(matchingRows)} von ${String(totalRows)}.`
              : `Die Auswahl betrifft nur die Spalten. Exportiert ${rowPhrase(totalRows)}.`}
          </p>

          {/*
            The one sentence that says the file is a selection — see
            the note at the top of this file. It names the two numbers that are
            already on screen rather than inventing a third, and it says
            „Fragen" for what is missing, because the file expands one question
            into several columns (an Adresse into four) and „sieben
            Spalten fehlen" would then be a number nobody can find in the
            download.
          */}
          {omits ? (
            <p
              className="responses__export-gap"
              id={gapId}
              data-testid="export-gap"
            >
              „Angezeigte Spalten" ist eine Auswahl ({visibleColumns} von{' '}
              {allColumns}). Die Datei enthält dann nicht jede Frage dieses
              Formulars.
            </p>
          ) : null}

          <div className="responses__export-formats">
            {formats.map((format) => (
              <a
                key={format.id}
                className="responses__export-format"
                href={format.href}
                onClick={close}
              >
                <span aria-hidden="true">⭳ </span>
                {format.label}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** „wird 1 Antwort" / „werden 7 Antworten" — the verb agrees too. */
function rowPhrase(count: number): string {
  return count === 1 ? 'wird 1 Antwort' : `werden ${String(count)} Antworten`;
}
