import { Readable } from 'node:stream';

import {
  FileNotFoundError,
  FileStorage,
  FileTooLargeError,
  type PutOptions,
  type PutResult,
} from '../../src/files/file-storage';

/**
 * The test double of the storage seam — **and it lives here, in `test/`, on
 * purpose** (proof 1).
 *
 * The requirement says: „ein Doppel der Naht in den Tests speichert im Speicher —
 * wenn dafür Produktivcode geändert werden muss, ist die Naht keine." The
 * strongest way to say that is where the file sits. Nothing under
 * `apps/api/src/` knows this class exists; it only has to extend
 * {@link FileStorage} and it is a full participant, including the key check,
 * which it inherits rather than repeats.
 *
 * What it buys the later stages is the measurement the requirement asks for: „gemessen am
 * **Storage-Doppel** (welche Bytes es gesehen hat), nicht an einer
 * HTTP-Antwort — eine 413 sagt nichts darüber, was vorher auf die Platte lief."
 * {@link bytesSeen} is that number.
 */
export class InMemoryFileStorage extends FileStorage {
  private readonly objects = new Map<string, Buffer>();

  /**
   * How many bytes this double has **read**, across all writes — including the
   * ones it then refused to keep.
   *
   * The distinction is the whole point: a limit that is enforced after the body
   * has been received is not a limit, and the only way to tell
   * the two apart is to count what the storage was handed, not what it stored.
   */
  bytesSeen = 0;

  /** What is stored under `key`, or `undefined`. For assertions only. */
  read(key: string): Buffer | undefined {
    return this.objects.get(key);
  }

  /** How many objects are stored — the „hinterlässt nichts" of a failed put. */
  get size(): number {
    return this.objects.size;
  }

  protected async putObject(
    key: string,
    source: AsyncIterable<Buffer>,
    options: PutOptions,
  ): Promise<PutResult> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.length;
      this.bytesSeen += chunk.length;
      if (bytes > options.maxBytes) {
        // Nothing is written — the same promise the real adapter keeps by
        // removing its `.partial` file. Both are measured by the same contract
        // test, which is the only reason a double proves anything.
        throw new FileTooLargeError(options.maxBytes);
      }
      chunks.push(chunk);
    }
    this.objects.set(key, Buffer.concat(chunks));

    const gate = this.putGate;
    if (gate !== undefined) {
      this.putGate = undefined;
      gate.arrived();
      await gate.wait;
    }
    return { bytes };
  }

  // The two below are `Promise`-returning without being `async`: there is
  // nothing to await in memory, and an `async` without an `await` is what the
  // linter rightly objects to. The signatures still match the seam exactly.

  protected openObject(key: string): Promise<Readable> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      // A distinguishable failure, never an empty stream: „die Zeile gibt es,
      // die Bytes fehlen" must not reach anybody as a truncated download.
      return Promise.reject(new FileNotFoundError());
    }
    return Promise.resolve(Readable.from([stored]));
  }

  /**
   * Makes the next `remove()` reject — a volume that went away mid-run.
   *
   * Here rather than in a subclass of one suite, because **two** packages rest
   * on what happens then: the purge („eine Zeile bleibt stehen, der Lauf
   * geht weiter") and the Logo sweep, whose error handling was
   * asserted in three paragraphs of comment and measured by nothing until the
   * reviews said so.
   */
  failNextRemoval(): void {
    this.failRemovalAfter(0);
  }

  /**
   * Makes the removal **after** `successes` further ones reject — the volume
   * going away part-way through a multi-file deletion.
   *
   * It exists because {@link failNextRemoval} cannot see the case a review
   * finding is about: with one attachment, „nothing was deleted" and „the
   * row was not deleted" are the same sentence. Only from the second file
   * onwards do they come apart — one file gone for good, the answer still
   * there, and a message that used to claim otherwise.
   */
  failRemovalAfter(successes: number): void {
    this.failNext = true;
    this.survivingRemovals = successes;
  }

  private failNext = false;
  private survivingRemovals = 0;
  private putGate: Gate | undefined;
  private removeGate: Gate | undefined;

  /**
   * Parks the **next** `remove()` until the returned gate is released — the
   * window in which a purge holds its row lock or a Logo sweep runs
   * against a concurrent write.
   */
  holdNextRemoval(): HeldGate {
    const [gate, held] = openGate();
    this.removeGate = gate;
    return held;
  }

  /** Forgets every arrangement — for an `afterEach` that must not leak one. */
  resetArrangements(): void {
    this.failNext = false;
    this.survivingRemovals = 0;
    this.putGate = undefined;
    this.removeGate = undefined;
  }

  /**
   * Parks the **next** `put()` after it has read the body and before it
   * returns, so a test can act in the window between the row being written
   * `pending` and its `status` being set.
   *
   * That window is where two separate reviews found the sweep deleting an upload
   * in flight; it is also the only way to make „the row was gone when we tried
   * to store it" happen on purpose.
   */
  holdNextPut(): HeldGate {
    const [gate, held] = openGate();
    this.putGate = gate;
    return held;
  }

  protected async removeObject(key: string): Promise<void> {
    const gate = this.removeGate;
    if (gate !== undefined) {
      this.removeGate = undefined;
      gate.arrived();
      await gate.wait;
    }
    if (this.failNext) {
      if (this.survivingRemovals > 0) {
        this.survivingRemovals -= 1;
      } else {
        this.failNext = false;
        throw new Error('storage unavailable');
      }
    }
    // Idempotent, like `rm --force`: the deletion orders of ADR-0014 no. 15
    // and no. 16 may be interrupted and retried.
    this.objects.delete(key);
  }
}

interface Gate {
  readonly arrived: () => void;
  readonly wait: Promise<void>;
}

/** What a caller of `holdNext…` gets: „it arrived" and „carry on". */
interface HeldGate {
  readonly arrived: Promise<void>;
  readonly release: () => void;
}

function openGate(): [Gate, HeldGate] {
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return [
    { arrived: arrive, wait },
    { arrived, release },
  ];
}
