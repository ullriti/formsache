import { describe, expect, it } from 'vitest';

import { contentDisposition } from './content-disposition';

/**
 * **The file name travels as data** (ADR-0014
 * no. 10).
 *
 * The unit level is where this belongs: the interesting inputs are names no
 * `fileNameSchema` would let through, and the whole reason this second
 * mechanism exists is that such a name can reach the column past the API — by
 * a raw write, a seed or a migration. An integration test could only ever feed
 * it names the schema already accepted.
 *
 * *Reproductions, run while writing this file:*
 * - Replacing the ASCII allow-list with „escape quotes and backslashes" → the
 *   control-character and the semicolon cases go red (measured: red).
 * - Dropping `filename*` and keeping only the fallback → „carries a non-ASCII
 *   name faithfully" goes red (measured: red).
 */
describe('contentDisposition ', () => {
  it('states which of the two dispositions it is', () => {
    expect(contentDisposition('attachment', 'a.pdf')).toMatch(/^attachment; /);
    expect(contentDisposition('inline', 'a.png')).toMatch(/^inline; /);
  });

  it('carries a non-ASCII name faithfully in the starred parameter', () => {
    const header = contentDisposition('attachment', 'Nachweis Müller.pdf');

    expect(header).toContain("filename*=UTF-8''Nachweis%20M%C3%BCller.pdf");
    // And harmlessly in the fallback, for a client that never learned it.
    expect(header).toContain('filename="Nachweis_M_ller.pdf"');
  });

  /**
   * The names this is actually for. Every one of them is a legal `text` value
   * in PostgreSQL and none of them survives `fileNameSchema` — so each stands
   * for a row that got in some other way.
   */
  it.each([
    ['a"; rm -rf /; x="b.pdf', 'a___rm_-rf____x__b.pdf'],
    ['scan\r\nSet-Cookie: a=b.pdf', 'scan__Set-Cookie__a_b.pdf'],
    ['../../etc/passwd', '.._.._etc_passwd'],
    ['<script>alert(1)</script>.png', '_script_alert_1___script_.png'],
  ])('renders %j harmlessly in the fallback', (name, expected) => {
    const header = contentDisposition('attachment', name);

    expect(header).toContain(`filename="${expected}"`);
    // Both halves: no control character survives either encoding, so nothing
    // here can end a header or start a second one. (The spaces in
    // `attachment; filename=` are the header's own separators — the *shape*
    // of the whole value is pinned by the next test.)
    // eslint-disable-next-line no-control-regex -- that class is the point.
    expect(header).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('never emits a character outside the two fixed alphabets', () => {
    // 0–255 in one name: whatever a column holds, the header is drawn from
    // `[A-Za-z0-9._-]` plus the percent-escape alphabet, and from nothing else.
    const everything = Array.from({ length: 256 }, (_, code) =>
      String.fromCharCode(code),
    ).join('');

    const header = contentDisposition('inline', everything);

    expect(header).toMatch(
      /^inline; filename="[A-Za-z0-9._-]*"; filename\*=UTF-8''[A-Za-z0-9%!\-._~]*$/,
    );
  });

  it('substitutes a name that would render as nothing', () => {
    // „安全" is a perfectly good name and a perfectly empty ASCII fallback;
    // `filename=""` is a header a client may read as „no name at all".
    expect(contentDisposition('attachment', '安全')).toContain(
      'filename="datei"',
    );
  });
});
