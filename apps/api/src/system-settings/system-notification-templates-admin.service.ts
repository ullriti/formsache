import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  systemNotificationTemplatesSchema,
  type NotificationTemplate,
  type SystemNotificationTemplatesResponse,
  type UpdateSystemNotificationTemplatesRequest,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import {
  INITIAL_NOTIFICATION_TEMPLATES_REVISION,
  SystemSettingsRepository,
} from './system-settings.repository';

/** The conflict — the same wording as on the mail page and the AI page. */
export const STALE_NOTIFICATION_TEMPLATES_MESSAGE =
  'Die Vorlagen wurden zwischenzeitlich von jemand anderem geändert. ' +
  'Bitte lade die Seite neu und übernimm deine Änderung erneut.';

/** The one log line an unreadable document produces per process. */
export const UNREADABLE_TEMPLATES_ADMIN_LOG =
  'system_setting.notification_templates does not parse; the superadmin page is showing the shipped templates instead.';

/**
 * **The superadmin page of the notification templates** (ADR-0022,
 * continuation 2026-08-18).
 *
 * It is the write path that did not exist up to here.
 * `system-settings.module.ts` recorded that as an open point — the column
 * was read and set by nothing —, together with the condition: whoever builds the
 * route brings the counter with them. The counter is
 * `notification_templates_revision`, and it is one **of its own** beside
 * `mail_revision` and `ai_revision`, because three pages maintain this one row
 * and a shared counter would make one lock out of three.
 *
 * ## Why the reading is tolerant — and what that means here
 *
 * `NotificationTemplatesService` next door reads the same document tolerantly, because
 * it supplies the editor of an organisation and an unreadable
 * installation-wide document must not put the notification page of **every**
 * organisation on 503. This page here is tolerant for the
 * second reason the mail page writes out: **it is the one place at which
 * a broken document can be repaired.** A 500 here would lock the
 * installation out of precisely that repair.
 *
 * What the editor then sees is the shipped set, and `decided: false`
 * tells them so. With it they save either the shipped set (and replace the
 * broken document with one that parses) or something of their own — both are the
 * repair.
 *
 * ## What does **not** happen here
 *
 * No writing back on reading. A `GET` that quietly filled a missing column with
 * the shipped set would turn „nothing decided" into a decision
 * nobody took — and unnoticedly at that, for afterwards the two
 * states would look the same. The difference is the whole reason why the column
 * is `nullable` (`schema.prisma`).
 */
@Injectable()
export class SystemNotificationTemplatesAdminService {
  private readonly logger = new Logger(
    SystemNotificationTemplatesAdminService.name,
  );

  /** As next door: the line „does not parse" is written once per process. */
  private reported = false;

  constructor(private readonly repository: SystemSettingsRepository) {}

  read(): Promise<SystemNotificationTemplatesResponse> {
    return this.compose();
  }

  /**
   * Replaces the templates — wholly, never field by field.
   *
   * The lock is checked **before** everything else, as on the mail page: an
   * outdated request gets the same 409, independently of whether it would
   * otherwise have got through. Afterwards the repository writes once more against
   * the same counter value, which closes the narrow race between the reading here and the
   * writing there.
   */
  async replace(
    request: UpdateSystemNotificationTemplatesRequest,
  ): Promise<SystemNotificationTemplatesResponse> {
    const current = await this.repository.findTemplatesForAdmin();
    const currentLock =
      current?.notificationTemplatesRevision ??
      INITIAL_NOTIFICATION_TEMPLATES_REVISION;
    if (request.lock !== currentLock) {
      throw new ConflictException(STALE_NOTIFICATION_TEMPLATES_MESSAGE);
    }

    const written = await this.repository.writeTemplates(
      currentLock,
      toJson(request.templates),
    );
    if (!written) {
      throw new ConflictException(STALE_NOTIFICATION_TEMPLATES_MESSAGE);
    }

    return this.compose();
  }

  private async compose(): Promise<SystemNotificationTemplatesResponse> {
    const row = await this.repository.findTemplatesForAdmin();
    const stored = row?.notificationTemplates ?? null;
    const decided = stored === null ? null : this.parsedOrNull(stored);
    return {
      templates: decided ?? [...NOTIFICATION_TEMPLATES_FLOOR],
      decided: decided !== null,
      lock:
        row?.notificationTemplatesRevision ??
        INITIAL_NOTIFICATION_TEMPLATES_REVISION,
    };
  }

  private parsedOrNull(
    stored: Prisma.JsonValue,
  ): NotificationTemplate[] | null {
    const result = systemNotificationTemplatesSchema.safeParse(stored);
    if (result.success) {
      return result.data;
    }
    this.reportOnce();
    return null;
  }

  private reportOnce(): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    // `error` and not `warn`, for the reason the reader next door
    // writes out: a broken system row is a fault of the installation,
    // and `@nestjs/testing` swallows `warn`.
    this.logger.error(UNREADABLE_TEMPLATES_ADMIN_LOG);
  }
}

/**
 * Passes the validated document on as JSON — the same narrow cast
 * `system-mail-admin.service.ts` uses for the same purpose: the value comes
 * from a Zod schema, carries only strings, booleans and lists
 * of those, and the cast stays confined to this one function.
 */
function toJson(
  document: readonly NotificationTemplate[],
): Prisma.InputJsonValue {
  return document;
}
