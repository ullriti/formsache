import {
  SUBMITTED_AT_COLUMN,
  formatTimestamp,
  type ExportCell,
  type ExportHeader,
  type ExportSheet,
} from './export-sheet.ts';
import { neutraliseHtml } from './html-text.ts';

/**
 * **The HTML writer** — one output format of the
 * export, and nothing else.
 *
 * It receives an {@link ExportSheet} — the rows already filtered, the columns
 * already chosen, every cell already rendered with its guard — and turns it
 * into **one** file. It cannot see the answers, the form or the column
 * selection, so it cannot lose a search it never had and cannot answer the
 * „angezeigte / alle" question a second time. What
 * is left in this module is exactly what is HTML.
 *
 * ## What this file *is*
 *
 * A document that is opened on the computer of a Mitglied, printed, and
 * forwarded by mail. Two properties follow from that sentence and they are the
 * whole of the requirement:
 *
 * - **Nothing is executed.** Every value in it was typed by a stranger into
 *   a public form — that is what a public form is. The file therefore contains
 *   no `<script>`, no event-handler attribute and no element that could carry
 *   one, because every untrusted string passes through {@link neutraliseHtml}
 *   and *nothing else in this module writes a tag from data*.
 * - **Nothing is fetched afterwards.** No stylesheet link, no web font, no image, no
 *   `url(...)` in the CSS. The styles are inline in a `<style>` element, so the
 *   file works on a laptop with no network — and, more importantly, opening it
 *   tells no server that it was opened.
 *
 * ## The logo: **not at all** — decided, not forgotten
 *
 * The requirement leaves two admissible answers, „eingebettet (Data-URI, dann
 * zählt die Größe)" or „gar nicht", and forbids the third: a `src` pointing
 * back at the installation. This writer takes the second, and the organisation appears
 * by **name** in the head instead. The numbers behind the decision:
 *
 * - A tenant logo may be **2 MiB** (`MAX_TENANT_LOGO_BYTES`, 2 097 152 bytes).
 *   Base64 inflates by 4/3, so an embedded logo adds up to **≈ 2 796 000
 *   bytes** to *every* exported file. A modest 240 KiB logo — well under the
 *   limit, and the size a scanned crest easily reaches — still adds
 *   **≈ 320 600 bytes**.
 * - A realistic export — 500 answers over 8 columns — comes out of this writer
 *   at **146 449 bytes**, of which the whole embedded stylesheet is 1 574
 *   (measured 2026-08-08; `export-html.test.ts` asserts the order of magnitude
 *   so this note cannot go stale). The shipped crest would therefore be
 *   **~2.2×** the entire file it decorates, the maximum one **~19×**, and it
 *   would be paid again by every recipient of every forwarded copy.
 * - What it buys is the organisation's identity, which the head already states in
 *   words. That is a poor trade at 2.2× and an absurd one at 19×.
 *
 * **If it is ever embedded, then as a data URI and only so.** The boundary
 * that keeps that honest is not this comment but the test: „kein Verweis auf
 * einen externen Host" is measured on the produced file, and a `<img src>`
 * pointing at the installation fails it whatever the intention was.
 *
 * ## The cell's guard is **nothing** here
 *
 * `ExportCell.guard` is the decision `questionColumns` made at the question
 * type, and every format honours it in its own alphabet (see `export-sheet.ts`).
 * The CSV writer turns `'text'` into a leading apostrophe because a spreadsheet
 * *interprets* a cell; a browser does not, so the HTML answer to the same
 * decision is **to do nothing**. Applying the CSV guard here as well would be
 * „doppelt geschützt ist beschädigt" : the file would
 * show `'01067` where the participant typed `01067`. There is a test for that
 * one line of reasoning, because it is the kind that gets „fixed" later.
 */

/**
 * What the printed head says about **this** export — the three facts the sheet
 * itself does not carry.
 *
 * They are not part of {@link ExportSheet} on purpose: a sheet is rows and
 * columns, and CSV and Excel have nowhere to put a title page. They reach this
 * writer as its own second argument instead of widening the seam for one
 * format.
 */
