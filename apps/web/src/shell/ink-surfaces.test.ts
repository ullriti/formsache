import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// As in `styles/tokens.test.ts`: jsdom turns `import.meta.url` into an http
// address, so the path comes from the working directory.
const SHELL_DIR = resolve(process.cwd(), 'src', 'shell');

/**
 * **On a dark ground the ink stands *on* ink** — the same fault three times.
 *
 * The header (`--color-header-bg`) and the mobile menu (`--color-ink-raised`)
 * are dark surfaces. `--color-text` and `--color-text-muted` are the colours of
 * body text on a **light** ground; whoever uses them here writes dark on
 * dark. That is no blemish but a `color-contrast` violation
 * under WCAG, and axe reports it as `serious`.
 *
 * ## Why a guard is needed and not only the axe run
 *
 * The button „Andere Sitzungen beenden" made this fault twice in **one**
 * session: first `--color-text-muted` in the sheet — found by the
 * axe run at 360 px —, then as a „Behebung" `--color-text`, which is the same
 * violation painted green. The third time it hit the header.
 *
 * And the sentence that appears after the revocation shows the limit of the
 * axe run: **it is visible only after an action** that no
 * accessibility case triggers (a revocation ends the sessions the rest of the
 * suite is logged in with). A colour no measurement ever sees is
 * exactly the one that stays wrong — this guard reads it in the source.
 */
const INK_FILES = [
  'app-header.css',
  'mobile-menu-sheet.css',
] as const satisfies readonly string[];

/** Source without comments — otherwise the explanation counts as a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('Flächen auf Tinte benutzen die Tinte auf Tinte', () => {
  for (const file of INK_FILES) {
    const source = readFileSync(resolve(SHELL_DIR, file), 'utf8');
    const code = stripComments(source);

    it(`${file} liest sich überhaupt (Boden unter dem Wächter)`, () => {
      // Without this line an empty or moved file would be green, and the guard
      // an assertion about nothing.
      expect(code.length).toBeGreaterThan(500);
      expect(code).toContain('--color-on-ink');
    });

    it(`${file} benutzt keine Fließtext-Tinte`, () => {
      const offenders = code
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) =>
          /var\(--color-text(?:-muted|-strong)?\)/u.test(line),
        )
        .map(({ line, number }) => `${String(number)}: ${line}`);

      expect(
        offenders,
        `${file} steht auf dunklem Grund. \`--color-text…\` ist die Tinte für ` +
          'helle Flächen und ergibt hier Dunkel auf Dunkel — gemeint ist ' +
          '`--color-on-ink` bzw. `--color-on-ink-muted`.',
      ).toStrictEqual([]);
    });
  }
});
