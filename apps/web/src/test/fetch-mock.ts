import type { MockInstance } from 'vitest';
import { vi } from 'vitest';

/**
 * Minimal `fetch` stubbing for the tests of the API layer.
 *
 * The responses are hand-built rather than real `Response` objects: the tests
 * only care about `ok`, `status` and the parsed body, and building them here
 * keeps the suite independent of which `Response` implementation the test
 * environment happens to expose.
 */

export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

export function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('no body')),
  } as unknown as Response;
}

export type FetchMock = MockInstance<typeof fetch>;

/** Replaces `globalThis.fetch`; Vitest restores it via `restoreAllMocks`. */
export function stubFetch(): FetchMock {
  return vi.spyOn(globalThis, 'fetch');
}

/**
 * The address a stubbed `fetch` call was made to, as a string.
 *
 * `fetch` takes three shapes — a string, a `URL`, or a `Request` — and only the
 * first stringifies to something useful; a `Request` would come out as
 * `[object Object]` and every `endsWith` check against it would quietly be
 * false. This is one place that handles all three, so a test that routes on the
 * path cannot pick the wrong one by accident.
 */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
