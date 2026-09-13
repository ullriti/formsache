import {
  REDACTED_PASSWORD,
  parseFormSettingsOverride,
  parseTenantFormDefaults,
  type FormSettingsOverride,
  type TenantFormSettings,
} from '@formsache/shared';

/**
 * Where the one secret sits inside a settings document — and nothing about how
 * it is protected.
 *
 * The split from `settings-secrets.service.ts` is deliberate. Everything here is pure
 * and holds no key material, so the **public** fill-in path can import it
 * without pulling the cipher, its module or its key token into reach. The claim
 * "a path that cannot decrypt cannot leak" is then a fact about the import
 * graph rather than a promise about how somebody will edit the file.
 *
 * The access word lives *inside* JSONB, not in a column of its own, so it
 * cannot be protected by the column type the way `oidc_client_secret_encrypted`
 * is. What protects it instead is that every read of `tenant.form_defaults` and
 * `form.settings_override` in the application goes through one of the parsers
 * below or one of the two in `settings-secrets.service.ts` — and each of them states
 * what happens to that one key.
 */

/**
 * The marker this module writes in place of the access word lives in
 * `@formsache/shared` ({@link REDACTED_PASSWORD}) and is only imported here.
 * It travels to the browser inside `tenantDefaults` and `effective`, so the
 * side that has to *recognise* it is the settings page — and a second spelling
 * over there is how an editor ends up looking at a NUL byte in the field
 * *Zugangspasswort*. What the value is, and why it is not the empty string, is
 * written at the constant itself.
 */

/** A JSON object, as opposed to an array, a scalar or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `document` with its `password` entry put through `map`.
 *
 * An **empty** word is left alone: `SecretBoxService.seal` refuses an empty
 * secret outright, and sealing one would anyway mean every untouched form
 * carried a secret-looking blob for a secret nobody set. Absence stays absence.
 */
export function mapPassword(
  document: unknown,
  map: (stored: string) => string,
): unknown {
  if (!isJsonObject(document)) {
    return document;
  }
  const password = document.password;
  if (typeof password !== 'string' || password === '') {
    return document;
  }
  return { ...document, password: map(password) };
}

/** The same, one level down — a form override keeps its values in `values`. */
export function mapOverridePassword(
  document: unknown,
  map: (stored: string) => string,
): unknown {
  if (!isJsonObject(document)) {
    return document;
  }
  const values = document.values;
  if (values === undefined) {
    return document;
  }
  return { ...document, values: mapPassword(values, map) };
}

/**
 * A stored `tenant.form_defaults` with its access word put through `map`.
 *
 * The organisation's column carries **one flat document** (review finding 10),
 * so the word sits at the top level and this is {@link mapPassword} under the
 * name of the reader that needs it. It carried `{ overridden, values }` until
 * 2026-08-17 and the word sat one level down; the migration
 * `20260817120000_tenant_form_defaults_flat` writes the shape out physically,
 * so there is no second answer to "which row is old?" here — a row that
 * still has the wrapper fails to parse (`parseTenantFormDefaults`).
 *
 * A name of its own rather than a call to {@link mapPassword} at each site: the
 * two columns are two shapes, and the reader that has to know which is which is
 * this file.
 */
export function mapTenantDefaultsPassword(
  stored: unknown,
  map: (value: string) => string,
): unknown {
  return mapPassword(stored, map);
}

const redact = (): string => REDACTED_PASSWORD;

/**
 * The organisation's standard **without** the access word.
 *
 * One step since review finding 10: the column carries the complete standard its
 * forms inherit, and `parseTenantFormDefaults` fills whatever gaps a row has
 * from the shipped constant. There used to be a second step here — the document
 * said which sections the organisation had decided, and a merge turned that
 * into what applies — and dropping it is the whole point of that finding.
 *
 * ## Two callers, and the second is the reason for the `export`
 *
 * The first is the tolerant call further down, for the public
 * fill-in path. The second is the **settings page of a form**
 * (ADR-0021, a security finding): it stands behind
 * `can_manage_form_settings`, and until then its response carried the decrypted
 * document of the organisation — access word included. An `editor` thereby reached
 * the organisation-wide word that protects the forms of **others**.
 *
 * This function is the right one there, and not a post-processing of the
 * decrypted response: it **does not decrypt in the first place**. Whoever may not
 * see the word does not resolve it either — the same build from which the
 * head of this file carries "a path that cannot decrypt cannot leak"
 * as a fact about the import graph.
 *
 * Strict and not tolerant (see {@link safeRedactedTenantDefaults}): on the
 * settings page an unreadable document is an error that somebody is to see,
 * not a display detail that one may let drop.
 */
export function redactedTenantDefaults(stored: unknown): TenantFormSettings {
  return parseTenantFormDefaults(mapTenantDefaultsPassword(stored, redact));
}

/** A form's override **without** the access word — see above. */
function redactedFormOverride(stored: unknown): FormSettingsOverride {
  return parseFormSettingsOverride(mapOverridePassword(stored, redact));
}

