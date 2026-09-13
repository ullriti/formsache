import {
  allQuestions,
  type FormDefinition,
  type FormPage,
  type Question,
} from './form-schema.ts';

/**
 * **The one place a question is copied and given a fresh id** .
 *
 * Two callers reduce to exactly this: the builder's „⧉ Duplizieren" on a
 * single question (`apps/web/src/builder/builder-store.ts`) and the API's
 * whole-form duplication (`apps/api/src/forms/forms.service.ts`), and
 * template insertion is the third — „nimm diese Frage(n) und gib sie mit neuen
 * IDs zurück" is one sentence regardless of how many questions are copied at
 * once, and two independently written copies of it are exactly the kind of
 * drift `CONTRIBUTING.md` warns about.
 *
 * `replaces` is dropped, not carried over. It names the question a type change
 * retired *within the same form* (`questionBaseShape.replaces`,
 * `form-schema.ts`) — bookkeeping for `publishDiff` to pair two ids into one
 * line of history. A duplicate has no such history: it did not replace
 * anything, and carrying the field over would point `publishDiff` at a
 * question the duplicate never touched, or — once the original's own
 * `replaces` chain is long enough — at an id from a form the copy no longer
 * has any connection to at all (a whole-form duplicate starts a fresh version
 * history, the evidence).
 *
 * `visibleIf` is left exactly as written. Its `questionId` names a *source*,
 * and copying **this** question does not move that source anywhere — the
 * reference still resolves the same way it did before the copy exists. What
 * *does* need rewriting is a condition whose source is itself one of several
 * questions being duplicated together (a whole page, a whole form) — that is
 * {@link duplicateQuestions} below, and it is not a special case of this
 * function so much as this function applied several times with the map added
 * on top.
 *
 * **The copy is deep, not spread** (a review finding). `{ ...question,
 * id }` copies the top level and hands every nested array straight on:
 * *measured on 2026-08-05:* `copy.options === original.options` was `true`, and
 * the same held for `events`, `rows`, `columns` and `files`. That was harmless
 * only for as long as both callers wrote the result straight into a document
 * they then let go of — and this function's own doc comment names a third
 * caller (template insertion) that puts the copy through a **different**
 * store. Two questions sharing one options array is the kind of aliasing whose
 * symptom is „ich habe die Kopie geändert und das Original hat sich mitgeändert"
 * — reported as data loss, found nowhere near here. „The one place a question is
 * copied" has to mean the copy is one, so it is settled here rather than
 * documented as a caveat for every caller to remember.
 *
 * `structuredClone` rather than a JSON round trip: a question is plain JSON by
 * construction (everything in it comes out of `formDefinitionSchema`), but
 * `JSON.parse(JSON.stringify(…))` silently drops keys whose value is
 * `undefined`, and `visibleIf`/`replaces` are exactly such optional keys.
 */
export function duplicateQuestion(question: Question, id: string): Question {
  const copy: Question = { ...structuredClone(question), id };
  delete copy.replaces;
  return copy;
}

/** What {@link duplicateQuestions} hands back. */
export interface QuestionDuplication {
  /** The copies, in the order `questions` was given. */
  readonly questions: Question[];
  /** Original id → the id its copy got. */
  readonly idMap: ReadonlyMap<string, string>;
}

/**
 * Duplicates a whole set of questions together — a page, a form — giving each
 * a fresh id **and** rewriting every `visibleIf` that pointed at another
 * question *in this same set* to that question's new id.
 *
 * That second half is what a single {@link duplicateQuestion} call cannot do
 * on its own: a lone duplicated question has no sibling in the copy whose id
 * moved, so nothing in *it* needs rewriting — but two questions copied
 * together, one of which is conditional on the other, would otherwise leave
 * the condition pointing at the original's id while the question it is
 * attached to lives under a new one. A condition whose source is **not** part
 * of this set (still on the original form, still at its old id) is left
 * untouched — that reference keeps resolving exactly as before, which is the
 * correct outcome for both callers this function has today: a page duplicated
 * *within* the same form still sees its own unduplicated pages at their
 * old ids, and a whole-form duplicate carries every question along at once, so
 * there is nothing left outside the set to begin with.
 */
export function duplicateQuestions(
  questions: readonly Question[],
  newId: () => string,
): QuestionDuplication {
  const withFreshIds = questions.map((question) => ({
    question,
    id: newId(),
  }));
  const idMap = new Map(
    withFreshIds.map(({ question, id }) => [question.id, id]),
  );

  const copies = withFreshIds.map(({ question, id }) => {
    const copy = duplicateQuestion(question, id);
    const { visibleIf } = copy;
    if (visibleIf === undefined) {
      return copy;
    }
    const mappedSource = idMap.get(visibleIf.questionId);
    if (mappedSource === undefined) {
      return copy;
    }
    return { ...copy, visibleIf: { ...visibleIf, questionId: mappedSource } };
  });

  return { questions: copies, idMap };
}

