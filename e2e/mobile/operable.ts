import { expect, type Page } from '@playwright/test';

/**
 * **Does the point in the middle of a control belong to the control itself?**
 * (second measurement.)
 *
 * The first of these two measurements — `scrollWidth <= clientWidth` on the
 * document — has been around for a long time: `expectNoHorizontalScroll` in
 * `app-flows.ts` runs it and two more. This file carries the second one, and it
 * exists because of a bug that this application really did build:
 * `styles/switch.css` explains it itself — `.switch__knob` lay on top of the
 * transparent `<input>` that covers the whole switch, and turned "the middle 18
 * of 42 px, exactly the spot everyone aims at" into a dead zone. **No test went
 * red from it.** The mobile cases called `setChecked`, which does not click at
 * all when the value is already right, and jsdom knows nothing about covering.
 *
 * What is measured is therefore exactly what a finger does: `elementFromPoint`
 * on the element's centre point. If something other than the element itself (or
 * one of its children) is hit there, the control is not reachable — no matter
 * how good it looks.
 *
 * ## What is deliberately *not* checked
 *
 * - **Only the centre point**, not the whole area. That is a deliberate decision,
 *   and a full-area check would be a source of findings without a bug where
 *   borders overlap (focus rings, `outline-offset`).
 * - **Disabled controls**: what cannot be operated cannot be covered either.
 *   `disabled` and `aria-disabled="true"` drop out.
 * - **Everything outside an open modal.** If a `role="dialog"` with
 *   `aria-modal="true"` is open, the rest of the page is deliberately unreachable
 *   — the scrim *is meant* to lie there. What is checked then is what is in the
 *   dialog.
 */

/** A finding: a control whose centre belongs to someone else. */
export interface CoveredControl {
  /** The control, named in test language. */
  readonly control: string;
  /** What actually lies at its centre point. */
  readonly covering: string;
  readonly x: number;
  readonly y: number;
}

/** Result of one run — the findings and the number of elements checked. */
export interface ControlProbe {
  readonly checked: number;
  readonly covered: readonly CoveredControl[];
  /**
   * Findings where the covering element carries `position: sticky` (or lies
   * within something that does).
   *
   * **Its own list, because it is a different statement.** A decoration lies on
   * top of a control because someone stacked the layers wrongly; a sticky column
   * lies on top of it because it *is meant* to stay put while the rest scrolls
   * away. The one is a bug in the stack, the other a layout decision whose price
   * becomes visible at 360 px — and throwing both into the same pot would mean
   * either playing down the one or reporting the other as a bug.
   */
  readonly stickyShadowed: readonly CoveredControl[];
  /**
   * Elements that did not come into view even after `scrollIntoView`. Its own
   * list instead of a finding: this is not a covering, but an element about
   * which this measurement can say nothing — and staying silent about it would
   * be the same "the checker ran over nothing" against which the axe run has its
   * counter-check.
   */
  readonly unreachable: readonly string[];
}

/**
 * The browser members that the `page.evaluate` callback uses.
 *
 * The root `tsconfig.json` above `e2e/` deliberately has no DOM lib
 * (`lib: ["ES2023"]`, `types: ["node"]`); `app-flows.ts` gives the reason and
 * for the same reason declares only what it uses. Ambient and module-wide — at
 * runtime the callback runs in the real browser.
 */
