import {
  UNCLAIMED_BYTES_PER_ADDRESS_FORM,
  UNCLAIMED_FILES_PER_ADDRESS_FORM,
  UNCLAIMED_FILE_LIFETIME_MS,
  UPLOAD_BYTES_PER_ADDRESS_HOUR,
  UPLOAD_FILES_PER_ADDRESS_HOUR,
  UPLOAD_WINDOW_MS,
} from '@formsache/shared';

/**
 * **What the four counters of ADR-0014 no. 7 count** — all of them per address,
 * none of them per form, per organisation or installation-wide.
 *
 * They come in pairs because a volume loses two things:
 *
 * 1. unclaimed **bytes** per address ⊕ form — 25 MiB;
 * 2. unclaimed **files** per address ⊕ form — 20;
 * 3. **bytes** per address and hour — 100 MiB;
 * 4. **files** per address and hour — 60.
 *
 * The count dimension is the one that is easy to leave out and is the reason
 * a review reopened this: an **8-byte file** with a valid PNG header
 * (`89 50 4E 47 0D 0A 1A 0A` and nothing else) passes the allow list and
 * every size limit, and against byte counters alone it goes through an
 * unbounded number of times — ten uploads a minute make 14 400 rows and 14 400
 * inodes per address and day while the byte counters stand at 115 KiB. A
 * minimum size would only move that number (a complete 1×1 PNG is ~70 bytes),
 * so what is bounded is what is scarce: the count.
 *
 * ## Why this is in the process and not in the database
 *
 * The `file` table has **no address column and will not get one**: an IP
 * address is personal data, and storing one next to every upload for the sake
 * of a counter is precisely the data minimisation this application commits to,
 * turned around. So counters 1 and 2 are kept here, next to 3 and 4, which the
 * ADR already puts in the process (assumption A3 — every limit of this
 * application is process-local and a horizontally scaled deployment multiplies
 * all of them).
 *
 * ## „Unbeansprucht" is bookkeeping, not a query — and it is released
 *
 * A file leaves the waiting room in two ways: the answer claims it (no. 13) or
 * the purge takes it after {@link UNCLAIMED_FILE_LIFETIME_MS} (no. 15). The
 * first is told to this tracker — {@link releaseUploads} is called with the
 * references a submission just claimed — and the second is a window.
 *
 * **The window is the deadline *plus one purge cadence*, and that was the
 * second deadline this file used to hide** (a review). „Its window is the
 * lifetime" was true of the constant and false of the disk: the purge does not
 * run at the instant a file expires, it runs on its interval, so with the
 * shipped daily cadence an abandoned upload occupies the volume for anything up
 * to forty-eight hours. The tracker forgot it after twenty-four, and an address
 * could therefore leave twice the documented twenty files and fifty megabytes
 * lying there — a ceiling that reads as a promise and was not one. Forgetting
 * only once the purge can actually have taken it makes the number in
 * `.env.example` true again.
 *
 * With the cadence at `0` the purge is off, nothing collects these files at
 * all, and no window can make the ceiling honest; the setting is a development
 * opt-out and says so where it is documented.
 *
 * ## ⚠️ And ever since drafts may carry attachments, there is a third way out
 * that this counter does not know
 *
 * An attachment that hangs on a **draft** is neither claimed nor collected: it
 * lives as long as the draft does, up to thirty days (see `file.draft_id`). The
 * window here stays „Frist plus eine Purge-Runde", so about two days — the
 * counter **forgets** it afterwards even though it stays lying there. In
 * practice that means: an address can put another 25 MiB into drafts for one
 * form every two days, and the Obergrenze of no. 7 bounds only what is waiting
 * *at the same time*, not what hangs on living drafts altogether.
 *
 * That is **the named price of the decision** („bis zu 30 Tage liegen Bytes
 * eines Teilnehmers auf der Platte") and not a gap that is quietly closed here:
 * pulling the window out to thirty days would hit the honest law office filing
 * four registrations with scans just as hard as a script — the same trade-off
 * the paragraph below makes for releasing.
 *
 * **What bounds the volume instead, since a security review:**
 * a draft owns at most what it **names** —
 * `releaseDraftAttachments` releases everything else on save, and what it can
 * name is bounded by the published version (`maxFiles` per file question).
 * Without that the arithmetic was 15 refills of the waiting room over the
 * lifetime of a draft, so 375 MiB and 300 files per address and form, in
 * **one** draft. What remains and stays honestly written here: the same address
 * can spread the refills over **several** drafts — they cost one slot from
 * `draft-quota.ts` and one `POST` each —, so that the inflow per address and
 * form still stands at 25 MiB every two days. The size of the volume and its
 * monitoring remain an operations matter (ADR-0014 no. 7, last paragraph).
 *
 * **Not releasing would have been the shorter code and the wrong number.** A
 * organisation's office behind one address, filing four registrations with scans for
 * four members, would hit „25 MiB je Formular" on the third one and be
 * told to come back tomorrow — a limit whose whole justification is that it
 * bounds *waste*, refusing work that produced answers. What is left after a
 * release is counter 3, and that one is meant to bite: 100 MiB an hour is four
 * complete answers, deliberately.
 */

