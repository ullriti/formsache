/**
 * Where a sealed secret **belongs** — the string `SecretBoxService` binds each
 * value to.
 *
 * The rule lives here as a function rather than as a template literal at each
 * call site, because a context built two different ways is worse than none:
 * the second caller's values simply stop opening, and the failure looks like a
 * corrupted database rather than like the mistake it is.
 *
 * **What it buys.** Without a context, a sealed value is portable: whoever can
 * write the JSONB column can copy an access word from one form into another —
 * **including across tenants** — and it decrypts perfectly. Tenant isolation is
 * a security boundary in this project, not a display question (`CONTRIBUTING.md`),
 * so a value that travels across it unnoticed is a hole in that boundary. The
 * context closes it: a value only opens where it was sealed.
 */

/**
 * The secrets this application stores encrypted.
 *
 * **The field is part of the context on purpose — and the case it was put there
 * for has arrived** . When this type had exactly one value the
 * field looked redundant, and the comment here said why it was not: the
 * per-tenant OIDC client secret was already foreseen, and the two would live
 * under the same tenant.
 * Without the field in the context, anyone able to write the column could move
 * the sealed OIDC client secret into `access.password` of one of their own
 * forms and simply read it out — `can_manage_form_settings` is allowed to see
 * an access word in clear. That is a privilege escalation from "may configure
 * forms" to "knows the identity provider's client secret", and it costs one
 * line to make impossible. Since ADR-0021 the escalation would climb one step
 * further than when this was written: the two rights are no longer the same
 * one, so it would carry the *narrower* role into a secret of the wider.
 *
 * That line is now load-bearing rather than anticipatory: `oidc.client_secret`
 * is sealed under {@link tenantOidcContext} and `access.password` under
 * {@link tenantDefaultsContext}, both naming the same tenant, so the only thing
 * keeping the two apart is the field segment. The attack described above is
 * exactly what the test reproduces — it is built as a test, not merely refused here.
 *
 * The other half of the promise stays where it was: an OIDC secret, unlike an
 * access word, is never handed back out. The read schema of the tenant
 * administration carries "gesetzt / nicht gesetzt" and no value
 * (`oidcConfigSchema` in `@formsache/shared`), because nobody has to read a client
 * secret aloud.
 *
 * **The third value, and the sentence it takes back** (* ADR-0013 no. 6). The Umsetzungsplan said in as many words
 * „kein neues `SecretField`, SMTP ist ein *Umgebungs*-Geheimnis". That held
 * while it was one. Now an organisation types its own
 * mail credentials into a surface and the installation's own live in a row, so
 * they belong in the same category as the access word — the sentence is
 * withdrawn here rather than worked around.
 *
 * `smtp.password` is what keeps that secret apart from the other two **inside
 * the same tenant**: without the field segment, whoever can write the JSONB
 * column could move the sealed OIDC client secret into `tenant.smtp.auth.password`
 * — or an SMTP password into `access.password`, which
 * `can_manage_form_settings` is allowed to read in clear. The reproduction of the requirement builds exactly that
 * (`src/mail/mail-secrets.service.spec.ts`); this line is the reason it fails.
 *
 * Adding a value here is the deliberate act of introducing a further secret,
 * and it belongs in the same change as the column that holds it.
 */
export type SecretField =
  'access.password' | 'ai.api_key' | 'oidc.client_secret' | 'smtp.password';

/**
 * `:` — it appears in neither a UUID (hex digits and `-`) nor in any
 * {@link SecretField}, and {@link assertContextPart} rejects it in every part
 * anyway. So the separator can never be part of a value it separates.
 */
const SEPARATOR = ':';

/**
 * The kinds of holder. They are **fixed literals in the first position and they
 * differ pairwise**, which is the whole collision argument: no combination of
 * ids and fields can make one kind's context equal another's, because no two of
 * them ever agree on segment one.
 *
 * The differing arity used to be a second, independent reason — four segments
 * against three — and it is worth noting that it no longer separates *all*
 * pairs: {@link tenantOidcContext} has the same three segments
 * {@link tenantDefaultsContext} has, because it hangs off the same `tenant`
 * row. That is exactly why the argument was written down as resting on segment
 * one alone: the property that had to keep holding is the one that did.
 *
 * {@link SYSTEM} is the first holder with **no id at all** (two segments), and
 * that is not an oversight — see {@link systemSecretContext}.
 */
const FORM_OVERRIDE = 'form-override';
const TENANT_DEFAULTS = 'tenant-defaults';
const TENANT_OIDC = 'tenant-oidc';
const TENANT_SMTP = 'tenant-smtp';
const SYSTEM = 'system';

/**
 * The allowlist that makes the argument above true rather than merely likely.
 *
 * UUIDs and field names are covered; everything else — the separator, NUL,
 * whitespace, anything an attacker might smuggle in through an id that did not
 * come from the database — is refused. Empty is refused too: an empty segment
 * would let `a::b` and `a:b:` collapse into each other.
 */
