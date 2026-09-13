import type {
  AnswerMap,
  FileAttachment,
  FormDefinition,
  ResponseDetail,
} from '@formsache/shared';
import {
  SUBMITTED_AT_COLUMN,
  allQuestions,
  attachmentsOf,
  renderRow,
  renderSchemalessRow,
} from '@formsache/shared';

/**
 * Row model of the responses table.
 *
 * Kept apart from the components so the two rules that decide what a reader
 * sees — how a row renders and how two rows compare — can be read and tested
 * without a DOM around them.
 */

/**
 * A row, with one cell per **question** — the folded rendering the application
 * shows.
 *
 * The file may write several columns for one of these cells (`questionColumns`
 * in `@formsache/shared`); the screen does not, and the search still agrees with the
 * file because the folded cell contains what its parts contain.
 */
export interface Row {
  readonly id: string;
  readonly response: ResponseDetail;
  readonly cells: Record<string, string>;
  /**
   * The published version this row was rendered against, or `undefined` when
   * that version is missing from the payload — see {@link toRow}. The detail
   * panel reads it to list the questions **this** participant was asked.
   */
  readonly definition: FormDefinition | undefined;
  /**
   * The attachments of this row, per question id.
   *
   * **Beside `cells`, never instead of them.** The cell keeps the folded text —
   * that is what sorting and the search run over, and what the export writes —
   * while this carries the pieces the table and the detail panel need to render
   * a **link** per file. Building a link out of the joined cell string would
   * mean splitting on „, ", and a file name may contain one.
   *
   * A question with no attachments has no entry, so a reader that does not know
   * about this type simply finds nothing.
   */
  readonly attachments: Readonly<Record<string, readonly FileAttachment[]>>;
}

/** Which column the table is ordered by, and in which direction. */
export interface SortState {
  readonly key: string;
  readonly direction: 1 | -1;
}

/**
 * One response as a row, rendered against **its own** published version.
 *
 * `definition` is the snapshot named by `response.formVersion`, looked up in
 * what `GET /forms/:id/responses/columns` sent. Rendering each row against its
 * own version is what makes the union of columns usable at all: only the
 * version that still had „Telefon" can format that row's answer to it, and an
 * answer given while the question was a phone number keeps reading like one
 * after the editor replaced it with a „Zahl" of the same name.
 *
 * ## When the payload does not carry the row's version
 *
 * The row is kept, with its timestamp and otherwise empty cells — never dropped
 * and never thrown over. The response exists, and one unrenderable row must not
 * take the table with it. `renderSchemalessRow` supplies the one cell that
 * needs no schema; without it the row would sort and search as if it had no
 * date.
 *
 * **The export does the same thing, cell for cell.** Both sides reach this
 * situation through the same damage from different doors — `responseColumnSet`
 * leaves a snapshot that no longer parses out of `versions`, which is how this
 * branch is reached, and `exportResponses` `safeParse`s the same stored JSONB
 * and hands the export seam a row with `definition: null`. Both then keep the row and
 * write nothing but its timestamp, through this very `renderSchemalessRow`, and
 * the search runs over the same fallback cells on both sides
 * (`matchesSearch` in `forms.service.ts`). So the count on screen, the rows in
 * the file and the rows a filtered export keeps all agree — „der Export folgt
 * der sichtbaren Sicht"  holds here too, which is what it is worth: a
 * number on screen that does not match the file teaches people to distrust the
 * export, and nothing tells them *which* line is missing.
 *
 * **What is still not expressed** — the standing caveat, so nobody reads the
 * agreement as completeness: neither surface distinguishes „nicht darstellbar"
 * from „nichts geantwortet". An empty cell here means the same as an empty cell
 * anywhere else, and only the timestamp gives the row away. Saying it properly
 * would need the wire to carry the distinction, which is an API decision rather
 * than this module's; it is accepted deliberately, on the grounds that the
 * ambiguity is identical on screen and has been accepted there all along.
 */