/**
 * The same two, but returning `null` instead of throwing on a document that
 * does not parse.
 *
 * **For the public fill-in path only, and the distinction is deliberate.** The
 * settings documents are `strictObject`, so a key an *older* deployment does
 * not know is a parse error — and that is a normal state during a rolling
 * deploy, a rollback, or with two replicas of different versions. On the public
 * path the settings are incidental: three display flags and a verdict. Letting
 * them turn a whole organisation's forms into 500s would trade a cosmetic degradation
 * for an outage, right next to a line that already degrades an unparseable
 * *definition* to a logged 404.
 *
 * **The enforcement layer must not inherit this.** They read the same values to
 * *refuse* submissions, and there "unreadable" cannot mean "no deadline, no
 * limit, no password" — that would open a closed form the moment a document
 * stopped parsing. Enforcement has to fail closed; display falls back.
 *
 * **There is no layer below the organisation any more** (ADR-0011,
 * continuation 2026-08-14). A section an organisation did not decide falls to
 * the shipped constant, which needs no read and therefore no parameter — the
 * property that lets this pure module be imported by the public fill-in path
 * has become one less thing to hand it.
 */
export function safeRedactedTenantDefaults(
  stored: unknown,
): TenantFormSettings | null {
  try {
    // The strict function itself, not a second parse next to it: an absent
    // column still has to mean "nothing decided" (no
    // backfill), and that rule must not exist twice.
    return redactedTenantDefaults(stored);
  } catch {
    return null;
  }
}

/** @see safeRedactedTenantDefaults */
export function safeRedactedFormOverride(
  stored: unknown,
): FormSettingsOverride | null {
  try {
    return redactedFormOverride(stored);
  } catch {
    return null;
  }
}

/**
 * A form's stored `settings_override`, with the access word taken out and
 * password protection switched off — what duplicating a form does to its
 * settings (the evidence).
 *
 * **Not `redact()`.** That marker exists so an *unreadable* document still
 * *parses* — a placeholder standing in for a secret this code path has no
 * business reading, kept so a later write of the same row does not clobber
 * the real word with a NUL-byte constant (its own comment names the risk).
 * Duplicating writes a **new** row, under a **new** `formOverrideContext`
 * (tenant + the new form's own id, `secret-context.ts`) that the original's
 * sealed bytes were never bound to and could never be opened under — sealing
 * `REDACTED_PASSWORD` there would store a secret-shaped ciphertext for a word
 * that does not exist. The honest state for a document nobody has decided a
 * word for is the same one `EMPTY_SETTINGS_OVERRIDE`'s access section starts
 * from: no word, no protection.
 *
 * **`passwordEnabled` is forced to `false` alongside the word**, not left as
 * the original had it. Leaving it `true` with an empty `password` is not
 * "protection with the word missing" — `checkSettingsConsistency` refuses
 * exactly that combination (`Passwortschutz ohne Passwort ist kein Schutz.`),
 * and *silently* turning "protected" into "open" while the switch still reads
 * "an" would be the one outcome worse than a document that fails to parse.
 *
 * **It decides on `values`, and never on `overridden`** (a review finding). The first version left the document alone unless
 * `overridden.access === true`, on the argument that a form which never
 * customised §*Zugriff & Sicherheit* carries no word in this document at all.
 * That argument is true of every document *this application writes* — because
 * `pruneToOverridden` drops unoverridden sections on the **write** path — and it
 * is exactly the "the database checks that already" assumption the head of this
 * file rejects: `settings_override` is JSONB and takes any JSON, from a hand
 * written `UPDATE`, an import, a restore, or a version of this code older than
 * the pruning. *Measured on 2026-08-05:*
 * `{overridden:{access:false},values:{passwordEnabled:true,password:'sealed:…'}}`
 * came back **unchanged**, and so did a document without any `overridden` key
 * — the secret travelled into the copy, under a context under which
 * nobody can open it any more, but it travelled.
 *
 * A neighbouring key is the wrong thing to ask, because it is not the thing
 * being removed: the question here is "does a word stand in this document" and
 * the only place that can be answered is `values`. Stripping a word out of a
 * section nobody overrode costs nothing — a duplicate inherits its organisation's
 * standard the way any new form does, which is what `EMPTY_SETTINGS_OVERRIDE`'s
 * access section already starts from.
 */
export function stripOverridePassword(document: unknown): unknown {
  if (!isJsonObject(document)) {
    return document;
  }
  const values = document.values;
  if (!isJsonObject(values)) {
    return document;
  }
  // The one thing that is asked: does this document carry either half of the
  // access word. A document that carries neither is handed back untouched
  // rather than gaining two keys for a section nobody decided — "nothing to
  // take out" is not the same as "take out and write down that there is none".
  // Whenever *one* of them is there, **both** are set: a `passwordEnabled`
  // without a word is the state `checkSettingsConsistency` refuses outright,
  // and a word without the switch is a secret travelling for no reason at all.
  if (!('password' in values) && !('passwordEnabled' in values)) {
    return document;
  }
  return {
    ...document,
    values: { ...values, password: '', passwordEnabled: false },
  };
}
