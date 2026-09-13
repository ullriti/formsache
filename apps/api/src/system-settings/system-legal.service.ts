import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  aiAvailable,
  aiProviderSchema,
  EMPTY_SYSTEM_LEGAL_PAGES,
  OPERATOR_NAME_SLOT,
  parseStoredSystemLegalPages,
  systemLegalPagesSchema,
  type SystemLegalPages,
  type UpdateSystemLegalRequest,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import {
  INITIAL_LEGAL_REVISION,
  SystemSettingsRepository,
} from './system-settings.repository';

/** The conflict — the same wording as on the mail, KI and template page. */
export const STALE_LEGAL_MESSAGE =
  'Die Rechtstexte wurden zwischenzeitlich von jemand anderem geändert. ' +
  'Bitte lade die Seite neu und übernimm deine Änderung erneut.';

/** The one log line an unreadable document produces per process. */
export const UNREADABLE_LEGAL_LOG =
  'system_setting.legal_pages does not parse; the legal pages of this installation are being served as „nichts hinterlegt".';

export interface SystemLegalDocument {
  readonly pages: SystemLegalPages;
  readonly lock: number;
}

/**
 * Dasselbe für die **Systemverwaltung**, um einen Wahrheitswert reicher: ob die
 * KI-Funktion eingerichtet ist (Review-Runde 5 Nr. 2 — die Begründung steht an
 * `SystemLegalResponse` in `system-settings-wire.ts`).
 */
export interface SystemLegalAdminDocument extends SystemLegalDocument {
  readonly aiActive: boolean;
}

/**
 * **The legal texts of the installation** (ADR-0028) — read by two very
 * different callers, and therefore a service of its own and not two methods on
 * somebody else's.
 *
 * ## Two readers, one tolerance
 *
 * The superadmin page reads in order to edit; the **public** path reads in
 * order to deliver — and with an unreadable document both get the same:
 * „nichts hinterlegt". For once that is not a trade-off but the same right
 * answer in both directions:
 *
 * - For the superadmin page, for the reason
 *   `SystemNotificationTemplatesAdminService` spells out: it is the **one
 *   place at which a broken document can be repaired**, and a 500 would lock
 *   the installation out of the repair.
 * - For the public path, for a sharper one: § 18 Abs. 1 MStV demands „ständig
 *   verfügbar". An imprint that delivers a 500 because of a broken JSONB is
 *   the most expensive conceivable failure of this feature — the page instead
 *   says truthfully that nothing is on file.
 *
 * ## The name of the operator comes out of the imprint
 *
 * {@link operatorName} reads it out of the placeholder the imprint has anyway
 * — **not a second column**. ADR-0019 separates software and installation;
 * introducing a „Name der Installation" of its own would mean having to keep
 * the same statement true twice, and whoever changes the operator in the
 * imprint would not change the second one along with it.
 *
 * It is only named when the imprint uses the **template**: out of a free text
 * of one's own it could only be guessed, and a guessed provider identification
 * is exactly the false statement `docs/legal/README.md` 5.4 decided against.
 */
@Injectable()
export class SystemLegalService {
  private readonly logger = new Logger(SystemLegalService.name);

  private reported = false;

  constructor(private readonly repository: SystemSettingsRepository) {}

  /** What the system settings and the public path read. */
  async read(): Promise<SystemLegalDocument> {
    const row = await this.repository.findLegal();
    const stored = row?.legalPages ?? null;
    return {
      pages: stored === null ? EMPTY_SYSTEM_LEGAL_PAGES : this.parsed(stored),
      lock: row?.legalRevision ?? INITIAL_LEGAL_REVISION,
    };
  }

  /**
   * **Was die Systemverwaltung liest** — die Dokumente *und* ob die KI dieser
   * Installation eingerichtet ist (Review-Runde 5 Nr. 2).
   *
   * Eine eigene Methode und nicht ein Feld an {@link read}: `read` bedient auch
   * den **öffentlichen** Weg, und der liest {@link aiActive} und
   * {@link operatorName} längst selbst. Ein Feld dort hätte jeden Aufruf einer
   * Rechtstextseite eine Abfrage gekostet, die sie schon hat.
   *
   * Die beiden laufen nebenläufig: die Seite soll nicht auf die Summe warten.
   */
  async readForAdmin(): Promise<SystemLegalAdminDocument> {
    const [document, aiActive] = await Promise.all([
      this.read(),
      this.aiActive(),
    ]);
    return { ...document, aiActive };
  }

