import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { AiSettingsService } from '../system-settings/ai-settings.service';
import type { TenantScopedRequest } from '../tenancy/request-context';

/**
 * What the route says when this installation has no AI.
 *
 * „Gibt es hier nicht", and deliberately not „ist gerade kaputt" (ADR-0015
 * no. 9): a 503 invites a retry and promises a return, and there is nothing to
 * return to. It names no variable and no provider — the caller behind this
 * guard is an editor of the organisation, not an operator, and the answer they can
 * act on is „diese Installation hat die Funktion nicht".
 */
export const AI_NOT_AVAILABLE_MESSAGE =
  'Diese Funktion gibt es in dieser Installation nicht.';

/**
 * **Availability — the last link of the chain, not the first**.
 *
 * Two rules meet on this route and they look like a contradiction until the
 * order is written down: one says „ohne Schlüssel 404", the other „ohne Sitzung
 * 401". Both are true, and the order decides which one a given request sees:
 *
 * > **Session → organisation → right → availability.**
 *
 * An unauthenticated caller therefore gets **401 even on an installation
 * without a key**, and an editor without `can_build` gets **403** rather
 * than a 404 that would tell them the feature is missing. That direction is the
 * safe one: putting availability first would turn this route into a probe that
 * answers a *different* status to strangers depending on whether the operator
 * pays for an AI — a configuration detail of the installation, handed out
 * before anybody proved who they are.
 *
 * The reverse order also breaks the one guarantee the first rule asks for in the other
 * direction: with availability first, „ohne Sitzung 401" would hold only on
 * configured installations, and the test for it would go green or red
 * depending on the environment it ran in.
 *
 * ## Why asked and not bound
 *
 * This guard used to inject a `boolean` that the module bound from the
 * environment at start-up. By now the configuration lives in
 * `system_setting` and changes during operation — a captured `boolean` would
 * be a lie from the first save onwards, and in the dangerous
 * direction: a switched-off provider would stay reachable until the restart.
 *
 * What is asked is `AiSettingsService`, the **only** reader of that row — the
 * same place from which the session payload takes its menu switch. Menu and
 * route therefore cannot drift apart: it is one resolution, read twice, and
 * that is exactly what is meant by „den Schalter nur
 * die Oberfläche ausblenden lassen".
 *
 * ## The third layer is evaluated here
 *
 * The organisation's own switch belongs at this place and at
 * no other: it is a statement about *this* organisation, and the organisation is only
 * settled after `TenantScopeGuard` has run. The link is an
 * **and** — an organisation can take the feature away from itself, but cannot give one the
 * installation does not have.
 *
 * ⚠️ **Without an organisation scope only the system layer is checked.** That is no
 * loophole: a route without `TenantScopeGuard` also has no organisation whose
 * switch could apply, and the chain before it has already rejected the request
 * if it had needed one.
 */
@Injectable()
export class AiFeatureGuard implements CanActivate {
  constructor(private readonly settings: AiSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const scope = request.tenantScope;
    const tenant = scope === undefined ? null : await scope.tenant.aiEnabled();
    if (!(await this.settings.available(tenant?.aiEnabled ?? null))) {
      throw new NotFoundException(AI_NOT_AVAILABLE_MESSAGE);
    }
    return true;
  }
}
