import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **Kein `Referer` verlässt diese Anwendung** (a review finding).
 *
 * Two of this application's addresses carry their authorisation **in the path**
 * — the Bearbeiten-Link and the Entwurfs-Adresse. That is a
 * deliberate trade: the address is copied by hand, so it holds one identifier
 * and nothing else. What the trade assumes is that the path stays between the
 * participant and the server, and a `Referer` breaks that assumption without
 * anybody doing anything wrong — one external image, one link followed out of
 * the confirmation page, and somebody else's log holds a working capability.
 *
 * *Measured on 2026-08-05:* `grep -r "Referrer-Policy"` over `apps/api/src`,
 * `apps/web` and the nginx template found **zero** hits.
 *
 * The header is set in three independent places, because three different things
 * can be served without the other two: the API (`common/no-store.ts`, covered by
 * its own suite over the routes), the built page behind the container's front
 * door (the nginx template), and the page itself wherever it is served from
 * (`index.html`, which is what covers `vite dev` and `vite preview`). This file
 * holds the two **static** ones to it — they are configuration and text, so no
 * running server would ever notice them going missing.
 *
 * It lives in `@formsache/shared` for the reason `nginx-body-limit.test.ts` does: it
 * reads files of two other workspaces and belongs to neither.
 *
 * *Reproduction:* remove one of the lines → the corresponding case turns red.
 */

/** Repo root — Vitest runs each workspace project from its own package root. */
const ROOT = resolve(process.cwd(), '..', '..');
const TEMPLATE = 'apps/web/docker/default.conf.template';
const DOCUMENT = 'apps/web/index.html';

const POLICY = 'no-referrer';

describe('Referrer-Policy on the paths that carry a capability', () => {
  const template = readFileSync(join(ROOT, TEMPLATE), 'utf8');
  const document = readFileSync(join(ROOT, DOCUMENT), 'utf8');

  it('is declared in the page itself, so it survives any way of serving it', () => {
    expect(
      /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/.test(document),
      `${DOCUMENT} carries no <meta name="referrer">. The built page is then ` +
        'only protected where the nginx front door serves it — not under ' +
        '`vite dev`, not under `vite preview`, and not behind any other web ' +
        'server an installation might use.',
    ).toBe(true);
  });

  it('is sent by the front door at the server level', () => {
    expect(
      /^\s*add_header\s+Referrer-Policy\s+"no-referrer"\s+always;/m.test(
        template,
      ),
      `${TEMPLATE} sets no Referrer-Policy.`,
    ).toBe(true);
  });

  /**
   * **The trap this file exists for.** nginx inherits `add_header` only while
   * the deeper level sets *none* of its own — and both content locations set
   * `Cache-Control`. A single server-level line would therefore vanish for
   * `/assets/` and for `/`, i.e. for the very document whose address is the
   * capability.
   */
  /**
   * **The same question for the policy of the page** — and for the same reason in the same place: it is text in
   * two files that no running server misses.
   *
   * ⚠️ The two headers cover **different** things, and neither replaces the
   * other: `<meta http-equiv>` in the document applies everywhere this
   * document is served (including `vite preview`, where the 314 E2E cases
   * measure it); the nginx header applies in addition to answers that are no
   * HTML. `X-Content-Type-Options` **cannot** be set via `<meta>`
   * at all — it therefore stands only at the server and at the API.
   */
  it('declares a Content-Security-Policy in the page itself', () => {
    expect(
      /<meta\s+http-equiv="Content-Security-Policy"/.test(document),
      `${DOCUMENT} carries no Content-Security-Policy. Without it the ` +
        'policy holds only where nginx serves the page — and no test of this ' +
        'repository would notice it going missing.',
    ).toBe(true);
  });

  it("keeps frame-ancestors 'none' and denies inline script", () => {
    const meta = /content="([^"]*)"\s*\/?>/.exec(
      /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/.exec(
        document,
      )?.[0] ?? '',
    )?.[1];
    expect(meta, 'no content attribute on the CSP meta tag').toBeDefined();
    expect(meta).toContain("frame-ancestors 'none'");
    expect(meta).toContain("object-src 'none'");
    expect(meta).toContain("base-uri 'none'");
    // **Scripts never inline.** For styles `'unsafe-inline'` is deliberately
    // set (two named `style` attributes); for scripts it would be the end of
    // the policy, and the built document demonstrably does not need it.
    const scriptSrc = /script-src ([^;]*)/.exec(meta ?? '')?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('sends both of them from the front door as well', () => {
    expect(
      /^\s*add_header\s+Content-Security-Policy\s+"[^"]+"\s+always;/m.test(
        template,
      ),
      `${TEMPLATE} sets no Content-Security-Policy.`,
    ).toBe(true);
    expect(
      /^\s*add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/m.test(
        template,
      ),
      `${TEMPLATE} sets no X-Content-Type-Options — and a <meta> cannot.`,
    ).toBe(true);
  });

  it('repeats it in every location that sets a header of its own', () => {
    const locations = [
      ...template.matchAll(/location\s+(\S+)\s*\{([^}]*)\}/g),
    ].map((match) => ({ path: match[1] ?? '?', body: match[2] ?? '' }));
    expect(locations.length).toBeGreaterThan(0);

    for (const location of locations) {
      if (!location.body.includes('add_header')) {
        // Nothing of its own, so the server-level line reaches it.
        continue;
      }
      for (const header of [
        `Referrer-Policy "${POLICY}"`,
        'Content-Security-Policy',
        'X-Content-Type-Options "nosniff"',
      ]) {
        expect(
          location.body.includes(header),
          `location ${location.path} in ${TEMPLATE} sets an add_header of its ` +
            'own, which makes nginx drop every inherited one — including ' +
            `${header}. Repeat the line inside this block.`,
        ).toBe(true);
      }
    }
  });
});
