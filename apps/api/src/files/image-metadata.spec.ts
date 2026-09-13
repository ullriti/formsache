import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { imageMetadataStripper } from './image-metadata';

/**
 * **What disappears from an uploaded image — and what does not** .
 *
 * The fixtures are hand-built byte sequences instead of real photos, and that
 * is deliberate: a photo out of a file proves that *this* photo gets through,
 * a built sequence proves the rule. Every case names the same two questions —
 * is what was expected **gone**, and is everything else **unchanged**.
 */

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** A JPEG segment with a length field: `FF <marker> <len> <payload>`. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function latin1(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

/** A PNG chunk with a valid CRC — the reader must not recompute it. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([latin1(type), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Runs the bytes through the transform — in pieces, like a real upload. */
async function strip(
  contentType: 'image/jpeg' | 'image/png',
  bytes: Buffer,
  pieceSize = 7,
): Promise<Buffer> {
  const stripper = imageMetadataStripper(contentType);
  if (stripper === null) {
    throw new Error('no stripper for this type');
  }
  const pieces: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += pieceSize) {
    pieces.push(bytes.subarray(at, at + pieceSize));
  }
  const source = Readable.from(
    pieces.length === 0 ? [Buffer.alloc(0)] : pieces,
  );
  const [out] = await Promise.all([
    buffer(stripper),
    pipeline(source, stripper as unknown as NodeJS.WritableStream),
  ]);
  return out;
}

describe('imageMetadataStripper — JPEG', () => {
  /**
   * **The case this is about.** The EXIF segment of a phone photo carries the
   * GPS coordinates; here a recognisable string stands in it as a stand-in, so
   * that a failure *shows* what was left over.
   */
  it('entfernt den EXIF-Block und lässt alles andere unverändert', async () => {
    const jfif = segment(0xe0, latin1('JFIF\0 Auflösung'));
    const exif = segment(
      0xe1,
      Buffer.concat([latin1('Exif\0\0'), latin1('GPS 51.2,6.8')]),
    );
    const icc = segment(0xe2, latin1('ICC_PROFILE\0 Farben'));
    const scan = Buffer.concat([
      segment(0xda, latin1('SOS')),
      Buffer.from([0x12, 0xff, 0x00, 0x34]),
      EOI,
    ]);

    const out = await strip(
      'image/jpeg',
      Buffer.concat([SOI, jfif, exif, icc, scan]),
    );

    expect(out.includes(latin1('GPS 51.2,6.8'))).toBe(false);
    expect(out.includes(latin1('Exif\0\0'))).toBe(false);
    // And the other direction, without which the case would prove nothing:
    // **exactly** the image without this one segment — not „anything
    // shorter".
    expect(out.equals(Buffer.concat([SOI, jfif, icc, scan]))).toBe(true);
  });

  /**
   * **XMP carries the same coordinates a second time.** Whoever removes only
   * EXIF does not remove the location — that is the defect this line prevents.
   */
  it('entfernt auch den XMP-Block', async () => {
    const xmp = segment(
      0xe1,
      Buffer.concat([
        latin1('http://ns.adobe.com/xap/1.0/\0'),
        latin1('<x:xmpmeta>51.2,6.8</x:xmpmeta>'),
      ]),
    );
    const out = await strip('image/jpeg', Buffer.concat([SOI, xmp, EOI]));
    expect(out.equals(Buffer.concat([SOI, EOI]))).toBe(true);
  });

  it('entfernt den Photoshop-Block (IPTC, APP13)', async () => {
    const iptc = segment(0xed, latin1('Photoshop 3.0\0 Ort: Bonn'));
    const out = await strip('image/jpeg', Buffer.concat([SOI, iptc, EOI]));
    expect(out.equals(Buffer.concat([SOI, EOI]))).toBe(true);
  });

  /**
   * **JFIF and ICC stay.** Neither says anything about a person, and without
   * the colour profile an image would look different in the browser than at
   * the sender's — altering an attachment is something other than removing a
   * piece of information.
   */
  it('lässt Auflösung und Farbprofil stehen', async () => {
    const keep = Buffer.concat([
      SOI,
      segment(0xe0, latin1('JFIF\0')),
      segment(0xe2, latin1('ICC_PROFILE\0')),
      EOI,
    ]);
    expect((await strip('image/jpeg', keep)).equals(keep)).toBe(true);
  });

  /**
   * **One byte this reader does not understand → everything unchanged.** The
   * goal is data minimisation, not enforcement: letting an image fail on an
   * unknown encoder would mean letting a registration fail on it.
   */
  it.each([
    { name: 'kein JPEG-Anfang', bytes: Buffer.from([1, 2, 3, 4, 5, 6]) },
    {
      name: 'abgeschnitten mitten im Segment',
      bytes: Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00])]),
    },
    {
      name: 'Müll, wo ein Segment beginnen müsste',
      bytes: Buffer.concat([SOI, Buffer.from([0x00, 0x01, 0x02])]),
    },
  ])('reicht durch: $name', async ({ bytes }) => {
    expect((await strip('image/jpeg', bytes)).equals(bytes)).toBe(true);
  });

  /**
   * **The chunking must change nothing.** An upload arrives in packets, and a
   * segment regularly straddles a packet boundary — that is exactly where a
   * reader breaks that takes the buffer for complete.
   */
  it.each([1, 2, 3, 5, 13, 4096])(
    'liefert dasselbe bei %p Byte je Stück',
    async (pieceSize) => {
      const bytes = Buffer.concat([
        SOI,
        segment(0xe0, latin1('JFIF\0')),
        segment(0xe1, Buffer.concat([latin1('Exif\0\0'), latin1('GPS')])),
        EOI,
      ]);
      const out = await strip('image/jpeg', bytes, pieceSize);
      expect(
        out.equals(Buffer.concat([SOI, segment(0xe0, latin1('JFIF\0')), EOI])),
      ).toBe(true);
    },
  );
});

