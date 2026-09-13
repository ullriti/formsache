import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import ts from 'typescript';

import playwrightConfig from '../playwright.config';

/**
 * **No mobile case operates a switch with `setChecked`** (first half).
 *
 * `setChecked` does not click when the value is already right — it checks and
 * returns. Over a dead zone a case written that way therefore stays green, and
 * that is exactly how the coverage error got through the whole suite.
 * `mobile-reachable.spec.ts` demonstrates it once; **this file holds it
 * fast**, because a demonstration says nothing about what somebody writes next
 * week.
 *
 * It reads source text instead of starting a browser and therefore runs in the
 * `smoke` project: the finding comes in the first seconds of a run, not after
 * the slow projects. The same construction and the same reason as
 * `smoke-suite-coverage.spec.ts`.
 *
 * ## What counts as a mobile case
 *
 * The files that *are* mobile operation: `…-mobile.spec.ts` (the halves that
 * were created per view) and `mobile-….spec.ts` (the remaining surface).
 * Expressly **not** the desktop files: there a `setChecked` in a preparation
 * is a shortcut that says so, and several of them give a reason in their
 * header why their *assertions* click all the same.
 */

/**
 * The one file that **must** use it — and why.
 *
 * The counter-check for it lays a decoration over a switch and proves that
 * `setChecked` with the value the switch has anyway stays green. Without the
 * call there would be no such proof.
 *
 * The exception is **checked**: if the call is missing there, this case is red
 * — an exception list that no longer points at anything is the kind of rule
 * that eventually covers every file.
 */
const PROVES_THE_POINT = 'mobile-reachable.spec.ts';

/**
 * Looks for the **call** `x.setChecked(…)` — not the word.
 *
 * Via the parser instead of via a string, and that is not elegance but a
 * measured failure: the first version searched for `.setChecked(` as text and
 * reported four files that mention the call only in their **comment** („The
 * middle of the switch, not `.check()`/`.setChecked()`") — that is, precisely
 * the ones that do everything right. A checker that cannot tell a model from a
 * violation trains people to delete the comment.
 */
/**
 * The **blocks** in which `setChecked` is called — per call the text of the
 * enclosing `test(…)` or `test.describe(…)`.
 *
 * ⚠️ **Why not the whole file** (a review finding, second half). The first
 * version of this hardening picked files by viewport and reported
 * `durchlauf-ki-und-export.spec.ts` — rightly as a file, wrongly as a
 * violation: the two
 * calls there stand in a **desktop preparation** (line 1165), the mobile block
 * begins seven hundred lines later. A guard that does not tell the two apart
 * either forces an exception for a file that does nothing wrong, or it gets
 * switched off.
 *
 * The question asked per call is therefore: does it stand in a block for which
 * a mobile viewport applies?
 */
function setCheckedBlocks(
  fileName: string,
  source: string,
): (string | undefined)[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );

  const blocks: (string | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setChecked'
    ) {
      blocks.push(enclosingBlockText(node));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return blocks;
}

/**
 * The text of the nearest enclosing `test(…)` or `test.describe(…)`.
 *
 * `undefined` when the call stands outside — then the whole file applies,
 * because a helper function at module level is used by every block, including
 * the mobile one.
 */
function enclosingBlockText(node: ts.Node): string | undefined {
  // `node.parent` is never `undefined` in the type, but very much so at
  // runtime — at the root of the tree. The loop therefore ends at
  // `SourceFile`, which it never recognises as a call anyway.
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined && !ts.isSourceFile(current);
    current = current.parent as ts.Node | undefined
  ) {
    if (!ts.isCallExpression(current)) {
      continue;
    }
    const callee = current.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression)
        ? `${callee.expression.text}.${callee.name.text}`
        : '';
    if (name === 'test' || name === 'test.describe') {
      return current.getFullText();
    }
  }
  return undefined;
}

/**
 * **Mobile is a question of the viewport, not of the file name**
 * (a review finding).
 *
 * The first version picked by the name: `…-mobile.spec.ts` and
 * `mobile-….spec.ts`. The danger hangs on the width, though, and three files
 * carry mobile blocks under a different name — `builder-drag`,
 * `durchlauf-funktionsumfang` and `durchlauf-ki-und-export` (each
 * `test.use({ viewport: { width: 360 … } })` or a context of their own). This
 * guard was blind to those.
 *
 * **Both** are therefore recognised: the name (it stays the intention a file
 * states) **and** a width below the breakpoint anywhere in the source text.
 * The number is deliberately a range check and not an equality: `375` (iPhone)
 * and `390` are just as mobile as the `360` this suite measures with.
 */
function usesMobileViewport(source: string): boolean {
  return /width:\s*(?:2\d\d|3\d\d|4[0-1]\d)\b/u.test(source);
}

function isMobileSpecName(name: string): boolean {
  return (
    name.endsWith('.spec.ts') &&
    (name.endsWith('-mobile.spec.ts') || name.startsWith('mobile-'))
  );
}

/** The project whose `use` carries the 360 px (`playwright.config.ts`). */
const MOBILE_PROJECT = 'mobile-360x740';

