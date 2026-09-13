import { formDefinitionSchema, type FormDefinition } from '@formsache/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  activePage,
  currentDefinition,
  useBuilderStore,
} from './builder-store';

/**
 * The document rules for reordering, docking to half width, and saving.
 *
 * The store is a reducer, so it is tested as one — no rendering, no DOM. Two
 * things are asserted throughout and are worth naming:
 *
 * - **The result still parses.** Every reorder ends with
 *   `formDefinitionSchema` over the document, because a builder that produces
 *   something the server refuses is worse than one that refuses to produce it.
 * - **`isDirty` tracks reality.** It is the difference between "saved" and
 *   "not saved" in the UI, and a flag that lies there loses work.
 */

const P1 = '019fe100-0000-7000-8000-0000000000a1';
const P2 = '019fe100-0000-7000-8000-0000000000a2';
const Q1 = '019fe100-0000-7000-8000-000000000001';
const Q2 = '019fe100-0000-7000-8000-000000000002';
const Q3 = '019fe100-0000-7000-8000-000000000003';
/** The id a type change mints for the replacement question. */
const Q_NEW = '019fe100-0000-7000-8000-000000000009';
/** A second and third fresh id, for the multi-hop revert tests. */
const Q_NEW2 = '019fe100-0000-7000-8000-00000000000a';
const Q_NEW3 = '019fe100-0000-7000-8000-00000000000b';

