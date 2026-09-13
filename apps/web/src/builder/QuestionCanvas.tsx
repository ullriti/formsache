import type { ReactElement } from 'react';
import { useMemo } from 'react';

import { activePage, selectedQuestion, useBuilderStore } from './builder-store';
import { conditionMarks } from './condition-status';
import { QuestionCard } from './QuestionCard';
import { useQuestionDrag } from './use-pointer-drag';

/**
 * The middle column: the questions of the active page.
 *
 * A `flex-wrap` list, because half-width cards are a *layout* fact — two cards
 * that fit next to each other do, and one that does not wraps. That is also
 * why the mobile rule for docking cards to half width is pure CSS: below the
 * breakpoint every card is full width, and the stored document does not
 * change.
 */
export function QuestionCanvas(): ReactElement {
  const page = useBuilderStore(activePage);
  const pageIndex = useBuilderStore((state) => state.activePageIndex);
  const pageCount = useBuilderStore((state) => state.pages.length);
  const selected = useBuilderStore(selectedQuestion);
  const selectQuestion = useBuilderStore((state) => state.selectQuestion);
  const renamePage = useBuilderStore((state) => state.renamePage);
  const setPageDescription = useBuilderStore(
    (state) => state.setPageDescription,
  );
  const drag = useQuestionDrag();
  // Over **all** pages, not the active one: a condition may point at a source
  // on an earlier page, so „löst diese Bedingung auf" cannot be answered from
  // one page alone (`condition-status.ts`).
  const pages = useBuilderStore((state) => state.pages);
  const marks = useMemo(() => conditionMarks(pages), [pages]);

  if (page === undefined) {
    return <div className="canvas" />;
  }

  return (
    <div
      className="canvas"
      ref={drag.containerRef}
      // Clicking the background deselects — the pointer's way back to the type
      // library. Cards stop the event, so this only fires on empty space.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          selectQuestion(null);
        }
      }}
    >
      {/*
        The page title, where the prototype puts it — and the *only* place it
        is edited. In the page list the same field made switching pages
        impossible without starting a rename; here it is a field the editor
        goes to deliberately, on the page it is already looking at.

        Wrapped in the `<h2>` it replaced: it is still the heading of the
        middle column, and without it the view has no structure at all between
        the form name and the cards. A heading may contain phrasing content,
        so the field keeps working exactly as it looks.
      */}
      <h2 className="canvas__heading">
        <input
          className="canvas__title"
          value={page.title}
          placeholder="Seitentitel"
          aria-label={`Titel von Seite ${String(pageIndex + 1)}`}
          onChange={(event) => {
            renamePage(pageIndex, event.target.value);
          }}
        />
      </h2>
      <p className="canvas__meta">
        Seite {pageIndex + 1} von {pageCount}
      </p>

      {/*
        The requirement — no precedent in the prototype (its `pages` never
        carried one), unlike the title above. Placed next to it rather than in
        the properties panel: this describes the *page*, not a question, and
        the panel is question-scoped.
      */}
      <textarea
        className="canvas__description"
        value={page.description ?? ''}
        placeholder="Seitenbeschreibung (optional) – erscheint beim Ausfüllen unter dem Seitentitel."
        aria-label={`Beschreibung von Seite ${String(pageIndex + 1)}`}
        rows={2}
        onChange={(event) => {
          setPageDescription(pageIndex, event.target.value);
        }}
      />

      {page.questions.length === 0 ? (
        <p className="canvas__empty">
          Diese Seite hat noch keine Fragen. Rechts einen Fragetyp wählen.
        </p>
      ) : (
        <ul className="canvas__cards">
          {page.questions.map((question, index) => (
            <QuestionCard
              key={question.id}
              question={question}
              index={index}
              total={page.questions.length}
              isSelected={selected?.id === question.id}
              conditionMark={marks.get(question.id) ?? null}
              onGripPointerDown={drag.onGripPointerDown}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
