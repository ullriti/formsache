import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  mailLogFilterSchema,
  type MailLogDetail,
  type MailLogListResponse,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import {
  FormIdInQuery,
  NoFormIdInRequest,
} from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import {
  CurrentFormRestriction,
  type FormRestriction,
} from '../tenancy/form-restriction';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequireAllPermissions } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { MailLogService } from './mail-log.service';

/**
 * How often one address may press „↻ Erneut".
 *
 * The only authenticated route in this application whose effect leaves the
 * building: every call hands a line back to the worker, which then talks to a
 * mail server. A held-down button on a failed line is otherwise an unbounded
 * supply of delivery attempts against a server that has already said no —
 * which is how an organisation's domain earns a reputation problem, and it costs the
 * caller nothing.
 *
 * Thirty a minute: an office working through a batch of bounced Jahrestagung
 * confirmations clicks a few dozen lines at most, so the number is invisible in
 * use and small enough to stop a script. Stated with `@Throttle` on the route
 * rather than by registering a throttler — there is exactly **one**
 * `ThrottlerModule.forRoot` in this application, and a second one silently
 * replaces it (`common/rate-limit.module.ts`).
 */
const MAIL_LOG_RETRY_RATE_LIMIT = { limit: 30, ttl: 60_000 } as const;

/**
 * The mail log of the active Organisation.
 *
 * **`can_manage_form_settings` *and* `can_view_responses` — both, on every
 * route** . The reason is the payload, not tidiness: a subject
 * line is rendered from the notification's template, and a template may put
 * `{{antworten}}` or any `{{frage:…}}` into it, so a log line can carry the
 * complete answer values of a submission — and every line carries the
 * participant's address. Whoever may read this log is reading answers. The
 * easier rule („whoever configures notifications may see what they produced")
 * would hand a group without `can_view_responses` a way round to the answers,
 * which is exactly the hole the review gate found at the CSV export
 * (`can_export` alone used to open it). It is not being opened a second time,
 * so the route asks for the conjunction and `RequireAllPermissions` is what
 * spells it — `RequireAnyPermission` here would let *either* flag through.
 *
 * The settings half is the **per-form** right since ADR-0021, not the
 * organisation-wide `can_manage_settings` it used to be. Nothing about the
 * conjunction changes: what guards the answers is `can_view_responses`, and
 * that flag is untouched. What changes is only *which* configuration right
 * counts — the one that belongs to the forms this log is about.
 *
 * **There is no tenant in the path**, as everywhere behind this guard chain:
 * the log is the one of the session's active Organisation, resolved by
 * `TenantScopeGuard` from a membership the caller holds. A request cannot name
 * another organisation, so there is nothing to refuse — and for this table that scoped
 * read is the *only* tenant boundary there is (see `MailLogService`).
 *
 * ## The fourth link belongs here too (review finding)
 *
 * `FormRestrictionGuard` was missing from this chain until a review,
 * and the consequence was the export hole a second time: somebody locked
 * out of form X read X's correspondence through `GET /api/mail-log?formId=X`
 * and every rendered body behind it — the answer values a template put into
 * `{{antworten}}`, in full.
 *
 * Adding the guard was not enough on its own, and that is the part worth
 * reading before touching these routes. The link used to *guess* which form a
 * request was about (`params.formId ?? params.id`), and **neither** of this
 * controller's shapes fits that guess: the list carries its form as a **query**
 * parameter, and `:id` here is a **log line**, not a form. So each route now
 * declares where its form stands (`form-id-source.decorator.ts`), a route that
 * declares nothing is refused rather than passed, and the two routes that name
 * no form get their check from `MailLogService` against `mail_log.form_id`.
 */
@Controller('mail-log')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
export class MailLogController {
  constructor(private readonly mailLog: MailLogService) {}

