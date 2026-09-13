import { expect, test, type Page } from '@playwright/test';

import { authStateFile } from './seed-account';

/**
 * **Motion can be switched off** .
 *
 * ⚠️ **Above** the decided target: „Animation aus Interaktionen" is
 * WCAG 2.3.3 and thus **AAA**. Cheap to build, therefore in — and named
 * here so that it is not later misunderstood as an AA obligation.
 *
 * ## What is measured is the computed duration, not the source text of the rule
 *
 * It would be one sentence shorter to read `base.css` and check that
 * `@media (prefers-reduced-motion: reduce)` stands in it. That would again be a test
 * that reads a file's text (rule 2 of this check) — it would stay green if the
 * rule ended up in a file nobody imports, if a later
 * selector overrode it, or if `!important` were missing in one place.
 *
 * This file therefore sets the **media query in the browser** and reads the
 * `transition-duration` and `animation-duration` that come out of it.
 *
 * ## And the counter-check stands next to it
 *
 * A measurement „alles ist 0 s" alone would be green for an application without any
 * animation too — and thus indistinguishable from „die Abschaltung wirkt".
 * The first case below therefore measures **without** the query and
 * demands that there is anything to switch off at all.
 */

test.describe.configure({ mode: 'default' });
test.use({ storageState: authStateFile });

/** Only the members that the `evaluate` callbacks below use. */
interface AnimatedElement {
  readonly tagName: string;
  readonly className: unknown;
}

declare const document: {
  querySelectorAll: (selector: string) => Iterable<AnimatedElement>;
  readonly fonts: { readonly ready: Promise<unknown> };
};
declare const getComputedStyle: (element: AnimatedElement) => {
  readonly transitionDuration: string;
  readonly animationDuration: string;
  readonly animationName: string;
};

interface Moving {
  /** `tag.klasse`, so that a failure says which box is moving. */
  readonly element: string;
  readonly kind: 'transition' | 'animation';
  readonly seconds: number;
}

/**
 * Every box of the page that moves for more than the blink of an eye.
 *
 * The threshold is **1 ms** and not 0: the switch-off of this application sets
 * `0.01ms` instead of `0s` — the usual trick, so that `transitionend` events
 * keep firing and state machines waiting for them do not get stuck.
 * „Keine Bewegung" therefore means „zu kurz, um sichtbar zu sein", and this number
 * writes down exactly that.
 */
async function movingBoxes(page: Page): Promise<readonly Moving[]> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  return page.evaluate((): readonly Moving[] => {
    const seconds = (value: string): number =>
      Math.max(
        ...value.split(',').map((part) => {
          const text = part.trim();
          const number = Number.parseFloat(text);
          if (Number.isNaN(number)) {
            return 0;
          }
          return text.endsWith('ms') ? number / 1000 : number;
        }),
      );

    const name = (element: AnimatedElement): string =>
      `${element.tagName.toLowerCase()}${
        typeof element.className === 'string' && element.className !== ''
          ? `.${element.className.trim().split(/\s+/u).join('.')}`
          : ''
      }`;

    const found: Moving[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);

      const transition = seconds(style.transitionDuration);
      if (transition > 0.001) {
        found.push({
          element: name(element),
          kind: 'transition',
          seconds: transition,
        });
      }

      // `animationName: none` means: the duration is there, but nothing is
      // running. Without this question every box with an inherited duration would count.
      const animation = seconds(style.animationDuration);
      if (style.animationName !== 'none' && animation > 0.001) {
        found.push({
          element: name(element),
          kind: 'animation',
          seconds: animation,
        });
      }
    }
    return found;
  });
}

/** Short and readable for the error message. */
function describe(boxes: readonly Moving[]): string {
  return boxes
    .slice(0, 8)
    .map(
      (box) =>
        `${box.element} (${box.kind}, ${String(Math.round(box.seconds * 1000))} ms)`,
    )
    .join('; ');
}

/* --- The measurement: the same view, twice ------------------------------- */

