/**
 * The one place where the web app talks to the API.
 *
 * Two rules shape this module, both from CONTRIBUTING.md and ADR-0005:
 *
 * 1. **Every response body leaves here as `unknown`.** Callers must run it
 *    through a Zod schema from `@formsache/shared`; nothing casts.
 * 2. **The session is a cookie the app cannot read.** It is `httpOnly`, so
 *    there is no token to attach and no "logged in" flag to keep — the only
 *    honest answer to "is someone signed in?" comes from `GET /api/auth/me`.
 *    All that is needed here is `credentials: 'same-origin'`, which the
 *    `/api` proxy in `vite.config.ts` makes sufficient.
 */

import {
  readSubmissionRefusal,
  readValidationProblem,
  toFieldIssues,
  type SubmissionRefusal,
} from '@formsache/shared';

/**
 * Base path of the API. Same origin — see the proxy in `vite.config.ts`.
 *
 * Exported: the OIDC login is a **full page navigation** to a server
 * route, not a `fetch`, so `auth.ts` has to build that address itself. A second
 * literal `'/api'` there would be a prefix that stops matching the day the mount
 * point moves.
 */
export const API_BASE = '/api';

/**
 * An API answer that was not a success.
 *
 * Carries the HTTP status because callers act on it: 401 on `/auth/me` means
 * "no session", which is a normal state and not a failure to report.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Field-level messages the server sent with a 400, keyed by the path it
     * named — for the fill-in view, which marks the field rather than showing
     * one sentence about a form with thirty questions.
     *
     * Absent for every other status, and absent when the body carried no
     * issues: a caller must be able to tell "the server named fields" from
     * "the server named none".
     */
    readonly fieldIssues?: Record<string, string>,
    /**
     * The server's own sentence behind a 409 on a public route (the requirement
     * and the rest of the public fill-in flow), parsed through `submissionRefusalSchema`.
     *
     * Carried because the edit view has nothing else to say: „geschlossen",
     * „Bearbeiten ausgeschaltet" and „Zeit abgelaufen" are three different
     * pieces of advice, and inventing a sentence in the browser for a state the
     * server decided would be a second answer to the same question. Absent for
     * every other status and for a body that is not a refusal — a proxy's HTML
     * page must not become a sentence shown as if the server had said it.
     */
    readonly refusal?: SubmissionRefusal,
    /**
     * The server's own sentence, when the error body carried one as plain text
     * (`{ "message": "…" }`, which is what a Nest `HttpException` produces).
     *
     * Read for the 422s of mail delivery: „Das Formular hat keine E-Mail-Frage, aus
     * der eine Adresse gelesen werden könnte" is written for the person on
     * screen, and a second wording invented in the browser is a sentence that
     * drifts away from the rule it describes.
     *
     * **Only ever a fallback, never a place to put markup.** It is rendered as
     * text like every other string in this application, and a caller that has a
     * better sentence for a status uses that one — a raw server message is the
     * last resort, not the default.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * What an error body carries, parsed through the shared contracts.
 *
 * Reading the body of a *failed* response is the one place a `try` is right:
 * the answer may be a proxy's HTML page, and that must not become a field
 * marker on a random question — nor an exception that replaces the real
 * `ApiError` with a parse error.
 *
 * Read **once**: `Response.json()` consumes the stream, so the two questions
 * („named the server fields?", „did it refuse, and why?") have to be asked of
 * the same parsed value.
 */
async function readErrorDetail(response: Response): Promise<{
  fieldIssues?: Record<string, string>;
  refusal?: SubmissionRefusal;
  detail?: string;
}> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }

  const problem = readValidationProblem(body);
  const refusal = readSubmissionRefusal(body);
  const message = readMessage(response.status, body);
  return {
    ...(problem === undefined ? {} : { fieldIssues: toFieldIssues(problem) }),
    ...(refusal === undefined ? {} : { refusal }),
    ...(message === undefined ? {} : { detail: message }),
  };
}

