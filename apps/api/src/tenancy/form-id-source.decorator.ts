import { SetMetadata } from '@nestjs/common';

/**
 * Where the form a request is about stands — **declared by the route, never
 * guessed by the guard** (review finding).
 *
 * The fourth link of the chain used to look for `params.formId ?? params.id`.
 * That reads well as long as every guarded route happens to spell the form out
 * in its path, and it is wrong the moment one does not:
 *
 * - `GET /api/mail-log?formId=…` carries the form as a **query** parameter, so
 *   the guard saw no form at all and let the request through — the
 *   mail log of a form somebody is locked out of, subject lines and
 *   all;
 * - `GET /api/mail-log/:id` carries an `:id` that is a **log line**, not a
 *   form. The guess would have looked that id up as a form, found nothing, and
 *   passed — a refusal that never fires, on a route that looks guarded.
 *
 * Guessing is therefore replaced by naming, and naming is **mandatory**: a
 * route that carries `FormRestrictionGuard` without one of these three
 * decorators is refused rather than let through (see
 * {@link FORM_ID_UNDECLARED_MESSAGE}). The dangerous default — „nothing
 * declared, so nothing to check" — is exactly how the two holes above came to
 * exist, and it is the one this metadata removes.
 */
export const FORM_ID_SOURCE = 'formsache:form-id-source';

/**
 * The three honest answers to „which form is this request about?".
 *
 * `nothing` carries a **reason** rather than being a bare marker. It is the
 * declaration a reviewer has to trust, so the route says out loud why no form
 * id can be read off the request — „the list is narrowed in the query", „the
 * form hangs off the row and the service checks it" — instead of leaving the
 * next reader to work out whether it was decided or forgotten.
 */
export type FormIdSource =
  | { readonly in: 'param'; readonly name: string }
  | { readonly in: 'query'; readonly name: string }
  | { readonly in: 'nothing'; readonly because: string };

/** The form id stands in the route path under this parameter name. */
export const FormIdInParam = (name: string) =>
  SetMetadata<string, FormIdSource>(FORM_ID_SOURCE, { in: 'param', name });

/** The form id arrives as a query parameter — `GET /api/mail-log?formId=…`. */
export const FormIdInQuery = (name: string) =>
  SetMetadata<string, FormIdSource>(FORM_ID_SOURCE, { in: 'query', name });

/**
 * This request names no form, and here is why.
 *
 * Two legitimate shapes, and neither may be silent: a route that returns a
 * **list** (the guard cannot narrow a result set — the restriction travels as
 * `FormRestriction.formFilter()` into the `where`), and a route whose form is
 * only reachable **through the row it addresses**, where the service does the
 * check with the same 404 the guard would have raised.
 */
export const NoFormIdInRequest = (because: string) =>
  SetMetadata<string, FormIdSource>(FORM_ID_SOURCE, {
    in: 'nothing',
    because,
  });
