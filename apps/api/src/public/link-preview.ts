/**
 * **The `<head>` lines a messenger reads when a public address is shared.**
 *
 * WhatsApp, Signal, Teams and the like fetch `/f/<Adresse>` and read `<title>`
 * and the Open Graph tags — without running a line of JavaScript. The page is a
 * single-page application, so what they found was the static
 * `<title>Formsache</title>` of `index.html`, for every form alike. The front
 * door (`apps/web/docker/default.conf.template`) now splices the output of this
 * module into that document for exactly those addresses, by server-side include
 * (ADR-0033).
 *
 * The fragment is HTML built from text an editor typed, so **every value is
 * escaped here** and nowhere else; nothing reaches it unescaped.
 */

/** The product name — what `index.html` carries when nothing better is known. */
export const LINK_PREVIEW_FALLBACK_TITLE = 'Formsache';

/**
 * Where a description is cut. Messengers show two or three lines and cut on
 * their own; the bound keeps a page intro of several paragraphs from travelling
 * into every preview request.
 */
export const LINK_PREVIEW_DESCRIPTION_MAX = 200;

/**
 * **The hard bound of the whole fragment, in UTF-8 bytes.**
 *
 * The front door reads the answer into memory (`include … set=`), and a
 * subrequest larger than `subrequest_output_buffer_size` does not fail — nginx
 * logs „too big subrequest response" and **cuts the whole document** in the
 * middle of `<head>`, with a 200 (measured, 2026-10-03: 4216 bytes against the
 * default page-size buffer). The participant gets a white page. Escaping makes
 * that reachable with legal input: a title of 200 `"` is 1200 bytes, twice.
 *
 * So the fragment never exceeds this, and the template's buffer is at least
 * twice of it (`packages/shared/src/link-preview-ssi.test.ts` holds the two
 * together): the description goes first, then everything but the plain title.
 */
export const LINK_PREVIEW_MAX_BYTES = 8192;

export interface LinkPreview {
  readonly title: string;
  /** The intro of the first page, or null — withheld behind an access word. */
  readonly description: string | null;
  readonly organisation: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? '');
}

/**
 * One line of plain text, cut at a word boundary. A preview is one paragraph;
 * the line breaks of the page intro would only become blanks there anyway.
 */
export function previewDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= LINK_PREVIEW_DESCRIPTION_MAX) {
    return flat;
  }
  // By code point, not by UTF-16 unit: a cut through a surrogate pair would
  // leave half an emoji, which turns into U+FFFD.
  const cut = Array.from(flat)
    .slice(0, LINK_PREVIEW_DESCRIPTION_MAX - 1)
    .join('');
  const boundary = cut.lastIndexOf(' ');
  // A single word longer than the bound is cut mid-word rather than dropped.
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * The fragment for `<head>`. `null` — no form, or one that cannot be filled in
 * — gives the same title the static document carries, so a shared link to a
 * draft, a closed or a deleted form says nothing about it.
 */
export function renderLinkPreview(preview: LinkPreview | null): string {
  const plain = `<title>${LINK_PREVIEW_FALLBACK_TITLE}</title>\n`;
  if (preview === null) {
    return plain;
  }

  for (const withDescription of [true, false]) {
    const fragment = fragmentOf(preview, withDescription);
    if (Buffer.byteLength(fragment, 'utf8') <= LINK_PREVIEW_MAX_BYTES) {
      return fragment;
    }
  }
  return plain;
}

function fragmentOf(preview: LinkPreview, withDescription: boolean): string {
  const title = escapeHtml(preview.title);
  const lines = [
    `<title>${title}</title>`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:site_name" content="${escapeHtml(preview.organisation)}" />`,
    '<meta property="og:type" content="website" />',
  ];

  const description =
    !withDescription || preview.description === null
      ? ''
      : previewDescription(preview.description);
  if (description !== '') {
    const escaped = escapeHtml(description);
    lines.push(
      `<meta name="description" content="${escaped}" />`,
      `<meta property="og:description" content="${escaped}" />`,
    );
  }

  return `${lines.join('\n')}\n`;
}
