import { eventChips } from './event-chips.ts';
import {
  isChoiceQuestion,
  otherLabelOf,
  TABLE_ROWS_MAX,
  type Question,
  type TableColumn,
} from './form-schema.ts';
import {
  attachmentsOf,
  isAddressAnswer,
  isEventAnswer,
  isFileAnswer,
  isMatrixAnswer,
  isTableAnswer,
  seatsOf,
  type AddressAnswer,
  type AnswerMap,
  type AnswerValue,
  type MatrixAnswer,
  type TableAnswer,
} from './response-validation.ts';

/**
 * **Which columns one question contributes to the export, and how each of them
 * is filled.**
 *
 * The answer to the first half used to always be „genau eine", and the
 * assumption was not written down anywhere — it was simply the shape of the
 * code: a column key *was* a question id, and the cell was `formatAnswerCell`
 * of that question. Three of the newer types break it at once — Adresse
 * (Straße, PLZ, Ort, Land), Matrix (one column per row) and Tabelle (one
 * column per cell) — so the seam is cut **here, once, before** any of them
 * exists. Three packages discovering it separately is three answers to one
 * question.
 *
 * ## One list, not two lists that have to agree
 *
 * A {@link QuestionColumn} carries its key, its header, its guard **and** how
 * to render its cell. The obvious alternative — one function for the headers
 * and another for the values — is two descriptions of the same thing, and the
 * failure mode when they drift is the worst one a CSV has: a value under the
 * wrong header, silently. Here a column cannot exist without saying what goes
 * in it.
 *
 * ## What stays true, and is the reason this file is separate at all
 *
 * `cellGuardFor` used to be exhaustively switched over the question type so a
 * new type could not inherit „ungeschützt" in silence. That property moves
 * *down* to the column, where it now belongs: {@link questionColumns} is the
 * exhaustive switch, and every branch has to say — per column — how its cells
 * are guarded. A type added without a branch is a compile error, exactly as
 * before.
 *
 * ## Two sources,: the form **and** the answers
 *
 * The plan used to be a function of the *document* alone — a form could be
 * asked what its file looks like with no answer in hand. That ends here:
 * a participant may add rows to a table („+ Zeile"), so the number of row
 * blocks is „so viele, wie die **längste** Antwort Zeilen hat". The answer set
 * is therefore an **explicit parameter** of {@link questionColumns}, and that
 * is the whole of the reason: the seam is cut once, before Excel and HTML sit
 * on it, rather than three times afterwards.
 *
 * **Required, never defaulted**, for the reason `escapeCsvCell`'s `guard` is:
 * a caller that forgets would silently get the form-only plan, and „forgot" is
 * indistinguishable from „meant it" at the one call site where it decides
 * anything. Passing an empty set is a statement a reader can check
 * (`responseColumns` makes it and says why); an omitted argument is not.
 *
 * **The whole set, and not just the values of this question.** The lookup „die
 * Antwort auf eine Frage steht unter ihrer Id" is then written once, here, next
 * to the `render` that reads the very same key — rather than at every caller,
 * where the four spellings of it would be four chances to project the wrong id
 * into a plan nobody can see afterwards.
 *
 * **`cellGuardFor` itself is gone** (a review finding, 2026-07-31). It survived
 * the refactor as a wrapper that looked the guard back up by key, because it was
 * still named in three places — and then had no caller left, since `buildCsv`
 * takes the guard from the column that produced the value. A function kept alive
 * by its own tests is worse than no function: „jede Zelle geht durch
 * `cellGuardFor`"  could be asserted, stay green, and say nothing about
 * the file. Those places say {@link questionColumns} now; there is one place
 * where a guard is decided, and it is the place the export reads.
 */

