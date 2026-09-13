import { questionColumns } from './answer-columns.ts';
import {
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  type CsvColumn,
} from './export-sheet.ts';
import {
  allQuestions,
  type FormDefinition,
  type Question,
} from './form-schema.ts';
import type {
  FormPublishDiff,
  FormVersionSnapshot,
  ResponseColumn,
} from './forms.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * **What a form ever asked** — the published life of a form document.
 *
 * Two questions are answered here, and both are statements about the
 * *document* rather than about a screen, which is why they live next to the
 * schema that defines it (`CONTRIBUTING.md`) instead of in a service:
 *
 * 1. **Which columns does the responses view have?** The union of every
 *    published version, not the draft and not the newest version. A question
 *    somebody removed keeps its column and stays exportable — the answers to it
 *    are still in the database, and before this they were unreachable through
 *    the interface, which is data loss that nobody notices until the data is
 *    needed. Reading the draft made it worse still: merely *trying something
 *    out* in the builder changed what the responses view showed, without saving
 *    and without publishing.
 * 2. **What does publishing again change?** The diff of the version in force
 *    against the draft, so an editor with answers on file is told what they are
 *    about to do rather than finding out afterwards.
 *
 * Everything here is pure and total: no clock, no database, no exception. A
 * history assembled from stored snapshots has to survive documents nobody would
 * write today — see the rules on identity and type below.
 */

/**
 * One question of the union, with what the history says about it.
 *
 * The **whole** `question` comes from one single snapshot (`lastVersion`),
 * never assembled from several: a label from one version beside the options of
 * another would be a question that was never published in that shape, and the
 * export would show a header nobody ever saw.
 */
export interface HistoricQuestion {
  /**
   * The question as the newest published version that still knows it spells
   * it — see {@link questionHistory} for why the newest and not the first.
   */
  readonly question: Question;
  /**
   * First published version this id appeared in.
   *
   * Carried for the surfaces that come next — a retired column that says „bis
   * Fassung 3 gefragt" needs both ends — and unused by anything today. Stated
   * plainly rather than dressed up: it is derived from the same walk as the
   * rest, so keeping it costs nothing, and inventing it later would mean
   * touching this function again.
   */
  readonly firstVersion: number;
  /** Last published version that still had it — the source of `question`. */
  readonly lastVersion: number;
  /** No longer asked in the newest published version. */
  readonly retired: boolean;
  /**
   * The same id carried **different types** across versions.
   *
   * Not supposed to happen: a type change in the builder
   * becomes a new question with a new id, precisely so that „Ja" and `42` never
   * share a column. An older document predates that rule, so the case is
   * *detected* here rather than trusted away.
   *
   * **Nobody consumes it yet** — it is deliberately not on the wire
   * (`ResponseColumn`), and no surface warns about it today. It is kept for the
   * follow-up that will: a column mixing „Ja" and `42` is exactly what an
   * editor should be told about. It changes nothing about how a *cell* is
   * rendered, because every row is formatted against its own snapshot
   * (`buildCsv`), never against the column.
   */
  readonly typeChanged: boolean;
  /**
   * The **export** columns this question ever produced, active ones first.
   *
   * The union has to be taken at column granularity, not at question
   * granularity, and that is the whole reason this field exists. A Matrix row
   * („Verpflegung") that version 1 asked about and version 2 dropped is a
   * column with answers behind it, exactly like a whole question that was
   * removed — and reading the columns off {@link HistoricQuestion.question}
   * alone (the newest published shape) would make those answers unreachable
   * through the interface. That is the data loss the requirement was written
   * against, one level further down.
   *
   * For every question type that exists today this is a single entry with the
   * question's own id and label, which is why nothing about the files the
   * application writes changes.
   *
   * **It may be empty**, and that is a statement rather than a degenerate case:
   * the Infotext is part of the document and no question — „keine
   * Spalte in Tabelle und Export". It keeps its place in the history (the
   * document did ask it, and `firstVersion`/`retired` are true of it), and
   * {@link responseColumnGroups} is where it drops out of the *columns*.
   */
  readonly columns: HistoricColumn[];
}

