import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  addQuestion,
  newForm,
  publishAndReadPath,
  saveForm,
} from './app-flows';
import { authStateFile, tenantAdminStateFile } from './seed-account';

/**
 * **Contrasts on the rendered result, not on the token** .
 *
 * What is measured is what the browser really paints: `getComputedStyle`
 * delivers foreground and background colour, this file computes the WCAG ratio
 * from that — for the colours of **two differently branded organisations**,
 * because the branding sets the colours at run time.
 *
 * ## Why that is not the same as `apps/web/src/styles/tokens.test.ts`
 *
 * This file and that one measure two different things, and both are needed:
 *
 * - `tokens.test.ts` reads the **token file** and computes the pairs that stand
 *   there. That proves: *the default values of the application are in order.*
 *   By construction it can say nothing about an organisation colour — that
 *   stands in the database, not in `tokens.css` — and nothing about whether the
 *   tokens **arrive** at all when rendering.
 * - This file reads the **screen**. It proves: *what is painted in the end is
 *   readable* — including every cascade, every inheritance and every run-time
 *   variable that can go wrong in between.
 *
 * Exactly this gap is reproduced here: „eine Token-Datei
 * prüfen statt des Browsers → der Test wird grün, während der Bildschirm falsch
 * ist. **Das ist keine Hypothese:** das Organisation-Branding hat nie gewirkt,
 * durch 2500 grüne Tests hindurch."
 *
 * ## Why the background is searched for and not read
 *
 * `getComputedStyle(el).backgroundColor` of a button is often
 * `rgba(0, 0, 0, 0)` — transparent —, and the filled accent button of this
 * application carries its colour as a **gradient** (`--gradient-accent`), so
 * not in this property at all. A test that computes `backgroundColor` against
 * `color` measures "text against transparent" there and arrives at a fantastic
 * ratio while the button is unreadable.
 *
 * {@link readPainted} therefore goes the way a real contrast checker goes: it
 * collects **every** colour that really lies under the text — both ends of the
 * gradient included — and the case computes against the **worst** of them. That
 * is the difference the finding of `fe6ec79` hangs on: a filled button is never
 * *one* colour.
 */

test.describe.configure({ mode: 'default' });

/** WCAG 2.1 AA for body text. */
const AA_TEXT = 4.5;
/** WCAG 2.1 AA for large text from 18,66 px bold or 24 px. */
const AA_LARGE = 3;

/* --- what the browser really paints -------------------------------------- */

/** Only the members the `evaluate` callback below uses. */
interface PaintedElement {
  readonly parentElement: PaintedElement | null;
  readonly tagName: string;
  readonly className: unknown;
}

declare const getComputedStyle: (element: PaintedElement) => {
  readonly color: string;
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly fontSize: string;
  readonly fontWeight: string;
};

interface Painted {
  /** The text colour, as `rgb(…)`/`rgba(…)`. */
  readonly color: string;
  /**
   * Every colour that lies under the text — from its own box upwards to the
   * first opaque one. A gradient contributes **all** of its stops.
   */
  readonly backgrounds: readonly string[];
  readonly fontSizePx: number;
  readonly fontWeight: number;
  /** For the error message: which element was measured. */
  readonly element: string;
}

/**
 * Reads text and background colours of an element, the way they are painted.
 *
 * Walks up the parent chain until an **opaque** background colour is found;
 * everything above that lies behind something non-transparent and no longer
 * counts. Semi-transparent layers and gradients on the way are taken along,
 * because the text stands on them as well.
 */
