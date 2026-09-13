import { Injectable, Logger } from '@nestjs/common';
import {
  isUnusableReplyTo,
  normaliseBaseUrl,
  type ReplyToLevel,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import { SystemSettingsRepository } from './system-settings.repository';

/**
 * The two installation-wide values that used to be environment variables
 * : the **system mail block** and the
 * **base address**.
 *
 * ## Why they are a service of their own
 *
 * One row, three readers, three different questions — and the tolerances
 * differ. An absent mail server is a normal state, and an absent base address
 * means „no link", which is the only safe answer there is; the notification
 * templates answer „nichts entschieden" with the shipped ones. Putting them on
 * one class would invite a caller to reach for the wrong tolerance, which is
 * the split `NotificationTemplatesService` already makes on the same row.
 *
 * ## The block leaves here **sealed**
 *
 * {@link storedSmtp} hands back what the column holds. The key lives in
 * `MailSecretsService` next to the queue that needs it; a settings module that
 * opened secrets would be a second place holding the key, and this one is the
 * file allowed to reach `PrismaService`.
 *
 * ## No cache, for the reason ADR-0011 gives
 *
 * The row is read afresh. A per-process cache would be invalidated in the
 * container that served the write and stale in every other one — and the value
 * it would hold is the mail server of the whole installation.
 */
@Injectable()
export class SystemMailSettingsService {
  private readonly logger = new Logger(SystemMailSettingsService.name);

  /** One line per broken value per process — see `SettingsSecretsService`. */
  private readonly reported = new Set<string>();

  constructor(private readonly repository: SystemSettingsRepository) {}

  /**
   * The installation's mail block as stored — sealed password included — or
   * `null` for „noch nicht eingerichtet".
   *
   * `findSmtp`, not the wider `findMailForAdmin`: this method
   * runs on the public fill-in path, and the base address has no business
   * riding along with a sealed password on a participant's request
   * (data minimisation — see the projection's own comment in the repository).
   */
  async storedSmtp(): Promise<Prisma.JsonValue | null> {
    return (await this.repository.findSmtp())?.smtp ?? null;
  }

  /**
   * The address this installation answers under, or `null`.
   *
   * **Checked on the way out, not merely on the way in.** The column is plain
   * `text`, and a value can reach it past the API — the same second gate the
   * branding of the requirement and the OIDC issuer apply. A stored value
   * that is not a base address answers `null`, which downstream means „kein
   * Link": the mechanics leave `{{bearbeiten}}` unresolved and the rest
   * of the text standing.
   *
   * That is the fail-closed direction. The alternative — handing the raw string
   * on — would put whatever is in the column at the front of a link in somebody
   * else's inbox, where it cannot be recalled.
   */
  async publicBaseUrl(): Promise<string | null> {
    const stored = (await this.repository.findBaseUrl())?.publicBaseUrl ?? null;
    if (stored === null) {
      return null;
    }
    const normalised = normaliseBaseUrl(stored);
    if (normalised === null) {
      // The value is not logged: it came out of a column, and a base address
      // can carry anything somebody typed.
      this.reportOnce(
        'system_setting.public_base_url is not an absolute http(s) base address; reporting it as unset.',
      );
      return null;
    }
    return normalised;
  }

  /**
   * The installation-wide default for `Reply-To`, or `null`.
   *
   * **Returned raw — unlike {@link publicBaseUrl} one method further
   * up, and that is deliberate.** The second gate does *not* decide here, because
   * it decides one level further up for all three levels at once:
   * `effectiveReplyTo` lets an unusably stored value fall through
   * and reaches for the next level. Deciding here would mean writing the same
   * rule twice — and the copy that drifts off would be the one that knows only one
   * of the three levels.
   *
   * The base address cannot do it that way: it has no level below it
   * that could step in, so its failure has to be decided where
   * it shows up.
   *
   * **It is reported nonetheless** (a review finding of the reply-to review). Falling through
   * is the right *effect* and nevertheless a silent failure: a
   * hand-written line like `geschaeftsstelle@lokal` takes the header away from
   * every mail of this installation without anything about it standing anywhere — in the
   * interface the address still stands in the field. The report changes nothing about
   * the resolution; it only makes visible that one level contributes nothing.
   */
  async replyTo(): Promise<string | null> {
    const stored = (await this.repository.findReplyTo())?.replyTo ?? null;
    if (isUnusableReplyTo(stored)) {
      // The value is not logged along — as with the base address one
      // method further up: it came out of a column, and a reply-to address
      // is an e-mail address (`CONTRIBUTING.md`).
      this.reportOnce(
        'system_setting.reply_to is not a bare e-mail address; no Reply-To header will be derived from it.',
      );
    }
    return stored;
  }

  /**
   * The two **lower** levels of the chain for an organization, in the order
   * in which they apply: first the organization, then the installation.
   *
   * Here, although the organization is not an installation-wide value — and therefore without
   * any access to a `tenant` row: the value is **handed in**,
   * from the side that has loaded the row anyway. What this method
   * contributes is what would otherwise stand there twice: the order of the two
   * levels (`PublicFormsService` and `TestMailService` each built it themselves)
   * and the reporting of an unusable value on **both** levels.
   *
   * The **evaluation** still does not stand here, but in the one rule:
   * `effectiveReplyTo`. What comes out here are raw values — **named**
   * raw values/0.1: which level a value is, this method knows
   * anyway, and a caller who had to derive it from the position would have
   * an opportunity to get it wrong at every call site — today there are three
   * (`TestMailService` hands *two* levels into the chain, `PublicFormsService`
   * *three*, and `NotificationsService` does not evaluate the topmost one itself
   * at all). "Level 1" would mean different things at these three places.
   */
  async replyToDefaults(
    /**
     * Die Organisation — oder `null`, wenn es keine gibt.
     *
     * `null` ist seit Review-Runde 3 Nr. 12 möglich und meint genau einen
     * Fall: die Testmail der Systemverwaltung, ausgelöst von jemandem ohne
     * Mitgliedschaft. Dann hat die Kette nur ihre untere Hälfte, und das ist
     * keine Ausnahme, sondern die Wahrheit — es gibt keine Organisation,
     * deren Antwortadresse gelten könnte.
     *
     * Ausdrücklich `null` und nicht „eine Organisation mit `replyTo: null`":
     * die beiden sähen im Ergebnis gleich aus und meinten Verschiedenes, und
     * die Meldung über einen unbrauchbaren Wert bräuchte eine Kennung, die es
     * nicht gibt.
     */
    tenant: {
      readonly id: string;
      readonly replyTo: string | null;
    } | null,
  ): Promise<readonly ReplyToLevel[]> {
    if (tenant === null) {
      return [{ origin: 'system', value: await this.replyTo() }];
    }
    if (isUnusableReplyTo(tenant.replyTo)) {
      // Once per organization, not per mail: `reportOnce` keys over the
      // message, so the id belongs in it. Not the value — see above.
      this.reportOnce(
        `tenant.reply_to of ${tenant.id} is not a bare e-mail address; no Reply-To header will be derived from it.`,
      );
    }
    return [
      { origin: 'tenant', value: tenant.replyTo },
      { origin: 'system', value: await this.replyTo() },
    ];
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}
