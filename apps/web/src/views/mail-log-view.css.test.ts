import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression test: the status column's
 * divider used to sit out of line with the other columns.
 *
 * `.mail-log__status-cell` is set on the `<td>` itself (`MailLogView.tsx`),
 * not on a wrapper inside it. The class used to declare
 * `display: flex; flex-direction: column`, which replaces a table cell's
 * mandated `display: table-cell` — a cell that stops being `table-cell` drops
 * out of the row's table layout, no longer stretches to the row's height like
 * its sibling `<td>`s, and its own `border-bottom` then sits at the bottom of
 * its own, differently sized content box instead of the row's shared
 * baseline. The fix leaves `display` unset on the cell and stacks its
 * children (chip, attempts, retry button) as plain block boxes instead.
 */
describe('mail-log-view.css › status cell', () => {
  const css = readFileSync(
    join(resolve(process.cwd(), 'src/views'), 'mail-log-view.css'),
    'utf8',
  );

  /** The declaration block of the *bare* `.mail-log__status-cell` rule, if any. */
  function bareStatusCellRule(): string | undefined {
    return /(?:^|[^-\w])\.mail-log__status-cell\s*\{([^}]*)\}/.exec(css)?.[1];
  }

  it('never sets display on the status cell (<td>) itself', () => {
    const body = bareStatusCellRule();
    // No bare rule at all is fine; a bare rule that touches `display` is the
    // regression this test exists to catch.
    expect(body?.includes('display') ?? false).toBe(false);
  });

  it('stacks the status cell content as content-sized block boxes instead', () => {
    expect(css).toMatch(
      /\.mail-log__status-cell\s*>\s*\*\s*\{[^}]*display:\s*block;[^}]*width:\s*fit-content;/,
    );
    expect(css).toMatch(
      /\.mail-log__status-cell\s*>\s*\*\s*\+\s*\*\s*\{[^}]*margin-top:\s*var\(--space-2\);/,
    );
  });
});
