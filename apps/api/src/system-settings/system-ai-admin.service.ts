import { ConflictException, Injectable } from '@nestjs/common';
import type { UpdateSystemAiSettingsRequest } from '@formsache/shared';

import { AiSettingsService } from './ai-settings.service';
import type { SystemAiSettingsResponse } from './system-settings-wire';

/**
 * The conflict when someone else was faster — the same wording as on the mail
 * page, because it is the same situation: the page holds a document that is by
 * now no longer the stored one.
 */
export const AI_SETTINGS_CONFLICT_MESSAGE =
  'Die KI-Einstellungen wurden zwischenzeitlich von jemand anderem geändert. ' +
  'Bitte lade die Seite neu und übernimm deine Änderung erneut.';

/**
 * **The superadmin side of the AI configuration** .
 *
 * Thin on purpose: the resolution, the unsealing and the three states of the
 * key live in {@link AiSettingsService}, because the route is not the only
 * reader — the guard and the session payload ask the same service. What is
 * added here is the envelope shape and the 409.
 *
 * ⚠️ **No `@CurrentAuth()`**, as on the mail page: the row keeps a
 * "last changed by" column only for the form defaults, and a superadmin who
 * sets the AI provider must not appear there as the one who last touched the
 * defaults.
 */
@Injectable()
export class SystemAiAdminService {
  constructor(private readonly settings: AiSettingsService) {}

  async read(): Promise<SystemAiSettingsResponse> {
    const { settings, gap, revision } = await this.settings.readForAdmin();
    return { values: settings, gap, lock: revision };
  }

  async replace(
    request: UpdateSystemAiSettingsRequest,
  ): Promise<SystemAiSettingsResponse> {
    if (!(await this.settings.write(request))) {
      throw new ConflictException(AI_SETTINGS_CONFLICT_MESSAGE);
    }
    return this.read();
  }
}
