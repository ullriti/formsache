import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { NOT_AUTHENTICATED_MESSAGE } from '../auth/session.guard';
import { resolveActiveTenantId } from '../auth/session-user';
import type { TenantScopedRequest } from './request-context';
import { TenantScopeFactory } from './tenant-scope';

/**
 * **Wie {@link TenantScopeGuard}, nur ohne die Absage**
 * (Review-Runde 3 Nr. 12).
 *
 * Er stellt denselben Bereich her, aus derselben Quelle — den
 * **Mitgliedschaften** dieser Anfrage, nie aus `session.active_tenant_id`
 * allein —, und lässt die Anfrage auch dann durch, wenn keine Organisation
 * ausgewählt ist. Der Handler sieht das dann als `null` und entscheidet
 * selbst, was er ohne Organisation noch tun kann.
 *
 * ## Wofür es das überhaupt gibt
 *
 * Für genau einen Fall, und der ist eng: die Testmail der Systemverwaltung.
 * Sie prüft den Mailserver **der Installation**, braucht also fachlich keine
 * Organisation — sie hing nur deshalb an einer, weil ihr Protokolleintrag
 * eine braucht (`mail_log.tenant_id` ist `NOT NULL`). Ohne Organisation
 * entfällt der Eintrag, und der Versand geht trotzdem.
 *
 * ⚠️ **Dieser Wächter erteilt keine Rechte.** Er ist das zweite Glied einer
 * Kette und niemals das erste: wer hier durchkommt, hat `SessionGuard` und —
 * auf der einen Route, die ihn benutzt — `SuperadminGuard` hinter sich. Für
 * alles, was Daten einer Organisation liest oder schreibt, bleibt
 * {@link TenantScopeGuard} der Weg, und zwar ausnahmslos: ein Handler, der
 * `null` bekäme und es übersähe, fragte Prisma mit `tenantId: undefined` —
 * und das liest PostgreSQL als „gar keine Bedingung". Deshalb ist der Rückgabetyp
 * des Parameter-Decorators hier ausdrücklich `TenantScope | null` und nicht
 * ein optionales Feld, das man vergessen kann.
 */
@Injectable()
export class OptionalTenantScopeGuard implements CanActivate {
  constructor(private readonly scopes: TenantScopeFactory) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();

    const auth = request.auth;
    if (auth === undefined) {
      // Nur erreichbar auf einer Route, die diesen Wächter ohne
      // `SessionGuard` gesetzt hat — ein Verdrahtungsfehler, geschlossen
      // beantwortet statt mit einem Bereich aus einer unangemeldeten Anfrage.
      throw new UnauthorizedException(NOT_AUTHENTICATED_MESSAGE);
    }

    const tenantId = resolveActiveTenantId(
      auth.user.memberships.map((membership) => membership.tenant.id),
      auth.user.activeTenantId,
    );
    if (tenantId !== null) {
      request.tenantScope = this.scopes.create(tenantId);
    }
    return true;
  }
}
