import { z } from 'zod';

import { permissionsSchema } from './auth.ts';
import { conditionDefectSchema } from './condition.ts';
import { formDefinitionSchema, questionTypeSchema } from './form-schema.ts';
import { legalPageStatusSchema } from './legal.ts';

/**
 * Wire contract of the form endpoints.
 *
 * One schema per message, parsed on both ends: the API validates what it
 * receives and the web client validates what it gets back. The second half is
 * not ceremony — a response missing `revision` would otherwise render a builder
 * that cannot save, and it would fail at the point of saving rather than at
 * the point of loading.
 */

export const formStatusSchema = z.enum(['draft', 'active']);
export type FormStatus = z.infer<typeof formStatusSchema>;

/** Timestamps travel as ISO-8601 strings; the client formats, the server states. */
const timestampSchema = z.iso.datetime();

/**
 * A form as the dashboard card shows it (design handoff): title, status badge,
 * date and answer count. Deliberately without the definition — the dashboard
 * lists thirty forms and needs none of their contents.
 */
export const formSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  status: formStatusSchema,
  /** Version participants currently fill in, or null while never published. */
  publishedVersion: z.number().int().positive().nullable(),
  responseCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  /**
   * What the signed-in person may do **on this form** — the third and fourth
   * links of the chain already applied.
   *
   * Not the organisation-wide flags of the membership, and that difference is the whole
   * field. A per-form restriction can cap somebody to a weaker role on one form
   * (`form_permission.capped_group_id`), and until this field existed the value
   * was **not on the wire at all**: the dashboard card and the form navigation
   * read `SessionUser.memberships[].permissions`, offered „Bearbeiten" to
   * somebody capped to a role without `can_build`, and the server answered 403 —
   * the same family of defect, one level down (there the evaluation was
   * missing, here the value).
   *
   * The server computes it with the **same** `FormRestriction` the guard chain
   * decides with — an intersection of the membership's permissions and the
   * capped group's, never a replacement, so it can only ever take away.
   *
   * **Display, never the boundary.** Every route still asks its guard
   * (`CONTRIBUTING.md`); reading a permission from here instead of enforcing it
   * would be the regression this field is not allowed to cause.
   */
  permissions: permissionsSchema,
});
export type FormSummary = z.infer<typeof formSummarySchema>;

// ---------------------------------------------------------------------------
// The paged form list
// ---------------------------------------------------------------------------

/**
 * **How many forms one page of `GET /api/forms` carries** — and the number the
 * dashboard therefore renders.
 *
 * **Measured, not guessed** (the requirement forbids the guess in as many
 * words) — but the two halves of the measurement are of **different strength**,
 * and that is stated here rather than only in the worklog
 * (`docs/worklog/2026-08-10-d3-d4-paginierung.md`), because the weaker half is
 * the one that decides the number:
 *
 * - **Rendering is the constraint, and it is measured *here*,
 *   not only elsewhere.** One measurement recorded 2748 forms putting
 *   `page.goto('/')` at 2.8 s of blocked main thread (**≈1 ms per card**), but
 *   that was a *single* foreign measurement out of the E2E backlog with
 *   application start-up still inside it — an upper bound, not a rate.
 *   `apps/web/src/views/dashboard-render-scaling.test.tsx` now measures the
 *   render half directly: ten warm mounts with the query cache pre-filled, no
 *   network and no start-up. On a 4-core runner the median for 24 cards landed
 *   between 24 ms and 45 ms across three runs — a frame's budget rather than a
 *   frozen tab, and comfortably inside the foreign upper bound.
 *   ⚠️ **The counter-probe is the point, not the number.** Eight times the page
 *   (200 cards) renders **3.3–3.7× slower in median** — sub-linear, but clearly
 *   scaling. Had it come out flat, the measurement would have been capturing
 *   mount overhead rather than rendering, and the new figure would have been
 *   worth exactly as much as the old one. The test asserts the **ordering**,
 *   never a millisecond: a threshold would go red on somebody else's hardware
 *   and be switched off, and then it would measure nothing at all.
 * - **The server is not the constraint**, and *that* half was measured for this
 *   package (`apps/api/test/forms/formularliste-messung.ts`, 3000 forms, real
 *   session through the whole guard chain): p50 11.3 ms at `limit=24` against
 *   11.4 ms at 50 and 18.7 ms at 500 — while the payload grows from 7 KB to
 *   145 KB. A bigger page buys nothing here and spends the whole difference on
 *   the client. What the measurement does **not** say is that 24 is optimal; it
 *   only rules the server out of the decision.
 *
 * 24 rather than 20 or 25 because the grid of the handoff is 1/2/3/4 columns
 * wide depending on the viewport, and 24 divides by all four — no page ever
 * ends in a half-filled row. That is a shape argument and decides only *within*
 * the range the first point opens.
 */