function question(id: string, label: string, width: 'full' | 'half' = 'full') {
  return {
    id,
    type: 'text' as const,
    label,
    hint: null,
    required: false,
    width,
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function definition(): FormDefinition {
  return formDefinitionSchema.parse({
    pages: [
      {
        id: P1,
        title: 'Seite 1',
        questions: [
          question(Q1, 'Eins'),
          question(Q2, 'Zwei'),
          question(Q3, 'Drei'),
        ],
      },
      { id: P2, title: 'Seite 2', questions: [] },
    ],
  });
}

function loadFixture(): void {
  useBuilderStore.getState().load({
    id: 'form-1',
    title: 'Testformular',
    definition: definition(),
    revision: 3,
  });
}

/** Question labels of the active page, in order — the thing a reorder changes. */
function order(): string[] {
  const page = activePage(useBuilderStore.getState());
  return (page?.questions ?? []).map((entry) => entry.label);
}

function widths(): string[] {
  const page = activePage(useBuilderStore.getState());
  return (page?.questions ?? []).map((entry) => entry.width);
}

/** Every test ends by proving the document is still one the server accepts. */
function expectParses(): void {
  const result = formDefinitionSchema.safeParse(
    currentDefinition(useBuilderStore.getState()),
  );
  expect(result.success).toBe(true);
}

describe('builder store', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    loadFixture();
  });

  /**
   * Inserting a template. The block arrives **ready** —
   * ids and conditions are the server's — so what is asserted here is that the
   * store takes it as it stands: it must not renumber, reorder or normalise
   * anything, or the ids the server minted would not be the ids in the
   * document that gets saved.
   */
  describe('inserting a Vorlage', () => {
    const TPL_PAGE = '019fe100-0000-7000-8000-0000000000c1';
    const TPL_Q = '019fe100-0000-7000-8000-0000000000c2';

    it('appends the page as it came, makes it active and marks the form unsaved', () => {
      useBuilderStore.getState().insertTemplatePage({
        id: TPL_PAGE,
        title: 'Aus einer Vorlage',
        description: null,
        questions: [question(TPL_Q, 'Vorlagenfrage')],
      });

      const state = useBuilderStore.getState();
      expect(state.pages).toHaveLength(3);
      expect(state.pages[2]?.id).toBe(TPL_PAGE);
      expect(state.pages[2]?.questions[0]?.id).toBe(TPL_Q);
      expect(state.activePageIndex).toBe(2);
      expect(state.selectedQuestionId).toBeNull();
      expect(state.isDirty).toBe(true);
      expectParses();
    });

    it('appends the question to the page in view and selects it', () => {
      useBuilderStore.getState().selectPage(1);
      useBuilderStore
        .getState()
        .insertTemplateQuestion(question(TPL_Q, 'Vorlagenfrage'));

      const state = useBuilderStore.getState();
      expect(state.pages[0]?.questions).toHaveLength(3);
      expect(state.pages[1]?.questions.map((entry) => entry.id)).toStrictEqual([
        TPL_Q,
      ]);
      expect(state.selectedQuestionId).toBe(TPL_Q);
      expect(state.isDirty).toBe(true);
      expectParses();
    });
  });

  it('starts clean after loading, and dirties on the first change', () => {
    expect(useBuilderStore.getState().isDirty).toBe(false);

    useBuilderStore.getState().setTitle('Anders');
    expect(useBuilderStore.getState().isDirty).toBe(true);

    // A save does not change the document, only the revision it is measured
    // against.
    useBuilderStore.getState().markSaved(4);
    expect(useBuilderStore.getState().isDirty).toBe(false);
    expect(useBuilderStore.getState().revision).toBe(4);
  });

  describe('pages', () => {
    it('adds a page and follows it', () => {
      useBuilderStore.getState().addPage();

      expect(useBuilderStore.getState().pages).toHaveLength(3);
      expect(useBuilderStore.getState().activePageIndex).toBe(2);
      expectParses();
    });

    it('renames and deletes', () => {
      useBuilderStore.getState().renamePage(1, 'Semester');
      expect(useBuilderStore.getState().pages[1]?.title).toBe('Semester');

      useBuilderStore.getState().deletePage(1);
      expect(useBuilderStore.getState().pages).toHaveLength(1);
      expectParses();
    });

    /** The requirement — the page description, edited the same way the title is. */
    it('sets and clears a page description', () => {
      useBuilderStore.getState().setPageDescription(1, 'Bitte pünktlich.');
      expect(useBuilderStore.getState().pages[1]?.description).toBe(
        'Bitte pünktlich.',
      );
      expect(useBuilderStore.getState().isDirty).toBe(true);
      expectParses();

      // Empty means "no description" — the same choice `hint` makes, spelled
      // `null` rather than `''` in the stored document.
      useBuilderStore.getState().setPageDescription(1, '');
      expect(useBuilderStore.getState().pages[1]?.description).toBeNull();
      expectParses();
    });

    /**
     * The case to be *defined*. Refused, not silently
     * replaced by a fresh page: a substitution would discard the questions
     * while looking like a deletion that worked.
     */
    it('refuses to delete the last page', () => {
      useBuilderStore.getState().deletePage(1);
      const before = useBuilderStore.getState().pages;

      useBuilderStore.getState().deletePage(0);

      expect(useBuilderStore.getState().pages).toStrictEqual(before);
      expectParses();
    });

    it('moves a page and carries the active one with it', () => {
      // Looking at page 1 (index 0), which is moved to the end.
      useBuilderStore.getState().selectPage(0);
      useBuilderStore.getState().movePage(0, 1);

      expect(useBuilderStore.getState().pages[1]?.id).toBe(P1);
      // Still looking at the same page, now at another index.
      expect(useBuilderStore.getState().activePageIndex).toBe(1);
      expectParses();
    });

    it('adjusts the active index when another page moves past it', () => {
      useBuilderStore.getState().selectPage(1);
      // Page 0 moves behind the active one, so the active one shifts up.
      useBuilderStore.getState().movePage(0, 1);

      expect(useBuilderStore.getState().activePageIndex).toBe(0);
    });

    /**
     * The transient half of a page drag. It exists so the list can show that a
     * row is *lifted* and where it would land — without that, a downward drag
     * gives no feedback at all until it is released, which is precisely what
     * "moving pages only works upwards" felt like.
     */
    describe('the drag marks of a page row', () => {
      it('marks the dragged row and clears it again on drop', () => {
        useBuilderStore.getState().beginPageDrag(0);

        expect(useBuilderStore.getState().draggingPageIndex).toBe(0);
        // Picking a row up is not an edit — nothing to save yet.
        expect(useBuilderStore.getState().isDirty).toBe(false);

        useBuilderStore.getState().movePage(0, 1);
        expect(useBuilderStore.getState().draggingPageIndex).toBeNull();
        expect(useBuilderStore.getState().pageDropIndex).toBeNull();
      });

      it('clears the marks even when the move goes nowhere', () => {
        useBuilderStore.getState().beginPageDrag(1);
        useBuilderStore.getState().setPageDropIndex(2);

        useBuilderStore.getState().movePage(1, 1);

        expect(useBuilderStore.getState().draggingPageIndex).toBeNull();
        expect(useBuilderStore.getState().pageDropIndex).toBeNull();
      });

      it('ends a cancelled drag without touching the document', () => {
        const before = useBuilderStore.getState().pages;
        useBuilderStore.getState().beginPageDrag(0);
        useBuilderStore.getState().setPageDropIndex(2);

        useBuilderStore.getState().endPageDrag();

        expect(useBuilderStore.getState().pages).toStrictEqual(before);
        expect(useBuilderStore.getState().draggingPageIndex).toBeNull();
        expect(useBuilderStore.getState().pageDropIndex).toBeNull();
        expect(useBuilderStore.getState().isDirty).toBe(false);
      });
    });

    it('ignores a move that goes nowhere or out of bounds', () => {
      const before = useBuilderStore.getState().pages;

      useBuilderStore.getState().movePage(0, 0);
      useBuilderStore.getState().movePage(0, 9);
      useBuilderStore.getState().movePage(-1, 0);

      expect(useBuilderStore.getState().pages).toStrictEqual(before);
    });
  });

  describe('reordering questions', () => {
    it('moves a card in front of the target on a "before" drop', () => {
      useBuilderStore.getState().moveQuestion(Q3, Q1, 'before');

      expect(order()).toStrictEqual(['Drei', 'Eins', 'Zwei']);
      expectParses();
    });

    /**
     * The reported bug, in the store: dragging *downwards* has to land the
     * card behind its target. While every reorder meant "before the target",
     * the card was lifted out and put back into the very slot it came from —
     * upwards worked, downwards did nothing at all.
     */
    it('moves a card behind the target on an "after" drop', () => {
      useBuilderStore.getState().moveQuestion(Q1, Q2, 'after');

      expect(order()).toStrictEqual(['Zwei', 'Eins', 'Drei']);
      expectParses();
    });

    it('moves a card to the very end on an "after" drop onto the last one', () => {
      useBuilderStore.getState().moveQuestion(Q1, Q3, 'after');

      expect(order()).toStrictEqual(['Zwei', 'Drei', 'Eins']);
    });

    it('moves a card behind the target on a right drop', () => {
      useBuilderStore.getState().moveQuestion(Q1, Q3, 'right');

      expect(order()).toStrictEqual(['Zwei', 'Drei', 'Eins']);
    });

    it('does nothing when a card is dropped on itself', () => {
      useBuilderStore.getState().moveQuestion(Q1, Q1, 'before');

      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
    });
  });

  describe('docking to half width', () => {
    /**
     * Half width is a **pair**. Both cards are set, not just the dragged one —
     * a single half-width card next to nothing leaves a gap the handoff does
     * not show.
     */
    it('sets both cards to half width on a side drop', () => {
      useBuilderStore.getState().moveQuestion(Q3, Q1, 'left');

      expect(order()).toStrictEqual(['Drei', 'Eins', 'Zwei']);
      expect(widths()).toStrictEqual(['half', 'half', 'full']);
      expectParses();
    });

    it('leaves widths alone on a reordering drop', () => {
      useBuilderStore.getState().moveQuestion(Q3, Q1, 'before');
      expect(widths()).toStrictEqual(['full', 'full', 'full']);

      useBuilderStore.getState().moveQuestion(Q3, Q1, 'after');
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });
  });

  /**
   * The way *out* of a docked row, and the invariant that keeps it honest
   * (reported: „bei zwei Feldern die nebeneinander sind, kommt man nicht mehr
   * zurück zu beide volle Breite").
   *
   * Docking was a one-way street: `left`/`right` set both cards to `half` and
   * nothing anywhere set them back. The fix is not a second gesture but a rule
   * — **a half-width card always has a half-width partner next to it** — plus
   * the reverse gesture: dragging a card out of its row with `before`/`after`
   * makes it full again, which strands its partner, which the rule then widens.
   */
  describe('leaving a docked row', () => {
    /** Loads a page whose first two cards are docked to each other. */
    function loadDocked(): void {
      useBuilderStore.getState().load({
        id: 'form-1',
        title: 'Testformular',
        definition: formDefinitionSchema.parse({
          pages: [
            {
              id: P1,
              title: 'Seite 1',
              questions: [
                question(Q1, 'Eins', 'half'),
                question(Q2, 'Zwei', 'half'),
                question(Q3, 'Drei'),
              ],
            },
            { id: P2, title: 'Seite 2', questions: [] },
          ],
        }),
        revision: 3,
      });
    }

    beforeEach(loadDocked);

    it('widens both cards when one is dragged out of the row', () => {
      useBuilderStore.getState().moveQuestion(Q1, Q3, 'after');

      expect(order()).toStrictEqual(['Zwei', 'Drei', 'Eins']);
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
      expectParses();
    });

    it('widens both cards when the row is left in the other direction', () => {
      useBuilderStore.getState().moveQuestion(Q2, Q3, 'before');

      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });

    it('widens the partner left behind when a card is deleted', () => {
      useBuilderStore.getState().deleteQuestion(Q1);

      expect(widths()).toStrictEqual(['full', 'full']);
      expectParses();
    });

    it('widens the partner left behind by a keyboard move', () => {
      // „Zwei" steps past „Drei", so „Eins" is left alone in its row.
      useBuilderStore.getState().nudgeQuestion(Q2, 'next');

      expect(order()).toStrictEqual(['Eins', 'Drei', 'Zwei']);
      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });

    it('keeps a pair intact while the two only swap places', () => {
      useBuilderStore.getState().nudgeQuestion(Q1, 'next');

      expect(order()).toStrictEqual(['Zwei', 'Eins', 'Drei']);
      expect(widths()).toStrictEqual(['half', 'half', 'full']);
    });

    /**
     * A row holds two cards, so a third half-width card in a run starts a row
     * of its own — where it would stand next to the gap the handoff does not
     * show. It is widened, and the pair before it is not disturbed.
     */
    it('widens the odd card out of a run of three', () => {
      useBuilderStore.getState().load({
        id: 'form-1',
        title: 'Testformular',
        definition: formDefinitionSchema.parse({
          pages: [
            {
              id: P1,
              title: 'Seite 1',
              questions: [
                question(Q1, 'Eins', 'half'),
                question(Q2, 'Zwei', 'half'),
                question(Q3, 'Drei', 'half'),
              ],
            },
          ],
        }),
        revision: 3,
      });

      expect(widths()).toStrictEqual(['half', 'half', 'full']);
      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
    });

    /**
     * Docking is *aimed*, and the aim decides the row — even when the target
     * is already docked to someone else.
     *
     * Measured before the fix: `moveQuestion(Q3, Q2, 'left')` produced
     * `['Eins:half', 'Drei:half', 'Zwei:full']` — the card landed next to
     * „Eins", which nobody aimed at, and the target it *was* aimed at was
     * thrown out of its row. The front-to-back repair kept the older pair.
     */
    it('takes the target out of its old row when a card docks to it', () => {
      useBuilderStore.getState().moveQuestion(Q3, Q2, 'left');

      expect(order()).toStrictEqual(['Eins', 'Drei', 'Zwei']);
      expect(widths()).toStrictEqual(['full', 'half', 'half']);
      expectParses();
    });

    it('does the same when the drop is on the right of a docked card', () => {
      const Q4 = '019fe100-0000-7000-8000-000000000004';
      useBuilderStore.getState().addQuestion('text', Q4);
      useBuilderStore.getState().moveQuestion(Q4, Q2, 'right');

      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Text', 'Drei']);
      expect(widths()).toStrictEqual(['full', 'half', 'half', 'full']);
      expectParses();
    });

    /** A document that arrives with an orphan is repaired, not displayed. */
    it('repairs a stray half card that came in from the server', () => {
      useBuilderStore.getState().load({
        id: 'form-1',
        title: 'Testformular',
        definition: formDefinitionSchema.parse({
          pages: [
            {
              id: P1,
              title: 'Seite 1',
              questions: [question(Q1, 'Eins', 'half'), question(Q2, 'Zwei')],
            },
          ],
        }),
        revision: 3,
      });

      expect(widths()).toStrictEqual(['full', 'full']);
    });

    /**
     * The properties panel is the keyboard's only way to half width, so
     * it cannot be a plain field: setting one card to `half` alone would be
     * undone by the invariant the moment it is applied. It docks the neighbour
     * instead — half width is a pair however it is reached.
     */
    describe('the width control of the properties panel', () => {
      it('releases the partner when a card is set back to full width', () => {
        useBuilderStore.getState().setQuestionWidth(Q1, 'full');

        expect(widths()).toStrictEqual(['full', 'full', 'full']);
        expect(useBuilderStore.getState().isDirty).toBe(true);
      });

      it('docks the following card when a card is set to half width', () => {
        useBuilderStore.getState().setQuestionWidth(Q1, 'full');
        useBuilderStore.getState().setQuestionWidth(Q2, 'half');

        expect(widths()).toStrictEqual(['full', 'half', 'half']);
        expectParses();
      });

      it('falls back to the preceding card for the last one', () => {
        useBuilderStore.getState().setQuestionWidth(Q1, 'full');
        useBuilderStore.getState().setQuestionWidth(Q3, 'half');

        expect(widths()).toStrictEqual(['full', 'half', 'half']);
      });

      /**
       * „Halbe Breite" on the last card, whose only neighbour is already
       * docked to someone else. Measured before the fix: the widths came back
       * as `['half', 'half', 'full']` with `isDirty` set — the select sprang
       * back and the form claimed unsaved changes for a layout nobody could
       * see. The neighbour is released instead, so the choice takes effect.
       */
      it('frees the neighbour from its old row instead of springing back', () => {
        useBuilderStore.getState().setQuestionWidth(Q3, 'half');

        expect(widths()).toStrictEqual(['full', 'half', 'half']);
        expect(useBuilderStore.getState().isDirty).toBe(true);
        expectParses();
      });

      /**
       * The one case that really has no answer: a page with a single card has
       * no neighbour to pair with. The card stays full width — and the attempt
       * leaves the document alone, so nothing claims to be unsaved.
       */
      it('leaves a single card on its page full width', () => {
        useBuilderStore.getState().selectPage(1);
        const id = '019fe100-0000-7000-8000-00000000001f';
        useBuilderStore.getState().addQuestion('text', id);
        useBuilderStore.getState().markSaved(4);

        useBuilderStore.getState().setQuestionWidth(id, 'half');

        expect(widths()).toStrictEqual(['full']);
        expect(useBuilderStore.getState().isDirty).toBe(false);
      });
    });
  });

  describe('keyboard moves', () => {
    it('moves one step and stops at the ends', () => {
      useBuilderStore.getState().nudgeQuestion(Q1, 'next');
      expect(order()).toStrictEqual(['Zwei', 'Eins', 'Drei']);

      useBuilderStore.getState().nudgeQuestion(Q1, 'prev');
      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);

      // Already first: nothing to do, and nothing lost.
      useBuilderStore.getState().nudgeQuestion(Q1, 'prev');
      expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
      expectParses();
    });

    /**
     * Deliberately *not* a width change: docking is a spatial gesture with no
     * keyboard equivalent, and silently making a card half width on an arrow
     * key would be a layout change nobody asked for. Width has its own control
     * in the properties panel.
     */
    it('never changes a width', () => {
      useBuilderStore.getState().nudgeQuestion(Q1, 'next');

      expect(widths()).toStrictEqual(['full', 'full', 'full']);
    });

    it('moves pages the same way', () => {
      useBuilderStore.getState().nudgePage(0, 'next');

      expect(useBuilderStore.getState().pages[1]?.id).toBe(P1);
    });
  });

  describe('questions', () => {
    it('adds a question of the chosen type and selects it', () => {
      const id = '019fe100-0000-7000-8000-00000000000f';
      useBuilderStore.getState().addQuestion('select', id);

      const page = activePage(useBuilderStore.getState());
      expect(page?.questions.at(-1)?.type).toBe('select');
      expect(useBuilderStore.getState().selectedQuestionId).toBe(id);
      // A fresh dropdown carries options — an empty list would not parse.
      expectParses();
    });

    it('deletes a question and clears the selection when it was selected', () => {
      useBuilderStore.getState().selectQuestion(Q2);
      useBuilderStore.getState().deleteQuestion(Q2);

      expect(order()).toStrictEqual(['Eins', 'Drei']);
      expect(useBuilderStore.getState().selectedQuestionId).toBeNull();
      expectParses();
    });

    /**
     * „⧉ Duplizieren" on a question card. The core of what
     * a copy *is* — fresh id, `replaces` dropped — is `duplicateQuestion` in
     * `@formsache/shared` and is proven there; what is tested here is the store's
     * own half: **where** the copy lands and what it does to the selection.
     */
    describe('duplicating a question', () => {
      const Q_COPY = '019fe100-0000-7000-8000-00000000000c';

      it('inserts the copy directly after the original, with a new id', () => {
        useBuilderStore.getState().duplicateQuestion(Q2, Q_COPY);

        const page = activePage(useBuilderStore.getState());
        const ids = (page?.questions ?? []).map((entry) => entry.id);
        expect(ids).toStrictEqual([Q1, Q2, Q_COPY, Q3]);
        expect(order()).toStrictEqual(['Eins', 'Zwei', 'Zwei', 'Drei']);
        expectParses();
      });

      it('selects the copy and dirties the document', () => {
        useBuilderStore.getState().duplicateQuestion(Q2, Q_COPY);

        expect(useBuilderStore.getState().selectedQuestionId).toBe(Q_COPY);
        expect(useBuilderStore.getState().isDirty).toBe(true);
      });

      it("carries the original's content, not just its label", () => {
        useBuilderStore.getState().updateQuestion(Q2, {
          ...question(Q2, 'Zwei'),
          required: true,
          hint: 'Bitte angeben',
        });
        useBuilderStore.getState().duplicateQuestion(Q2, Q_COPY);

        const page = activePage(useBuilderStore.getState());
        const copy = page?.questions.find((entry) => entry.id === Q_COPY);
        expect(copy?.required).toBe(true);
        expect(copy?.hint).toBe('Bitte angeben');
      });

      it('does nothing for an id that does not exist', () => {
        const before = order();
        useBuilderStore.getState().duplicateQuestion('no-such-id', Q_COPY);

        expect(order()).toStrictEqual(before);
        expect(useBuilderStore.getState().selectedQuestionId).toBeNull();
      });

      /**
       * **Duplicating must not change the width of any other question** (a
       * review finding).
       *
       * *Measured on 2026-08-05:* the copy was spliced between „Eins" and its
       * row partner „Zwei", the invariant repaired from the front, and the
       * orphaned remainder — „Zwei", a question nobody had touched — was
       * widened to full width. The four store tests above do not touch `width`
       * and saw nothing of it.
       *
       * Both cases stand here, because the repair has two parts and each one
       * on its own is incomplete: behind the row *and* at full width.
       */
      describe('the row it lands beside (a review finding)', () => {
        /** „Eins" and „Zwei" next to each other, „Drei" below them. */
        function dockFirstTwo(): void {
          useBuilderStore.getState().setQuestionWidth(Q1, 'half');
          expect(widths()).toStrictEqual(['half', 'half', 'full']);
        }

        it('puts the copy below the whole row and leaves the partner half width', () => {
          dockFirstTwo();
          useBuilderStore.getState().duplicateQuestion(Q1, Q_COPY);

          // Directly below means: in the row under the pair, not into the
          // middle of it.
          expect(order()).toStrictEqual(['Eins', 'Zwei', 'Eins', 'Drei']);
          expect(widths()).toStrictEqual(['half', 'half', 'full', 'full']);
          expect(
            (activePage(useBuilderStore.getState())?.questions ?? []).map(
              (entry) => entry.id,
            ),
          ).toStrictEqual([Q1, Q2, Q_COPY, Q3]);
          expectParses();
        });

        it('leaves the row after it alone as well — a full-width copy ends the row it starts', () => {
          // Four cards, two pairs: the second pair is the part that a
          // half-width insertion would shift by one position.
          const Q4 = '019fe100-0000-7000-8000-000000000004';
          useBuilderStore.getState().addQuestion('text', Q4);
          useBuilderStore.getState().setQuestionWidth(Q1, 'half');
          useBuilderStore.getState().setQuestionWidth(Q3, 'half');
          expect(widths()).toStrictEqual(['half', 'half', 'half', 'half']);

          useBuilderStore.getState().duplicateQuestion(Q1, Q_COPY);

          expect(widths()).toStrictEqual([
            'half',
            'half',
            'full',
            'half',
            'half',
          ]);
          expectParses();
        });
      });
    });

    it('drops the selection when the page changes', () => {
      useBuilderStore.getState().selectQuestion(Q1);
      useBuilderStore.getState().selectPage(1);

      // A question of page 1 left selected while page 2 is shown would drive
      // the properties panel from a card nobody can see.
      expect(useBuilderStore.getState().selectedQuestionId).toBeNull();
    });

    /**
     * Konzept no. 24: a type change mints a new id rather than editing
     * `type` in place, so that every already-published revision keeps
     * pointing at the retired question and its answers. The store itself
     * never looks at answers — see `changeQuestionType`'s doc comment — so
     * what is tested here is the document-shaped half of the promise: id,
     * position, width/pairing and selection.
     */
    describe('changing type (Konzept Nr. 24)', () => {
      it('gives the question a new id instead of editing its type', () => {
        useBuilderStore.getState().changeQuestionType(Q2, 'number', Q_NEW);

        const page = activePage(useBuilderStore.getState());
        const ids = (page?.questions ?? []).map((entry) => entry.id);
        expect(ids).toStrictEqual([Q1, Q_NEW, Q3]);
        expect(page?.questions[1]?.type).toBe('number');
        expectParses();
      });

      it('keeps the question in its place', () => {
        expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);

        useBuilderStore.getState().changeQuestionType(Q2, 'number', Q_NEW);

        // Same slot, not appended at the end — „Zwei" stays between „Eins" and
        // „Drei", it does not jump to where a freshly added question would go.
        expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[1]?.id).toBe(Q_NEW);
      });

      it('carries the label and the required flag over, but not type-specific rules', () => {
        useBuilderStore.getState().updateQuestion(Q1, {
          ...question(Q1, 'Eins'),
          label: 'Vorname',
          required: true,
          pattern: '^[A-Z].*$',
        });

        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);

        const page = activePage(useBuilderStore.getState());
        const changed = page?.questions[0];
        expect(changed?.label).toBe('Vorname');
        expect(changed?.required).toBe(true);
        // A text pattern reapplied to a number question would not even parse.
        expect(changed).not.toHaveProperty('pattern');
        expectParses();
      });

      it('moves the selection to the new id when the question was selected', () => {
        useBuilderStore.getState().selectQuestion(Q2);
        useBuilderStore.getState().changeQuestionType(Q2, 'date', Q_NEW);

        // Otherwise the properties panel would go blank on the exact field the
        // user just changed.
        expect(useBuilderStore.getState().selectedQuestionId).toBe(Q_NEW);
      });

      it('leaves the selection alone when a different question changes type', () => {
        useBuilderStore.getState().selectQuestion(Q1);
        useBuilderStore.getState().changeQuestionType(Q2, 'date', Q_NEW);

        expect(useBuilderStore.getState().selectedQuestionId).toBe(Q1);
      });

      it('keeps a docked pair intact — the width, and with it the row, survives the swap', () => {
        useBuilderStore.getState().load({
          id: 'form-1',
          title: 'Testformular',
          definition: formDefinitionSchema.parse({
            pages: [
              {
                id: P1,
                title: 'Seite 1',
                questions: [
                  question(Q1, 'Eins', 'half'),
                  question(Q2, 'Zwei', 'half'),
                  question(Q3, 'Drei'),
                ],
              },
              { id: P2, title: 'Seite 2', questions: [] },
            ],
          }),
          revision: 3,
        });

        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);

        // Neither card widened back to full: the invariant only repairs a
        // half-width card left *without* a partner, and this one still has
        // one — its neighbour never moved.
        expect(widths()).toStrictEqual(['half', 'half', 'full']);
        expect(order()).toStrictEqual(['Eins', 'Zwei', 'Drei']);
        expectParses();
      });
    });

    /**
     * Addendum of 2026-07-27 to Konzept no. 24: switching back to the
     * type a question had at the last load or save undoes the retirement
     * instead of adding another one — same id, same type-specific settings.
     */
    describe('switching back to the type it started with (addendum 2026-07-27)', () => {
      /** A text question with real type-specific settings, not just nulls. */
      function textWithPattern(id: string, label: string) {
        return {
          id,
          type: 'text' as const,
          label,
          hint: null,
          required: false,
          width: 'full' as const,
          minLength: 2,
          maxLength: 10,
          pattern: '^[A-Z].*$',
        };
      }

      it('restores the original id and its type-specific settings on the way back', () => {
        useBuilderStore.getState().load({
          id: 'form-1',
          title: 'Testformular',
          definition: formDefinitionSchema.parse({
            pages: [
              {
                id: P1,
                title: 'Seite 1',
                questions: [
                  textWithPattern(Q1, 'Eins'),
                  question(Q2, 'Zwei'),
                  question(Q3, 'Drei'),
                ],
              },
              { id: P2, title: 'Seite 2', questions: [] },
            ],
          }),
          revision: 3,
        });

        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        const page = activePage(useBuilderStore.getState());
        // Not just the id: the original validation is back too — handing
        // back the id while Muster/Min/Max stayed lost would be „als wäre
        // nichts geschehen" in name only.
        expect(page?.questions[0]).toMatchObject({
          id: Q1,
          type: 'text',
          pattern: '^[A-Z].*$',
          minLength: 2,
          maxLength: 10,
        });
        expectParses();
      });

      it('keeps an edit made along the way — the revert does not reset label or required', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().updateQuestion(Q_NEW, {
          id: Q_NEW,
          type: 'number',
          label: 'Unterwegs umbenannt',
          hint: null,
          required: true,
          width: 'full',
          min: null,
          max: null,
          integer: false,
        });

        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]).toMatchObject({
          id: Q1,
          label: 'Unterwegs umbenannt',
          required: true,
        });
      });

      /**
       * Case 1: a question added in this session was never loaded or saved,
       * so it has no origin to return to. Switching it back to the type it
       * was created with is not special-cased — it just never finds an
       * origin, and behaves like any other type change.
       */
      it('never reverts a question that did not exist at the last load or save', () => {
        const freshId = '019fe100-0000-7000-8000-0000000000f0';
        useBuilderStore.getState().addQuestion('text', freshId);

        useBuilderStore.getState().changeQuestionType(freshId, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        const page = activePage(useBuilderStore.getState());
        const last = page?.questions.at(-1);
        expect(last?.id).toBe(Q_NEW2);
        expect(last?.id).not.toBe(freshId);
        expectParses();
      });

      /**
       * Case 2: several hops (Text → Zahl → Datum → Text) must land back on
       * the *original* id, not on the id of an intermediate detour.
       */
      it('walks back through several hops to the original id, not an intermediate one', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'date', Q_NEW2);
        useBuilderStore.getState().changeQuestionType(Q_NEW2, 'text', Q_NEW3);

        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]?.id).toBe(Q1);
        expect(page?.questions[0]?.type).toBe('text');
        expectParses();
      });

      /**
       * Case 4: a successful save moves the baseline. Switching back to what
       * was the type *before* the save must not reach past the save to the
       * pre-save id — the saved draft is the truth from here on.
       */
      it('does not revert past a save — the saved draft is the new baseline', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().markSaved(4);

        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]?.id).toBe(Q_NEW2);
        expect(page?.questions[0]?.id).not.toBe(Q1);
        expectParses();
      });

      /** Case 5: the paired row must survive the way back exactly as the way out. */
      it('keeps a docked pair intact on the way back too', () => {
        useBuilderStore.getState().load({
          id: 'form-1',
          title: 'Testformular',
          definition: formDefinitionSchema.parse({
            pages: [
              {
                id: P1,
                title: 'Seite 1',
                questions: [
                  question(Q1, 'Eins', 'half'),
                  question(Q2, 'Zwei', 'half'),
                  question(Q3, 'Drei'),
                ],
              },
              { id: P2, title: 'Seite 2', questions: [] },
            ],
          }),
          revision: 3,
        });

        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        expect(widths()).toStrictEqual(['half', 'half', 'full']);
        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]?.id).toBe(Q1);
        expectParses();
      });
    });

    /**
     * Konzept no. 26: the new question of a type change carries a
     * reference to the id it replaces, so `publishDiff` (parallel work in
     * `packages/shared`) can show a type change as one change instead of "one
     * removed, one added" with nothing connecting the two. The field itself
     * (`replaces?: string`) is not part of `Question` in `packages/shared`
     * yet — see `WithReplaces` in `builder-store.ts`.
     */
    describe('the reference to the question it replaces (Konzept Nr. 26)', () => {
      it('points at the origin on a forward hop', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);

        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]).toMatchObject({ id: Q_NEW, replaces: Q1 });
      });

      it('points at the checkpoint, not the previous hop, after several changes', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'date', Q_NEW2);

        // One type change from the reviewer's point of view (Text → Datum),
        // so the reference is Q1 — not Q_NEW, the id that only existed for
        // the moment in between.
        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]).toMatchObject({ id: Q_NEW2, replaces: Q1 });
      });

      it('disappears when the type reverts to the origin — the question is itself again', () => {
        useBuilderStore.getState().changeQuestionType(Q1, 'number', Q_NEW);
        useBuilderStore.getState().changeQuestionType(Q_NEW, 'text', Q_NEW2);

        const page = activePage(useBuilderStore.getState());
        expect(page?.questions[0]?.id).toBe(Q1);
        // A self-reference would make `publishDiff` report a type change
        // that never happened.
        expect(page?.questions[0]).not.toHaveProperty('replaces');
      });

      it('is never set for a question that did not exist at the last load or save', () => {
        const freshId = '019fe100-0000-7000-8000-0000000000f1';
        useBuilderStore.getState().addQuestion('text', freshId);

        useBuilderStore.getState().changeQuestionType(freshId, 'number', Q_NEW);

        const page = activePage(useBuilderStore.getState());
        const last = page?.questions.at(-1);
        expect(last?.id).toBe(Q_NEW);
        expect(last).not.toHaveProperty('replaces');
      });
    });
  });

  it('empties itself on reset, so another form cannot show these pages', () => {
    useBuilderStore.getState().reset();

    expect(useBuilderStore.getState().pages).toStrictEqual([]);
    expect(useBuilderStore.getState().formId).toBeNull();
  });
});
