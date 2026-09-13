import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';

import { useBuilderStore } from './builder-store';
import {
  PAGE_ROW_ATTRIBUTE,
  useKeyboardDrag,
  usePageDrag,
} from './use-pointer-drag';

/**
 * The page list of the handoff: grip, number badge, title and „<n>
 * Fragen", the active page highlighted.
 *
 * No ▲/▼ buttons — not here and not on mobile (Konzept no. 9). The grip
 * alone says a row can be moved, and it is operable by pointer *and* keyboard.
 *
 * **The row switches the page; renaming happens in the canvas header.** The
 * row used to carry a text input, which made the title the only clickable part
 * of it *and* turned every attempt to switch pages into a rename („Egal wo man
 * hinklickt sollte die Seite wechseln"). The prototype settles the split: its
 * page row is one button, and the page title is edited in the canvas above the
 * questions (`QuestionCanvas`). That keeps the two gestures apart without
 * inventing a mode — switching is a click, renaming is a field the editor goes
 * to on purpose.
 */
export function PageList({
  onOpenTemplates,
  onSaveFormAsTemplate,
  onSavePageAsTemplate,
}: {
  /**
   * The three template controls of the handoff's sidebar: „▤ Vorlagen & Blöcke" and the two „☆ … als Vorlage speichern".
   *
   * All three optional, and absent means **not rendered**: they belong to
   * `canBuild`, and a control that can never work is noise rather than a hint.
   * They sit here rather than in the toolbar because that is where the handoff
   * puts them — beside the pages, which is what a block is made of.
   */
  readonly onOpenTemplates?: () => void;
  readonly onSaveFormAsTemplate?: () => void;
  readonly onSavePageAsTemplate?: () => void;
} = {}): ReactElement {
  const pages = useBuilderStore((state) => state.pages);
  const activePageIndex = useBuilderStore((state) => state.activePageIndex);
  const pageDropIndex = useBuilderStore((state) => state.pageDropIndex);
  const draggingPageIndex = useBuilderStore((state) => state.draggingPageIndex);
  const selectPage = useBuilderStore((state) => state.selectPage);
  const addPage = useBuilderStore((state) => state.addPage);
  const deletePage = useBuilderStore((state) => state.deletePage);

  const drag = usePageDrag();

  return (
    <div className="page-list">
      <p className="page-list__caption">Seiten</p>

      <ul className="page-list__rows" ref={drag.containerRef}>
        {pages.map((page, index) => (
          <PageRow
            key={page.id}
            index={index}
            total={pages.length}
            title={page.title}
            questionCount={page.questions.length}
            isActive={index === activePageIndex}
            dropEdge={dropEdgeOf(pageDropIndex, index, pages.length)}
            isDragging={draggingPageIndex === index}
            canDelete={pages.length > 1}
            onSelect={() => {
              selectPage(index);
            }}
            onDelete={() => {
              deletePage(index);
            }}
            onGripPointerDown={drag.onGripPointerDown}
          />
        ))}
      </ul>

      <button type="button" className="page-list__add" onClick={addPage}>
        + Seite hinzufügen
      </button>

      {onOpenTemplates === undefined ? null : (
        <button
          type="button"
          className="page-list__templates"
          onClick={onOpenTemplates}
        >
          <span aria-hidden="true">▤ </span>Vorlagen &amp; Blöcke
        </button>
      )}

      {onSavePageAsTemplate === undefined ? null : (
        <button
          type="button"
          className="page-list__save-template"
          onClick={onSavePageAsTemplate}
        >
          <span aria-hidden="true">☆ </span>Seite als Vorlage speichern
        </button>
      )}

      {onSaveFormAsTemplate === undefined ? null : (
        <button
          type="button"
          className="page-list__save-template"
          onClick={onSaveFormAsTemplate}
        >
          <span aria-hidden="true">☆ </span>Formular als Vorlage speichern
        </button>
      )}
    </div>
  );
}

/** Which edge of a row carries the insertion line, if any. */
type DropEdge = 'before' | 'after';

/**
 * Where the insertion line goes for row `index`, given the gap being aimed at.
 *
 * The gap *after* the last row has no row of its own to mark, so the last row
 * carries it on its lower edge. Without that the one target a downward drag
 * aims at — "to the very end" — was the only one that showed nothing at all,
 * which is most of why moving a page down looked broken.
 */