/** One export column of the union, with what the history says about it. */
export interface HistoricColumn {
  /** As {@link QuestionColumn} mints it — a question id, or `id#part`. */
  readonly key: string;
  /**
   * The header **without** the „nicht mehr gefragt" note, taken whole from the
   * newest published version that still produced this column — for the same
   * reason {@link HistoricQuestion.question} is: a question label from one
   * version beside a part name from another is a column nobody ever published.
   */
  readonly label: string;
  /**
   * Not produced by the newest published shape of this question any more —
   * either because the question is retired, or because the part is (a Matrix
   * row that was deleted while the question stayed).
   */
  readonly retired: boolean;
}

/** The mutable accumulator behind {@link questionHistory}. */
interface HistoryEntry {
  question: Question;
  readonly firstVersion: number;
  lastVersion: number;
  /** Position of the question inside `lastVersion`, in page order. */
  lastIndex: number;
  typeChanged: boolean;
  /** Every column key this id ever produced — see {@link HistoricQuestion.columns}. */
  readonly columns: Map<string, ColumnEntry>;
}

/** One column of the union while it is being accumulated. */
interface ColumnEntry {
  label: string;
  /** Newest published version that still produced this column. */
  lastVersion: number;
  /** Position of the column inside that version's plan for the question. */
  lastIndex: number;
}

/**
 * Every question ever published, merged by **id**.
 *
 * **Identity is the id, never the label.** A label is edited; renaming
 * „Name" to „Vor- und Zuname" must not open a second column beside fifty
 * answers. Where one id carries two labels, the newest published version that
 * knows it wins: it is the last thing the editor decided the question means,
 * and for a retired question it is the state it was retired in.
 *
 * **Order** — the rule as the client decided it (2026-07-27):
 *
 * - questions of the newest published version come first, in **its** document
 *   order. The table is meant to look like the form as it stands today, because
 *   that is the view people work in daily — and reordering in the builder has
 *   to be visible there;
 * - retired questions follow, in the order they were retired in: by the version
 *   they were last published in and, within it, by that version's document
 *   order.
 *
 * **The consequence, stated rather than discovered:** this order is *not*
 * append-only. A question that leaves the active block joins the retired ones
 * at their end and thereby moves every column between — the previously retired
 * ones each shift one place towards the front. The alternative that would have
 * been append-only, ordering everything by first appearance, was weighed and
 * rejected: it decouples the active block from the form, so a reordering in the
 * builder would no longer show up in the table at all. What *does* hold is that
 * the retired columns keep their order **relative to one another**, and a newly
 * retired one always joins as the last of them.
 *
 * `snapshots` may arrive in any order; it is sorted by version here rather than
 * trusted, because "newest" decides both the label and the order and a caller's
 * `ORDER BY` is not a thing this function can see.
 *
 * `answers` is the second source the column union has had — see
 * {@link HistoricQuestion.columns}. It is **not** split by version: a question
 * keeps its id across versions, and a table's row blocks are one list over
 * the whole file (`exportPlan` says the same thing from the other end). The
 * answer set may arrive in any order too, and unlike `snapshots` it is not
 * sorted here, because nothing about the result depends on it — the one thing
 * read out of it is a maximum.
 */