/**
 * What the media query makes of this view — **both states, on
 * the same boxes**.
 *
 * A case that only measures „mit `reduce` bewegt sich nichts" is just as green for an
 * application **without any animation** as for one that switches it off
 * cleanly. The zero only gets its meaning from something having been counted
 * beforehand on the same view — which is why the counter-check does not stand
 * next to it as a case of its own but **inside** the same one.
 *
 * @param open brings the view into the state in which it moves.
 */
async function expectMotionOnlyWithoutReduce(
  page: Page,
  open: () => Promise<void>,
  where: string,
): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await open();

  const before = await movingBoxes(page);
  expect(
    before.length,
    `${where}: ohne die Abfrage bewegt sich hier nichts. Dann ist die Messung ` +
      'darunter eine Tautologie und belegt die Abschaltung nicht — sie ' +
      'müsste an eine Ansicht ziehen, auf der es Bewegung gibt.',
  ).toBeGreaterThan(0);

  /*
    **The query is set expressly and then measured afterwards.**

    `test.use({ reducedMotion: 'reduce' })` alone was not enough: the check
    below reported `false` on 2026-08-10, so the page was running in full
    motion — and without this check the case would nevertheless have been called „mit reduce
    bewegt sich nichts". Green for the wrong reason, exactly the sort of
    assurance rule 1 of this check is written against.
  */
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await open();

  const applied = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    applied,
    `${where}: die Medienabfrage ist im Browser nicht gesetzt; dieser Fall ` +
      'misst dann die gewöhnliche Darstellung.',
  ).toBe(true);

  const after = await movingBoxes(page);
  expect(
    after.length,
    `${where}: diese Boxen bewegen sich trotz „reduce": ${describe(after)}. ` +
      'Die Abschaltung in `apps/web/src/styles/base.css` deckt sie nicht — ' +
      'entweder fehlt ihr `!important`, oder die Regel steht hinter einem ' +
      'spezifischeren Selektor. Ohne die Abfrage waren es ' +
      `${String(before.length)} Boxen: ${describe(before)}.`,
  ).toBe(0);
}

test.describe('Bewegung ist abschaltbar ', () => {
  /**
   * **The off-canvas sheet at 360 px** — the view with the most conspicuous
   * motion of this application: the sheet slides in with `fs-pop`
   * (`mobile-menu-sheet.css`), and the switches cross-fade with
   * `--motion-fast` (`switch.css`).
   */
  test.use({ viewport: { width: 360, height: 740 } });

  test('das Off-Canvas-Sheet fährt mit „reduce" nicht mehr herein', async ({
    page,
  }) => {
    await expectMotionOnlyWithoutReduce(
      page,
      async () => {
        await page.getByRole('button', { name: 'Menü öffnen' }).click();
        await expect(page.getByRole('dialog', { name: 'Menü' })).toBeVisible();
      },
      'Off-Canvas-Sheet (360 px)',
    );
  });
});

test.describe('Bewegung ist abschaltbar, im Breitbild ', () => {
  /**
   * **And the same question on the desktop**, because a switch-off that takes
   * hold at only one width is none.
   *
   * What is opened is the **Organisations-Auswahl**, and that is no arbitrary choice: the
   * resting dashboard moves nothing at all — measured on 2026-08-10, zero boxes
   * without the query —, and a case over a motionless view would have reported „mit
   * reduce bewegt sich nichts" without ever having switched anything off.
   * That is exactly what the counter-check in {@link expectMotionOnlyWithoutReduce}
   * guards against, and it did so here. The header's drop-down menu slides in with `fs-pop`
   * (`app-header.css`) — that is the motion of this width.
   */
  test('das Klappmenü der Kopfzeile fährt mit „reduce" nicht mehr herein', async ({
    page,
  }) => {
    await expectMotionOnlyWithoutReduce(
      page,
      async () => {
        await expect(
          page.getByRole('heading', { name: 'Dashboard', level: 1 }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: /Organisations-Auswahl/u })
          .click();
      },
      'Klappmenü der Kopfzeile (1280 px)',
    );
  });
});

declare const window: {
  matchMedia: (query: string) => { readonly matches: boolean };
};
