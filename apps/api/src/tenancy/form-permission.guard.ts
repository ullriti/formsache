import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { NOT_AUTHENTICATED_MESSAGE } from '../auth/session.guard';
import { FORM_NOT_FOUND_MESSAGE } from '../common/form-not-found';
import { isUuid } from '../common/uuid';
import { FORM_ID_SOURCE, type FormIdSource } from './form-id-source.decorator';
import { MISSING_PERMISSION_MESSAGE } from './group-permission.guard';
import { FormRestriction, isRestrictable } from './form-restriction';
import type { TenantScopedRequest } from './request-context';
import {
  REQUIRED_PERMISSION,
  type PermissionRequirement,
} from './require-permission.decorator';
import { NO_TENANT_SCOPE_MESSAGE } from './tenant-scope.guard';

/**
 * What a route gets whose {@link FormIdSource} does not fit it — a **wiring**
 * mistake, answered closed, in both of its shapes:
 *
 * - the route declares **nothing** at all;
 * - the route declares a **parameter that is not there** (review finding). A class-wide `@FormIdInParam('id')` covers every route of the
 *   controller including the ones without an `:id` — a later `@Get('archived')`
 *   on `FormsController` is enough — and `params['id']` is then `undefined`.
 *   Reading that as „kein Formular, also nichts zu prüfen" is the same
 *   dangerous default the decorator was introduced to remove; it merely moved
 *   one line further in.
 *
 * Deliberately as blank as every other refusal this application sends outward
 * (`CONTRIBUTING.md`): it says nothing about routes, parameters or guards. The
 * detail belongs in the failing test and in this comment, not in a body a
 * stranger can read — and it is one message for both shapes so the outside
 * cannot tell them apart either.
 */
export const FORM_ID_UNDECLARED_MESSAGE = 'Zugriff verweigert.';

/**
 * **Fourth and last link** of the guard chain:
 * *tenant scope → group permissions → **form restriction***.
 *
 * It runs **after** `GroupPermissionGuard`, and the order is required
 * rather than a preference:
 *
 * - after `TenantScopeGuard`, because a form of another organisation has to be
 *   unreachable *before* anybody asks what rights the caller holds on it. That
 *   is the requirement — „404 vor jeder Rechteprüfung" — and reordering the two
 *   turns the 404 into a 403 that confirms the id exists somewhere;
 * - after `GroupPermissionGuard`, because this link can only **take away**. It
 *   narrows the permissions the third link already granted; it never re-asks a
 *   question that link answered with „no". Running it first would make it look
 *   like a second grantor, and the first person to write „unless restricted" in
 *   it would have built one.
 *
 * **What it does not do is filter lists.** A guard says yes or no to one
 * request; the form list has to *not load* what the caller may not see, which
 * is a `where` and not a decision (the requirement's first reproduction). The guard
 * therefore also puts a {@link FormRestriction} on the request — a query
 * fragment the handlers pass into their own statement — and that object is the
 * only thing a list route gets.
 *
 * **Which form a request is about is declared, not guessed** — see
 * {@link FormIdSource}, and see {@link FORM_ID_UNDECLARED_MESSAGE} for what a
 * route that declares nothing gets.
 *
 * The guard injects nothing but `Reflector`: everything it reads comes off the
 * request the earlier links put there (`auth`, `tenantScope`). That is what lets
 * it be applied in any module without dragging database access into it, exactly
 * as `GroupPermissionGuard` is.
 */
