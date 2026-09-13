import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression test: the „einziger Weg
 * zurück"-hint on the confirmation page used to be plain muted text with no
 * visual weight, so the warning it carries read as decoration. It now takes
 * the sitewide „Hinweis-/Warnkasten" treatment (`.login__notice`,
 * `.dashboard__notice`) — hairline border, 3 px warning-coloured left edge,
 * tinted background — see the comment above the rule for why that pattern
 * and not a hand-picked look.
 */
describe('public-form-view.css › edit hint', () => {
  const css = readFileSync(
    join(resolve(process.cwd(), 'src/views'), 'public-form-view.css'),
    'utf8',
  );

  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|[^-\\w])${escaped}\\s*\\{([^}]*)\\}`).exec(
      css,
    );
    if (match?.[1] === undefined) {
      throw new Error(`Rule ${selector} not found in public-form-view.css`);
    }
    return match[1];
  }

  it('marks the hint as a warning notice, not plain text', () => {
    const body = ruleBody('.public__edit-hint');

    expect(body).toContain('border-left: 3px solid var(--color-warning);');
    expect(body).toContain('background: var(--color-warning-bg-soft);');
  });
});