export const FORM_PAGE_SIZE_DEFAULT = 24;

/**
 * **The server's ceiling on `limit`** — the answer to "`?limit=100000` from
 * the address bar" (the ⚠️ line).
 *
 * A page size that a caller may name is a lever on the server's memory and on
 * every reader's browser, so the number a caller names is a *wish*: it is
 * clamped, never obeyed and never rejected. Clamping rather than 400 is
 * deliberate — an over-large `limit` is an honest request for "everything", and the
 * useful answer to it is the largest page that exists plus a `total` saying how
 * much more there is.
 *
 * 100 rather than 1000: at ≈1 ms of main thread per card (see
 * {@link FORM_PAGE_SIZE_DEFAULT}) a hundred cards is still around a tenth of a
 * second, and a thousand is the 1-second freeze this whole limit exists
 * to prevent.
 */
export const FORM_PAGE_SIZE_MAX = 100;

/**
 * **How long a search term may be.** Bounded for the reason every string on the
 * wire is: `title contains` over an unbounded term is work the sender chooses
 * for the server. 200 is the bound {@link formTitleSchema} puts on the column
 * being searched — a longer term cannot match anything anyway.
 */
export const FORM_SEARCH_MAX_LENGTH = 200;

/**
 * What a caller may say about *which* page of the form list it wants — parsed
 * from the query string, so every field arrives as a string or not at all.
 *
 * **Offset, not cursor**, and the dashboard is the reason: it
 * shows „n Formulare" as a *total* and offers page-by-page navigation, and a
 * cursor can express neither — it cannot say how many pages there are and it
 * cannot jump to the third. The price of offset paging is the well-known one
 * (a form edited between two page loads can shift by one position); the price
 * of a cursor here would have been a wire contract that cannot serve the view
 * it exists for.
 *
 * `limit` is **clamped, not refused** — see {@link FORM_PAGE_SIZE_MAX}. A
 * non-numeric `limit` *is* refused: that is a typo or a probe, not a wish.
 *
 * ## `strictObject`, since a review finding
 *
 * It was a `z.object`, and that **throws unknown keys away**. Whoever sent
 * `?search=Jahrestagung` — the parameter is called `q` — got no
 * refusal, but the first page of the **whole organisation**, and nothing told
 * them that their search never took place. A silent wrong answer is
 * more expensive than a loud refusal: the caller reads 24 forms and takes
 * them for their own hits.
 *
 * ⚠️ **Six isolated test runs went green right past it.** Against a fresh
 * database, "all forms of the organisation" and "those of the run" coincide —
 * only the full run, with the leftovers of the rest of the suite in the same organisation,
 * turned an `Expected: 2` into a `Received: 97`.
 *
 * That is **no** contradiction to the clamped `limit` above: there the
 * *value* is too large and the wish stays recognisable ("give me many"), here
 * the *name* is unknown and there is no recognisable wish at all. The same
 * distinction is made by `mailLogFilterSchema` next door, which is a
 * `strictObject` — this schema was the outlier.
 */