interface ProbeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface ProbeElement {
  readonly tagName: string;
  readonly id: string;
  readonly className: string;
  readonly textContent: string | null;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => ProbeRect;
  getClientRects: () => Iterable<ProbeRect>;
  /**
   * **Is this element rendered at all?**
   *
   * `getBoundingClientRect().width === 0` was the answer to that until
   * 2026-08-18, and it was a substitute: "has no area" is *mostly* the same as
   * "is not there". For a closed `<details>` it is not.
   *
   * *Measured* on the preview of the legal-text editor (`<details
   * class="legal-editor__preview">`, closed): Chromium **lays out** the content
   * of a closed `<details>` — for the open and close animation — but does not
   * render it. The link „veröffentlichte Seite" inside it reported
   * `116,6×14 @ 116, 2727,5` and **one** fragment, while
   * `checkVisibility()` said `false` on the same element. The probe took the
   * phantom box at face value, scrolled it into view and found there —
   * rightly — the card that actually stands at that spot.
   * Three dead zones were reported on a link that nobody can see.
   *
   * This question answers all the cases at once: `display: none`,
   * `visibility: hidden`, `content-visibility` and the closed
   * `<details>`. The zero-size check stays next to it — it is
   * cheaper and names a different case (laid out, but empty).
   *
   * ⚠️ **Opacity does not count**, and that is the browser's default,
   * which is deliberately not overridden here: `checkVisibility()` checks
   * `opacity: 0` only with `{ opacityProperty: true }`. A transparent
   * control is invisible *and* operable — a dead zone on top of it
   * would be a finding, not a nothing.
   *
   * *Reproduction:* remove the two calls → the two
   * legal-text tabs each report three findings on „veröffentlichte Seite".
   */
  checkVisibility: () => boolean;
  scrollIntoView: (options: {
    readonly block: string;
    readonly inline: string;
  }) => void;
  contains: (other: ProbeElement | null) => boolean;
  closest: (selector: string) => ProbeElement | null;
  matches: (selector: string) => boolean;
  readonly parentElement: ProbeElement | null;
}
declare const document: {
  querySelectorAll: (selector: string) => Iterable<ProbeElement>;
  querySelector: (selector: string) => ProbeElement | null;
  elementFromPoint: (x: number, y: number) => ProbeElement | null;
  readonly fonts: { readonly ready: Promise<unknown> };
};
declare const window: {
  readonly innerWidth: number;
  readonly innerHeight: number;
};
declare const getComputedStyle: (element: ProbeElement) => {
  readonly position: string;
  readonly display: string;
};

/**
 * What counts as "operable".
 *
 * The built-in roles plus the ones this application assigns by hand.
 * `[tabindex]` without `-1` is included because an element that is in the tab
 * order must also be reachable with a finger; `tabindex="-1"`, by contrast, is
 * the application's pattern for "focusable only by script" (the heading, the
 * line „Seite n von m") and not a control.
 */
const OPERABLE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Runs the measurement and returns what it found.
 *
 * Separate from {@link expectNoControlCovered}, because the counter-check
 * *needs* the findings: it lays a decoration over a switch
 * and shows that something is there — an assertion that only knows "green or
 * red" could not demonstrate that.
 */
