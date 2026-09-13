import { expect, test } from '@playwright/test';

import { expectNoHorizontalScroll } from './app-flows';
import { CROP_SAMPLE_PNG_BASE64 } from './sample-image';
import { tenantAdminStateFile } from './seed-account';

/**
 * The one browser global the crop case reads — declared here for the reason
 * `tenant-admin.spec.ts` and `app-flows.ts` declare their own: the root
 * `tsconfig.json` that covers `e2e/` deliberately has no DOM lib.
 */
interface ComputedStyle {
  readonly touchAction: string;
}
declare function getComputedStyle(element: unknown): ComputedStyle;

/**
 * Tenant administration at 360 px — the mobile half of the requirement, and the
 * fourth of the four small remaining gaps that never got measured below
 * the breakpoint.
 *
 * **Its own file, deliberately not `tenant-admin.spec.ts` itself added to the
 * `mobile-360x740` project.** That file runs `mode: 'serial'` and writes
 * shared state of one organisation — its branding row, its groups, its members — for
 * the reason its own docblock gives: two workers editing the same row at once
 * would take the 409 of an optimistic lock rather than merely race an
 * assertion. `fullyParallel` runs every project concurrently, so claiming that
 * file for the mobile project as well would run its serial suite **twice, at
 * once**, against the very row it says must not be touched by two workers —
 * exactly the hazard the file exists to avoid. A dedicated file that never
 * saves sidesteps it instead of fighting it.
 *
 * **The one thing this file checks is the middle-click of the Logo chooser**
 * — the dead zone (a decoration covering part of a control, invisible to
 * `setChecked()`) — because a decoration is exactly the kind of defect a
 * narrower box is more likely to reintroduce, and because it needs no save: the
 * selection is local draft state until „Speichern" is pressed, which this file
 * never does. The colour round-trip, the group/member fixture and the
 * access-revocation case live in `tenant-admin.spec.ts`, in the desktop
 * project, with the full guard chain behind them; nothing here duplicates
 * that evidence.
 */

