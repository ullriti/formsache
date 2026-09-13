import type { Readable } from 'node:stream';

import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  UNCLAIMED_FILE_LIFETIME_MS,
  type ApiEnv,
  type UploadedFile,
} from '@formsache/shared';

import { API_ENV } from '../config/env';
import { FileStorage, FileTooLargeError } from '../files/file-storage';
import {
  FILE_NAME_HEADER,
  refuseDeclaredLength,
  requireFileName,
  requireRequestType,
  storeUpload,
  tooLargeMessage,
} from '../files/upload-pipeline';
import { PrismaService } from '../prisma/prisma.service';
import { PublicFormsService } from './public-forms.service';
import { recordUpload, uploadAllowance, type UploadKey } from './upload-quota';

/**
 * What an accepted upload answers with — **the shared contract**
 * (`uploadedFileSchema` in `@formsache/shared`), re-exported rather than declared a
 * second time here.
 *
 * The browser parses this answer and carries `ref` and `fileName` straight into
 * the answer it submits, so the two halves are one message; a hand-kept
 * interface beside the schema is exactly the parallel description `AGENTS.md`
 * forbids.
 */
export type { UploadedFile };

/**
 * Re-exported so the controller next door keeps one import — the header itself
 * belongs to the shared chain (`files/upload-pipeline.ts`), because the Logo
 * route sends the same one.
 */
export { FILE_NAME_HEADER };

/**
 * **Which form these bytes belong to — the three doors, named** .
 *
 * A discriminated union rather than „slug plus optional token", because they do
 * not merely resolve a form differently, they carry **different refusal
 * chains**:
 *
 * - `'form'` is the public fill-in view. It runs the *submission* chain
 *   (`openForUpload`): unpublished, closed, not yet open, and — the link that
 *   matters here — `password_required` when the form is protected and the proof
 *   is missing.
 * - `'edit'` is the correction of an existing answer. It runs the
 *   *edit* chain (`openForUploadByEditToken`): the one 404 for a token that
 *   names nothing, `editing_disabled`, and the deadline — and **no** password
 *   gate, for the three reasons `byEditToken` writes out. A token holder who
 *   cannot upload a replacement scan could correct every answer *except* the
 *   attachment, which is a hole rather than a restriction.
 * - `'draft'` is a *Zwischenspeichern* resumed (a finding of the acceptance run).
 *   It runs the *draft* chain (`openForUploadByDraftToken`): the same
 *   one 404, plus `saving_disabled` when the switch is off — and no password
 *   gate, for the reasons `byDraftToken` sets out. Without it a resumed draft
 *   could remove its attachment and never replace it, and a draft older than
 *   the purge window with a Pflicht file question could not be submitted at
 *   all.
 *
 * All three chains are the existing ones, called rather than re-implemented: a
 * second reading of „darf dieses Formular gerade etwas annehmen" is the drift
 * this service has no business inventing.
 */
export type UploadTarget =
  | {
      readonly kind: 'form';
      readonly slug: string;
      readonly proof: string | undefined;
    }
  | { readonly kind: 'edit'; readonly token: string }
  | { readonly kind: 'draft'; readonly token: string };

/**
 * What a caller is told when the counters of ADR-0014 no. 7 are spent.
 *
 * It says what happened and what to do, and deliberately **not** which of the
 * four counters it was: „25 MiB warten bereits für dieses Formular" would tell
 * a stranger the shape of the bookkeeping, and none of the four is a number the
 * participant can do anything about beyond submitting or waiting.
 */
const QUOTA_EXHAUSTED_MESSAGE =
  'Es warten bereits zu viele Dateien von dieser Verbindung. Bitte das Formular absenden oder es später erneut versuchen.';

/**
 * The public upload (ADR-0014 no. 4, 5, 6, 7, 8, 14).
 *
 * ## The order of the checks is the decision
 *
 * 1. the **envelope** — request type, file name — because a caller who cannot
 *    name their file has not made an upload;
 * 2. the **form**, through the submission's own refusal chain
 *    (`openForUpload`): unknown, unpublished, password-protected, closed. Bytes
 *    are not written against a registration that is not accepting any;
 * 3. the **quota** (no. 7), which produces a *ceiling* rather than a verdict;
 * 4. the **signature** (no. 5) on the first eight bytes — before a row exists
 *    and long before anything is written;
 * 5. the **row**, then `put()` with that ceiling, then `stored`. That order is
 *    no. 4: a row without bytes is visible, purgeable and a clean 404, while
 *    bytes without a row are unfindable — the seam has no `list()` — and would
 *    outlive every deletion guarantee already in place.
 *
 * **Every limit is in front of the write, and the last one is in front of it
 * *while* it happens**: the allowance is handed to `put()` as `maxBytes`, so the
 * stream is torn down at the limit instead of after the body has arrived. A
 * `Content-Length` that lies changes nothing, because the counter counts what it
 * is handed rather than what it was promised (the requirement — „eine Grenze, die
 * erst nach dem vollständigen Empfang greift, ist keine").
 *
 * ## What it does not do
 *
 * No virus scan, no content inspection, no EXIF stripping — the ADR rejects each
 * of them for the public path, and assumption A4 says what magic
 * bytes do and do not prove: they establish the beginning, not the rest. What
 * protects the application is the way a file is delivered (no. 11).
 */
