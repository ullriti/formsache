import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { TenantScopedRequest } from './request-context';
import type { TenantScope } from './tenant-scope';

/**
 * Der Bereich, den {@link OptionalTenantScopeGuard} hergestellt hat — **oder
 * `null`** (Review-Runde 3 Nr. 12).
 *
 * Ein eigener Decorator neben `@CurrentTenantScope()` und keine Option an
 * ihm, und das ist der ganze Punkt: der andere **wirft**, wenn kein Bereich
 * da ist, weil ein `undefined` als `TenantScope` bei Prisma als
 * `tenantId: undefined` ankäme — also als gar keine Bedingung. Diese Zusage
 * darf nicht durch einen Schalter am selben Decorator weich werden. Wer
 * `null` bekommt, hat es im Typ stehen und muss es beantworten.
 */
export const CurrentOptionalTenantScope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantScope | null =>
    context.switchToHttp().getRequest<TenantScopedRequest>().tenantScope ??
    null,
);
