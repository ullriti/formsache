import { z } from 'zod';

import { baseUrlSchema } from './base-url.ts';
import { smtpAuthSchema, smtpBlockSchema } from './mail-config.ts';
import { replyToAddressSchema } from './reply-to.ts';

/**
 * What the installation as a whole decides — **mail server, base address and
 * KI, and no longer any form standards**
 * ([ADR-0011](../../../docs/architecture/0011-systemweite-einstellungen.md),
 * continuation 2026-08-14).
 *
 * The system row used to carry a third layer of form settings below every
 * organisation. It is gone (review finding 9): the sections a form inherits now
 * come from its organisation and, where the organisation decided nothing, from
 * the shipped constant `SYSTEM_FORM_SETTINGS` in `form-settings.ts`. What was
 * left after that decision is what is left in this file — the values that
 * genuinely belong to the *installation* and to no organisation: how mail
 * leaves the machine, what address the machine has, and which KI it may call.
 *
 * The columns `system_setting.form_defaults` and `form_defaults_revision` were
 * dropped by the migration `20260814120000_two_layer_form_settings`, after it
 * had copied whatever they decided into the organisations that were inheriting
 * it. Nothing here reads them any more, and nothing may reintroduce them
 * without a new decision — the reasoning for removing the layer is in the ADR.
 */

// ---------------------------------------------------------------------------
// The installation's mail server and base address (ADR-0013 §5/§6) — the superadmin write path `mail-config.ts` names as a
// gap until this one.
// ---------------------------------------------------------------------------

/**
 * **Two values, not one, and they are independent** (ADR-0013 no. 3): the
 * mail block says who the installation is in the mail system, the base
 * address says where it is reachable. Neither is filled from the other, and
 * both may be absent — „kein Mailserver eingerichtet" is a normal, supported
 * state (ADR-0013 no. 5), not a fault to work around.
 *
 * Built from `mail-config.ts` and `base-url.ts` (both **used, not
 * restated** — the shapes, bounds and the union's indivisibility live there),
 * plus the envelope this package adds: what the superadmin's page reads and
 * writes, and never a password.
 */

/**
 * The installation's mail block as the superadmin's page reads it — the
 * `system_setting.smtp` naked block of ADR-0013, and **never the password**.
 *
 * **Why there is no separate `passwordSet` flag, unlike
 * `oidcConfigSchema.clientSecretSet`.** An organisation's OIDC secret can be „a client
 * id without a secret" — two independent optional facts. This block's `auth`
 * cannot: it is a pair or nothing at all (`smtpAuthSchema`), so there is no
 * state „hat einen Benutzer, aber kein Passwort" for a flag to report. Once
 * `authUser` is not `null`, a password is stored beside it — structurally,
 * because the block cannot have been saved any other way — and that is all a
 * display needs to know.
 */
export const systemSmtpDisplaySchema = z.strictObject({
  host: smtpBlockSchema.shape.host,
  port: smtpBlockSchema.shape.port,
  secure: smtpBlockSchema.shape.secure,
  /** `null` for a relay without a login. */
  authUser: smtpAuthSchema.shape.user.nullable(),
  from: smtpBlockSchema.shape.from,
});
export type SystemSmtpDisplay = z.infer<typeof systemSmtpDisplaySchema>;

/**
 * What the superadmin's *Mailserver & Basis-Adresse* page receives.
 *
 * `strictObject`, so a server that started sending the password here would
 * fail at load time on the client rather than put a secret on screen — the
 * same positive-list promise `oidcConfigSchema` makes one layer up.
 */
export const systemMailSettingsSchema = z.strictObject({
  /** `null` — „noch nicht eingerichtet" (ADR-0013 no. 5), not a fault. */
  smtp: systemSmtpDisplaySchema.nullable(),
  /** Already normalised by the server (`base-url.ts`), or `null`. */
  publicBaseUrl: z.string().nullable(),
  /**
   * The installation-wide default for `Reply-To`, or `null`.
   *
   * **Beside `smtp`, not inside it** — precisely the question the decision put
   * before the building. The block is indivisible because it carries a secret;
   * a reply address is none, and were it to lie in the block it would not be
   * changeable without the SMTP password and could not be set at all on an
   * installation without a mail server (`smtp: null`). The same position
   * {@link publicBaseUrl} already has one line further up.
   *
   * A loose `string`, like `publicBaseUrl`: the check happens on the way in
   * (`replyToAddressSchema` in the write schema) and once more on the way to
   * the header (`effectiveReplyTo`), not in this display document.
   */
  replyTo: z.string().nullable(),
  /**
   * **Where an operational alert goes** , or
   * `null` for „nobody".
   *
   * ⚠️ **This field is the find of a review.** The column had existed for a
   * long time, and the guard too — but **no write path**: no controller, no
   * seed, no variable set it. On every real installation the alert reported
   * „no alert address is configured" and sent nothing, and its test set the
   * column itself, which is why nothing caught it.
   *
   * It stands on **this** page because it is an address the same superadmin
   * maintains under the same counter — not because it belonged to the mail
   * server. The column stays out of the SMTP block, for the same reason as
   * {@link replyTo}: it is not a secret and has to be settable on an
   * installation without a mail server too.
   */
  opsAlertEmail: z.string().nullable(),
});
export type SystemMailSettings = z.infer<typeof systemMailSettingsSchema>;

