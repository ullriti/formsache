import { writeCsv } from './csv.ts';
import {
  EXPORT_FORMAT_LABELS,
  exportFormatSchema,
  type ExportFormat,
} from './export-format.ts';
import {
  buildExportSheet,
  type CsvColumn,
  type CsvRow,
  type ExportSheet,
} from './export-sheet.ts';
import { writeHtml, type HtmlExportMeta } from './export-html.ts';
import { XLSX_CONTENT_TYPE, writeXlsx } from './export-xlsx.ts';

/**
 * **The choice of format** : which formats the export offers,
 * what each of them is called on the wire, and the one place a chosen view
 * becomes a file.
 *
 * The Handoff names CSV, Excel and HTML „aus den aktuell gefilterten
 * Zeilen + sichtbaren Spalten", and Konzept no. 22 adds that the column question —
 * angezeigte oder alle — is asked **at the export** and „gilt für jedes
 * Ausgabeformat". Both sentences are about the same property: the format is the
 * *last* decision, taken after the view is already fixed.
 *
 * {@link writeExport} is that shape in code. It builds the sheet **before** it
 * looks at the format, and hands the writers nothing but the sheet, so a second
 * format cannot work out its own rows (which is how a filter goes missing —
 * the requirement, and twice) and cannot answer the column question again.
 * Adding Excel is a `write` in a new module and one entry in
 * {@link EXPORT_FORMATS}; there is no second place where it could be told which
 * rows to write.
 */

/**
 * **The names live next door** (`export-format.ts`), re-exported here so that
 * every reader of this module keeps reaching them under the address it always
 * used.
 *
 * They moved because the responses view needs the list and the labels and
 * nothing else, and importing *this* module for them put the Excel writer — and
 * through it a 930 kB `exceljs` chunk — into the browser bundle. The reasoning
 * and the measurement are written down there.
 *
 * ⚠️ `xlsx` and `html` are in that list **with** their writer below.
 * An entry without one is a 500 with a stack trace where a 400 belongs, which is
 * what the `Record<ExportFormat, ExportFormatSpec>` type of {@link EXPORT_FORMATS}
 * prevents.
 */
export { exportFormatSchema, type ExportFormat };

/**
 * What a writer produces: text, or bytes.
 *
 * `Uint8Array` and not `Buffer`, because this package runs in the browser as
 * well. It is in the type from the start although CSV and HTML are both text:
 * an Excel workbook is a zip archive, and a contract the second format has to
 * break is not a seam. The same reason makes {@link ExportFormatSpec.write}
 * allowed to be asynchronous — a workbook is serialised through a promise.
 */
export type ExportBody = string | Uint8Array;

/** One output format: how it is named, how it is served, how it is written. */
export interface ExportFormatSpec {
  /** File extension **and** the value of the `:format` route parameter. */
  readonly extension: ExportFormat;
  readonly contentType: string;
  /**
   * The name the export menu shows (design handoff) — **one list, not two**.
   *
   * It is taken from `EXPORT_FORMAT_LABELS` rather than written here, because
   * the menu reads that record directly: the browser must not be made to
   * download an Excel writer in order to render the word „Excel".
   */
  readonly label: string;
  /**
   * The whole difference between the formats.
   *
   * It receives the {@link ExportSheet} and the {@link HtmlExportMeta} — not
   * the answers, not the form, not the column selection. That is the seam:
   * what a writer cannot see, it cannot decide differently from its
   * neighbours.
   *
   * The meta is the *whole export's* three facts (title, Organisation, moment), not
   * one format's: CSV and Excel simply have nowhere to put them and declare a
   * shorter signature, which TypeScript accepts. It is **not** optional here,
   * because „optional" is how the printed head stayed neutral through the
   * entire build of the HTML writer while `export-html.test.ts` was green on a meta no route ever
   * sent.
   */
  readonly write: (
    sheet: ExportSheet,
    meta: HtmlExportMeta,
  ) => ExportBody | Promise<ExportBody>;
}

export const EXPORT_FORMATS: Readonly<Record<ExportFormat, ExportFormatSpec>> =
  {
    csv: {
      extension: 'csv',
      // `charset=utf-8` next to the BOM the writer emits: the header tells a
      // browser, the BOM tells Excel, and the two are read by different things.
      contentType: 'text/csv; charset=utf-8',
      label: EXPORT_FORMAT_LABELS.csv,
      write: writeCsv,
    },
    // **One entry, one writer — Excel is no more than that** .
    // Which rows and which columns were decided before this record was even
    // looked at, so adding a format cannot add a second answer to either
    // question. The whole difference to the line above is `write`.
    xlsx: {
      extension: 'xlsx',
      // No `charset`: the body is a zip archive, and a character set on binary
      // content is the kind of header that makes a proxy try to transcode it.
      contentType: XLSX_CONTENT_TYPE,
      label: EXPORT_FORMAT_LABELS.xlsx,
      write: writeXlsx,
    },
    // The third writer, and the only one that uses the second argument: the
    // printed head that identifies the file („Kopf mit Formulartitel, Organisation
    // und Zeitpunkt"). CSV and Excel take the sheet alone and are assignable
    // all the same — a function may ignore a parameter it is offered.
    html: {
      extension: 'html',
      contentType: 'text/html; charset=utf-8',
      label: EXPORT_FORMAT_LABELS.html,
      write: writeHtml,
    },
  };

/** A written file, ready to be served. */
export interface WrittenExport {
  readonly extension: ExportFormat;
  readonly contentType: string;
  readonly body: ExportBody;
}

/**
 * **The one place where rows and columns become a file.**
 *
 * The order of the three steps is the point of this seam:
 *
 * 1. the caller has already chosen the rows (search) and the columns
 *    („angezeigte / alle") — one answer, for every format;
 * 2. {@link buildExportSheet} turns them into cells **once**, guards included;
 * 3. only then does the format matter.
 *
 * Reversed — branch first, build second — each format would own a copy of steps
 * 1 and 2, and the copies would agree until the day one of them missed a
 * filter. what that costs: „die Zeilenmenge für Excel
 * neu ermitteln, statt die des CSV zu benutzen" is a file with rows in it that
 * the person exporting never saw.
 */
export async function writeExport(
  format: ExportFormat,
  columns: readonly CsvColumn[],
  rows: readonly CsvRow[],
  meta: HtmlExportMeta,
): Promise<WrittenExport> {
  const spec = EXPORT_FORMATS[format];
  const sheet = buildExportSheet(columns, rows);
  return {
    extension: spec.extension,
    contentType: spec.contentType,
    body: await spec.write(sheet, meta),
  };
}
