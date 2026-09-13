import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  AI_QUOTA_EXHAUSTED_MESSAGE,
  aiFormPromptRequestSchema,
  type AiFormDraftResponse,
  type AiQuota,
} from '@formsache/shared';

import { CurrentAuth } from '../auth/current-auth.decorator';
import type { AuthContext } from '../auth/request-context';
import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { AiFeatureGuard } from './ai-feature.guard';
import { AiFormsService } from './ai-forms.service';

/**
 * How often **one client address** may start a generation.
 *
 * Not the budget — that is the monthly quota of Konzept no. 7, counted per organisation and
 * enforced transactionally before the call. This is the **burst** guard, and
 * the two answer different questions: the quota bounds the bill of a month, the
 * limit here bounds how much a single origin can have in flight at once. One
 * call may occupy up to `AI_REQUEST_TIMEOUT_MS` (60 s by default), so six a
 * minute is roughly „six calls of this organisation open at the same time" — generous
 * for a person refining a prompt (each attempt takes tens of seconds to come
 * back) and tight enough that a script cannot burn a 50-call monthly quota in
 * one distracted minute; it needs nine, which is long enough for somebody to
 * notice.
 *
 * Counted per address (an IPv6 caller reduced to its /64, `clientAddress`), so
 * the admins of an organisation behind one NAT share it — accepted for the same reason
 * `TEST_MAIL_RATE_LIMIT` accepts it: a per-session counter is one a caller
 * resets by logging in again.
 *
 * ⚠️ `@Throttle` alone does nothing in this application — there is no global
 * `APP_GUARD` for the throttler, so every limited route carries
 * `@UseGuards(ThrottlerGuard)` beside it. And it stays with the **one**
 * `ThrottlerModule.forRoot` in `common/rate-limit.module.ts`; a second one
 * silently replaces the first, which is how the login's limit once disappeared
 * with nothing turning red.
 */
const AI_GENERATE_RATE_LIMIT = { limit: 6, ttl: 60_000 } as const;

/**
 * **The KI-Formularerstellung — an editor's feature** (the requirements and
 * the check „401 ohne Sitzung").
 *
 * ## The chain, and its order is the statement
 *
 * `SessionGuard → TenantScopeGuard → GroupPermissionGuard → AiFeatureGuard`,
 * declared at the controller so a route added later inherits it instead of
 * having to remember it (the argument `FormsController` makes).
 * The four answers it produces, in the order they are decided:
 *
 * | missing | answer |
 * |---|---|
 * | session | **401** |
 * | organisation (none chosen, membership gone) | **403** |
 * | `can_build` | **403** |
 * | the feature (no key, `AI_ENABLED=false`) | **404** |
 *
 * **Availability last, and that is not a matter of taste** (see
 * `AiFeatureGuard`): the checks „404 ohne Schlüssel" and „401 ohne Sitzung" read
 * like a contradiction until the order is fixed. A stranger gets 401 whether or
 * not this installation has an AI — otherwise the status code itself would tell
 * anybody on the internet whether the operator pays for one.
 *
 * ## No `:tenantId`, no `:id`
 *
 * The organisation is the session's active one, resolved by `TenantScopeGuard` and
 * never a parameter — so „über die Tenant-Grenze" has no spelling here at all:
 * there is no id a caller could point at another organisation's anything. What is
 * bound to the organisation is the *quota*, and it is spent through
 * `ScopedAiUsageDelegate`, i.e. with `tenant_id` in the `where` of both the
 * lock and the count.
 *
 * ## Nothing is created
 *
 * `POST /api/ai/forms` **creates no form** (ADR-0015 no. 11). It
 * answers with a draft to look at; *Übernehmen* is the ordinary
 * `POST /api/forms` plus `PUT /api/forms/:id`, which is what makes „ein
 * bestehender Entwurf wird nie ersetzt" a property of the route surface rather
 * than of a client's care. The `POST` here is a `POST` because it costs money
 * and writes an `ai_usage` row, not because it creates a resource.
 */
@Controller('ai')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard, AiFeatureGuard)
export class AiFormsController {
  constructor(private readonly ai: AiFormsService) {}

  /**
   * „✦ KI-Formular" — one free text in, one draft back.
   *
   * `canBuild`, and only that: what comes back is a form *document*, the same
   * thing the builder edits. A member who may only read answers has no use for
   * it and no right to spend the organisation's budget.
   *
   * 200 for every outcome the model produced — including the six named
   * failures, see `aiFormDraftResponseSchema` — and **429** for the one case in
   * which nothing was called and nothing counted: the quota is used up.
   */
  @Post('forms')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('canBuild')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: AI_GENERATE_RATE_LIMIT })
  async generate(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<AiFormDraftResponse> {
    const attempt = await this.ai.generate(
      scope,
      auth.user.id,
      // Parsed, never cast: the free text is foreign data, and the bound
      // (`AI_PROMPT_MAX`) is enforced here rather than by the input field.
      parseRequest(aiFormPromptRequestSchema, body),
    );
    if (attempt.kind === 'exhausted') {
      // The quota travels with the refusal so the dialogue can say „50 von 50
      // verbraucht" instead of „irgendwas ist voll" — the same numbers the
      // success path carries, from the same schema.
      throw new HttpException(
        { message: AI_QUOTA_EXHAUSTED_MESSAGE, quota: attempt.quota },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return attempt.response;
  }

  /**
   * „Verbrauch und Rest" — what the organisation may **see** .
   *
   * A read and nothing else. The number itself is set by the **Superadmin** in
   * the tenant administration (`PUT /api/admin/tenants/:tenantId/ai-quota`): a
   * Organisation-Admin who could raise their own budget would be a cost lever no guard
   * watches, and the bill is the operator's. `0` is the per-Organisation off switch.
   */
  @Get('quota')
  @RequirePermission('canBuild')
  quota(@CurrentTenantScope() scope: TenantScope): Promise<AiQuota> {
    return this.ai.quota(scope);
  }
}
