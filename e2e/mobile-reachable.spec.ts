import { expect, test } from '@playwright/test';
import type { A11yFixture } from './a11y/views';
import { A11Y_VIEWS } from './a11y/views';

import { expectNoHorizontalScroll, openMobileMenu } from './app-flows';
import {
  buildFixtureForm,
  purgeFixtureForm,
  RESPONSES_STICKY_SHADOW,
} from './mobile/fixture';
import { expectNoControlCovered, probeControls } from './mobile/operable';
import { authStateFile } from './seed-account';

/**
 * **No view scrolls horizontally, and nothing covers anything operable**
 *  — at 360 px, one case per view.
 *
 * Two measurements per view, and neither of them existed across the board
 * before:
 *
 * 1. `expectNoHorizontalScroll` — `scrollWidth <= clientWidth` at the document,
 *    plus `<main>` and every clipping box inside it (`app-flows.ts` explains
 *    why one measurement became three). Up to here every mobile spec called it
 *    for *its* view; an area that was not.
 * 2. `expectNoControlCovered` — the point in the middle of every control
 *    belongs to itself. This measurement is new, and `mobile/operable.ts` names
 *    the defect this application *did* build with it.
 *
 * **Which views** is not decided by this file here either: `a11y/views.ts`
 * carries the way to each one, and `a11y-view-list.spec.ts` counts these ways
 * against the addresses `parseRoute` can produce. The list is **read** here — a
 * second one, maintained by hand, would be exactly the one that forgets the new
 * view.
 *
 * **`mode: 'default'` instead of the global `fullyParallel`**, for the same
 * leftover reason as in `a11y.spec.ts`: `beforeAll` builds a form, publishes it,
 * submits an answer and parks a draft. Under `fullyParallel` that would run once
 * per worker.
 */

test.describe.configure({ mode: 'default' });

/**
 * The browser members that the callback of the counter-check uses — ambient and
 * module-wide, for the reason `app-flows.ts` sets out: the root
 * `tsconfig.json` over `e2e/` deliberately has no DOM lib.
 */
interface DecorationTarget {
  getBoundingClientRect: () => {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}
interface DecorationLayer {
  setAttribute: (name: string, value: string) => void;
}
declare const document: {
  createElement: (tag: string) => DecorationLayer;
  readonly body: { append: (node: DecorationLayer) => void };
};
declare const window: {
  readonly scrollX: number;
  readonly scrollY: number;
};

let fixture: A11yFixture;
let formId: string | undefined;

test.beforeAll(async ({ browser }) => {
  const built = await buildFixtureForm(browser);
  fixture = built.fixture;
  formId = built.formId;
});

test.afterAll(async ({ browser }) => {
  await purgeFixtureForm(browser, formId);
});

test.describe('360 px – angemeldet', () => {
  test.use({ storageState: authStateFile });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'signed-in')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);
      await expectNoHorizontalScroll(page, `${view.name} (360 px)`);
      await expectNoControlCovered(page, `${view.name} (360 px)`, {
        knownStickyShadow:
          view.kind === 'responses' ? RESPONSES_STICKY_SHADOW : [],
      });
    });
  }
});

test.describe('360 px – ohne Anmeldung', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const view of A11Y_VIEWS.filter((v) => v.audience === 'public')) {
    test(view.name, async ({ page }) => {
      await view.open(page, fixture);
      await expectNoHorizontalScroll(page, `${view.name} (360 px)`);
      await expectNoControlCovered(page, `${view.name} (360 px)`);
    });
  }
});

/**
 * The opened off-canvas sheet is a layout layer of its own — and the only one
 * in which a scrim lies over the whole page. The special case of the checker
 * ("if a modal is open, what stands **inside** it is checked") is thereby
 * really driven once, instead of only being described.
 */
test.describe('360 px – das offene Menü', () => {
  test.use({ storageState: authStateFile });

  test('Off-Canvas-Sheet: nichts ragt heraus, nichts liegt über den Einträgen', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await openMobileMenu(page);

    await expectNoHorizontalScroll(
      page,
      'Dashboard mit offenem Sheet (360 px)',
    );
    // Menü schließen, Dashboard, Verwaltung, tenant row, Abmelden — below five
    // entries the sheet has not loaded.
    await expectNoControlCovered(page, 'Off-Canvas-Sheet (360 px)', {
      minimum: 5,
    });
  });
});

