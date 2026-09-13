import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { TENANT_LOGO_CONTENT_TYPES, isFileRef } from '@formsache/shared';

import { deliverFile } from '../files/file-delivery';
import { FileStorage } from '../files/file-storage';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one refusal of the public Logo route — **one message for every reason**.
 *
 * An invented reference, a malformed one, a reference naming an attachment, a
 * row whose bytes were never written, a `tenant_logo` carrying a type off the
 * Logo list: all of them answer this, with the same status. Five reasons and
 * one answer, because a caller who can tell them apart has an oracle over rows
 * they may not know exist.
 */
export const FILE_NOT_FOUND_MESSAGE = 'Diese Datei wurde nicht gefunden.';

/**
 * The public Logo retrieval (ADR-0014 no. 11a).
 *
 * ## Why this is allowed to hold a `PrismaService`
 *
 * `apps/api/src/public/**` is the fourth entry on the allow-list in
 * `eslint.config.js`, and the argument there covers this file exactly: there is
 * **no session** on this path, so there is no membership to derive a
 * `TenantScope` from. What binds the query instead is the reference — 16 bytes
 * of CSPRNG, unique across the installation — and the row it resolves supplies
 * its own tenant. The tenant is never a parameter the caller controls, which is
 * the property that entry exists to protect.
 *
 * **The retrieval needs no new entry**, and that is deliberate: ADR-0014
 * foresees exactly one further one, and it belongs to the purge.
 *
 * ## `kind = 'tenant_logo'` is in the `where`, not in an `if`
 *
 * No. 11a: „Liefert ausschließlich Zeilen mit `kind = 'tenant_logo'`". As a
 * condition of the statement, an attachment reference resolves to nothing here
 * — the same answer as an invented one, from the same code path. A check after
 * the load would be a second place where „welche Art Datei ist das" is decided,
 * and the `CHECK` constraint plus the `BEFORE UPDATE` trigger on `file`
 * (ADR-0014 no. 3) are what keep the column itself honest.
 */
@Injectable()
export class PublicLogoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
  ) {}

  async byRef(ref: string): Promise<StreamableFile> {
    // Bounded and spelled before the database sees it, for the reason
    // `isPublicSlug` carries: a percent escape is decoded before this line,
    // `%00` arrives as a NUL byte, PostgreSQL refuses U+0000 in `text`, and the
    // query throws — a **500 where every unknown address answers 404**, i.e.
    // the oracle this closes.
    if (!isFileRef(ref)) {
      throw new NotFoundException(FILE_NOT_FOUND_MESSAGE);
    }

    const file = await this.prisma.file.findFirst({
      where: {
        publicRef: ref,
        kind: 'tenant_logo',
        // A row whose bytes were never written (the crash window of no. 4) is
        // not a Logo yet. Excluded here so the answer is the ordinary 404
        // rather than a truncated image.
        status: 'stored',
        // **And the organisation still has to name it** (ADR-0014 no. 19: „ein
        // `tenant_logo` existiert genau so lange, wie `tenant.logo_ref` es
        // benennt"). The row was the whole condition until a security review,
        // which measured what that costs when the sweep's `remove()`
        // fails: the row is then left standing on purpose (no. 16), and this
        // sessionless route went on delivering a Logo the organisation had already
        // withdrawn — for good, if that organisation never touched its appearance
        // again. Asking the reference makes withdrawal effective at once and
        // independent of whether the bytes could be collected, which is what
        // no. 19 says in the first place.
        // **And the organisation must still be there** — the sibling of filter 5 of
        // the requirement, on the second sessionless route: a public byte
        // retrieval bound to `tenant`, so leaving it out keeps a deleted organisation's
        // Logo served from an address anybody who once opened its form has
        // written down.
        //
        // This condition is **not** one of the six documented filters, and until
        // a security review the line here claimed it „is
        // measured here anyway" — which was false: no test named it, and it
        // could have been deleted without a single case going red. It now has
        // one, beside the other five, in `test/admin/tenant-trash.spec.ts`
        // („filter 5 — the public Logo of a deleted Organisation answers 404").
        tenant: { logoRef: ref, deletedAt: null },
      },
      select: { id: true, fileName: true, contentType: true },
    });
    if (file === null) {
      throw new NotFoundException(FILE_NOT_FOUND_MESSAGE);
    }

    // The read is over before a single byte is opened — no transaction spans
    // the delivery (`files/file-delivery.ts`, and a lesson learned before).
    return deliverFile(this.storage, file, {
      // The **Logo** list: PNG and JPEG. `application/pdf` is on the other
      // list, it is the same table, and a `tenant_logo` carrying it answers 404
      // instead of being invented into `octet-stream` (no. 11a).
      list: TENANT_LOGO_CONTENT_TYPES,
      disposition: 'inline',
      notFound: FILE_NOT_FOUND_MESSAGE,
    });
  }
}
