import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_CONTENT_TYPES,
  TENANT_LOGO_CONTENT_TYPES,
  deliverableContentType,
  detectContentType,
  fileNameSchema,
  isAllowedContentType,
  isFileRef,
} from './file-types.ts';

/**
 * **The requirement at the bottom of the pyramid** — the list decides on the
 * *content*, never on a name and never on what the caller declared.
 *
 * The two proofs that matter are the negative ones: a file with an allowed
 * extension and foreign content, and an SVG. Both are here as bytes, because
 * that is the only thing the check ever sees.
 *
 * *Reproduction:* switch the check to the extension — every assertion below
 * that hands in bytes whose name would say otherwise goes red, since there is
 * no name in this function at all.
 */

const png = (tail = ''): Uint8Array =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...Buffer.from(tail),
  ]);

const jpeg = (): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

const pdf = (leading = ''): Uint8Array =>
  new Uint8Array(Buffer.from(`${leading}%PDF-1.7\n`));

const svg = (): Uint8Array =>
  new Uint8Array(
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
  );

describe('detectContentType — the signature, at offset 0', () => {
  it('reads PNG, JPEG and PDF from their first bytes', () => {
    expect(detectContentType(png())).toBe('image/png');
    expect(detectContentType(jpeg())).toBe('image/jpeg');
    expect(detectContentType(pdf())).toBe('application/pdf');
  });

  it('refuses an SVG — however it is named or declared', () => {
    // The bytes are all this function gets: there is no `Nachweis.png` and no
    // `Content-Type: image/png` in this call, which is exactly the property
    // for.
    expect(detectContentType(svg())).toBeNull();
  });

  it('refuses content that only *looks* allowed by its name', () => {
    // „Nachweis.pdf" whose content is a ZIP: the extension is not consulted,
    // so the answer is null and the upload is refused.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(detectContentType(zip)).toBeNull();
    // HTML, the one that would matter most on the public logo route.
    expect(detectContentType(new Uint8Array(Buffer.from('<html>')))).toBeNull();
  });

  it('refuses a PDF whose header is not at offset 0 — Annahme A7, measured', () => {
    // Documented cost rather than a discovery: a scanner that writes a newline
    // or a BOM in front of `%PDF-` produces a file every viewer opens and this
    // check rejects. The slack the specification allows is the room in which a
    // polyglot carries its second head, so offset 0 stands — and testing
    // with a real scanner PDF measures the cost.
    expect(detectContentType(pdf(' '))).toBeNull();
    expect(detectContentType(pdf('\n'))).toBeNull();
    expect(detectContentType(pdf('\ufeff'))).toBeNull();
  });

  it('refuses a file too short to carry a signature', () => {
    expect(detectContentType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectContentType(new Uint8Array([]))).toBeNull();
  });

  it('accepts a truncated PNG header as nothing — all eight bytes count', () => {
    expect(
      detectContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])),
    ).toBeNull();
  });
});

describe('the two lists', () => {
  it('keeps PDF off the Logo list and SVG off both', () => {
    expect(isAllowedContentType(TENANT_LOGO_CONTENT_TYPES, 'image/png')).toBe(
      true,
    );
    expect(isAllowedContentType(TENANT_LOGO_CONTENT_TYPES, 'image/jpeg')).toBe(
      true,
    );
    expect(
      isAllowedContentType(TENANT_LOGO_CONTENT_TYPES, 'application/pdf'),
    ).toBe(false);

    expect(
      isAllowedContentType(ATTACHMENT_CONTENT_TYPES, 'application/pdf'),
    ).toBe(true);

    // Neither list can name SVG at all: it is not a member of the type, so a
    // future entry would be a compile error rather than a lookup that happens
    // to miss.
    expect(isAllowedContentType(ATTACHMENT_CONTENT_TYPES, null)).toBe(false);
    expect(TENANT_LOGO_CONTENT_TYPES).not.toContain('image/svg+xml');
    expect(ATTACHMENT_CONTENT_TYPES).not.toContain('image/svg+xml');
  });
});

describe('fileNameSchema — rejected, never sanitised (Nr. 10)', () => {
  it('keeps an ordinary name and normalises it to NFC', () => {
    expect(fileNameSchema.parse('Nachweis Müller.pdf')).toBe(
      'Nachweis Müller.pdf',
    );
    // Decomposed „ü" (u + combining diaeresis) becomes the composed form, so
    // one name has one spelling in the database.
    expect(fileNameSchema.parse('Mu\u0308ller.pdf')).toBe('M\u00fcller.pdf');
  });

  it('refuses path separators, control characters and the two dot names', () => {
    for (const name of [
      '../../etc/passwd',
      'a\\b.pdf',
      'Nachweis\r\nX-Injected: 1.pdf',
      'Nachweis\u0007.pdf',
      '.',
      '..',
      '',
      'x'.repeat(256),
    ]) {
      expect(fileNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('isFileRef', () => {
  it('takes the base64url alphabet and bounds the length', () => {
    expect(isFileRef('A0_-aaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(isFileRef('has spaces')).toBe(false);
    expect(isFileRef('a/b')).toBe(false);
    // `%00` arrives decoded — the byte that makes PostgreSQL throw and turns a
    // 404 route into a 500 oracle.
    expect(isFileRef('\u0000')).toBe(false);
    expect(isFileRef('x'.repeat(201))).toBe(false);
    expect(isFileRef(42)).toBe(false);
  });
});

/**
 * **The delivered type is looked up, never handed on** (* ADR-0014 no. 11).
 *
 * The stored value is a *key*: what comes back is the list's own constant, and
 * a miss is `null` — which both retrieval routes answer as a 404, not as 415
 * and not as `application/octet-stream`.
 *
 * The case that makes it necessary is the third test. Both kinds live in one
 * `file` table, the attachment list contains `application/pdf`, and a
 * `tenant_logo` carrying that type is expressible through a raw write. Without
 * this function its delivery would be whatever the implementation happened to
 * do.
 *
 * *Reproduction:* let the function return `stored` on a miss (i.e. hand the
 * column on) → the last two tests go red.
 */
describe('deliverableContentType', () => {
  it('answers with a member of the list it was given', () => {
    const delivered = deliverableContentType(
      TENANT_LOGO_CONTENT_TYPES,
      'image/png',
    );

    expect(delivered).toBe('image/png');
    // The property, stated the only way it is observable in JavaScript:
    // whatever comes back is **on the list**. Strings are values here, so
    // „unser Konstante statt der Spalte" cannot be shown by identity — what can
    // be shown is that nothing off the list ever comes out, which is the two
    // tests below.
    expect(TENANT_LOGO_CONTENT_TYPES).toContain(delivered);
  });

  it('answers null for a type on the *other* list', () => {
    expect(
      deliverableContentType(TENANT_LOGO_CONTENT_TYPES, 'application/pdf'),
    ).toBeNull();
    expect(
      deliverableContentType(ATTACHMENT_CONTENT_TYPES, 'application/pdf'),
    ).toBe('application/pdf');
  });

  it.each([
    'image/svg+xml',
    'text/html',
    'application/octet-stream',
    'IMAGE/PNG',
    'image/png; charset=utf-8',
    '',
    '__proto__',
  ])('answers null for %s', (stored) => {
    expect(deliverableContentType(ATTACHMENT_CONTENT_TYPES, stored)).toBeNull();
    expect(
      deliverableContentType(TENANT_LOGO_CONTENT_TYPES, stored),
    ).toBeNull();
  });
});