@Injectable()
export class FormRestrictionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();

    const auth = request.auth;
    if (auth === undefined) {
      // The chain was assembled wrongly — `SessionGuard` did not run. Refuse
      // rather than evaluate a restriction against an absent person.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    const scope = request.tenantScope;
    if (scope === undefined) {
      // Either `TenantScopeGuard` did not run or it ran *after* this one. Both
      // are the reordering the requirement forbids, and both are refused here rather
      // than worked around: without a scope there is no tenant-bound way to read
      // a restriction, and reading one without a tenant is the mistake itself.
      throw new ForbiddenException(NO_TENANT_SCOPE_MESSAGE);
    }

    const membership = auth.user.memberships.find(
      (candidate) => candidate.tenant.id === scope.tenantId,
    );
    if (membership === undefined) {
      // Unreachable through the normal chain — the scope was built from a
      // membership. Checked anyway, because the alternative to checking is
      // assuming, and the assumption would grant.
      throw new ForbiddenException(MISSING_PERMISSION_MESSAGE);
    }

    const restrictable = isRestrictable(membership.group);
    const required = this.requirementOf(context);
    // Put on the request **before** any refusal, so a route that only needs the
    // list fragment gets it on exactly the same terms as one that is refused.
    //
    // It carries the membership's permissions and the route's requirement,
    // because the two routes whose form is not in the request at all
    // (`GET /api/mail-log/:id`, its retry) have to reach the *same* verdict
    // this guard reaches — `FormRestriction.verdictFor` is that one evaluation.
    const restriction = new FormRestriction(
      auth.user.id,
      restrictable,
      membership.permissions,
      required,
    );
    request.formRestriction = restriction;

    if (!restrictable) {
      // The second half of the requirement: an administrator is not merely
      // hard to restrict, their restriction is **not read**. Whatever stands in
      // `form_permission` for this person — written by a route, a migration or a
      // hand-edited database — is ignored here, so „sieht immer alles" does not
      // depend on which way the row got in.
      return true;
    }

    const formId = this.formIdOf(request, this.sourceOf(context));
    if (formId === undefined || !isUuid(formId)) {
      // No form in this route (the list, the create), or an id no `uuid` column
      // could hold. The second case is deliberately *not* answered here: the
      // service resolves it and answers 404 like any unknown id, and a refusal
      // from the guard would be a different door for a malformed string than
      // for an unknown one. „Declared but absent" does **not** arrive here —
      // {@link formIdOf} refuses it (see {@link FORM_ID_UNDECLARED_MESSAGE}).
      return true;
    }

    const stored = await scope.formPermissions.findFor(formId, auth.user.id);
    const verdict = await restriction.verdictFor(stored, (id) =>
      scope.groups.findById(id),
    );

    if (verdict === 'revoked') {
      // The same answer, byte for byte, that an unknown or a foreign form gets
      // (`FORM_NOT_FOUND_MESSAGE`) — as required. A 403 here would
      // tell the caller that the form exists and that somebody deliberately
      // locked them out of it, which is more than „kein Zugriff" has to say.
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }

    if (verdict === 'capped-out') {
      // 403, not 404: the cap does not hide the form — the caller may still open
      // it, they simply may not do *this* on it. Hiding it here would contradict
      // the list, which a cap does not narrow.
      throw new ForbiddenException(MISSING_PERMISSION_MESSAGE);
    }

    return true;
  }

  /**
   * What the route **declared** about where its form id stands.
   *
   * `getAllAndOverride` so a controller can state the shape once and a single
   * route override it — `FormsController` names `:id` for the whole class and
   * `GET /forms` says „no form here", rather than every route repeating itself
   * and one of them forgetting.
   */
  private sourceOf(context: ExecutionContext): FormIdSource | undefined {
    return this.reflector.getAllAndOverride<FormIdSource | undefined>(
      FORM_ID_SOURCE,
      [context.getHandler(), context.getClass()],
    );
  }

  /**
   * Which form this request is about, read from where the route said it stands.
   *
   * **Nothing is guessed and nothing falls through.** The earlier version
   * looked for `params.formId ?? params.id`, which was silently wrong on two
   * shapes this chain now guards: a form that arrives as a *query* parameter
   * (`GET /api/mail-log?formId=…` — no form found, request let through) and an
   * `:id` that is not a form at all (`GET /api/mail-log/:id` — a log line id
   * looked up as a form, found nothing, request let through). Both looked
   * guarded. See {@link FormIdSource}.
   *
   * A query parameter is only accepted as a `string`: `?formId=a&formId=b`
   * arrives as an array, and there is no honest single form to check it
   * against. It is treated as „no id here", which is safe because the handler
   * parses the same parameter through its own schema and answers 400.
   *
   * **A declared *path* parameter that is not in the path is a refusal, not an
   * absence** (review finding). The two „no id" cases are not the same
   * thing: a query parameter is optional by nature — `GET /api/mail-log`
   * without a prefilter is the ordinary request, and the list narrows itself in
   * the `where` — whereas `:id` is part of the route's own path, so its absence
   * means the declaration does not describe this route. Answering that with
   * „nothing to check" is the fail-open the decorator was written to remove:
   * a class-wide `@FormIdInParam('id')` plus one sibling route without an `:id`
   * (`@Get('archived')`) would silently opt that route out of the fourth link.
   */
  private formIdOf(
    request: TenantScopedRequest,
    source: FormIdSource | undefined,
  ): string | undefined {
    if (source === undefined) {
      // A route carrying this guard without declaring where its form stands.
      // Refused, never passed: „nothing declared, so nothing to check" is the
      // exact reading that left the mail log open (review finding), and a new route must not be able to inherit it by omission.
      throw new ForbiddenException(FORM_ID_UNDECLARED_MESSAGE);
    }
    if (source.in === 'nothing') {
      return undefined;
    }
    if (source.in === 'param') {
      const value = request.params?.[source.name];
      if (value === undefined) {
        // The declaration misses this route — see the doc above. Same blank
        // refusal as „declared nothing", because from the outside it is the
        // same mistake and neither deserves a different door.
        throw new ForbiddenException(FORM_ID_UNDECLARED_MESSAGE);
      }
      return value;
    }
    const value = request.query?.[source.name];
    return typeof value === 'string' ? value : undefined;
  }

  private requirementOf(
    context: ExecutionContext,
  ): PermissionRequirement | undefined {
    return this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
  }
}
