/**
 * Captures everything the process writes to `stdout` and `stderr`.
 *
 * Two requirements need this and neither can be satisfied by reading a logger mock:
 *
 * - One promises the „kein Mailserver" notice **once**. A `toContain` stays
 *   green when the sentence is printed on every send, so the assertion has to
 *   be a *count* — over the startup and several worker runs together.
 * - The other promises the SMTP credentials land in no log. The only honest way to
 *   check „no log" is to take everything that was written, over a full cycle of
 *   queueing, sending, failing and retrying, and search it.
 *
 * Both patch the real streams rather than `console`, because Nest's logger
 * writes straight to `process.stdout.write` and would sail past a `console`
 * spy. Output is forwarded to the original stream as well, so a failing test is
 * still debuggable.
 */

export interface StdioCapture {
  /** Everything written since the capture started. */
  readonly text: () => string;
  /** How often `needle` occurs in it. */
  readonly countOf: (needle: string) => number;
  /** Restores the original streams. Safe to call twice. */
  readonly restore: () => void;
}

type Write = typeof process.stdout.write;

export function captureStdio(): StdioCapture {
  const chunks: string[] = [];
  const originals: {
    readonly stream: NodeJS.WriteStream;
    readonly write: Write;
  }[] = [];

  for (const stream of [process.stdout, process.stderr]) {
    // Bound rather than referenced: `write` needs its stream as `this`, and a
    // bare method reference would lose it the moment it is called through the
    // patched slot.
    const original = stream.write.bind(stream);
    originals.push({ stream, write: original });
    const forward = original as unknown as (...args: unknown[]) => boolean;
    const patched: Write = (
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): boolean => {
      chunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk),
      );
      return forward(chunk, encoding, callback);
    };
    stream.write = patched;
  }

  let restored = false;
  return {
    text: () => chunks.join(''),
    countOf: (needle: string) => {
      if (needle === '') {
        return 0;
      }
      return chunks.join('').split(needle).length - 1;
    },
    restore: () => {
      if (restored) {
        return;
      }
      restored = true;
      for (const { stream, write } of originals) {
        stream.write = write;
      }
    },
  };
}