export const formListQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit muss eine ganze Zahl sein.')
    .transform(Number)
    .pipe(z.number().int().min(1))
    // The cap lives here rather than in the service, so that *every* caller of
    // this contract — the route, a future one, the client — reads the same
    // ceiling out of the same place. `Math.min`, not a `.max()` refusal: see
    // FORM_PAGE_SIZE_MAX.
    .transform((value) => Math.min(value, FORM_PAGE_SIZE_MAX))
    .optional()
    // The default is applied **after** the optional rather than by `.default()`,
    // because `.default()` on a transforming chain wants the *input* type — a
    // page size spelled as the string `'24'`. One number, written once, as a
    // number.
    .transform((value) => value ?? FORM_PAGE_SIZE_DEFAULT),
  offset: z
    .string()
    .regex(/^\d+$/, 'offset muss eine ganze Zahl sein.')
    .transform(Number)
    // ⚠️ **Bounded, and the bound is not decoration** (review finding).
    // The regex accepts any run of digits, and `Number.isInteger(1e19)` is
    // true, so `?offset=10000000000000000000` used to reach Prisma as a `skip`
    // — where it does not fit a 64-bit signed integer and raises a
    // `PrismaClientValidationError` that leaves the controller as a **500**.
    // A number a caller typed that the system cannot represent is a bad
    // request, not a server fault.
    //
    // `MAX_SAFE_INTEGER` rather than an invented product limit: it is the
    // largest integer JavaScript can hold exactly, so past it the value on the
    // wire and the value in the query are not even the same number. An offset
    // past the end of the list is answered with an empty page (tested), so no
    // legitimate caller is refused by this.
    .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
    .optional()
    .transform((value) => value ?? 0),
  /**
   * The search term of the dashboard toolbar — **server-side** . A client-side filter over the loaded page would answer „keine
   * Treffer" for a form that exists on page two, which is not a narrower answer
   * but a wrong one.
   */
  q: z
    .string()
    .max(FORM_SEARCH_MAX_LENGTH)
    .transform((value) => value.trim())
    .optional()
    .transform((value) => value ?? ''),
  /**
   * **One form by id, through the same list** — what the app shell needs to
   * answer "what may this person do on *this* form?" once the list is
   * paged (kept alive across the move to pagination).
   *
   * Until this package the shell read that answer out of the whole, unpaged
   * list: "loaded and not in it" meant "revoked or a foreign organisation". With a
   * page that reading is simply false — "not in it" now also means "on page
   * three". Rather than let the shell guess, it asks for the one row, through
   * exactly the `where` the list is built from, so the restriction is applied
   * in one place for both.
   */
  id: z.uuid().optional(),
});
export type FormListQuery = z.infer<typeof formListQuerySchema>;

/**
 * One page of the form list — what `GET /api/forms` answers.
 *
 * An object rather than the bare array it used to be, and the extra fields are
 * the contract:
 *
 * - `total` is the number of forms the **whole** filtered list holds, not the
 *   number in `items`. The dashboard's „n Formulare" reads it, and reading it
 *   off `items.length` is the defect this field exists to prevent.
 * - `activeTotal` and `responseTotal` are the other two figures of the
 *   dashboard's KPI row, and they are here for exactly the reason `total` is.
 *   Previously the page counted them off the loaded array — correct while the
 *   array *was* the organisation. Left there, „Formulare 2748" would have stood next to
 *   „Aktiv 3", counted over twenty-four cards, and the tile that was wrong would
 *   be the one nobody could check. Every one of the three is computed over the
 *   **same** filtered statement, so a search narrows all three together or
 *   none.
 * - `limit`/`offset` are echoed **as applied**, not as asked for. A caller that
 *   sent `limit=100000` finds {@link FORM_PAGE_SIZE_MAX} here — which is how a
 *   client can page correctly without having to know the server's ceiling.
 */
