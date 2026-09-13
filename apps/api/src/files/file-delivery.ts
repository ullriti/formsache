import { NotFoundException, StreamableFile } from '@nestjs/common';
import {
  deliverableContentType,
  type UploadContentType,
} from '@formsache/shared';

import {
  contentDisposition,
  type DispositionType,
} from './content-disposition';
import { FileNotFoundError, type FileStorage } from './file-storage';

/**
 * **The one way bytes leave this application** (ADR-0014 no. 11) — shared by
 * the two retrieval routes precisely because their *rules* differ.
 *
 * The Logo is public and embedded (`inline`, the Logo list), an attachment
 * is behind the whole guard chain and never embedded (`attachment`, the
 * attachment list). What must **not** differ is everything below: the type is
 * derived from a list rather than handed on, a miss is a 404 rather than an
 * invention, and `nosniff` travels either way. Two copies of that would be two
 * places to narrow and one to forget — the lesson `branding.ts` opens with.
 *
 * ## Three properties, and each of them is a decision
 *
 * 1. **The `Content-Type` is fixed, never the stored one.** The stored value is
 *    a *key* into the caller's list and what comes back is the list's own
 *    constant ({@link deliverableContentType}). Both kinds live in one table
 *    and the attachment list contains `application/pdf`, so a `tenant_logo`
 *    carrying that type is expressible through a raw write — it answers **404**
 *    here, not 415 and not `application/octet-stream`.
 * 2. **The name is escaped, not trusted** (`content-disposition.ts`).
 * 3. **No transaction spans the delivery.** The row is read and the read is
 *    over; only then are the bytes opened and streamed. That is a lesson
 *    learned before, where two interactive transactions held the database open across an
 *    SMTP dialogue — a download of ten megabytes over a mobile connection is
 *    the same shape and lasts longer. Nothing in this function takes a
 *    transaction, and nothing that calls it may hold one open across the call.
 */
export interface DeliverableFile {
  /** The storage key — the row's `id`, never the reference (no. 4). */
  readonly id: string;
  /** The original name, as data (no. 10). */
  readonly fileName: string;
  /** The **measured** type in the column, used here only as a key (no. 5). */
  readonly contentType: string;
}

export interface DeliveryRule {
  /** Which of the two allow lists this route delivers under (no. 5). */
  readonly list: readonly UploadContentType[];
  /** `attachment` or `inline` — the difference between the two routes. */
  readonly disposition: DispositionType;
  /**
   * The one refusal of this route, byte for byte.
   *
   * Handed in rather than derived, because „byte-gleich mit einem erfundenen
   * Verweis" is a property of the *route*: whatever this function refuses has
   * to be indistinguishable from what the route answers for a reference that
   * names nothing at all.
   */
  readonly notFound: string;
}

export async function deliverFile(
  storage: FileStorage,
  file: DeliverableFile,
  rule: DeliveryRule,
): Promise<StreamableFile> {
  const type = deliverableContentType(rule.list, file.contentType);
  if (type === null) {
    // No. 11(a): „alles andere → 404", byte-identical to an invented
    // reference. A distinct status here would be a second answer for „gibt es
    // nicht so" and therefore an oracle.
    throw new NotFoundException(rule.notFound);
  }

  let bytes;
  try {
    bytes = await storage.open(file.id);
  } catch (cause) {
    if (cause instanceof FileNotFoundError) {
      // The crash window of no. 4 — a row whose bytes were never written, or
      // whose bytes the purge removed between this read and now. „Eine Zeile
      // ohne Bytes ist beim Abruf ein sauberer 404", and the seam makes that
      // distinguishable from an empty stream on purpose.
      throw new NotFoundException(rule.notFound);
    }
    throw cause;
  }

  return new StreamableFile(bytes, {
    type,
    disposition: contentDisposition(rule.disposition, file.fileName),
  });
}
