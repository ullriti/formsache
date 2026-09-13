import { Transform, type TransformCallback } from 'node:stream';

import type { UploadContentType } from '@formsache/shared';

import { FileTooLargeError } from './file-storage';

/**
 * **Removing location data from uploaded images** (ADR-0014).
 *
 * A phone photo regularly carries GPS coordinates in the EXIF block, plus device,
 * serial number and time of capture. Up to this point this application passed them
 * on to the processor unchanged — and the record of processing activities
 * did not mention it, because nobody had noticed. That is not a
 * security hole but the opposite of data minimisation: the participant
 * who attaches a photo to their registration knows nothing about it.
 *
 * ## What this here is **not**
 *
 * ⚠️ **No content inspection and no virus protection.** Concept no. 61 expressly
 * rejected both, and this file changes nothing about that: it reads the
 * *frame structure* of an image and throws away named blocks. What is inside an
 * image it does not check — what protects the application is still the
 * manner of delivery (ADR-0014 no. 11: `nosniff`, `Content-Disposition`,
 * own origin).
 *
 * ⚠️ **No re-encoding.** The image data themselves are **passed through byte for
 * byte**; only whole segments or chunks are removed. Re-encoding an image
 * would mean pulling a library with a native part into the public
 * fill-out path and changing the quality of an attachment that somebody
 * deliberately uploaded that way.
 *
 * ## Why an unexpected byte leads to **passing through** instead of rejecting
 *
 * The goal is data minimisation, not enforcement. An image whose structure
 * this reader does not understand is, after the allowlist and the
 * signature check, still a permitted image — rejecting it would mean letting a
 * registration fail at an encoder that *we* do not know.
 * If the rest thus stays unchanged, the result is exactly today's state
 * and never a broken image. The price is named: in that case nothing is
 * removed.
 *
 * ## Streaming, not buffered
 *
 * An attachment may be 10 MB, and the path that accepts it is
 * **public**. Putting the whole image into memory in order to edit it
 * would turn a rate limit into a memory limit. What is buffered is therefore only
 * the *current head* in each case — with JPEG a segment (at most 64 kB), with PNG
 * eight bytes of chunk header; the large chunks (`IDAT`) run through unbuffered.
 */

/** JPEG: segments without a length field — they carry nothing that would be removed. */
const JPEG_STANDALONE = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
]);

/**
 * The segments that are removed — and why **only** these.
 *
 * - `APP1` with `Exif\0\0`: the block with GPS, device and time of capture.
 * - `APP1` with the XMP namespace: the same data in Adobe's XML form,
 *   regularly present **in addition**. Whoever removes only EXIF does not remove the
 *   coordinates.
 * - `APP13`: Photoshop IRB with IPTC — carries place, author and caption.
 *
 * **Stays:** `APP0` (JFIF — resolution, belongs to the display) and `APP2`
 * (ICC colour profile; without it an image looks different in a browser than it did for the
 * sender). Neither is a statement about a human being.
 */
const JPEG_APP1 = 0xe1;
const JPEG_APP13 = 0xed;
const JPEG_SOS = 0xda;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');

/**
 * PNG: the text and EXIF chunks.
 *
 * `eXIf` is the official place since 2017; `tEXt`/`zTXt`/`iTXt` are the
 * text chunks in which cameras and image editors deposit the same thing once
 * more. Everything else — above all `IHDR`, `PLTE`, `IDAT`, `IEND` — stays,
 * otherwise it would no longer be an image.
 */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

/**
 * The transform for this content type, or `null` if there is nothing to do.
 *
 * `null` for `application/pdf`: a PDF carries metadata of its own, and removing
 * them would mean understanding its structure — exactly the content inspection that
 * concept no. 61 rejected. That is named as a residual risk and not tacitly
 * left out.
 */