/**
 * How a cell is to be guarded — decided by the **column**, not by what the
 * value happens to look like.
 *
 * Guessing from the string is what produced the inconsistency this type exists
 * to remove: `+49 6421 123456` was neutralised because it starts with a
 * formula prefix, while `01603884482` was not, because it does not — and the
 * second one then reached Excel as a *number*, which drops the leading zero
 * and turns a phone number into `1603884482`. Two answers to the same question
 * ended up handled two different ways, and one of them lost data.
 *
 * - `'number'` — produced by this module from a numeric answer. Never
 *   prefixed: it cannot be a formula, and prefixing it would make „Summe"
 *   skip the row.
 * - `'text'` — must stay text whatever it contains. Always prefixed, so every
 *   value of such a column looks the same and none is re-interpreted.
 * - `'auto'` — free text. Prefixed only when it begins like a formula.
 * - `'date'` — the answer to a `date` question, rendered `TT.MM.JJJJ`. In a
 *   CSV it is indistinguishable from `'auto'` (the string starts with a digit,
 *   so nothing is prefixed either way); in `.xlsx` it becomes a **date cell**,
 *   which is the whole reason the guard exists. It is required
 *   that „ein Datum so steht, dass Excel es als Datum sortiert", and until
 *   recently that held for the submission timestamp alone — a `date` **question**
 *   carried `'auto'`, landed as text, and sorted `01.12.` before `02.01.`.
 *
 *   It is a guard and not a special case in the writer for the reason the whole
 *   type exists: the writer must not decide anything from the *shape* of a
 *   value. `27.07.2026` and a free text somebody typed as `27.07.2026` look
 *   identical; only the question tells them apart, and only here is the
 *   question still in scope.
 *
 * **Per column and not per question**: an Adresse is one question
 * whose PLZ column is `'text'` (leading zero) while the rest is `'auto'`, and
 * a Tabelle mixes free text with numbers cell by cell. A guard chosen for the
 * whole question would have to pick one of them and lose the other.
 */
export type CellGuard = 'number' | 'text' | 'auto' | 'date';

/**
 * Separates a question id from the part of the answer a column carries.
 *
 * `#` because a question id is a UUID (`questionSchema`), and a UUID cannot
 * contain one — so a part key can never collide with another question's id, and
 * the question a column belongs to stays readable in a stack trace.
 *
 * **Part keys do not travel on the wire.** The column *selection* (the field
 * menu, `columns=` on the export route) works on whole questions, which is what
 * keeps the table and the file choosing from the same list; see
 * `pickDefaultColumns`. These keys exist inside the file and inside this
 * package, nowhere else.
 */
export const COLUMN_KEY_SEPARATOR = '#';

/**
 * Separates the question's label from the part's in a header — `Anschrift — PLZ`.
 *
 * An em dash with spaces, the spelling the requirement writes out
 * (`Frage — Spalte (Zeile n)`). It is a header a Mitglied reads in Excel,
 * so it has to say which question the column belongs to *and* which part of it.
 */
export const COLUMN_LABEL_SEPARATOR = ' — ';

/**
 * The four parts of an Adresse answer, in the order the handoff's own grid
 * shows them (Straße full width, then PLZ and Ort next to each other, then
 * Land full width).
 *
 * Exported so the fill-in view's four `<input>`s (`FieldInput.tsx`) use the
 * same labels the export's column headers do. Two independent lists —
 * placeholders here, headers there — is exactly the drift this module's own
 * doc comment warns about for headers and cell values; naming the parts once
 * closes it for their labels too.
 */
export const ADDRESS_PARTS: readonly {
  readonly key: keyof AddressAnswer;
  readonly label: string;
}[] = [
  { key: 'street', label: 'Straße & Hausnummer' },
  { key: 'zip', label: 'PLZ' },
  { key: 'city', label: 'Ort' },
  { key: 'country', label: 'Land' },
];

/**
 * One column of the export, produced by one question.
 *
 * `render` takes the answer to the **whole question** and returns this column's
 * cell — for a single-column question that is the whole answer, for a part it is
 * the piece belonging to that part. It never sees the other questions' answers,
 * which is what keeps a column a statement about its own question.
 */
export interface QuestionColumn {
  /**
   * The question id for a single-column question, `id#part` otherwise.
   *
   * Stable across versions, because it is what the union of published versions
   * is merged by (`questionHistory`): a Matrix row that existed in version 1
   * keeps its column after being removed in version 2 only for as long as it
   * keeps its key.
   */
  readonly key: string;
  /** The header, without the „nicht mehr gefragt" note — that is added on the way into the file. */
  readonly label: string;
  readonly guard: CellGuard;
  readonly render: (value: AnswerValue | undefined) => string;
}