/**
 * **The reproduction, driven permanently** — literally the same one:
 * „eine dekorative Ebene mit `position:absolute` über einen Schalter legen →
 * (2) rot".
 *
 * It stands fixed in the run and not only once in the report, for the reason
 * `a11y.spec.ts` names for its counter-check: a probe driven once says nothing
 * about whether the assertion is still sharp in half a year.
 *
 * And it proves the **second** part of it along with it: `setChecked`
 * stays green at the same dead zone. That is not an aside but
 * the reason why this defect could arise unnoticed without a test turning red.
 */
test.describe('Gegenprobe: die tote Zone wird gesehen', () => {
  test.use({ storageState: authStateFile });

  test('eine Dekoration über dem Schalter macht die Messung rot — `setChecked` nicht', async ({
    page,
  }) => {
    await page.goto(`/forms/${fixture.formId}/settings`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Formular-Einstellungen' }),
    ).toBeVisible();

    const access = page.getByRole('region', { name: 'Zugriff & Sicherheit' });
    const control = access.getByRole('switch', {
      name: 'Zwischenspeichern erlauben',
    });
    await expect(control).toBeVisible();

    // Before **without a finding at this switch** — not "flawless before".
    // The same consideration as with the axe counter-check: what is measured is
    // the difference *this* decoration makes.
    const before = await probeControls(page);
    expect(
      before.covered,
      'Vor der eingebauten Dekoration darf nichts überdeckt sein — sonst misst ' +
        'dieser Fall nicht, was er zu messen vorgibt.',
    ).toStrictEqual([]);

    const wasChecked = await control.isChecked();

    /*
      The decoration: `position: absolute`, opaque, over the switch — and
      without `pointer-events: none`, so exactly what `styles/switch.css` once
      had. Absolute and not `fixed`, so that it sticks to the switch when the
      measurement scrolls it into the middle of the viewport.

      Created in the DOM instead of in the source, like the axe counter-check
      and for its reason: breaking a foreign file and trusting that it is turned
      back yields the same DOM with more risk.
    */
    await control.evaluate((element: DecorationTarget) => {
      const box = element.getBoundingClientRect();
      const layer = document.createElement('div');
      layer.setAttribute('class', 'test-decoration');
      layer.setAttribute(
        'style',
        [
          'position: absolute',
          `left: ${String(box.left + window.scrollX)}px`,
          `top: ${String(box.top + window.scrollY)}px`,
          `width: ${String(box.width)}px`,
          `height: ${String(box.height)}px`,
          'background: transparent',
          'z-index: 9999',
        ].join('; '),
      );
      document.body.append(layer);
    });

    const after = await probeControls(page);
    const found = after.covered.map(
      (finding) => `${finding.control} ← ${finding.covering}`,
    );
    expect(
      found.join(' | '),
      'Die Messung muss den überdeckten Schalter nennen, und die Dekoration ' +
        'als das, was an seiner Mitte liegt. Tut sie das nicht, ist sie stumpf ' +
        'und jede grüne Messung darüber wertlos.',
    ).toMatch(/switch__input\[role=switch\] ← div\.test-decoration/u);

    /*
      And the other half: **`setChecked` sees nothing of it.** With the value
      the switch has anyway it does not click — it only checks and returns. A
      case written that way would stay green over the dead zone; that is the
      line that was missing.

      A short deadline, so that this proof does not hang on the time limit of
      the run: if `setChecked` does go clicking after all, one second is ample
      for the actionability failure that `click()` below demonstrates.
    */
    await control.setChecked(wasChecked, { timeout: 2000 });

    // A real click on the other hand does not get through — Playwright's
    // actionability check sees the same layer the measurement above names.
    const refusal: string | null = await control.click({ timeout: 2000 }).then(
      () => null,
      // The text of the message, not the error itself: only it says **why** the
      // click did not get through, and only it is safe to format.
      (error: unknown) =>
        error instanceof Error ? error.message : 'unbekannt',
    );
    expect(
      refusal ?? '(der Klick ging durch)',
      'Ein Klick auf den überdeckten Schalter muss scheitern — sonst liegt die ' +
        'Dekoration gar nicht darüber und der ganze Fall misst nichts.',
    ).toMatch(/intercepts pointer events|Timeout/u);
  });
});
