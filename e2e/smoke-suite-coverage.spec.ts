import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import config from '../playwright.config';

/**
 * Every spec file in this folder is picked up by at least one project.
 *
 * This exists because of the most expensive test failure this project has had:
 * `form-settings.spec.ts` carried the whole proof of the requirements,
 * was matched by no `testMatch`, and therefore ran **zero** tests — while its
 * own docblock claimed it made the mobile single-column requirement "eine
 * Messung statt einer Behauptung". `pnpm e2e` was green throughout, and the
 * gap was found by a review reading the config, not by the suite.
 *
 * The cause is structural rather than careless: `testMatch` is an explicit
 * alternation **per project**, which is deliberate — several specs run in one
 * viewport only, each for a reason written next to it — but it also means a
 * new file is invisible by default and silent about it.
 *
 * The check runs in `smoke`, which needs no session and no database, so it
 * fails in the first seconds of a run rather than after the slow projects.
 *
 * It deliberately does **not** assert which project a file belongs to: that is
 * a judgement (viewport, shared state, runtime) and the config argues each
 * case. It asserts only that somebody made the judgement.
 */

function matchersOf(): RegExp[] {
  return (config.projects ?? []).flatMap((project) => {
    const match: unknown = project.testMatch;
    return match instanceof RegExp ? [match] : [];
  });
}

test('every spec file is claimed by a project', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // This file included: a guard that exempts itself is the first thing to go
  // unnoticed when the naming convention changes.
  const specs = (await readdir(here)).filter((name) =>
    name.endsWith('.spec.ts'),
  );
  // A guard over an empty list would pass for the wrong reason.
  expect(specs.length).toBeGreaterThan(5);

  const matchers = matchersOf();
  expect(matchers.length).toBeGreaterThan(2);

  const orphans = specs.filter(
    (name) => !matchers.some((matcher) => matcher.test(`e2e/${name}`)),
  );

  expect(
    orphans,
    'These spec files run in no project — add them to a `testMatch` in ' +
      'playwright.config.ts, then check with `npx playwright test --list`. ' +
      'A file that is matched by nothing runs zero tests and reports green.',
  ).toStrictEqual([]);
});

/**
 * **And every project gets invoked as well** — the same defect one level up.
 *
 * The case above checks whether every *file* belongs to a project. It says
 * nothing about whether this project ever *runs*: `pnpm e2e` enumerates its
 * projects one by one with `--project=`, and a project that is missing there is
 * just as invisible as a file without a `testMatch` — with the same green run
 * over it.
 *
 * *Measured on 2026-08-18:* `durchlauf-erstinbetriebnahme` stood completely in
 * `playwright.config.ts`, with `testMatch` and `dependencies`, and the case
 * above was green. In two complete runs the name did **not appear a single
 * time**. No test found it, but somebody who laid the two files next to each
 * other — exactly the kind of find this case makes in the first seconds from
 * now on.
 *
 * **The enumeration stays explicit**, it is not replaced by "all projects": the
 * order in `pnpm e2e` is a statement (the four walkthroughs run strictly one
 * after the other and alone), and a blanket "take everything" would take the
 * intent away from it. What is measured here is only that nobody *forgets* a
 * project.
 *
 * *Reproduction:* remove one `--project=` from the script → red.
 */
test('every project is invoked by `pnpm e2e`', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest: unknown = JSON.parse(
    await readFile(`${root}/package.json`, 'utf8'),
  );
  const scripts: unknown =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as Record<string, unknown>).scripts
      : undefined;
  const script: unknown =
    typeof scripts === 'object' && scripts !== null
      ? (scripts as Record<string, unknown>).e2e
      : undefined;
  expect(typeof script, 'Ohne das Skript misst dieser Fall nichts.').toBe(
    'string',
  );

  const invoked = new Set(
    [...String(script).matchAll(/--project=([\w-]+)/gu)].map(
      (hit) => hit[1] ?? '',
    ),
  );
  // A guard over an empty set would pass for the wrong reason.
  expect(invoked.size).toBeGreaterThan(2);

  const declared = (config.projects ?? [])
    .map((project) => project.name)
    .filter((name): name is string => name !== undefined);
  expect(declared.length).toBeGreaterThan(2);

  expect(
    declared.filter((name) => !invoked.has(name)),
    'Diese Projekte stehen in playwright.config.ts, werden von `pnpm e2e` ' +
      'aber nicht aufgerufen — sie laufen nie, und der Lauf meldet trotzdem ' +
      'grün. Ergänze sie im `e2e`-Skript in package.json.',
  ).toStrictEqual([]);

  expect(
    [...invoked].filter((name) => !declared.includes(name)),
    'Diese Projekte ruft `pnpm e2e` auf, es gibt sie aber nicht — Playwright ' +
      'bricht dann mit „Project(s) not found" ab.',
  ).toStrictEqual([]);
});