export async function probeControls(page: Page): Promise<ControlProbe> {
  // Fonts first: before `document.fonts.ready` every box centre is that
  // of a fallback face, and the measurement would check a layout state that
  // nobody gets to see. The same order as in
  // `expectNoHorizontalScroll`.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  return page.evaluate((selector: string): ControlProbe => {
    /** Short name of an element for the error message. */
    const describe = (element: ProbeElement | null): string => {
      if (element === null) {
        return '(nichts)';
      }
      const tag = element.tagName.toLowerCase();
      const id = element.id === '' ? '' : `#${element.id}`;
      // `?? ''` because of `noUncheckedIndexedAccess`: `split` never returns an
      // empty array, but the type does not know that.
      const classes =
        element.className === ''
          ? ''
          : `.${element.className.split(/\s+/u)[0] ?? ''}`;
      const role = element.getAttribute('role');
      const label =
        element.getAttribute('aria-label') ??
        (element.textContent ?? '').trim().slice(0, 40);
      const named = label === '' ? '' : ` „${label}"`;
      return `${tag}${id}${classes}${role === null ? '' : `[role=${role}]`}${named}`;
    };

    /*
      If a modal is open, the rest of the page is deliberately unreachable.
      The last one in the document wins: the application opens dialogs on top of
      dialogs (off-canvas sheet → AI dialog), and the one mounted last is
      the topmost.
    */
    const modals = [
      ...document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
    ];
    // `?? null` instead of an index check: `noUncheckedIndexedAccess` turns
    // every access into a `| undefined`, and "no modal open" and "the access
    // missed" are the same statement here — what is checked is the whole page.
    const scope = modals[modals.length - 1] ?? null;

    /** Does the element or one of its ancestors carry `position: sticky`? */
    const sticksSomewhere = (element: ProbeElement | null): boolean => {
      let node = element;
      while (node !== null) {
        if (getComputedStyle(node).position === 'sticky') {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const covered: CoveredControl[] = [];
    const stickyShadowed: CoveredControl[] = [];
    const unreachable: string[] = [];
    let checked = 0;

    for (const element of document.querySelectorAll(selector)) {
      if (scope !== null && !scope.contains(element)) {
        continue;
      }
      if (
        element.matches(
          '[disabled], [aria-disabled="true"], [aria-hidden="true"]',
        ) ||
        element.closest('[aria-hidden="true"], [inert]') !== null
      ) {
        continue;
      }

      // See `ProbeElement.checkVisibility`: the phantom box of a closed
      // `<details>` is not a control in the layout.
      if (!element.checkVisibility()) {
        continue;
      }
      const rect0 = element.getBoundingClientRect();
      if (rect0.width === 0 || rect0.height === 0) {
        // Laid out, but without an area — there is nothing to hit.
        continue;
      }

      /**
       * Does the element own its centre point in the **current** position?
       * `null` as long as the point does not lie in the viewport at all.
       */
      const owner = ():
        | { readonly finding: CoveredControl; readonly sticky: boolean }
        | null
        | undefined => {
        /*
          **Per line fragment, not on the union** — and the reason is
          measured.

          For an inline element that wraps, `getBoundingClientRect` returns
          the *union* of its line boxes, and its centre then lies
          between the lines. The link „Lizenzen und Urheberrecht" on the
          public imprint stood in three fragments on 2026-08-18
          (59,2×16 · 4,3×16 · 119,1×16); the union measured 266,7×36,3, and
          its centre (174,3 / 432,3) fell into the gap between line 1 and
          line 2. `elementFromPoint` returned the paragraph there — and the
          measurement reported a dead zone on a link that every finger
          hits.

          `getClientRects()` gives exactly these fragments. What is checked is
          the centre of **every** fragment; if the element owns one of them, it
          is reachable. For everything that does not wrap — every button, every
          field, every switch — the list has a single entry and is identical
          with the box: nothing changes about their measurement, and the
          counter-check in `mobile-reachable.spec.ts` stays red, because a
          decoration over the switch covers its only fragment too.

          *Reproduction:* switch back to `getBoundingClientRect` → the
          public imprint case goes red again, with the paragraph as
          "covering".
        */
        const fragments = [...element.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        );
        // No fragment in the viewport means: about this position the
        // measurement says nothing — the same `undefined` as before, so that
        // `scrollIntoView` tries the next position.
        let outside = true;
        let miss: {
          readonly finding: CoveredControl;
          readonly sticky: boolean;
        } | null = null;
        for (const rect of fragments) {
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          if (
            x < 0 ||
            y < 0 ||
            x >= window.innerWidth ||
            y >= window.innerHeight
          ) {
            continue;
          }
          outside = false;
          const hit = document.elementFromPoint(x, y);
          const ownsPoint =
            hit === element ||
            element.contains(hit) ||
            // A `<label>` that encloses the element forwards the click to
            // the control — so the point belongs to it after all.
            // Every *other* ancestor does not: there the pointer lands
            // on the ancestor, and that is exactly the dead zone.
            (hit !== null && hit.matches('label') && hit.contains(element));
          if (ownsPoint) {
            return null;
          }
          // The first miss is remembered, but not reported as long as
          // fragments are still open: it is only reported if **none** of them
          // belongs to the element.
          miss ??= {
            sticky: sticksSomewhere(hit),
            finding: {
              control: describe(element),
              covering: describe(hit),
              x: Math.round(x),
              y: Math.round(y),
            },
          };
        }
        if (outside || miss === null) {
          return undefined;
        }
        return miss;
      };

      /*
        **Four positions, not one** — and the reason is measured, not
        precautionary. An element that lies in a sideways-scrolling box
        has no *one* centre: it depends on how far the box has been
        scrolled. What is checked is therefore the position the element is in
        anyway, and three forced ones: centred, at the left and at the right edge.
        If it owns the point in **one** of them, it is reachable.

        A decoration on top of it answers the question with no at every
        position — the counter-check in `mobile-reachable.spec.ts` therefore
        pins its layer to the document coordinates of the switch and stays red
        across all four positions.
      */
      let seenInView = false;
      let ownsSomewhere = false;
      let finding: CoveredControl | null = null;
      let stickyFinding = false;

      for (const inline of ['keep', 'center', 'start', 'end']) {
        if (inline !== 'keep') {
          // `block: 'center'` keeps the element away from sticky headers and
          // footers: lying underneath them is a consequence of scrolling and
          // not a covering.
          element.scrollIntoView({ block: 'center', inline });
        }
        const verdict = owner();
        if (verdict === undefined) {
          continue;
        }
        seenInView = true;
        if (verdict === null) {
          ownsSomewhere = true;
          break;
        }
        finding = verdict.finding;
        stickyFinding = verdict.sticky;
      }

      if (!seenInView) {
        unreachable.push(describe(element));
        continue;
      }

      checked += 1;
      if (!ownsSomewhere && finding !== null) {
        (stickyFinding ? stickyShadowed : covered).push(finding);
      }
    }

    return { checked, covered, stickyShadowed, unreachable };
  }, OPERABLE_SELECTOR);
}

/** A control whose rendered box is smaller than the target. */
export interface SmallTarget {
  readonly control: string;
  readonly width: number;
  readonly height: number;
}

/**
 * **44 × 44 px — WCAG 2.5.5, and thus AAA** .
 *
 * The number stands here and not in a comment — the rule is: "the
 * number stands in the test, not in the comment".
 */
export const TOUCH_TARGET_PX = 44;

/**
 * **24 × 24 px — WCAG 2.5.8 "Target Size (Minimum)", and thus AA.**
 *
 * That is the level that was **decided** on 2026-08-06. It
 * stands next to the AAA number above, because that decision itself points out
 * that it lies above the target — and because a suite that only knows the
 * AAA number is either red or measures nothing at all.
 */
export const TOUCH_TARGET_MIN_PX = 24;

/**
 * Measures the **rendered** boxes of all operable elements and returns those
 * that stay below {@link TOUCH_TARGET_PX}.
 *
 * What is measured is `getBoundingClientRect`, not the declared size: padding,
 * line height and the font have a say, and that is exactly why this
 * measurement lives in the browser and not in a CSS test.
 */
export async function measureSmallTargets(
  page: Page,
  minimum: number = TOUCH_TARGET_PX,
): Promise<readonly SmallTarget[]> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  return page.evaluate(
    ({ selector, minimum }: { selector: string; minimum: number }) => {
      const describe = (element: ProbeElement): string => {
        const tag = element.tagName.toLowerCase();
        const classes =
          element.className === ''
            ? ''
            : `.${element.className.split(/\s+/u)[0] ?? ''}`;
        const label =
          element.getAttribute('aria-label') ??
          (element.textContent ?? '').trim().slice(0, 40);
        return `${tag}${classes}${label === '' ? '' : ` „${label}"`}`;
      };

      /**
       * The **inline exception** of WCAG 2.5.8 — as part of the assertion,
       * not as leniency.
       *
       * The success criterion whose name this measurement carries has five
       * explicit exceptions, and one of them reads literally: *"Inline: The
       * target is in a sentence or its size is otherwise constrained by the
       * line-height of non-target text."* A link in the middle of running text
       * is **conformant** by that, and not out of goodwill: its height is the
       * line height of the sentence it stands in. Blowing it up to 24 px
       * would tear the paragraph apart — the criterion does not demand that, it
       * takes this case out explicitly.
       *
       * **Why this only shows up now.** Until the legal texts (ADR-0028) this
       * application had no links in running text; every target was a
       * button, a field or a link in a list. The probe therefore got by
       * without the exception, and that it does not know it was until then
       * invisible. On 2026-08-18 it reported six names on the two
       * legal-text tabs — `a.legal-text__link „Datenschutzerklärung"`
       * 149,7×16 and five of the same build —, and the message said about them
       * „Es gehört vergrößert". That was the sentence of a state without
       * running text.
       *
       * **Narrowly drawn, so that no button slips through.** Both halves of
       * the exception are required: `display: inline` (not
       * `inline-block`/`inline-flex` — those carry their size themselves) **and**
       * neighbouring text in the same element, that is a sentence longer than
       * the label of the target. An `<a>` that stands alone in its paragraph
       * is thereby still a target with a size; a `role="button"` with
       * `display: inline` likewise, because its label *is* the whole
       * content.
       *
       * *Reproduction:* remove this exception → the six names stand
       * in the list again. Extend it instead to every `display: inline`
       * → a standalone link would drop out too, and the
       * measurement would lose the case it is built for.
       */
      const inlineInSentence = (element: ProbeElement): boolean => {
        if (getComputedStyle(element).display !== 'inline') {
          return false;
        }
        const parent = element.parentElement;
        if (parent === null) {
          return false;
        }
        const own = (element.textContent ?? '').trim();
        const sentence = (parent.textContent ?? '').trim();
        return own !== '' && sentence.length > own.length;
      };

      const seen = new Map<string, SmallTarget>();
      for (const element of document.querySelectorAll(selector)) {
        if (
          element.matches('[disabled], [aria-hidden="true"]') ||
          element.closest('[aria-hidden="true"], [inert]') !== null
        ) {
          continue;
        }
        // See `ProbeElement.checkVisibility`.
        if (!element.checkVisibility() || inlineInSentence(element)) {
          continue;
        }
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) {
          continue;
        }
        if (box.width >= minimum && box.height >= minimum) {
          continue;
        }
        const name = describe(element);
        // Grouped by name: twenty identically built row buttons are
        // **one** finding, not twenty — otherwise the number of
        // records decides how long the list is.
        if (!seen.has(name)) {
          // One decimal place, and it is not cosmetics: the handle of a
          // question card measures 23,5 px and stood in the list as "24×30" — a
          // line that seemed to say 24 was smaller than 24.
          seen.set(name, {
            control: name,
            width: Math.round(box.width * 10) / 10,
            height: Math.round(box.height * 10) / 10,
          });
        }
      }
      return [...seen.values()].sort((a, b) =>
        a.control < b.control ? -1 : a.control > b.control ? 1 : 0,
      );
    },
    { selector: OPERABLE_SELECTOR, minimum },
  );
}