/**
 * The columns one question produces — **the exhaustive switch** .
 *
 * Every type of question answers two things here: how many columns it occupies
 * in the file, and how each of them is guarded. The nine types below all
 * answer „eine Spalte, gefüllt mit {@link formatAnswerCell}", which is what the
 * export did before this function existed and is why the files it produces are
 * byte for byte the ones it produced then.
 *
 * The guards, and why each is what it is:
 *
 * - **Telefon → `'text'`, always.** Two reasons, and the second is the one that
 *   loses data. A phone number is never arithmetic, so nothing is given up by
 *   keeping it text — and a German number written the ordinary way,
 *   `01603884482`, arrives in Excel as the *number* 1603884482 with the leading
 *   zero gone. Guarding only the `+49…` spelling would neutralise one form of
 *   the same answer and quietly damage the other; every phone number is
 *   therefore treated alike.
 * - **Zahl → `'number'`.** The string was produced here from a numeric answer;
 *   it cannot be a formula, and prefixing it would take the row out of any sum.
 * - **Everything else → `'auto'`.** Free text a participant typed, guarded when
 *   it begins like a formula. Not forced to text, because that would put an
 *   apostrophe in front of every name in the file.
 *
 * The apostrophe is visible when the CSV is opened — that is the accepted cost,
 * confirmed with the client on 2026-07-27. It is preferred over a value that
 * either executes or silently changes.
 *
 * **Written out rather than left to a `default`**, for the same reason
 * `buildAnswersSchema` is exhaustive: a type added (Adresse, Matrix,
 * Tabelle, Datei-Upload) would otherwise pick up „eine Spalte, `'auto'`" in
 * silence — which is precisely the mechanism that produced the defect the guard
 * exists to fix, now with a second way to be wrong (a folded cell nobody can
 * evaluate). Without a branch here it is a compile error.
 *
 * @param answers **Every** answer the file (or the table) is about — not the
 * answers to this question, and not one of them. `table` is the one branch that
 * reads it, through {@link tableRowCount}; the other fifteen ignore it.
 *
 * The counter-check that pins that (`answer-columns.test.ts`, „plans a %s question
 * the same with answers as without") runs over **all sixteen** types, `table`
 * included — and `table` passes it as well: its sample answer carries a single
 * cell row while the fixture form offers two, so `max(2, 1)` is the form's own
 * count and the two plans agree. It is therefore a guard that nothing *else*
 * started reading the set, not a proof that `table` does; that proof is
 * `die wachsende Tabelle` beside it.
 */