  /**
   * The log, newest first, with the four KPI counters.
   *
   * Both filters arrive as query parameters and both are optional: `status` is
   * the KPI tile that was clicked — „Gesamt" is the *absence* of a status, not
   * a fourth one — and `formId` is the prefilter one arrives with from a form.
   *
   * Read one by one and then parsed rather than handed in as a whole object:
   * `mailLogFilterSchema` is a strict object, so a stray `?_=1` from a proxy or
   * a client's cache buster would turn the page into a 400. What the two
   * parameters *say* is still parsed and never cast — an unknown status is a
   * 400 here, not a silently ignored filter that would show an organisation more than it
   * asked for.
   */
  @Get()
  @RequireAllPermissions('canManageFormSettings', 'canViewResponses')
  // The one route in this application whose form arrives in the query. Named,
  // so the fourth link evaluates the prefilter it is given — and the *list*
  // itself is narrowed in the `where` of `ScopedMailLogDelegate`, because a
  // guard cannot narrow a result set (first reproduction).
  //
  // Consequence, and it is a decided one: `?formId=<gesperrt>` answers 404
  // (the guard), while `?formId=<unbekannt>` answers 200 with an empty log.
  // The two are therefore distinguishable, which they are not on
  // `GET /forms/:id`. The trade is deliberate — the 404 is the same answer
  // every other route gives for that form, and the alternative (200 with
  // nothing in it) would make the fourth link invisible on the one route that
  // addresses a form here. What it reveals is bounded: „ein Formular meines
  // eigenen Organisation, auf das ich gesperrt bin, existiert" — which is what
  // being locked out *is*, told to the person it was told to.
  @FormIdInQuery('formId')
  list(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
    @Query('status') status: string | undefined,
    @Query('formId') formId: string | undefined,
  ): Promise<MailLogListResponse> {
    const query: Record<string, string> = {};
    if (status !== undefined) {
      query.status = status;
    }
    if (formId !== undefined) {
      query.formId = formId;
    }
    return this.mailLog.list(
      scope,
      parseRequest(mailLogFilterSchema, query),
      restriction,
    );
  }

  /**
   * One line, with the mail as it was rendered (the acceptance run).
   *
   * **The same conjunction as the list, on purpose — the reason is stronger
   * here, not weaker.** The list's payload carries a subject; this one carries
   * `bodyText`/`bodyHtml`, i.e. the answer values a template placed into them.
   * Whoever may read one recipient's whole rendered mail is reading answers as
   * directly as the export did, and `can_export` alone opening that route
   * is the exact hole the review gate found there — not reopened here.
   *
   * `:id`, not a query narrowing the list: this is a single row a caller
   * already saw in the table, not a second way to search the log.
   */
  @Get(':id')
  @RequireAllPermissions('canManageFormSettings', 'canViewResponses')
  // `:id` is a **log line**, not a form — the guess the fourth link used to
  // make would have looked it up as one, found nothing and let the request
  // through. The form hangs off `mail_log.form_id`, so the check is
  // `MailLogService.detail`'s, with the same 404 an unknown id gets.
  @NoFormIdInRequest(
    'the :id is a mail_log row; its form is checked in MailLogService.detail',
  )
  detail(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
    @Param('id') id: string,
  ): Promise<MailLogDetail> {
    return this.mailLog.detail(scope, id, restriction);
  }

  /**
   * „↻ Erneut" on one failed line.
   *
   * `POST` and not `PUT`: it is not a state a client describes but an action on
   * a row the server owns, and the mutating method is what puts it behind the
   * global CSRF guard — a `GET` retry would be triggerable
   * from any page a logged-in editor happens to open.
   *
   * **204, no body.** The line's new state matters to the table *and* to the
   * KPI tiles above it (one leaves „Fehlgeschlagen", one joins „In
   * Warteschlange"), so a client has to reload the list either way; answering
   * with a single entry would invite it not to, and the numbers would then
   * disagree with the row. The wire contract has no retry envelope for the same
   * reason (`@formsache/shared`).
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canManageFormSettings', 'canViewResponses')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: MAIL_LOG_RETRY_RATE_LIMIT })
  // Same shape as the detail route, and it matters more here: this one *sends*.
  @NoFormIdInRequest(
    'the :id is a mail_log row; its form is checked in MailLogService.retry',
  )
  retry(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
    @Param('id') id: string,
  ): Promise<void> {
    return this.mailLog.retry(scope, id, restriction);
  }
}