async function readPainted(page: Page, selector: string): Promise<Painted> {
  const target = page.locator(selector).first();
  await expect(
    target,
    `${selector}: das Element muss auf der Seite stehen, sonst misst diese ` +
      'Zusicherung nichts.',
  ).toBeVisible();

  return target.evaluate((element: PaintedElement): Painted => {
    const own = getComputedStyle(element);
    const backgrounds: string[] = [];

    const name = (node: PaintedElement): string =>
      `${node.tagName.toLowerCase()}${
        typeof node.className === 'string' && node.className !== ''
          ? `.${node.className.trim().split(/\s+/u).join('.')}`
          : ''
      }`;

    /*
      **How the browser delivers a colour is not one spelling but three** —
      measured on 2026-08-10 on exactly this button:

          linear-gradient(rgb(227, 0, 0), color(srgb 0.694353 0 0))

      The dark end of a `color-mix(in srgb, …)` comes back as
      `color(srgb …)`, not as `rgb(…)`. A pattern that only knows `rgb`
      overlooks it **silently** — and thereby overlooks precisely the end at
      which a filled button first becomes unreadable. Both spellings are
      therefore collected, and {@link channels} understands both.
    */
    const COLOR_PATTERN = /(rgba?\([^)]*\)|color\(\s*srgb[^)]*\))/gu;

    let node: PaintedElement | null = element;
    while (node !== null) {
      const style = getComputedStyle(node);

      // A gradient stands in `background-image` and is invisible in
      // `backgroundColor` (there it then reads `rgba(0, 0, 0, 0)`).
      const gradient = style.backgroundImage.includes('gradient(');
      if (gradient) {
        for (const found of style.backgroundImage.matchAll(COLOR_PATTERN)) {
          backgrounds.push(found[0]);
        }
      }

      const alpha = /rgba\([^)]*?,\s*([\d.]+)\s*\)/u.exec(
        style.backgroundColor,
      )?.[1];
      const opacity = alpha === undefined ? 1 : Number(alpha);
      if (opacity > 0) {
        backgrounds.push(style.backgroundColor);
      }

      /*
        **An opaque gradient ends the search just as an opaque colour does.**
        Without this line the ascent ran past the filled button up to the white
        card behind it and reported "text white on white, 1:1" — a background
        that **nobody sees** at this place, because the gradient covers it
        completely. Measured on 2026-08-10; the first version of this case fell
        through on it.

        `transparent` in the gradient cancels that: then what lies underneath
        really does shine through, and the ascent has to keep running.
      */
      const gradientIsOpaque =
        gradient &&
        !style.backgroundImage.includes('transparent') &&
        !/rgba\([^)]*?,\s*0?\.\d+\s*\)/u.test(style.backgroundImage) &&
        !/rgba\([^)]*?,\s*0\s*\)/u.test(style.backgroundImage);

      if (opacity >= 1 || gradientIsOpaque) {
        break;
      }
      node = node.parentElement;
    }

    return {
      color: own.color,
      backgrounds,
      fontSizePx: Number.parseFloat(own.fontSize),
      fontWeight: Number(own.fontWeight),
      element: name(element),
    };
  });
}

/* --- WCAG arithmetic ----------------------------------------------------- */

/**
 * The two spellings in which this browser delivers colours, onto channels
 * 0…255.
 *
 * `rgb(227, 0, 0)` **and** `color(srgb 0.694353 0 0)` — the second one comes
 * out of every resolved `color-mix(in srgb, …)` and carries fractions 0…1
 * instead of 0…255. A parser that only knows the first does **not** silently
 * throw away here, but runs into the error below: an overlooked colour is one
 * measurement fewer, and that one is missing exactly where it matters most.
 */