export const formListPageSchema = z.object({
  items: z.array(formSummarySchema),
  total: z.number().int().nonnegative(),
  /** Of {@link formListPageSchema.total}, how many are published („Aktiv"). */
  activeTotal: z.number().int().nonnegative(),
  /** Answers on file across all of them — the „Antworten gesamt" tile. */
  responseTotal: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type FormListPage = z.infer<typeof formListPageSchema>;

/**
 * One form with the definition the builder edits.
 *
 * `revision` is part of the contract rather than an implementation detail: the
 * client has to send back the value it loaded, and that is what turns two
 * concurrent editors into a 409 instead of a silent overwrite.
 */
export const formDetailSchema = formSummarySchema.extend({
  definition: formDefinitionSchema,
  revision: z.number().int().positive(),
  /** Public address of the form — random, not derived from the id. */
  publicSlug: z.string().min(1),
  /**
   * Whether publishing would produce anything.
   *
   * `false` means the **saved** draft is the document already in force, so
   * publishing would only raise the version number. The builder reads it to
   * lock its publish button *before* the press and to say why — the state used
   * to be knowable only afterwards, from a number that had gone up.
   *
   * Computed on the server from `hasUnpublishedChanges()` in `@formsache/shared` —
   * the very function `POST /forms/:id/publish` refuses on. Two answers to one
   * question is exactly the drift the shared function exists against: a client
   * that judged for itself would offer a button the server rejects, or hide one
   * it would have accepted.
   *
   * It says nothing about **unsaved** edits; the builder knows those itself and
   * they are a different reason with a different remedy ("erst speichern").
   * Deliberately on the detail only, never on `FormSummary`: the dashboard
   * lists thirty forms and would have to compare thirty published snapshots
   * against their drafts to show a fact no card displays. (The snapshots
   * themselves are already loaded there — `findManyWithCounts` includes the
   * whole `form_version` row for a number. That is an early leftover and its own
   * cut, noted in the worklog; the point here is the comparison, not the read.)
   */
  hasUnpublishedChanges: z.boolean(),
});
export type FormDetail = z.infer<typeof formDetailSchema>;

/**
 * **What a form may be called** — one bound, three writers.
 *
 * Named rather than repeated, because it acquired a third writer
 * there and the third one is the reason: the title a language model suggests
 * (`aiFormDraftSchema`) is **foreign text** on its way into exactly this field,
 * so it has to be bounded by exactly this rule. A second `max(200)` spelled out
 * next to the AI draft would be the drift `pickDefaultColumns` was shared
 * against — the half a model may fill would not be the half the create
 * route accepts, and the mismatch would only surface as a 400 after a counted
 * call had already been paid for.
 */
export const formTitleSchema = z.string().trim().min(1).max(200);

export const createFormRequestSchema = z.object({
  title: formTitleSchema,
  /**
   * „Aus einer Vorlage anlegen" — a template of
   * **this** Organisation, or the route answers 404.
   *
   * Optional, and creating a form from one goes through this route rather than
   * through a route of its own: a form comes into existence in exactly one
   * place, and "with or without a template" is one branch there instead of two
   * doors that would each have to remember the public address, the empty page
   * and the response count.
   *
   * The **title** stays the caller's either way. The dialog prefills it from
   * the template's name, but the person creating the form is the one naming it,
   * and a template used twice would otherwise produce two identically named
   * forms.
   */
  templateId: z.uuid().optional(),
});
export type CreateFormRequest = z.infer<typeof createFormRequestSchema>;

/**
 * A full replacement of title and definition.
 *
 * `PUT` semantics on purpose: the builder holds the whole document in memory
 * anyway, and a patch protocol over a nested page/question tree would need a
 * conflict story of its own on top of the revision check.
 */
export const updateFormRequestSchema = z.object({
  title: formTitleSchema,
  definition: formDefinitionSchema,
  /** The revision the editor started from. */
  revision: z.number().int().positive(),
});
export type UpdateFormRequest = z.infer<typeof updateFormRequestSchema>;

/** Publishing takes a revision too — you publish what you last saw. */
export const publishFormRequestSchema = z.object({
  revision: z.number().int().positive(),
});
export type PublishFormRequest = z.infer<typeof publishFormRequestSchema>;

/**
 * One submitted answer set, with the schema state it was validated against
 *  — the responses table renders each row against *its* version, not
 * against whatever the form looks like today.
 */
export const responseDetailSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  submittedAt: timestampSchema,
  /** Version number of the snapshot this submission was checked against. */
  formVersion: z.number().int().positive(),
  /** Answers keyed by question id; shape validated by `response-validation.ts`. */
  answers: z.record(z.string(), z.unknown()),
});
export type ResponseDetail = z.infer<typeof responseDetailSchema>;

