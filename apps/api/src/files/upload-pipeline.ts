import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  BadRequestException,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  FILE_REF_BYTES,
  FILE_SIGNATURE_BYTES,
  detectContentType,
  fileNameSchema,
  isAllowedContentType,
  type UploadContentType,
} from '@formsache/shared';

import type { FileStorage } from './file-storage';
import { imageMetadataStripper } from './image-metadata';
import { readBodyHead } from './request-body';

/**
 * **The one upload chain, used twice** (ADR-0014 no. 4, 5, 14 — the requirements).
 *
 * There are two routes in this application that take bytes from a caller: the
 * public attachment of an answer (`public/public-uploads.service.ts`) and the
 * Logo of an organisation (`tenant-admin/tenant-logo.service.ts`). They differ in
 * everything *around* the bytes — one is sessionless and rate-limited per
 * address, the other sits behind the whole guard chain and carries the CSRF
 * header; one writes an unclaimed `response_attachment`, the other replaces a
 * `tenant_logo` and the column that points at it — and in **nothing about the
 * bytes themselves**.
 *
 * So the bytes live here, once. That is not tidiness: every line below is a
 * decision of ADR-0014 that a second, hand-written copy would restate slightly
 * differently, and the differences are invisible until they are exploited —
 * a signature checked at the wrong offset, a limit applied after the body
 * arrived, a row marked `stored` before `put()` returned. The Logo route is
 * the second caller, and it was written by **giving this module a second
 * caller** rather than by copying the first one.
 *
 * What stays with the callers, because it genuinely differs: the *order* in
 * which the envelope, the target and the quota are consulted (each route's own
 * refusal chain), the wording of a refusal, and everything about the row.
 */

/**
 * The header the file name travels in — **percent-encoded** (ADR-0014 no. 10).
 *
 * A header is a latin-1 byte string by the letter of HTTP, and „Nachweis
 * Müller.pdf" is not one. Percent-encoding is the same escape the answer uses
 * on the way out (`filename*=UTF-8''…`, RFC 6266), so the name has one encoding
 * in both directions instead of two conventions that meet in the middle.
 *
 * The name is **data**, never a path (no. 4): the storage key is the row's id.
 */
export const FILE_NAME_HEADER = 'x-file-name';

/**
 * The one content type an upload route accepts (ADR-0014 no. 14).
 *
 * **Not a formality.** An HTML form can only ever send
 * `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
 * so a route that *demands* `application/octet-stream` is grammatically
 * unreachable for a foreign form — the same property `bodyParser: false` was
 * bought for in `app-setup.ts`, and the reason there is no multipart parser
 * anywhere in this application. It is also what keeps `express.json` off these
 * bodies.
 */
const REQUIRED_REQUEST_TYPE = 'application/octet-stream';

/** 415 unless the caller declared {@link REQUIRED_REQUEST_TYPE}. */
export function requireRequestType(value: string | undefined): void {
  // `application/octet-stream; charset=…` is nonsense but legal to send; the
  // media type is what these routes decide on.
  const mediaType = (value ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== REQUIRED_REQUEST_TYPE) {
    throw new UnsupportedMediaTypeException(
      `Der Upload muss als ${REQUIRED_REQUEST_TYPE} gesendet werden.`,
    );
  }
}

/** The percent-decoded name, through the shared schema — or 400. */
export function requireFileName(encoded: string | undefined): string {
  if (encoded === undefined) {
    throw new BadRequestException(
      `Der Dateiname fehlt (Kopfzeile ${FILE_NAME_HEADER}).`,
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // A malformed escape is the caller's own header, so saying so is not an
    // oracle about anything of ours.
    throw new BadRequestException(
      `Der Dateiname in ${FILE_NAME_HEADER} ist nicht prozent-kodiert.`,
    );
  }
  const parsed = fileNameSchema.safeParse(decoded);
  if (!parsed.success) {
    // Rejected, never sanitised (no. 10): a cleaned-up name would be a second
    // opinion about what a name is, and the two differ exactly where it counts.
    throw new BadRequestException('Der Dateiname wird nicht angenommen.');
  }
  return parsed.data;
}

/**
 * A declared length above the per-file limit, refused before a byte is read.
 *
 * **A courtesy, not the mechanism.** The counter inside {@link storeUpload}
 * decides; a caller who omits or forges `Content-Length` meets it there.
 */
export function refuseDeclaredLength(
  value: string | undefined,
  maxBytes: number,
): void {
  const declared = Number(value);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeException(tooLargeMessage(maxBytes));
  }
}

/** „Die Datei ist zu groß. Erlaubt sind höchstens N MB je Datei." */
export function tooLargeMessage(maxBytes: number): string {
  return `Die Datei ist zu groß. Erlaubt sind höchstens ${String(megabytes(maxBytes))} MB je Datei.`;
}