/**
 * The `message` of an error body, when it is one readable sentence.
 *
 * Parsed, not cast: an array of messages (Nest's validation pipe) and anything
 * that is not a string come back as `undefined`, so a caller can never end up
 * showing `[object Object]` to an editor. The bound keeps a proxy's essay out
 * of the interface.
 */
function readMessage(status: number, body: unknown): string | undefined {
  // **4xx only.** A refusal is written for the caller — „Das Formular hat keine
  // E-Mail-Frage …" is a sentence somebody composed for this screen. A 5xx body
  // is not: Nest answers „Internal server error", and putting a server's
  // internal wording in front of an editor tells them nothing and may say more
  // than it should.
  if (status < 400 || status >= 500) {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || !('message' in body)) {
    return undefined;
  }
  const { message } = body;
  return typeof message === 'string' &&
    message.trim() !== '' &&
    message.length <= 500
    ? message
    : undefined;
}

/** A network or parse failure — the request never produced an API answer. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

interface RequestOptions {
  /**
   * `PATCH` since Konzept no. 74 („Vorlage umbenennen"): the one call of this
   * application that really changes **one field** of a row and says
   * nothing about the rest. For the transport it changes nothing — everything except
   * `GET`/`HEAD`/`OPTIONS` carries the CSRF header, here as in the
   * `CsrfGuard` of the API.
   */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON-serialisable request body. Omitted for GET. */
  readonly body?: unknown;
  /**
   * Extra request headers — today the access proof of a password-protected
   * public form (`api/public-form.ts`).
   *
   * Merged **under** the ones this module sets, so a caller cannot overwrite
   * `Content-Type` or the CSRF header by accident: those two are decided by the
   * transport, not by a feature.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Cancels the request from the caller's side.
   *
   * There is exactly one caller: the KI-Dialog's *Abbrechen* during the
   * working phase. It is a real `AbortSignal` on `fetch` rather than a flag the
   * handler checks afterwards, because the two are not the same promise: a
   * request that keeps running after the dialog closed still arrives, and
   * whatever it triggers then happens on a screen that has moved on. What
   * cancelling must **not** do is leave something half-created — that is the
   * route's half (nothing is stored before *Übernehmen*, ADR-0015 no. 11) and
   * this one's: no request is made from the discarded run afterwards.
   */
  readonly signal?: AbortSignal;
}

/**
 * Name of the cookie the API hands the CSRF token out in, and of the header it
 * expects it back in (`apps/api/src/auth/csrf.ts`).
 *
 * Two spellings of one contract, which is a risk worth naming: these constants
 * live on the server side of the wire and are duplicated here rather than
 * imported, because `@formsache/shared` describes *messages*, and a cookie name is
 * transport. The integration test on the server pins the names; if they ever
 * change, every mutating request from this client answers 403 immediately and
 * loudly — which is the failure mode one can find, unlike a silent one.
 */
const CSRF_COOKIE_NAME = 'formsache_csrf';
const SECURE_CSRF_COOKIE_NAME = `__Host-${CSRF_COOKIE_NAME}`;
const CSRF_HEADER_NAME = 'X-CSRF-Token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads the CSRF token out of `document.cookie`.
 *
 * This is the one cookie of the application that is deliberately readable: the
 * session cookie is `httpOnly` and must stay that way, and the token exists
 * precisely so the client has something it *can* read and echo back. Behind
 * TLS the name carries the `__Host-` prefix, so both are tried — the client
 * does not know whether it is talking to a TLS deployment, and asking would
 * be a round trip to learn something a cookie already says.
 */
