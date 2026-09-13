import { randomUUID } from 'node:crypto';

import type { HeaderResponse } from '../common/http-transport';
import { JsonLogger } from './json-logger';

/** The header under which the request id comes back. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * **One id per request, in the log and in the response** (ADR-0016).
 *
 * It exists for a single manual step: an operator receives a
 * complaint („heute Mittag ging das Absenden nicht") and is to find the
 * corresponding log lines — **without** the application logging content
 * for that purpose. The id is the substitute for exactly that.
 *
 * ⚠️ **Generated, never taken over.** An `X-Request-Id` from the request is
 * deliberately *not* reused: it would come from outside, be arbitrarily long,
 * arbitrarily often repeatable and would afterwards stand in every log line —
 * a string chosen by a stranger in a file the
 * operator later searches through. The convenience of a passed-through id is
 * a question for the day on which an upstream proxy assigns it and
 * somebody has given reasons for its trustworthiness.
 */
export function requestId(
  _request: unknown,
  response: HeaderResponse,
  next: () => void,
): void {
  const id = randomUUID();
  response.setHeader(REQUEST_ID_HEADER, id);
  // The frame encloses the **forwarding**, not the response: everything logged
  // synchronously out of this request carries the id.
  JsonLogger.runWithRequestId(id, () => {
    next();
  });
}