export interface ControlExpectation {
  /**
   * How many operable elements the view has at minimum.
   *
   * Not decoration: a view in which the measurement finds *zero* elements would
   * be silently green — the same trap against which the axe run sets its count
   * against the router. Where the number comes out smaller than expected, the
   * view has not loaded.
   */
  readonly minimum?: number;
  /**
   * Controls that a **sticky** layer covers at every scroll
   * position — by name, as a known finding.
   *
   * Empty for every view but one. Whoever enters something here records a
   * finding instead of keeping quiet about it: the list is **exhaustive**, a
   * second such finding turns the assertion red.
   */
  readonly knownStickyShadow?: readonly string[];
}

/**
 * **Every operable element gets its own centre point.**
 */
export async function expectNoControlCovered(
  page: Page,
  where: string,
  expectation: ControlExpectation = {},
): Promise<void> {
  const minimum = expectation.minimum ?? 1;
  const known = expectation.knownStickyShadow ?? [];
  const probe = await probeControls(page);

  expect(
    probe.checked,
    `${where}: die Messung hat ${String(probe.checked)} bedienbare Elemente ` +
      `gefunden, erwartet waren mindestens ${String(minimum)}. Eine Ansicht ` +
      'ohne Bedienelemente ist keine geladene Ansicht — und eine Messung über ' +
      'nichts meldet grün.',
  ).toBeGreaterThanOrEqual(minimum);

  expect(
    probe.covered,
    `${where}: der Punkt in der Mitte dieser Bedienelemente gehört etwas ` +
      'anderem. Ein Finger, der dort tippt, trifft die genannte Ebene statt ' +
      'des Bedienelements — genau die tote Zone, die `styles/switch.css` ' +
      'einmal hatte. Bei Dekoration hilft `pointer-events: none`.',
  ).toStrictEqual([]);

  expect(
    probe.stickyShadowed.map((finding) => finding.control).sort(),
    `${where}: diese Bedienelemente liegen an **jeder** Scrollposition unter ` +
      'einer klebenden Ebene. Das ist kein falsch gestapelter Zierrat, sondern ' +
      'der Preis einer `position: sticky`-Spalte auf 360 px — und deshalb ein ' +
      'benannter Befund und keine stille Ausnahme.',
  ).toStrictEqual([...known].sort());

  expect(
    probe.unreachable,
    `${where}: diese Bedienelemente kamen auch nach \`scrollIntoView\` nicht ` +
      'ins Sichtfeld. Sie sind bei 360 px unerreichbar oder liegen außerhalb ' +
      'des Dokuments.',
  ).toStrictEqual([]);
}