/**
 * Takes a set of questions **out of the document they lived in** — deep
 * copies, with every condition whose source stayed behind dropped (saving a Seite or a Frage as a template).
 *
 * It is the counterpart of {@link duplicateQuestions} and belongs beside it
 * for the reason that function's own comment gives: it is the *other* half of
 * „was passiert mit `visibleIf`, wenn Fragen ihren Zusammenhang verlassen".
 * {@link duplicateQuestions} answers it for a copy that stays in reach of its
 * sources (the reference still resolves, so it is left alone); this one
 * answers it for a set that is being stored on its own and will be inserted
 * into **some other form**, weeks later, where the id it names exists nowhere
 * at all.
 *
 * Carrying such a reference over would produce a page that refuses to publish
 * — `findUnresolvableConditions` (`condition.ts`) is exactly the check that
 * would then fire, on a form whose editor never wrote the condition and cannot
 * see what it points at. Dropping it is the honest reading of what a template
 * is: **a standalone block.** A condition whose source does not travel with
 * the block is not a condition any more, it is a dangling id.
 *
 * A **single** question therefore never keeps a condition (a set of one has no
 * source in it but itself), and a **whole form** keeps all of them (nothing is
 * outside the set) — which is why the form case needs no special handling
 * either here or at the call site.
 *
 * **`replaces` never travels either** (a later fix). It is the
 * same foreign id `duplicateQuestion` refuses to carry over, and for the same
 * reason — it names a question a type change retired *inside the source form*,
 * so in any other document it points `publishDiff` at a question this block
 * never touched. Dropping it only on the *insert* side left the stored template
 * carrying it: *measured on 2026-08-05* `"replaces":"019fe911-…-011"` — a
 * question id of the source form — stood in a template row without any
 * connection there at all. Harmless only for as long as every reader of a template
 * happens to be `duplicateQuestions`; a stored foreign key that nothing needs
 * is exactly what „a Vorlage names no form and holds no form id"
 * (`form-templates.ts`) says a template does not have.
 *
 * No new ids: this is the *save* side, and the ids are refreshed when the
 * template is inserted ({@link duplicateQuestions}), because one stored
 * template may be inserted many times and each insertion needs its own.
 */
export function detachQuestions(questions: readonly Question[]): Question[] {
  const inSet = new Set(questions.map((question) => question.id));
  return questions.map((question) => {
    const copy: Question = structuredClone(question);
    if (copy.visibleIf !== undefined && !inSet.has(copy.visibleIf.questionId)) {
      delete copy.visibleIf;
    }
    delete copy.replaces;
    return copy;
  });
}

/**
 * Takes a **whole form** out of the document it lived in — the document-wide
 * application of {@link detachQuestions}, for „ein ganzes Formular als Vorlage
 * speichern" .
 *
 * It exists because the per-page call is the **wrong** one for a form: running
 * {@link detachQuestions} once per page would judge each page's conditions
 * against that page alone, and a condition pointing at a question on an earlier
 * page — which travels along in a whole form — would be dropped as if it had
 * stayed behind. Handing the questions over in one set, `allQuestions` order, is
 * what the function's own comment means by „a **whole form** keeps all of them
 * (nothing is outside the set)".
 *
 * What it therefore removes from a form template is `replaces` and nothing else:
 * the id of a question a type change retired *inside the source form*, which
 * this document does not carry and which points `publishDiff` at a question the
 * template never touched. *Measured on 2026-08-06:* a form template, saved out
 * of a form with `replaces`, carried `"replaces"` together with the foreign id
 * permanently in its row — the kind for which there had been **no** call until
 * then.
 *
 * The pages are rebuilt by taking the copies back off the front in the same
 * order, exactly as {@link duplicateFormDefinition} does and for the same
 * reason: `allQuestions` walks pages in order and each page's questions in
 * order, so page *n* gets back the questions it started with. **The ids stay**
 * — this is the *save* side, and fresh ones are minted when the template becomes
 * a form (`FormsService.create` → {@link duplicateFormDefinition}).
 */
export function detachFormDefinition(
  definition: FormDefinition,
): FormDefinition {
  const detached = detachQuestions(allQuestions(definition));

  let cursor = 0;
  const pages: FormPage[] = definition.pages.map((page) => {
    const count = page.questions.length;
    const questions = detached.slice(cursor, cursor + count);
    cursor += count;
    return { ...page, questions };
  });

  return { pages };
}

/** What {@link duplicateFormDefinition} hands back. */
export interface FormDuplication {
  readonly definition: FormDefinition;
  /** Original question id → the id its copy got — for the caller's own
   *  references (notification placeholders, recipients). */
  readonly idMap: ReadonlyMap<string, string>;
}

/**
 * Duplicates a whole form's definition: every page and
 * every question gets a fresh id, and every `visibleIf` is rewritten to match
 * — the whole-document application of {@link duplicateQuestions}.
 *
 * Page ids are refreshed too, though nothing reads one across forms today
 * (`grep` finds no `pageId` reference outside the builder's own React keys) —
 * a duplicate that shared *any* id with the form it came from would be one
 * accidental join away from being the wrong kind of "independent copy", and
 * regenerating them costs nothing here.
 *
 * The order of `questions` handed to {@link duplicateQuestions} is
 * `allQuestions(definition)` — pages in order, each page's questions in
 * order — and the pages are rebuilt by taking that same number of copies back
 * off the front in the same order, so page *n*'s copies are exactly the
 * questions page *n* started with, still in their original sequence.
 */
export function duplicateFormDefinition(
  definition: FormDefinition,
  newId: () => string,
): FormDuplication {
  const { questions, idMap } = duplicateQuestions(
    allQuestions(definition),
    newId,
  );

  let cursor = 0;
  const pages: FormPage[] = definition.pages.map((page) => {
    const count = page.questions.length;
    const pageQuestions = questions.slice(cursor, cursor + count);
    cursor += count;
    return { ...page, id: newId(), questions: pageQuestions };
  });

  return { definition: { pages }, idMap };
}