/**
 * One published snapshot — the version number and the document it froze.
 *
 * The pair travels as a unit because neither half is usable alone: a row names
 * its version (`ResponseDetail.formVersion`), and rendering it needs the
 * definition that version carried. It is what the responses view
 * renders cells against, what `form-history.ts` builds the column union from,
 * and what the public fill-in path's „Bearbeiten nach Absenden" will hand a participant so
 * their answer is shown against **the fassung they filled in**.
 */
export const formVersionSnapshotSchema = z.object({
  version: z.number().int().positive(),
  definition: formDefinitionSchema,
});
export type FormVersionSnapshot = z.infer<typeof formVersionSnapshotSchema>;

/**
 * A column of the responses view.
 *
 * `CsvColumn` plus the one fact the union adds: whether the question is still
 * being asked. A retired column is shown and exported like any other — the
 * answers behind it exist — and is marked so a reader can tell why newer rows
 * are empty there.
 */
export const responseColumnSchema = z.object({
  /** Question id, or `SUBMITTED_AT_COLUMN`. */
  key: z.string().min(1),
  label: z.string().min(1),
  /** Not part of the newest published version any more. */
  retired: z.boolean(),
});
export type ResponseColumn = z.infer<typeof responseColumnSchema>;

/**
 * Everything the responses table needs besides the rows themselves.
 *
 * Deliberately **not** derived from `FormDetail.definition`: that is the draft,
 * and reading columns from it made an unsaved experiment in the builder change
 * what the responses view showed (no. 22).
 */
export const responseColumnSetSchema = z.object({
  /** The union of all published versions, active first — see `form-history.ts`. */
  columns: z.array(responseColumnSchema),
  /** Every published snapshot, ascending. A row renders against its own. */
  versions: z.array(formVersionSnapshotSchema),
});
export type ResponseColumnSet = z.infer<typeof responseColumnSetSchema>;

const publishDiffQuestionSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1),
  type: questionTypeSchema,
});
export type PublishDiffQuestion = z.infer<typeof publishDiffQuestionSchema>;

const publishDiffTypeChangeSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1),
  from: questionTypeSchema,
  to: questionTypeSchema,
});
export type PublishDiffTypeChange = z.infer<typeof publishDiffTypeChangeSchema>;

/** What publishing the draft would change about the form's questions. */
export const formPublishDiffSchema = z.object({
  removed: z.array(publishDiffQuestionSchema),
  added: z.array(publishDiffQuestionSchema),
  typeChanged: z.array(publishDiffTypeChangeSchema),
});
export type FormPublishDiff = z.infer<typeof formPublishDiffSchema>;

/**
 * Where in a notification a placeholder sits — the editor has to find it again.
 *
 * Spelled here because it travels on the wire with {@link publishPreviewSchema}
 * — **and spelled only here.** The server's refusal message and the publish
 * dialog both name the same three places to the same person; a second hand-
 * written union next to this one (`notification-questions.ts` used to carry
 * one) is a truth that can drift while nothing fails.
 */
export const placeholderPlaceSchema = z.enum(['subject', 'body', 'recipients']);
export type PlaceholderPlace = z.infer<typeof placeholderPlaceSchema>;

/**
 * German wording of {@link PlaceholderPlace}, for the one sentence the server's
 * 422 and the publish dialog both say.
 *
 * Next to the enum rather than at either call site, for the reason the enum is
 * here: „Empfängerliste" in the dialog and „Empfänger" in the refusal would be
 * two names for one place, and the editor has to search for it.
 */
