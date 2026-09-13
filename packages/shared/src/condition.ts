import { z } from 'zod';

import {
  allQuestions,
  conditionOperatorsFor,
  type FormDefinition,
  type Question,
  type QuestionCondition,
} from './form-schema.ts';
import {
  isBlankAnswer,
  isChoiceAnswer,
  normalisedAnswer,
  seatsOf,
} from './response-validation.ts';

/**
 * **The evaluation of a Bedingung — once, for both sides** .
 *
 * The fill-in view decides with it what to render — `FillIn.tsx` computes
 * {@link visibleQuestionIds} once per keystroke and both its render and its
 * `validatePage` read that set — and the server decides with it what is
 * required and what is stored (`buildAnswersSchema`). There is no second copy:
 * „Anzeige (Client) und Validierung (Server) lesen dieselbe Funktion", plus
 * a check nobody can do by reading — *eine Suche findet die
 * Auswertung genau einmal*. That search is mechanised in
 * `single-source.test.ts` (rule 3, `FILE_SCOPED_IDENTIFIERS`):
 * `evaluateCondition` and `visibleQuestionIds` may be **declared** in this file
 * and nowhere else in the repository. Importing them is free; that is the point
 * of them being here.
 *
 * **{@link visibleQuestionIds} is the whole exported surface**, and
 * {@link evaluateCondition} deliberately is not: the two answer differently on
 * a condition whose operator the source type does not offer (the applicability
 * test lives in the caller), and the more obviously named of the two was the
 * wrong one to reach for. Details at {@link evaluateCondition}.
 *
 * Why a second copy would be invisible without that guard: a client that
 * evaluates its own version renders a form that behaves exactly like this one
 * — until the two disagree, and then the participant fills in a field the
 * server throws away, or does not see a field the server demands. Both are
 * silent, and no test over one side can see either.
 *
 * ## The import cycle with `response-validation.ts`, and why it stays
 *
 * This module imports {@link isBlankAnswer} from there, and that module imports
 * {@link visibleQuestionIds} from here. Both directions are used **inside
 * functions**, never while a module is being evaluated, so neither ESM nor CJS
 * can observe a half-initialised binding.
 *
 * It is deliberate, and the alternative is worse: „ist ausgefüllt" is the same
 * statement as „diese Pflichtfrage ist beantwortet", and this project has
 * measured what a second definition of it costs (`choiceAnswerSchema`'s comment
 * about the empty „Sonstiges"). A local emptiness test here would look right
 * and would answer differently for a choice answer that carries nothing but a
 * typed „Sonstiges" — visible in nothing but the one form where somebody used
 * it.
 */

/**
 * What a source answer looks like **to a comparison** — the one place a
 * question type turns into something an operator can be applied to.
 *
 * Three kinds, because the operators need three: a number to compare, a text to
 * search in, and a set of values to look for. `none` is what the five excluded
 * types read as; nothing can be asked about them.
 */
type SourceReading =
  | { readonly kind: 'number'; readonly value: number | null }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'values'; readonly values: readonly string[] }
  | { readonly kind: 'none' };

/**
 * Reads one answer as its source type presents it.
 *
 * **Total over every payload**, not only over the ones this application writes:
 * on the server this runs on the *raw request body* — before any schema has
 * looked at it — so „ein Fremder hat `42` in ein Textfeld geschrieben" has to
 * be an answer this function gives rather than an exception it throws. Every
 * branch therefore tests the shape it expects and falls back to „nichts
 * Lesbares" instead of trusting a narrowing.
 *
 * The `switch` has **no `default`** and ends in `never`: a seventeenth question
 * type fails `pnpm typecheck` here, in the function that would otherwise have
 * decided in silence that it reads as nothing and hides everything that depends
 * on it.
 */
