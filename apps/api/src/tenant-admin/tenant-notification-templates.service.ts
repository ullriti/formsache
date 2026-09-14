import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  notificationTemplatesDocumentSchema,
  type NotificationTemplate,
  type TenantNotificationTemplatesResponse,
  type UpdateTenantNotificationTemplatesRequest,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import type { TenantScope } from '../tenancy/tenant-scope';
import { TENANT_NOT_FOUND_MESSAGE } from './oidc-config.service';

/** The conflict — the same wording the other settings tabs use. */
export const STALE_TENANT_NOTIFICATION_TEMPLATES_MESSAGE =
  'Die Vorlagen wurden zwischenzeitlich von jemand anderem geändert. ' +
  'Bitte lade die Seite neu und übernimm deine Änderung erneut.';

/**
 * The line a broken `tenant.notification_templates` document produces —
 * **on every occurrence**, unlike the „einmal je Prozess" convention the
 * installation-wide readers this replaced followed. That convention exists to
 * bound how much one broken row can amplify on a hot, unauthenticated path
 * (`PublicFormsService`, the old system-wide reader); this one is neither: a
 * broken row here belongs to one organisation, is read only behind a session,
 * and its own log line names which one, so the volume it can produce is
 * already bounded by how often that one organisation opens this page.
 */
export function unreadableTenantNotificationTemplatesLog(
  tenantId: string,
): string {
  return `tenant.notification_templates of ${tenantId} does not parse; falling back to the shipped templates.`;
}

/**
 * **The notification templates of one organisation** (ADR-0032) — the tab
 * *Vorlagen* of the organisation administration, and the source
 * `NotificationsService` reads from when it hands the editor of a form's
 * notifications its starting points.
 *
 * Until ADR-0032 this was a single installation-wide row, superadmin-only,
 * and every organisation was offered the **same** shipped-or-decided set.
 * That row and its write path (`/admin/system-settings/notification-templates`)
 * are gone; each organisation now owns and edits its own document on
 * `tenant.notification_templates`, seeded from that former row when this
 * migration ran and from {@link NOTIFICATION_TEMPLATES_FLOOR} for every
 * organisation created since.
 *
 * ## No `PrismaService` in the constructor
 *
 * Like every other domain service of this directory: the only way to the row
 * is the `TenantScope` the guard chain hands in, which has no possibility of
 * naming a **foreign** organisation. The tenant boundary is therefore
 * structural here, not checked.
 *
 * ## Why the reading is tolerant
 *
 * A row this application itself always writes with a valid document should
 * never fail to parse — but a raw write straight into the database can still
 * leave one that does not. Refusing outright (500, as the mail block does)
 * would lock exactly the page that could repair it; degrading to the shipped
 * floor, the way the notification editor's read already tolerated an
 * unreadable *installation-wide* document, keeps this page open for that
 * repair. `decided: false` tells the editor which of the two happened, same
 * as when the row genuinely carries nothing.
 */
@Injectable()
export class TenantNotificationTemplatesService {
  private readonly logger = new Logger(TenantNotificationTemplatesService.name);

  /** The tab *Vorlagen* of this organisation. */
  async ofTenant(
    scope: TenantScope,
  ): Promise<TenantNotificationTemplatesResponse> {
    const row = await scope.tenant.notificationTemplates();
    if (row === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    const decided = this.parsedOrNull(scope, row.notificationTemplates);
    return {
      templates: decided ?? [...NOTIFICATION_TEMPLATES_FLOOR],
      decided: decided !== null,
      lock: row.notificationTemplatesRevision,
    };
  }

  /**
   * What the notification editor of a form is offered — **never throws**, for
   * the same reason {@link ofTenant} degrades rather than fails: this method
   * is called on the way to listing a form's notifications, and a broken
   * templates row must not take that listing down with it.
   */
  async forEditor(scope: TenantScope): Promise<NotificationTemplate[]> {
    const row = await scope.tenant.notificationTemplates();
    if (row === null) {
      return [...NOTIFICATION_TEMPLATES_FLOOR];
    }
    return (
      this.parsedOrNull(scope, row.notificationTemplates) ?? [
        ...NOTIFICATION_TEMPLATES_FLOOR,
      ]
    );
  }

  /**
   * Replaces the templates of this organisation — wholly, never entry by
   * entry.
   *
   * The lock is checked **before** everything else, as on every other
   * settings tab: an outdated request gets the same 409, independently of
   * whether it would otherwise have gone through. The repository write checks
   * the same counter once more in its `where`, closing the narrow race
   * between the read here and the write there.
   */
  async replaceOfTenant(
    scope: TenantScope,
    request: UpdateTenantNotificationTemplatesRequest,
  ): Promise<TenantNotificationTemplatesResponse> {
    const current = await scope.tenant.notificationTemplates();
    if (current === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    if (request.lock !== current.notificationTemplatesRevision) {
      throw new ConflictException(STALE_TENANT_NOTIFICATION_TEMPLATES_MESSAGE);
    }

    const written = await scope.tenant.updateNotificationTemplates(
      current.notificationTemplatesRevision,
      toJson(request.templates),
    );
    if (!written) {
      throw new ConflictException(STALE_TENANT_NOTIFICATION_TEMPLATES_MESSAGE);
    }

    return this.ofTenant(scope);
  }

  private parsedOrNull(
    scope: TenantScope,
    stored: Prisma.JsonValue | null,
  ): NotificationTemplate[] | null {
    if (stored === null) {
      return null;
    }
    const result = notificationTemplatesDocumentSchema.safeParse(stored);
    if (result.success) {
      return result.data;
    }
    this.logger.error(unreadableTenantNotificationTemplatesLog(scope.tenantId));
    return null;
  }
}

/**
 * Passes the validated document on as JSON — the same narrow return the old
 * system-wide service used for the same purpose: the value comes from a Zod
 * schema and carries only strings, booleans and lists of those.
 */
function toJson(
  templates: readonly NotificationTemplate[],
): Prisma.InputJsonValue {
  return templates;
}