export const PLACEHOLDER_PLACE_LABELS: Readonly<
  Record<PlaceholderPlace, string>
> = {
  subject: 'Betreff',
  body: 'Text',
  recipients: 'Empfängerliste',
};

/**
 * Why publishing is blocked by a dangling placeholder — the sentence that
 * stands **once** before the list of findings.
 *
 * The sibling of `UNRESOLVABLE_CONDITION_LEAD` in `condition.ts`, and here
 * rather than there for the reason `PLACEHOLDER_PLACE_LABELS` is here: this is
 * where the placeholder finding is spelled. Two surfaces say it to the same
 * person about the same draft — the 422 of `POST /forms/:id/publish`
 * (`orphanedPlaceholderMessage`) and the publish dialog, which carries the
 * finding forward *before* the button is pressed.
 *
 * **Two wordings existed and this is the shorter one.** The dialog used to
 * append „– sonst ginge eine E-Mail ohne Empfänger oder mit einer Lücke im Text
 * hinaus", the 422 stopped after „entfernen." Three reasons the clause is gone
 * rather than promoted:
 *
 * 1. It is wrong about one of the three places this very dialog enumerates. A
 *    placeholder in the **Betreff** leaves a gap in the subject line, not „im
 *    Text" — `PLACEHOLDER_PLACE_LABELS` keeps „Betreff" and „Text" apart three
 *    lines above.
 * 2. Its sibling lead now stands directly above it in the same block, and that
 *    one is finding + repair and nothing else. Two sentences of different
 *    length about the same kind of refusal read as two different severities.
 * 3. It is what the refusal already sends today, so no message anybody has seen
 *    changes wording; what changes is only that the dialog stops writing its
 *    own.
 *
 * The consequence itself is not lost — it is the *rationale of the lock*, and
 * it lives where rationale belongs: Konzept.
 */
export const ORPHANED_PLACEHOLDER_LEAD =
  'Diese Benachrichtigungen verweisen auf Fragen, die in der neuen Fassung ' +
  'fehlen. Bitte den Platzhalter austauschen oder entfernen.';

/**
 * One reference that would point at nothing after publishing.
 *
 * **The notification and the placeholder are both named**, and that is the whole
 * point: „Benachrichtigung X, Platzhalter Y" is something an
 * editor can act on, „irgendwo in Ihren Benachrichtigungen" means searching n
 * texts by hand.
 */
export const publishBlockedPlaceholderSchema = z.object({
  /**
   * `.default('placeholder')` rather than plain required, for the reason
   * `blocked` itself carries a default: a payload written before the second
   * shape existed carried no discriminator, and it still parses — as the one
   * thing it can have been.
   */
  kind: z.literal('placeholder').default('placeholder'),
  notificationName: z.string().min(1),
  /** The token as it is written, so the editor can search for it. */
  token: z.string().min(1),
  /** Caption of the disappearing question, when the version in force knows it. */
  label: z.string().nullable(),
  places: z.array(placeholderPlaceSchema),
});
export type PublishBlockedPlaceholder = z.infer<
  typeof publishBlockedPlaceholderSchema
>;

/**
 * One *Bedingte Anzeige* that would point at nothing after publishing.
 *
 * The same three fields `unresolvableConditionText` reads, and deliberately no
 * more: the dialog says the same sentence as the 422 by **calling that
 * function**, not by receiving a rendered string (a server that shipped the
 * sentence would decide the wording of a view it cannot see) and not by
 * spelling out the four defects a second time in `PublishNotice.tsx`.
 *
 * `questionId` and `sourceId` stay behind, like `notificationId` above: they are
 * the server's business, and what the editor needs is the caption of the
 * question to open.
 */
export const publishBlockedConditionSchema = z.object({
  kind: z.literal('condition'),
  /** Caption of the question **carrying** the condition — the one to open. */
  questionLabel: z.string().min(1),
  /** Caption of the source, from the draft or from the version in force. */
  sourceLabel: z.string().nullable(),
  defect: conditionDefectSchema,
});
export type PublishBlockedCondition = z.infer<
  typeof publishBlockedConditionSchema
