import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  parseFormSettingsOverride,
  parseTenantFormDefaults,
  type FormSettingsOverride,
  type TenantFormSettings,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import {
  formOverrideContext,
  tenantDefaultsContext,
} from '../common/secret-box/secret-context';
import { SecretBoxService } from '../common/secret-box/secret-box.service';
import {
  mapOverridePassword,
  mapTenantDefaultsPassword,
} from './settings-document';

/** The one secret a settings document holds — see `secret-context.ts`. */
const ACCESS_PASSWORD = 'access.password';

/**
 * What the caller is told when a stored access word cannot be opened.
 *
 * Deliberately without detail: whoever sees it is an editor, not an attacker,
 * and the reason — wrong key, rotated key, a value moved in from another row —
 * is a server fact that belongs in the log next to what it happened *to*, never
 * in a response.
 */
export const UNREADABLE_SETTINGS_MESSAGE =
  'Die gespeicherten Einstellungen konnten nicht gelesen werden.';

/**
 * Sealing and opening the one secret inside a settings document.
 *
 * The service holds the {@link SecretBoxService} and nothing else; *where* the
 * secret sits is `settings-document.ts`, which is pure. The two concerns can
 * then be reviewed apart — and the public fill-in path can import the shape
 * knowledge without ever importing the key holder.
 *
 * **Both JSONB columns carry the word, and each is bound to its own place.**
 * A tenant standard is sealed under `tenantDefaultsContext(tenantId, …)`, a
 * form override under `formOverrideContext(tenantId, formId, …)`. The two
 * contexts can never coincide, so a sealed value cannot be copied from one row
 * into another — not between forms and, above all, not across the tenant
 * boundary this project treats as a security boundary rather than a display
 * question (`CONTRIBUTING.md`).
 *
 * **The consequence that is easy to miss: taking a section over re-seals.**
 * Switching *Zugriff & Sicherheit* to „Angepasst" copies the organisation's word into
 * the form's own document (`setSectionOverride`), and under two different
 * contexts a copy of the stored *string* would be a value nobody can open
 * again. What makes that impossible here is the shape of the write path rather
 * than a rule somebody has to remember: everything between `open…` and `seal…`
 * is **plaintext**, so a copy is a copy of the word and the sealing happens
 * once, at the end, under the context of wherever it ended up.
 */
@Injectable()
export class SettingsSecretsService {
  /** Where the *reason* goes; the caller only learns that it failed. */
  private readonly logger = new Logger(SettingsSecretsService.name);

  /**
   * Which „cannot be opened"-lines have already been written, so each is
   * written **once per process lifetime**.
   *
   * The same shape — and the same reason — as `PublicFormsService.reportedDocuments`
   * and `AccessWordService.reported`, and it belongs here changed who
   * can reach this code. Until then `open()` was only called behind a session by
   * somebody holding one of the two settings rights; a line per call was a
   * line per editor
   * page load. The password gate calls it on an **unauthenticated** route, so a
   * rotated or mismatched key turned this into one `logger.error` per gate
   * attempt — ten a minute per address, from as many addresses as an outsider
   * cares to use, aimed at exactly the organisation whose row is already broken. That is
   * the amplifier the two sets above were built against, and the new caller went
   * straight past both.
   *
   * Keyed by the finished message, which is the context: it separates by tenant,
   * by form and by field, and it is bounded by the number of broken rows rather
   * than by traffic. Nothing a caller writes reaches it — the context is built
   * from ids that came out of the database and a fixed field name.
   */
  private readonly reported = new Set<string>();

  constructor(private readonly box: SecretBoxService) {}