function dropEdgeOf(
  gapIndex: number | null,
  index: number,
  total: number,
): DropEdge | null {
  if (gapIndex === null) {
    return null;
  }
  if (gapIndex === index) {
    return 'before';
  }
  return gapIndex === total && index === total - 1 ? 'after' : null;
}

interface PageRowProps {
  readonly index: number;
  readonly total: number;
  readonly title: string;
  readonly questionCount: number;
  readonly isActive: boolean;
  readonly dropEdge: DropEdge | null;
  readonly isDragging: boolean;
  readonly canDelete: boolean;
  readonly onSelect: () => void;
  readonly onDelete: () => void;
  readonly onGripPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    index: number,
  ) => void;
}

function PageRow({
  index,
  total,
  title,
  questionCount,
  isActive,
  dropEdge,
  isDragging,
  canDelete,
  onSelect,
  onDelete,
  onGripPointerDown,
}: PageRowProps): ReactElement {
  const nudgePage = useBuilderStore((state) => state.nudgePage);
  const origin = useRef<number | null>(null);
  const label = `Seite ${String(index + 1)}`;
  const count =
    questionCount === 1 ? '1 Frage' : `${String(questionCount)} Fragen`;

  const keyboard = useKeyboardDrag({
    label,
    position: index + 1,
    total,
    horizontal: false,
    onMove: (direction) => {
      nudgePage(index, direction);
    },
    onCancel: () => {
      const from = origin.current;
      if (from === null) {
        return;
      }
      // Pages are addressed by *index*, so the position has to be tracked as
      // it moves — passing the same index repeatedly would nudge whichever row
      // happens to sit there after the first step.
      let current = index;
      while (current !== from) {
        const forward = from > current;
        nudgePage(current, forward ? 'next' : 'prev');
        current += forward ? 1 : -1;
      }
    },
  });

  useEffect(() => {
    origin.current = keyboard.held ? (origin.current ?? index) : null;
  }, [keyboard.held, index]);

  const classes = [
    'page-row',
    isActive ? 'page-row--active' : '',
    isDragging ? 'page-row--dragging' : '',
    dropEdge === null ? '' : `page-row--drop-${dropEdge}`,
    keyboard.held ? 'page-row--held' : '',
  ]
    .filter((entry) => entry !== '')
    .join(' ');

  return (
    <li className={classes} {...{ [PAGE_ROW_ATTRIBUTE]: String(index) }}>
      <button
        type="button"
        className="page-row__grip"
        aria-label={`${label} verschieben`}
        aria-pressed={keyboard.held}
        onPointerDown={(event) => {
          onGripPointerDown(event, index);
        }}
        onKeyDown={keyboard.onKeyDown}
      >
        <span aria-hidden="true">⠿</span>
      </button>

      {/*
        The whole row, minus the two controls that have their own job: it
        covers the rest of the row through `.page-row__select::after`, so a
        click on the badge, on the title or on the empty space beside them
        switches the page. A `<button>` next to the grip rather than around it
        — nesting one interactive element inside another is invalid HTML and
        unusable with a screen reader (the same reason `TenantList` keeps one
        button per row).
      */}
      <button
        type="button"
        className="page-row__select"
        aria-current={isActive ? 'page' : undefined}
        // An `aria-label` *replaces* the visible content, so everything the
        // row shows has to be in it: an untitled page would otherwise be
        // announced as „, Seite 2 von 3" and the question count would be lost
        // entirely. The position is added because the badge that carries it is
        // decorative.
        aria-label={`${title.trim() === '' ? 'Ohne Titel' : title}, ${label} von ${String(total)}, ${count}`}
        onClick={onSelect}
      >
        <span className="page-row__badge" aria-hidden="true">
          {index + 1}
        </span>
        <span className="page-row__body">
          <span className="page-row__title">{title}</span>
          <span className="page-row__meta">{count}</span>
        </span>
      </button>

      <button
        type="button"
        className="page-row__delete"
        aria-label={`${label} löschen`}
        // The last page cannot be deleted — the schema requires one, and a
        // control that reports failure afterwards is worse than one that is
        // visibly unavailable.
        disabled={!canDelete}
        title={
          canDelete ? undefined : 'Die letzte Seite kann nicht gelöscht werden.'
        }
        onClick={onDelete}
      >
        <span aria-hidden="true">×</span>
      </button>

      <span className="visually-hidden" role="status">
        {keyboard.announcement}
      </span>
    </li>
  );
}