export function questionHistory(
  snapshots: readonly FormVersionSnapshot[],
  answers: readonly AnswerMap[],
): HistoricQuestion[] {
  const ordered = [...snapshots].sort((a, b) => a.version - b.version);
  const entries = new Map<string, HistoryEntry>();

  for (const snapshot of ordered) {
    allQuestions(snapshot.definition).forEach((question, index) => {
      const known = entries.get(question.id);
      const entry = known ?? {
        question,
        firstVersion: snapshot.version,
        lastVersion: snapshot.version,
        lastIndex: index,
        typeChanged: false,
        columns: new Map<string, ColumnEntry>(),
      };
      if (known !== undefined) {
        // Compared before the replacement, so a type that changed twice and
        // changed back is still reported as having changed.
        known.typeChanged ||= known.question.type !== question.type;
        known.question = question;
        known.lastVersion = snapshot.version;
        known.lastIndex = index;
      } else {
        entries.set(question.id, entry);
      }

      // The columns of **this** version's shape of the question, so a part that
      // only ever existed in an old version keeps its place in the union.
      questionColumns(question, answers).forEach((column, columnIndex) => {
        entry.columns.set(column.key, {
          label: column.label,
          lastVersion: snapshot.version,
          lastIndex: columnIndex,
        });
      });
    });
  }

  // "Newest" is the **highest published version**, not `form.published_version_id`.
  // The two say the same thing today, because publishing only ever appends.
  // Should a future change allow putting an older version back in force, this would go
  // on calling the highest one active and would quietly report the wrong
  // questions as retired — the caller would then have to pass the version in
  // force in, and this is the line that has to change.
  const newest = ordered.at(-1);
  const active = new Set(
    newest === undefined
      ? []
      : allQuestions(newest.definition).map((question) => question.id),
  );

  const all = [...entries.values()];
  // For an active question `lastIndex` *is* its index in the newest version —
  // that version is by definition the last one containing it.
  const current = all
    .filter((entry) => active.has(entry.question.id))
    .sort((a, b) => a.lastIndex - b.lastIndex);
  const retired = all
    .filter((entry) => !active.has(entry.question.id))
    .sort((a, b) => a.lastVersion - b.lastVersion || a.lastIndex - b.lastIndex);

  return [...current, ...retired].map((entry) => ({
    question: entry.question,
    firstVersion: entry.firstVersion,
    lastVersion: entry.lastVersion,
    retired: !active.has(entry.question.id),
    typeChanged: entry.typeChanged,
    columns: columnsOf(entry, !active.has(entry.question.id), answers),
  }));
}

/**
 * The columns of one question, in the order the file writes them.
 *
 * The same rule as one level up, and for the same reasons (see the order
 * paragraph of {@link questionHistory}): the newest published shape first, in
 * *its* order, then the parts that shape no longer produces, ordered by the
 * version they were last published in. So a Matrix whose rows were reordered in
 * the builder exports in today's order, and a row deleted along the way follows
 * behind, marked.
 *
 * The consequence is the same one too, and it is deliberate: deleting a Matrix
 * row moves the columns after it. The alternative — ordering by first
 * appearance — would decouple the file from the form and hide a reordering
 * entirely.
 */
function columnsOf(
  entry: HistoryEntry,
  retired: boolean,
  answers: readonly AnswerMap[],
): HistoricColumn[] {
  // The same answer set the accumulator above walked with, and that is what
  // makes the two agree: a row block that only exists because somebody added a
  // row is „active" here and was recorded there, so it is never listed twice —
  // once as a live column and once as a retired one.
  const active = questionColumns(entry.question, answers);
  const activeKeys = new Set(active.map((column) => column.key));

  return [
    // Label and order from the one snapshot `entry.question` came from — never
    // assembled across versions.
    ...active.map((column) => ({
      key: column.key,
      label: column.label,
      retired,
    })),
    ...[...entry.columns.entries()]
      .filter(([key]) => !activeKeys.has(key))
      .sort(
        ([, a], [, b]) =>
          a.lastVersion - b.lastVersion || a.lastIndex - b.lastIndex,
      )
      .map(([key, column]) => ({ key, label: column.label, retired: true })),
  ];
}