/** One entry of the sliding windows: when, how much. */
interface Upload {
  readonly at: number;
  readonly bytes: number;
}

/**
 * What one address has uploaded within the hour — counters 3 and 4.
 *
 * Keyed by {@link clientAddress}'s key, so an IPv6 subscriber is one entry and
 * not 2^64.
 */
const perAddress = new Map<string, Upload[]>();

/** What one address ⊕ form has waiting — counters 1 and 2. */
const perAddressForm = new Map<string, Map<string, Upload>>();

/** Which bucket a reference was recorded in, so a claim can release it. */
const bucketOfRef = new Map<string, string>();

/** At most one sweep a second, whatever the traffic. */
const SWEEP_EVERY_MS = 1_000;
let sweptAt = 0;

function within(entries: readonly Upload[], since: number): Upload[] {
  return entries.filter((entry) => entry.at > since);
}

function sweep(now: number, waitingRoomMs: number): void {
  if (now - sweptAt < SWEEP_EVERY_MS) {
    return;
  }
  sweptAt = now;

  const hourAgo = now - UPLOAD_WINDOW_MS;
  for (const [address, entries] of perAddress) {
    const kept = within(entries, hourAgo);
    if (kept.length === 0) {
      perAddress.delete(address);
    } else {
      perAddress.set(address, kept);
    }
  }

  const lifetimeAgo = now - waitingRoomMs;
  for (const [bucket, refs] of perAddressForm) {
    for (const [ref, entry] of refs) {
      if (entry.at <= lifetimeAgo) {
        refs.delete(ref);
        bucketOfRef.delete(ref);
      }
    }
    if (refs.size === 0) {
      perAddressForm.delete(bucket);
    }
  }
}

/**
 * How many bytes this caller may still write — or `null` for „no room at all".
 *
 * **The answer is a ceiling, not a verdict, and that is what makes the limit
 * hold *before* the write** (ADR-0014 no. 6): it is handed to `put()` as
 * `maxBytes`, so the stream is torn down the moment the allowance is exceeded
 * rather than after the body has arrived. A caller who lies about
 * `Content-Length` changes nothing — the counter decides, and it counts what it
 * was handed.
 *
 * `null` when a *count* is exhausted, because that cannot be expressed as a
 * smaller ceiling: zero bytes is still a file, and the counters of no. 7 exist
 * precisely because tiny files are what fill an inode table.
 *
 * **What this does not do is reserve**, and the consequence is named rather
 * than discovered: two uploads from one address in flight at the same moment
 * both read the same allowance, so an address can exceed a counter by up to the
 * number of requests it has open at once. Reserving would mean booking bytes
 * nobody has sent yet and giving them back on every failure path — more moving
 * parts on the one route strangers reach, to bound an overshoot that is already
 * bounded by the rate limit of no. 8 (ten a minute, address ⊕ form). It is the
 * same shape as the answer-limit's „soft" counterpart in `mailAllowance`, and
 * it is a decision, not an oversight.
 */
