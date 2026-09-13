import { access, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type OnModuleInit } from '@nestjs/common';

import {
  FileNotFoundError,
  FileStorage,
  FileTooLargeError,
  type PutOptions,
  type PutResult,
} from './file-storage';

/**
 * The shipped adapter: a directory on a volume (ADR-0014, Konzept no. 5 rejected
 * S3-as-default explicitly).
 *
 * **This is the only file in the application that knows a file has a path.**
 * Everything else holds a {@link FileStorage} and a key — which is what
 * the requirement means by „kein Code außerhalb dieser Naht weiß, *wo* eine
 * Datei liegt", and what makes the in-memory double in the tests possible
 * without changing a line of production code.
 *
 * Deliberately **not** `@Injectable()`: the directory is configuration, so this
 * class is constructed by the factory in `FileStorageModule` and never by the
 * container. A `useClass` would fail at startup with a DI error about a
 * `String` parameter, and the missing decorator is what says so.
 */
export class LocalFileStorage extends FileStorage implements OnModuleInit {
  constructor(private readonly root: string) {
    super();
  }

  /**
   * Checks the configured directory **at startup** — the same cut
   * `decodeSecretBoxKey()` makes: the *form* of a configured value is checked
   * where the thing that needs it lives, not in the shared schema (ADR-0014
   * no. 2).
   *
   * A volume that did not come up is a start-up failure this way, instead of a
   * 500 during the one hour it matters — the hour an organisation opens its
   * Jahrestagung registration and a participant tries to attach a proof.
   *
   * **Restated from the ADR, where somebody will meet it:**
   * `access(W_OK)` is a smoke test, not a guarantee. POSIX ACLs, a volume
   * remounted read-only later, or a full disk all pass here and still fail on
   * write. That case stays a runtime error — with a category, and without the
   * path in the answer.
   */
  async onModuleInit(): Promise<void> {
    await this.verifyRoot();
  }

  async verifyRoot(): Promise<void> {
    // Absolute, because a relative path means „irgendwo unterhalb des
    // Arbeitsverzeichnisses", and this process is started from the repository
    // root (`node apps/api/dist/main.js`), from `apps/api` (`pnpm dev`) and
    // from `/app` (the container). Three working directories are three
    // different storage locations for the same configuration — and personal
    // attachments would be written to whichever one happened to be current.
    if (!isAbsolute(this.root)) {
      throw new Error(
        `FILE_STORAGE_DIR must be an absolute path, got "${this.root}"`,
      );
    }

    const stats = await stat(this.root).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        throw new Error(
          `FILE_STORAGE_DIR does not exist: "${this.root}". It is not created ` +
            'on the fly — a directory that appears by itself would hide the ' +
            'case this check exists for: a volume that failed to mount.',
        );
      }
      throw error;
    });

    if (!stats.isDirectory()) {
      throw new Error(`FILE_STORAGE_DIR is not a directory: "${this.root}"`);
    }

    await access(this.root, fsConstants.W_OK).catch(() => {
      throw new Error(
        `FILE_STORAGE_DIR is not writable by this process: "${this.root}". ` +
          'In the container image the directory is created and handed to ' +
          '`node` before `USER node` — a named volume on a path the image ' +
          'does not have would be owned by root.',
      );
    });
  }

  protected async putObject(
    key: string,
    source: Readable,
    options: PutOptions,
  ): Promise<PutResult> {
    const target = this.pathFor(key);
    const temporary = `${target}.partial`;
    await mkdir(dirname(target), { recursive: true });

    let bytes = 0;
    // The counter sits **around** the stream, not behind it (ADR-0014 no. 6):
    // the moment one byte too many arrives the pipeline is torn down, so a
    // caller cannot fill a volume by lying about `Content-Length`. What lands
    // on disk until then is the `.partial` file, and it is removed below.
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          callback(new FileTooLargeError(options.maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      const handle = await open(temporary, 'w');
      // The write stream owns the handle and closes it when it is destroyed —
      // measured on Node 22, because a leaked descriptor per aborted upload on
      // a route strangers reach is a slow denial of service rather than a
      // tidiness question.
      await pipeline(source, counted, handle.createWriteStream());
    } catch (error) {
      // „bricht ab **und hinterlässt nichts**" — the contract test measures
      // this by opening the key afterwards, not by looking at the directory.
      await rm(temporary, { force: true });
      throw error;
    }

    // Only now does the key exist: a reader either sees the complete file or
    // nothing at all, never a truncated one. Same-directory rename, so this is
    // one filesystem operation and not a copy.
    await rename(temporary, target);
    return { bytes };
  }

  protected async openObject(key: string): Promise<Readable> {
    const handle = await open(this.pathFor(key), 'r').catch(
      (error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          throw new FileNotFoundError();
        }
        throw error;
      },
    );
    // Opened first, then streamed: `createReadStream(path)` would report a
    // missing file as an `error` event on a stream the caller already holds,
    // and a caller that forgot to listen would see an empty download instead
    // of a 404.
    return handle.createReadStream();
  }

  protected async removeObject(key: string): Promise<void> {
    // `force` makes the unknown key a no-op — the idempotence the two deletion
    // orders of ADR-0014 no. 15/16 rely on when they are retried. The empty
    // fan-out directories are left behind on purpose: removing them would race
    // with a concurrent `put()` into the same prefix, and two empty
    // directories cost nothing.
    //
    // **Both names, because `putObject` writes two** (a security review).
    // A process that dies mid-upload — OOM, a deploy, `SIGKILL` — leaves
    // `<key>.partial` with a participant's bytes in it. The purge would then
    // take the row twenty-four hours later and never the file, and with no
    // `list()` on this seam nothing could ever find it again: personal data the
    // application has declared deleted, sitting on the volume for good. The
    // second `rm` costs one syscall on a path that is almost never there.
    const target = this.pathFor(key);
    await rm(target, { force: true });
    await rm(`${target}.partial`, { force: true });
  }

  /**
   * `<root>/ab/cd/<id>` — two levels of fan-out from the id's own hex
   * (ADR-0014 no. 4).
   *
   * Without it a single directory would collect every file of the
   * installation, and a directory with a hundred thousand entries is slow to
   * open on every filesystem and painful to look at on all of them.
   *
   * `join` cannot escape `root` here, and the reason is upstream rather than
   * in this line: {@link FileStorage} has already rejected anything that is not
   * a UUID literal, so there is no `..` and no separator left to work with.
   */
  private pathFor(key: string): string {
    const hex = key.replaceAll('-', '');
    return join(this.root, hex.slice(0, 2), hex.slice(2, 4), key);
  }
}

/** Node's I/O errors carry `code`; `unknown` is how they arrive in a catch. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
