import { Injectable, Logger } from '@nestjs/common';
import { effectiveSettings, type FormSettings } from '@formsache/shared';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import {
  SigningService,
  type SigningPurpose,
} from '../common/secret-box/signing.service';
import { SettingsSecretsService } from './settings-secrets.service';

/**
 * „Ist das das Zugangswort dieses Formulars?" — asked by the public password
 * gate, answered with a boolean.
 *
 * ## Why this service exists at all
 *
 * The access word is sealed under `SECRET_BOX_KEY`, so checking it needs the
 * key — and until now nothing on the public fill-in path could reach it. That
 * was a deliberate property: `settings-document.ts` and `settings-enforcement.ts`
 * both *redact* the word instead of opening it, and `PublicFormsService` holds
 * no `SecretBoxService`, so „a path that cannot decrypt cannot leak" was a fact
 * about the import graph rather than a promise.
 *
 * The access-word check cannot be built without opening the word somewhere, and there were two
 * ways to do it. Loosening the redacting parsers would have given the whole
 * public path the plaintext for the sake of one comparison — every future edit
 * of `bySlug` would then have been one keystroke away from putting the word in
 * a payload. This is the other way: **one named service, in the folder where
 * the key already lives, whose entire surface is a predicate.** It takes a form
 * and a string and returns `true` or `false`; there is no method on it that
 * hands anybody a plaintext.
 *
 * What that costs is stated plainly rather than glossed over: `PublicFormsModule`
 * now imports a module that transitively provides `SecretBoxService`, so the
 * import graph no longer proves on its own that the public path cannot decrypt.
 * What still proves it is narrower and has to be checked by reading two
 * constructor lists: `PublicFormsService` injects this service, this service
 * returns a boolean, and the redacting parsers are untouched — the read path
 * still cannot see a word even by accident.
 *
 * ## The comparison
 *
 * Constant-time and **the same amount of work on every path** — the same shape
 * `AuthService.login` has for the same reason. The caller is a
 * stranger on a public route who may try as often as the rate limit allows, and
 * a comparison that returns early on the first differing character is how a
 * secret is guessed one character at a time.
 *
 * Three things make that true here:
 *
 * 1. **Both words are MACed before they are compared**, so the comparison runs
 *    over two 43-character strings whatever the words were. Comparing the
 *    plaintexts directly could not be constant time: `timingSafeEqual` refuses
 *    buffers of different lengths, and the length check in front of it would
 *    hand out the length of the stored word.
 * 2. **The MAC of the offered word is computed on every path**, including the
 *    ones where there is nothing to compare it with — an unknown form, a form
 *    without a password, a settings document that does not parse.
 * 3. **A dummy value is decrypted on those paths too**, which is exactly what
 *    {@link DUMMY_PASSWORD_HASH} does for the login: without it, „dieses
 *    Formular hat gar kein Wort" would come back measurably faster than „das
 *    Wort war falsch".
 */

/** @see SigningPurpose — the subkey this comparison runs under. */
const COMPARE_PURPOSE: SigningPurpose = 'public.access-word';

/**
 * The word compared against when there is no real one, and the value decrypted
 * when there is nothing to decrypt.
 *
 * **What keeps it from ever letting anybody in is the guard in {@link
 * AccessWordService.matches}, not this string.** The comment here used to claim
 * the opposite — „it contains a NUL byte, so no offered word can ever equal it"
 * — and that was false: JSON carries U+0000 without complaint, and
 * `accessRequestSchema` bounded the offer by length while saying nothing about
 * its characters. A stranger could send this constant verbatim. What refused
 * them was `expected !== null && equal`, which never consults the comparison on
 * a form that has no word at all.
 *
 * The claim is now true because two independent things make it true, and both
 * are tested:
 *
 * 1. `accessRequestSchema` (`packages/shared/src/public-form.ts`) refuses
 *    control characters, so this value is **unreachable from the wire**. That
 *    is defence in depth, not the defence.
 * 2. `matches` answers `false` whenever no word is configured, whatever the
 *    comparison said — `access-word.service.spec.ts` offers this very constant
 *    to a form without a password and demands a `false`.
 *
 * Exported for that test. It is not a secret; it is what stands in for the
 * absence of one.
 */
export const DUMMY_WORD = '\u0000no-access-word-configured';

/**
 * Context of the dummy ciphertext.
 *
 * Not one of the two real builders in `secret-context.ts`, and it must not be:
 * a value sealed under a form's or an organisation's context is a value that would open
 * against that row. This one belongs nowhere, which is precisely what makes it
 * safe to keep in memory for the lifetime of the process.
 */
const DUMMY_CONTEXT = 'dummy:access-word-comparison';

/**
 * The two JSONB documents a form's effective settings are made of — the same
 * shape `enforcedSettings` takes, so a caller does not have to select
 * differently for the two paths.
 */
export interface AccessWordSource {
  readonly id: string;
  readonly settingsOverride: unknown;
  readonly tenant: { readonly id: string; readonly formDefaults: unknown };
}

