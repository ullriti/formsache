import { z } from 'zod';

/**
 * **Two allow lists, checked against the signature of the content** — the
 * decision written out in ADR-0014 no. 5.
 *
 * | list | allowed | delivery |
 * |---|---|---|
 * | logo (`tenant_logo`) | PNG, JPEG | public, embedded |
 * | attachment (`response_attachment`) | PDF, PNG, JPEG | only with a session, as a download |
 *
 * **SVG is on neither**, and the two reasons are different: a logo is
 * *embedded*, so a script inside one would run in the origin of this
 * application; an attachment is only protected by a `Content-Disposition`
 * header, and the first preview anybody builds — „man will ja sehen, was
 * hochgeladen wurde" — turns that into XSS in our own origin.
 *
 * Shared rather than server-side (the storage seam is deliberately not shared):
 * the browser needs the same list for its file picker and for its own „diesen
 * Typ nehmen wir nicht", and two spellings of one list are exactly the drift
 * `pickDefaultColumns` was moved here to avoid. The server still decides — the
 * client-side check is UX (`CONTRIBUTING.md`).
 */

/** Every type this application accepts anywhere. */
export const UPLOAD_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** The attachment list (ADR-0014 no. 5): a proof is a scan or a photo. */
export const ATTACHMENT_CONTENT_TYPES: readonly UploadContentType[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
];

/**
 * The logo list — **no PDF**, because this one is delivered to strangers and
 * embedded in a page. It is the narrower of the two on purpose, and the two are
 * separate constants rather than one list with a flag so that widening one
 * cannot widen the other by accident.
 */
export const TENANT_LOGO_CONTENT_TYPES: readonly UploadContentType[] = [
  'image/png',
  'image/jpeg',
];

/**
 * What each accepted type is **called on screen** — the everyday name, not the
 * media type.
 *
 * „PDF, JPG, PNG" is what the handoff's own file field says (`renderPreview`'s
 * file branch) and what a participant recognises; `application/pdf,
 * image/jpeg` is what the `accept` attribute needs. Both are derived from the
 * one list rather than typed out beside it, so widening the list cannot leave
 * the caption saying something narrower — the drift this module exists against.
 *
 * `image/jpeg` reads **JPG** rather than „JPEG": it is the extension the file
 * on a participant's desktop actually carries.
 */
const UPLOAD_TYPE_LABELS: Readonly<Record<UploadContentType, string>> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
};

/** One allow list as the names a participant reads — „PDF, JPG, PNG". */
export function contentTypeLabels(
  list: readonly UploadContentType[],
): string[] {
  return list.map((type) => UPLOAD_TYPE_LABELS[type]);
}

/**
 * The value of the `accept` attribute for an attachment picker.
 *
 * **A convenience for the file dialog, never a check.** `accept` filters what a
 * browser offers by default and is switched off by „Alle Dateien" in every file
 * dialog there is; the decision is the signature check on the server
 * ({@link detectContentType}), which reads the content rather than the name.
 */
export const ATTACHMENT_ACCEPT = ATTACHMENT_CONTENT_TYPES.join(',');

/**
 * How many bytes of the content the signature check needs.
 *
 * Eight — the length of the longest signature below (PNG). Everything is
 * decided on these bytes, so this is also the amount an upload route has to
 * hold in memory before it may write anything.
 */
export const FILE_SIGNATURE_BYTES = 8;

/**
 * The signatures, **at offset 0**, in the order they are tried.
 *
 * - PNG: `89 50 4E 47 0D 0A 1A 0A`
 * - JPEG: `FF D8 FF`
 * - PDF: `%PDF-`
 *
 * **Offset 0 for the PDF is stricter than the PDF specification**, which allows
 * the header anywhere in the first 1024 bytes. Deliberately: that slack is
 * precisely the room in which a polyglot carries its other head. What it costs
 * is named rather than discovered — a PDF with leading whitespace, a newline or
 * a UTF-8 BOM is **rejected** although every viewer opens it, and scanners and
 * multi-function devices do produce such files (assumption A7 of the ADR). The
 * acceptance run measures it with a real scanner PDF instead of assuming.
 */
