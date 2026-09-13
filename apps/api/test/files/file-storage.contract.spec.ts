import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FileNotFoundError,
  FileTooLargeError,
  InvalidStorageKeyError,
  type FileStorage,
} from '../../src/files/file-storage';
import { LocalFileStorage } from '../../src/files/local-file-storage';
import { InMemoryFileStorage } from '../support/in-memory-file-storage';

/**
 * **The shared contract of the storage seam — and it is the actual yield of
 * ADR-0014 no. 1**, not a formality.
 *
 * Two implementations exist so that the upload test suites can measure
 * what an upload wrote without touching a filesystem. A double that only
 * satisfies its own tests proves nothing about the adapter that ships, so both
 * run **this** file — every promise below is a promise of the seam, not of one
 * side of it.
 *
 * The four the ADR names explicitly:
 *
 *   - `put` over `maxBytes` aborts **and leaves nothing** — measured by opening
 *     the key afterwards, not by looking at a directory (one of the two has no
 *     directory);
 *   - `remove` on an unknown key is not an error;
 *   - `open` on an unknown key is a *distinguishable* error, not an empty
 *     stream;
 *   - a key that is not a `file` id is refused **at the seam** — `..` and an
 *     absolute path included — rather than normalised (no. 4).
 */

interface Subject {
  readonly name: string;
  readonly create: () => FileStorage;
}

/** Throwaway directories of the local subject, removed once at the very end. */
const localRoots: string[] = [];

const SUBJECTS: readonly Subject[] = [
  {
    name: 'LocalFileStorage',
    create: () => {
      const root = mkdtempSync(join(tmpdir(), 'formsache-storage-contract-'));
      localRoots.push(root);
      return new LocalFileStorage(root);
    },
  },
  { name: 'InMemoryFileStorage', create: () => new InMemoryFileStorage() },
];

afterAll(() => {
  for (const root of localRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A key of the only shape the seam accepts: the id of a `file` row. */
const key = (): string => randomUUID();

const streamOf = (bytes: Buffer): Readable => Readable.from([bytes]);

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe.each(SUBJECTS)('$name — the storage contract', (subject) => {
  let storage: FileStorage;

  beforeAll(async () => {
    storage = subject.create();
    if (storage instanceof LocalFileStorage) {
      await storage.verifyRoot();
    }
  });

  it('round-trips what it was given and reports the byte count', async () => {
    const id = key();
    const payload = Buffer.from('Nachweis über die Bestandsmeldung');

    const result = await storage.put(id, streamOf(payload), {
      maxBytes: 1024,
    });

    expect(result.bytes).toBe(payload.length);
    await expect(
      collect(await storage.open(id)).then((b) => b.toString()),
    ).resolves.toBe(payload.toString());
  });

  it('accepts a file of exactly maxBytes', async () => {
    const id = key();
    const payload = Buffer.alloc(64, 7);

    await expect(
      storage.put(id, streamOf(payload), { maxBytes: 64 }),
    ).resolves.toStrictEqual({ bytes: 64 });
  });

  /**
   * The load-bearing half of the requirement, at the level where it is a property
   * of the seam rather than of an HTTP route: a limit that is applied after the
   * write is not a limit.
   */
  it('aborts over maxBytes and leaves nothing behind', async () => {
    const id = key();

    await expect(
      storage.put(id, streamOf(Buffer.alloc(65)), { maxBytes: 64 }),
    ).rejects.toBeInstanceOf(FileTooLargeError);

    // The evidence is that the key is *not there*, not that a directory looks
    // tidy — the in-memory double has no directory to look at.
    await expect(storage.open(id)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('answers an unknown key with a distinguishable error, not an empty stream', async () => {
    await expect(storage.open(key())).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it('removes idempotently — an unknown key is not a failure', async () => {
    await expect(storage.remove(key())).resolves.toBeUndefined();

    const id = key();
    await storage.put(id, streamOf(Buffer.from('weg')), { maxBytes: 16 });
    await storage.remove(id);
    await expect(storage.open(id)).rejects.toBeInstanceOf(FileNotFoundError);
    // …and again, because the purge of ADR-0014 no. 15 may be interrupted
    // between removing the bytes and deleting the row, and its next run must
    // not fail on what the last one already did.
    await expect(storage.remove(id)).resolves.toBeUndefined();
  });

  /**
   * ADR-0014 no. 4: the check sits **at the seam**, so a second caller inherits
   * it instead of forgetting it. Both a traversal and an absolute path are
   * refused — and refused, not normalised: a normaliser turns a broken caller
   * into a silently working one.
   */
  describe.each([
    ['a traversal', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a bare file name', 'scan.pdf'],
    ['a key with a separator', `${randomUUID()}/../${randomUUID()}`],
    ['an empty key', ''],
  ])('refuses %s as a key', (_label, bad) => {
    it('on put, open and remove alike', async () => {
      await expect(
        storage.put(bad, streamOf(Buffer.from('x')), { maxBytes: 16 }),
      ).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.open(bad)).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      );
      await expect(storage.remove(bad)).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      );
    });
  });

  it('keeps the rejected key out of the error message', async () => {
    // A storage key is not personal data — but a *file name* is the thing most
    // likely to be handed in as one by mistake, and it can carry a person's
    // name. The rejection therefore says what is wrong and not what it saw
    // (nothing personal belongs in logs).
    const looksPersonal = 'Mueller_Attest.pdf';
    const error: unknown = await storage
      .open(looksPersonal)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(InvalidStorageKeyError);
    expect((error as Error).message).not.toContain(looksPersonal);
  });
});

/**
 * One thing the contract cannot state, because only one of the two has a
 * filesystem: that a refused key wrote nothing **anywhere on disk**.
 *
 * The assertion above („put rejects") would also hold for an adapter that
 * created the file first and threw afterwards.
 */
describe('LocalFileStorage — nothing reaches the filesystem past the seam', () => {
  it('writes nothing outside its root, and nothing at all for a bad key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'formsache-storage-escape-'));
    try {
      const storage = new LocalFileStorage(root);
      await storage.verifyRoot();

      await expect(
        storage.put('../escaped', streamOf(Buffer.from('x')), {
          maxBytes: 16,
        }),
      ).rejects.toBeInstanceOf(InvalidStorageKeyError);

      expect(await readdir(root)).toStrictEqual([]);

      // …and a good key does land inside, so the emptiness above is a result
      // and not an adapter that writes nowhere at all.
      const id = randomUUID();
      await storage.put(id, streamOf(Buffer.from('drin')), { maxBytes: 16 });
      expect(await readdir(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * **`remove()` takes the half-written file too** (a security review finding).
   *
   * `putObject` writes `<key>.partial` and renames it, so a process that dies
   * mid-upload leaves that name behind with a participant's bytes in it. The
   * purge deletes the row a day later and would never have touched the file:
   * with no `list()` on this seam nothing could find it again — personal data
   * the application has declared deleted, staying on the volume for good.
   *
   * *Reproduction:* remove the second `rm` in `removeObject` → the leftover
   * survives and this case is red.
   */
  it('removes a half-written file the same key left behind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'formsache-storage-partial-'));
    try {
      const storage = new LocalFileStorage(root);
      await storage.verifyRoot();

      const id = randomUUID();
      await storage.put(id, streamOf(Buffer.from('ganz')), { maxBytes: 16 });

      // The crash, reproduced by its residue: the same name `putObject` uses.
      const target = join(root, id.slice(0, 2), id.slice(2, 4), id);
      writeFileSync(`${target}.partial`, 'halb');

      await storage.remove(id);

      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.partial`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