>;

/**
 * Everything that blocks a publish — two shapes, one field.
 *
 * **One field on purpose.** Both are refusals of `POST /forms/:id/publish` with
 * the same 422, both are stated before the button rather than after, and both
 * disable the same control. A second array next to `blocked` would be a second
 * thing every reader has to remember to ask — and the day somebody forgets, the
 * dialog offers a confirm button the server refuses, which is the exact failure
 * this field was written against.
 *
 * `z.union` rather than `z.discriminatedUnion`, against this repository's own
 * habit (`public-form.ts` states why the discriminated form is normally the
 * better one): a discriminated union demands the discriminator *be there*, and
 * the placeholder entries of a server one deploy behind carry none. The union
 * accepts those through the first branch and its default. The two shapes share
 * no required field, so „no branch matched" cannot mean „matched the wrong one"
 * — and that is not left to reading: `forms.test.ts` refuses a condition entry
 * without its `kind`, so the day the condition shape gets a default of its own,
 * a broken condition would file itself under the placeholder branch and the
 * test says so instead of the dialog showing an empty reason.
 */
export const publishBlockedSchema = z.union([
  publishBlockedPlaceholderSchema,
  publishBlockedConditionSchema,
]);
export type PublishBlocked = z.infer<typeof publishBlockedSchema>;

/**
 * The verdict an editor gets **before** publishing again.
 *
 * Advisory **except for `blocked`**: the server states how many answers are on
 * file and which questions change, and the editor decides. The two things it
 * does *not* leave to the editor are a placeholder pointing into thin air
 *  and a Bedingung whose source no longer resolves —
 * `POST /forms/:id/publish` refuses both with a 422, and `blocked`
 * carries the same findings forward so the refusal is readable **before** the
 * button is pressed rather than after. `revision` is part of this payload for
 * the same reason it always was: a preview whose revision no longer matches
 * describes a draft somebody has since changed.
 */
