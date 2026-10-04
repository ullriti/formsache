import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **The link preview of `/f/<Adresse>` is text in two files** (ADR-0033).
 *
 * `index.html` carries the SSI commands, the nginx template switches SSI on for
 * the public address and routes the include to the API. Neither half does
 * anything without the other, and no running server in CI notices either going
 * missing — `vite preview` serves the commands as comments. The container was
 * measured by hand (2026-10-03); this file holds the two texts to what was
 * measured.
 *
 * It lives in `@formsache/shared` for the reason `referrer-policy.test.ts` does:
 * it reads files of two other workspaces and belongs to neither.
 */

const ROOT = resolve(process.cwd(), '..', '..');
const TEMPLATE = 'apps/web/docker/default.conf.template';
const DOCUMENT = 'apps/web/index.html';

/** Every SSI command the document is meant to hold, in order. */
const EXPECTED_COMMANDS = [
  '<!--# include virtual="/_link-preview/$link_preview_slug" set="link_preview_head" -->',
  '<!--# if expr="$link_preview_head" -->',
  '<!--# echo var="link_preview_head" encoding="none" -->',
  '<!--# else -->',
  '<!--# endif -->',
];

describe('link preview by server-side include', () => {
  const template = readFileSync(join(ROOT, TEMPLATE), 'utf8');
  const document = readFileSync(join(ROOT, DOCUMENT), 'utf8');

  /**
   * **Measured, not assumed:** a prose comment that mentioned the syntax made
   * nginx parse the comment as a command, log an error and drop the line. Every
   * `<!--#` in the document is therefore one of these five.
   */
  it('holds exactly the five SSI commands and no stray `<!--#`', () => {
    const commands = document.match(/<!--#[^]*?-->/g) ?? [];

    expect(commands.map((command) => command.replace(/\s+/g, ' '))).toEqual(
      EXPECTED_COMMANDS,
    );
  });

  it('keeps exactly one plain title, in the else branch', () => {
    // Prose comments mention `<title>` too; only markup counts.
    const markup = document.replace(/<!--(?!#)[^]*?-->/g, '');
    expect(markup.match(/<title>/g)).toHaveLength(1);
    expect(
      /<!--# else -->\s*<title>Formsache<\/title>\s*<!--# endif -->/.test(
        document,
      ),
    ).toBe(true);
  });

  it('switches SSI on for the bare public address only', () => {
    const location =
      /location ~ "\^\/f\/\(\?<link_preview_slug>\[A-Za-z0-9_-\]\{1,200\}\)\/\?\$" \{([^]*?)\n {4}\}/.exec(
        template,
      );

    expect(location, `${TEMPLATE} has no SSI location for /f/`).not.toBe(null);
    const body = location?.[1] ?? '';
    expect(body).toMatch(/^\s*ssi on;/m);
    expect(body).toMatch(/^\s*ssi_silent_errors on;/m);
    // `try_files` would redirect internally and leave the location, and SSI.
    expect(body).toMatch(/^\s*rewrite \^ \/index\.html break;/m);
    expect(body).not.toMatch(/try_files/);
    // `add_header` here replaces every inherited one.
    expect(body).toMatch(/add_header Referrer-Policy "no-referrer" always;/);
    expect(body).toMatch(/add_header Content-Security-Policy /);
    expect(body).toMatch(/add_header X-Content-Type-Options "nosniff" always;/);
  });

  it('turns every failure of the include into an empty answer', () => {
    const location =
      /location ~ "\^\/_link-preview\/\(\?<link_preview_api_slug>[^"]*" \{([^]*?)\n {4}\}/.exec(
        template,
      );

    expect(location, `${TEMPLATE} has no internal include location`).not.toBe(
      null,
    );
    const body = location?.[1] ?? '';
    expect(body).toMatch(/^\s*internal;/m);
    expect(body).toMatch(
      /rewrite \^ \/api\/public\/forms\/\$link_preview_api_slug\/link-preview break;/,
    );
    expect(body).toMatch(/^\s*proxy_intercept_errors on;/m);
    // The rate limit (429) and an API that is down (502) are the two that
    // actually happen.
    expect(body).toMatch(/error_page [^;]*\b429\b[^;]*= @link_preview_none;/);
    expect(body).toMatch(/error_page [^;]*\b502\b[^;]*= @link_preview_none;/);
    expect(template).toMatch(
      /location @link_preview_none \{\s*return 204;\s*\}/,
    );
  });

  /**
   * **Measured:** an answer above the buffer does not fail — nginx cuts the
   * whole document off mid-`<head>`, with a 200, and the form page stays
   * white. The API bounds its fragment (`LINK_PREVIEW_MAX_BYTES`); this holds
   * the buffer to twice of it.
   */
  it('reads the include into a buffer twice the bound of the fragment', () => {
    const api = readFileSync(
      join(ROOT, 'apps/api/src/public/link-preview.ts'),
      'utf8',
    );
    const bound = /export const LINK_PREVIEW_MAX_BYTES = (\d+);/.exec(api);
    const buffer = /^\s*subrequest_output_buffer_size (\d+)k;/m.exec(template);

    expect(bound, 'LINK_PREVIEW_MAX_BYTES not found').not.toBe(null);
    expect(
      buffer,
      `${TEMPLATE} sets no subrequest_output_buffer_size`,
    ).not.toBe(null);
    expect(Number(buffer?.[1]) * 1024).toBeGreaterThanOrEqual(
      2 * Number(bound?.[1]),
    );
  });

  it('sends neither the session cookie nor a wish for compression', () => {
    expect(template).toMatch(/^\s*proxy_set_header Cookie\s+"";/m);
    expect(template).toMatch(/^\s*proxy_set_header Accept-Encoding\s+"";/m);
  });
});