export function questionColumns(
  question: Question,
  answers: readonly AnswerMap[],
): QuestionColumn[] {
  switch (question.type) {
    case 'phone':
      return [wholeAnswer(question, 'text')];
    // The star count is a `number` answer (`response-validation.ts`), never a
    // formula: guarding it as text would make Excel sort „10" before „2" the
    // same way a phone number does not, which is exactly the defect this
    // guard exists to prevent.
    case 'number':
    case 'rating':
      return [wholeAnswer(question, 'number')];
    // Its own guard, and the reason is written at `CellGuard`:
    // the rendered `TT.MM.JJJJ` is a date to a reader and a string to a
    // spreadsheet, and this is the last place that still knows which.
    case 'date':
      return [wholeAnswer(question, 'date')];
    case 'text':
    case 'textarea':
    case 'email':
    case 'select':
    case 'radio':
    case 'checkbox':
      return [wholeAnswer(question, 'auto')];
    // **The empty case with two locks built around it.** An
    // `info` is a callout, not a question: no column in the responses table,
    // no column in the export, and nothing for the field menu to offer. Every
    // caller of `questionColumns` has to cope with a question that
    // contributes zero columns — this is the type that actually does.
    case 'info':
      return [];
    // **Four columns, one question** — the seam's other real user, next to the empty case just above it. PLZ is
    // `'text'`, always: it is the one part a spreadsheet reinterprets, the
    // exact damage `phone` above is guarded against, and unlike a phone
    // number this is a plain five-digit string with no formula character to
    // fall back on — `'text'` rather than trusting `escapeCsvCell`'s
    // digit-string round trip is deliberately breakable on purpose (set it to
    // `'number'` and `01067` comes back `1067`).
    // The other three parts are free text, so `'auto'`.
    case 'address':
      return ADDRESS_PARTS.map((part) =>
        addressPart(
          question,
          part.key,
          part.label,
          part.key === 'zip' ? 'text' : 'auto',
        ),
      );
    // **One column per row** : the statement is
    // the header, the picked scale step is the value. A 3×4 Matrix therefore
    // contributes **three** columns, not twelve and not one — the scale is
    // what a cell *contains*, the statements are what the columns *are*.
    // Folding it into „Organisation: Sehr gut; Programm: Gut" would make the
    // one thing a Matrix is collected for — comparing one statement across all
    // responses — impossible without cutting the cell apart again.
    //
    // `'auto'`, like every other free-text column: the value is a scale label
    // an editor typed, and an editor who writes „=Sehr gut" is guarded the
    // same way a participant is.
    case 'matrix':
      return question.rows.map((row) => ({
        key: `${question.id}${COLUMN_KEY_SEPARATOR}${row.value}`,
        label: `${question.label}${COLUMN_LABEL_SEPARATOR}${row.label}`,
        guard: 'auto' as const,
        render: (value: AnswerValue | undefined) =>
          isMatrixAnswer(value)
            ? scaleLabels(question, pickedIn(value, row.value)).join(', ')
            : '',
      }));
    // **One column per cell**  — `columns × rows` of them, so
    // a table with 3 Spalten × 2 Zeilen contributes **six**. The header is
    // the spelling used everywhere: `Frage — Spalte (Zeile n)`, `n`
    // counted from 1 because that is the row a participant sees.
    //
    // **The guard belongs to the column, not to the question** — and a Tabelle is the
    // type where that stops being a nicety: a Zahl column is `'number'` (it
    // must stay summable) while the Text column beside it is `'auto'` (a
    // participant may type `=1+1` into it). One guard for the whole question
    // would have to give up one of the two.
    // **One column, and in it stand the file names — nothing else**
    // (ADR-0014 no. 17). Not the address, because an export
    // is the document that gets mailed on and left on network drives, and an
    // address in it is an invitation to paste it into a browser; not the
    // `public_ref` „als bloße Kennung" either, because that is a URL with a
    // piece missing. The way to the file is the responses view, behind the
    // guard chain.
    //
    // **`'auto'`, and that is the whole of the requirement for this line.** A
    // file name is free text a stranger chose: `=cmd|'…'!A1.xlsx` is a
    // perfectly legal one, and „ist ja nur ein Dateiname" is exactly how a
    // column inherits „ungeschützt". It gets the guard every other free-text
    // column gets, from the same place, and the proof is an export carrying
    // such a name — not a look at this line.
    case 'file':
      return [wholeAnswer(question, 'auto')];
    // **One column per event, and in it stands a number** („eine Spaltengruppe im Export"). The same shape the
    // Matrix takes one type earlier — the entry is the header, the answer is the
    // cell — because it is the same question: „wie viele je Veranstaltung" is
    // only answerable per column, and „Sommerfest: 3; Stadtfest: 2" folded into
    // one cell would have to be cut apart again to sum a single event, which is
    // the one thing this list is collected for.
    //
    // **`'number'`, like `number` and `rating`**: the cell is produced here from
    // a numeric answer, so it cannot be a formula, and guarding it as text would
    // put an apostrophe in front of every seat count and take the column out of
    // any „Summe" — which is exactly the arithmetic a Geschäftsstelle does with
    // this file. An event nobody registered for is an **empty** cell, not a `0`:
    // the answer does not carry the key (`EventAnswer` is sparse), and a zero
    // written here would claim a registration of zero people that nobody made.
    case 'event':
      return question.events.map((event) => ({
        key: `${question.id}${COLUMN_KEY_SEPARATOR}${event.key}`,
        label: `${question.label}${COLUMN_LABEL_SEPARATOR}${event.label}`,
        guard: 'number' as const,
        render: (value: AnswerValue | undefined) => {
          const seats = new Map(seatsOf(value));
          const count = seats.get(event.key);
          return count === undefined ? '' : String(count);
        },
      }));
    //
    // **The one branch that reads `answers`:** the row
    // count is the form's *and* the longest answer's, see {@link tableRowCount}.
    // Everything below it is unchanged, and deliberately so — a row that only
    // exists because somebody added it gets its key, its header and its guard
    // from the same three lines the form's own rows get them from, so „der
    // Schutz liegt je Spalte" cannot hold for the first three rows and lapse for
    // the fourth. The guard is a function of the **Zelltyp** and of nothing
    // else; the row index does not appear in it.
    case 'table': {
      const rows = tableRowCount(question, answers);
      return question.columns.flatMap((column) =>
        Array.from({ length: rows }, (_, rowIndex) => ({
          key: `${question.id}${COLUMN_KEY_SEPARATOR}${String(rowIndex)}${COLUMN_KEY_SEPARATOR}${column.key}`,
          label: `${question.label}${COLUMN_LABEL_SEPARATOR}${column.label} (Zeile ${String(rowIndex + 1)})`,
          guard: tableColumnGuard(column),
          // An answer with fewer rows has **nothing** at this index, and
          // `cellRows(value)[rowIndex]` is `undefined` — one empty cell, in its
          // own column. Not a shifted one: the value a shorter answer *does*
          // carry stays under the row number it was given, because the index
          // into the stored array is the index of the column and never a
          // running counter over what happens to be present.
          render: (value: AnswerValue | undefined) =>
            isTableAnswer(value)
              ? formatTableCell(
                  column,
                  keyOf(cellRows(value)[rowIndex], column.key),
                )
              : '',
        })),
      );
    }
  }
}

