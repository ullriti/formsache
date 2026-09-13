import type { FormPage, Question } from './form-schema.ts';

/**
 * **Rows** — what „halbe Breite" means for a form document (design handoff).
 *
 * A row is a run of *two consecutive* half-width questions; anything left over
 * starts a row of its own. That sentence is a statement about the document,
 * not about a canvas: the builder lays it out with `flex-wrap`, the fill-in
 * view renders it as explicit rows, and both have to agree — otherwise a
 * participant sees a different form than the one the editor built.
 *
 * The rule used to live in `apps/web/src/builder/builder-store.ts`, which was
 * defensible only for as long as half width never left the builder. It does
 * now, so it lives here with the schema that defines `width`
 * (`CONTRIBUTING.md`: shared core logic belongs in `packages/shared`).
 *
 * Everything below is pure, and everything below reads the rule from
 * `rowRanges` — there is no second place where "two consecutive halves" is
 * spelled out. A rule written twice is a rule that will eventually disagree
 * with itself, which is the exact failure this module was extracted to end.
 */

/**
 * The two width literals, as spread-ready objects.
 *
 * `as const` rather than a cast to `Question`: it narrows the literal to the
 * union member `width` actually accepts, so a spread keeps its discriminated
 * variant instead of collapsing to `string`. Exported because the builder's
 * docking gesture sets the same two values and used to carry a byte-identical
 * copy of this.
 */
export const HALF_WIDTH = { width: 'half' } as const;
export const FULL_WIDTH = { width: 'full' } as const;

/**
 * **The rule, and the only place it is written**: the rows as `[start, size]`.
 *
 * Read from the front, exactly the way the builder's `flex-wrap` canvas lays
 * them out — two consecutive half-width questions form a row of size 2, and
 * the question after them opens the next one. Everything else in this module
 * is a different question asked of this one walk, which is why `rowsOf` and
 * `withPairedWidths` cannot drift apart.
 *
 * The ranges tile the list completely and in order: every index belongs to
 * exactly one row, so no caller can lose a question by walking them.
 */
function* rowRanges(
  questions: Question[],
): Generator<readonly [number, number]> {
  for (let start = 0; start < questions.length;) {
    const paired =
      questions[start]?.width === 'half' &&
      questions[start + 1]?.width === 'half';
    yield [start, paired ? 2 : 1];
    start += paired ? 2 : 1;
  }
}

/**
 * The index the question at `index` shares its row with today, or `-1`.
 *
 * The builder's gestures ask this to find out who is docked to whom — see
 * `moveQuestion` and `setQuestionWidth`.
 */
export function rowPartnerIndex(questions: Question[], index: number): number {
  for (const [start, size] of rowRanges(questions)) {
    if (size !== 2) {
      continue;
    }
    if (start === index) {
      return start + 1;
    }
    if (start + 1 === index) {
      return start;
    }
  }
  return -1;
}

/**
 * Dissolves the row of `index`: whoever shares it goes back to full width.
 *
 * The counterpart to "the aimed-at card becomes the partner". Docking to a
 * card that is already docked to someone else has to free it first, or the
 * invariant — which repairs from the front — keeps the *older* pair and
 * throws the target out of the row the user just aimed at.
 */
export function withReleasedRow(
  questions: Question[],
  index: number,
): Question[] {
  const partner = rowPartnerIndex(questions, index);
  if (partner === -1) {
    return questions;
  }
  return questions.map((question, position) =>
    position === partner ? { ...question, ...FULL_WIDTH } : question,
  );
}

/**
 * **The invariant: no half-width question without a partner in its row.**
 *
 * Half width is a *pair*  — a lone half card would sit next to a
 * gap the handoff does not show. Anything that ends up in a row of its own is
 * therefore widened again.
 *
 * This belongs at the **writing** end and is applied there: the builder's
 * store runs it over every document its actions commit, so what gets saved is
 * already sound. The fill-in view does not repeat it — it groups by `rowsOf`,
 * and a row of one is full width by layout whatever the question claims.
 *
 * The rule repairs from the front and knows nothing about intent, so callers
 * that *have* an intent — which card was aimed at — say so by releasing the
 * old row first (`withReleasedRow`). What arrives here is already the layout
 * the gesture asked for; this only widens what is genuinely left over.
 *
 * Returns the input array itself when nothing has to change, so React's
 * identity checks still see an unchanged page.
 */
export function withPairedWidths(questions: Question[]): Question[] {
  let repaired: Question[] | null = null;

  for (const [start, size] of rowRanges(questions)) {
    const question = questions[start];
    if (size !== 1 || question?.width !== 'half') {
      continue;
    }
    repaired ??= [...questions];
    repaired[start] = { ...question, ...FULL_WIDTH };
  }

  return repaired ?? questions;
}

/** The same rule over a whole document. */
export function withPairedPageWidths(pages: FormPage[]): FormPage[] {
  let repaired: FormPage[] | null = null;

  // A plain loop, not `forEach`: an assignment inside a callback is invisible
  // to the type checker's flow analysis, which then reads `repaired` below as
  // "always null".
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page === undefined) {
      continue;
    }
    const questions = withPairedWidths(page.questions);
    if (questions === page.questions) {
      continue;
    }
    repaired ??= [...pages];
    repaired[index] = { ...page, questions };
  }

  return repaired ?? pages;
}

/**
 * The question list grouped into the rows it is rendered as.
 *
 * **Guarantees** — what callers may rely on, and what the unit tests pin down:
 *
 * - a row holds two questions exactly when both are `half`; everything else
 *   gets a row to itself;
 * - concatenating the rows reproduces the input **element by element**, order
 *   and identity included, so document order — and with it the tab order of
 *   the fill-in view — is untouched.
 *
 * Deliberately **no** normalisation: a lone half-width question is handed back
 * as it is, in a row of its own, and a row of one is full width by layout.
 * Widening it here would break the identity guarantee above in order to
 * produce a `width` that no renderer reads — the invariant belongs at the
 * writing end (`withPairedWidths`), not on every read.
 */
export function rowsOf(questions: Question[]): Question[][] {
  return [...rowRanges(questions)].map(([start, size]) =>
    questions.slice(start, start + size),
  );
}