describe('imageMetadataStripper — PNG', () => {
  const ihdr = chunk('IHDR', Buffer.alloc(13));
  const idat = chunk('IDAT', Buffer.from('Bilddaten'));
  const iend = chunk('IEND', Buffer.alloc(0));

  it('entfernt eXIf und die Textchunks, nicht die Bilddaten', async () => {
    const bytes = Buffer.concat([
      PNG_MAGIC,
      ihdr,
      chunk('eXIf', latin1('GPS 51.2,6.8')),
      chunk('tEXt', latin1('Comment\0Bonn')),
      idat,
      chunk('iTXt', latin1('XML:com.adobe.xmp\0')),
      iend,
    ]);

    const out = await strip('image/png', bytes);

    expect(out.includes(latin1('GPS 51.2,6.8'))).toBe(false);
    expect(out.includes(latin1('Bonn'))).toBe(false);
    expect(out.equals(Buffer.concat([PNG_MAGIC, ihdr, idat, iend]))).toBe(true);
  });

  it('lässt ein Bild ohne Metadaten Byte für Byte unverändert', async () => {
    const bytes = Buffer.concat([PNG_MAGIC, ihdr, idat, iend]);
    expect((await strip('image/png', bytes)).equals(bytes)).toBe(true);
  });

  it.each([1, 3, 8, 9, 4096])(
    'liefert dasselbe bei %p Byte je Stück',
    async (pieceSize) => {
      const bytes = Buffer.concat([
        PNG_MAGIC,
        ihdr,
        chunk('tEXt', latin1('Comment\0Bonn')),
        idat,
        iend,
      ]);
      const out = await strip('image/png', bytes, pieceSize);
      expect(out.equals(Buffer.concat([PNG_MAGIC, ihdr, idat, iend]))).toBe(
        true,
      );
    },
  );

  /** An impossible chunk length: pass through instead of guessing. */
  it('reicht durch, wenn eine Chunk-Länge unmöglich ist', async () => {
    const broken = Buffer.concat([
      PNG_MAGIC,
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      latin1('IDAT'),
    ]);
    expect((await strip('image/png', broken)).equals(broken)).toBe(true);
  });
});

describe('imageMetadataStripper — die Obergrenze der Eingabe', () => {
  /**
   * **Without this case the transform would be a hole, not a protection.**
   *
   * `FileStorage.put` caps what is **written**. With the transform in front of
   * it, only what is left over counts there — and a sequence made up of purely
   * *discarded* segments writes almost nothing. An attacker could thereby send
   * arbitrarily much over a **public** path without ever running into
   * `FileTooLargeError`.
   *
   * The case reproduces exactly that: 12 kB of input that becomes 4 bytes of
   * output, against a limit of 1 kB.
   *
   * *Counter-check:* remove the counting in `_transform` → this case goes red,
   * because the transform swallows the bytes without complaint.
   */
  it('scheitert an der Eingabemenge, nicht an der Ausgabemenge', async () => {
    const dropped = segment(
      0xed,
      Buffer.concat([latin1('Photoshop 3.0\0'), Buffer.alloc(1000, 0x41)]),
    );
    const bytes = Buffer.concat([SOI, dropped, dropped, dropped, dropped, EOI]);
    expect(bytes.length).toBeGreaterThan(4000);

    const stripper = imageMetadataStripper('image/jpeg', 1024);
    if (stripper === null) {
      throw new Error('no stripper');
    }
    await expect(
      pipeline(
        Readable.from([bytes]),
        stripper as unknown as NodeJS.WritableStream,
      ),
    ).rejects.toMatchObject({ name: 'FileTooLargeError' });
  });

  /** And below it the same sequence gets through — otherwise the case does not measure the limit. */
  it('lässt dieselbe Folge unter der Grenze durch', async () => {
    const dropped = segment(
      0xed,
      Buffer.concat([latin1('Photoshop 3.0\0'), Buffer.alloc(1000, 0x41)]),
    );
    const bytes = Buffer.concat([SOI, dropped, EOI]);
    const stripper = imageMetadataStripper('image/jpeg', 1024 * 1024);
    if (stripper === null) {
      throw new Error('no stripper');
    }
    const [out] = await Promise.all([
      buffer(stripper),
      pipeline(
        Readable.from([bytes]),
        stripper as unknown as NodeJS.WritableStream,
      ),
    ]);
    expect((out as Buffer).equals(Buffer.concat([SOI, EOI]))).toBe(true);
  });
});

describe('imageMetadataStripper — Zuständigkeit', () => {
  /**
   * **PDF stays untouched, and that is named.** A PDF carries metadata of its
   * own; removing it would mean understanding its structure — exactly the
   * content inspection that concept no. 61 rejected.
   */
  it('gibt für PDF keinen Umformer zurück', () => {
    expect(imageMetadataStripper('application/pdf')).toBeNull();
  });
});