/**
 * How many row blocks a table occupies in the file: what the **form** offers,
 * or what the **longest answer** carries — whichever is more.
 *
 * Three properties, and each of them is a line of the requirement:
 *
 * - **The longest, not the first.** A maximum over the set, so the file has a
 *   column for every row anybody filled in. Reading the length off the first
 *   answer would make the widest table in the file a matter of who submitted
 *   first — and the rows of everyone after them would silently not be in it.
 * - **Order cannot matter.** `Math.max` over a set is the same number whichever
 *   way the set is walked, which is why „die Reihenfolge der Spalten ist
 *   unabhängig von der Reihenfolge der Antworten" is a property here rather
 *   than a thing to be careful about. The test reverses the set and compares.
 * - **Never below the form's own rows.** A form offering three rows keeps three
 *   columns when nobody filled in anything — otherwise the question would
 *   disappear from the file exactly when the export is used to find out that
 *   nobody answered.
 *
 * ## The ceiling, and why it is here rather than only in the request path
 *
 * This function runs over `cells` arrays that reached the database as JSONB and
 * arrive here through an `as AnswerMap` cast (`forms.service.ts`) — the same
 * foreign data every reader in this module is written to survive. The product
 * rule that bounds a submission belongs in the rejection chain of `submit()`
 * and is the first lock's; this is the second lock, and it
 * bounds what **one** stored row may decide about the width of everybody's
 * file.
 *
 * ⚠️ **Above the ceiling, values disappear from the file without a word.** A
 * stored answer with `TABLE_ROWS_MAX + 5` rows is planned at `TABLE_ROWS_MAX`
 * blocks; the five rows beyond it have no header, no column and no marker — the
 * file simply stops. That is the accepted price of bounding what **one** stored
 * row may decide about the width of everybody's file, and it is only acceptable
 * for as long as nothing above can legally produce such an answer.
 *
 * ⚠️ **Nothing here notices when that stops being true, and the first lock is
 * where it can stop.** The per-question Obergrenze of the requirement — however it ends
 * up spelled in `tableQuestionSchema` — is the number the **server accepts**;
 * `TABLE_ROWS_MAX` is the number the **file writes**. As long as the first may
 * exceed the second, the difference is data the application took and cannot show.
 * **The place to settle that is the schema, not this line**: a per-question
 * Obergrenze bounded by `TABLE_ROWS_MAX` makes a document that could overrun the
 * file stop parsing, instead of one that quietly writes a short one. No test at
 * this end can stand in for it — this function never sees what the request path
 * lets in.
 */
