import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The views of the application, **read out of the router** — not maintained
 * by hand.
 *
 * That is the actual point of this derivation. A hand-maintained list forgets
 * exactly the view that is new: it gets created, the router gets its branch,
 * the check-list stays as it was — and the run is green because it ran over
 * one view less. This project has already had exactly this shape of defect
 * once, in the other direction (`form-settings.spec.ts` ran in no project and
 * reported green; see `smoke-suite-coverage.spec.ts`).
 *
 * **Why the source text instead of an import.** The addresses of the
 * application are a *type* (`Route`), and types are gone at runtime. There is
 * no value in `routes.ts` that enumerates all the kinds — and creating one
 * would mean maintaining a second list, which is exactly what is to be
 * prevented here. What is read is therefore what the application *does*:
 * every kind that `parseRoute` can produce from a URL. A kind that brings
 * forth no address is not a view.
 */

const ROUTES_FILE = fileURLToPath(
  new URL('../../apps/web/src/router/routes.ts', import.meta.url),
);

/** From here on stand the `return { kind: … }` of the address resolution. */
const PARSE_ROUTE_START = 'export function parseRoute(';

/**
 * Lower bound against the silent zero.
 *
 * A regex that finds nothing — because the file was renamed, the function
 * rewritten or the literal spelled differently — would yield an empty set,
 * and a check-list is always complete against the empty set. That is the same
 * confusion that has to be ruled out with axe: „zero violations" can only be
 * told apart from „the checker ran over nothing" if somebody counts.
 */
const MINIMUM_KINDS = 15;

/**
 * Every route kind that `parseRoute` can produce from a path.
 *
 * Read synchronously, because the list has to be settled when the module is
 * loaded: `views.ts` builds from it the table the test file iterates over,
 * and Playwright collects tests before the first `await`.
 */
export function routerRouteKinds(): ReadonlySet<string> {
  const source = readFileSync(ROUTES_FILE, 'utf8');

  const start = source.indexOf(PARSE_ROUTE_START);
  if (start === -1) {
    throw new Error(
      `\`${PARSE_ROUTE_START}\` steht nicht in ${ROUTES_FILE}. Die Ableitung ` +
        'der Ansichtsliste liest den Quelltext des Routers; wenn die Funktion ' +
        'umbenannt wurde, gehört dieser Zeiger nachgezogen — sonst prüft der ' +
        'axe-Lauf gegen eine leere Liste und ist aus dem falschen Grund grün.',
    );
  }

  const kinds = new Set(
    [
      ...source.slice(start).matchAll(/return\s*\{\s*kind:\s*'([a-z-]+)'/gu),
    ].map((match) => match[1] ?? ''),
  );

  if (kinds.size < MINIMUM_KINDS) {
    throw new Error(
      `Aus ${ROUTES_FILE} wurden nur ${String(kinds.size)} Routen-Sorten ` +
        `gelesen, erwartet sind mindestens ${String(MINIMUM_KINDS)}. Entweder ` +
        'schreibt `parseRoute` seine Rückgaben inzwischen anders, oder die ' +
        'Datei ist nicht die, für die sie gehalten wird.',
    );
  }

  return kinds;
}