export interface HtmlExportMeta {
  /** The form's title, as the editor typed it — escaped like any other value. */
  readonly formTitle: string;
  /** The organisation the form belongs to; empty when the caller has none. */
  readonly tenantName: string;
  /**
   * When the file was written, as an ISO-8601 instant — or `null`.
   *
   * `null` rather than „then take now": a writer that reaches for the clock
   * produces a different file every time it runs, which is exactly what a
   * golden test cannot hold still. The caller has the moment; this module has
   * a string.
   */
  readonly exportedAt: string | null;
}

/**
 * The head of a file whose caller said nothing about it.
 *
 * **Deliberately poorer, never wrong**: the neutral title, the row count, no
 * Organisation, and above all **no invented date**. A default that guessed the moment
 * of writing would put a timestamp in the document that means „whenever this
 * was rendered", which reads exactly like „as of" and is not.
 *
 * ⚠️ It is **not** what the application serves. `writeExport` takes the meta
 * as a required argument and the route fills it from the form and
 * the organisation, so this default now only shortens the tests below that measure
 * escaping and have no head to speak of. It stayed the served head through
 * the entire build of the HTML writer while this file's tests were green on a meta no caller
 * sent — which is why the seam above stopped accepting an absent one.
 */
const UNTITLED_EXPORT: HtmlExportMeta = {
  formTitle: 'Antworten',
  tenantName: '',
  exportedAt: null,
};

/**
 * **The styles — embedded, and that is the assurance, not the convenience.**
 *
 * A `<link rel="stylesheet">` would point at the installation. A file forwarded
 * to a Mitglied would then, on being opened, ask that server for the
 * stylesheet — and tell it who opened it, when, and from which address. The
 * same holds for a web font, which is why the font stacks below name only
 * families that are already on the machine.
 *
 * There is no `url(...)` anywhere in here and none may appear: it is the one
 * CSS construct that can load something, and the test reads the parsed
 * stylesheet for it rather than trusting this sentence.
 *
 * Colours are spelled out rather than referenced as design tokens, and that is
 * forced: this file leaves the building. `apps/web/src/styles/tokens.css` is
 * not reachable from it, and reaching for it would be the `<link>` above. The
 * values are the tokens' (`--color-text` `#1c1b18`, `--color-text-muted`
 * `#55503f`, `--color-surface` `#ffffff`, `--color-panel` `#f2efe8`,
 * `--color-table-border` `#e2ddd0`, `--tenant-accent` `#cea967`), copied here
 * once so the export looks like the product it came from.
 *
 * **The print part is part of the promise**: `thead` repeats on every
 * page (`display: table-header-group`), a row is not torn across a page break,
 * and the head is not separated from the table it belongs to.
 */
const STYLES = `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background-color: #ffffff;
      color: #1c1b18;
      font-family: "Iowan Old Style", Palatino, Georgia, "Times New Roman", serif;
      font-size: 13px;
      line-height: 1.45;
    }
    .export-head { border-bottom: 2px solid #cea967; margin-bottom: 16px; padding-bottom: 12px; }
    .export-head .tenant {
      color: #55503f;
      font-size: 12px;
      letter-spacing: 0.08em;
      margin: 0 0 4px;
      text-transform: uppercase;
    }
    .export-head h1 { font-size: 20px; line-height: 1.25; margin: 0; }
    .export-head .stamp { color: #55503f; font-size: 12px; margin: 6px 0 0; }
    table { border-collapse: collapse; width: 100%; }
    caption {
      clip-path: inset(50%);
      height: 1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
      width: 1px;
    }
    th, td {
      border: 1px solid #e2ddd0;
      overflow-wrap: anywhere;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    thead th { background-color: #f2efe8; font-weight: 700; }
    tbody tr:nth-child(even) { background-color: #f2efe8; }
    .stamp-cell { white-space: nowrap; }
    .empty { color: #55503f; font-style: italic; }
    @media print {
      body { padding: 0; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
      .export-head { break-after: avoid; page-break-after: avoid; }
      tbody tr:nth-child(even) { background-color: transparent; }
    }
`;