function readCsrfToken(): string | undefined {
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === SECURE_CSRF_COOKIE_NAME || name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/**
 * The CSRF header, or none — for a request that is **not** built by
 * {@link buildHeaders}.
 *
 * There is exactly one such request: the logo upload of the requirement,
 * which sends a raw body through {@link requestUpload} and rides a session.
 * Exported rather than repeated there, because „lies das Cookie und benenne die
 * Kopfzeile" written twice is two spellings of one protection — and the second
 * one is the one nobody updates.
 *
 * No token, no header — and the request goes out anyway. Before the first login
 * there is no session either, so the API answers 401 rather than 403, and that
 * is the answer the user needs to see.
 */
export function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token === undefined ? {} : { [CSRF_HEADER_NAME]: token };
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...options.headers,
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (!SAFE_METHODS.has(options.method)) {
    Object.assign(headers, csrfHeaders());
  }

  return headers;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method: options.method,
      // Same-origin only: sending the session cookie cross-origin would
      // require CORS with credentials, which we deliberately do not have.
      credentials: 'same-origin',
      headers: buildHeaders(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    // A cancelled request is not an unreachable server. Wrapping the
    // `AbortError` into „Der Server ist nicht erreichbar." would hand the
    // caller a sentence to show for something the caller itself just did — and
    // the one caller that cancels wants to recognise its own abort, not to
    // report an outage that did not happen.
    if (options.signal?.aborted === true) {
      throw cause;
    }
    throw new NetworkError('Der Server ist nicht erreichbar.', { cause });
  }
}

/**
 * Sends a request and returns the parsed JSON body as `unknown`.
 *
 * Deliberately not generic: a type parameter here would be a cast wearing a
 * nicer hat. The caller parses.
 */
export async function requestJson(
  path: string,
  options: RequestOptions,
): Promise<unknown> {
  const response = await send(path, options);

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new ApiError(
      response.status,
      `${options.method} ${path} failed with status ${String(response.status)}`,
      detail.fieldIssues,
      detail.refusal,
      detail.detail,
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new NetworkError('Die Antwort des Servers war unlesbar.', { cause });
  }
}

/**
 * Sends **one file as the raw body** and returns the parsed JSON answer as
 * `unknown` (ADR-0014 no. 14).
 *
 * A function of its own rather than a `body` variant of {@link requestJson},
 * because everything about it is different and each difference is a decision of
 * the ADR:
 *
 * - `Content-Type: application/octet-stream`, **set explicitly**. `fetch(url,
 *   {body: file})` would otherwise send the file's own type, and the route
 *   answers 415 to everything but this one — which is what makes it
 *   grammatically unreachable for a foreign HTML form, the same property
 *   `bodyParser: false` was bought for on the server.
 * - The name travels in a header, **percent-encoded**: a header is a latin-1
 *   byte string by the letter of HTTP, and „Nachweis Müller.pdf" is not one.
 * - **No `JSON.stringify`**, obviously, and no CSRF header: the route is
 *   `@CsrfExempt()` like every other public one, because it authenticates
 *   nobody.
 *
 * The **request** carries no size check. The limit is the server's and is
 * enforced while the bytes arrive (no. 6); a browser-side refusal is UX and
 * belongs where the user is, next to the picker (`FileField.tsx`).
 */
export async function requestUpload(
  path: string,
  file: File,
  headers?: Readonly<Record<string, string>>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...headers,
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    });
  } catch (cause) {
    throw new NetworkError('Der Server ist nicht erreichbar.', { cause });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new ApiError(
      response.status,
      `POST ${path} failed with status ${String(response.status)}`,
      detail.fieldIssues,
      detail.refusal,
      detail.detail,
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new NetworkError('Die Antwort des Servers war unlesbar.', { cause });
  }
}

/** Sends a request that answers without a body (204). */
export async function requestVoid(
  path: string,
  options: RequestOptions,
): Promise<void> {
  const response = await send(path, options);

  if (!response.ok) {
    // A route that answers 204 on success still answers with a body when it
    // refuses — „↻ Erneut" on a line that is no longer `failed` is a 409 with a
    // sentence, and dropping it here would leave the button looking broken.
    const detail = await readErrorDetail(response);
    throw new ApiError(
      response.status,
      `${options.method} ${path} failed with status ${String(response.status)}`,
      detail.fieldIssues,
      detail.refusal,
      detail.detail,
    );
  }
}