/**
 * The columns of the responses view: every question ever published, then the
 * timestamp.
 *
 * The same shape `availableColumns` produces, with one field more, so the table
 * and the export choose from it exactly as before — `retired` is the only thing
 * a caller has to decide what to do about, and the answer the client asked for
 * is "show it, mark it as no longer active".
 *
 * A form with no published version at all yields the timestamp column alone.
 * That is deliberate and it is the whole point: the draft is **never** a source
 * of columns, and a form that was never published has no answers to show either.
 *
 * ## This list is answer-independent, and that is a claim worth stating
 *
 * Everything else that expands a question into columns takes the answer set.
 * This one does not, because it is the **wire** contract: one
 * entry per question, no part keys, and a table is a single tick in the field
 * menu whether a participant added rows to it or not. What could still have
 * depended on the answers is the `columns.length > 0` filter one level down —
 * and today it cannot, for two reasons that are worth naming separately because
 * only one of them is a fact about the *type*:
 *
 * - `tableRowCount` is **monotone**: it returns `max(question.rows, …)`, so
 *   consulting the answers only ever *adds* row blocks to a table's plan and
 *   never takes the last one away;
 * - a table's plan is **non-empty without any answer**, because
 *   `tableQuestionSchema` demands `rows ≥ 1` and at least one Spalte. That is a
 *   rule of the **document content**, not of the type — the empty plan of the
 *   `info` type is the one that follows from the type alone.
 *
 * **Startzeilen were introduced later, and `rows ≥ 1` stays** (2026-08-06). The
 * question this paragraph asked — „was, wenn `rows: 0` erlaubt würde?" — was
 * decided rather than inherited: „beliebig viele Begleitpersonen" is spelled
 * `rows: 1` plus `addRows`, because a table with no start row plans no column
 * while no answer carries one, and the question would drop out of this list —
 * field menu and responses table — while the export, which *does* hold the
 * answers, writes columns for it. The reasoning is written where the bound is
 * (`tableQuestionSchema`); what pins it is `form-schema.test.ts` („refuses a
 * Tabelle without a start row"), which goes red on the bound **alone**.
 *
 * ⚠️ The test below it — „lists a Tabelle, which is asked without any answer in
 * hand" — does **not**: it builds a table with two start rows, so relaxing
 * `rows` to `min(0)` leaves it green until somebody also writes `rows: 0` into
 * a fixture (measured 2026-08-06). It shows the *consequence*, the schema
 * test guards the *bound*, and neither stands in for the other.
 *
 * So the empty set below is the honest argument rather than a placeholder: the
 * caller has no answers in hand (`responseColumnSet` in `forms.service.ts`
 * builds the table's columns without loading a single response), and loading
 * them for a list that cannot change would be a query for nothing.
 */
export function responseColumns(
  snapshots: readonly FormVersionSnapshot[],
): ResponseColumn[] {
  // Mapped down rather than sent as it is: the export columns behind a question
  // are this package's business, and putting them on the wire would invite the
  // client to build a second opinion about what the file contains.
  return responseColumnGroups(snapshots, NO_ANSWERS).map(
    ({ key, label, retired }) => ({
      key,
      label,
      retired,
    }),
  );
}

/**
 * „Keine Antworten" — the empty second source.
 *
 * Named rather than an inline `[]` — see {@link responseColumns} for why it is
 * one. Exported so that the tests of this seam say „keine Antworten" with the
 * same value the production path says it with, rather than each declaring its
 * own `[]` and its own explanation of it.
 */
export const NO_ANSWERS: readonly AnswerMap[] = [];

/**
 * What the responses view calls a column, together with the columns it writes
 * into the file.
 *
 * **The selection happens on this level and the expansion below it**, and that
 * split is the point. The field menu, the `columns=` parameter and
 * `pickDefaultColumns` all work on whole questions — one entry per question, on
 * screen and on the wire, exactly as before — while the file expands each of
 * them into {@link HistoricColumn.columns}. So an Adresse is one tick in the
 * menu and four columns in Excel, and there is still only one answer to „welche
 * Spalten sind gewählt".
 *
 * Server-side only. `ResponseColumn` is the wire contract with the frontend and
 * stays exactly what it was.
 */
export interface ResponseColumnGroup extends ResponseColumn {
  readonly columns: readonly HistoricColumn[];
}

