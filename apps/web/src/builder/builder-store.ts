import type {
  FormDefinition,
  FormPage,
  Question,
  QuestionType,
  QuestionWidth,
} from '@formsache/shared';
/*
 * The row rule — **the invariant `withPairedPageWidths`, the two width
 * literals and the "who is docked to whom" lookups** — lives in
 * `packages/shared/src/question-rows.ts`.
 *
 * "No half-width card without a partner in its row" is a statement about the
 * *document*, not about this canvas: since the fill-in view renders half width
 * too, builder and participant have to read the same rule or they show
 * different forms. It therefore sits next to the schema that defines `width`
 * (`CONTRIBUTING.md`) and is imported here.
 *
 * What stays a property of *this* store is where the rule is applied: **once**,
 * over every document the actions commit (see `set` below), rather than
 * repeated per movement. Docking used to be a one-way street precisely because
 * the width rule lived inside a single action — no other path (deleting,
 * nudging, editing the width) knew about it, and none of them could give a
 * card its full width back („bei zwei Feldern die nebeneinander sind, kommt
 * man nicht mehr zurück zu beide volle Breite").
 *
 * The rule repairs from the front and knows nothing about intent, so the
 * actions that *have* an intent — which card was aimed at — say so by
 * releasing the old row (`withReleasedRow`) before they commit.
 */
import {
  FULL_WIDTH,
  HALF_WIDTH,
  duplicateQuestion,
  rowPartnerIndex,
  withPairedPageWidths,
  withReleasedRow,
} from '@formsache/shared';
import { create } from 'zustand';

import { createQuestion } from './question-defaults';

/**
 * Editor state of the builder — Zustand, and **only** the editing document
 * (`CONTRIBUTING.md`).
 *
 * The rule that keeps this honest: nothing here is server state. The store is
 * filled once from a loaded form (`load`) and hands its document back on save;
 * it never reads the query cache and never writes into it. That is what makes
 * "unsaved" a fact rather than a guess — `isDirty` is true exactly while this
 * document differs from the revision it was loaded at.
 *
 * Reordering lives here too, not in the components. The rules for insertion
 * index, docking two cards to half width, and what happens to the active
 * page when pages move are decisions about a document, and a document is
 * testable without a DOM. The pointer hook only ever answers *where* the
 * pointer is.
 */

/**
 * Where a dragged card would land relative to the card the pointer picked out.
 *
 * `left` and `right` are the docking gesture of the requirement — both cards
 * become half width and the dragged one lands on that side. `before` and
 * `after` are a plain reorder.
 *
 * The pair `before`/`after` replaces a single `mid`, and that is a bug fix
 * rather than a refactor: "in the middle of that card" does not say which side
 * of it the card lands on, so the store always inserted *before* the target.
 * Since the index is computed after the dragged card is lifted out, dropping
 * onto the next card down meant putting it back exactly where it came from —
 * dragging upwards worked, dragging downwards did nothing.
 */
export type DropZone = 'left' | 'right' | 'before' | 'after';

export interface BuilderState {
  /** Id of the form being edited; null while nothing is loaded. */
  formId: string | null;
  title: string;
  pages: FormPage[];
  /** The revision this document was loaded at — sent back on save. */
  revision: number;
  activePageIndex: number;
  selectedQuestionId: string | null;
  isDirty: boolean;

  // --- transient drag state, never saved -----------------------------------
  /** Question currently being dragged, or null. */
  draggingQuestionId: string | null;
  /** Card the pointer picked out, and the side of it that would be joined. */
  dragOverQuestionId: string | null;
  dragZone: DropZone | null;
  /** Page row currently being dragged, or null. */
  draggingPageIndex: number | null;
  /** Insertion gap while a page row is dragged, or null when it would not move. */
  pageDropIndex: number | null;

  load: (form: {
    id: string;
    title: string;
    definition: FormDefinition;
    revision: number;
  }) => void;
  /** After a successful save: same document, new revision, no longer dirty. */
  markSaved: (revision: number) => void;
  reset: () => void;