function tableRowCount(
  question: Question & { type: 'table' },
  answers: readonly AnswerMap[],
): number {
  let longest = 0;
  for (const answer of answers) {
    const value = answer[question.id];
    if (isTableAnswer(value)) {
      longest = Math.max(longest, cellRows(value).length);
    }
  }
  return Math.max(question.rows, Math.min(longest, TABLE_ROWS_MAX));
}

/**
 * **What a `render` may assume about the value it is handed: nothing** (a
 * review finding, measured 2026-07-31).
 *
 * The three `is…Answer` guards narrow by the presence of *one key*, never by
 * what is under it — that is stated at each of them. A column that went on to
 * treat `value.zip` as a string therefore reached `escapeCsvCell` with a number
 * in hand, and `guardValue`'s `value.startsWith(…)` threw a `TypeError` that no
 * `try` catches: **one** damaged row took the **whole** export down, which is
 * the exact failure {@link formatAnswerCell} argues against two screens further
 * down for a value it cannot render.
 *
 * The four readers below are the answer, and they are used by every `render` in
 * this file: a subfield that is not a string, a Matrix row that is not an array
 * of strings, a `cells` that is not an array all read as „nothing here" — the
 * same answer this module already gives an unknown option or an absent value.
 * They cannot repair a document and do not try; they only keep one bad row from
 * being everybody's problem.
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One key of a value that is supposed to be an object — `undefined` when it is
 * not one.
 *
 * The cast is the one `objectValues` (`response-validation.ts`) already makes
 * and is bounded the same way: the result is `unknown` and every caller has to
 * decide what it is before using it.
 */