  /**
   * The name of the operator, or `null`.
   *
   * For the footer of every public page and for the legal texts of every
   * organisation that quote it. `null` means „nicht hinterlegt", and the
   * footer then writes „Betrieb dieser Plattform" without a name — which is
   * true and produces an open point in the system administration, instead of
   * inventing a statement.
   */
  async operatorName(): Promise<string | null> {
    const { pages } = await this.read();
    if (pages.imprint.mode !== 'template') {
      return null;
    }
    const name = (pages.imprint.fills[OPERATOR_NAME_SLOT] ?? '').trim();
    return name === '' ? null : name;
  }

  /**
   * Whether the KI feature of this installation is **set up** — the one
   * condition of the templates that can be resolved out of the configuration.
   *
   * It is resolved and not asked, and that is a decision with consequences in
   * both directions: an operator who switches the KI off and leaves the
   * paragraph standing would describe a processing that does not take place;
   * one who switches it on and forgets the tick would conceal a transfer to a
   * third country. Both are a false statement, and both only arise when a
   * human has to get two things right at the same time.
   *
   * ⚠️ **Without touching the key.** The query checks *that* one is on file
   * and does not fetch it ({@link SystemSettingsRepository.findAiPresence});
   * `aiAvailable` therefore gets a marker instead of the value. The price is
   * named: a key that does stand there but can no longer be unsealed counts as
   * present here — the declaration then names a feature that is in fact
   * absent. That is the direction in which this error is meant to fall: it
   * describes too much and not too little, and the state is an operational
   * error anyway, one that draws attention loudly.
   */
  async aiActive(): Promise<boolean> {
    const presence = await this.repository.findAiPresence();
    if (presence === null) {
      return false;
    }
    const provider = aiProviderSchema.safeParse(presence.aiProvider);
    return aiAvailable({
      enabled: presence.aiEnabled,
      provider: provider.success ? provider.data : null,
      // A marker, not a key: `findAiPresence` has already decided that the
      // column is filled, and `aiAvailable` only asks whether anything stands
      // there at all.
      apiKey: 'hinterlegt',
      model: presence.aiModel,
    });
  }

  /**
   * Replaces the legal texts — completely, never page by page.
   *
   * The lock is checked **before** everything else, as on the three
   * neighbouring pages: an outdated request gets the same 409, regardless of
   * whether it would otherwise have got through. Afterwards the repository
   * writes once more against the same counter value, which closes the narrow
   * race between the read here and the write there.
   */
  async replace(
    request: UpdateSystemLegalRequest,
  ): Promise<SystemLegalAdminDocument> {
    const current = await this.repository.findLegal();
    const currentLock = current?.legalRevision ?? INITIAL_LEGAL_REVISION;
    if (request.lock !== currentLock) {
      throw new ConflictException(STALE_LEGAL_MESSAGE);
    }

    const written = await this.repository.writeLegal(
      currentLock,
      toJson(request.pages),
    );
    if (!written) {
      throw new ConflictException(STALE_LEGAL_MESSAGE);
    }

    // `readForAdmin` und nicht `read`: die Antwort eines Schreibens ist die
    // Nutzlast derselben Seite, und die braucht `aiActive` genauso.
    return this.readForAdmin();
  }

  private parsed(stored: Prisma.JsonValue): SystemLegalPages {
    const result = systemLegalPagesSchema.safeParse(stored);
    if (result.success) {
      return result.data;
    }
    this.reportOnce();
    return parseStoredSystemLegalPages(stored);
  }

  private reportOnce(): void {
    if (this.reported) {
      return;
    }
    this.reported = true;
    // `error` and not `warn`, for the reason the neighbours spell out: a
    // broken system row is an error of the installation, and `@nestjs/testing`
    // swallows `warn`.
    this.logger.error(UNREADABLE_LEGAL_LOG);
  }
}

/**
 * Passes the validated document on as JSON — the same narrow cast
 * `system-mail-admin.service.ts` and the template service use: the value comes
 * out of a Zod schema, carries only strings, truth values and maps of those,
 * and the cast stays confined to this one function.
 */
function toJson(pages: SystemLegalPages): Prisma.InputJsonValue {
  return pages;
}
