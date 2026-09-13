import {
  REDACTED_PASSWORD,
  effectiveSettings,
  parseFormSettingsOverride,
  parseTenantFormDefaults,
  type FormSettings,
  type FormSettingsOverride,
  type TenantFormSettings,
} from '@formsache/shared';
import { z } from 'zod';

import {
  mapOverridePassword,
  mapTenantDefaultsPassword,
} from './settings-document';

/**
 * The **strict** read of a settings document — the one enforcement uses.
 *
 * It is a second path deliberately placed *next to* the tolerant one in
 * `settings-document.ts`, not in place of it. Both read the same two JSONB
 * columns and they answer an unreadable document in opposite ways, because they
 * are asked different questions:
 *
 * | | `safeRedacted…` (display) | this file (enforcement) |
 * |---|---|---|
 * | asks | „was zeigen wir an?" | „nehmen wir diese Absendung an?" |
 * | unreadable document | shipped defaults, logged | **refuses**, {@link UnreadableSettingsError} |
 *
 * **Why the tolerant fallback must not be inherited here.** The settings
 * schemas are `strictObject`, so a key written by a *newer* deployment is a
 * parse error in an older one — the ordinary state during a rolling deploy, a
 * rollback, or with two replicas of different versions. On the display path
 * that has to degrade, or one bad `tenant.form_defaults` answers 500 for every
 * form of an organisation. On the enforcement path the same fallback would read
 * „unreadable" as „no deadline, no limit, no password" and would **open a
 * closed form** in the moment a document stopped parsing — a registration that
 * was shut on Sunday accepting answers again on Monday because of a deploy.
 *
 * So enforcement fails closed: an unreadable document refuses the submission
 * and nothing is written. That is the strictly worse outcome for availability
 * and the strictly better one for correctness, and only one of the two can be
 * corrected afterwards — a refused participant reloads, an answer accepted past
 * the deadline is already in the organisation's list.
 *
 * **Still redacted, like the display path.** The access word is replaced rather
 * than opened, and this module holds no `SecretBoxService` — a path that cannot
 * decrypt cannot leak, however it is edited later. The other checks read
 * deadlines, limits and the time limit; none of them needs the word. The
 * password check will need it and has to obtain it where the key lives,
 * not by loosening this file.
 */

/**
 * The settings of this form cannot be read, so nothing may be decided from
 * them.
 *
 * Its own type rather than a Nest exception: this module is pure and knows
 * nothing about HTTP. The caller turns it into an answer and logs *what* it
 * happened to — the ids belong in the log line, and nothing about the document
 * belongs in the response.
 */
export class UnreadableSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableSettingsError';
  }
}

/**
 * A stored JSON `null` — the one document shape enforcement must **not** read
 * as „nichts entschieden".
 *
 * The shared parsers answer `null` and `undefined` alike with the shipped
 * defaults, and for them that is right: their contract is „an absent column
 * means nothing was decided" (no backfill). But there is no
 * absent column here. Both `tenant.form_defaults` and `form.settings_override`
 * are `JSONB **NOT NULL** DEFAULT '{}'` (`20260726191937_init_tenancy_and_auth`
 * and `20260727180000_form_settings_override`), so „nichts entschieden" is
 * spelled `{}` and always has been. What reaches this branch is a literal JSON
 * `null` inside the column — a value nobody's write path produces, and reading
 * it as „keine Frist, kein Limit" is exactly the fail-open this module exists
 * to prevent.
 *
 * `undefined` stays tolerated, because that is not a document at all: it is a
 * property missing from the object handed in, which only a partial `select` can
 * produce, and answering it here would hide a query bug behind a 503.
 */
function refuseJsonNull(stored: unknown, what: string): void {
  if (stored === null) {
    throw new UnreadableSettingsError(`${what} is JSON null`);
  }
}

/**
 * The organisation's standard, strictly, with the access word replaced.
 *
 * The column carries the complete standard (review finding 10), and the gaps of
 * a row that predates a key are filled from the shipped constant by
 * `parseTenantFormDefaults` — in `@formsache/shared`, so nothing about what an
 * absent key means is decided here. The strict reading and the tolerant one
 * differ only in how they answer an unreadable row.
 */
function strictRedactedTenantDefaults(stored: unknown): TenantFormSettings {
  return parseTenantFormDefaults(
    mapTenantDefaultsPassword(stored, () => REDACTED_PASSWORD),
  );
}

/** A form's override, strictly, with the access word replaced. */
function strictRedactedFormOverride(stored: unknown): FormSettingsOverride {
  return parseFormSettingsOverride(
    mapOverridePassword(stored, () => REDACTED_PASSWORD),
  );
}

export interface EnforcementSource {
  readonly id: string;
  readonly settingsOverride: unknown;
  readonly tenant: { readonly id: string; readonly formDefaults: unknown };
}

/**
 * What applies to this form, or a refusal to guess.
 *
 * The merge itself is the shared `effectiveSettings()`, exactly as on the
 * display path — the difference between the two readings is what happens
 * *before* the merge, never a second answer to „was gilt?".
 *
 * The two documents are read separately so the error can name which of them is
 * broken. An **empty** document (`{}`, the column default) still means „nichts
 * entschieden" (no backfill) and reads as the shipped constant; a
 * stored JSON `null` does not — see {@link refuseJsonNull}.
 *
 * **Two documents, and there is no third** (ADR-0011, continuation
 * 2026-08-14). While an installation-wide layer existed, the caller had to
 * resolve it first and refuse before reaching this point; that layer is gone,
 * so what a form is worth is decided by the two rows this function is handed.
 */
export function enforcedSettings(source: EnforcementSource): FormSettings {
  const tenantWhat = `form_defaults of tenant ${source.tenant.id}`;
  const formWhat = `settings_override of form ${source.id}`;

  let tenantDefaults: TenantFormSettings;
  refuseJsonNull(source.tenant.formDefaults, tenantWhat);
  try {
    tenantDefaults = strictRedactedTenantDefaults(source.tenant.formDefaults);
  } catch (cause) {
    // The cause is dropped rather than chained: the document holds an access
    // word, and a Zod error prints the value it choked on.
    throwUnreadable(cause, `${tenantWhat} do not parse`);
  }

  let override: FormSettingsOverride;
  refuseJsonNull(source.settingsOverride, formWhat);
  try {
    override = strictRedactedFormOverride(source.settingsOverride);
  } catch (cause) {
    throwUnreadable(cause, `${formWhat} does not parse`);
  }

  return effectiveSettings(tenantDefaults, override);
}

/**
 * „Das Dokument parst nicht" — but **only** for a failure that really is a
 * parse failure.
 *
 * The two blocks above used to catch bare, and that swallowed more than they
 * meant to: a `TypeError` from a bug in this module or in the shared merge came
 * out as „unreadable document" and was answered with a calm 503 that says the
 * state resolves itself. It never would. Fail closed is not affected either way
 * — nothing is written in both cases — but the diagnosis is: a programming
 * error has to reach the 500 path, where it is loud.
 */
function throwUnreadable(cause: unknown, message: string): never {
  if (cause instanceof z.ZodError) {
    throw new UnreadableSettingsError(message);
  }
  throw cause;
}