/**
 * The response columns with their export columns — the list the CSV is built
 * from.
 *
 * The timestamp is a group of one, rather than a special case carried alongside:
 * a caller that had to remember „and the timestamp is different" is a caller
 * that will forget.
 *
 * ## A question that writes **no** column is not a column
 *
 * The Infotext is „keine Frage: … keine Spalte in Tabelle und Export", and it
 * says so by producing an empty plan. Dropping it *here* is what makes that one
 * sentence true on every surface at once, because everything downstream reads
 * this list: the field menu would otherwise offer a column that cannot be shown,
 * `pickDefaultColumns` would spend one of its three slots on it, and a selection
 * of nothing but Infotexte would reach `buildCsv` as a header of nothing — a BOM,
 * an empty header line and one empty line per answer.
 *
 * Deliberately not filtered one level up, in {@link questionHistory}: the
 * history is a statement about the *document*, and the document did ask it.
 *
 * ## `answers` — and it has to be the rows the file is built from
 *
 * This is where the header list of the export comes from, and `buildCsv` builds
 * its cell plan from the rows it is handed. The two are the same statement about
 * a table's row blocks only for as long as they are made over the same set:
 * headers from all answers and cells from the filtered ones leave empty columns
 * at the end of the file, the other way round leaves values with no header to
 * stand under. `exportResponses` filters first and then builds both from the
 * result.
 */
export function responseColumnGroups(
  snapshots: readonly FormVersionSnapshot[],
  answers: readonly AnswerMap[],
): ResponseColumnGroup[] {
  return [
    ...questionHistory(snapshots, answers)
      .filter((entry) => entry.columns.length > 0)
      .map((entry) => ({
        key: entry.question.id,
        label: entry.question.label,
        retired: entry.retired,
        columns: entry.columns,
      })),
    {
      key: SUBMITTED_AT_COLUMN,
      label: SUBMITTED_AT_LABEL,
      retired: false,
      columns: [
        { key: SUBMITTED_AT_COLUMN, label: SUBMITTED_AT_LABEL, retired: false },
      ],
    },
  ];
}

/**
 * What a retired column says in a CSV header (client decision, 2026-07-27).
 *
 * German, because it is read by a Mitglied in Excel and not by a developer.
 * Exported so that the one place it is written is this one — a surface that
 * wants the same wording imports it instead of retyping it.
 */
export const RETIRED_COLUMN_NOTE = 'nicht mehr gefragt';

/**
 * The response columns as **CSV headers**: a retired column says so in its
 * header text.
 *
 * The note is added **here**, on the way into the file, and deliberately not in
 * `ResponseColumn.label`:
 *
 * - the wire contract should carry facts, not presentation. `retired` is the
 *   fact; the table renders it as a muted marker next to the header, the file
 *   has no way to render anything and needs words. Baking the words into
 *   `label` would force the table to show the file's phrasing, or to strip it
 *   back off — and stripping a suffix off a label is how a question actually
 *   called „Verpflegung (nicht mehr gefragt)" gets mangled;
 * - the file leaves the application for good. Someone opens it who has never
 *   seen the form, and there an empty cell reads as „nicht ausgefüllt". That is
 *   a different statement from „danach nicht mehr gefragt", and only the header
 *   can tell them apart.
 */
export function csvColumns(
  groups: readonly ResponseColumnGroup[],
): CsvColumn[] {
  // The one place a chosen question becomes the columns of the file.
  // `flatMap`, not `map`: for the nine types of today the two are the same
  // thing, and for an Adresse the difference is four columns instead of one
  // cell somebody has to cut apart in Excel — losing the leading zero of the
  // Postleitzahl in the process.
  return groups.flatMap((group) =>
    group.columns.map((column) => ({
      key: column.key,
      label: column.retired
        ? `${column.label} (${RETIRED_COLUMN_NOTE})`
        : column.label,
    })),
  );
}

/**
 * What publishing the draft would change, against the version **in force**.
 *
 * Against the live version and not against the union: a question retired three
 * versions ago is not being removed again, and repeating it every time would
 * make the warning noise — which is how a warning stops being read.
 *
 * Three kinds, named because no. 23 asks for them by name: what disappears from
 * the form, what appears, and what changes its type. A label change is not
 * among them; it is not a change a stored answer can be hurt by.
 *
 * **A type change wears two ids** (no. 24, no. 26). Retyping a question mints a
 * new one, so by id alone the change looks like a removal plus an unrelated
 * addition — and the editor was shown the same question text twice with nothing
 * saying it is one change. A retyped question therefore names its predecessor
 * (`Question.replaces`), and {@link replacements} turns that into the one
 * pairing this function trusts.
 *
 * `published` is null for a form that has never been published — then
 * everything is an addition, which is the truthful reading of a first publish.
 */
