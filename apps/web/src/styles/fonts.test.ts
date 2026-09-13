import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the self-hosted PT Serif setup.
 *
 * ## What this proves
 *
 * That the declaration is coherent and local: the `@font-face` family is
 * spelled exactly like the family the `--font-display` token asks for, the
 * required weights exist, every `src` points at a file that is really in the
 * repo and really is a WOFF2 container, the stylesheet is actually imported,
 * and no stylesheet reaches out to a foreign origin. Each of those failures
 * is silent in a browser — a typo in the family name or a dangling `url()`
 * produces no error, just titles quietly rendered in the fallback serif.
 *
 * ## What this does NOT prove
 *
 * That a browser ends up drawing PT Serif. jsdom neither loads web fonts nor
 * measures text, so no assertion here can tell PT Serif apart from Georgia on
 * screen. The rendered result, the `font-display` behaviour and the "no
 * request leaves the origin" promise are only observable in a real browser
 * and belong in Playwright: compare the used font of a title against a
 * PT-Serif-only reference (e.g. `document.fonts.check`) and assert that a
 * public fill-out view issues no third-party request.
 */

// jsdom turns `import.meta.url` into an http URL, so paths come from the
// working directory — Vitest runs each workspace project from its own root.
const PACKAGE_DIR = resolve(process.cwd());
const STYLES_DIR = join(PACKAGE_DIR, 'src', 'styles');

const FONTS_CSS = readFileSync(join(STYLES_DIR, 'fonts.css'), 'utf8');
const TOKENS_CSS = readFileSync(join(STYLES_DIR, 'tokens.css'), 'utf8');
const INDEX_CSS = readFileSync(join(STYLES_DIR, 'index.css'), 'utf8');
const INDEX_HTML = readFileSync(join(PACKAGE_DIR, 'index.html'), 'utf8');

/** The cuts the bundle ships. Adding one here without adding the file fails. */
const REQUIRED_WEIGHTS = ['400', '700'];

/** See the reasoning block in `fonts.css`; changing it is a design decision. */
const EXPECTED_FONT_DISPLAY = 'fallback';

interface FontFace {
  readonly descriptors: ReadonlyMap<string, string>;
}

function parseFontFaces(css: string): FontFace[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((block) => {
    const body = block[1] ?? '';
    const descriptors = new Map<string, string>(
      [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((declaration) => [
        (declaration[1] ?? '').trim(),
        (declaration[2] ?? '').trim(),
      ]),
    );

    return { descriptors };
  });
}

function descriptor(face: FontFace, name: string): string {
  const value = face.descriptors.get(name);

  expect(value, `@font-face is missing the descriptor "${name}"`).toBeDefined();
  return value ?? '';
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/** Resolves a `url(...)` from `fonts.css` against that stylesheet's folder. */
function resolveSrcPath(src: string): string {
  const match = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(src);

  expect(match?.[1], `no url() in src "${src}"`).toBeDefined();
  return resolve(STYLES_DIR, match?.[1] ?? '');
}

const faces = parseFontFaces(FONTS_CSS);

describe('self-hosted PT Serif', () => {
  it('declares a face for every weight the app uses', () => {
    // Without this the suite could pass on an empty file.
    expect(faces.length).toBeGreaterThan(0);

    const declared = faces.map(
      (face) =>
        `${unquote(descriptor(face, 'font-family'))} ${descriptor(face, 'font-weight')} ${descriptor(face, 'font-style')}`,
    );

    for (const weight of REQUIRED_WEIGHTS) {
      expect(declared).toContain(`PT Serif ${weight} normal`);
    }
  });

  it('spells the family exactly like the --font-display token', () => {
    // A mismatch here is the classic silent failure: the browser reports
    // nothing and every title falls through to the fallback serif.
    const token = /--font-display:\s*([^;]+);/.exec(TOKENS_CSS)?.[1];
    expect(token).toBeDefined();

    const firstFamily = unquote((token ?? '').split(',')[0] ?? '');
    const families = new Set(
      faces.map((face) => unquote(descriptor(face, 'font-family'))),
    );

    expect(families).toContain(firstFamily);
  });

  it.each(faces.map((face, index) => [index, face] as const))(
    'face %i ships a real WOFF2 file inside the repo',
    (_index, face) => {
      const src = descriptor(face, 'src');
      expect(src).toContain("format('woff2')");

      const path = resolveSrcPath(src);
      expect(path.endsWith('.woff2')).toBe(true);
      // A dangling url() is silent in the browser, so read the file here.
      const file = readFileSync(path);

      // WOFF2 signature — catches a truncated file or a stray LFS pointer.
      expect(file.subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(file.byteLength).toBeGreaterThan(20_000);
    },
  );

  it.each(faces.map((face, index) => [index, face] as const))(
    'face %i sets the agreed font-display',
    (_index, face) => {
      expect(descriptor(face, 'font-display')).toBe(EXPECTED_FONT_DISPLAY);
    },
  );

  it('is reachable from the stylesheet entry point', () => {
    // Declaring the faces in a file nobody imports would be a no-op.
    expect(INDEX_CSS).toContain("@import './fonts.css';");
  });

  it('preloads the bold cut from a path that exists', () => {
    const href = /rel="preload"[\s\S]*?href="([^"]+)"/.exec(INDEX_HTML)?.[1];
    expect(href).toBeDefined();

    // The href is root-relative in the HTML; on disk it hangs off the package.
    const path = join(PACKAGE_DIR, (href ?? '').replace(/^\//, ''));
    expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('wOF2');
    // Font preloads without `crossorigin` are fetched a second time.
    expect(INDEX_HTML).toMatch(/rel="preload"[\s\S]*?crossorigin/);
  });

  it('loads no font from a foreign origin', () => {
    // The whole point of self-hosting: the public fill-out views must not
    // hand a participant's IP address to a CDN.
    for (const css of [FONTS_CSS, TOKENS_CSS, INDEX_CSS]) {
      expect(css).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//);
      expect(css).not.toMatch(/@import\s+(?:url\()?['"]?(?:https?:)?\/\//);
    }

    expect(INDEX_HTML).not.toContain('fonts.googleapis.com');
    expect(INDEX_HTML).not.toContain('fonts.gstatic.com');
  });
});