test.use({ storageState: tenantAdminStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

const TENANT_APPEARANCE_PATH = '/admin/appearance';

test.describe('Organisations-Verwaltung · Erscheinungsbild (360 px)', () => {
  test('die Logo-Kachel lässt sich in ihre Mitte klicken, und nichts ragt über den Viewport', async ({
    page,
  }) => {
    await page.goto(TENANT_APPEARANCE_PATH);
    await expect(
      page.getByRole('heading', { name: 'Organisations-Verwaltung', level: 1 }),
    ).toBeVisible();

    // The chooser group is called „Logo" (finding 8).
    const logoGroup = page.getByRole('radiogroup', { name: 'Logo' });
    const tiles = logoGroup.getByRole('radio');

    /*
     * Waited for, not read once. The `h1` above belongs to the *shell* of the
     * Verwaltung and is already there while the tab still renders
     * „Erscheinungsbild wird geladen…", so `count()` on its own would read 0
     * and the `toBeGreaterThan(1)` below would fail for a reason that has
     * nothing to do with the chooser. That is the lesson of an earlier acceptance run,
     * and this file repeated it — `count()` is the one locator method that
     * does not wait (`CONTRIBUTING.md`: wait for a state, never for a duration).
     */
    await expect(
      tiles,
      'The Logo chooser has not rendered yet — the heading above belongs to ' +
        'the surrounding Verwaltung, not to this tab.',
    ).not.toHaveCount(0);

    const tileCount = await tiles.count();
    expect(
      tileCount,
      'The chooser must offer more than one tile, or clicking one proves ' +
        'nothing about whether the middle of the control is reachable.',
    ).toBeGreaterThan(1);

    const none = logoGroup.getByRole('radio', { name: 'Kein Logo' });
    const other = tiles.nth(tileCount - 1);
    const startedOnNone = await none.isChecked();

    // `.click()` targets the element's centre and verifies the point receives
    // the event — never `.check()`/`.setChecked()`, which skip the pointer
    // and would stay green over a decoration covering the tile.
    if (startedOnNone) {
      await other.click();
      await expect(other).toBeChecked();
      await none.click();
      await expect(none).toBeChecked();
    } else {
      await none.click();
      await expect(none).toBeChecked();
      await other.click();
      await expect(other).toBeChecked();
    }

    // Draft-only: nothing above ever clicked „Speichern", so the organisation's stored
    // Logo is untouched — the toggle proves reachability, not persistence.
    await expectNoHorizontalScroll(
      page,
      'Organisations-Verwaltung · Erscheinungsbild',
    );
  });

  /**
   * „Ausschnitt wählen" with the finger.
   *
   * Two things that exist only here:
   *
   * 1. **The same gesture with the finger.** The frame is built with pointer
   *    events and not with HTML5 DnD, precisely so that mouse and touch are
   *    *one* path — that is proven only when a touch context really drags it.
   *    Without `touch-action: none` on frame and handles the browser scrolls the
   *    page instead of giving us the drag, and this case is red.
   * 2. **Nothing sticks out over the viewport at 360 px** — the dialog is the
   *    widest surface of this tab, and an image without `max-width` would be
   *    exactly the case that `expectNoHorizontalScroll` measures.
   *
   * Saves nothing: the dialog is cancelled, no request goes
   * out.
   */
  test('der Ausschnittsrahmen lässt sich mit dem Finger ziehen, und der Dialog passt in 360 px', async ({
    page,
  }) => {
    await page.goto(TENANT_APPEARANCE_PATH);
    const picker = page.locator('input[type="file"]');
    await expect(picker).toBeEnabled();

    await picker.setInputFiles({
      name: 'Zuschnitt.png',
      mimeType: 'image/png',
      buffer: Buffer.from(CROP_SAMPLE_PNG_BASE64, 'base64'),
    });

    const dialog = page.getByRole('dialog', { name: 'Ausschnitt wählen' });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalScroll(page, 'Ausschnitt wählen (Dialog offen)');

    const frame = dialog.getByRole('group', { name: 'Bildausschnitt' });
    const readout = dialog.locator('.logo-crop__readout');
    await expect(readout).toHaveText(
      'Ausschnitt 400 × 400 Pixel, linke obere Ecke bei 0, 0.',
    );

    // First shrink it — a frame that fills the whole image cannot
    // move, and a drag without effect would be no evidence.
    await frame.focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(readout).toHaveText(
      'Ausschnitt 392 × 392 Pixel, linke obere Ecke bei 0, 0.',
    );

    /*
     * The frame must not lose the gesture to the browser's scroller —
     * without `touch-action: none` the page scrolls instead of giving us the drag,
     * and that is the commonest reason why a hand-built touch drag "does not
     * work on the phone" (the same measurement as on the builder's handle).
     */
    expect(
      await frame.evaluate(
        (element: object) => getComputedStyle(element).touchAction,
      ),
    ).toBe('none');

    const box = await frame.boundingBox();
    if (box === null) {
      throw new Error('[e2e] the crop frame was not laid out');
    }
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const to = { x: from.x + 200, y: from.y + 200 };

    // Real touch input via the DevTools protocol, no events generated in
    // the script — `page.touchscreen` can only tap. Exactly this
    // distinction is the point: a synthetic `pointerdown` would pass
    // over HTML5 DnD as well, a finger would not.
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x, y: from.y }],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: to.x, y: to.y }],
      });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
    } finally {
      await session.detach();
    }

    // Down and to the right past the edge: the frame stays inside the image and
    // keeps its size (400 − 392 = 8 on both axes).
    await expect(readout).toHaveText(
      'Ausschnitt 392 × 392 Pixel, linke obere Ecke bei 8, 8.',
    );

    await expectNoHorizontalScroll(page, 'Ausschnitt wählen (nach dem Zug)');
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeHidden();
  });
});