export const publishPreviewSchema = z.object({
  revision: z.number().int().positive(),
  /** Version currently in force, or null while never published. */
  publishedVersion: z.number().int().positive().nullable(),
  /** Answers already on file — the „Es liegen bereits N Antworten vor". */
  responseCount: z.number().int().nonnegative(),
  changes: formPublishDiffSchema,
  /**
   * Every reference publishing would leave dangling — empty when nothing
   * blocks.
   *
   * `.default([])` rather than plain required, and that is what makes this
   * addition purely additive: a payload written before this field existed still
   * parses, and every reader sees an array either way — never `undefined`, so
   * `blocked.length > 0` cannot silently be `false` because a server is one
   * deploy behind.
   */
  blocked: z.array(publishBlockedSchema).default([]),
  /**
   * How far along the **privacy notice of this form** is (ADR-0028 no. 4).
   *
   * ## Why this stands here and not on the settings document
   *
   * Because otherwise exactly the person who publishes would not learn of it.
   * `GET /api/forms/:id/settings` demands `can_manage_form_settings`; an
   * editor with `can_build` alone would get a 403 there — and `can_build` is
   * the permission that publishes. This preview already stands behind
   * `can_build` and answers exactly **one** narrow question: "is the notice
   * finished?"
   *
   * ⚠️ **This is data minimisation, not protection** — and the difference is important
   * enough for these lines (review finding of 2026-08-18). Here stood "without
   * handing out the text", which reads like secrecy. But the text
   * is **world-readable as intended**: it stands on the public
   * fill-in page, and `GET /api/public/forms/:slug` hands it out without any
   * sign-in. Whoever holds `can_build` knows the `publicSlug` via
   * `GET /api/forms/:id` anyway. The preview carries the traffic light because that is what
   * the dialogue needs — not because the text were hidden from
   * anybody.
   *
   * The difference counts beyond this file: ADR-0028 names this
   * build as the pattern for open item 3 (the publishing notice
   * for the **legal texts of the organisation**). There the question of
   * protection is a real one — the legal texts of an organisation likewise stand
   * publicly, but the way to them does not lead through a form. Whoever adopts the
   * build therefore adopts it with *this* reasoning and not
   * with the wrong one — which is what `organisationLegal` right below does.
   *
   * ## `.default('ready')` — "we do not know" is no shortcoming
   *
   * A server that is one version behind does not send the field; a
   * client that made a shortcoming out of that would halt every publishing
   * dialogue of this installation with a message that nobody can remedy.
   * The same direction in which `blocked` resolves its default value.
   */
  privacyNotice: legalPageStatusSchema.default('ready'),
  /**
   * How far along the **legal texts of the organisation** are — its
   * `Anbieterangaben` and its `Datenschutzhinweise` (`TENANT_LEGAL_PAGES`)
   * taken together, worst state winning (ADR-0028, open item 3).
   *
   * ## Why this stands here
   *
   * For the reason `privacyNotice` above stands here, and it is the same
   * gap in the same dialogue: `GET /tenant/legal` demands
   * `can_manage_settings`, so the hint that an organisation has no imprint
   * and no privacy notice never reaches an editor who holds `can_build`
   * alone — and `can_build` is the permission that publishes. This preview
   * already stands behind `can_build` and can therefore say the one thing
   * the moment before publishing turns on: are they finished?
   *
   * ## ⚠️ Why the reasoning of `privacyNotice` must **not** be reused here
   *
   * Up there the traffic light is data minimisation and expressly no
   * protection: the notice of a form is world-readable as intended on the
   * fill-in page, and whoever holds `can_build` reaches it through the
   * `publicSlug` that `GET /api/forms/:id` hands them anyway. Withholding
   * the text there protects nothing; the light is simply all the dialogue
   * needs.
   *
   * Here it is **both** — minimisation *and* a bar, and the bar is the part
   * that decides the shape of this field. What `can_manage_settings` guards
   * is not the published page but the **document** behind it: `mode`,
   * `fills` and `custom` stand side by side and stay standing (ADR-0028 §3),
   * so the guarded route hands out precisely the half that is *not*
   * published — a lawyer's draft in `custom` while the template applies,
   * entries in `fills` while an own text applies, and the state of a page
   * nobody has published yet. This answer stands behind `can_build`, a
   * lower bar than the route it summarises, and it must not become the way
   * around it.
   *
   * From that follows what this field is, and it is a hard boundary:
   * **never the text, never the name of a field, never which of the two
   * pages.** One light over both together, and whoever wants to know *what*
   * is missing needs `can_manage_settings` and goes to the tab — where the
   * finding is named page by page and can actually be remedied.
   *
   * Worst state wins for that same reason and not merely for brevity: two
   * lights, or one plus a count, would already say which page is which.
   *
   * ## `.default('ready')` — as above
   *
   * A server one version behind sends no field, and a client must not turn
   * that into a shortcoming: it would halt the publishing dialogue of that
   * installation with a finding nobody can act on. The same direction in
   * which `privacyNotice` and `blocked` resolve their defaults.
   */
  organisationLegal: legalPageStatusSchema.default('ready'),
});
export type PublishPreview = z.infer<typeof publishPreviewSchema>;

export function parseFormDetail(source: unknown): FormDetail {
  return formDetailSchema.parse(source);
}

/**
 * One page of the form list, parsed.
 *
 * The successor of `parseFormSummaries`, which took the bare array the route
 * used to answer. Replaced rather than kept beside it: two entry points would
 * mean two readings of "what is the form list", and the one that carries no
 * `total` is the one a caller would reach for by habit.
 */
export function parseFormListPage(source: unknown): FormListPage {
  return formListPageSchema.parse(source);
}

export function parseResponseColumnSet(source: unknown): ResponseColumnSet {
  return responseColumnSetSchema.parse(source);
}

export function parsePublishPreview(source: unknown): PublishPreview {
  return publishPreviewSchema.parse(source);
}