  setTitle: (title: string) => void;
  selectPage: (index: number) => void;
  addPage: () => void;
  renamePage: (index: number, title: string) => void;
  /** The requirement — the paragraph under the page title. */
  setPageDescription: (index: number, description: string) => void;
  deletePage: (index: number) => void;
  movePage: (from: number, to: number) => void;

  /**
   * „▤ Vorlagen & Blöcke" → inserting a **page template**: the page is appended and becomes the active one.
   *
   * The page arrives **ready** — the server minted its ids and rewrote its
   * conditions (`POST /form-templates/:id/instance`), so this action does no
   * copying of its own. That is deliberate: „gib mir diese Fragen mit neuen
   * IDs" already exists once, in `@formsache/shared`, and a client-side second
   * version would be the one nobody can measure from `apps/api`.
   */
  insertTemplatePage: (page: FormPage) => void;
  /** The same for a **question template**: appended to the page in view. */
  insertTemplateQuestion: (question: Question) => void;

  selectQuestion: (id: string | null) => void;
  addQuestion: (type: QuestionType, id: string) => void;
  /**
   * „⧉ Duplizieren" on a question card: a copy with a fresh
   * id, directly below the original, on the same page.
   */
  duplicateQuestion: (id: string, newId: string) => void;
  updateQuestion: (id: string, question: Question) => void;
  /**
   * A type change is internally a new question — see the action's doc comment
   * below for why and what survives the change.
   */
  changeQuestionType: (id: string, type: QuestionType, newId: string) => void;
  deleteQuestion: (id: string) => void;
  /** Reorder, and dock to half width when a side is hit. */
  moveQuestion: (fromId: string, toId: string, zone: DropZone) => void;
  /** Width from the properties panel — pair-aware, see `setQuestionWidth`. */
  setQuestionWidth: (id: string, width: QuestionWidth) => void;
  /** Keyboard equivalent of a drag: one step in a direction. */
  nudgeQuestion: (id: string, direction: 'prev' | 'next') => void;
  nudgePage: (index: number, direction: 'prev' | 'next') => void;

  beginQuestionDrag: (id: string) => void;
  setDragTarget: (overId: string | null, zone: DropZone | null) => void;
  endQuestionDrag: () => void;
  beginPageDrag: (index: number) => void;
  setPageDropIndex: (index: number | null) => void;
  endPageDrag: () => void;
}

/**
 * Whether two versions of the same document lay their cards out identically.
 *
 * Only the widths are compared, and only by `setQuestionWidth` — it is the one
 * action whose effect the invariant may legitimately undo, and an edit that
 * changed nothing must not mark the form unsaved.
 */
function sameWidths(pages: FormPage[], others: FormPage[]): boolean {
  return pages.every((page, index) => {
    const other = others[index];
    return (
      other !== undefined &&
      page.questions.every(
        (question, position) =>
          question.width === other.questions[position]?.width,
      )
    );
  });
}

/** A page that is empty but valid — `formDefinitionSchema` needs at least one. */
function emptyPage(index: number): FormPage {
  return {
    id: crypto.randomUUID(),
    title: `Seite ${String(index + 1)}`,
    // `null`, not `''` — the same „no value" the schema gives `hint`.
    description: null,
    questions: [],
  };
}

/**
 * The starting point for a type change — the "switched back" case described in
 * the addendum on `changeQuestionType`.
 *
 * Reverting to the type a question started this session with (`origin`) does
 * not just restore its id: it restores its type-specific settings too —
 * Min/Max, Muster, Optionen — exactly as they stood at that origin. Handing
 * back the id while leaving those lost would be „als wäre nichts geschehen"
 * in name only; the caller still overrides `label`/`hint`/`required`/`width`
 * with the *current* question afterward, because an edit made along the way
 * is real and is not undone by a revert any more than by a forward change.
 *
 * Anything that is not a revert — no origin, or a genuinely different type —
 * gets the ordinary fresh defaults, same as any other type change.
 */
function baseForType(
  type: QuestionType,
  id: string,
  origin: Question | undefined,
): Question {
  if (origin?.type === type) {
    return { ...origin, id };
  }
  return createQuestion(type, id);
}