const SIGNATURES: readonly {
  readonly type: UploadContentType;
  readonly bytes: readonly number[];
}[] = [
  {
    type: 'image/png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  // `%PDF-`
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * What the **content** says it is — or `null`.
 *
 * Never the file extension and never the `Content-Type` the caller sent: both
 * belong to whoever uploaded the file, and only one of the three was measured
 * . A byte comparison on the first eight bytes needs no
 * dependency — no `file-type`, no `sharp`, no scanner in the one path every
 * stranger on the internet can reach.
 *
 * **Assumption A4 of the ADR, restated where somebody meets it:** magic bytes
 * prove the beginning, not the rest. A PNG whose tail is a ZIP archive is
 * accepted here; what protects the application is the way the file is delivered
 * (ADR-0014 no. 11), not the completeness of this check.
 */
export function detectContentType(head: Uint8Array): UploadContentType | null {
  for (const signature of SIGNATURES) {
    if (startsWith(head, signature.bytes)) {
      return signature.type;
    }
  }
  return null;
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => head[index] === byte);
}

/**
 * Is this measured type on the given list?
 *
 * Takes the list as a parameter rather than the `kind`, so the caller has to
 * name which of the two delivery rules it is answering for — „welche Liste" is
 * the question already decided, and a helper that guessed it from a string
 * would put that decision back into a lookup.
 */
export function isAllowedContentType(
  list: readonly UploadContentType[],
  type: UploadContentType | null,
): type is UploadContentType {
  return type !== null && list.includes(type);
}

/**
 * The longest a file name may be, in code points after NFC normalisation.
 *
 * 255 is the limit of every filesystem this could ever be written to — not that
 * it is written to one (the storage key is the row's `id`, ADR-0014 no. 4), but
 * a name that no operating system could hold is a name a participant did not
 * type either.
 */
const FILE_NAME_MAX = 255;

/** Control characters, which have no business in a name that gets rendered. */
// eslint-disable-next-line no-control-regex -- that is exactly the class here.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The original file name — **as data** (ADR-0014 no. 10).
 *
 * It is stored and displayed (what is required is „der Dateiname als Link")
 * and never becomes part of a path. Two mechanisms guard it, and this is the
 * first: a name that does not pass is **rejected, not sanitised**. A sanitiser
 * would be a second opinion about what a name is, and the two opinions differ
 * exactly where it matters.
 *
 * The second mechanism is `Content-Disposition` on the way out: the first
 * one alone would rest on „every row came through this schema", which a raw
 * write, a seed or a migration disproves.
 *
 * NFC first, because `.length` on a decomposed name counts differently than a
 * reader would, and the normalised form is what gets stored.
 */
export const fileNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .refine((value) => value.length >= 1 && value.length <= FILE_NAME_MAX, {
    message: `Der Dateiname muss zwischen 1 und ${String(FILE_NAME_MAX)} Zeichen lang sein.`,
  })
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: 'Der Dateiname enthält Steuerzeichen.',
  })
  .refine((value) => !value.includes('/') && !value.includes('\\'), {
    message: 'Der Dateiname darf keine Pfadtrenner enthalten.',
  })
  .refine((value) => value !== '.' && value !== '..', {
    message: 'Der Dateiname ist kein Name.',
  });

/**
 * The shape of a file reference (ADR-0014 no. 9) — 16 bytes of CSPRNG as
 * base64url, i.e. the alphabet and length of `publicSlug` and `editToken`.
 *
 * **Bounded well above 22 characters on purpose**, exactly like `isPublicSlug`:
 * a tighter bound would silently 404 every existing address the day the number
 * of random bytes changes. Both halves earn their place, and the alphabet is
 * the one that bites — a percent escape is decoded before the application sees
 * it, `%00` arrives as a NUL byte, PostgreSQL refuses U+0000 in `text`, and the
 * query throws: a **500 where every unknown address answers 404**, which is the
 * distinction this closes off.
 */
const FILE_REF_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function isFileRef(value: unknown): value is FileRef {
  return typeof value === 'string' && FILE_REF_PATTERN.test(value);
}

/**
 * {@link isFileRef} as a schema — the way a payload states a stored file.
 *
 * Declared next to the predicate rather than beside the one union that uses it
 * (`tenantLogoSchema` in `branding.ts`), for the reason `single-source.test.ts`
 * exists: a second `z.string().regex(…)` spelling of this alphabet elsewhere
 * would be the `hexColorSchema` duplication again, and that one cost this
 * repository three narrowings and one forgotten copy.
 */
export const fileRefSchema = z.string().refine(isFileRef, {
  error: 'Das ist kein Dateiverweis.',
});

/**
 * The address of a stored file, as a **name** rather than as a guarantee.
 *
 * A plain alias of `string`: TypeScript has no nominal types, so this promises
 * nothing the compiler can hold anybody to, and it is written down as an alias
 * precisely so that nobody reads it as one. What it buys is that a signature
 * carrying two strings — `deliverableBranding(stored, ownedUpload)` — says
 * which of them has been through {@link isFileRef}, and that is the shape
 * ADR-0014 no. 12 spells out. The check itself is the predicate, at every
 * boundary, every time.
 */
export type FileRef = string;

/** How many random bytes a reference is minted from (no. 9). */
export const FILE_REF_BYTES = 16;

/**
 * The type a stored file is **delivered** as — looked up in one of the two
 * lists, never handed on (ADR-0014 no. 11).
 *
 * The stored `content_type` is a **key**, not a value: it goes into the list
 * and what comes back out is the list's own constant. `image/png` → the
 * `'image/png'` written above, and **no hit → `null`**, which both retrieval
 * routes answer as a 404 — not 415, and never „dann eben `octet-stream`".
 *
 * The case is not hypothetical, which is why the ADR writes it out. Both kinds
 * live in one table, the attachment list contains `application/pdf`, and a
 * `tenant_logo` carrying that type would arrive through a raw write or a future
 * third writer. Without this function its delivery would be whatever the
 * implementation happened to do — an empty header, `application/octet-stream`,
 * or the stored string — and „was liefert eine Zeile aus, die es nicht geben
 * darf" must not belong to chance.
 *
 * Why 404 rather than a distinct code: the route has exactly one answer for
 * „gibt es nicht so", and a second one would be an oracle over rows a caller
 * may not know exist.
 */
export function deliverableContentType(
  list: readonly UploadContentType[],
  stored: string,
): UploadContentType | null {
  return list.find((allowed) => allowed === stored) ?? null;
}
