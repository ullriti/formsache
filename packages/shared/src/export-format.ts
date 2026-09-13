import { z } from 'zod';

/**
 * **What the output formats are called** — on the wire and on the screen.
 *
 * Split off from `export-formats.ts` (which says how each one is *written*) for
 * a reason that is measured rather than aesthetic: the export menu of the
 * responses view needs the list and the names, and nothing else. Reading them
 * from the writer registry pulled `writeXlsx` into the browser bundle, and with
 * it the dynamic `import('exceljs')` — a **930 kB** chunk shipped to every
 * visitor of the application to render three words. Measured with
 * `pnpm --filter @formsache/web build`: 680 kB plus `exceljs.min-*.js` at 929.89 kB,
 * against 673 kB without.
 *
 * So the seam is here, and it is the same seam the export itself has: *what a
 * format is called* is shared knowledge, *how it is written* belongs to the
 * server. This module imports nothing but Zod and therefore reaches no writer.
 *
 * ⚠️ **It stays one list** . `EXPORT_FORMATS`
 * (`export-formats.ts`) takes its labels from {@link EXPORT_FORMAT_LABELS} and
 * its keys from {@link exportFormatSchema}, so a format cannot exist in the menu
 * without a writer, nor carry two names. What must **not** happen is a second
 * label spelled into `ResponsesView.tsx`: the menu entry and the file the route
 * hands back would then be about two different things, and only for the format
 * somebody forgot.
 */

/**
 * The formats the export route accepts — the wire contract, in one place for
 * client and server.
 *
 * A Zod enum rather than a union type, because the value arrives from a URL:
 * `GET /forms/:id/export.:format` is parsed with this and refused when it is
 * something else, instead of falling through to a default that would hand out a
 * CSV under an `.xlsx` name.
 *
 * ⚠️ An entry here without a writer in `EXPORT_FORMATS` is a 500 with a stack
 * trace where a 400 belongs; the record's `Record<ExportFormat, …>` type is what
 * makes that a compile error.
 */
export const exportFormatSchema = z.enum(['csv', 'xlsx', 'html']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/**
 * The name the export menu shows for each format (design handoff) — **one list, not
 * two**.
 *
 * `Record<ExportFormat, string>` rather than a loose object, so a fourth format
 * cannot be added to the wire without being given a name here, and a name
 * cannot be left behind for a format that no longer exists.
 *
 * ⚠️ **„Excel" and „HTML" are new labels of the interface** (and
 * required: Playwright matches an accessible name as a
 * case-insensitive **substring**). They were searched for in `e2e/` and in the
 * web tests before being introduced; „HTML" is rendered elsewhere only as the
 * format radio of the notification editor, which is a different view, and no
 * locator in the repository matches either word today.
 */
export const EXPORT_FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  csv: 'CSV',
  // „Excel" and not „XLSX": the extension is what the file is called, this is
  // what the person clicking it calls the program they will open it in.
  xlsx: 'Excel',
  html: 'HTML',
};