/**
 * The settings document of a form that is not there — so that a guess at an
 * unknown address costs the same comparison as a guess at a real one
 * (bullets 2 and 3).
 *
 * `PublicFormsService.unlock` feeds this to {@link AccessWordService.matches}
 * when the slug resolves to nothing. It lives **here**, next to the type it is
 * an instance of, rather than in the public module: it is a fifth source of the
 * comparison, and the unit test that counts the work done per source has to be
 * able to name it without importing a service that holds a `PrismaService`.
 *
 * The ids are placeholders and never reach a query; they exist because
 * `secret-context.ts` refuses to build a context out of anything that is not
 * shaped like an id, and a comparison that threw here would answer a probe with
 * a 500. Both documents are empty, which means „nichts entschieden", which means
 * no access word — so this can only ever produce `false`.
 */
export const ABSENT_FORM: AccessWordSource = Object.freeze({
  id: '00000000-0000-0000-0000-000000000000',
  settingsOverride: {},
  tenant: Object.freeze({
    id: '00000000-0000-0000-0000-000000000000',
    formDefaults: {},
  }),
});

@Injectable()
export class AccessWordService {
  /** Where the *reason* goes; the caller only ever learns `false`. */
  private readonly logger = new Logger(AccessWordService.name);

  /**
   * A sealed value that stands for „nothing to open", produced once at
   * construction.
   *
   * Sealed rather than hard-coded, because a ciphertext in the source would be
   * a ciphertext under somebody else's key and would fail to open here — which
   * would make the equalising path *cheaper* than the real one instead of
   * equally expensive, i.e. exactly the oracle it exists to close.
   */
  private readonly dummySealed: string;

  /**
   * Which „does not parse"-lines have already been written, so each is written
   * once per process lifetime — the same reasoning as
   * `PublicFormsService.reportedDocuments`: this is a route strangers call, and
   * a log line per request is a log amplifier aimed at whichever organisation's row is
   * already broken.
   */
  private readonly reported = new Set<string>();

  constructor(
    private readonly box: SecretBoxService,
    private readonly signing: SigningService,
    private readonly secrets: SettingsSecretsService,
  ) {
    this.dummySealed = this.box.seal(DUMMY_WORD, DUMMY_CONTEXT);
  }

  /**
   * Whether `offered` is the access word that applies to this form.
   *
   * `false` for every way this can fail to be true, and they are deliberately
   * not told apart: a wrong word, a form without a password, a form whose
   * settings do not parse, a sealed value that will not open. The caller answers
   * all of them with the one 404 the public routes give an address that leads
   * nowhere (second bullet).
   *
   * **Fail closed.** An unreadable document answers `false`, never „kein
   * Passwortschutz" — the same rule `settings-enforcement.ts` is built around.
   * The read path locks such a form for the same reason, so the two agree: a
   * form nobody can open stays shut rather than falling open.
   *
   * **Two documents decide it and nothing else** (ADR-0011, continuation
   * 2026-08-14): the organisation's standard and the form's override. The
   * merge is `effectiveSettings`, not a second and shorter one written here —
   * „was gilt?" has one answer.
   */
  matches(source: AccessWordSource, offered: string): boolean {
    const expected = this.expectedWord(source);

    // Both MACs, always — `expected` is only consulted after the comparison has
    // already run, so no path is shorter than any other.
    const offeredMac = this.signing.sign(COMPARE_PURPOSE, offered);
    const equal = this.signing.verify(
      COMPARE_PURPOSE,
      expected ?? DUMMY_WORD,
      offeredMac,
    );

    return expected !== null && equal;
  }

  /**
   * The configured word, or `null` — with the decryption cost paid either way.
   */
  private expectedWord(source: AccessWordSource): string | null {
    const settings = this.openSettings(source);
    if (
      settings === null ||
      !settings.passwordEnabled ||
      settings.password.length === 0
    ) {
      // Point 3 of the file comment: the AES-GCM open that the configured case
      // performs happens here too, so „no word" costs what „wrong word" costs.
      this.box.open(this.dummySealed, DUMMY_CONTEXT);
      return null;
    }
    return settings.password;
  }

  /**
   * The effective settings **with the word opened**, or `null`.
   *
   * Built from `SettingsSecretsService` rather than from a second strict parser
   * next to `settings-enforcement.ts`: that module redacts on purpose and stays
   * that way, and the opening parsers already exist and are the ones the editor's
   * settings page is read through. What is added here is only the merge — the
   * same shared `effectiveSettings()` both other readings use, so „was gilt?"
   * keeps having one answer.
   */
  private openSettings(source: AccessWordSource): FormSettings | null {
    try {
      return effectiveSettings(
        this.secrets.openTenantDefaults(
          source.tenant.formDefaults,
          source.tenant.id,
        ),
        this.secrets.openFormOverride(
          source.settingsOverride,
          source.tenant.id,
          source.id,
        ),
      );
    } catch {
      // The cause is dropped rather than logged: a Zod error prints the value
      // it choked on, and that value is a settings document holding an access
      // word (proof 4). What is actionable is *which* form.
      this.reportOnce(
        `settings of form ${source.id} (tenant ${source.tenant.id}) cannot be read; ` +
          'refusing every access word for it (fail closed).',
      );
      return null;
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