/**
 * **Writes the table as one HTML file.**
 *
 * `meta` is optional so that the format table can carry this function as it
 * stands (`write: writeHtml`); what a caller loses by omitting it is described
 * at {@link UNTITLED_EXPORT} — a poorer head, never a wrong one.
 *
 * Header and body go through **one** cell function, because a header is a cell
 * too ({@link ExportHeader}): a question an editor named
 * `<img src=x onerror=…>` is neutralised exactly like an answer a participant
 * typed. A writer that treated the two differently would have one unguarded row
 * per file — and the column plan does not know the caption is dangerous,
 * because no plan does.
 */
export function writeHtml(
  sheet: ExportSheet,
  meta: HtmlExportMeta = UNTITLED_EXPORT,
): string {
  const columns = Math.max(sheet.header.length, 1);

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${neutraliseHtml(documentTitle(meta))}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    documentHead(meta, sheet.rows.length),
    '<table>',
    `<caption>${neutraliseHtml(documentTitle(meta))}</caption>`,
    '<thead>',
    `<tr>${sheet.header.map(headerCell).join('')}</tr>`,
    '</thead>',
    '<tbody>',
    sheet.rows.length === 0
      ? `<tr><td class="empty" colspan="${String(columns)}">Keine Antworten</td></tr>`
      : sheet.rows.map((row) => bodyRow(row, sheet.header)).join('\n'),
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The title of the document — the form's, or the neutral one.
 *
 * A single function for `<title>` and `<caption>` so the browser tab, the print
 * header a browser adds of its own accord, and the table's accessible name
 * cannot say three different things.
 */
function documentTitle(meta: HtmlExportMeta): string {
  return meta.formTitle.trim() === ''
    ? UNTITLED_EXPORT.formTitle
    : meta.formTitle;
}

/**
 * **The head of the printed page**: organisation, form title, timestamp
 * and the number of answers.
 *
 * Every part of it is escaped. An organisation name and a form title are typed by an
 * administrator rather than by a stranger, which is a *smaller* risk and not a
 * different one — and „der Fragetitel" is on the same line of defence, since
 * the column plan carries captions the same way it carries values.
 *
 * A line whose value the caller does not have is **left out** rather than
 * rendered empty: „Stand: " followed by nothing looks like a fault in the
 * export, and a fault in an export is not something the reader can check.
 */
function documentHead(meta: HtmlExportMeta, rows: number): string {
  const stamp =
    meta.exportedAt === null ? '' : formatTimestamp(meta.exportedAt);
  const facts = [
    stamp === '' ? '' : `Stand: ${stamp} UTC`,
    `${String(rows)} ${rows === 1 ? 'Antwort' : 'Antworten'}`,
  ].filter((fact) => fact !== '');

  return [
    '<header class="export-head">',
    meta.tenantName.trim() === ''
      ? ''
      : `<p class="tenant">${neutraliseHtml(meta.tenantName)}</p>`,
    `<h1>${neutraliseHtml(documentTitle(meta))}</h1>`,
    `<p class="stamp">${neutraliseHtml(facts.join(' · '))}</p>`,
    '</header>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * One header cell. `scope="col"` so a screen reader names the column when it
 * reads a value out of it — the file is a document somebody reads, not a blob.
 */
function headerCell(header: ExportHeader): string {
  return `<th scope="col"${cellClass(header.key)}>${neutraliseHtml(header.value)}</th>`;
}

function bodyRow(
  row: readonly ExportCell[],
  header: readonly ExportHeader[],
): string {
  const cells = row.map(
    (cell, index) =>
      // `header[index]` is aligned with the row by construction
      // (`ExportSheet` is a rectangle); a row longer than the header would be a
      // defect of the seam, and the cell still gets written rather than lost.
      `<td${cellClass(header[index]?.key)}>${neutraliseHtml(cell.value)}</td>`,
  );
  return `<tr>${cells.join('')}</tr>`;
}

/**
 * The one thing the column *key* decides here: the timestamp keeps its line.
 *
 * `TT.MM.JJJJ HH:MM` wrapped after the date reads as two different values in a
 * narrow column. Nothing else in this writer looks at the key — a format that
 * started to make decisions per column would be answering questions
 * `export-sheet.ts` already answered.
 */
function cellClass(key: string | undefined): string {
  return key === SUBMITTED_AT_COLUMN ? ' class="stamp-cell"' : '';
}