export function toRow(
  response: ResponseDetail,
  definition: FormDefinition | undefined,
): Row {
  const cells =
    definition === undefined
      ? renderSchemalessRow(response.submittedAt)
      : // `answers` is `unknown` on the wire. `formatAnswerCell` narrows by the
        // question's own type and answers `''` for anything that does not fit
        // it — including a stored value of the wrong shape, which it checks for
        // rather than trusting.
        renderRow(
          definition,
          response.submittedAt,
          response.answers as AnswerMap,
        );

  return {
    id: response.id,
    response,
    cells,
    definition,
    attachments: attachmentsByQuestion(response, definition),
  };
}

/**
 * The attachments of one response, keyed by question id — read against **its
 * own** version, like every other cell of the row.
 *
 * Only questions of type `file` are looked at, so a `{files: …}` that somehow
 * sat under another question is not turned into a link: the question decides
 * what its answer is, which is the rule the whole of `formatAnswerCell` follows.
 * `attachmentsOf` then drops anything inside it that is not a readable pair —
 * one damaged row must not take the table down (`response-validation.ts`).
 */
function attachmentsByQuestion(
  response: ResponseDetail,
  definition: FormDefinition | undefined,
): Record<string, readonly FileAttachment[]> {
  if (definition === undefined) {
    return {};
  }
  const answers = response.answers as AnswerMap;
  const found: Record<string, readonly FileAttachment[]> = {};
  for (const question of allQuestions(definition)) {
    if (question.type !== 'file') {
      continue;
    }
    const files = attachmentsOf(answers[question.id]);
    if (files.length > 0) {
      found[question.id] = files;
    }
  }
  return found;
}

/**
 * Compares two rows by one column.
 *
 * Numeric when **both** values parse as numbers, alphabetic otherwise — the
 * handoff asks for the distinction, and doing it per pair rather than per
 * column means a column of mostly-numbers with one "keine Angabe" in it still
 * sorts sensibly instead of falling back to string order for everybody.
 *
 * The timestamp column is the exception and sorts on the **raw** ISO value.
 * Its cell is `TT.MM.JJJJ HH:MM`, and comparing that as text puts „3.8." before
 * „20.7." — the default view is „neueste zuerst", so the one column whose order
 * everybody sees first was the one getting it wrong across a month boundary.
 * ISO 8601 is lexicographically ordered, which is why it is the right thing to
 * compare and the wrong thing to show.
 */
export function compareBy(
  key: string,
  direction: 1 | -1,
): (left: Row, right: Row) => number {
  return (left: Row, right: Row): number => {
    if (key === SUBMITTED_AT_COLUMN) {
      return (
        left.response.submittedAt.localeCompare(right.response.submittedAt) *
        direction
      );
    }

    const a = left.cells[key] ?? '';
    const b = right.cells[key] ?? '';

    const asNumbers = [a, b].map((value) => Number(value.replace(',', '.')));
    if (
      a !== '' &&
      b !== '' &&
      asNumbers.every((value) => !Number.isNaN(value))
    ) {
      return ((asNumbers[0] ?? 0) - (asNumbers[1] ?? 0)) * direction;
    }
    return a.localeCompare(b, 'de') * direction;
  };
}

/**
 * The next sort state after a click on a column header.
 *
 * A new column starts ascending; the active one flips. Spelled out here rather
 * than inline so the table component stays a rendering concern.
 */
export function nextSort(current: SortState, key: string): SortState {
  return current.key === key
    ? { key, direction: current.direction === 1 ? -1 : 1 }
    : { key, direction: 1 };
}

/** `aria-sort` for one column header — 'none' unless it is the active one. */
export function ariaSortFor(
  sort: SortState,
  key: string,
): 'none' | 'ascending' | 'descending' {
  if (sort.key !== key) {
    return 'none';
  }
  return sort.direction === 1 ? 'ascending' : 'descending';
}