export function publishDiff(
  published: FormDefinition | null,
  draft: FormDefinition,
): FormPublishDiff {
  const before = published === null ? [] : allQuestions(published);
  const after = allQuestions(draft);

  const beforeById = new Map(before.map((question) => [question.id, question]));
  const afterById = new Map(after.map((question) => [question.id, question]));

  const retyped = replacements(after, beforeById, afterById);
  // Keyed both ways: the predecessor is no longer „removed", the successor is
  // no longer „added", and together they are the one line the editor reads.
  const predecessorOf = new Map(
    retyped.map((pair) => [pair.successor.id, pair.predecessor]),
  );
  const replacedIds = new Set(retyped.map((pair) => pair.predecessor.id));

  return {
    // In the order of the document they come from, so the list reads like the
    // form rather than like a hash map.
    removed: before
      .filter(
        (question) =>
          !afterById.has(question.id) && !replacedIds.has(question.id),
      )
      .map(toDiffQuestion),
    added: after
      .filter(
        (question) =>
          !beforeById.has(question.id) && !predecessorOf.has(question.id),
      )
      .map(toDiffQuestion),
    typeChanged: after.flatMap((question) => {
      // By id first: a question that kept its id **is** its predecessor, and a
      // reference beside it cannot outrank that.
      const old = beforeById.get(question.id) ?? predecessorOf.get(question.id);
      if (old === undefined || old.type === question.type) {
        return [];
      }
      // The label of the **draft**: the sentence the editor is about to read
      // is about the question as it will be called after publishing.
      return [
        {
          id: question.id,
          label: question.label,
          from: old.type,
          to: question.type,
        },
      ];
    }),
  };
}

/**
 * **Is there anything to publish?** — the draft against the version in force
 * (2026-07-27).
 *
 * `true` means publishing would produce a version that differs from the one
 * participants are filling in right now; `false` means it would mint a second,
 * byte-identical snapshot and raise the version number for nothing. That number
 * used to be the only sign that the button had done anything at all, so it went
 * up on every press — which is the defect this answers, together with the
 * visible „Fassung N veröffentlicht" the builder now shows.
 *
 * **This is deliberately not {@link publishDiff}, and that is the whole point.**
 * The diff reports three kinds — `removed`, `added`, `typeChanged` — because
 * those are the three that can hurt a stored answer. Rewording a label, editing
 * a hint, changing an option list, flipping „Pflichtfeld", switching a width,
 * reordering questions or renaming a page produce **no diff entry at all**.
 * Gating the button on the diff would therefore lock an editor out of
 * publishing genuine work, and the draft they wrote would never reach a single
 * participant: a silent loss, and a worse one than the extra version it set out
 * to prevent.
 *
 * The **first** publish is always something to do: there is no version in force
 * to differ from, so `published === null` answers `true` without comparing.
 *
 * @see sameDefinition for what "identical" means here.
 */
export function hasUnpublishedChanges(
  published: FormDefinition | null,
  draft: FormDefinition,
): boolean {
  return published === null || !sameDefinition(published, draft);
}

/**
 * Whether two form documents say the same thing.
 *
 * **Structural, over the whole document**, rather than a hand-written
 * field-by-field comparison. A comparison that lists the fields it cares about
 * has to be extended whenever the schema grows — and the failure mode when
 * somebody forgets is not a crash but a *false negative*: the new field's
 * change reads as „nichts zu veröffentlichen", the publish button stays locked,
 * and the editor's work never reaches a participant. New question
 * types add fields nobody has written yet; this function must not need editing
 * for them.
 *
 * Both sides are Zod-parsed, so the set of keys is already decided by the
 * schema. What is *not* decided is the **order** they were written in — a
 * document read back out of JSONB carries the order PostgreSQL stored, which
 * need not be the order the builder produced. `JSON.stringify` on the two would
 * therefore report a difference where there is none, so keys are sorted here.
 *
 * **Array order is kept**, and that is not an oversight: pages, questions and
 * options are sequences a participant reads top to bottom. Reordering them
 * changes the document and is something to publish.
 *
 * A key whose value is `undefined` counts as absent, so the `.optional()`
 * `replaces` of a question compares equal whether it was omitted or written out
 * as `undefined`.
 */
