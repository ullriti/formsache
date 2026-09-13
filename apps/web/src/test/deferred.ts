/**
 * A promise the test resolves by hand.
 *
 * What it is for: the race of the requirement only exists **while a save is in
 * flight**. A `fetch` stub that resolves immediately never produces the window
 * in which somebody keeps typing, so the test would pass against a view that
 * throws the input away. Handing the `PUT` one of these makes that window as
 * long as the test needs.
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let capture: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    capture = resolve;
  });
  if (capture === undefined) {
    // Unreachable: a Promise executor runs synchronously. Checked rather than
    // asserted away, so this file needs no non-null assertion.
    throw new Error('The promise executor did not run synchronously.');
  }
  return { promise, resolve: capture };
}