export function uploadAllowance(
  key: UploadKey,
  perFileLimit: number,
  /**
   * How long an unclaimed file really occupies the volume — the deadline plus
   * one purge cadence. See the file header: the deadline alone was the second
   * deadline hiding in here.
   */
  waitingRoomMs = UNCLAIMED_FILE_LIFETIME_MS,
  now = Date.now(),
): number | null {
  sweep(now, waitingRoomMs);

  const hourly = within(
    perAddress.get(key.address) ?? [],
    now - UPLOAD_WINDOW_MS,
  );
  if (hourly.length >= UPLOAD_FILES_PER_ADDRESS_HOUR) {
    return null;
  }
  const hourlyBytes = hourly.reduce((sum, entry) => sum + entry.bytes, 0);

  const waiting = [...(perAddressForm.get(key.bucket)?.values() ?? [])];
  if (waiting.length >= UNCLAIMED_FILES_PER_ADDRESS_FORM) {
    return null;
  }
  const waitingBytes = waiting.reduce((sum, entry) => sum + entry.bytes, 0);

  const allowance = Math.min(
    perFileLimit,
    UPLOAD_BYTES_PER_ADDRESS_HOUR - hourlyBytes,
    UNCLAIMED_BYTES_PER_ADDRESS_FORM - waitingBytes,
  );
  return allowance > 0 ? allowance : null;
}

/** Books an upload that was actually written. */
export function recordUpload(
  key: UploadKey,
  ref: string,
  bytes: number,
  now = Date.now(),
): void {
  const entry: Upload = { at: now, bytes };

  perAddress.set(key.address, [
    ...within(perAddress.get(key.address) ?? [], now - UPLOAD_WINDOW_MS),
    entry,
  ]);

  const bucket = perAddressForm.get(key.bucket) ?? new Map<string, Upload>();
  bucket.set(ref, entry);
  perAddressForm.set(key.bucket, bucket);
  bucketOfRef.set(ref, key.bucket);
}

/**
 * These references left the waiting room — the answer claimed them (no. 13).
 *
 * Deliberately keyed by reference rather than by address: the claim happens in
 * the submission's transaction, which knows the form and the files but has no
 * business learning the caller's address for a second purpose. It also means a
 * submission from a *different* address than the upload — a participant who
 * switched from wifi to mobile mid-form — releases the right bucket.
 *
 * The hourly counters are **not** touched: they bound what one address makes
 * this installation write within an hour, and a written byte stays written
 * whether or not an answer owns it.
 */
export function releaseUploads(refs: readonly string[]): void {
  for (const ref of refs) {
    const bucket = bucketOfRef.get(ref);
    if (bucket === undefined) {
      continue;
    }
    bucketOfRef.delete(ref);
    const entries = perAddressForm.get(bucket);
    entries?.delete(ref);
    if (entries?.size === 0) {
      perAddressForm.delete(bucket);
    }
  }
}

/**
 * The two keys one upload is counted under.
 *
 * Built from {@link addressFormKey} rather than assembled here, so „address ⊕
 * form" means the same thing to the rate limit and to these counters — including
 * the per-address ceiling on distinct forms, without which a caller inventing a
 * slug per request would allocate a bucket per request and the quota itself
 * would be the attack.
 */
export interface UploadKey {
  /** The address alone — counters 3 and 4. */
  readonly address: string;
  /** Address ⊕ form — counters 1 and 2. */
  readonly bucket: string;
}

/** Forgets everything — for tests that need to start from nothing. */
export function resetUploadQuota(): void {
  perAddress.clear();
  perAddressForm.clear();
  bucketOfRef.clear();
  sweptAt = 0;
}
