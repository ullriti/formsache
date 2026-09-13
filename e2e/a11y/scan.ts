import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * The mechanical checker itself.
 *
 * **Why axe-core and not hand-written rules.** What is needed is a
 * checker „der über jede Ansicht läuft" — a list of
 * hand-written assertions („this button has a label") would again be
 * the hand-maintained list that forgets exactly what is new. axe-core is
 * the one dependency of this package; it does not stand in the pnpm
 * `catalog:`, because it is in use at exactly one place (`CONTRIBUTING.md`).
 */

/**
 * The rule sets that are checked against.
 *
 * WCAG 2.0/2.1 at levels A and AA — that is the standard that applies here for
 * accessibility. **Not** `best-practice`: its rules
 * are recommendations without a normative basis (for instance „every page has
 * exactly one `<h1>`"), and a gate that goes red on a recommendation is sooner
 * or later switched off instead of followed. What is missing here is missing
 * deliberately and is named.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/**
 * The levels that make the gate go red.
 *
 * The rule for this gate, verbatim: „null Verstöße der Stufen *serious* und
 * *critical* als Gate". `moderate` and `minor` are measured along and
 * printed out in the failure case, but they do not stop the run — otherwise
 * axe's opinion about nuances of contrast would decide whether this
 * project can ship.
 */
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

export interface A11yViolation {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  /** The affected elements, as a CSS path — so that the finding is findable. */
  readonly targets: readonly string[];
}

export interface A11yResult {
  /** All violations, the non-blocking ones included. */
  readonly all: readonly A11yViolation[];
  /** Only *serious* and *critical* — what the gate hangs on. */
  readonly blocking: readonly A11yViolation[];
  /**
   * How many rules were checked at all and found something they
   * could judge.
   *
   * That is the answer to „der Prüfer lief über nichts": a view with
   * zero violations **and** zero passed rules is one axe has not really
   * seen — an empty `<body>` passes every check.
   */
  readonly passes: number;
}

/**
 * Runs axe over the whole page and sorts the findings by severity.
 *
 * ⚠️ **`analyze()` hangs on two views when the preparation creates a
 * notification.** This application has two `SandboxedHtmlFrame`
 * (notification preview and detail window of the mail log), both
 * `sandbox` without `allow-scripts` — and axe does descend into
 * `<iframe>`s of its own accord, but as soon as the preparation creates a
 * notification, `analyze()` runs, in both widths, on the view
 * „Benachrichtigungen" and on the dialog „E-Mail ansehen", into the timeout
 * after 30 seconds instead of booking the frame as `incomplete`.
 *
 * It is thus a finding about the **construction** of the checker and not an
 * accessibility defect of the view — the treatment is the exclusion
 * below.
 *
 * ⚠️ **The exclusion takes the frame node itself out as well, not only
 * its content.** Measured on the real path — `title` removed from
 * `SandboxedHtmlFrame.tsx`, `pnpm e2e --grep
 * "Benachrichtigungen|E-Mail ansehen"` → **green**, although `frame-title` is
 * a *serious* rule and both views show such a frame.
 *
 * **Two things** thereby remain unchecked: the content of a rendered mail
 * (text without controls — bearable) and the frame rules `frame-title` and
 * `frame-tested`. For those there is a substitute on the component itself
 * (`apps/web/src/views/SandboxedHtmlFrame.test.tsx`), so that the promise
 * hangs on evidence instead of on this comment.
 */
export async function scan(page: Page): Promise<A11yResult> {
  const results = await new AxeBuilder({ page })
    .withTags([...TAGS])
    .exclude('iframe[sandbox]')
    .analyze();

  const all = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target.map(String)),
  }));

  return {
    all,
    blocking: all.filter((violation) => BLOCKING_IMPACTS.has(violation.impact)),
    passes: results.passes.length,
  };
}

/** One finding in one line, so that the report is readable without a trace. */
export function describeViolation(violation: A11yViolation): string {
  return (
    `  [${violation.impact}] ${violation.id}: ${violation.help}\n` +
    violation.targets.map((target) => `      → ${target}`).join('\n')
  );
}

/**
 * The gate: zero violations of the levels *serious* and *critical*.
 *
 * Checks **two** things, and the second is the reason why this function
 * exists instead of a bare `expect(violations).toStrictEqual([])`: that
 * axe saw the view at all. Without the second assertion „null
 * Verstöße" cannot be told apart from „der Prüfer lief über nichts" — that is
 * verbatim the sentence this gate rests on.
 */
export async function expectNoSeriousViolations(
  page: Page,
  viewName: string,
): Promise<A11yResult> {
  const result = await scan(page);

  expect(
    result.passes,
    `axe hat in „${viewName}" keine einzige Regel bestanden gemeldet. Das ` +
      'heißt nicht „sauber", das heißt „nichts gesehen" — vermutlich wurde ' +
      'die Ansicht vor dem Rendern gemessen oder die Adresse führt ins Leere.',
  ).toBeGreaterThan(0);

  expect(
    result.blocking.map(describeViolation).join('\n'),
    `Barrierefreiheit in „${viewName}" (Stufen serious/critical, ` +
      `${String(result.all.length)} Verstöße insgesamt, ` +
      `${String(result.passes)} Regeln bestanden)`,
  ).toBe('');

  return result;
}
