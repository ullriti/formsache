/**
 * The size limits of an uploaded file (ADR-0014 no. 6).
 *
 * Shared rather than server-side, for the reason the seam itself is **not**
 * shared: the browser needs the same numbers for its own „diese Datei ist zu
 * groß" long before the request leaves, and two spellings of one limit are
 * exactly the drift `pickDefaultColumns` was moved here to avoid. The
 * server still enforces them itself — the client-side check is UX.
 *
 * **The numbers are estimates, not measurements** (assumption A5 of the ADR):
 * they come from the described use — a scanned certificate at 300 dpi is
 * 0.5–3 MiB, a phone photo of one 3–6 MiB, a logo exported from a template a
 * few hundred KiB. The acceptance run is the first chance to check them
 * against real traffic. Changing one is a constant and the nginx limit
 * (no. 18), not a redesign.
 */

import {
  ATTACHMENT_CONTENT_TYPES,
  TENANT_LOGO_CONTENT_TYPES,
  contentTypeLabels,
} from './file-types.ts';

const MIB = 1024 * 1024;

/**
 * One attachment to an answer: **10 MiB**. Carries a scanned document and a
 * phone photo with room to spare, and stays small enough that a rejection on a
 * mobile connection costs seconds rather than minutes.
 */
export const MAX_ATTACHMENT_BYTES = 10 * MIB;

/**
 * The one sentence a participant and an editor read under a Datei-Upload field
 * — „Erlaubt: PDF, JPG, PNG · max. 10 MB" .
 *
 * **Composed from the two constants, never typed out.** The builder's preview
 * and the fill-in view both show it, and a second spelling is a caption that
 * goes on promising ten megabytes after the limit moved — the same drift the
 * handoff's own field has built in, where the text is a free box an editor
 * fills in (`fileQuestionSchema` says why that box is gone).
 */
export const ATTACHMENT_HINT = `Erlaubt: ${contentTypeLabels(
  ATTACHMENT_CONTENT_TYPES,
).join(', ')} · max. ${String(MAX_ATTACHMENT_BYTES / MIB)} MB`;

/**
 * One logo: **2 MiB**. The delivered `beispiel-emblem.svg` is 240 KiB, so
 * this is eight times a real one — generous for a square graphic that gets
 * rendered at a few hundred pixels.
 */
export const MAX_TENANT_LOGO_BYTES = 2 * MIB;

/**
 * The sentence under the logo picker, composed like {@link ATTACHMENT_HINT}
 * and for the same reason: the *Erscheinungsbild* tab spelled the megabyte
 * arithmetic out by hand until a review caught it — the caption that
 * goes on promising two megabytes after the limit moves.
 *
 * The refusal of SVG is named rather than implied — it is on neither positive
 * list, and „warum nimmt er mein Logo nicht" is the question this
 * sentence exists to answer before it is asked.
 */
export const TENANT_LOGO_HINT = `${contentTypeLabels(
  TENANT_LOGO_CONTENT_TYPES,
).join(' oder ')}, höchstens ${String(
  MAX_TENANT_LOGO_BYTES / MIB,
)} MB. SVG wird nicht angenommen.`;

/**
 * How many files one answer may carry: **10** (ADR-0014 no. 6).
 *
 * The domain says one or two — a registration with a proof, a
 * Sterbefallmeldung with a certificate. Ten is far above that and still bounds a
 * form somebody gave fifty file questions.
 *
 * Enforced **when the answer is submitted** (no. 13), because before that there
 * is no answer to measure it against. That is the split, not a gap: upload time
 * is bounded by the per-address counters below.
 */
export const MAX_FILES_PER_RESPONSE = 10;

/**
 * How many bytes one answer may carry in total: **25 MiB** (ADR-0014 no. 6).
 *
 * Not the arithmetical 100 MiB (10 × 10 MiB): the realistic case is two or
 * three scans, and this system is not an archive — it replaces the way via
 * e-mail, and a mail attachment is at its end at 25 MiB anyway.
 */
export const MAX_RESPONSE_BYTES = 25 * MIB;

/**
 * How long an unclaimed upload lives before the purge takes it: **24 hours**
 * (ADR-0014 no. 15).
 *
 * **One constant, read by two places**, and that is the whole reason it is
 * here: the purge cuts on it, and condition 5 of the claim (no. 13)
 * refuses a file older than it. Two numbers would be two opinions about when a
 * file expires, and the gap between them is a submitted answer with an
 * attachment that has no bytes.
 */
export const UNCLAIMED_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * What one address may hold **in the waiting room of one form** — 25 MiB and 20
 * files (ADR-0014 no. 7, counters 1 and 2).
 *
 * They come as a pair because a volume loses two things. Bytes are the obvious
 * one; the other is **inodes and rows**: an 8-byte file with a valid PNG header
 * passes the allow list and every size limit, and against byte counters
 * alone it would pass an unbounded number of times — 14 400 rows a day from one
 * address while the byte counters stood at 115 KiB. A minimum size would only
 * move that number (a complete 1×1 PNG is ~70 bytes), so what is bounded is
 * what is scarce: the count.
 *
 * **Per address ⊕ form, never per form.** A cap a stranger's traffic can reach
 * is a lever with which a third party switches off an organisation's registration.
 */
export const UNCLAIMED_BYTES_PER_ADDRESS_FORM = 25 * MIB;
export const UNCLAIMED_FILES_PER_ADDRESS_FORM = 20;

/**
 * What one address may upload **per hour, across all forms** — 100 MiB and 60
 * files (ADR-0014 no. 7, counters 3 and 4).
 *
 * 100 MiB is four times a complete answer with ten attachments: an address may
 * submit four times an hour what is already the outermost honest case, and a
 * script is not served. What it does **not** bound is the distributed case — a
 * thousand addresses are a thousand allowances — and nothing here pretends
 * otherwise; the alternative would be the lever above.
 */
export const UPLOAD_BYTES_PER_ADDRESS_HOUR = 100 * MIB;
export const UPLOAD_FILES_PER_ADDRESS_HOUR = 60;

/** The window both hourly counters slide over. */
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/**
 * The largest single file this application accepts anywhere.
 *
 * Derived rather than written down again: it is what every limit *in front of*
 * the application has to clear — the `client_max_body_size` of the nginx front
 * door above all, whose default of 1 MiB would otherwise reject an upload with
 * its own HTML page instead of our readable message (ADR-0014 no. 18). The
 * guard test in `nginx-body-limit.test.ts` compares the two, so the two
 * spellings cannot drift.
 */
export const MAX_UPLOAD_BYTES = Math.max(
  MAX_ATTACHMENT_BYTES,
  MAX_TENANT_LOGO_BYTES,
);
