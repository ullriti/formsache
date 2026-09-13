/**
 * `Content-Disposition` for a stored file — **the file name as data, on the way
 * out** (ADR-0014 no. 10, second mechanism).
 *
 * The name is validated on the way *in* by `fileNameSchema`, and that check
 * alone would rest on „jede Zeile in der Datenbank ist durch das Schema
 * gekommen" — a raw write, a seed and a migration are three counter-examples.
 * So the name is escaped again here, and this half rests on nothing but the
 * escape itself:
 *
 * - `filename*=UTF-8''<percent-encoded>` per RFC 6266/RFC 5987, which is what
 *   carries „Nachweis Müller.pdf" correctly;
 * - a conservative ASCII fallback in `filename="…"`, in which **everything**
 *   outside `[A-Za-z0-9._-]` is replaced. Not „quotes and backslashes escaped":
 *   an allow-list cannot be defeated by a character somebody thinks of later,
 *   and the fallback exists for clients that never learned the starred
 *   parameter — its job is to be *harmless*, not faithful.
 *
 * **Why the allow-list matters more than it looks.** A header value with CR or
 * LF in it is a response-splitting attempt, and Node does refuse such a header
 * — but „Node prüft das" is a statement about a library, and security
 * statements about libraries age (ADR-0014 no. 10). Both halves of the value
 * built here are drawn from fixed alphabets: percent-encoding emits
 * `[A-Za-z0-9%!'()*\\-._~]` and nothing else, and the fallback emits
 * `[A-Za-z0-9._-]`. Neither can produce a control character whatever the column
 * holds.
 */

/** What the fallback keeps. Everything else becomes `_`. */
const ASCII_SAFE = /[^A-Za-z0-9._-]/g;

/** The name a file gets when the column holds nothing usable in ASCII. */
const FALLBACK_NAME = 'datei';

/**
 * `attachment` for an answer's attachment, `inline` for a Logo.
 *
 * Two values and no default: ADR-0014 no. 11 makes them the *difference*
 * between the two retrieval routes, so a caller has to say which one it is
 * rather than inherit one.
 */
export type DispositionType = 'attachment' | 'inline';

export function contentDisposition(
  type: DispositionType,
  fileName: string,
): string {
  const ascii = fileName.replace(ASCII_SAFE, '_');
  // A name made entirely of replaced characters („安全.pdf") would degrade to
  // `____.pdf`, which is fine — but an *empty* one is not a name at all, and a
  // `filename=""` is a header a client may read as „no name".
  const fallback = ascii.replace(/_/g, '') === '' ? FALLBACK_NAME : ascii;
  // `encodeURIComponent` leaves `!'()*` unescaped; they are `attr-char` under
  // RFC 5987 except for `'`, `(`, `)` and `*`, so those four are escaped by
  // hand rather than left to a reader's tolerance.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