/**
 * SMTP authentication, **written** — the same pair as `smtpAuthSchema`,
 * except the password may be **absent**.
 *
 * Absent means „lass das gespeicherte Passwort stehen" — the three-state
 * shape `oidcConfigWriteSchema.clientSecret` has, minus the „entfernen"
 * state: a relay that wants no login sends `auth: null` on the block itself
 * rather than an empty pair. Whether a password *is* stored to fall back on
 * is server state this schema cannot see; a request that has none to keep is
 * refused where the row is read, not here (`SystemMailAdminService`, the
 * same split `OidcConfigService.nextSecret` draws for the client secret).
 */
export const systemSmtpAuthWriteSchema = z.strictObject({
  user: smtpAuthSchema.shape.user,
  password: smtpAuthSchema.shape.password.optional(),
});
export type SystemSmtpAuthWrite = z.infer<typeof systemSmtpAuthWriteSchema>;

/**
 * The system SMTP block, written — **all five fields required except the
 * password** .
 *
 * Unlike an organisation's identity this row has nobody to inherit from, so — exactly
 * as `smtpBlockSchema` already says — there is no open field. A request
 * naming only `host` fails right here, at the missing `port`/`secure`/`from`,
 * and the message names the field: `parseRequest` joins a Zod issue's path
 * with dots, so a missing `port` reads `smtp.port: …`. A request naming an
 * `auth` without a stored password to fall back on parses **successfully**
 * here — that half is not a schema question, it is
 * answered by the service that knows what is stored.
 */
export const systemSmtpWriteSchema = z.strictObject({
  host: smtpBlockSchema.shape.host,
  port: smtpBlockSchema.shape.port,
  secure: smtpBlockSchema.shape.secure,
  auth: systemSmtpAuthWriteSchema.nullable(),
  from: smtpBlockSchema.shape.from,
});
export type SystemSmtpWrite = z.infer<typeof systemSmtpWriteSchema>;

/**
 * A write of the installation's mail server and base address.
 *
 * **A full replace of each field, not a patch** — the same shape
 * `oidcConfigWriteSchema` has apart from its own three-state secret: the page
 * always holds the complete current document, so „nur `host` gesetzt" already
 * fails at this schema for `smtp`, and
 * `publicBaseUrl` stays exactly as stored only by the caller naming its
 * current value again — there is no patch semantics to leave it out of.
 *
 * `smtp: null` removes the block; `null` and „already `null`" are the same
 * request and produce the same state, which is why there is no third value
 * for „delete".
 */
export const updateSystemMailSettingsRequestSchema = z.strictObject({
  smtp: systemSmtpWriteSchema.nullable(),
  publicBaseUrl: baseUrlSchema.nullable(),
  /**
   * The system-wide default for `Reply-To` — `null` clears it.
   *
   * A full replace like the two fields above, not a patch: the page holds the
   * whole document, so it names the current value again. Checked with **the
   * same** address check the block's sender address has
   * (`replyToAddressSchema` is literally `smtpBlockSchema.shape.from`) — a
   * second version would be the duplication this project has already paid for
   * several times.
   */
  replyTo: replyToAddressSchema.nullable(),
  /**
   * The operator's address for operational alerts — `null` clears it.
   *
   * Checked with **the same** address check as the two fields above; a third
   * version would be the duplication this project has already paid for. One
   * address, not a distribution-list field: whoever wants several recipients
   * enters a distribution address (see the schema comment at the column).
   */
  opsAlertEmail: replyToAddressSchema.nullable(),
  /**
   * The optimistic lock this superadmin started from —
   * `mail_revision`, the two columns' own counter, exactly the shape
   * `form_defaults_revision` has for the other half of the row. **Not**
   * `updated_at`: that field is `@updatedAt` on the whole row and moves on
   * *any* write to it (including a `form_defaults` save that never touched
   * mail), and PostgreSQL truncates it to milliseconds — two writes landing in
   * the same millisecond would compare equal and the second would overwrite
   * the first silently, which is exactly the failure no. 21 exists to rule
   * out. See `SystemSettingsRepository.writeMail` for the write side.
   *
   * Never `null`: a fresh installation with no row yet reports the number the
   * column will start at, the same convention `revision` has one layer up
   * (`system-settings-wire.ts`'s `revisionSchema`) — an optional lock is one
   * the next client forgets.
   */
  lock: z.number().int().positive(),
});
export type UpdateSystemMailSettingsRequest = z.infer<
  typeof updateSystemMailSettingsRequestSchema
>;
