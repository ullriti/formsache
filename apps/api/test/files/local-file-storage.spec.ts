import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { LocalFileStorage } from '../../src/files/local-file-storage';

/**
 * What only the shipped adapter can be asked — the two things the shared
 * contract cannot state because the in-memory double has no filesystem.
 *
 * 1. **The startup check of ADR-0014 no. 2.** A volume that did not come up has
 *    to stop the start, not turn into a 500 during the one hour a registration
 *    is open. Everything below is the *form* of the configured value, checked
 *    where the adapter lives — the same cut `decodeSecretBoxKey()` makes.
 * 2. **The fan-out of no. 4**, so no directory collects a hundred thousand
 *    entries, and the storage key is the row's `id` rather than anything a
 *    caller sent.
 */

function throwawayDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'formsache-storage-'));
}

describe('LocalFileStorage.verifyRoot — a volume that did not come up stops the start', () => {
  it('accepts a directory that exists and is writable', async () => {
    const root = throwawayDirectory();
    try {
      await expect(
        new LocalFileStorage(root).verifyRoot(),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The case this whole check exists for: `docker compose` mounts a named
   * volume, the mount fails or the path is wrong, and the directory is simply
   * not there. It is **not** created on the fly — a directory that appears by
   * itself hides exactly this.
   */
  it('refuses a directory that does not exist', async () => {
    const root = join(throwawayDirectory(), 'never-mounted');
    await expect(new LocalFileStorage(root).verifyRoot()).rejects.toThrow(
      /does not exist/,
    );
    // …and it stayed absent.
    await expect(stat(root)).rejects.toThrow();
  });

  it('refuses a path that is a file rather than a directory', async () => {
    const root = throwawayDirectory();
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'x');
    try {
      await expect(new LocalFileStorage(file).verifyRoot()).rejects.toThrow(
        /not a directory/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The container case, and the one that would otherwise show up as „alle Tests
   * grün, erster Upload 500": a named volume on a path the image does not have
   * is created root-owned while the process runs as `node`.
   *
   * Skipped for uid 0, where `W_OK` succeeds on a directory with mode 000 and
   * the assertion would be about the test runner rather than about the check.
   */
  it.skipIf(process.getuid?.() === 0)(
    'refuses a directory it cannot write to',
    async () => {
      const root = throwawayDirectory();
      chmodSync(root, 0o500);
      try {
        await expect(new LocalFileStorage(root).verifyRoot()).rejects.toThrow(
          /not writable/,
        );
      } finally {
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  /**
   * A relative path is three different directories: this process is started
   * from the repository root, from `apps/api` (`pnpm dev`) and from `/app` (the
   * container). „Wohin personenbezogene Anlagen geschrieben werden" must not
   * depend on the working directory of whoever started it.
   */
  it('refuses a relative path', async () => {
    await expect(
      new LocalFileStorage('var/files').verifyRoot(),
    ).rejects.toThrow(/absolute/);
  });
});

describe('LocalFileStorage — the layout on disk (ADR-0014 Nr. 4)', () => {
  it('fans the id out over two levels and names the file after it', async () => {
    const root = throwawayDirectory();
    try {
      const storage = new LocalFileStorage(root);
      await storage.verifyRoot();

      const id = randomUUID();
      const hex = id.replaceAll('-', '');
      await storage.put(id, Readable.from([Buffer.from('inhalt')]), {
        maxBytes: 64,
      });

      expect(await readdir(root)).toStrictEqual([hex.slice(0, 2)]);
      expect(await readdir(join(root, hex.slice(0, 2)))).toStrictEqual([
        hex.slice(2, 4),
      ]);
      // The file is named after the row, **not** after what somebody uploaded:
      // a file name is data (no. 10) and never part of a path.
      expect(
        await readdir(join(root, hex.slice(0, 2), hex.slice(2, 4))),
      ).toStrictEqual([id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * „bricht ab **und hinterlässt nichts**" from the disk's point of view: the
   * contract test proves the key cannot be opened, this one proves there is no
   * half-written file left under any name — the `.partial` included.
   */
  it('leaves no partial file behind when the limit is exceeded', async () => {
    const root = throwawayDirectory();
    try {
      const storage = new LocalFileStorage(root);
      await storage.verifyRoot();

      const id = randomUUID();
      const hex = id.replaceAll('-', '');
      await expect(
        storage.put(id, Readable.from([Buffer.alloc(4096)]), { maxBytes: 8 }),
      ).rejects.toThrow();

      expect(
        await readdir(join(root, hex.slice(0, 2), hex.slice(2, 4))),
      ).toStrictEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
