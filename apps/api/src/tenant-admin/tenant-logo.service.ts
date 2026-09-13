import type { Readable } from 'node:stream';

import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import {
  MAX_TENANT_LOGO_BYTES,
  TENANT_LOGO_CONTENT_TYPES,
  contentTypeLabels,
  type TenantBrandingSettings,
} from '@formsache/shared';

import { FileStorage, FileTooLargeError } from '../files/file-storage';
import { sweepUnreferencedLogos } from '../files/logo-sweep';
import {
  refuseDeclaredLength,
  requireFileName,
  requireRequestType,
  storeUpload,
  tooLargeMessage,
} from '../files/upload-pipeline';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantBrandingService } from './tenant-branding.service';

/**
 * What an organisation is told when the file it sent is not a logo.
 *
 * The list is read from the constant rather than typed out — „PNG, JPG" is
 * `contentTypeLabels(TENANT_LOGO_CONTENT_TYPES)`, so a caption cannot come to
 * say something wider or narrower than the check (`file-types.ts`).
 *
 * **The sentence names the difference to the other list on purpose.** PDF *is*
 * accepted as an answer's attachment two routes away, it is the same table, and
 * an admin who has just been told „PDF geht" elsewhere deserves the reason
 * rather than a bare refusal.
 */
const REJECTED_TYPE_MESSAGE = `Als Logo werden nur ${contentTypeLabels(
  TENANT_LOGO_CONTENT_TYPES,
).join(
  ' und ',
)} angenommen — geprüft wird der Inhalt der Datei, nicht ihre Endung. SVG und PDF sind ausgeschlossen, weil das Logo in die öffentliche Seite eingebettet wird.`;

/**
 * **The logo upload — beside the selection from the shipped assets**
 * (ADR-0014 no. 12 and no. 15).
 *
 * ## What this route is, in one sentence
 *
 * It is a **replacement**, not a staging area: the bytes, the row and
 * `tenant.logo_ref` are written in one act, so the organisation's Logo is the file it
 * just sent and there is never a stored `tenant_logo` that nobody points at.
 *
 * That shape is the answer to the open point ADR-0014 no. 15 handed to this
 * package. The alternative — upload now, adopt on the next „Speichern" — reads
 * more like the rest of the tab and produces exactly the orphan the ADR has no
 * collector for: the purge touches no Logo, deliberately, so an upload nobody
 * adopted would sit on the volume until the end of the installation. The whole
 * reasoning, including why not a relation column, is in `files/logo-sweep.ts`.
 *
 * ## What it deliberately does *not* remove
 *
 * The selection from the shipped assets stays complete, including the way back:
 * an organisation that saves `{ kind: 'asset' }` or `null` on the *Erscheinungsbild* tab
 * leaves the upload unreferenced, and the same sweep takes it. „Eine Organisation ohne
 * eigenes Logo soll nicht in ein Loch fallen" is a property of the requirement,
 * not a transitional state.
 *
 * ## Two lists, and this one is the narrow one
 *
 * `TENANT_LOGO_CONTENT_TYPES` — **PNG and JPEG**. No PDF, although the
 * attachment list next door has it and both kinds live in one table: a logo
 * is *embedded* into a page strangers open (ADR-0014 no. 5), and
 * „ein Logo ist ein Bild" is the whole of the difference. No SVG either, on
 * neither list, and here for the immediate reason: a script inside one would
 * run in the origin of this application. Both lists stay separate constants so
 * that widening one cannot widen the other by accident.
 *
 * ## The guard chain, and the one difference to the public upload
 *
 * Session → tenant scope → `canManageSettings`, and the CSRF header like every
 * other mutating administration route. The public upload is `@CsrfExempt()`
 * because it authenticates nobody; this one rides a session, so it is not
 * (ADR-0014 no. 14). There is no rate limit beyond the guard chain and no
 * per-address quota: those exist because strangers reach the public path, and
 * the counters of no. 7 are ceilings on **unclaimed** files — a logo is
 * claimed the moment it exists.
 */
@Injectable()
export class TenantLogoService {
  constructor(
    private readonly storage: FileStorage,
    private readonly branding: TenantBrandingService,
  ) {}

  /**
   * Stores the organisation's own logo and makes it the one the pages show.
   *
   * The order is the shared chain's (`files/upload-pipeline.ts`, ADR-0014
   * no. 4) plus the two steps that belong to a logo:
   *
   * 1. envelope — request type and file name;
   * 2. declared length, as a courtesy before a byte is read;
   * 3. signature → row → `put()` with the 2 MiB ceiling → `stored`;
   * 4. **adopt** — `logo_ref` now names this file, and `branding_revision`
   *    moves so a stale tab fails loudly instead of writing the old reference
   *    back over it;
   * 5. **sweep** — whatever the organisation pointed at before is gone, bytes first.
   *
   * Steps 4 and 5 are in this order and not the other way round: sweeping first
   * would take the file the organisation is still showing, and an upload that then
   * failed would leave it with no Logo at all.
   */
  async replaceLogo(
    scope: TenantScope,
    input: {
      readonly requestType: string | undefined;
      readonly encodedFileName: string | undefined;
      readonly declaredLength: string | undefined;
      readonly body: Readable;
    },
  ): Promise<TenantBrandingSettings> {
    requireRequestType(input.requestType);
    const fileName = requireFileName(input.encodedFileName);
    refuseDeclaredLength(input.declaredLength, MAX_TENANT_LOGO_BYTES);

    try {
      await storeUpload(
        this.storage,
        {
          create: (data) => scope.files.createLogo(data),
          // Storing and adopting are **one** transaction (`tenant-scope.ts`):
          // between them the row would be a finished `tenant_logo` that nobody
          // names, and nothing in this application collects such a row.
          markStored: (id, byteSize, publicRef) =>
            scope.files.markLogoStoredAndAdopt(id, byteSize, publicRef),
          discard: (id) => scope.files.deleteLogo(id),
        },
        {
          body: input.body,
          fileName,
          list: TENANT_LOGO_CONTENT_TYPES,
          // The per-file limit **is** the ceiling here: there is no waiting
          // room to share, so the number in the message is always the number
          // that was applied — the ambiguity the public route has to word
          // around does not exist on this one.
          maxBytes: MAX_TENANT_LOGO_BYTES,
          rejectedTypeMessage: REJECTED_TYPE_MESSAGE,
        },
      );
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        throw new PayloadTooLargeException(
          tooLargeMessage(MAX_TENANT_LOGO_BYTES),
        );
      }
      throw error;
    }

    await sweepUnreferencedLogos(scope, this.storage);

    // The whole document, not just the reference: the tab has to adopt the new
    // `revision` in the same step, or its next save answers 409 for a change it
    // made itself.
    return this.branding.read(scope);
  }
}