@Injectable()
export class PublicUploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly forms: PublicFormsService,
    /**
     * Only for the waiting-room window below — the environment carries the
     * purge cadence, and the quota's ceiling is only true if it waits for it.
     */
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async upload(input: {
    readonly target: UploadTarget;
    readonly requestType: string | undefined;
    readonly encodedFileName: string | undefined;
    readonly declaredLength: string | undefined;
    readonly key: UploadKey;
    readonly body: Readable;
  }): Promise<UploadedFile> {
    requireRequestType(input.requestType);
    const fileName = requireFileName(input.encodedFileName);

    // The form decides whether these bytes may exist at all — resolved through
    // the chain of the door this upload came in by, so „geschlossen" means the
    // same thing to the upload and to the answer it belongs to
    // ({@link UploadTarget}).
    const form = await this.openFor(input.target);

    // A declared length above the per-file limit is refused before a single
    // byte is read. It is a courtesy, not the mechanism: the counter below
    // decides, and a caller who omits or forges this header meets it there.
    refuseDeclaredLength(input.declaredLength, MAX_ATTACHMENT_BYTES);

    // **Deadline plus cadence, not the deadline alone.** An unclaimed file is
    // gone when the purge has taken it, and the purge runs on its interval; a
    // tracker that forgot at the deadline let one address leave twice the
    // documented twenty files and fifty megabytes on the volume (a review
    // finding). A cadence of `0` switches the purge off, and then no window makes
    // the ceiling honest — the setting is a development opt-out.
    const allowance = uploadAllowance(
      input.key,
      MAX_ATTACHMENT_BYTES,
      UNCLAIMED_FILE_LIFETIME_MS + Math.max(0, this.env.FILE_PURGE_INTERVAL_MS),
    );
    if (allowance === null) {
      throw new PayloadTooLargeException(QUOTA_EXHAUSTED_MESSAGE);
    }

    let stored;
    try {
      stored = await storeUpload(
        this.storage,
        {
          // From the resolved form, never from the request: the participant
          // says which form, and the form says which Organisation.
          create: (data) =>
            this.prisma.file.create({
              data: {
                tenantId: form.tenantId,
                formId: form.id,
                kind: 'response_attachment',
                publicRef: data.publicRef,
                fileName: data.fileName,
                contentType: data.contentType,
              },
              select: { id: true },
            }),
          markStored: async (id, byteSize) => {
            await this.prisma.file.update({
              where: { id },
              data: { status: 'stored', byteSize },
            });
          },
          discard: async (id) => {
            await this.prisma.file.delete({ where: { id } });
          },
        },
        {
          body: input.body,
          fileName,
          list: ATTACHMENT_CONTENT_TYPES,
          maxBytes: allowance,
          rejectedTypeMessage:
            'Diese Datei wird nicht angenommen. Erlaubt sind PDF, PNG und JPEG — geprüft wird der Inhalt der Datei, nicht ihre Endung.',
        },
      );
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        // **Two sentences, because there are two reasons.** The ceiling handed
        // to `put()` is the *smaller* of the per-file limit and what this
        // address has left (no. 7), so „diese Datei ist zu groß, erlaubt sind
        // 10 MB" would be a plain falsehood for a two-megabyte file from a
        // caller whose waiting room is nearly full — and a participant cannot
        // act on a number that does not describe their situation.
        //
        // The number is a documented constant, not a secret. What is *not* in
        // here is the path, the key or the storage's own words (assumption A1).
        throw new PayloadTooLargeException(
          error.maxBytes < MAX_ATTACHMENT_BYTES
            ? QUOTA_EXHAUSTED_MESSAGE
            : tooLargeMessage(MAX_ATTACHMENT_BYTES),
        );
      }
      throw error;
    }

    recordUpload(input.key, stored.publicRef, stored.byteSize);

    return {
      ref: stored.publicRef,
      fileName: stored.fileName,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
    };
  }

  /**
   * The door decides the refusal chain — one `switch`, exhaustive, so a fourth
   * kind added to {@link UploadTarget} is a compile error here rather than a
   * door that silently inherits somebody else's rules.
   */
  private openFor(
    target: UploadTarget,
  ): Promise<{ id: string; tenantId: string }> {
    switch (target.kind) {
      case 'form':
        return this.forms.openForUpload(target.slug, target.proof);
      case 'edit':
        return this.forms.openForUploadByEditToken(target.token);
      case 'draft':
        return this.forms.openForUploadByDraftToken(target.token);
    }
  }
}