/** 16 bytes of CSPRNG, base64url — the alphabet and length of a slug (no. 9). */
function mintFileRef(): string {
  return randomBytes(FILE_REF_BYTES).toString('base64url');
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * The row half of an upload — **the caller's**, because the row is where the
 * two routes differ completely.
 *
 * An interface rather than a Prisma delegate, and that is what keeps this
 * module out of the database: the public path reaches its rows through
 * `PrismaService` (it has no session to derive a scope from, the fourth entry
 * of the allow-list in `eslint.config.js`), the Logo route through the
 * `TenantScope` the guard chain hands in. Neither can be expressed as the
 * other, and `apps/api/src/files/**` is deliberately **not** on that allow-list
 * (the counter-check the ninth entry names).
 */
export interface UploadRowStore {
  /**
   * The row, **before** the bytes (no. 4). Answers the id, which is also the
   * storage key.
   */
  create(data: {
    readonly publicRef: string;
    readonly fileName: string;
    readonly contentType: UploadContentType;
  }): Promise<{ readonly id: string }>;

  /** The row is a file now: `status = 'stored'`, `byte_size` measured. */
  /**
   * The bytes have landed. `publicRef` travels along because the Logo path
   * adopts in the very same transaction (`markLogoStoredAndAdopt`): the two
   * used to be separate statements with a `tenant_logo` row that nobody named
   * in between, and nothing collects such a row.
   */
  markStored(id: string, byteSize: number, publicRef: string): Promise<void>;

  /** The write failed — take the row with it. Best effort; see below. */
  discard(id: string): Promise<void>;
}

/** What an accepted upload left behind. */
export interface StoredUpload {
  readonly id: string;
  readonly publicRef: string;
  readonly fileName: string;
  readonly contentType: UploadContentType;
  readonly byteSize: number;
}

const logger = new Logger('UploadPipeline');

/**
 * Signature → row → bytes → `stored` (ADR-0014 no. 4 and no. 5).
 *
 * ## The order is the decision
 *
 * 1. the **signature** on the first eight bytes — before a row exists and long
 *    before anything is written. The **content**, never the extension and never
 *    the `Content-Type` the caller sent: both of those belong to whoever
 *    uploaded the file, and only one of the three was measured;
 * 2. the **row**, whose id becomes the storage key. A reference is minted here
 *    and is deliberately *not* the key, so an address can be rotated without
 *    moving bytes (no. 9);
 * 3. `put()` **with the ceiling**, so the stream is torn down at the limit
 *    rather than after the body has arrived. A `Content-Length` that lies
 *    changes nothing: the counter counts what it is handed rather than what it
 *    was promised (the requirement — „eine Grenze, die erst nach dem vollständigen
 *    Empfang greift, ist keine");
 * 4. `stored`.
 *
 * Row before bytes, because the two abort points are not symmetric: a **row
 * without bytes** is visible, purgeable and a clean 404, while **bytes without
 * a row** are unfindable — the seam has no `list()` (no. 1) — and would outlive
 * every deletion promise the concept makes.
 *
 * `FileTooLargeError` travels **out** rather than being translated here: the
 * two routes owe their callers different sentences for it (the public one has a
 * per-address quota whose ceiling is often the smaller number, so „erlaubt sind
 * 10 MB" would be a plain falsehood there), and a message written for one of
 * them would be wrong on the other.
 *
 * ## What it does not do
 *
 * No virus scan and no content inspection — Konzept no. 61 rejects both, and
 * **As the ADR already notes**, magic bytes establish only the
 * beginning, not the rest. What protects the application is the way a file is
 * delivered (no. 11).
 *
 * **Image metadata has been removed since 2026-08-12** (* `image-metadata.ts`) — and that is no exception to the sentence above,
 * but something else: data minimization instead of checking. A phone photo
 * regularly carries GPS coordinates, and this path handed them through
 * unchanged to the editor. What is removed are whole named blocks; the image data
 * itself runs through byte by byte, PDF stays untouched, and what the
 * reader does not understand goes on unchanged.
 */
export async function storeUpload(
  storage: FileStorage,
  rows: UploadRowStore,
  input: {
    readonly body: Readable;
    readonly fileName: string;
    /** Which of the two allow lists applies — Logo or attachment (no. 5). */
    readonly list: readonly UploadContentType[];
    /** The ceiling handed to `put()`; never above the per-file limit. */
    readonly maxBytes: number;
    /** What a caller is told when the content is not on {@link input.list}. */
    readonly rejectedTypeMessage: string;
  },
): Promise<StoredUpload> {
  const { head, body } = await readBodyHead(input.body, FILE_SIGNATURE_BYTES);

  const contentType = detectContentType(head);
  if (!isAllowedContentType(input.list, contentType)) {
    throw new UnsupportedMediaTypeException(input.rejectedTypeMessage);
  }

  const publicRef = mintFileRef();
  const row = await rows.create({
    publicRef,
    fileName: input.fileName,
    contentType,
  });

  /**
   * **Between the pipe and the storage, not before and not after** .
   *
   * *After* would not work: the bytes would then already lie on the disk and in
   * every backup. *Before*, that is before the type detection, just as little — which
   * reader is responsible is decided by the detected type, not by the claimed one.
   *
   * ⚠️ **The ceiling travels along.** The transformer counts the *input* and
   * throws the same `FileTooLargeError` as the storage; without that, only what
   * remains would count at the back, and a sequence made up entirely of discarded
   * segments would be an unlimited upload over a public path.
   */
  const stripper = imageMetadataStripper(contentType, input.maxBytes);
  const stored = stripper === null ? body : body.pipe(stripper);

  let byteSize: number;
  try {
    const written = await storage.put(row.id, stored, {
      maxBytes: input.maxBytes,
    });
    byteSize = written.bytes;
  } catch (error) {
    // The row is removed rather than left behind: it never had bytes, and
    // „aufräumbar" is not a reason to leave litter this path can clear itself.
    // Failing to clear it is not worth losing the real error over.
    await rows.discard(row.id).catch((cause: unknown) => {
      logger.error(
        `Could not remove the row of a failed upload: ${describe(cause)}`,
      );
    });
    throw error;
  }

  await rows.markStored(row.id, byteSize, publicRef);

  return {
    id: row.id,
    publicRef,
    fileName: input.fileName,
    contentType,
    byteSize,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'unknown error';
}