export function sameDefinition(a: FormDefinition, b: FormDefinition): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Narrowing helpers, so the walk below never touches an `any`. */
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON with object keys in a fixed order — the comparable form of a document.
 *
 * Total on purpose: it is handed parsed definitions today, and a function that
 * threw on an unexpected shape would take the publish button down with it.
 *
 * **Exported beyond {@link sameDefinition}** since the 2026-07-29 review of the
 * edit-mail change block: `notification-render.ts` needs the same
 * key-order-independent structural comparison for one answer's raw value, not
 * a whole definition, and a second hand-written deep-equal is exactly the kind
 * of second description this project writes tests against elsewhere.
 */
export function canonicalJson(value: unknown): string {
  if (isList(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      // Absent and „present but undefined" are the same statement, and only
      // one of them survives a round trip through JSONB.
      .filter(([, entry]) => entry !== undefined)
      // By code unit, not by locale: the comparison has to give the same answer
      // on a German laptop and in a CI container.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  // `JSON.stringify(undefined)` is `undefined` at run time while typed as
  // `string`, which is the one way this could return a lie. Named rather than
  // trusted away.
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** A question of the version in force and the draft question that succeeded it. */
interface Replacement {
  readonly predecessor: Question;
  readonly successor: Question;
}

/**
 * The `replaces` references that actually describe a **type change**.
 *
 * A reference is a claim by the draft, not a fact — it survives copy-paste, an
 * undo, a restored question and a builder bug. Four conditions have to hold
 * before the diff reports one change instead of two, and each of them is a case
 * that occurs in ordinary use rather than a defensive flourish:
 *
 * 1. **The predecessor is in force.** Building a question and retyping it
 *    before ever publishing is the normal case, and there the reference points
 *    at something the published version never knew: the draft question is
 *    simply new, and saying „ändert den Typ" would name a change nobody outside
 *    the builder can see.
 * 2. **The predecessor is gone from the draft.** Someone who restores or
 *    duplicates the old question has removed nothing — both questions stand,
 *    and a *type change* would claim a replacement that did not happen.
 * 3. **The successor is itself new.** A question that was published under its
 *    own id is not the replacement of another; taking its reference at face
 *    value would swallow the predecessor's removal without anything appearing
 *    in its place.
 * 4. **The type really differs.** A reference with an unchanged type is what
 *    text → number → text leaves behind. The id changed, so the stored answers
 *    are orphaned exactly as in a removal, and that — removed plus added — is
 *    what the editor is told, because it is what happens.
 *
 * **Two questions naming the same predecessor** should not occur; the builder
 * mints one successor. It is not rejected by the schema, because a stored
 * document is compared, not re-validated, and a diff that throws leaves the
 * editor with no verdict at all on the one form that needs one. The first in
 * document order wins — the order this whole module already reads documents in,
 * so the outcome is the same on every machine — and the second stays a plain
 * addition. Nothing is lost either way: every question still appears exactly
 * once in the verdict.
 */
function replacements(
  after: readonly Question[],
  beforeById: ReadonlyMap<string, Question>,
  afterById: ReadonlyMap<string, Question>,
): Replacement[] {
  const claimed = new Map<string, Replacement>();

  for (const successor of after) {
    const target = successor.replaces;
    if (target === undefined || beforeById.has(successor.id)) {
      continue;
    }
    const predecessor = beforeById.get(target);
    if (
      predecessor === undefined ||
      afterById.has(target) ||
      claimed.has(target)
    ) {
      continue;
    }
    claimed.set(target, { predecessor, successor });
  }

  return [...claimed.values()].filter(
    (pair) => pair.predecessor.type !== pair.successor.type,
  );
}

function toDiffQuestion(question: Question): {
  id: string;
  label: string;
  type: Question['type'];
} {
  return { id: question.id, label: question.label, type: question.type };
}