function readingOf(question: Question, answer: unknown): SourceReading {
  switch (question.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'date':
      return {
        kind: 'text',
        value: typeof answer === 'string' ? answer : '',
      };
    case 'number':
    case 'rating':
      return {
        kind: 'number',
        value: typeof answer === 'number' ? answer : null,
      };
    case 'select':
    case 'radio':
    case 'checkbox':
      // The chosen option **values**, never the labels: a stored answer refers
      // to the value, and so does the condition the builder writes. `filter`
      // rather than a cast — `values` is whatever the request carried.
      return {
        kind: 'values',
        values:
          isChoiceAnswer(answer) && Array.isArray(answer.values)
            ? answer.values.filter(
                (value): value is string => typeof value === 'string',
              )
            : [],
      };
    case 'event':
      // „Angemeldet" is a Personenzahl above zero, and the value a condition
      // compares against is the event **key** — the same key the export column
      // and the `event_registration` row carry. This is the honest translation
      // of the prototype's own event field, which is a set of ticks: a tick is
      // what „mindestens eine Person" is here.
      return {
        kind: 'values',
        values: seatsOf(answer)
          .filter(([, seats]) => seats > 0)
          .map(([key]) => key),
      };
    case 'info':
    case 'file':
    case 'table':
    case 'matrix':
    case 'address':
      // No source, no reading (`conditionOperatorsFor` hands these types an
      // empty operator list, so {@link visibleQuestionIds} never gets here).
      return { kind: 'none' };
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  throw new Error(
    `readingOf: unhandled question type ${JSON.stringify(unhandled)}`,
  );
}

/**
 * „ist gleich" over one reading.
 *
 * - **number:** compared as numbers, so `'3.0'` from the builder's box matches
 *   an answer of `3`, which a string comparison would call unequal. A value
 *   that is no number at all matches nothing — `Number('drei')` is `NaN` and
 *   `NaN === 3` is `false`, so „ist gleich drei" over a Zahlfrage is a
 *   condition that never fires rather than one that quietly compares texts.
 *   Surrounding space is *not* a case this has to fend off: `Number('3 ')` is
 *   `3`, and `conditionValueSchema` trims what the editor typed anyway.
 * - **text:** trimmed on both sides and otherwise exact, including case. The
 *   trim is not tolerance for its own sake: a value picked in the builder never
 *   carries surrounding space and a typed answer regularly does. Case is *not*
 *   folded — „ist gleich" over a free text is a comparison an editor writes
 *   deliberately, and `contains` is the forgiving operator of the pair.
 * - **values:** „ist gleich X" means *X ist gewählt*. For a Einfachauswahl that
 *   is the whole answer; for a Mehrfachauswahl it is the reading a participant
 *   has of their own form („wenn Bahn angekreuzt ist"), and the alternative —
 *   demanding that X is the *only* tick — would make the operator useless on
 *   the one type that can carry several.
 */
function equalsReading(reading: SourceReading, value: string): boolean {
  switch (reading.kind) {
    case 'number':
      return reading.value !== null && Number(value) === reading.value;
    case 'text':
      return reading.value.trim() === value.trim();
    case 'values':
      return reading.values.includes(value);
    case 'none':
      return false;
  }
}

/**
 * Does this condition hold, given the answer to its source question?
 *
 * **The one evaluation.** Everything that decides whether a question is on
 * screen, whether its Pflicht binds and whether its value is kept comes through
 * here — see the module comment for why there may not be a second one.
 *
 * `answer` is `unknown` because the value handed in started as raw material:
 * the server's request body, the fill-in view's own draft state, where a
 * half-typed value is normal. {@link visibleQuestionIds} runs it through
 * `normalisedAnswer` first, so what arrives here is spelled the way the stored
 * row will be.
 *
 * ## Why this is **not** exported (review finding, 2026-08-03)
 *
 * It assumes the pair is **applicable** — that `condition.operator` is one of
 * the operators `source.type` offers. A pair that is not applicable still gets
 * a defined answer here (`false`, via the `none`/kind mismatches) rather than
 * an exception, because a total function is the one shape a validator can call
 * on a stored document from an older version without a second opinion about
 * whether it is allowed to exist.
 *
 * {@link visibleQuestionIds} makes the opposite choice for the same pair: it
 * asks {@link resolveConditionSource} first and **shows** the question when the
 * operator does not apply (fail open, so a build mistake is loud rather than
 * invisible). Two answers to one question, and while both were exported the
 * naming decided which one a caller got: `contains` on a Auswahlfrage — an
 * operator the type does not offer — read as *visible* through
 * `visibleQuestionIds` and as `false` through `evaluateCondition`, so a client
 * reaching for the obvious name would hide exactly the question the server
 * requires and whose answer it stores.
 *
 * The two are therefore **not** reconciled by moving the applicability test in
 * here — that would trade the failing direction for the other one, and the
 * fail-open decision belongs where the source chain is resolved (a hidden
 * source hides its dependants, which this function cannot see either). Instead
 * the module keeps one door: {@link visibleQuestionIds} is the contract
 * surface, this is the step inside it.
 */

/**
 * The Vergleichswert, spelled the way the *answer* it is compared against is
 * spelled — compare like with like.
 *
 * The answer travels through `answerSchemaFor`, and for `email` that schema is
 * `trim().toLowerCase()`. The Vergleichswert does not: an editor who writes
 * „Kanzlei@Example.org" against an E-Mail-Frage was building a condition that
 * could **never** fire, because the stored side is always lower case and
 * nothing said so. That is the same class of trap as the one an earlier review
 * found in the panel — a condition that looks right and means something else —
 * only reachable from the other end, and a hand-written `PUT` reaches it even
 * with a perfect panel.
 *
 * Applied through {@link normalisedAnswer}, deliberately, rather than a list of
 * „types whose comparison folds case": the transform is whatever the answer
 * schema does today, so a schema that starts trimming tomorrow does not need a
 * second edit here. A value that is not a string after normalisation is left
 * alone — a choice value handed to a `select` schema does not parse and comes
 * back untouched, which is what {@link equalsReading} wants for a `values`
 * reading.
 *
 * `contains` needs none of this: it already folds case on both sides.
 */
function comparableValue(source: Question, value: string): string {
  const normalised = normalisedAnswer(source, value);
  return typeof normalised === 'string' ? normalised : value;
}

function evaluateCondition(
  condition: QuestionCondition,
  source: Question,
  answer: unknown,
): boolean {
  const reading = readingOf(source, answer);

  switch (condition.operator) {
    // „ausgefüllt" is the same statement as „diese Pflichtfrage ist
    // beantwortet", and it is read from the same function — including the
    // cases a local test would get wrong: a choice answer carrying nothing but
    // a typed „Sonstiges", an Adresse with one of four subfields filled, a
    // Tabelle whose cells are all blank.
    //
    // Over the **normalised** answer, like every other operator here: the two
    // spellings of „nicht angemeldet" (`{seats: {stadtfest: 0}}` and
    // `{seats: {}}`) are one state. `filled`/`empty` are the pair where that
    // distinction would otherwise show, so they read the normalised answer
    // rather than the raw one. See `normalisedAnswer`.
    case 'filled':
      return !isBlankAnswer(answer);
    case 'empty':
      return isBlankAnswer(answer);
    case 'equals':
      return equalsReading(reading, comparableValue(source, condition.value));
    // The **strict** negation, blank included: „nur anzeigen, wenn Anreise
    // *nicht* Auto ist" shows the question while nothing is chosen yet, which
    // is what the sentence says and what the handoff's own evaluator does. The
    // participant who then picks „Auto" watches it disappear again.
    case 'notEquals':
      return !equalsReading(reading, comparableValue(source, condition.value));
    // Case-folded, unlike „ist gleich": this is the operator for „irgendwo im
    // Freitext steht …", and an editor who writes „verein" does not
    // mean „nur klein geschrieben". Only over a text reading — the operator is
    // offered for no other kind.
    case 'contains':
      return (
        reading.kind === 'text' &&
        reading.value.toLowerCase().includes(condition.value.toLowerCase())
      );
    // A missing number is neither greater nor smaller. Both bounds are strict:
    // „größer als 3" is 4 and up, which is what the words say.
    case 'greaterThan':
      return (
        reading.kind === 'number' &&
        reading.value !== null &&
        reading.value > condition.value
      );
    case 'lessThan':
      return (
        reading.kind === 'number' &&
        reading.value !== null &&
        reading.value < condition.value
      );
  }
}

/**
 * **„Die Quelle ist auflösbar" — once, for the evaluation and for the publish
 * lock.**
 *
 * Two questions are asked here and they are deliberately one test: is the
 * source a question that stands **before** the one depending on it, and does
 * its type offer this operator at all? `earlier` carries the first — it holds
 * exactly the questions already passed in document order, so „gibt es nicht",
 * „steht dahinter" and „ist die Frage selbst" all read as a miss without any of
 * them needing a case here. `conditionOperatorsFor` carries the second, and an
 * excluded source type has an empty list, so „falscher Typ" needs no case
 * either.
 *
 * It exists as a function because otherwise the publish lock would be a second
 * writing of the evaluator's „Quelle ist eine **vorherige** Frage" — the same sentence, in the module
 * that blocks publishing, free to answer differently from the one that decides
 * what is on screen. The half that says „auflösbar" would then publish a form
 * whose evaluation hides or shows the wrong question, and nothing on either
 * side could see it. `single-source.test.ts` (rule 3) holds the declaration to
 * this file for that reason.
 */
function resolveConditionSource(
  condition: QuestionCondition,
  earlier: ReadonlyMap<string, Question>,
): Question | null {
  const source = earlier.get(condition.questionId);
  if (source === undefined) {
    return null;
  }
  return conditionOperatorsFor(source.type).includes(condition.operator)
    ? source
    : null;
}

/**
 * Why a condition cannot be resolved — the four shapes of „zeigt ins Leere".
 *
 * Separate values rather than one „ungültig", because the editor's next move
 * differs: a missing source is repaired by picking another one, a source
 * standing behind its dependant by dragging one of the two.
 */
export const conditionDefectSchema = z.enum([
  'missing',
  'later',
  'self',
  'operator',
]);
/**
 * Derived from the schema rather than written twice: the defect travels on the
 * wire (`publishPreview().blocked`), and a hand-written union next
 * to the schema is a second list of the four — free to grow a fifth on one side
 * only, where {@link reasonOf}'s `switch` would no longer be exhaustive and
 * nothing would say so.
 */
export type ConditionDefect = z.infer<typeof conditionDefectSchema>;

/** One *Bedingte Anzeige* that would point at nothing. */
export interface UnresolvableCondition {
  /** The question carrying the condition — the one the editor has to open. */
  readonly questionId: string;
  readonly questionLabel: string;
  readonly sourceId: string;
  /** Caption of the source, from the draft or from the version in force. */
  readonly sourceLabel: string | null;
  readonly defect: ConditionDefect;
}

/**
 * Every condition of the **draft** whose source does not resolve.
 *
 * **The draft is what is asked, deliberately not `publishDiff().removed`** —
 * the same trap the placeholder lock nearly fell into elsewhere, and for the
 * same reason: retyping a question mints a new id and the diff *pairs* the two
 * into one line, so the predecessor never appears among
 * the removals at all, while a condition naming it finds no question in the
 * published document. The diff answers „what does the editor need to be warned
 * about"; this answers „löst diese Bedingung auf", and only the second question
 * decides whether a participant sees the right form.
 *
 * It compares nothing and therefore is no second copy of the diff. It walks the
 * draft top to bottom, exactly as {@link visibleQuestionIds} does, and asks
 * {@link resolveConditionSource} — the same function, so a form that publishes
 * is a form whose every condition the evaluation can actually evaluate.
 *
 * `published` is read for one thing only: the caption of a source the draft no
 * longer has, so the refusal is readable as well as precise.
 *
 * **Renaming and reordering are not the same freedom.** A source whose caption
 * changed is still the same question and nothing fires (the binding is the id);
 * a source dragged *behind* its dependant fires, because at the moment that
 * question is asked its source has no answer yet — the earlier-question rule, at publish time.
 */
export function findUnresolvableConditions(input: {
  readonly draft: FormDefinition;
  /** The version in force — used only to name a question that disappeared. */
  readonly published: FormDefinition | null;
}): UnresolvableCondition[] {
  const questions = allQuestions(input.draft);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const publishedLabels = new Map(
    (input.published === null ? [] : allQuestions(input.published)).map(
      (question) => [question.id, question.label],
    ),
  );

  const findings: UnresolvableCondition[] = [];
  /** The questions already passed — the only ones a condition may point at. */
  const earlier = new Map<string, Question>();

  for (const question of questions) {
    const condition = question.visibleIf;
    if (
      condition !== undefined &&
      resolveConditionSource(condition, earlier) === null
    ) {
      findings.push({
        questionId: question.id,
        questionLabel: question.label,
        sourceId: condition.questionId,
        sourceLabel:
          byId.get(condition.questionId)?.label ??
          publishedLabels.get(condition.questionId) ??
          null,
        defect: defectOf(question, condition, earlier, byId),
      });
    }
    earlier.set(question.id, question);
  }

  return findings;
}

/**
 * Which of the four it is — asked only once {@link resolveConditionSource} has
 * said „nein", so this never decides *whether* something is wrong, only how to
 * say it.
 *
 * The order is the order of repair: pointing at itself is a condition nobody
 * can have meant, a source that is gone has to be replaced before its position
 * can matter, and „steht dahinter" is asked before the operator because moving
 * the question may make the operator question moot.
 */
function defectOf(
  question: Question,
  condition: QuestionCondition,
  earlier: ReadonlyMap<string, Question>,
  byId: ReadonlyMap<string, Question>,
): ConditionDefect {
  if (condition.questionId === question.id) {
    return 'self';
  }
  if (!byId.has(condition.questionId)) {
    return 'missing';
  }
  return earlier.has(condition.questionId) ? 'operator' : 'later';
}

/**
 * Why publishing is blocked, in general — the sentence that stands **once**
 * before the list of findings.
 *
 * A constant because **three** surfaces say it to the same person about the
 * same draft: the 422 of `POST /forms/:id/publish`, the mark on the question
 * card (`condition-status.ts`, through {@link unresolvableConditionMessage})
 * and the publish dialog, which carries the finding forward *before* the button
 * is pressed. Written a second time in the dialog it would be free to explain
 * the block differently from the refusal that enforces it — the
 * `PLACEHOLDER_PLACE_LABELS` story in `forms.ts` is the same lesson, elsewhere.
 */
export const UNRESOLVABLE_CONDITION_LEAD =
  'Diese Fragen haben eine bedingte Anzeige, deren Quellfrage nicht ' +
  'auflösbar ist. Bitte die Bedingung anpassen oder entfernen.';

/**
 * What is wrong with **one** condition — the sentence the editor acts on.
 *
 * It **names the affected question**, which is the whole point:
 * „irgendwo stimmt eine Bedingung nicht" leaves an editor clicking through
 * every question of the form to find the one switch that is set.
 *
 * The named question is the one carrying the condition, not the source: that is
 * the one to open, and the source's caption comes along in the same sentence
 * where it is known.
 *
 * The `missing` wording says the type change out loud. It is the case an editor
 * cannot otherwise explain — the source is still on the canvas, under its old
 * caption, and the message would read as plainly wrong without the half sentence
 * that says why the id is not.
 *
 * **Takes the three fields it reads, not an {@link UnresolvableCondition}**: the
 * publish dialog holds the same finding minus the two ids
 * (`publishBlockedConditionSchema`), and the point of this function is that both
 * sides get the *same* sentence out of it rather than a similar one.
 */
export function unresolvableConditionText(
  finding: Pick<
    UnresolvableCondition,
    'questionLabel' | 'sourceLabel' | 'defect'
  >,
): string {
  const source =
    finding.sourceLabel === null
      ? 'Die Quellfrage'
      : `Die Quellfrage „${finding.sourceLabel}"`;
  return `Frage „${finding.questionLabel}": ${reasonOf(finding.defect, source)}`;
}

/**
 * The refusal an editor reads when publishing is blocked.
 *
 * Assembled from the two pieces above and from nothing else, so „derselbe Text"
 * between the 422 and the builder's own condition panel (`condition-status.ts`)
 * is one function call rather than two texts that happen to agree today.
 *
 * The publish dialog is the third surface and does **not** call this: it needs
 * the lead once above a list, not a run-on sentence, so it renders
 * {@link UNRESOLVABLE_CONDITION_LEAD} and one
 * {@link unresolvableConditionText} per finding — the two pieces this function
 * is assembled from, which is what keeps the three in step.
 */
export function unresolvableConditionMessage(
  findings: readonly UnresolvableCondition[],
): string {
  const items = findings.map(unresolvableConditionText);

  return (
    `Veröffentlichen nicht möglich: ${UNRESOLVABLE_CONDITION_LEAD} ` +
    items.join(' · ')
  );
}

/** One sentence per defect — `switch` without `default`, so a fifth is a compile error. */
function reasonOf(defect: ConditionDefect, source: string): string {
  switch (defect) {
    case 'missing':
      return (
        `${source} fehlt in der neuen Fassung — auch ein Typwechsel zählt, ` +
        'er vergibt eine neue Frage-ID.'
      );
    case 'later':
      return `${source} steht erst nach dieser Frage.`;
    case 'self':
      return 'Die Bedingung zeigt auf die Frage selbst.';
    case 'operator':
      return `${source} bietet diesen Vergleich nicht an.`;
  }
}

/**
 * Every question of a form that is **on screen** for this set of answers — in
 * page order, conditions resolved.
 *
 * One function for both surfaces, and one result for both uses: the fill-in
 * view renders what is in the set, the answer validator requires what is in the
 * set and **throws away everything that is not** (`buildAnswersSchema` in
 * `response-validation.ts`).
 *
 * ## The three cases that are not „Bedingung ausgewertet"
 *
 * 1. **No condition** — shown. The overwhelming majority of questions.
 * 2. **The source is not resolvable** — shown, deliberately *fail open*.
 *    A source that does not exist in this document, that stands *after* the
 *    question that depends on it, that is the question itself, or whose type
 *    offers this operator not at all: none of these can be evaluated, and the
 *    two directions of getting it wrong are not equal. Hiding would silently
 *    drop a question — possibly a required one — from a form that is already
 *    live, and nothing would say so; showing costs an answer to a question
 *    whose condition is broken, which an editor can see. The publish lock narrows
 *    where this branch can still be reached: since `forms.service.ts` refuses
 *    a `POST /forms/:id/publish` whose draft carries an unresolvable condition
 *    ({@link findUnresolvableConditions}, the same {@link resolveConditionSource}
 *    this function asks), no *newly published* version can contain one. What
 *    remains are the documents that never passed that gate — a draft in the
 *    builder's own preview, and a version published before the lock existed —
 *    and those are exactly what this branch is the floor under. It is not a
 *    substitute for the lock, and the lock is not a reason to drop it.
 * 3. **The source is itself hidden** — hidden, whatever the operator
 *    says. A question nobody was asked has no answer, and „ist leer" over it
 *    would be a technical truth that shows a follow-up question to a branch of
 *    the form its participant never entered. Because a source is always an
 *    *earlier* question this resolves in one pass, top to bottom, with no
 *    recursion and no cycle to detect.
 *
 * ## About versions
 *
 * An answer is rendered and validated against **its own** version, and a
 * condition travels inside the same document as the question that carries it —
 * both were written by one save. There is therefore no such thing as „die
 * Quelle gab es in dieser Fassung noch nicht": if a later version adds the
 * source and the condition, the older row simply has neither, and its question
 * stays unconditional exactly as its participant saw it. The one thing that
 * must not happen is a condition being judged against *today's* draft — which
 * is why every caller on the server passes the snapshot (`response.form_version`
 * on the edit path, `publishedVersion` on the submission) and never
 * `form.definition`.
 */
export function visibleQuestionIds(
  definition: FormDefinition,
  answers: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const visible = new Set<string>();
  /** The questions already passed — the only ones a condition may point at. */
  const earlier = new Map<string, Question>();

  for (const page of definition.pages) {
    for (const question of page.questions) {
      const condition = question.visibleIf;
      let shown = true;

      if (condition !== undefined) {
        // The same resolution the publish lock runs, so „auflösbar" cannot
        // mean two things — see {@link resolveConditionSource}.
        const source = resolveConditionSource(condition, earlier);
        if (source === null) {
          shown = true;
        } else if (!visible.has(source.id)) {
          shown = false;
        } else {
          // **Over the value the column carries** — not over the raw one.
          // `normalisedAnswer` applies both normalisation layers of the write
          // path (`canonicalAnswerValue` and the field schema of the
          // question), so that „was steht auf dem Bildschirm" has the same
          // answer at submission and at an unchanged edit of the same row. Why
          // it costs data otherwise stands there.
          shown = evaluateCondition(
            condition,
            source,
            normalisedAnswer(source, answers[source.id]),
          );
        }
      }

      if (shown) {
        visible.add(question.id);
      }
      earlier.set(question.id, question);
    }
  }

  return visible;
}