/**
 * **The third way of being mobile: the project says so.**
 *
 * The name and `test.use` were two thirds. CI found the last one:
 * `a11y.spec.ts` is claimed by **both** view projects in
 * `playwright.config.ts` and runs entirely at 360 px in the mobile project —
 * without ever naming a width in its source text. For this guard the file was
 * thereby a desktop file, and a `setChecked` in one of its cases would have
 * gone unnoticed.
 *
 * Derived instead of maintained, for the same reason as the organisation
 * prefixes: a list made by hand would be right on the day it came into being.
 * If the project is missing or its `testMatch` is not a regular expression,
 * that is an error and not an empty result — otherwise this extension would
 * one day check nothing.
 */
function mobileProjectFiles(names: readonly string[]): Set<string> {
  const project = (playwrightConfig.projects ?? []).find(
    (candidate) => candidate.name === MOBILE_PROJECT,
  );
  if (project === undefined) {
    throw new Error(
      `Das Projekt „${MOBILE_PROJECT}" gibt es nicht mehr — dieser Wächter ` +
        'liest seine Dateiliste daraus und wäre sonst still blind.',
    );
  }
  const match: unknown = project.testMatch;
  if (!(match instanceof RegExp)) {
    throw new Error(
      `Das \`testMatch\` von „${MOBILE_PROJECT}" ist kein regulärer Ausdruck ` +
        'mehr; die Ableitung unten muss dann mitwachsen.',
    );
  }
  return new Set(names.filter((name) => match.test(`/${name}`)));
}

test('kein Mobil-Fall bedient einen Schalter mit `setChecked` ', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const all = (await readdir(here)).filter((name) => name.endsWith('.spec.ts'));

  const sources = new Map<string, string>();
  for (const name of all) {
    sources.set(name, await readFile(`${here}${name}`, 'utf8'));
  }

  const byProject = mobileProjectFiles(all);

  const names = all.filter(
    (name) =>
      isMobileSpecName(name) ||
      usesMobileViewport(sources.get(name) ?? '') ||
      byProject.has(name),
  );

  // A check over an empty list would be green for the wrong reason.
  expect(
    names.length,
    'Es muss Mobil-Specs geben, sonst prüft dieser Fall nichts.',
  ).toBeGreaterThan(5);

  // And the finding itself: the three files that escaped the name check are
  // now included. Without this line „by viewport" would be a claim.
  for (const named of [
    'builder-drag.spec.ts',
    'durchlauf-ki-und-export.spec.ts',
  ]) {
    expect(
      names,
      `${named} trägt einen Mobil-Block und muss geprüft werden.`,
    ).toContain(named);
  }

  // And the same for the third way: `a11y.spec.ts` names no width and is not
  // called mobile — the project makes it one. Without this line „by project"
  // would again be only a claim.
  expect(
    [...byProject].sort(),
    'Die Ableitung aus dem Mobil-Projekt liefert `a11y.spec.ts` nicht mehr — ' +
      'dann prüft dieser Teil des Wächters nichts.',
  ).toContain('a11y.spec.ts');

  const offenders: string[] = [];
  let exceptionStillNeeded = false;

  for (const name of names) {
    const source = sources.get(name) ?? '';
    const blocks = setCheckedBlocks(name, source);
    if (blocks.length === 0) {
      continue;
    }
    if (name === PROVES_THE_POINT) {
      exceptionStillNeeded = true;
      continue;
    }
    // **Block-exact**: a file with a mobile name is mobile as a whole;
    // otherwise only a call counts whose block has a mobile viewport.
    //
    // ⚠️ A call **outside** every block (`undefined`) is shared preparation.
    // For a file that takes its width out of the source text it counts all the
    // same — it *is* mobile. For one that is mobile only via the project, the
    // same preparation also runs in the desktop project: there `setChecked` is
    // a shortcut that says so and not a promise about a finger. Exactly those
    // three calls stand in `a11y.spec.ts`, and they create data instead of
    // operating a switch.
    const mobileCalls = isMobileSpecName(name)
      ? blocks
      : blocks.filter((block) =>
          block === undefined
            ? usesMobileViewport(source)
            : usesMobileViewport(block) || byProject.has(name),
        );
    if (mobileCalls.length > 0) {
      offenders.push(name);
    }
  }

  expect(
    offenders,
    'Diese Mobil-Specs rufen `setChecked` auf. Ersetze den Aufruf durch ' +
      '`click()`/`tap()` und miss den Wert **vorher gegen nachher** — ' +
      '`setChecked` klickt nicht, wenn der Wert schon stimmt, und sieht eine ' +
      'tote Zone deshalb nie (`styles/switch.css`).',
  ).toStrictEqual([]);

  expect(
    exceptionStillNeeded,
    `${PROVES_THE_POINT} soll den Aufruf tragen: dort ist er die Gegenprobe, ` +
      'die belegt, dass `setChecked` über einer Dekoration grün bleibt. Ist er ' +
      'dort verschwunden, gehört diese Ausnahme gelöscht statt stehen zu bleiben.',
  ).toBe(true);
});