function keyOf(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null && !Array.isArray(source)
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

/** The scale steps picked in one Matrix row, as they come out of JSONB. */
function pickedIn(answer: MatrixAnswer, row: string): string[] {
  const picked = keyOf(answer.rows, row);
  return Array.isArray(picked)
    ? picked.filter(
        (entry: unknown): entry is string => typeof entry === 'string',
      )
    : [];
}

/** The rows of a table answer — an array, or nothing to show. */
function cellRows(answer: TableAnswer): readonly unknown[] {
  return Array.isArray(answer.cells) ? answer.cells : [];
}

/**
 * The guard of one table column — decided by the **Zelltyp**, which is the
 * only thing that knows what its cells can contain.
 *
 * A Haken renders as „Ja" and a Liste as an option label an editor typed;
 * both are `'auto'` for the same reason free text is. Only a Zahl column is
 * `'number'`, and only because its cells are produced from numeric answers by
 * {@link formatTableCell} — the same claim `number` and `rating` make above.
 */
function tableColumnGuard(column: TableColumn): CellGuard {
  return column.type === 'number' ? 'number' : 'auto';
}

/**
 * One table cell as text — the same value in the file and on screen.
 *
 * **`unknown`, not `TableCellValue`**: the cell comes out of a `cells` object
 * that no guard has looked inside (see {@link textOf}), so the type would be a
 * claim rather than a fact. Every branch decides for itself.
 */
function formatTableCell(column: TableColumn, cell: unknown): string {
  if (cell === undefined) {
    return '';
  }
  if (typeof cell === 'boolean') {
    // `true` is the only stored boolean (`TableCellValue`); a `false` that
    // reached the column anyway is not an answer and reads as an empty cell
    // rather than as „Nein", which would claim something nobody said.
    return cell ? 'Ja' : '';
  }
  if (typeof cell === 'number') {
    // German decimal comma, the rule `formatAnswerCell` applies to every other
    // number in the file.
    return String(cell).replace('.', ',');
  }
  if (column.type === 'select') {
    const option = column.options.find((candidate) => candidate.value === cell);
    // The label, falling back to the raw value for an option that has since
    // been removed — the same choice `formatAnswerCell` makes and for the same
    // reason: an empty cell would look like „nicht beantwortet".
    return option?.label ?? textOf(cell);
  }
  // `TableCellValue` says string by now; a document this application did not
  // write may still hold an object here, and returning it would hand a
  // non-string to `escapeCsvCell` (see {@link textOf}).
  return textOf(cell);
}

/** The scale steps of a Matrix row as their **labels**, in the picked order. */
function scaleLabels(
  question: Question & { type: 'matrix' },
  picked: readonly string[],
): string[] {
  return picked.map((value) => {
    const column = question.columns.find(
      (candidate) => candidate.value === value,
    );
    return column?.label ?? value;
  });
}

/** The single column of a question whose answer is not taken apart. */
function wholeAnswer(question: Question, guard: CellGuard): QuestionColumn {
  return {
    key: question.id,
    label: question.label,
    guard,
    render: (value) => formatAnswerCell(question, value),
  };
}

/** One column of an Adresse — the part of the answer this one column carries. */
function addressPart(
  question: Question,
  part: keyof AddressAnswer,
  partLabel: string,
  guard: CellGuard,
): QuestionColumn {
  return {
    key: `${question.id}${COLUMN_KEY_SEPARATOR}${part}`,
    label: `${question.label}${COLUMN_LABEL_SEPARATOR}${partLabel}`,
    guard,
    render: (value) => (isAddressAnswer(value) ? textOf(value[part]) : ''),
  };
}

/**
 * One answer as a single cell — the **folded** rendering.
 *
 * This is what the application shows: the responses table, the detail panel and
 * the notification mails all put one answer on one line (the requirement says so in
 * as many words for the Adresse — „Tabelle und Detailansicht in der Anwendung
 * zeigen weiterhin eine Zeile"). The *file* is the surface that takes an answer
 * apart, through {@link questionColumns}.
 *
 * Choice answers become their **labels**, joined — the export is read by a
 * person, and `ja` says less than `Ja, ich komme`. The labels are looked up in
 * the schema version the answer was validated against, which is what
 * keeps an export of a form that has since been reworked readable rather than
 * merely non-crashing.
 *
 * A value whose option no longer exists is shown as the raw value rather than
 * dropped: it is what the participant chose, and the alternative is an empty
 * cell that looks like "did not answer".
 */
export function formatAnswerCell(
  question: Question,
  value: AnswerValue | undefined,
): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'number') {
    // German decimal comma, because the file is opened in a German Excel and
    // `4.5` would be read as a date there.
    return String(value).replace('.', ',');
  }

  if (typeof value === 'string') {
    // A date answer is `YYYY-MM-DD` (the validator pins the format), and the
    // file it lands in already writes `TT.MM.JJJJ` in its timestamp column.
    // Two date notations side by side in one spreadsheet is the kind of detail
    // that makes a reader distrust the whole export — found during an
    // acceptance run, where „Stichtag 2026-05-15" sat next to „Eingereicht am
    // 27.07.2026".
    return question.type === 'date' ? formatIsoDate(value) : value;
  }

  // The **folded** half of the Adresse answer (named in as many
  // words: „Tabelle und Detailansicht in der Anwendung zeigen weiterhin eine
  // Zeile"). Checked ahead of the choice branch below — an `AddressAnswer` is
  // also a plain object, and `isChoiceQuestion` alone would not have kept it
  // out, only the two shapes' disjoint keys do (`isAddressAnswer`).
  if (isAddressAnswer(value)) {
    const streetAndCity = [textOf(value.zip), textOf(value.city)]
      .filter((part) => part.trim() !== '')
      .join(' ');
    return [textOf(value.street), streetAndCity, textOf(value.country)]
      .filter((part) => part.trim() !== '')
      .join(', ');
  }

  // The **folded** halves of the two structured answer types — what
  // the responses table, the detail panel and the notification mails show.
  // This is precisely the rendering known as „nicht auswertbar"
  // *for the file*, and it is the right one *on screen*: a row of the
  // responses table has one cell per question, and a reader wants the whole
  // answer at a glance. The file takes it apart (`questionColumns`).
  if (isMatrixAnswer(value)) {
    if (question.type !== 'matrix') {
      return '';
    }
    return question.rows
      .map((row) => ({
        row,
        labels: scaleLabels(question, pickedIn(value, row.value)),
      }))
      .filter((entry) => entry.labels.length > 0)
      .map((entry) => `${entry.row.label}: ${entry.labels.join(', ')}`)
      .join('; ');
  }

  // The **folded** file answer: the names, joined — the same cell the export
  // writes and the responses table shows (ADR-0014 no. 17). Checked ahead of
  // the choice branch for the reason the Adresse is: a `FileAnswer` is a plain
  // object too, and only the disjoint keys keep the two apart.
  //
  // A comma and a space rather than „, " with a count or a bullet: it is the
  // separator every other folded multi-value cell in this file already uses
  // (a choice answer's labels), and one spelling of „mehrere" beats two.
  if (isFileAnswer(value)) {
    return attachmentsOf(value)
      .map((file) => file.name)
      .join(', ');
  }

  // The **folded** Veranstaltung answer — „Sommerfest: 3; Stadtfest: 2",
  // the spelling the Matrix branch above already uses for the same shape of
  // answer. This is what the responses table, the CSV cell and the notification
  // mails show; the file takes it apart into one column per event
  // (`questionColumns`), which is the division the requirement draws for the Adresse
  // and this type inherits for the same reason.
  //
  // **Which events count as answered, and in which order, is decided in
  // `eventChips`**  and only *written out* here. The detail panel draws
  // the same list as chips, and two walks over one answer are the second read
  // path `CONTRIBUTING.md` warns against — the day „was zählt als angemeldet" changes,
  // one of the two surfaces would keep the old rule with nothing going red.
  if (isEventAnswer(value)) {
    return eventChips(question, value)
      .map((chip) => `${chip.label}: ${String(chip.seats)}`)
      .join('; ');
  }

  if (isTableAnswer(value)) {
    if (question.type !== 'table') {
      return '';
    }
    return cellRows(value)
      .map((row) =>
        question.columns
          .map((column) => ({
            column,
            text: formatTableCell(column, keyOf(row, column.key)),
          }))
          .filter((entry) => entry.text !== '')
          .map((entry) => `${entry.column.label}: ${entry.text}`)
          .join(', '),
      )
      .filter((line) => line !== '')
      .join('; ');
  }

  if (!isChoiceQuestion(question) || !Array.isArray(value.values)) {
    // Not reachable through any write path — every stored answer went through
    // the validator derived from its own schema version. Checked anyway,
    // because the alternative is `value.values.map` on foreign JSONB, and the
    // failure mode there is a `TypeError` that takes the whole export (or the
    // whole table) down over one damaged row.
    return '';
  }

  // Narrowed by predicate rather than cast: `Array.isArray` on foreign data
  // yields `any[]`, and taking that at its word is the very thing
  // `CONTRIBUTING.md` forbids. A non-string entry is dropped, which is the same answer this
  // function gives for anything else it cannot render.
  const labels = value.values
    .filter((entry: unknown): entry is string => typeof entry === 'string')
    .map((entry) => {
      const option = question.options.find(
        (candidate) => candidate.value === entry,
      );
      return option?.label ?? entry;
    });

  // **Not `!== null`.** An optional choice question whose „Sonstiges" box was
  // ticked and left empty is stored as `{values: [], other: ''}` — the shape
  // `isBlankAnswer` calls unanswered. Reading the mere presence of the box as an
  // answer wrote „Sonstiges: " into the cell of a question nobody answered,
  // which in a Teilnehmerliste reads as a participant who said something.
  // Whitespace goes the same way, for the same reason it does there.
  const other = typeof value.other === 'string' ? value.other : '';
  if (other.trim() !== '') {
    labels.push(`${otherLabelOf(question)}: ${other}`);
  }

  return labels.join(', ');
}

/**
 * `YYYY-MM-DD` → `TT.MM.JJJJ`.
 *
 * Split by hand rather than through `Date`: the value carries no time and no
 * zone, and parsing it into a `Date` would give it both — `new Date('2026-05-15')`
 * is midnight **UTC**, which is the previous day for anyone west of Greenwich.
 * A value that is not the pinned format is returned untouched; it cannot
 * normally occur (the validator enforces it), and inventing a date for it would
 * be worse than showing what is stored.
 */
function formatIsoDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return value;
  }
  const [, year, month, day] = match;
  return `${String(day)}.${String(month)}.${String(year)}`;
}
