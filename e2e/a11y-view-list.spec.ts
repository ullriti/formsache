import { expect, test } from '@playwright/test';

import { dialogSources } from './a11y/overlay-sources';
import { A11Y_OVERLAYS } from './a11y/overlays';
import { questionTypeLabels } from './a11y/question-type-labels';
import {
  FIRST_QUESTION_TYPE,
  FURTHER_QUESTION_TYPES,
} from './a11y/question-types';
import { routerRouteKinds } from './a11y/router-kinds';
import { A11Y_VIEWS } from './a11y/views';

/**
 * The checklist of the axe run, **counted against the router** .
 *
 * This checklist is supposed to achieve two things, and this is the second:
 * „die Liste der geprüften Ansichten wird aus dem Router abgeleitet, nicht von
 * Hand gepflegt". The axe run itself proves that the visited views are clean —
 * it cannot prove that it has visited all of them. A hand-maintained list
 * forgets exactly the view that is new, and the run reports green because it ran
 * over one view fewer.
 *
 * Runs in the project `smoke`: no session, no database, no browser — so in the
 * first seconds of a run and not after the slow projects. That is the same
 * consideration as with `smoke-suite-coverage.spec.ts` next door, which asks the
 * inversion of the same question (does every file run in a project at all?).
 */

test('jede Adresse des Routers hat eine Ansicht in der axe-Prüfliste', () => {
  const kinds = routerRouteKinds();
  const covered = new Set(
    A11Y_VIEWS.flatMap((view) => (view.kind === null ? [] : [view.kind])),
  );

  const missing = [...kinds].filter((kind) => !covered.has(kind));
  expect(
    missing,
    'Diese Routen-Sorten kann `parseRoute` aus einer URL erzeugen, aber der ' +
      'axe-Lauf besucht sie nicht. Es ist eine Ansicht, die es gibt und die ' +
      'niemand prüft — trage sie in `e2e/a11y/views.ts` ein (mit dem Weg, wie ' +
      'man hinkommt).',
  ).toStrictEqual([]);
});

/**
 * And the opposite direction: an entry whose kind the router does not know.
 *
 * That happens when renaming a route. Without this half the orphaned entry would
 * stay, would *not* cover the new kind — and the count above would nevertheless
 * work out, because the sets stayed equally large.
 */
test('kein Eintrag der Prüfliste zeigt auf eine Adresse, die es nicht gibt', () => {
  const kinds = routerRouteKinds();

  const orphans = A11Y_VIEWS.flatMap((view) =>
    view.kind !== null && !kinds.has(view.kind) ? [view.kind] : [],
  );
  expect(
    orphans,
    'Diese Sorten stehen in `e2e/a11y/views.ts`, aber `parseRoute` erzeugt ' +
      'sie nicht mehr. Vermutlich wurde eine Route umbenannt — dann zeigt der ' +
      'Eintrag ins Leere und die neue Sorte ist ungeprüft.',
  ).toStrictEqual([]);
});

/**
 * And that anything was counted at all.
 *
 * Both assertions above compare with `[]` and would be green against two empty
 * sets. `routerRouteKinds()` does throw on too few hits, but an empty
 * `A11Y_VIEWS` would pass through both — and would be exactly the state in which
 * the checker had run over nothing.
 */
test('die Prüfliste ist nicht leer und deckt jede Adresse ab', () => {
  const kinds = routerRouteKinds();

  expect(A11Y_VIEWS.length).toBeGreaterThanOrEqual(kinds.size);
  expect(
    new Set(A11Y_VIEWS.map((view) => view.name)).size,
    'Zwei Einträge mit demselben Namen wären im Bericht nicht zu ' +
      'unterscheiden — und der Testname ist hier der ganze Nachweis, welche ' +
      'Ansicht in welcher Breite geprüft wurde.',
  ).toBe(A11Y_VIEWS.length);
});

/**
 * **The same count for the overlays** (a review finding, 2026-08-12).
 *
 * The three cases above are complete against `parseRoute` — and were
 * nevertheless half the truth: nine dialogs have no address, so a count over
 * addresses could not miss them. For four months the axe run saw not a single
 * one of them and reported „every view" while doing so.
 *
 * What is counted therefore is a second feature: `role="dialog"` in the source
 * text of the components (`overlay-sources.ts`). A new dialog without an entry
 * in `overlays.ts` turns this case red instead of staying silently unchecked.
 */
