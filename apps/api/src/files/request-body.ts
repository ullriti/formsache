import { PassThrough, Readable } from 'node:stream';

/**
 * The first `size` bytes of a request body — **and the body, still complete**
 * (ADR-0014 no. 5, no. 14).
 *
 * The signature check needs the first eight bytes before anything may be
 * written, and `put()` needs all of them afterwards. Reading the whole body
 * into memory first is the shape ADR-0014 rules out in „Alternatives
 * considered" no. 5: nothing bounds concurrency on the public path, so the
 * per-file limit would become „limit × parallel uploads" of RAM.
 *
 * ## Why the body is piped through a `PassThrough` instead of being read
 * directly
 *
 * Because of what happens on a **refusal**. `put()` tears its source down the
 * moment the limit is exceeded, and destroying the request itself would destroy
 * the socket — the caller would see a reset connection instead of the readable
 * 413 that for. With the buffer in between, the torn-down
 * stream is ours: the request stays intact, Node discards whatever is still in
 * flight once the response ends, and the answer arrives.
 *
 * It is also what bounds the memory while the row is being written: the
 * `PassThrough`'s own high-water mark applies backpressure to the socket, so a
 * slow database does not turn into an unbounded buffer.
 */
export interface BodyHead {
  /** At most `size` bytes — fewer only if the body was shorter. */
  readonly head: Buffer;
  /** The body from byte 0, head included. */
  readonly body: Readable;
}

export function readBodyHead(
  source: Readable,
  size: number,
): Promise<BodyHead> {
  const buffered = new PassThrough();
  source.pipe(buffered);
  // `pipe` forwards data, never errors: a client that hangs up mid-upload would
  // otherwise leave this promise pending for as long as the process lives.
  source.on('error', (error: Error) => buffered.destroy(error));
  // And an abort is not always an error. A request the client tears down is
  // *destroyed* rather than ended, so `pipe` never calls `end()` on the buffer
  // and nothing below would ever fire — one pending promise and one open stream
  // per aborted upload, on the route strangers reach. `close` fires either way;
  // `readableEnded` is what tells the clean end from the torn one.
  source.on('close', () => {
    if (!source.readableEnded) {
      buffered.destroy(new Error('the upload was aborted'));
    }
  });

  return new Promise<BodyHead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let seen = 0;

    const cleanUp = (): void => {
      buffered.off('readable', onReadable);
      buffered.off('end', onEnd);
      buffered.off('error', onError);
    };

    const onReadable = (): void => {
      let chunk = buffered.read() as Buffer | null;
      while (chunk !== null) {
        chunks.push(chunk);
        seen += chunk.length;
        if (seen >= size) {
          cleanUp();
          const head = Buffer.concat(chunks);
          // Put back exactly what was taken, so the seam is handed a body that
          // starts at byte 0 — the alternative, concatenating a head onto a
          // rest, is one place where an off-by-one silently truncates a file.
          buffered.unshift(head);
          resolve({ head: head.subarray(0, size), body: buffered });
          return;
        }
        chunk = buffered.read() as Buffer | null;
      }
    };

    const onEnd = (): void => {
      cleanUp();
      // Shorter than the signature it would need: nothing may be unshifted
      // after `end`, so the (tiny, already-read) body is replayed instead.
      const head = Buffer.concat(chunks);
      resolve({ head, body: Readable.from(head.length > 0 ? [head] : []) });
    };

    const onError = (error: Error): void => {
      cleanUp();
      reject(error);
    };

    buffered.on('readable', onReadable);
    buffered.on('end', onEnd);
    buffered.on('error', onError);
  });
}
