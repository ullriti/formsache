import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { ATTACHMENT_CONTENT_TYPES, isFileRef } from '@formsache/shared';

import type { FormRestriction } from '../tenancy/form-restriction';
import type { TenantScope } from '../tenancy/tenant-scope';
import { deliverFile } from './file-delivery';
import { FileStorage } from './file-storage';

/**
 * The one refusal of the attachment route — **one message for every reason**.
 *
 * An invented reference, a malformed one, another organisation's attachment, an
 * unclaimed upload, an answer in the trash, a form the caller is locked
 * out of, a row whose bytes are gone: every one of them answers this, with the
 * same status and the same body. **Never a 403**, because a 403 states that the
 * resource exists and that somebody deliberately locked this person out of it —
 * which is more than „kein Zugriff" has to say and is the oracle the requirements close.
 *
 * A constant of its own rather than the public Logo route's, **although the
 * wording is currently identical** — and the difference is worth stating
 * because it is not visible in the strings. „Byte-gleich" is a property each
 * route has against **its own** invented reference; nothing anywhere depends
 * on the two routes agreeing with each other, and nothing may come to. One
 * shared constant would quietly make „die beiden antworten gleich" a fact
 * somebody could start relying on, and narrowing one route's wording would
 * then be a change to the other.
 */
export const ATTACHMENT_NOT_FOUND_MESSAGE = 'Diese Datei wurde nicht gefunden.';

/**
 * **The attachment of an answer — explicitly not public** (* ADR-0014 no. 11b).
 *
 * Read through `scope.files`, i.e. through the `TenantScope` the guard chain
 * built from a membership the caller holds. There is no `PrismaService` here
 * and there must not be: `apps/api/src/files/**` is not on the allow-list in
 * `eslint.config.js`, the ADR foresees one further entry and it belongs to the
 * purge. The delegate's `where` is the tenant boundary
 * (`tenancy/tenant-scope.ts`), and it is the only one `file` has.
 *
 * ## The fourth link cannot be a guard here, and that is why the check is below
 *
 * `FormRestrictionGuard` reads the form off the *request*, and this request
 * names a **file**. The form hangs two reads further in — on the answer the
 * file was claimed by — so the route declares `@NoFormIdInRequest(…)` and the
 * verdict is reached here, on the row the tenant-bound query just resolved.
 * That is the shape `MailLogService.detail` established for `GET
 * /api/mail-log/:id` (review finding), and the decision is not made a
 * second time: `FormRestriction.verdictFor` is the guard's own evaluation,
 * asked here about a different form id.
 *
 * **Both verdicts answer 404**, unlike in the guard, where a cap is a 403. The
 * difference is what the caller named: there they named a form and already know
 * it exists; here they named a file reference, and a 403 would confirm that a
 * file with this reference exists and belongs to a form they are restricted on.
 */
@Injectable()
export class AttachmentService {
  constructor(private readonly storage: FileStorage) {}

  async byRef(
    scope: TenantScope,
    ref: string,
    restriction: FormRestriction,
  ): Promise<StreamableFile> {
    // Bounded before the database sees it: `%00` arrives decoded as a NUL byte,
    // PostgreSQL refuses U+0000 in `text`, and the query throws — a 500 where
    // every unknown address answers 404 .
    if (!isFileRef(ref)) {
      throw new NotFoundException(ATTACHMENT_NOT_FOUND_MESSAGE);
    }

    const file = await scope.files.findAttachmentByRef(ref);
    if (file === null) {
      // „Gibt es nicht", „gehört einer anderen Organisation", „ist noch nicht
      // beansprucht" and „hängt an einer gelöschten Antwort" are one answer,
      // from one code path.
      throw new NotFoundException(ATTACHMENT_NOT_FOUND_MESSAGE);
    }

    // **Two form ids, and they have to agree.** `file.form_id` is condition 3
    // of the claim (no. 13) and `response.form_id` is the form of the answer
    // that owns the row; no path of this application can make them differ. A
    // raw write can — `file` has no composite foreign key (no. 3) — and the
    // consequence would be a restriction evaluated against the wrong form,
    // i.e. the fourth link asking about a form nobody locked anybody out of.
    // Refused rather than resolved: „welches Formular gilt" is not a question
    // with two answers.
    if (file.formId !== file.responseFormId) {
      throw new NotFoundException(ATTACHMENT_NOT_FOUND_MESSAGE);
    }

    await this.requireUnrestricted(scope, file.responseFormId, restriction);

    // The reads are over; nothing holds a transaction across the stream (a
    // lesson restated in `file-delivery.ts`).
    return deliverFile(this.storage, file, {
      // The **attachment** list — PDF, PNG, JPEG — and the type is derived from
      // it rather than handed on. `attachment`, never `inline`: this file was
      // uploaded by a stranger, and the whole protection of a PDF here is that
      // no browser renders it in our origin (no. 5, no. 11b).
      list: ATTACHMENT_CONTENT_TYPES,
      disposition: 'attachment',
      notFound: ATTACHMENT_NOT_FOUND_MESSAGE,
    });
  }

  /**
   * The fourth link, on the row rather than on the request — the same
   * evaluation `FormRestrictionGuard` reaches, asked about the form the answer
   * belongs to.
   *
   * An administrator's stored restrictions are not read at all:
   * `restrictedUserId()` is the one place that exception becomes a value
   * , so „sieht immer alles" does not depend on
   * what a migration or a hand-edited row put into `form_permission`.
   */
  private async requireUnrestricted(
    scope: TenantScope,
    formId: string,
    restriction: FormRestriction,
  ): Promise<void> {
    const userId = restriction.restrictedUserId();
    if (userId === undefined) {
      return;
    }
    const stored = await scope.formPermissions.findFor(formId, userId);
    const verdict = await restriction.verdictFor(stored, (id) =>
      scope.groups.findById(id),
    );
    if (verdict !== 'open') {
      throw new NotFoundException(ATTACHMENT_NOT_FOUND_MESSAGE);
    }
  }
}