  /**
   * The organisation's standards, word included — **one complete document**
   * (review finding 10).
   *
   * A key this document does not carry falls to the shipped constant — there is
   * no layer below the organisation to read (ADR-0011, continuation
   * 2026-08-14), which is one database this service does not have to reach.
   *
   * There were two methods here until the switches went: „das gespeicherte
   * Dokument" for the write path and „was es bedeutet" for the reading ones.
   * The two are the same thing now, so there is one.
   *
   * ## „…wie `can_manage_settings` es sehen darf" once stood here, and that was
   * wrong (a security finding)
   *
   * This method opens the word for **everybody** who calls it; it knows no
   * right and checks none. The sentence once described the callership, and then
   * came ADR-0021 and with it a second, narrower right
   * (`can_manage_form_settings`) — the callership changed, the sentence did
   * not, and the decrypted document stood in the response of a route that
   * should never have shown it.
   *
   * **Whoever may not show the word does not call this**, but
   * `redactedTenantDefaults` in `settings-document.ts` — that one replaces the
   * sealed value unopened. The decision falls at
   * `FormSettingsService.shownTenantDefaults`, that is where the caller's right
   * is known, and not in a comment here.
   */
  openTenantDefaults(stored: unknown, tenantId: string): TenantFormSettings {
    const context = tenantDefaultsContext(tenantId, ACCESS_PASSWORD);
    return parseTenantFormDefaults(
      mapTenantDefaultsPassword(stored, (sealed) => this.open(sealed, context)),
    );
  }

  /** A form's override as `can_manage_form_settings` may see it, word included. */
  openFormOverride(
    stored: unknown,
    tenantId: string,
    formId: string,
  ): FormSettingsOverride {
    const context = formOverrideContext(tenantId, formId, ACCESS_PASSWORD);
    return parseFormSettingsOverride(
      mapOverridePassword(stored, (sealed) => this.open(sealed, context)),
    );
  }

  /**
   * The organisation's standards on the way into JSONB, access word sealed.
   *
   * Takes the complete document the organisation decided — since review finding
   * 10 there is no second, „nicht übernommener" half of it that could leave an
   * orphaned ciphertext behind for a word nobody can reach any more.
   *
   * Everything between `open…` and `seal…` is **plaintext**, which is what
   * makes the context binding structural: a word that arrives here is a word,
   * never a ciphertext sealed somewhere else, so it is sealed once and under
   * the context of the row it ends up in.
   */
  sealTenantDefaults(
    defaults: TenantFormSettings,
    tenantId: string,
  ): Prisma.InputJsonValue {
    const context = tenantDefaultsContext(tenantId, ACCESS_PASSWORD);
    return toJson(
      mapTenantDefaultsPassword(defaults, (plain) =>
        this.box.seal(plain, context),
      ),
    );
  }

  /** A form's override on the way into JSONB, access word sealed. */
  sealFormOverride(
    override: FormSettingsOverride,
    tenantId: string,
    formId: string,
  ): Prisma.InputJsonValue {
    const context = formOverrideContext(tenantId, formId, ACCESS_PASSWORD);
    return toJson(
      mapOverridePassword(override, (plain) => this.box.seal(plain, context)),
    );
  }

  /**
   * Opens one sealed value, or refuses the whole read.
   *
   * **Refusing is the deliberate half.** The tempting alternative — hand back
   * an empty word and log a warning — would show an editor a settings page
   * claiming the form has no password while a form that very much has one keeps
   * turning people away. A key rotated without its data, a hand-edited row, or
   * a value carried in from somewhere it does not belong is a real fault;
   * saying so is the only answer that does not lie.
   */
  private open(sealed: string, context: string): string {
    try {
      return this.box.open(sealed, context);
    } catch {
      // Neither the sealed value nor the plaintext reaches the log — only the
      // context, which is made of ids and a field name and is what makes the
      // line actionable (`CONTRIBUTING.md`). `SecretBoxError` messages are fixed
      // constants, but they are dropped anyway: this code must not depend on
      // somebody keeping them that way.
      //
      // Once per context, not once per call — see {@link reported}. The throw
      // is unconditional; only the *line* is rationed, so nothing about the
      // refusal depends on whether this process has seen the fault before.
      this.reportOnce(`Stored secret at ${context} cannot be opened.`);
      throw new InternalServerErrorException(UNREADABLE_SETTINGS_MESSAGE);
    }
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}

/**
 * Hands a settings document to Prisma as JSON.
 *
 * The documents come from the shared schemas and hold nothing but strings,
 * numbers, booleans and nulls, but the *mapped* copies are `unknown` by
 * construction — `mapPassword` cannot promise more than its input did. The cast
 * is confined to this one function rather than repeated at four call sites.
 */
function toJson(document: unknown): Prisma.InputJsonValue {
  return document as Prisma.InputJsonValue;
}
