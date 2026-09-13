import type { Readable } from 'node:stream';

import { isUuid } from '../common/uuid';

/**
 * **The one seam between this application and where bytes actually live**
 * (ADR-0014 no. 1).
 *
 * Three methods, and the list of what is deliberately missing is as much the
 * decision as the list of what is here:
 *
 * - **no `list()`** — the purge of ADR-0014 no. 15 works from the *database*,
 *   because a directory listing knows neither a tenant nor an owner, and a
 *   clean-up that starts from the disk is a deletion without any notion of
 *   authorisation. The consequence is carried on purpose: bytes without a row
 *   are unfindable, which is exactly why the row is written first (no. 4);
 * - **no `exists()`** — it would only ever be read as „darf ich das ausliefern",
 *   and that answer belongs to the guard chain and the `file` row, never to the
 *   storage;
 * - **no URL building** — the address of a file is a decision of this
 *   application (no. 9), not of its storage. An adapter that handed out URLs
 *   would be the first step towards pre-signed links, and those travel *past*
 *   the guard chain by design.
 *
 * An abstract class rather than an interface plus a symbol, following
 * `MailClock` and `MailTransport`: NestJS can use the class itself as the
 * injection token, so there is one name instead of a token and a type that can
 * drift apart.
 *
 * ## Why the three public methods delegate to `protected` abstract ones
 *
 * The key check of ADR-0014 no. 4 has to sit **at the seam**, not at the
 * caller: „ein künftiger zweiter Aufrufer erbt sie, statt sie zu vergessen".
 * As a template method, an adapter gets it by existing — it implements
 * `putObject`/`openObject`/`removeObject` and the check has already run.
 *
 * **What that is not: a guarantee.** TypeScript has no `final`, so an adapter
 * *could* override `put` and skip the check — which is precisely why the
 * mechanism is named in two halves rather than claimed in one. The second half
 * is `test/files/file-storage.contract.spec.ts`: it hands every implementation
 * `../../../etc/passwd` through the **public** method, so an override that
 * dropped the check fails there. Neither half alone would do; the base class
 * makes the check the default, the contract makes it a condition of being an
 * adapter at all.
 *
 * `packages/shared` gets none of this: the seam is server-side.
 */
export abstract class FileStorage {
  /**
   * Writes `source` under `key`, at most `maxBytes` of it.
   *
   * The limit is enforced **while** reading, never after: the public upload
   * path is reachable by strangers, and a limit that only applies once the
   * whole body has arrived is not a limit. Exceeding it
   * rejects with {@link FileTooLargeError} and leaves **nothing** behind — the
   * subsequent `open()` fails, which is the property the contract test measures
   * rather than an HTTP status.
   */
  async put(
    key: string,
    source: Readable,
    options: PutOptions,
  ): Promise<PutResult> {
    return this.putObject(requireStorageKey(key), source, options);
  }

  /**
   * Opens the bytes stored under `key`.
   *
   * An unknown key rejects with {@link FileNotFoundError} — a *distinguishable*
   * failure and not an empty stream, so „die Zeile gibt es, die Bytes fehlen"
   * (the crash window of ADR-0014 no. 4) cannot reach a participant as a
   * truncated download that looks like a delivered file.
   */
  async open(key: string): Promise<Readable> {
    return this.openObject(requireStorageKey(key));
  }

  /**
   * Removes the bytes stored under `key`. **Idempotent** — an unknown key is
   * not an error.
   *
   * That is what makes the two deletion orders of ADR-0014 safe to retry: the
   * purge (no. 15) and the physical deletion (no. 16) both remove bytes first and
   * may be interrupted, and a second run must not fail on what the first one
   * already did.
   */
  async remove(key: string): Promise<void> {
    return this.removeObject(requireStorageKey(key));
  }

  protected abstract putObject(
    key: string,
    source: Readable,
    options: PutOptions,
  ): Promise<PutResult>;

  protected abstract openObject(key: string): Promise<Readable>;

  protected abstract removeObject(key: string): Promise<void>;
}

export interface PutOptions {
  /** Hard upper bound; the write is aborted the moment it is exceeded. */
  readonly maxBytes: number;
}

export interface PutResult {
  /** What was actually written — the number the `file` row records. */
  readonly bytes: number;
}

/**
 * The shape a storage key may have: the `id` of the `file` row, and nothing
 * else (ADR-0014 no. 4).
 *
 * Not the file name — that one belongs to whoever uploaded it (no. 10) — and
 * not the `public_ref`, because a reference that is also a path could never be
 * rotated without moving bytes.
 *
 * **The rejection is the point, not the normalisation.** `../../../etc/passwd`
 * is refused rather than cleaned up: a normaliser turns a broken caller into a
 * silently working one, and the next path shape somebody invents gets the same
 * treatment. Anything that is not a UUID literal is a programming error here,
 * so it fails loudly and locally.
 */
export function requireStorageKey(key: string): string {
  if (!isUuid(key)) {
    throw new InvalidStorageKeyError();
  }
  return key;
}

/**
 * A key that is not a `file` id.
 *
 * Carries no path and not even the offending key: this is thrown on a path that
 * strangers reach, and an error message is the one place a rejected value
 * reliably ends up in a log (keine personenbezogenen Daten in
 * Logs).
 */
export class InvalidStorageKeyError extends Error {
  constructor() {
    super('storage key must be the id of a file row');
    this.name = 'InvalidStorageKeyError';
  }
}

/**
 * Nothing is stored under this key.
 *
 * Deliberately its own class: callers have to be able to answer 404 for it
 * while a genuine I/O failure stays a 500. The key is *not* in the message —
 * see {@link InvalidStorageKeyError} — and neither is the path, so a mounted
 * volume's layout cannot travel outwards through an error (ADR-0014).
 */
export class FileNotFoundError extends Error {
  constructor() {
    super('no bytes stored under this key');
    this.name = 'FileNotFoundError';
  }
}

/**
 * The write exceeded `maxBytes` and was aborted; nothing was kept.
 *
 * The limit that produced it is named — it is a documented constant, not a
 * secret, and „zu groß" without a number is the kind of message a participant
 * cannot act on.
 */
export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file exceeds the limit of ${String(maxBytes)} bytes`);
    this.name = 'FileTooLargeError';
  }
}
