import {
  formatAnswerCell,
  questionColumns,
  type CellGuard,
  type QuestionColumn,
} from './answer-columns.ts';
import { allQuestions, type FormDefinition } from './form-schema.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * **The output seam** : what an export *is*, before any format writes
 * it.
 *
 * There used to be one output format, so „welche Zeilen, welche Spalten, was
 * steht in der Zelle" and „wie sieht eine CSV-Datei aus" were the same
 * function. Excel and HTML end that, and the order in which the two
 * halves are separated decides whether the three formats can drift: a second
 * writer that works out its own rows is the defect in as
 * many words — „Zwei Wege in dieselbe Datei sind der Fehler aus Regel 5" — and
 * it happened twice, both times as a leak nobody saw.
 *
 * So the selection happens **here, once**:
 *
 * - the **rows** are handed in already filtered (the caller applies the search
 *   with {@link rowMatchesSearch} over {@link renderRow}, which is the same
 *   rendering the responses table shows);
 * - the **columns** are handed in already chosen ({@link chooseColumns},   „angezeigte / alle"), and the question is asked at the *export*
 *   rather than per format);
 * - {@link buildExportSheet} turns the two into an {@link ExportSheet}, and a
 *   format writer sees **nothing else**. It cannot lose a filter it never had
 *   and cannot answer the column question a second time, because neither the
 *   unfiltered rows nor the full column list is in its hand.
 *
 * ## What the sheet carries, and what it deliberately does not
 *
 * Each cell is a **rendered value plus its guard** — the two things every
 * format needs and the two things no format may decide for itself. The guard is
 * decided at the **question type**, in `questionColumns` (`answer-columns.ts`),
 * which stays the single exhaustive switch; this module only *transports* that
 * decision to whoever writes the file. CSV turns `'text'` into a leading
 * apostrophe, Excel will turn it into a text-typed cell, HTML into nothing at
 * all — three renderings of **one** decision, exactly as intended
 * („anders **gebaut**, aber gleich **entschieden**").
 *
 * What the sheet does *not* carry is escaping. A value arrives here as the
 * participant gave it (`=SUM(A1)`, `01067`, a line break), and each writer
 * neutralises it in its own alphabet. Pre-escaping for one format would hand
 * the next one a value it has to un-escape — „doppelt geschützt ist
 * beschädigt" .
 */

/**
 * A column of the export — one column a question produces, or the submission
 * timestamp.
 *
 * **Not „eine Frage"**: a question contributes one column or
 * several (`questionColumns`), and this is one of them. For the sixteen types
 * that exist today several of them coincide, which is why `key` is a question
 * id in most files the application has written so far.
 *
 * The name still says „Csv" and that is history, not meaning: it is the column
 * of an *export*, whatever format is written from it. It is left as it is
 * because `export-golden.test.ts` — the byte-identity proof this package is
 * measured against — imports it under this name and must not be touched by the
 * change it is proving.
 */
export interface CsvColumn {
  /**
   * A column key as `QuestionColumn` (`answer-columns.ts`) mints it — a
   * question id, an `id#part`, or {@link SUBMITTED_AT_COLUMN}.
   */
  readonly key: string;
  readonly label: string;
}

/** The one column that is not a question. */
export const SUBMITTED_AT_COLUMN = '__submitted_at__';

/** Header of the timestamp column — names the zone, see {@link formatTimestamp}. */
export const SUBMITTED_AT_LABEL = 'Eingereicht am (UTC)';

/** One row of the export, already narrowed to what is being exported. */
export interface CsvRow {
  readonly submittedAt: string;
  readonly answers: AnswerMap;
  /**
   * The schema the row was submitted against, or `null` when that
   * snapshot no longer parses.
   *
   * `null` rather than "leave the row out", for the reasons written at
   * {@link schemalessCells}. The type has to be able to say it, because the
   * caller is the one that discovers it — `exportResponses` `safeParse`s the
   * stored JSONB — and a row it cannot describe is a row it would have to drop.
   */
  readonly definition: FormDefinition | null;
}

/**
 * One cell of the sheet: **what it says, and how it must be protected.**
 *
 * `value` is the rendered answer and nothing more — no quoting, no apostrophe,
 * no escaping. `guard` is the decision `questionColumns` made at the question
 * type, carried here so that every format applies the *same* decision in its
 * own way (see the module comment).
 *
 * **Per cell rather than per column**, although the guard is a property of the
 * column: a row is rendered against **its own** schema version, and two
 * versions may disagree about one column key — a table whose „Anzahl" column
 * was a Zahl in version 1 and free text in version 2 keeps its key across both.
 * Reading one guard off the header would have to pick one of the two versions
 * and would silently misprotect the rows of the other; today's CSV takes the
 * guard from the row's own plan, and the sheet keeps that property rather than
 * flattening it.
 */
export interface ExportCell {
  readonly value: string;
  readonly guard: CellGuard;
}

/**
 * A header cell — a cell that also knows which column it names.
 *
 * `key` is what a writer needs to tell the timestamp column from a question's
 * (the HTML export keeps that one column from wrapping mid-timestamp, an Excel
 * writer may want a width per column); `value` is the header text, already
 * carrying the „nicht mehr gefragt" note that `csvColumns` adds on the way into
 * the file.
 *
 * It is an {@link ExportCell} so that a writer treats header and body with one
 * function and cannot forget to protect the header: a form's label is text an
 * editor typed, and an editor who names a question „=Summe" is guarded exactly
 * like a participant who types it.
 */
export interface ExportHeader extends ExportCell {
  readonly key: string;
}

/**
 * **The format-neutral shape of an export** — one header row and one array of
 * cells per response, all of them aligned to the same columns in the same
 * order.
 *
 * A rectangle, deliberately: `rows[i][j]` belongs under `header[j]` for every
 * `i`, so a writer never has to look a column up and can never put a value
 * under the wrong header. That is the failure mode a CSV has and cannot report
 * — a file that opens with the columns shifted by one.
 */
export interface ExportSheet {
  readonly header: readonly ExportHeader[];
  readonly rows: readonly (readonly ExportCell[])[];
}

/**
 * Builds the sheet — **the one place rows and columns become cells**.
 *
 * Takes the rows *already filtered* and the columns *already chosen*: the
 * rule is that every export follows the visible view, and
 * the surest way to honour that is to make this function — and through it every
 * writer — unable to see anything else.
 *
 * **Every cell is resolved against the row's own schema version** , and
 * that resolution is per *column* rather than per question: the
 * row's questions are asked what columns they produce, and each answer carries
 * its own guard and its own rendering. Nothing here knows what an Adresse or a
 * Matrix is; it knows that a question hands out columns.
 *
 * **The work is proportional to the file, not to the form** — measured, and
 * measured because it is invisible in the output (`export-cost.test.ts`). Two
 * things make that true, and both were briefly untrue after the column seam was
 * cut: the plan is built once per *version* rather than once per row, and only
 * the columns the file actually writes are rendered. A 60-question form
 * exported with one column chosen is 500 formatted cells for 500 answers, not
 * 30 000 — an export is a user action somebody waits for.
 *
 * **The answer set the plan is built from is `rows` itself** : a question's
 * columns depend on the answers as well as on the document,
 * and taking that set from anywhere but the rows being written is a way for the
 * cells and the file to be about two different things. The *headers* come from
 * outside (`csvColumns`), so the caller has to build them from the **same** rows
 * it passes here — a header list built over more rows than are exported leaves
 * empty columns behind, one built over fewer leaves values without a header to
 * stand under. `forms.service.ts` builds both from the filtered set.
 */
export function buildExportSheet(
  columns: readonly CsvColumn[],
  rows: readonly CsvRow[],
): ExportSheet {
  // Keyed by the snapshot object, and local to this call: `columns` is fixed
  // here, so a plan built for it cannot go stale, and nothing outlives the
  // export. The rows of an export share a handful of published versions —
  // `exportResponses` parses each one once and hands the same object to every
  // row that points at it, which is what makes the identity a usable key.
  const plans = new Map<FormDefinition, readonly (PlannedCell | undefined)[]>();
  // Once, not once per version: the set is the same for every plan, and it is
  // the set this file is about.
  const answers = rows.map((row) => row.answers);

  return {
    header: columns.map((column) => ({
      key: column.key,
      value: column.label,
      guard: 'auto',
    })),
    rows: rows.map((row) => {
      const definition = row.definition;
      if (definition === null) {
        return schemalessCells(columns, row.submittedAt);
      }

      const plan = planFor(plans, columns, definition, answers);

      return columns.map((column, index) => {
        if (column.key === SUBMITTED_AT_COLUMN) {
          return {
            value: formatTimestamp(row.submittedAt),
            guard: 'auto' as const,
          };
        }
        const planned = plan[index];
        if (planned === undefined) {
          // The column belongs to something this row's schema version does not
          // have — a question added after the row was submitted, or a part of
          // one (a Matrix row) that it did not carry yet. Empty is the truthful
          // cell: the participant was never asked.
          return EMPTY_CELL;
        }
        // Guard **per column**, from the column that produced the value.
        // Reading it off the question instead would have to pick one guard for
        // an Adresse whose PLZ is text and whose rest is free text, and one of
        // the two is then wrong in a way nobody sees until Excel has eaten a
        // leading zero.
        return {
          value: planned.column.render(row.answers[planned.questionId]),
          guard: planned.column.guard,
        };
      });
    }),
  };
}

/** The cell of a column this row's version has nothing for. */
const EMPTY_CELL: ExportCell = { value: '', guard: 'auto' };

/**
 * The plan of one version, built once and remembered — see the cost note at
 * {@link buildExportSheet}.
 *
 * A function rather than the `let plan = …; if (plan === undefined) …` it
 * replaces, so what the row loop holds is a value that cannot be `undefined`
 * rather than one that merely is not.
 */
function planFor(
  plans: Map<FormDefinition, readonly (PlannedCell | undefined)[]>,
  columns: readonly CsvColumn[],
  definition: FormDefinition,
  answers: readonly AnswerMap[],
): readonly (PlannedCell | undefined)[] {
  const known = plans.get(definition);
  if (known !== undefined) {
    return known;
  }
  const plan = exportPlan(columns, definition, answers);
  plans.set(definition, plan);
  return plan;
}

/**
 * What fills one column of the file, for rows of one published version.
 *
 * The question id travels with the column because a column renders **its** part
 * of the answer to the *whole* question (`QuestionColumn.render`), and the
 * answer is keyed by question — for an Adresse the four columns all read the one
 * stored value.
 */
interface PlannedCell {
  readonly questionId: string;
  readonly column: QuestionColumn;
}

/**
 * The plan of one version, **aligned to the columns of the file**: position `i`
 * says what fills column `i`, or `undefined` when this version has nothing for
 * it (a question added later, the timestamp, a Matrix row it never asked).
 *
 * Aligned rather than a lookup per cell, and built for the *chosen* columns
 * only, because both are what keeps the export proportional to the file. A plan
 * over every question of the form would ask sixty questions for their columns
 * and format sixty cells to write one — the file would be identical, so nothing
 * but a measurement can see it.
 *
 * `answers` is the **whole** set of the export and not the rows of this version,
 * even though the plan is per version: it is the same set the header
 * was built from, computed once (see {@link buildExportSheet}), so plan and
 * header are aligned by construction rather than by argument.
 *
 * **What that is *not* worth, measured** (a review finding): this
 * used to claim that splitting the set by version would „put the values of
 * version 1 under nothing". It would not. The split was run against the whole
 * package — 1392 tests, all green, with the golden case now carrying a
 * growing table over two versions. The reason is structural: a version's
 * plan would be built over a set that **contains its own rows**, and
 * `tableRowCount` is a maximum over that set, so every value a row carries
 * still has a column. Fewer row blocks, yes — but only ones that would have
 * been empty anyway.
 *
 * The line therefore stands on cost and on one property, and the property is
 * the thing to watch: as long as a question's column count over a set covers
 * every answer *in* that set, whole and per-version agree. A column source that
 * broke that — a count read off the first answer, or off the number of answers
 * — would make them differ, and passing the whole set is what keeps that from
 * mattering here. A plan built over a *smaller* set than the header's does show
 * up: handing this the first answer alone makes the golden case red.
 */
function exportPlan(
  columns: readonly CsvColumn[],
  definition: FormDefinition,
  answers: readonly AnswerMap[],
): readonly (PlannedCell | undefined)[] {
  const wanted = new Set(columns.map((column) => column.key));
  const byKey = new Map<string, PlannedCell>();

  for (const question of allQuestions(definition)) {
    for (const column of questionColumns(question, answers)) {
      if (wanted.has(column.key)) {
        byKey.set(column.key, { questionId: question.id, column });
      }
    }
  }

  return columns.map((column) => byKey.get(column.key));
}

/**
 * The cells a row gets when its schema version cannot be resolved: the
 * timestamp, and every other cell empty.
 *
 * ## The row stays in the file
 *
 * Decided on 2026-07-27, against the previous behaviour of leaving it out
 * (`exportCsv` skipped a snapshot that no longer parses). Two reasons:
 *
 * - **„Der Export folgt der sichtbaren Sicht" is a promised property**,
 *   not a convenience. The table keeps such a row — timestamp,
 *   empty cells, and a detail panel that says „Die Fassung dieser Antwort liegt
 *   nicht vor" — so a screen reading „N Antworten" against a file of N−1 lines
 *   breaks the export as a whole and permanently: nobody can tell *which* line
 *   is missing, so no export can be trusted afterwards.
 * - **Dropping a response out of the file silently** is exactly the class of
 *   defect the requirement was written against — data that is there but
 *   nobody can reach any more. The old comment justified skipping as better
 *   than failing the whole export, which is true, and those were never the only
 *   two options.
 *
 * ## The objection, weighed and accepted
 *
 * Empty cells read as „nicht ausgefüllt" rather than „nicht darstellbar". That
 * is true — and it is equally true on screen, where it is already accepted.
 * Saying the two apart properly needs a marking of its own in the data model;
 * that is a larger decision, it is not open here, and it is deliberately not
 * built.
 *
 * Built from {@link renderSchemalessRow}, the same function the responses table
 * renders such a row with, so the file and the screen cannot drift apart on the
 * one path where nobody would notice.
 */
function schemalessCells(
  columns: readonly CsvColumn[],
  submittedAt: string,
): readonly ExportCell[] {
  const cells = renderSchemalessRow(submittedAt);
  return columns.map((column) => ({
    value: cells[column.key] ?? '',
    guard: 'auto',
  }));
}

/**
 * `TT.MM.JJJJ HH:MM`, in UTC.
 *
 * UTC and not the reader's zone, because the file is produced on the server
 * and read who-knows-where; a timestamp that silently means a different
 * instant depending on who opens it is worse than one that is consistently
 * UTC. The column header says so.
 */
export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${String(at.getUTCFullYear())}` +
    ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
  );
}

/**
 * How many questions the **table** shows before the timestamp (design handoff).
 *
 * ⚠️ **Module-private, and staying that way.** The requirement turned the *export's*
 * preselection to „alle Spalten" while the table kept three, and
 * the way that is built is the {@link ColumnSurface} argument of
 * {@link pickDefaultColumns}, threaded through {@link chooseColumns} — never a
 * second function and never this constant read in two places. Both surfaces
 * still answer the column question with one function, which is the whole reason
 * it is shared.
 *
 * `single-source.test.ts` holds both halves of that: `pickDefaultColumns` and
 * this constant are declared in this file and nowhere else, so a
 * `pickExportColumns` next door is a red test rather than a quiet second
 * default.
 */
const DEFAULT_QUESTION_COLUMNS = 3;

/**
 * **Whose Vorbelegung is meant** — the table's or the export's.
 *
 * The two differ in exactly one number and for a reason that is not a matter of
 * taste: the table's three columns are a statement about **screen space**, the
 * export is a statement about **data**. A file is pulled to evaluate and to
 * archive, and a silently trimmed one is data loss nobody notices — a real
 * case measured a form with ten column-bearing questions whose untouched export
 * carried three of them.
 *
 * It is an argument rather than a second function on purpose: „es bleibt
 * **eine** Funktion … mit verschiedenen
 * Argumenten, nie zwei Funktionen". Everything else about the default — that
 * retired questions keep their slot, that a question writing no column does not
 * take one, that the timestamp comes last — is decided once and holds for both
 * surfaces. A second function would have to restate all of it, and the day the
 * two restatements disagree the file stops being what the screen showed.
 *
 * A named union rather than a count, so that no call site spells
 * {@link DEFAULT_QUESTION_COLUMNS} out a second time: `pickDefaultColumns(all, 3)`
 * in the responses view would be exactly the copy this file is guarded against.
 */
export type ColumnSurface = 'table' | 'export';

/**
 * The columns taken when nobody has chosen any — **die Vorbelegung**, and per
 * the requirement a different one per surface.
 *
 * The table takes the first three questions plus the timestamp (design handoff);
 * the export takes **every** question plus the timestamp. Which of the two is
 * meant is {@link ColumnSurface}, and the reasoning for the split is written
 * there.
 *
 * ## „Spalte" here means **question**, on both sides
 *
 * Since a question may occupy several columns in the file, „die ersten drei"
 * needs saying which three. It counts *questions*: the field menu offers
 * questions, the export route names questions in `columns=`, and the default is
 * the first three of them — an Adresse counts once here and writes four columns
 * into the file. Counting expanded columns instead would give a form whose
 * first question is an Adresse a default of that one question and nothing else,
 * and the table (which shows the folded cell) would disagree with the file about
 * what „die Standardsicht" is. That disagreement is exactly what this function
 * exists to make impossible, so the count stays at the level both sides share.
 *
 * **Here rather than twice.** The table and the export each used to spell this
 * rule out on their own side of the wire, in two languages, and they had
 * already drifted: an export with no `columns` parameter rebuilt "the default"
 * from the *server's* reading while the table showed the client's. Whenever the
 * two disagree, the file contains columns that are not on screen — which is
 * precisely the promise of the requirement. It is written once, and both sides
 * run this function over the same list.
 *
 * ## Retired columns are **not** skipped, and that was weighed
 *
 * The list is the union of every published version,
 * so a form with fewer than three questions in force fills the remaining slots
 * with retired ones. Skipping them was considered — a form's history is not
 * obviously something to be shown unasked — and rejected, for three reasons
 * that all point the same way:
 *
 * - the spec says the opposite in as many words: „Eine entfernte Frage **bleibt
 *   als Spalte sichtbar** — erkennbar als nicht mehr aktiv — und bleibt
 *   exportierbar";
 * - this function is the default of the **export** as much as of the table. A
 *   form asking one question today, with one retired behind it, would produce
 *   an untouched export without the retired column — the answers to a removed
 *   question dropping out of the file again, which is the exact defect the
 *   requirement exists to end. In the table a hidden column is one click away in the field
 *   menu; in a file that has left the building it is gone;
 * - the cost of showing it is small and bounded, because it is *marked*: the
 *   header says „nicht mehr gefragt" on screen and in the file. An unmarked
 *   column would be a different matter.
 *
 * Splitting *this* rule so the table skips and the file does not is the one
 * option that must not be taken. ⚠️ Not to be confused with what the requirement
 * does split: that is the **count** — how many of the questions the untouched
 * view takes — and it is a single argument to this one function. Which
 * questions are eligible, in which order, and where the timestamp goes stays
 * one answer for both surfaces, which is what „zwei Vorbelegungen, eine Regel"
 * means.
 *
 * Generic, and returning members of `all` rather than freshly built objects, so
 * a richer column type (`ResponseColumn`, which carries `retired`) keeps its
 * extra fields instead of being flattened on the way through.
 */
export function pickDefaultColumns<T extends CsvColumn>(
  all: readonly T[],
  surface: ColumnSurface,
): T[] {
  const questions = all.filter(
    // …only questions that **write** something. A question with an empty plan
    // (the Infotext) is not a column of anything, and counting it would
    // make „die ersten drei" two — the file and the table would then be short of
    // a question, silently, because a callout box took its slot.
    (column) =>
      column.key !== SUBMITTED_AT_COLUMN && columnsWritten(column) > 0,
  );

  return [
    // The one line the surface decides. `slice` on the export side as well would
    // need a second number to mean „alle", and a number that means „all of them"
    // is a number somebody eventually lowers.
    ...(surface === 'table'
      ? questions.slice(0, DEFAULT_QUESTION_COLUMNS)
      : questions),
    ...all.filter((column) => column.key === SUBMITTED_AT_COLUMN),
  ];
}

/**
 * The visible columns: what the client says it shows, or the default view.
 *
 * **The one column question** : „angezeigte / alle" is
 * asked at the *export* and answered here, once, for every format. That is why
 * it lives beside {@link buildExportSheet} and not beside a writer — a writer
 * never sees the full column list, so it cannot answer the question a second
 * time and cannot disagree with the table about the answer.
 *
 * The whole rule of "the export follows the visible view"  in one
 * function, on both sides of the wire. It used to be written twice — once in
 * `ResponsesView.tsx` and once in `forms.service.ts` — which is how the table
 * and the file came to disagree about what "the default" is.
 *
 * Unknown keys are dropped rather than refused: a selection made before a
 * question was removed is not a bad request, it is a moment out of date. A
 * selection that **writes no column** falls back to the default, so the file is
 * never a header of nothing.
 *
 * „Writes no column" and not „is empty": an entry of the selection
 * may expand into several file columns — or into **none**, which is what an
 * Infotext does. Counting the entries would call a selection of one
 * Infotext a selection, and the file would come out as a BOM, an empty header
 * line and one empty line per answer. `responseColumnGroups` already keeps such
 * an entry off the list, so this is the second lock rather than the first; it is
 * here because this function is the one that promises the property, and the
 * promise should not depend on a filter in another module.
 *
 * `surface` is passed straight on to {@link pickDefaultColumns} and touches
 * nothing else: a stated selection is honoured as stated, on both surfaces.
 * The requirement changed what „nichts gewählt" means, not what „das hier gewählt"
 * means. It is **required** rather than defaulted, because a default would make
 * a forgotten argument on the export side look exactly like a deliberate one —
 * and that mistake is the trimmed file the decision was taken against.
 */
export function chooseColumns<T extends CsvColumn>(
  all: readonly T[],
  requested: readonly string[] | undefined,
  surface: ColumnSurface,
): T[] {
  if (requested === undefined) {
    return pickDefaultColumns(all, surface);
  }
  const wanted = new Set(requested);
  const chosen = all.filter((column) => wanted.has(column.key));
  return writtenColumns(chosen) === 0
    ? pickDefaultColumns(all, surface)
    : chosen;
}

/**
 * How many columns **one** entry of the selection writes into the file.
 *
 * An entry that carries an expansion (`ResponseColumnGroup.columns`, the server
 * side) counts what it expands into — four for an Adresse, none for an Infotext;
 * an entry that does not (`ResponseColumn`, what the client holds — the wire
 * contract deliberately carries no part keys) counts as the one column it is.
 * Read structurally rather than by importing the richer type, because
 * `form-history.ts` already imports *this* module and the two would form a cycle
 * over a question this module can answer on its own.
 */
function columnsWritten(column: CsvColumn): number {
  return 'columns' in column && Array.isArray(column.columns)
    ? column.columns.length
    : 1;
}

/** How many columns a whole selection writes. */
function writtenColumns(selection: readonly CsvColumn[]): number {
  return selection.reduce((total, column) => total + columnsWritten(column), 0);
}

/**
 * The rendered cells of one row, keyed by column — the single description of
 * "what this row looks like".
 *
 * Sorting, searching and the file all read from this, on both sides of the
 * wire. That is what makes „der Export folgt der sichtbaren Sicht"  a
 * property rather than a coincidence: a search that scans these cells cannot
 * match something the file then leaves out.
 *
 * **One cell per question, deliberately, even where the file writes several**
 * (the requirement: „Tabelle und Detailansicht in der Anwendung zeigen weiterhin eine
 * Zeile"). The screen shows the folded answer; only the file takes it apart. The
 * property above survives that because the folded cell *contains* what the parts
 * contain — a search for a Postleitzahl matches the row on screen and keeps it
 * in the file — which is the one thing a folded rendering has to guarantee and
 * the reason `formatAnswerCell` and `questionColumns` sit in the same module.
 */
export function renderRow(
  definition: FormDefinition,
  submittedAt: string,
  answers: AnswerMap,
): Record<string, string> {
  const cells = renderSchemalessRow(submittedAt);
  for (const question of allQuestions(definition)) {
    cells[question.id] = formatAnswerCell(question, answers[question.id]);
  }
  return cells;
}

/**
 * The cells a row has when its schema version cannot be resolved — the
 * timestamp and nothing else.
 *
 * The one cell that needs no schema, which is why it is the one a row keeps
 * when the snapshot it names is missing (`toRow` in the web app). It is stated
 * here, next to {@link renderRow} and used *by* it, rather than rebuilt at the
 * call site: the column key and the timestamp format are decided in this module,
 * and a second spelling of them would drift the moment either changes — silently,
 * because the path that uses it is the rare one.
 */
export function renderSchemalessRow(
  submittedAt: string,
): Record<string, string> {
  return { [SUBMITTED_AT_COLUMN]: formatTimestamp(submittedAt) };
}

/**
 * Whether a row matches a search term — **the one row question**.
 *
 * Over **every** rendered cell including the timestamp. Leaving the timestamp
 * out — as the server did — meant a search for „20.07.2026" listed rows in the
 * table and produced a file with nothing but a header row.
 *
 * It sits in this module rather than beside a writer for the reason
 * {@link chooseColumns} does: the row set of *every* format is the set this
 * function keeps, decided before {@link buildExportSheet} is called. A format
 * that worked out its own rows would eventually lose a filter, which is the
 * defect that happened twice.
 */
export function rowMatchesSearch(
  cells: Record<string, string>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return Object.values(cells).some((cell) =>
    cell.toLowerCase().includes(needle),
  );
}