/**
 * The reference a type change leaves on the question it retired — Konzept
 * no. 26 (2026-07-27). Without it, `publishDiff` sees a type change as
 * *one removed and one new* question with nothing connecting the two, and the
 * pre-publish warning shows the same Fragetext twice with no hint that it is
 * a single change.
 *
 * `replaces` lives on `questionBaseShape` in `packages/shared/src/form-schema.ts`
 * (`.optional()`, for the same reason `visibleIf` next to it is: „no
 * predecessor" has exactly one spelling, the absent key) — so `Question`
 * itself is what `changeQuestionType` writes below, with no local stand-in.
 */

const initial = {
  formId: null,
  title: '',
  pages: [] as FormPage[],
  revision: 0,
  activePageIndex: 0,
  selectedQuestionId: null,
  isDirty: false,
  draggingQuestionId: null,
  dragOverQuestionId: null,
  dragZone: null,
  draggingPageIndex: null,
  pageDropIndex: null,
} satisfies Partial<BuilderState>;

/** The partial form every action in this store uses — never a full replace. */
type BuilderPatch =
  Partial<BuilderState> | ((state: BuilderState) => Partial<BuilderState>);

export const useBuilderStore = create<BuilderState>()((commit, get) => {
  /**
   * `set` with the width invariant applied — the gate every **action of this
   * store** passes through.
   *
   * Wrapping the setter rather than calling a helper in each action is the
   * point: an action added later cannot forget the rule, because it does not
   * have to know about it. Anything that writes `pages` is repaired on the
   * way in, including `load` — a document that arrives from the server with a
   * stray half-width card is fixed rather than displayed with a gap.
   *
   * It is not a hard boundary: `useBuilderStore.setState` from outside goes
   * straight to Zustand and around this. Nothing does that today, and the
   * document is only ever written through the actions above.
   */
  const set = (patch: BuilderPatch): void => {
    commit((state) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      return next.pages === undefined
        ? next
        : { ...next, pages: withPairedPageWidths(next.pages) };
    });
  };

  /**
   * The session's memory of "where each question started" — Konzept
   * no. 24, addendum of 2026-07-27: switching a question's type back to the
   * type it had when this document was loaded (or last saved) gives it back
   * the id — and the type-specific settings — it had then.
   *
   * Keyed by the question's *current* id, so a lookup in `changeQuestionType`
   * is one map read regardless of how many times the type has changed since;
   * the value is the whole question as it stood at that origin (not just
   * id+type), which is what lets a revert restore Min/Max, Muster or
   * Optionen and not only the id. See `baseForType`.
   *
   * Deliberately **not** part of `BuilderState`: nothing renders from it, it
   * must never reach a save payload, and it answers a question about *this
   * session*, never about answers — the builder still does not know whether
   * either id was ever published to, exactly as before this addendum.
   * Entries for retired ids are never swept — a stale mapping is inert
   * because no live question can carry its key again (ids are UUIDs), so the
   * cost is a few unreachable map entries, not a correctness risk.
   */
  let questionOrigins = new Map<string, Question>();

  /** Makes `pages` the new baseline every future revert is measured against. */
  function rememberOrigins(pages: FormPage[]): void {
    const origins = new Map<string, Question>();
    for (const page of pages) {
      for (const question of page.questions) {
        origins.set(question.id, question);
      }
    }
    questionOrigins = origins;
  }

  return {
    ...initial,

    load: (form) => {
      const pages = form.definition.pages.map((page) => ({ ...page }));
      // The freshly loaded document *is* the baseline: every question in it
      // maps to itself, which is exactly the self-mapping a revert needs to
      // find on the very first type change.
      rememberOrigins(pages);
      set({
        ...initial,
        formId: form.id,
        title: form.title,
        pages,
        revision: form.revision,
      });
    },

    markSaved: (revision) => {
      // A successful save moves the baseline: from here on the saved draft
      // is the truth, so a later revert must not reach back past it to an id
      // from before the save (the "switched back" rule on `changeQuestionType`
      // reverts to the origin, and the origin must never predate the save).
      rememberOrigins(get().pages);
      set({ revision, isDirty: false });
    },

    reset: () => {
      questionOrigins = new Map();
      set({ ...initial });
    },

    setTitle: (title) => {
      set({ title, isDirty: true });
    },

    selectPage: (index) => {
      const { pages } = get();
      if (index < 0 || index >= pages.length) {
        return;
      }
      // The selection follows the page: a question of page 1 that stayed
      // selected while page 2 is shown would drive the properties panel from a
      // card nobody can see.
      set({ activePageIndex: index, selectedQuestionId: null });
    },

    addPage: () => {
      set((state) => {
        const pages = [...state.pages, emptyPage(state.pages.length)];
        return {
          pages,
          activePageIndex: pages.length - 1,
          selectedQuestionId: null,
          isDirty: true,
        };
      });
    },

    insertTemplatePage: (page) => {
      set((state) => {
        const pages = [...state.pages, page];
        return {
          pages,
          activePageIndex: pages.length - 1,
          selectedQuestionId: null,
          isDirty: true,
        };
      });
    },

    insertTemplateQuestion: (question) => {
      set((state) => ({
        pages: state.pages.map((page, index) =>
          index === state.activePageIndex
            ? { ...page, questions: [...page.questions, question] }
            : page,
        ),
        selectedQuestionId: question.id,
        isDirty: true,
      }));
    },

    renamePage: (index, title) => {
      set((state) => ({
        pages: state.pages.map((page, current) =>
          current === index ? { ...page, title } : page,
        ),
        isDirty: true,
      }));
    },

    setPageDescription: (index, description) => {
      set((state) => ({
        pages: state.pages.map((page, current) =>
          current === index
            ? // Empty means "no description" — the same choice
              // `renamePage` does not have to make, because a page title may
              // not be empty (`pageSchema.title` is `min(1)`).
              { ...page, description: description === '' ? null : description }
            : page,
        ),
        isDirty: true,
      }));
    },

    /**
     * Deleting the last page is **refused**, which is the answer the requirement
     * asks to be defined.
     *
     * Refused rather than "replaced by a fresh empty one": the schema requires
     * at least one page, and silently substituting a new page would throw the
     * questions away while looking like a deletion that worked.
     */
    deletePage: (index) => {
      set((state) => {
        if (state.pages.length <= 1) {
          return {};
        }
        const pages = state.pages.filter((_, current) => current !== index);
        const activePageIndex = Math.min(
          state.activePageIndex,
          pages.length - 1,
        );
        return {
          pages,
          activePageIndex,
          selectedQuestionId: null,
          isDirty: true,
        };
      });
    },

    /**
     * Moves a page and carries the *active* page with it.
     *
     * The index arithmetic is the part worth reading: after a move, "page 2" may
     * be a different page. Following the prototype, the active index is adjusted
     * so the page the editor was looking at stays the page they are looking at.
     */
    movePage: (from, to) => {
      set((state) => {
        const { pages } = state;
        if (
          from === to ||
          from < 0 ||
          to < 0 ||
          from >= pages.length ||
          to >= pages.length
        ) {
          return { pageDropIndex: null, draggingPageIndex: null };
        }

        const next = [...pages];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) {
          return { pageDropIndex: null, draggingPageIndex: null };
        }
        next.splice(to, 0, moved);

        let activePageIndex = state.activePageIndex;
        if (state.activePageIndex === from) {
          activePageIndex = to;
        } else if (
          from < state.activePageIndex &&
          to >= state.activePageIndex
        ) {
          activePageIndex -= 1;
        } else if (
          from > state.activePageIndex &&
          to <= state.activePageIndex
        ) {
          activePageIndex += 1;
        }

        return {
          pages: next,
          activePageIndex,
          pageDropIndex: null,
          draggingPageIndex: null,
          isDirty: true,
        };
      });
    },

    selectQuestion: (id) => {
      set({ selectedQuestionId: id });
    },

    addQuestion: (type, id) => {
      set((state) => ({
        pages: state.pages.map((page, index) =>
          index === state.activePageIndex
            ? {
                ...page,
                questions: [...page.questions, createQuestion(type, id)],
              }
            : page,
        ),
        selectedQuestionId: id,
        isDirty: true,
      }));
    },

    /**
     * The copy is spliced in **directly below** the original, on its own
     * page — never at `activePageIndex`, which the grip/⧉ column of a card on
     * a page that is not the active one would otherwise silently move to
     * (nothing else in this store reaches across pages by id, so this action
     * is the first to have to search for one).
     *
     * `duplicateQuestion` from `@formsache/shared` is the whole of *what* a copy is
     * (fresh id, `replaces` dropped, `visibleIf` left as written) — the same
     * function the API applies to every question when a **form** is
     * duplicated, so the two „⧉" buttons of the handoff cannot drift apart on
     * what „duplicated" means (`CONTRIBUTING.md`).
     *
     * ## „Direkt darunter" is measured in **rows**, and the copy is full width
     *
     * The requirement says the copy stands directly below the
     * original; it says nothing about the card *beside* it. The first version
     * spliced at `index + 1` and gave the copy the original's width, which
     * inside a docked pair puts it **between** the two — and the row invariant,
     * which repairs from the front, then widens the partner that was left over.
     * *Gemessen am 2026-08-05:* `["Eins:half", "Zwei:half"]` → „Eins"
     * dupliziert → `["Eins:half", "Eins:half", "Zwei:full"]`. Duplizieren einer
     * Frage änderte die Breite einer **anderen**.
     *
     * Both halves of the fix are needed, and each closes one of two ways the
     * same insertion disturbs the rows behind it:
     *
     * - **after the whole row, not after the card** — otherwise the copy splits
     *   the pair it was cut from;
     * - **at full width** — otherwise it pairs up with whatever follows and
     *   shifts every later pair by one, orphaning the last of them (measured on
     *   four docked cards: duplicating the first widened the fourth).
     *
     * A full-width copy is also the honest state rather than a concession:
     * `createQuestion` starts every new card full width because „half width is
     * something one *docks* a card into" (`question-defaults.ts`), and a copy
     * arriving on a row of its own has nothing to be docked to. In the handoff's
     * canvas it appears exactly where the requirement asks — on the line below the
     * original, starting at the same left edge.
     */
    duplicateQuestion: (id, newId) => {
      set((state) => {
        const pageIndex = state.pages.findIndex((page) =>
          page.questions.some((question) => question.id === id),
        );
        if (pageIndex === -1) {
          return {};
        }
        const page = state.pages[pageIndex];
        // Not reachable: `pageIndex` was just found by the same predicate.
        // Stated rather than asserted, so a future change to the search above
        // that breaks the invariant fails here instead of on a non-null
        // assertion nobody re-reads (`CONTRIBUTING.md`).
        if (page === undefined) {
          return {};
        }
        const questionIndex = page.questions.findIndex(
          (question) => question.id === id,
        );
        const original = page.questions[questionIndex];
        if (original === undefined) {
          return {};
        }
        const copy = { ...duplicateQuestion(original, newId), ...FULL_WIDTH };
        const questions = [...page.questions];
        // The end of the original's row: its partner's index when it has one,
        // its own otherwise. `rowPartnerIndex` is the shared rule
        // (`question-rows.ts`), never a second reading of „nebeneinander" here.
        const partnerIndex = rowPartnerIndex(page.questions, questionIndex);
        questions.splice(Math.max(questionIndex, partnerIndex) + 1, 0, copy);

        return {
          pages: state.pages.map((candidate, index) =>
            index === pageIndex ? { ...page, questions } : candidate,
          ),
          selectedQuestionId: newId,
          isDirty: true,
        };
      });
    },

    updateQuestion: (id, question) => {
      set((state) => ({
        pages: state.pages.map((page) => ({
          ...page,
          questions: page.questions.map((candidate) =>
            candidate.id === id ? question : candidate,
          ),
        })),
        isDirty: true,
      }));
    },

    /**
     * **Changing a question's type is, internally, not an edit of the
     * question** — it retires it and puts a fresh one in its place.
     *
     * The mechanism is deliberately just a new id. Every answer already points
     * at a snapshot of the question it was collected against (a published
     * revision), so a new id on the editing document is enough to leave the
     * old question and its answers exactly where they were in every revision
     * published so far: nothing here has to look at answers, or even know
     * they exist. That holds unconditionally, including for a question that
     * was never published — there the new id simply never appears in any
     * revision, which is not a special case but the same rule with nothing to
     * do. Making the retirement conditional on "has this question been
     * answered yet" would need the builder to ask the server, turn a pure
     * document edit into a network round trip, and give a future "simplification"
     * a real reason to special-case drafts — the unconditional version has none.
     *
     * What survives the swap, and why: `label` and `required` describe *what
     * is being asked*, not *how* — a Ja/Nein-Frage that becomes a Dropdown is
     * still the same question in that sense, so keeping them is a courtesy, not
     * a bug. `hint` is the same kind of type-agnostic free text as `label` and
     * survives for the same reason. `width` survives because the second part of
     * this change is the row it sits in, not the question itself — a type
     * change must not tear a paired row apart, and the surest way to guarantee
     * that is to leave the slot (index and width) untouched and only replace
     * what sits in it. Everything type-specific (Min/Max, Muster, Optionen …)
     * is *not* carried over: those describe validation for the *old* type, and
     * reapplying them to the new one is usually nonsense (a text pattern on a
     * date, options on a number) rather than a saved effort.
     *
     * **Addendum, 2026-07-27:** switching *back* to the type the question had
     * at the last load or save is not a further retirement — it is undoing
     * one. `questionOrigins` says whether `id` traces back to such an origin
     * and, if so, what that origin looked like; when the target `type`
     * matches it, the question gets its origin's id back instead of `newId`,
     * and `baseForType` restores its type-specific settings from the same
     * snapshot. A question with no origin (case: added in this session,
     * never loaded or saved) always takes the `newId`/fresh-defaults branch —
     * not a special case, just what "no origin recorded" means for a lookup
     * that finds nothing. This still needs no knowledge of answers: it is the
     * same session-local bookkeeping the rest of this action already doesn't
     * have, one step further back.
     *
     * **Second addendum, same day:** a forward hop also sets
     * `replaces` to `origin.id` — the id as of the last load or save, never
     * `id`, the question that was live a moment ago. That distinction is the
     * point of the decision: Text → Zahl → Datum is *one* type change as far
     * as anyone comparing published revisions is concerned, so the second hop
     * must still point at the original Text question, not at the Zahl
     * question that only existed inside this session. A revert carries no
     * `replaces` at all — the question is its origin again, and a reference
     * to itself would make `publishDiff` report a change that never
     * happened. A question with no origin (the case named in the first
     * addendum) never gets one
     * either, for the same reason it never reverts: there is nothing on
     * record for it to point back to.
     */
    changeQuestionType: (id, type, newId) => {
      set((state) => {
        // Checked up front, not folded into the `map` below, because a flag
        // flipped inside that closure would be a second thing to keep in
        // sync with the loop instead of one question answered once.
        const exists = state.pages.some((page) =>
          page.questions.some((question) => question.id === id),
        );
        if (!exists) {
          return {};
        }

        const origin = questionOrigins.get(id);
        const revertsToOrigin = origin?.type === type;
        const resolvedId = revertsToOrigin ? origin.id : newId;
        const replaces =
          origin !== undefined && !revertsToOrigin ? origin.id : undefined;

        const pages = state.pages.map((page) => {
          const index = page.questions.findIndex(
            (question) => question.id === id,
          );
          const old = page.questions[index];
          if (index === -1 || old === undefined) {
            return page;
          }
          const fresh: Question = {
            ...baseForType(type, resolvedId, origin),
            label: old.label,
            hint: old.hint,
            required: old.required,
            width: old.width,
            // Spread rather than always assigning `replaces: replaces`: the
            // field must genuinely be *absent* when there is nothing to
            // point at, not present-and-`undefined` — a test can tell the
            // two apart with `toHaveProperty`, and a future strict schema
            // upstream may too.
            ...(replaces === undefined ? {} : { replaces }),
          };
          const questions = [...page.questions];
          questions[index] = fresh;
          return { ...page, questions };
        });

        if (origin !== undefined) {
          // The question now lives under `resolvedId` — carry its origin
          // forward so a later change can still find the way back, including
          // right after a revert: `resolvedId` then equals `origin.id`, and
          // this re-affirms the self-mapping `rememberOrigins` set up for it.
          questionOrigins.set(resolvedId, origin);
        }

        return {
          pages,
          // The properties panel reads `selectedQuestionId`; without this the
          // panel would go blank the instant the id it was showing stopped
          // existing, right when the user is watching the field they just
          // changed.
          selectedQuestionId:
            state.selectedQuestionId === id
              ? resolvedId
              : state.selectedQuestionId,
          isDirty: true,
        };
      });
    },

    deleteQuestion: (id) => {
      set((state) => ({
        pages: state.pages.map((page) => ({
          ...page,
          questions: page.questions.filter((question) => question.id !== id),
        })),
        selectedQuestionId:
          state.selectedQuestionId === id ? null : state.selectedQuestionId,
        isDirty: true,
      }));
    },

    /**
     * Reorder, and dock to half width when the pointer was on a side third
     * (the requirements).
     *
     * Both cards become `half` on a side drop — the dragged one and the target —
     * because half width is a *pair*: a single half-width card next to nothing
     * would leave a gap the handoff does not show. The card that was aimed at
     * is the one that ends up next to the dragged card, even when it was
     * already docked to someone else; that partner is released.
     *
     * `before`/`after` is the **way back out**: a card dragged to a new place in
     * the column asked for a place of its own, so it becomes full width again.
     * Its former partner is then alone in its row, and `withPairedWidths` (in `@formsache/shared`) widens
     * that one too — which is why the reverse gesture needs no code of its own
     * for the card left behind.
     *
     * The zone carries the *side*, and it has to: the insertion index is read
     * after the dragged card has been lifted out, so "before the next card down"
     * and "where I came from" are the same index. That is why a `mid` zone that
     * always meant "before" let cards move up but never down.
     */
    moveQuestion: (fromId, toId, zone) => {
      set((state) => {
        if (fromId === toId) {
          return { dragOverQuestionId: null, dragZone: null };
        }

        const pages = state.pages.map((page, index) => {
          if (index !== state.activePageIndex) {
            return page;
          }

          const questions = [...page.questions];
          const fromIndex = questions.findIndex(
            (question) => question.id === fromId,
          );
          if (fromIndex === -1) {
            return page;
          }
          const [moved] = questions.splice(fromIndex, 1);
          if (moved === undefined) {
            return page;
          }

          const docks = zone === 'left' || zone === 'right';
          const dragged: Question = {
            ...moved,
            ...(docks ? HALF_WIDTH : FULL_WIDTH),
          };
          const targetIndex = questions.findIndex(
            (question) => question.id === toId,
          );

          // Docking is *aimed*: the card under the pointer becomes the
          // partner, so a row it already belongs to is dissolved first — and
          // before the dragged card is inserted, or the front-to-back repair
          // would read the new neighbours as the old row and hand the target
          // back to its previous partner.
          const rest =
            docks && targetIndex !== -1
              ? withReleasedRow(questions, targetIndex).map(
                  (question, index) =>
                    index === targetIndex
                      ? { ...question, ...HALF_WIDTH }
                      : question,
                )
              : questions;

          const behind = zone === 'right' || zone === 'after';
          const insertAt =
            targetIndex === -1
              ? rest.length
              : behind
                ? targetIndex + 1
                : targetIndex;
          rest.splice(insertAt, 0, dragged);

          return { ...page, questions: rest };
        });

        return {
          pages,
          dragOverQuestionId: null,
          dragZone: null,
          draggingQuestionId: null,
          isDirty: true,
        };
      });
    },

    /**
     * Width from the properties panel — and the keyboard's only way into a
     * docked row, which is why it is not a plain field edit.
     *
     * Half width is a pair however it is reached. Setting one card to `half`
     * alone would be undone by the invariant on the way in, so the neighbour is
     * docked with it: the card *after* it, or the one before it when there is no
     * card after — and, exactly like the docking gesture, that neighbour is
     * freed from the row it is in today. Without that release the control was
     * measurably dead for the last card of a page whose predecessor was already
     * docked: the widths changed, the front-to-back repair took them straight
     * back, and the form was left claiming unsaved changes.
     *
     * A card that finds no neighbour at all stays full width — a single half
     * card on a page is exactly the gap the invariant exists to prevent — and
     * that attempt leaves the document (and `isDirty`) untouched.
     *
     * The other direction needs no partner handling: `full` strands the former
     * partner, and the invariant widens it.
     */
    setQuestionWidth: (id, width) => {
      set((state) => {
        const pages = withPairedPageWidths(
          state.pages.map((page) => {
            const index = page.questions.findIndex(
              (question) => question.id === id,
            );
            if (index === -1) {
              return page;
            }
            // Already docked and asked to dock again: nothing to do, and
            // re-running the pairing would tear up an intact row.
            if (
              width === 'half' &&
              rowPartnerIndex(page.questions, index) !== -1
            ) {
              return page;
            }
            const partnerIndex =
              width === 'half'
                ? index + 1 < page.questions.length
                  ? index + 1
                  : index - 1
                : -1;

            const questions =
              partnerIndex === -1
                ? page.questions
                : withReleasedRow(page.questions, partnerIndex);

            return {
              ...page,
              questions: questions.map((question, current) =>
                current === index || current === partnerIndex
                  ? { ...question, width }
                  : question,
              ),
            };
          }),
        );

        // A change the invariant takes straight back is no change: the card
        // found no partner, so it stays full width. Marking the form unsaved
        // for a width nobody can see would send an empty save on the next
        // click and leave „Nicht gespeichert" standing until then.
        return sameWidths(pages, state.pages) ? {} : { pages, isDirty: true };
      });
    },

    /**
     * One step left/right in the question order — the keyboard's drag.
     *
     * Deliberately *not* a width change: docking is a spatial gesture, and there
     * is no keyboard equivalent of "the left third of that card". Width is set
     * in the properties panel instead, which is reachable by Tab.
     */
    nudgeQuestion: (id, direction) => {
      set((state) => ({
        pages: state.pages.map((page, index) => {
          if (index !== state.activePageIndex) {
            return page;
          }
          const questions = [...page.questions];
          const from = questions.findIndex((question) => question.id === id);
          const to = direction === 'prev' ? from - 1 : from + 1;
          if (from === -1 || to < 0 || to >= questions.length) {
            return page;
          }
          const [moved] = questions.splice(from, 1);
          if (moved === undefined) {
            return page;
          }
          questions.splice(to, 0, moved);
          return { ...page, questions };
        }),
        isDirty: true,
      }));
    },

    nudgePage: (index, direction) => {
      const to = direction === 'prev' ? index - 1 : index + 1;
      get().movePage(index, to);
    },

    beginQuestionDrag: (id) => {
      set({ draggingQuestionId: id, selectedQuestionId: id });
    },

    setDragTarget: (overId, zone) => {
      set({ dragOverQuestionId: overId, dragZone: zone });
    },

    endQuestionDrag: () => {
      set({
        draggingQuestionId: null,
        dragOverQuestionId: null,
        dragZone: null,
      });
    },

    /**
     * A page row has been picked up.
     *
     * Separate from `pageDropIndex` because the two answer different questions:
     * *this row is lifted* (which the list shows on the row itself) and *it
     * would land here* (an insertion line in a gap). While both were the same
     * number, a drag started by marking its own row as a drop target — a line
     * that promised a move which would not happen.
     */
    beginPageDrag: (index) => {
      set({ draggingPageIndex: index, pageDropIndex: null });
    },

    setPageDropIndex: (index) => {
      set({ pageDropIndex: index });
    },

    endPageDrag: () => {
      set({ draggingPageIndex: null, pageDropIndex: null });
    },
  };
});

/** The page currently shown, or undefined while nothing is loaded. */
export function activePage(state: BuilderState): FormPage | undefined {
  return state.pages[state.activePageIndex];
}

/** The selected question of the active page, or undefined. */
export function selectedQuestion(state: BuilderState): Question | undefined {
  if (state.selectedQuestionId === null) {
    return undefined;
  }
  return activePage(state)?.questions.find(
    (question) => question.id === state.selectedQuestionId,
  );
}

/** The document as the save route wants it. */
export function currentDefinition(state: BuilderState): FormDefinition {
  return { pages: state.pages };
}