export function imageMetadataStripper(
  contentType: UploadContentType,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Transform | null {
  switch (contentType) {
    case 'image/jpeg':
      return new JpegMetadataStripper(maxBytes);
    case 'image/png':
      return new PngMetadataStripper(maxBytes);
    default:
      return null;
  }
}

/**
 * A transform that piles up bytes until it has enough for the next
 * decision.
 *
 * The subclasses write {@link step}: it gets the buffer, returns
 * whether it was able to do something, and advances by itself. If it cannot, the
 * transform waits for more bytes — and at the end of the stream out goes what
 * is still there. That way a truncated image also ends as what it is,
 * instead of as an exception.
 */
abstract class ChunkedStripper extends Transform {
  /**
   * **The upper bound applies to the *input*, not to the result — and without it
   * this transform would be a hole.**
   *
   * `FileStorage.put` caps what is **written**. If this transform stands
   * in front of it, only what is left over counts there: a sequence of
   * ten thousand empty `APP1` segments writes almost nothing and would therefore
   * never run into `FileTooLargeError` — an unbounded upload over a
   * **public** path, built out of the attempt to minimise data.
   * Counting therefore happens here, on the way in.
   */
  private seen = 0;

  protected buffer: Buffer = Buffer.alloc(0);
  /** As soon as this is true, everything further runs through unchanged. */
  protected passThrough = false;
  /** This many bytes of the running block still to pass through or discard. */
  protected pending = 0;
  protected dropping = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.seen += chunk.length;
    if (this.seen > this.maxBytes) {
      // The same exception as the store, so that both paths produce the same
      // sentence — the route does not distinguish which edge it was at.
      done(new FileTooLargeError(this.maxBytes));
      return;
    }
    if (this.passThrough) {
      this.push(chunk);
      done();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.consume()) {
        /* keep going as long as a decision was possible */
      }
    } catch (error: unknown) {
      done(error instanceof Error ? error : new Error('stripper failed'));
      return;
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    // What is left goes out: a truncated image stays truncated
    // and is not additionally mutilated here.
    if (this.buffer.length > 0 && !this.dropping) {
      this.push(this.buffer);
    }
    this.buffer = Buffer.alloc(0);
    done();
  }

  /** Consumes as much of the buffer as the running block still needs. */
  private consume(): boolean {
    if (this.pending > 0) {
      const take = Math.min(this.pending, this.buffer.length);
      if (take === 0) {
        return false;
      }
      if (!this.dropping) {
        this.push(this.buffer.subarray(0, take));
      }
      this.buffer = this.buffer.subarray(take);
      this.pending -= take;
      if (this.pending === 0) {
        this.dropping = false;
      }
      return true;
    }
    return this.step();
  }

  /**
   * A decision at the start of the buffer, or `false` if bytes are still
   * missing for it.
   */
  protected abstract step(): boolean;

  /** Everything further unchanged — the exit for "I do not understand this". */
  protected giveUp(): boolean {
    this.passThrough = true;
    this.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    return false;
  }
}

class JpegMetadataStripper extends ChunkedStripper {
  private started = false;

  protected step(): boolean {
    if (!this.started) {
      if (this.buffer.length < 2) {
        return false;
      }
      if (this.buffer[0] !== 0xff || this.buffer[1] !== 0xd8) {
        return this.giveUp();
      }
      this.push(this.buffer.subarray(0, 2));
      this.buffer = this.buffer.subarray(2);
      this.started = true;
      return true;
    }

    if (this.buffer.length < 2) {
      return false;
    }
    if (this.buffer[0] !== 0xff) {
      // No segment start where one ought to be: this reader is at its
      // limit, and the image goes on unchanged.
      return this.giveUp();
    }
    const marker = this.buffer[1] ?? 0;
    if (JPEG_STANDALONE.has(marker)) {
      this.push(this.buffer.subarray(0, 2));
      this.buffer = this.buffer.subarray(2);
      return true;
    }
    if (marker === JPEG_SOS) {
      // From here on come the entropy-coded image data, in which `FF` is no
      // longer a segment start. Everything further unchanged.
      return this.giveUp();
    }
    if (this.buffer.length < 4) {
      return false;
    }
    const length = this.buffer.readUInt16BE(2);
    if (length < 2) {
      return this.giveUp();
    }
    const total = 2 + length;
    if (marker === JPEG_APP1) {
      // The header is enough for the decision; the segment itself may still be
      // incomplete.
      if (
        this.buffer.length < 4 + XMP_HEADER.length &&
        this.buffer.length < total
      ) {
        return false;
      }
      const payload = this.buffer.subarray(
        4,
        Math.min(total, this.buffer.length),
      );
      const drop =
        payload.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER) ||
        payload.subarray(0, XMP_HEADER.length).equals(XMP_HEADER);
      return this.begin(total, drop);
    }
    return this.begin(total, marker === JPEG_APP13);
  }

  /** Begins a block of known length — pass through or discard. */
  private begin(total: number, drop: boolean): boolean {
    this.dropping = drop;
    this.pending = total;
    return true;
  }
}

class PngMetadataStripper extends ChunkedStripper {
  private started = false;

  protected step(): boolean {
    if (!this.started) {
      if (this.buffer.length < 8) {
        return false;
      }
      this.push(this.buffer.subarray(0, 8));
      this.buffer = this.buffer.subarray(8);
      this.started = true;
      return true;
    }
    if (this.buffer.length < 8) {
      return false;
    }
    const length = this.buffer.readUInt32BE(0);
    // By the standard a chunk cannot be larger than 2^31−1; anything above that
    // is not a PNG that this reader should go on interpreting.
    if (length > 0x7fff_ffff) {
      return this.giveUp();
    }
    const type = this.buffer.toString('latin1', 4, 8);
    this.dropping = PNG_DROP.has(type);
    // 4 length + 4 type + data + 4 CRC. The CRC belongs to the chunk, and because
    // always **whole** chunks are removed, none has to be recomputed.
    this.pending = 12 + length;
    return true;
  }
}
