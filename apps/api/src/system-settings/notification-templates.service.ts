import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_TEMPLATES_FLOOR,
  parseSystemNotificationTemplates,
  type NotificationTemplate,
} from '@formsache/shared';
import { z } from 'zod';

import { SystemSettingsRepository } from './system-settings.repository';

/**
 * The delivered notification templates, read from the system row (the requirement,
 * [ADR-0011](../../../../docs/architecture/0011-systemweite-einstellungen.md)).
 *
 * ## Why there is only a tolerant reading here
 *
 * The mail reader next door has its own, and that split is the whole point of
 * the requirement: the settings layer decides whether a submission is accepted, so
 * an unreadable document must not be read as „keine Frist, kein Limit".
 *
 * **A template is not weightless — it carries `triggers` and `toSubmitter`**,
 * which propose when a mail goes out and that it goes to the address the
 * participant typed in. What makes the tolerant reading right is therefore not
 * „entscheidet nichts", it is *what the degradation degrades to* and *when it
 * is read*:
 *
 * 1. **The fallback is the shipped floor**, a narrower and known value — never
 *    something somebody else set and never „keine Einschränkung". Compare the
 *    settings layer, where degrading would mean „keine Frist, kein Limit, kein
 *    Passwort": there the calm answer is the *wider* one, which is exactly why
 *    that path fails closed.
 * 2. **It is read at one moment only**, when the editor is offered something to
 *    start from, and an editor sees what they are applying before they save it.
 *    What a mail later says is the text on the `notification` row, which no
 *    template can reach any more (applying one copies, it does not
 *    link) — so a degraded read cannot change a single notification that already
 *    exists.
 *
 * What *fail closed* would cost is plain: one unreadable installation-wide
 * document would make the notifications page of **every** Organisation answer 503 — a
 * page whose actual content, the stored notifications, is perfectly readable.
 * Degrading leaves the picker offering the text the application ships, which is
 * what it offered before that.
 *
 * ## Three states, two of them the same answer
 *
 * | State | Answer |
 * |---|---|
 * | no row / column NULL — nobody decided anything | {@link NOTIFICATION_TEMPLATES_FLOOR} |
 * | `[]` — decided: offer nothing | `[]` |
 * | present, does not parse | the floor, logged **once** |
 *
 * A stored JSON `null` cannot be told apart from SQL NULL through Prisma, and
 * here that ambiguity costs nothing: both answers are the floor, and the only
 * difference the distinction could make is a log line. That is exactly why the
 * settings layer, where the two answers are „Konstante" and „503", refuses JSON
 * null explicitly (`refuseJsonNull`) instead of relying on the client.
 */
@Injectable()
export class NotificationTemplatesService {
  private readonly logger = new Logger(NotificationTemplatesService.name);

  /**
   * Whether the „does not parse" line has been written, so it is written once
   * per process — the shape `SettingsSecretsService.reported` has, and for the
   * same reason. This path is session-guarded rather than public, so the
   * amplification is smaller, but a broken row here affects every organisation at once.
   */
  private reported = false;

  constructor(private readonly repository: SystemSettingsRepository) {}

  /**
   * What the notification editor is offered.
   *
   * Never throws — see the module comment. The result is a plain array the
   * caller hands to the wire; nothing about it is stored anywhere until an
   * editor applies one and saves the notification it produced.
   */
  async forEditor(): Promise<NotificationTemplate[]> {
    const row = await this.repository.find();
    const stored = row?.notificationTemplates ?? null;
    if (stored === null) {
      // „Nichts entschieden" — no row at all, or a row from before anybody
      // touched the templates. Deliberately not an error and deliberately not
      // backfilled: the absence is the meaning (ADR-0011).
      return [...NOTIFICATION_TEMPLATES_FLOOR];
    }

    try {
      return parseSystemNotificationTemplates(stored);
    } catch (cause) {
      // Only a *parse* failure degrades; anything else is a programming error
      // and has to reach the 500 path where it is loud — the same narrowing
      // every display path in this application makes.
      if (!(cause instanceof z.ZodError)) {
        throw cause;
      }
      // The cause is dropped rather than chained: a Zod error prints the value
      // it choked on, and that value is text somebody wrote (`CONTRIBUTING.md`).
      this.reportOnce();
      return [...NOTIFICATION_TEMPLATES_FLOOR];
    }
  }

  private reportOnce(): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    // `error`, not `warn`: a broken system row is a fault of the installation.
    // `@nestjs/testing` installs a logger whose `warn` is an empty method (the
    // lesson learned before), so `warn` would also make the „genau einmal" proof
    // unobservable.
    this.logger.error(UNREADABLE_NOTIFICATION_TEMPLATES_LOG);
  }
}

/** The one line a broken template document produces, per process. */
export const UNREADABLE_NOTIFICATION_TEMPLATES_LOG =
  'system_setting.notification_templates does not parse; falling back to the shipped templates.';
