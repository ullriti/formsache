import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  UNCLAIMED_BYTES_PER_ADDRESS_FORM,
  UNCLAIMED_FILES_PER_ADDRESS_FORM,
  UNCLAIMED_FILE_LIFETIME_MS,
  UPLOAD_BYTES_PER_ADDRESS_HOUR,
  UPLOAD_FILES_PER_ADDRESS_HOUR,
  UPLOAD_WINDOW_MS,
} from '@formsache/shared';

import {
  recordUpload,
  releaseUploads,
  resetUploadQuota,
  uploadAllowance,
  type UploadKey,
} from './upload-quota';

/**
 * The four counters of ADR-0014 no. 7 — the cheap, deterministic half of
 * the requirement.
 *
 * The endpoint's own suite (`test/public/upload.spec.ts`) proves that the
 * allowance reaches `put()` as `maxBytes`, i.e. that the limit holds *while*
 * the body arrives. This file states the arithmetic those numbers come from,
 * including the two properties that are easy to get wrong and invisible from
 * outside: the **count** dimension, and the fact that one address ⊕ form bucket
 * cannot spend another's.
 */

const alpha: UploadKey = { address: '198.51.100.1', bucket: '198.51.100.1|A' };
const alphaOther: UploadKey = {
  address: alpha.address,
  bucket: '198.51.100.1|B',
};
const stranger: UploadKey = {
  address: '198.51.100.2',
  bucket: '198.51.100.2|A',
};

let refs = 0;
const ref = (): string => `ref-${String((refs += 1))}`;

describe('the upload quota (ADR-0014 Nr. 7)', () => {
  beforeEach(() => {
    resetUploadQuota();
  });

  it('hands out the per-file limit when nothing is waiting', () => {
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });

  /**
   * **The allowance shrinks**, which is what makes counter 1 hold before the
   * write rather than after it: what is left is handed to `put()` as its limit.
   */
  it('shrinks the ceiling by what is already waiting for this form', () => {
    recordUpload(alpha, ref(), UNCLAIMED_BYTES_PER_ADDRESS_FORM - 1000);

    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBe(1000);
  });

  it('refuses outright once nothing is left', () => {
    recordUpload(alpha, ref(), UNCLAIMED_BYTES_PER_ADDRESS_FORM);
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBeNull();
  });

  /**
   * **The count dimension, and the reason it exists.** An 8-byte file with a
   * valid PNG header passes the allow list and every size limit; against
   * byte counters alone it would pass an unbounded number of times, and what
   * fills up is the inode table and the `file` table rather than the volume.
   *
   * *reproduction:* drop the file counters and keep only the bytes → this test
   * goes red while every byte assertion above stays green.
   */
  it('bounds the number of waiting files, however small they are', () => {
    for (let i = 0; i < UNCLAIMED_FILES_PER_ADDRESS_FORM; i += 1) {
      recordUpload(alpha, ref(), 8);
    }

    // 160 bytes in total — no byte counter would have noticed.
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBeNull();
  });

  it('bounds the number of uploads per address and hour across forms', () => {
    for (let i = 0; i < UPLOAD_FILES_PER_ADDRESS_HOUR; i += 1) {
      // Spread over enough buckets that counters 1 and 2 never fire — what is
      // measured here is the hourly one.
      recordUpload(
        { address: alpha.address, bucket: `bucket-${String(i)}` },
        ref(),
        8,
      );
    }

    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBeNull();
    // Somebody else is untouched: every counter is per address, so nobody can
    // spend another caller's allowance (the rule, bullet 5).
    expect(uploadAllowance(stranger, MAX_ATTACHMENT_BYTES)).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });

  it('bounds the bytes per address and hour across forms', () => {
    recordUpload(
      { address: alpha.address, bucket: 'elsewhere' },
      ref(),
      UPLOAD_BYTES_PER_ADDRESS_HOUR - 500,
    );

    // The hourly counter is now the binding one, below both the per-file limit
    // and what this form's own bucket would allow.
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBe(500);
  });

  it('forgets what left the hourly window', () => {
    const longAgo = Date.now() - UPLOAD_WINDOW_MS - 1000;
    recordUpload(
      { address: alpha.address, bucket: 'elsewhere' },
      ref(),
      UPLOAD_BYTES_PER_ADDRESS_HOUR,
      longAgo,
    );

    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });

  /**
   * **The waiting room waits for the purge, not merely for the deadline**
   * (the trash-purge review).
   *
   * „Its window *is* the lifetime" was true of the constant and false of the
   * volume: the purge runs on its cadence, so with the shipped daily interval
   * an abandoned upload sits there for up to forty-eight hours while the
   * tracker forgot it after twenty-four. One address could therefore leave
   * twice the documented ceiling lying about — a number that reads as a promise
   * and was not one.
   *
   * *reproduction:* pass `UNCLAIMED_FILE_LIFETIME_MS` as the window (the old
   * behaviour) → the second assertion hands out a full allowance and is red.
   */
  it('keeps counting a file the purge cannot have collected yet', () => {
    const cadence = 24 * 60 * 60 * 1000;
    const window = UNCLAIMED_FILE_LIFETIME_MS + cadence;
    // Past the deadline, but the purge's next run is still ahead of it.
    const uploadedAt = Date.now() - UNCLAIMED_FILE_LIFETIME_MS - 60_000;

    recordUpload(alpha, ref(), UNCLAIMED_BYTES_PER_ADDRESS_FORM, uploadedAt);

    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES, window)).toBeNull();

    // …and once the cadence has passed too, the room is free again.
    expect(
      uploadAllowance(
        alpha,
        MAX_ATTACHMENT_BYTES,
        window,
        Date.now() + cadence + 60_000,
      ),
    ).toBe(MAX_ATTACHMENT_BYTES);
  });

  /**
   * **Claiming frees the waiting room** (no. 13 feeding no. 7).
   *
   * Without this, an organisation's office behind one address that files four
   * registrations with scans would meet „25 MiB je Formular" on the third —
   * a limit whose whole justification is that it bounds *waste* refusing work
   * that produced answers. What still bites afterwards is the hourly counter,
   * and deliberately so: it is not released.
   */
  it('releases the bucket of a file an answer claimed, but not the hour', () => {
    const claimed = ref();
    recordUpload(alpha, claimed, UNCLAIMED_BYTES_PER_ADDRESS_FORM);
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBeNull();

    releaseUploads([claimed]);

    // The form's waiting room is free again…
    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBe(
      MAX_ATTACHMENT_BYTES,
    );
    // …and the hour still remembers: a written byte stays written whether or
    // not an answer owns it. Measured by spending the *rest* of the hour
    // elsewhere — if the release had refunded those 25 MiB, there would still
    // be room here.
    recordUpload(
      { address: alpha.address, bucket: 'elsewhere' },
      ref(),
      UPLOAD_BYTES_PER_ADDRESS_HOUR - UNCLAIMED_BYTES_PER_ADDRESS_FORM,
    );
    expect(
      uploadAllowance(
        { address: alpha.address, bucket: 'fresh' },
        MAX_ATTACHMENT_BYTES,
      ),
    ).toBeNull();
  });

  it('releasing an unknown reference is a no-op', () => {
    expect(() => {
      releaseUploads(['never-seen']);
    }).not.toThrow();
  });

  it('keeps the two forms of one address apart', () => {
    recordUpload(alpha, ref(), UNCLAIMED_BYTES_PER_ADDRESS_FORM);

    expect(uploadAllowance(alpha, MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(uploadAllowance(alphaOther, MAX_ATTACHMENT_BYTES)).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });
});
