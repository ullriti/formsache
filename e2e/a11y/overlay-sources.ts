import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The **overlays** of the application, read out of the source
 * (a review finding, 2026-08-12).
 *
 * `router-kinds.ts` next door counts the *addresses*. That was exactly the gap:
 * against `parseRoute` the checklist was complete, and yet the
 * axe run never saw nine dialogs, three popovers and two states of the fill-in
 * mask — they have no address. But a view is not what has a URL,
 * it is what a human gets to see; and a dialog is the form
 * in which this application shows its most delicate operations (publish,
 * delete, save as template, choose the image crop).
 *
 * What is read is the same thing the browser sees: `role="dialog"` in the
 * source of the components. **Popovers and page states are not in it** — they
 * carry `aria-expanded` or no marker at all and therefore cannot be counted
 * reliably from the source; they stand by hand in `overlays.ts` and
 * are marked as such there. That is the honest limit of this
 * guard: it covers the dialogs, not everything.
 */

const WEB_SRC = fileURLToPath(new URL('../../apps/web/src', import.meta.url));

/**
 * Lower bound against the silent zero — the same consideration as in
 * `router-kinds.ts`: a search pattern that finds nothing any more would deliver
 * an empty set, and against the empty set every checklist is complete.
 *
 * Today there are 9. The bound sits below that so that a *removed* dialog
 * is not red at once; it sits above 0 so that a broken search pattern is.
 */
const MINIMUM_DIALOGS = 6;

/** `role="dialog"` as it stands in the `.tsx` — single or JSX quoting. */
const DIALOG_MARKER = /role=(?:"dialog"|\{'dialog'\})/u;

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      yield path;
    }
  }
}

/**
 * Every component file that opens a dialog — as a path relative to
 * `apps/web/src`, the way an entry in `overlays.ts` names it.
 *
 * Read synchronously, because both callers are synchronous test bodies — the
 * guard compares two sets and needs no browser, no session and no database for
 * that. (For `A11Y_OVERLAYS` itself it would be a
 * must — Playwright collects the test cases before the first `await` runs —;
 * here it is simply the easier way.)
 */
export function dialogSources(): ReadonlySet<string> {
  const sources = new Set<string>();
  for (const path of walk(WEB_SRC)) {
    if (DIALOG_MARKER.test(readFileSync(path, 'utf8'))) {
      sources.add(relative(WEB_SRC, path).replaceAll('\\', '/'));
    }
  }

  if (sources.size < MINIMUM_DIALOGS) {
    throw new Error(
      `Unter ${WEB_SRC} wurden nur ${String(sources.size)} Dialoge gefunden, ` +
        `erwartet sind mindestens ${String(MINIMUM_DIALOGS)}. Entweder ` +
        'schreibt die Anwendung ihre Dialoge inzwischen anders (dann gehört ' +
        `${DIALOG_MARKER.source} nachgezogen), oder der Pfad stimmt nicht. ` +
        'Ohne diese Schranke wäre die Prüfliste gegen die leere Menge ' +
        'vollständig — und der axe-Lauf aus dem falschen Grund grün.',
    );
  }

  return sources;
}