function channels(color: string): readonly [number, number, number] {
  const srgb = /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/u.exec(color);
  if (srgb !== null) {
    return [
      Number(srgb[1]) * 255,
      Number(srgb[2]) * 255,
      Number(srgb[3]) * 255,
    ];
  }

  const parts = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(color);
  if (parts === null) {
    throw new Error(
      `„${color}" ist keine Farbe, die diese Messung lesen kann. Der ` +
        'Browser liefert aufgelöste Farben als `rgb(…)`, `rgba(…)` oder ' +
        '`color(srgb …)`; kommt eine vierte Schreibweise dazu, gehört sie ' +
        'hierher — sie stillschweigend zu überspringen hieße, eine Fläche ' +
        'ungemessen zu lassen.',
    );
  }
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Relative luminance per WCAG 2.x. */
function luminance(color: string): number {
  const [red, green, blue] = channels(color).map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as unknown as readonly [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Contrast ratio of two colours, per WCAG 2.x. */
function contrast(a: string, b: string): number {
  const [dark = 0, light = 0] = [luminance(a), luminance(b)].sort(
    (x, y) => x - y,
  );
  return (light + 0.05) / (dark + 0.05);
}

/** Rounded to two decimal places. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Asserts: the text is readable on **every** background that lies under it.
 *
 * The message names colour, background and ratio — a failure that only says
 * "too little contrast" forces measuring by hand.
 */
function expectReadable(
  painted: Painted,
  where: string,
  minimum: number,
): void {
  expect(
    painted.backgrounds.length,
    `${where} (${painted.element}): unter der Schrift wurde keine einzige ` +
      'Hintergrundfarbe gefunden. Dann misst diese Zusicherung nichts — ' +
      'wahrscheinlich ist die Elternkette bis zum Wurzelelement durchsichtig.',
  ).toBeGreaterThan(0);

  const measured = painted.backgrounds.map((background) => ({
    background,
    ratio: round(contrast(painted.color, background)),
  }));
  const worst = measured.reduce((left, right) =>
    left.ratio <= right.ratio ? left : right,
  );

  expect(
    worst.ratio,
    `${where}: Schrift ${painted.color} auf ${worst.background} misst ` +
      `${String(worst.ratio)}:1, gefordert sind ${String(minimum)}:1. ` +
      `Alle gemessenen Hintergründe: ${measured
        .map((entry) => `${entry.background} → ${String(entry.ratio)}:1`)
        .join(', ')}. Gemessen am gerenderten Ergebnis, nicht an einem Token.`,
  ).toBeGreaterThanOrEqual(minimum);
}

/* --- the two organisations ----------------------------------------------- */

/**
 * The two organisations of the seed — differently branded, and that is what
 * this is about.
 *
 * The colours stand here **not** as an expectation but as a description: what
 * is measured is what the browser paints, and the assertion below additionally
 * checks that the two pages really do carry **different** accent colours.
 * Without this counter-check the whole effort with two sessions would be for
 * nothing: measuring two pages in the same colour is one measurement, not two.
 */
const SEEDED_TENANTS = [
  {
    name: 'Dachorganisation (Gold)',
    state: authStateFile,
    /** `apps/api/prisma/seed.ts` — for orientation, not as an expectation. */
    seededAccent: '#cea967',
  },
  {
    name: 'Ortsgruppe Musterstadt (Rot)',
    state: tenantAdminStateFile,
    seededAccent: '#e30000',
  },
] as const;

interface Branded {
  readonly name: string;
  readonly publicPath: string;
  readonly formId: string | undefined;
  readonly state: string;
}

const branded: Branded[] = [];

/**
 * Builds one published form under each of the two organisations.
 *
 * **Two sessions, not one organisation and a tenant switch:** a switch through
 * `PUT /api/session/tenant` writes the *shared* session row that every other
 * spec of this run uses along with it (see `playwright.config.ts` on
 * `durchlauf-organisationen`). The second parked session from `auth.setup.ts`
 * belongs to the `admin` of Musterstadt and is there for exactly such cases.
 */
test.beforeAll(async ({ browser }) => {
  for (const tenant of SEEDED_TENANTS) {
    const context = await browser.newContext({
      storageState: tenant.state,
    });
    const page = await context.newPage();
    try {
      await newForm(page, `Kontrast ${tenant.name}`);
      const formId = /\/forms\/([^/?#]+)/u.exec(page.url())?.[1];
      await addQuestion(page, 'Text', 'Name des Mitglieds');
      await saveForm(page);
      const publicPath = await publishAndReadPath(page);
      branded.push({
        name: tenant.name,
        publicPath,
        formId,
        state: tenant.state,
      });
    } finally {
      await context.close();
    }
  }
});

test.afterAll(async ({ browser }) => {
  for (const entry of branded) {
    const context = await browser.newContext({ storageState: entry.state });
    const page = await context.newPage();
    try {
      if (entry.formId !== undefined) {
        await page.request.delete(`/api/forms/${entry.formId}`);
        await page.request.delete(`/api/forms/${entry.formId}/permanent`);
      }
    } finally {
      await context.close();
    }
  }
});

/** Opens a public fill-in address — without a session, like a participant. */
async function openPublic(
  browser: Browser,
  publicPath: string,
): Promise<{ readonly page: Page; readonly close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(publicPath);
  await page.evaluate(async () => {
    // Fonts first, then measure: a fallback font has different weights, and
    // the threshold hangs off `font-weight` (large text may be 3:1).
    await document.fonts.ready;
  });
  return {
    page,
    close: async () => {
      await context.close();
    },
  };
}

declare const document: {
  readonly fonts: { readonly ready: Promise<unknown> };
};

/* --- the measurements ---------------------------------------------------- */

test.describe('Gerenderte Kontraste je Organisation', () => {
  /**
   * **The counter-check first**: the two pages really do carry different
   * colours.
   *
   * That is the case that would have found the finding. A branding that does
   * not take effect makes **both** pages the same — and every contrast
   * measurement below would stay green, because it then measures the default
   * colour twice. Only this line turns "two organisations measured" into a
   * statement.
   */
  test('die zwei Organisationen zeichnen wirklich zwei verschiedene Akzentfarben', async ({
    browser,
  }) => {
    expect(branded.length, 'beide Formulare stehen').toBe(2);

    const accents: string[] = [];
    for (const entry of branded) {
      const opened = await openPublic(browser, entry.publicPath);
      try {
        const painted = await readPainted(opened.page, '.public__primary');
        // The filled button carries the organisation colour as a gradient;
        // its first stop **is** `--color-accent`.
        expect(
          painted.backgrounds.length,
          `${entry.name}: der Absenden-Knopf muss einen gezeichneten ` +
            'Hintergrund haben.',
        ).toBeGreaterThan(0);
        accents.push(painted.backgrounds[0] ?? '');
      } finally {
        await opened.close();
      }
    }

    const [first, second] = accents;
    expect(
      first,
      'Beide Organisationen zeichnen dieselbe Akzentfarbe. Entweder wirkt das ' +
        'Organisation-Branding nicht (genau der Befund, den dieser Fall ausdrücklich ' +
        'prüft), oder beide Formulare wurden unter derselben Organisation gebaut — ' +
        'in beiden Fällen misst alles darunter zweimal dasselbe.',
    ).not.toBe(second);
  });

  for (const index of [0, 1] as const) {
    /**
     * **The actual measurement**, per organisation.
     *
     * Three surfaces, because an organisation sets three colours and the text
     * has to stand on all three of them:
     *
     * 1. the **filled accent button** — the surface `fe6ec79` hangs on. Its
     *    gradient has two ends, and it is computed against the worse one;
     *    "readable at the top, not at the bottom" is the case a measurement
     *    against a single colour overlooks.
     * 2. the **name of the organisation** in the header — text on
     *    `--tenant-header-bg`.
     * 3. the **question text** on the card — text over `--tenant-canvas-bg`.
     */
    test(`${SEEDED_TENANTS[index].name}: Schrift auf den Organisationsfarben ist lesbar`, async ({
      browser,
    }) => {
      const entry = branded[index];
      expect(entry, 'das Formular dieser Organisation steht').toBeDefined();
      if (entry === undefined) {
        return;
      }

      const opened = await openPublic(browser, entry.publicPath);
      try {
        const button = await readPainted(opened.page, '.public__primary');
        /*
          **Bold button text from 18,66 px may be 3:1** (WCAG 1.4.3, „large
          text"). Which threshold applies is therefore **measured** and not
          assumed: an assertion that demands 3:1 across the board would be too
          mild for a button with small text, and one with 4.5:1 across the
          board would demand a colour of the handoff that it did not choose.
        */
        const large =
          button.fontSizePx >= 24 ||
          (button.fontSizePx >= 18.66 && button.fontWeight >= 700);
        expectReadable(
          button,
          `${entry.name}: „Absenden" — Schrift auf dem Akzentverlauf ` +
            `(${String(button.fontSizePx)} px, Gewicht ` +
            `${String(button.fontWeight)})`,
          large ? AA_LARGE : AA_TEXT,
        );

        const tenantName = await readPainted(opened.page, '.public__tenant');
        expectReadable(
          tenantName,
          `${entry.name}: Name der Organisation im Kopf`,
          AA_TEXT,
        );

        const label = await readPainted(opened.page, '.field__label');
        expectReadable(
          label,
          `${entry.name}: Fragetext auf der Karte`,
          AA_TEXT,
        );
      } finally {
        await opened.close();
      }
    });

    /**
     * **The same organisation colour, signed in.**
     *
     * `AppShell` sets up `tenantThemeStyle` just like the public view, so the
     * filled button of the dashboard carries the colour of the organisation —
     * only here an editor sees it instead of a participant.
     *
     * It stands next to it as a case of its **own**, because the public view
     * and the signed-in area are two different ways to the same token: a
     * `data-tenant-theme` that is missing in one of the two is exactly the
     * finding — and it would be invisible with only one of the two
     * measurements.
     */
    test(`${SEEDED_TENANTS[index].name}: der gefüllte Knopf im angemeldeten Bereich ist lesbar`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        storageState: SEEDED_TENANTS[index].state,
      });
      const page = await context.newPage();
      try {
        await page.goto('/');
        await expect(
          page.getByRole('heading', { name: 'Dashboard', level: 1 }),
        ).toBeVisible();

        const create = await readPainted(page, '.dashboard__create-button');
        const large =
          create.fontSizePx >= 24 ||
          (create.fontSizePx >= 18.66 && create.fontWeight >= 700);
        expectReadable(
          create,
          `${SEEDED_TENANTS[index].name}: „+ Neues Formular" auf dem Akzentverlauf`,
          large ? AA_LARGE : AA_TEXT,
        );
      } finally {
        await context.close();
      }
    });
  }
});
