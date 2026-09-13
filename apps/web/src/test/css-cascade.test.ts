import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Cascade } from './css-cascade';

/**
 * **The measuring instrument is itself measured** (review findings 9 and 10).
 *
 * `css-cascade.ts` is test tooling, not production code — and precisely for
 * that a fault in it is more expensive than one in a view: it turns every
 * measurement below it into a claim about nothing, and the message points at
 * the wrong file. The occasion was a unitless zero from a
 * shorthand (`padding: 0 var(--space-7) var(--space-6)`) that `pixels()`
 * rejected as „keine Pixel-Länge" — the fault stood in the tool and looked like
 * one in the stylesheet.
 *
 * The stylesheets here are **their own**, none of the application's: a test
 * about the tool must not turn red because someone changed a padding.
 */

const directory = mkdtempSync(join(tmpdir(), 'css-cascade-'));

function cssFile(name: string, source: string): string {
  const path = join(directory, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

function element(className: string): Element {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Cascade.pixels', () => {
  it('liest die einheitenlose Null einer Kurzschreibweise als 0', () => {
    const styles = Cascade.fromFile(
      cssFile('zero.css', '.card { padding: 0 20px 18px; }'),
    );

    const card = element('card');
    expect(styles.pixels(card, 'padding-top')).toBe(0);
    expect(styles.pixels(card, 'padding-right')).toBe(20);
    expect(styles.pixels(card, 'padding-bottom')).toBe(18);
    // Left follows right — the shorthand fill rules of CSS.
    expect(styles.pixels(card, 'padding-left')).toBe(20);
  });

  it('nimmt auch eine unmittelbar zugewiesene Null an', () => {
    const styles = Cascade.fromFile(
      cssFile('flat.css', '.card { margin: 0; }'),
    );

    expect(styles.pixels(element('card'), 'margin-top')).toBe(0);
  });

  /**
   * The counter-check to the leniency above: unitless, **only** the zero is
   * allowed. Reading `1.5` silently as `1.5px` would mean guessing — and that
   * in a tool whose entire purpose is not to guess.
   */
  it('weist eine einheitenlose Länge ungleich null weiter ab', () => {
    const styles = Cascade.fromFile(
      cssFile('unitless.css', '.card { padding-top: 1.5; }'),
    );

    expect(() => styles.pixels(element('card'), 'padding-top')).toThrow(
      /keine Pixel-Länge/u,
    );
  });

  it('gibt `undefined` zurück, wo nichts zugewiesen ist', () => {
    const styles = Cascade.fromFile(
      cssFile('nothing.css', '.card { color: red; }'),
    );

    expect(styles.pixels(element('card'), 'padding-top')).toBeUndefined();
  });
});

describe('Cascade.fromFile', () => {
  /**
   * **A cascade sees only the files it is given** (finding 10). Whoever
   * measures a tree inside its shell has to hand in that shell's stylesheet —
   * otherwise the tool reads every rule from it as not present, and an
   * inherited opacity silently counts as 1.
   */
  it('nimmt mehrere Dateien und wertet die spätere als die spätere', () => {
    const shell = cssFile(
      'shell.css',
      '.row { opacity: 0.55; } .cell { padding: 4px; }',
    );
    const view = cssFile('view.css', '.cell { padding: 12px; }');

    const styles = Cascade.fromFile(shell, view);

    const row = element('row');
    const cell = element('cell');
    row.append(cell);
    document.body.append(row);

    // From the second file, at equal specificity — the later one wins.
    expect(styles.pixels(cell, 'padding-top')).toBe(12);
    // And the inherited opacity of the shell multiplies in, instead of being
    // read silently as 1.
    expect(styles.effectiveOpacity(cell)).toBeCloseTo(0.55);
  });

  it('sagt, welche der Dateien keine Regeln hatte', () => {
    const good = cssFile('good.css', '.card { padding: 4px; }');
    const empty = cssFile('empty.css', '/* nur ein Kommentar */');

    expect(() => Cascade.fromFile(good, empty)).toThrow(/empty\.css/u);
  });

  it('verlangt mindestens eine Datei', () => {
    expect(() => Cascade.fromFile()).toThrow(/keine Datei/u);
  });
});
