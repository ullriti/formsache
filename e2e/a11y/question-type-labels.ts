import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The **field kinds** of the application, read out of the source (review
 * follow-up, 2026-08-12).
 *
 * The same construction as `router-kinds.ts` (addresses) and
 * `overlay-sources.ts` (dialogs) — and for the same reason. An earlier revision
 * took the test form from one text question to all sixteen field kinds and
 * found a *critical* violation at once in doing so. What it did **not** do:
 * count the sixteen against anything. The list in `a11y.spec.ts` was thereby
 * exactly the hand-maintained list the finding had set out against: add a
 * seventeenth field kind → all a11y cases stay green, and the new kind has
 * never been scanned. Literally the state this revision fixed for the views.
 *
 * **Why the source and not an import.** `e2e/` deliberately keeps
 * `@formsache/shared` and `apps/web` out (`app-flows.ts` gives the reason: no
 * DOM lib, no bundler resolution, the test run is not to hang on the
 * application build). What is read is therefore what the palette offers a
 * human: the labels from `QUESTION_TYPE_LABELS`.
 */

const LABELS_FILE = fileURLToPath(
  new URL('../../apps/web/src/builder/question-defaults.ts', import.meta.url),
);

const DECLARATION = 'export const QUESTION_TYPE_LABELS';

/**
 * Lower bound against the silent zero — today there are 16.
 *
 * It stands below that so that a *removed* field kind is not red at once, and
 * above 0, because against the empty set every checklist is complete.
 */
const MINIMUM_LABELS = 12;

/** Every label the palette offers. */
export function questionTypeLabels(): readonly string[] {
  const source = readFileSync(LABELS_FILE, 'utf8');

  const start = source.indexOf(DECLARATION);
  if (start === -1) {
    throw new Error(
      `\`${DECLARATION}\` steht nicht in ${LABELS_FILE}. Die Feldarten des ` +
        'Prüfformulars werden aus dieser Tabelle gezählt; wurde sie umbenannt ' +
        'oder verschoben, gehört dieser Zeiger nachgezogen — sonst zählt der ' +
        'Wächter gegen eine leere Menge und ist aus dem falschen Grund grün.',
    );
  }

  const end = source.indexOf('};', start);
  const labels = [
    ...source
      .slice(start, end === -1 ? undefined : end)
      .matchAll(/^\s*[a-z]+:\s*'([^']+)',$/gmu),
  ].map((match) => match[1] ?? '');

  if (labels.length < MINIMUM_LABELS) {
    throw new Error(
      `Aus ${LABELS_FILE} wurden nur ${String(labels.length)} Feldarten ` +
        `gelesen, erwartet sind mindestens ${String(MINIMUM_LABELS)}. ` +
        'Entweder schreibt die Tabelle ihre Einträge inzwischen anders, oder ' +
        'die Datei ist nicht die, für die sie gehalten wird.',
    );
  }

  return labels;
}