const CONTEXT_PART = /^[A-Za-z0-9._-]+$/;

function assertContextPart(value: string, name: string): string {
  if (!CONTEXT_PART.test(value)) {
    // The value is an id or a field name, never a secret, so naming it in the
    // message is safe and makes the mistake findable.
    throw new Error(
      `secret context part "${name}" must match ${String(CONTEXT_PART)}, got: ${value}`,
    );
  }
  return value;
}

/**
 * Context for the access word inside a **form's** `settings_override`.
 *
 * The tenant id travels along even though the form id alone would identify the
 * row: it is the boundary that matters, and binding it means a value cannot be
 * moved between tenants even if form ids were ever recycled or guessed.
 */
export function formOverrideContext(
  tenantId: string,
  formId: string,
  field: SecretField,
): string {
  return [
    FORM_OVERRIDE,
    assertContextPart(tenantId, 'tenantId'),
    assertContextPart(formId, 'formId'),
    assertContextPart(field, 'field'),
  ].join(SEPARATOR);
}

/**
 * Context for the access word inside a **tenant's** `form_defaults`.
 *
 * It belongs to no form, which is exactly why the two builders exist: a
 * three-segment context cannot be produced by the form builder, so a tenant
 * standard can never be opened as a form override or the other way round.
 */
export function tenantDefaultsContext(
  tenantId: string,
  field: SecretField,
): string {
  return [
    TENANT_DEFAULTS,
    assertContextPart(tenantId, 'tenantId'),
    assertContextPart(field, 'field'),
  ].join(SEPARATOR);
}

/**
 * Context for a secret that hangs off the **`tenant` row itself** — today the
 * OIDC client secret of the requirement.
 *
 * A third builder rather than a second field inside `tenantDefaultsContext`,
 * although both name a tenant and a field: the two secrets live in different
 * *columns* of the same row. `form_defaults` is a JSONB document
 * `can_manage_settings` may edit and read back in clear; `oidc_client_secret_encrypted`
 * is a `Bytes` column nothing reads out. Sharing a context literal would mean a
 * value sealed for one column opens in the other, and the shorter path is the
 * dangerous one — a sealed OIDC secret written into the settings document would
 * come back out through the page that is *allowed* to show an access word.
 *
 * The field segment already rules that out on its own (`oidc.client_secret`
 * against `access.password`, see {@link SecretField}), so this is the second of
 * two independent reasons rather than the only one. Two are wanted here: the
 * field segment protects against a value being *moved*, the holder literal
 * against a future column of the same row being added without anybody thinking
 * about it.
 */
export function tenantOidcContext(
  tenantId: string,
  field: SecretField,
): string {
  return [
    TENANT_OIDC,
    assertContextPart(tenantId, 'tenantId'),
    assertContextPart(field, 'field'),
  ].join(SEPARATOR);
}

/**
 * Context for the SMTP password inside a **organisation's** `tenant.smtp` document
 * (ADR-0013 no. 6).
 *
 * A holder of its own rather than a second field under {@link tenantOidcContext},
 * for precisely the reason that function's own note gives: the literal exists so
 * that *a further column of the same row* cannot be added without somebody
 * thinking about it, and `tenant.smtp` is that further column. Reusing
 * `tenant-oidc` for a value that has nothing to do with OIDC would spend that
 * argument the first time it was needed — and leave a name at every call site
 * that says the opposite of what is happening.
 *
 * The field segment (`smtp.password` against `oidc.client_secret`) already keeps
 * the two apart on its own; this is the second of two independent reasons, which
 * is the posture every builder here takes.
 */
export function tenantSmtpContext(
  tenantId: string,
  field: SecretField,
): string {
  return [
    TENANT_SMTP,
    assertContextPart(tenantId, 'tenantId'),
    assertContextPart(field, 'field'),
  ].join(SEPARATOR);
}

/**
 * Context for a secret of the **installation itself** — today the SMTP password
 * of the system mail server.
 *
 * **Two segments, because there is no id to name.** `system_setting` is the one
 * table besides the mail queue that belongs to no organisation and holds exactly one row
 * (`CHECK (id = 'x')`), so a holder id would be a constant pretending to be a
 * discriminator. What separates this context from every other is segment one,
 * which is the argument all of them rest on — and the shorter arity makes a
 * collision with a three-segment context impossible a second way.
 *
 * The direction that matters: a value sealed here **cannot** be opened in any
 * organisation's row, so a system SMTP password copied into `tenant.smtp` by a raw write
 * is not readable there — and an organisation's password copied into the system row is
 * not readable either. Neither is a hypothetical „the installation's secret is
 * everybody's secret" reading available to a future caller, because there is no
 * builder that produces this string from a tenant id.
 */
export function systemSecretContext(field: SecretField): string {
  return [SYSTEM, assertContextPart(field, 'field')].join(SEPARATOR);
}
