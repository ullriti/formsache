import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  updateSystemAiSettingsRequestSchema,
  updateSystemLegalRequestSchema,
  updateSystemMailSettingsRequestSchema,
  updateSystemNotificationTemplatesRequestSchema,
  type SystemNotificationTemplatesResponse,
} from '@formsache/shared';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { SessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { parseRequest } from '../common/parse-request';
import { SystemAiAdminService } from './system-ai-admin.service';
import { SystemMailAdminService } from './system-mail-admin.service';
import { SystemNotificationTemplatesAdminService } from './system-notification-templates-admin.service';
import { SystemLegalService } from './system-legal.service';
import type {
  SystemAiSettingsResponse,
  SystemLegalResponse,
  SystemMailSettingsResponse,
} from './system-settings-wire';

/**
 * How many calls a minute these routes take.
 *
 * Not because a superadmin is a threat: sixty a minute is far beyond what
 * opening a settings page costs and well below what a loop could do to a
 * database that also has to answer public fill-in requests.
 *
 * Stated with `@Throttle` on the controller rather than by registering a
 * throttler: there is exactly **one** `ThrottlerModule.forRoot` in this
 * application (`common/rate-limit.module.ts`), and a second one replaces it
 * silently — which is how the login's limit once disappeared without anything
 * turning red.
 */
const SYSTEM_SETTINGS_RATE_LIMIT = { limit: 60, ttl: 60_000 } as const;

/**
 * The superadmin surfaces on `system_setting`: the installation's mail server
 * and base address, and its KI configuration. One controller for both — they
 * are the same kind of route on the same row behind the same guard, and a
 * second controller would be a second answer to a question
 * `system-settings.repository.ts` already settles once.
 *
 * The third pair, `GET`/`PUT /notification-templates`, arrived with the setup
 * wizard (ADR-0022, continuation 2026-08-18) and closed the one column of
 * this row that was read and never written.
 *
 * There used to be a *fourth* pair here, `GET`/`PUT /form-defaults`, for a layer
 * of form settings below every organisation. It is gone with the layer
 * (ADR-0011, continuation 2026-08-14) — and with it the one cross-tenant
 * *write* this application had.
 *
 * ## The guard chain here is short, and every link that is missing is missing
 * on purpose
 *
 * `SessionGuard` then `SuperadminGuard`, and nothing else:
 *
 * - **No `TenantScopeGuard`.** These settings belong to no organisation — they are the
 *   layer *below* every organisation. Requiring a scope would tie the administration of
 *   the installation to a membership, and the property hangs
 *   on the user rather than on the active Organisation. A superadmin who is a member of
 *   nothing must be able to seed the standards of a fresh installation; that is
 *   the state every installation starts in.
 * - **No `GroupPermissionGuard`.** `can_manage_settings` is granted by an organisation to
 *   its own people. Accepting it here would let whoever administers one organisation set
 *   the default for **all** of them — the sentence the requirement opens with.
 *
 * The chain of `CONTRIBUTING.md` (*tenant scope → group permissions →
 * form restriction*) is untouched by this: superadmin is a fourth way in,
 * beside it and only for administration routes, never a key that opens the
 * three. `SuperadminGuard` says the same thing from the other side.
 *
 * ## No CSRF exemption
 *
 * The `PUT` sits behind the global `CsrfGuard` like every other mutating admin
 * route. There is nothing about this route that would justify
 * an exemption — it is called from the application's own settings page with a
 * session cookie, which is exactly the shape the token protects.
 *
 * ## `/admin/`, not next to an organisation's own settings
 *
 * The organisation-facing routes deliberately carry no tenant in their path,
 * and that absence *is* their tenant boundary. Hanging an installation-wide
 * route off the same prefix would blur which of the two a route means. The
 * administration of the installation gets its own prefix instead, behind this
 * same guard.
 */
@Controller('admin/system-settings')
@UseGuards(SessionGuard, SuperadminGuard, ThrottlerGuard)
@Throttle({ default: SYSTEM_SETTINGS_RATE_LIMIT })
export class SystemSettingsController {
  constructor(
    private readonly mail: SystemMailAdminService,
    private readonly ai: SystemAiAdminService,
    private readonly templates: SystemNotificationTemplatesAdminService,
    private readonly legal: SystemLegalService,
  ) {}

  /**
   * The installation's mail server and base address
   * — the write path this route provides instead ("ohne SQL, ohne
   * Seed-Trick, ohne Handgriff am JSONB").
   *
   * Same guard chain and same rate limit as the KI pair below, and for the
   * same reason: this is the same kind of route on the same row, behind the
   * same superadmin boundary — a second controller here would be a second
   * answer to a question `system-settings.repository.ts` already settles once
   * ("writing belongs to the superadmin routes … and to nothing else").
   */
  @Get('mail')
  readMail(): Promise<SystemMailSettingsResponse> {
    return this.mail.read();
  }

  /**
   * The AI configuration — the same row, the same
   * guard, the same rate limit as the two pairs above.
   *
   * ⚠️ **The key never goes out.** The response carries `apiKeySet`, not
   * the value; `systemAiSettingsSchema` is a `strictObject`, so that a server
   * that did send it along fails on loading in the client instead of bringing a
   * secret onto the screen.
   */
  @Get('ai')
  readAi(): Promise<SystemAiSettingsResponse> {
    return this.ai.read();
  }

  @Put('ai')
  replaceAi(@Body() body: unknown): Promise<SystemAiSettingsResponse> {
    return this.ai.replace(
      parseRequest(updateSystemAiSettingsRequestSchema, body),
    );
  }

  /**
   * The **notification templates** of the installation (ADR-0022,
   * continuation 2026-08-18) — the third pair on the same row, behind
   * the same guard and under the same rate limit.
   *
   * It is the pair that did not exist for a long time: the column was read and
   * written by nothing. What comes with this route is therefore not only
   * a controller pair, but also the counter without which a write path on
   * a shared row silently overwrites somebody else's change
   * (`20260818100000_notification_templates_revision`).
   */
  @Get('notification-templates')
  readTemplates(): Promise<SystemNotificationTemplatesResponse> {
    return this.templates.read();
  }

  @Put('notification-templates')
  replaceTemplates(
    @Body() body: unknown,
  ): Promise<SystemNotificationTemplatesResponse> {
    return this.templates.replace(
      parseRequest(updateSystemNotificationTemplatesRequestSchema, body),
    );
  }

  /**
   * The **legal texts of the installation** (ADR-0028) — the fourth pair on
   * the same row, behind the same guard and under the same rate limit.
   *
   * ⚠️ **The write path lies here and the delivery elsewhere.** What is
   * stored here is read by the public path without any sign-in
   * (`public/public-legal.controller.ts`) — that is the whole purpose. Whoever
   * changes something on this pair thereby changes what strangers get to see, and
   * the allow-list that makes that safe stands in `legal-text.ts`.
   */
  @Get('legal')
  readLegal(): Promise<SystemLegalResponse> {
    // `readForAdmin`: diese Seite braucht zusätzlich, ob die KI-Funktion steht
    // — sonst fehlen ihr die Felder des KI-Abschnitts (Review-Runde 5 Nr. 2).
    return this.legal.readForAdmin();
  }

  @Put('legal')
  replaceLegal(@Body() body: unknown): Promise<SystemLegalResponse> {
    return this.legal.replace(
      parseRequest(updateSystemLegalRequestSchema, body),
    );
  }

  @Put('mail')
  replaceMail(@Body() body: unknown): Promise<SystemMailSettingsResponse> {
    // No `@CurrentAuth()` here: `writeMail` deliberately never records an
    // author (see its own comment), so there is nothing on this route that
    // would use one.
    return this.mail.replace(
      parseRequest(updateSystemMailSettingsRequestSchema, body),
    );
  }
}