test('jeder Dialog der Anwendung hat einen Eintrag in der Überlagerungsliste', () => {
  const sources = dialogSources();
  const covered = new Set(
    A11Y_OVERLAYS.flatMap((overlay) =>
      overlay.source === null ? [] : [overlay.source],
    ),
  );

  const missing = [...sources].filter((source) => !covered.has(source));
  expect(
    missing,
    'Diese Komponenten machen einen `role="dialog"` auf, und der axe-Lauf ' +
      'sieht ihn nie. Trage sie in `e2e/a11y/overlays.ts` ein (mit dem Weg, ' +
      'wie man den Dialog aufbekommt) — ein Dialog ist die Form, in der diese ' +
      'Anwendung ihre folgenreichsten Schritte zeigt.',
  ).toStrictEqual([]);
});

/**
 * And the opposite direction — the same consideration as with the router: an
 * entry that points at a file which no longer opens a dialog covers nothing, and
 * the sets would nevertheless have stayed equally large.
 */
test('kein Eintrag der Überlagerungsliste zeigt auf einen Dialog, den es nicht gibt', () => {
  const sources = dialogSources();

  const orphans = A11Y_OVERLAYS.flatMap((overlay) =>
    overlay.source !== null && !sources.has(overlay.source)
      ? [overlay.source]
      : [],
  );
  expect(
    orphans,
    'Diese Pfade stehen in `e2e/a11y/overlays.ts`, tragen aber kein ' +
      '`role="dialog"` mehr. Vermutlich wurde eine Komponente verschoben oder ' +
      'umgebaut — dann prüft der Eintrag etwas anderes, als er behauptet.',
  ).toStrictEqual([]);
});

/**
 * And that the popovers do not disappear silently.
 *
 * For them there is no feature in the source text that could be counted
 * reliably (`aria-expanded` also stands on accordions and menus that are no
 * overlay). What remains is a lower bound — the same build as `MINIMUM_KINDS` in
 * `router-kinds.ts`, and for the same reason: against the empty set every
 * checklist is complete.
 */
test('die Überlagerungsliste deckt auch das ab, was kein Dialog ist', () => {
  const withoutDialog = A11Y_OVERLAYS.filter(
    (overlay) => overlay.source === null,
  );
  // Five: the three popovers and the two states of the fill-in mask. The number
  // is the *present-day* quantity and no reserve — the bound stood at 5 against
  // six entries for one commit, because „Seiten (Off-Canvas)" was wrongly
  // carried as a non-dialog. Whoever had deleted „Popover · Export" back then —
  // exactly the entry that found the serious contrast error — would have landed
  // at 5 and the guard would have stayed green.
  expect(withoutDialog.map((overlay) => overlay.name)).toHaveLength(5);
  expect(
    new Set(A11Y_OVERLAYS.map((overlay) => overlay.name)).size,
    'Zwei Einträge mit demselben Namen wären im Bericht nicht zu ' +
      'unterscheiden — und der Testname ist hier der ganze Nachweis.',
  ).toBe(A11Y_OVERLAYS.length);
});

/**
 * **And the same count for the field kinds** (review rework, 2026-08-12).
 *
 * An earlier revision brought the check form from one text question up to all
 * sixteen and thereby immediately found a *critical* violation. What it did not
 * do: count the sixteen against anything. The list was thereby exactly the
 * hand-maintained one that the finding had set out against — a seventeenth field
 * kind would come along, all a11y cases would stay green, and it would never
 * have been scanned.
 *
 * *Counter-check:* take an entry out of `FURTHER_QUESTION_TYPES` → this case
 * turns red and names it.
 */
test('das Prüfformular des axe-Laufs trägt jede Feldart der Palette', () => {
  const palette = questionTypeLabels();
  const covered = new Set<string>([
    FIRST_QUESTION_TYPE,
    ...FURTHER_QUESTION_TYPES,
  ]);

  const missing = palette.filter((label) => !covered.has(label));
  expect(
    missing,
    'Diese Feldarten bietet die Palette an, und das Prüfformular des ' +
      'axe-Laufs enthält keine davon — sie werden also in keiner Ansicht ' +
      'gescannt. Trage sie in `e2e/a11y/question-types.ts` ein.',
  ).toStrictEqual([]);

  const unknown = [...covered].filter((label) => !palette.includes(label));
  expect(
    unknown,
    'Diese Beschriftungen stehen in `e2e/a11y/question-types.ts`, aber die ' +
      'Palette kennt sie nicht mehr. Der Eintrag klickt dann auf einen Knopf, ' +
      'den es nicht gibt — und die umbenannte Art ist ungeprüft.',
  ).toStrictEqual([]);
});
