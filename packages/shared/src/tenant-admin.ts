import { z } from 'zod';

import {
  PASSWORD_HASH_INPUT_MAX,
  emailAddressSchema,
  groupSummarySchema,
  personNameSchema,
  permissionsSchema,
  tenantSummarySchema,
} from './auth.ts';
import { baseUrlSchema } from './base-url.ts';
import { hexColorSchema } from './branding.ts';
import { SINGLE_LINE_TEXT_MESSAGE, isSingleLineText } from './html-text.ts';
import { PASSWORD_MIN } from './form-settings.ts';
import { smtpAuthSchema, smtpBlockSchema } from './mail-config.ts';
import { replyToAddressSchema } from './reply-to.ts';

/**
 * Wire contract of the tenant administration (design handoff).
 *
 * **Everything shared is built once, here, before the code that uses it.**
 * The OIDC endpoints, the users and groups, the per-form restriction, the
 * superadmin routes, and the views are all built
 * against these schemas rather than against a second
 * description of the same payload. The last time a shared definition stood in
 * two work orders it promptly existed twice and cost a merge round.
 *
 * Two things are deliberately **not** in this file:
 *
 * - **Branding.** The colour predicate, the logo allow-list and the branding
 *   document live in `branding.ts` and belong to a separate module, which runs in
 *   parallel. A colour rule written here as well would be the third time this
 *   project pays for the same duplication. Where a colour is unavoidable — the
 *   tint of a group card — this file reuses {@link hexColorSchema}, the
 *   predicate that has been in `auth.ts`, instead of stating a new one.
 * - **The four settings sections.** `tenant.form_defaults` is `form-settings.ts`'s.
 *   The tenant administration's middle tab shows
 *   them; it does not redefine them.
 *
 * The rule that shapes the read schemas: **nothing secret travels in a
 * response.** The OIDC client secret is the second database secret of this
 * application and, unlike the access word, it never leaves the
 * server — {@link oidcConfigSchema} carries „gesetzt / nicht gesetzt" and no
 * value. Every read schema here is a `strictObject`, so the proof of that is a
 * **allow list**: a field added later has to be added to the schema too, and
 * the test that pins the payload down fails until somebody looks at it. „Enthält
 * kein Passwort" would be the weaker form — it stays green for the field nobody
 * thought of.
 */

// ---------------------------------------------------------------------------
// OIDC configuration
// ---------------------------------------------------------------------------

/**
 * Scopes are requested space-separated, so a scope may not contain a space —
 * one entry could otherwise become two, or smuggle a second parameter into the
 * authorisation request.
 *
 * The character set is RFC 6749's `scope-token` minus the ones this application
 * has no use for: letters, digits and the three punctuation marks providers
 * actually ship (`openid`, `profile`, `email`, `urn:zitadel:iam:org:project:roles`).
 */
const OIDC_SCOPE = /^[A-Za-z0-9._:-]+$/;

/** The scopes a fresh configuration starts from — standard OIDC, no provider. */
export const DEFAULT_OIDC_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
];

const oidcScopeSchema = z.string().min(1).max(64).regex(OIDC_SCOPE);

/**
 * The name of a claim inside the ID token.
 *
 * A claim name is a JSON object key, and the two this application reads are
 * looked up by that key. The character set is what providers actually mint:
 * `email`, `upn`, `preferred_username`, and the URI-shaped names Entra still
 * ships for legacy applications
 * (`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`) — hence
 * `:`, `/`, `.` and `-` beside letters, digits and `_`.
 *
 * **Flat, never a path.** There is no `a.b` traversal behind this: the value is
 * used as one key of the token's own top-level object, exactly as `claims.email`
 * was before it was configurable. A name containing a dot names a claim whose
 * key contains a dot.
 */
const OIDC_CLAIM = /^[A-Za-z0-9._:/-]+$/;

const oidcClaimSchema = z.string().trim().min(1).max(128).regex(OIDC_CLAIM);

/**
 * The claim name that may be **empty**, and only that one.
 *
 * An empty verification claim is a decision, not a missing value: „diese Adresse
 * zählt ohne Gegenprüfung". It is spelled as the empty string rather than as
 * `null` because the column is `NOT NULL` with a default — `null` would have to
 * mean both „noch nie gespeichert" and „bewusst abgewählt", and those two must
 * not be the same value in a field that switches a security check off.
 */
const oidcOptionalClaimSchema = z.union([z.literal(''), oidcClaimSchema]);

/** The claim a fresh configuration reads the address from. */
export const DEFAULT_OIDC_EMAIL_CLAIM = 'email';

/** The claim a fresh configuration checks the address against. */
export const DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM = 'email_verified';

/**
 * What the *Erscheinungsbild & Login* tab reads about the identity provider.
 *
 * **An allow list, and the client secret is not on it** . The column holds ciphertext (`tenant.oidc_client_secret_encrypted`,
 * sealed with {@link https://en.wikipedia.org/wiki/Authenticated_encryption AEAD}
 * under a context naming tenant *and* field), and there is no route that opens
 * it: a client secret is not something anybody has to read aloud, which is the
 * one property that makes the form access word different. All the
 * page needs is whether one is stored, so that is all this carries.
 *
 * `redirectUri` **is** here and is **not** in {@link oidcConfigWriteSchema}, and
 * that asymmetry is the whole of the requirement's third reproduction: the address
 * the provider redirects to is decided by the server (from `PublicUrlService`)
 * and shown so it can be pasted into the IdP. Taking it from a request would
 * turn the login into an open redirector, and there is no field in which to
 * send it.
 */
export const oidcConfigSchema = z.strictObject({
  /** Whether this organisation offers the SSO button at all. */
  enabled: z.boolean(),
  /** Discovery base URL — `<issuer>/.well-known/openid-configuration`. */
  issuer: z.url().max(512).nullable(),
  clientId: z.string().min(1).max(256).nullable(),
  scopes: z.array(oidcScopeSchema).max(32),
  /**
   * Which claim of the ID token carries the address.
   *
   * Always a concrete name — the column is `NOT NULL` with
   * {@link DEFAULT_OIDC_EMAIL_CLAIM} as its default, so an organisation that has never
   * opened this field reads back `email` and behaves exactly as before.
   */
  emailClaim: oidcClaimSchema,
  /**
   * Which claim has to say `true` for that address to count — **or the empty
   * string, meaning it counts unchecked** .
   *
   * Emptying this gives up „Abwesenheit ist keine Zustimmung": whoever runs the
   * Anmeldedienst of this organisation can then pull an invitation of **this** Organisation onto
   * an address that is not theirs. The surface that offers the field says so.
   */
  emailVerifiedClaim: oidcOptionalClaimSchema,
  /** Caption of the SSO button, or null for the shipped default. */
  buttonLabel: z.string().min(1).max(80).nullable(),
  /** „gesetzt / nicht gesetzt" — never the secret itself. */
  clientSecretSet: z.boolean(),
  /** Server-decided, read-only, shown for copying into the IdP. */
  redirectUri: z.url(),
});
export type OidcConfig = z.infer<typeof oidcConfigSchema>;

/**
 * What the tab writes back.
 *
 * `clientSecret` has **three** states and they are all real: absent means „lass
 * das gespeicherte Geheimnis stehen" (the page never held it, so it cannot send
 * it back), a string replaces it, and `null` removes it. A two-state field would
 * force the page to send something on every save — and the only thing it could
 * send is the value it does not have.
 *
 * The cross-field rule is deliberately **half** structural: switching OIDC on
 * without an issuer or a client id is refused here, because the payload knows
 * both. Whether a *secret* is stored is server state this document cannot see,
 * so that half is checked where the column is — `fail closed`. Stating
 * it here as an optimistic „the client will send one" would be a rule that
 * passes for the request that does not.
 */
export const oidcConfigWriteSchema = z
  .strictObject({
    enabled: z.boolean(),
    issuer: z.url().max(512).nullable(),
    clientId: z.string().trim().min(1).max(256).nullable(),
    scopes: z.array(oidcScopeSchema).max(32),
    /** See {@link oidcConfigSchema} — a name, never empty. */
    emailClaim: oidcClaimSchema,
    /** See {@link oidcConfigSchema} — empty means „ohne Gegenprüfung". */
    emailVerifiedClaim: oidcOptionalClaimSchema,
    /**
     * See {@link oidcConfigSchema} — and **single-line**
     * (ADR-0026): the caption does not only stand on the
     * sign-in page, it also stands in the body of the SSO invitation
     * (`oidcInvitationBody`, „wähle die Schaltfläche „…""). That makes it a
     * foreign value in a mail of the installation and carries the same condition
     * as the person's name and the organisation's.
     */
    buttonLabel: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isSingleLineText, { message: SINGLE_LINE_TEXT_MESSAGE })
      .nullable(),
    clientSecret: z.string().min(1).max(1024).nullable().optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.enabled) {
      return;
    }
    if (config.issuer === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['issuer'],
        message: 'Ohne Issuer kann SSO nicht aktiviert werden.',
      });
    }
    if (config.clientId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'Ohne Client-ID kann SSO nicht aktiviert werden.',
      });
    }
    if (!config.scopes.includes('openid')) {
      // Without it the provider is free to answer without an id token, and
      // there is then no `sub` to bind an account to.
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Der Scope „openid" ist für SSO zwingend.',
      });
    }
  });
export type OidcConfigWrite = z.infer<typeof oidcConfigWriteSchema>;

// ---------------------------------------------------------------------------
// Sending identity of one organisation
// ---------------------------------------------------------------------------

/**
 * The four transport fields of a block — **taken from `smtpBlockSchema`, not
 * restated.**
 *
 * `mail-config.ts` is the truth about what a block is (ADR-0013 no. 1), and the
 * two schemas below differ from it in exactly one place: the credentials. It is
 * the same set of four `systemSmtpWriteSchema` lists field by field elsewhere
 * — taken off the block rather than retyped, so a field added to it cannot
 * arrive here late. A
 * second spelling of host, port, `secure` and `from` here would be a second
 * opinion about the port range and about „eine nackte Adresse, nie
 * `Name <adresse>`" — and the copy that drifts is always the one further from
 * the value it describes. Only `auth` is replaced, because only `auth` carries
 * a secret and a secret never travels in the same shape in both directions.
 */
const smtpTransportShape = smtpBlockSchema.omit({ auth: true }).shape;

/**
 * One organisation's mail server, as the *Mailversand*-Reiter reads it —
 * **one or none** (ADR-0023).
 *
 * There used to be a discriminated union here with a `system` arm: „diese
 * Organisation erbt den Mailserver der Installation". That inheritance is
 * abolished, so the arm is gone and `smtp: null` means exactly one thing —
 * **none entered yet**, and with that this organisation sends nothing.
 * That is not an error state but the one every freshly created
 * organisation starts in; the surface says so plainly instead of nagging.
 *
 * The block itself stays indivisible: either every field or `null`. A
 * half block would be the SPF/DKIM forgery of ADR-0013 no. 2 with a
 * tick mark in front of it.
 *
 * **The password is not on the list, `passwordSet` is.** Exactly the
 * shape {@link oidcConfigSchema} has for the client secret: the page
 * has to know *whether* one is stored, never which. „gesetzt" means *the
 * stored value can be opened in this organisation* — bytes carried in from
 * elsewhere read as „nicht gesetzt", which is the fail-closed
 * and at the same time the repairable answer.
 */
export const mailIdentityBlockSchema = z.strictObject({
  ...smtpTransportShape,
  /** The pair, or `null` for a relay that wants no login — never half of it. */
  auth: z
    .strictObject({
      user: z.string().min(1),
      /** „gesetzt / nicht gesetzt" — never the value. */
      passwordSet: z.boolean(),
    })
    .nullable(),
});

/**
 * What the tab gets — an envelope with exactly one field.
 *
 * An envelope and not the bare `block | null`, for the same reason
 * `systemMailSettingsSchema` (`system-settings.ts`) has one: a route that answers `null` at the
 * top level is an answer a client mistakes for „nichts
 * geladen" — and adding a field to it later (a second address, say)
 * would then be a break instead of an addition.
 */
export const mailIdentityConfigSchema = z.strictObject({
  /** The mail server entered, or `null` for „noch keiner". */
  smtp: mailIdentityBlockSchema.nullable(),
});
export type MailIdentityConfig = z.infer<typeof mailIdentityConfigSchema>;

/**
 * The credentials on a write — **the same shape `systemSmtpAuthWriteSchema`
 * has, taken from the same place** (`system-settings.ts`).
 *
 * Two surfaces ask one question — „ändert dieser Speichervorgang das Passwort
 * oder behält er es?" — and they answer it identically, down to which schema
 * the two fields come from. That is deliberate: this project has paid three
 * times for the same rule existing twice (`pickDefaultColumns`,
 * `ADDRESS_QUESTION_TYPES`, the duplicated placeholder grammar), and a
 * *credentials* rule that drifts is the variant where the second copy quietly
 * stores an empty secret.
 *
 * - **absent** — „lass das gespeicherte Passwort stehen". The ordinary case:
 *   the page never held the password, so it cannot send it back, and somebody
 *   correcting a port would otherwise have to retype credentials they may not
 *   even have. Whether one *is* stored is server state this document cannot
 *   see, so „keins da" is refused where the column is, fail closed.
 * - **a string** — replaces it.
 *
 * There is deliberately no third state that empties the password while keeping
 * the user: `auth` is a **pair**, and removing a login means `auth: null`, which
 * removes both halves in one document. A password field that could be emptied
 * on its own would be the first crack in „der Block hat keine offenen Felder".
 */
export const mailIdentityAuthWriteSchema = z.strictObject({
  user: smtpAuthSchema.shape.user,
  password: smtpAuthSchema.shape.password.optional(),
});
export type MailIdentityAuthWrite = z.infer<typeof mailIdentityAuthWriteSchema>;

/**
 * What the tab writes back — the whole block, or `null`.
 *
 * `smtp: null` deletes the entry; after that this organisation sends nothing
 * any more, and the card says so. There is no patch behaviour: the
 * page holds the complete document, so it names every field again —
 * only the password may be missing, and what that means stands at
 * {@link mailIdentityAuthWriteSchema}.
 */
export const mailIdentityWriteSchema = z.strictObject({
  smtp: z
    .strictObject({
      ...smtpTransportShape,
      auth: mailIdentityAuthWriteSchema.nullable(),
    })
    .nullable(),
});
export type MailIdentityWrite = z.infer<typeof mailIdentityWriteSchema>;

// ---------------------------------------------------------------------------
// Base address of one organisation
// ---------------------------------------------------------------------------

/**
 * The organisation's own base address — **deliberately its own document, not a field
 * of {@link mailIdentityConfigSchema}** (ADR-0013 no. 3).
 *
 * The address says *where this organisation is reachable*, not *who it is in the mail
 * system*: an organisation may be reachable under its own address and still send over
 * the system's mail server, which is the normal case and not a mixture — so
 * it is set and cleared independently of `source`, through its own route
 * (`tenant-base-url.controller.ts`), the same separation the ADR draws for
 * the reader (`TenantBaseUrlRepository`) this write finally gives a
 * counterpart.
 *
 * **Only for the links a form sends to participants** — the Bearbeiten-Link
 * in a confirmation mail, chiefly.
 * The sign-in return address and the OIDC `redirect_uri` stay on the
 * **system** address on purpose: were an organisation truly reachable under its own
 * host, its sign-in return would land on a host the session cookie does not
 * apply to, and the person would look logged out with no error at all. The
 * write schema's own doc repeats this at the point somebody fills the field
 * in.
 */
export const tenantBaseUrlSchema = z.strictObject({
  /** The organisation's own address, or `null` for „die Systemvorgabe gilt". */
  baseUrl: z.string().nullable(),
});
export type TenantBaseUrl = z.infer<typeof tenantBaseUrlSchema>;

/**
 * What the *Mailversand*-Reiter's *Basis-Adresse*-Abschnitt writes back.
 *
 * `null` clears it — „die Systemvorgabe gilt" — and **if that is missing too,
 * `{{bearbeiten}}` resolves to nothing** (the requirement): a dead link in a
 * participant's inbox cannot be recalled, so an empty base address is „kein
 * Link", never a guess. {@link baseUrlSchema} is reused rather than restated
 * — the same predicate the system row and `PublicUrlService` already agree
 * on, so „was ist eine Basis-Adresse?" has exactly one answer across all
 * three writers of it.
 */
export const tenantBaseUrlWriteSchema = z.strictObject({
  baseUrl: baseUrlSchema.nullable(),
});
export type TenantBaseUrlWrite = z.infer<typeof tenantBaseUrlWriteSchema>;

// ---------------------------------------------------------------------------
// Reply-to address of one organisation
// ---------------------------------------------------------------------------

/**
 * This organisation's reply-to address — **its own document, like the
 * base address and for the same reason** (ADR-0013 no. 3).
 *
 * The SMTP block is indivisible because it carries a secret; a
 * reply-to address is not one. Were it inside the block, an organisation could not
 * change it without having the SMTP password to hand — and an organisation with no
 * mail server entered (`smtp: null`) would have no block at all for it to
 * fit into. So the same standing as {@link tenantBaseUrlSchema}: its own
 * value, its own route, its own section on the *Mailversand*-Reiter.
 */
export const tenantReplyToSchema = z.strictObject({
  /** The organisation's own reply-to address, or `null` for „die Systemvorgabe gilt". */
  replyTo: z.string().nullable(),
});
export type TenantReplyTo = z.infer<typeof tenantReplyToSchema>;

/**
 * What the *Antwortadresse*-Abschnitt writes back.
 *
 * `null` clears it — „die Systemvorgabe gilt". If that is missing too, the mail goes
 * out **without** `Reply-To`, and a mail client then replies to the
 * sender address, as RFC 5322 provides for anyway (`effectiveReplyTo`).
 * Checked with the same address check as the sender address — there is no second
 * version of it.
 */
export const tenantReplyToWriteSchema = z.strictObject({
  replyTo: replyToAddressSchema.nullable(),
});
export type TenantReplyToWrite = z.infer<typeof tenantReplyToWriteSchema>;

// ---------------------------------------------------------------------------
// Testmail
// ---------------------------------------------------------------------------

/**
 * What the „Testmail senden" button of the *Mailversand*-Reiter sends — **an
 * address and nothing else**.
 *
 * ## What is unchanged: no transport field, nowhere
 *
 * A `strictObject`, and that is this schema's actual assurance:
 * the route uses the **stored** block, never one just typed in,
 * and that is said more strongly here than with „der Handler ignoriert das schon" —
 * there is no field a client *could* write a host, a port or a password
 * into. A request that tries ends with 400 before a
 * handler or even a socket sees it. The part that keeps the route from
 * dialling an arbitrary machine has therefore not moved.
 *
 * ## What is new: a differing recipient (finding 29b)
 *
 * This schema used to carry **no** fields, and the recipient was fixed to the
 * address from the session. The reasoning for that was meant seriously and stands
 * carried forward on the docblock of `TestMailController` — where it also says
 * what it still carries today and what it does not. The short version: the free
 * *recipient* is not the property that would make this route
 * dangerous; that would be the free *host*, and that stays excluded.
 *
 * `null` means „an mich selbst" and is the default — a caller that says nothing
 * gets exactly the behaviour of before. Checked with the same
 * address check as everywhere else in this package: {@link emailAddressSchema}
 * from `auth.ts` — trimmed, lower-cased, at most 254 characters, then
 * `z.email()`. There is no second spelling of it: `auth.ts`,
 * `response-validation.ts`, `mail-template.ts` and the line below all use
 * the same constant (review finding 10).
 */
export const testMailRequestSchema = z.strictObject({
  recipientEmail: emailAddressSchema.nullable().default(null),
});
export type TestMailRequest = z.infer<typeof testMailRequestSchema>;

/**
 * What the button gets back.
 *
 * `recipientEmail` names who the tab should say the mail went to — the address
 * the request asked for, or the signed-in person's own when it asked for none.
 * Never a notification's recipient list. **The server decides it**; this
 * document carries only the answer, so that the page never has to assemble it
 * itself (and cannot) — not even when it has just
 * proposed it itself.
 *
 * `reason` is `null` on `sent`. On `failed` it is one of the fixed sentences
 * this application already writes into `mail_log.last_error` for the same
 * situation — never a fresh one and never the transport's own words: „kein
 * Mailserver eingetragen"  or „die gespeicherte
 * Mail-Konfiguration ist unlesbar"  when nothing was attempted,
 * and — for a delivery that was attempted and
 * failed — one of the four categories `mail-error-category.ts` defines rather
 * than the remote's raw error (a security review found that a route which dials
 * on demand and answers with the literal transport error is a port scanner
 * run from inside the server's network).
 */
export const testMailResultSchema = z.strictObject({
  recipientEmail: z.email(),
  status: z.enum(['sent', 'failed']),
  reason: z.string().nullable(),
});
export type TestMailResult = z.infer<typeof testMailResultSchema>;

// ---------------------------------------------------------------------------
// Users of one organisation
// ---------------------------------------------------------------------------

/**
 * The bound a password may be set within — **both halves imported, neither
 * restated**.
 *
 * Both numbers used to stand here a second time, and each one had a different
 * way of going wrong quietly:
 *
 * - The **minimum** is {@link PASSWORD_MIN} of `form-settings.ts`, the floor the
 *   form access word uses — this one guards a whole organisation,
 *   so it cannot be the laxer of the two. Written out as `12`, lowering *this*
 *   copy to `8` left the whole shared suite green: no test compared the two, and
 *   each half's own tests derive their input from its own constant.
 * - The **maximum** is {@link PASSWORD_HASH_INPUT_MAX}, the bound
 *   `loginRequestSchema` applies before a string reaches Argon2id. Two numbers
 *   drifting apart here does not fail a request — it produces a password that
 *   can be *set* and not *entered*, which is an account nobody can sign in to.
 *
 * The names survive because they read correctly at the call sites below and are
 * part of the package's export surface; they are aliases of one value each, not
 * a second opinion about it. `single-source.test.ts` pins each underlying
 * constant to the one file that may declare it.
 *
 * The minimum lives at the *setting* side and not at the login — which is why
 * `loginRequestSchema` deliberately has none: a policy belongs where a password
 * is set, a payload limit belongs on every path that hashes one.
 */
export {
  PASSWORD_MIN as USER_PASSWORD_MIN,
  PASSWORD_HASH_INPUT_MAX as USER_PASSWORD_MAX,
};

/**
 * E-mail as it is stored: trimmed, lower-cased, bounded by RFC 5321.
 *
 * {@link emailAddressSchema} and no second spelling of it: a path that
 * normalises differently no longer finds the other one's row — and the
 * sign-in path reads the same column that is written here.
 */
const userEmailSchema = emailAddressSchema;

/**
 * A person's name as an organisation writes it — **single-line**
 * (ADR-0026).
 *
 * The bounds are the column's (`user.name`, `text`, not empty); new is
 * {@link isSingleLineText}, and that is not cosmetics: this value travels
 * verbatim into the body of the invitation and the reset mail, which go out over the
 * **identity of the installation**. Without the condition a
 * holder of `can_manage_users` creates a person with a name that
 * carries line breaks, picks the mailbox along with it — and the installation
 * delivers an SPF/DKIM-signed mail whose text somebody else wrote.
 * The HTML version was covered by `escapeHtml`, the text version was not.
 *
 * **Here and not only in the body**, because a value that never reaches the
 * column does not stand in any future mail either; `collapseWhitespace` in
 * `account-invitation-mail.ts` and `password-reset-mail.ts` is the second
 * bolt for rows that came into being before this rule.
 *
 * ⚠️ `profileUpdateSchema` in `auth.ts` writes the **same** column — the
 * second path, which the docblock there expressly names as a bearable
 * duplication. It does not carry this condition yet; whoever smuggles
 * something in there, however, only sends it to their own mailbox.
 */
/** A person's name — the one spelling stands in `auth.ts`. */
const userNameSchema = personNameSchema;

/**
 * How a person signs in — the „OIDC"/„Lokal"/„Eingeladen" badge of the
 * design handoff.
 *
 * **Three values for three shapes of `user`** (ADR-0012 §3a), not two: a
 * password hash is `local`, a stamped `oidc_subject` is `oidc`, and an
 * `oidc_issuer` **without** a subject yet is `invited` — an organisation's admin sent
 * an invitation nobody has redeemed with a first SSO login. The first two
 * were the whole of the original design; the third used to fall under `oidc` as well,
 * which made an unclaimed invitation indistinguishable from an account that
 * has already signed in at least once (a review finding — see
 * `deriveAccountKind` in `apps/api/src/tenant-admin/users.service.ts`, the
 * one place that turns the two database columns into this value).
 */
export const accountKindSchema = z.enum(['local', 'oidc', 'invited']);
export type AccountKind = z.infer<typeof accountKindSchema>;

/**
 * One member of an organisation, as the *Nutzerrechte (Tenant-Ebene)* tab lists them.
 *
 * A **membership**, not a user: the list is „wer arbeitet in dieser Organisation", and
 * the same person may serve several. That distinction is not cosmetic — it is
 * what the requirement rests on, where removing somebody from Organisation A
 * must leave their access to Organisation B untouched.
 *
 * No password hash, no OIDC subject and no `isSuperadmin`: none of the three is
 * an organisation's business, and a `strictObject` is what keeps a later `...user` spread
 * from adding one.
 */
export const tenantMemberSchema = z.strictObject({
  userId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  accountKind: accountKindSchema,
  /** The group that grants this person's permissions in **this** Organisation. */
  group: groupSummarySchema,
});
export type TenantMember = z.infer<typeof tenantMemberSchema>;

/**
 * The answer to „Person hinzufügen" — the member **plus whether an invitation
 * actually went out**.
 *
 * A separate schema and not a field on {@link tenantMemberSchema}: the list
 * cannot derive this. Adding somebody who already has an account only writes a
 * membership (`attachExisting`), and that path enqueues nothing — the person
 * signs in with the password they already have. The two cases are
 * indistinguishable from the member alone, and the page said „hat eine
 * Einladung per Mail bekommen" for both until this field existed.
 *
 * It belongs to the **creation**, not to the person: a day later nobody can
 * say whether that membership arrived by invitation, and nobody needs to.
 */
export const tenantMemberCreatedSchema = tenantMemberSchema.extend({
  invited: z.boolean(),
});
export type TenantMemberCreated = z.infer<typeof tenantMemberCreatedSchema>;

/** The tab's list. An object rather than a bare array, so it can grow. */
export const tenantMemberListSchema = z.strictObject({
  members: z.array(tenantMemberSchema),
});
export type TenantMemberList = z.infer<typeof tenantMemberListSchema>;

/**
 * „Person hinzufügen" — a **discriminated union**, not one object with optional
 * fields (design handoff).
 *
 * Whether the `oidc` variant may be used at all is a tenant question (the tab
 * greys the option out when the organisation has SSO switched off) and is decided on
 * the server: the option being absent from a page is comfort, the refusal is
 * the boundary.
 *
 * ## Why the `local` arm no longer carries a password (ADR-0024)
 *
 * It once carried one, with the reasoning: „ein lokales Konto ohne Passwort
 * ist dann kein Dokument, das an der Prüfung scheitert, sondern eines, das man
 * nicht hinschreiben kann". The sentence described the right shape for the
 * wrong thing — it made **somebody else** the person who types and knows this
 * account's password. Whoever created a person knew their
 * password afterwards, had to tell it to them by a second route and had no
 * assurance that they ever changed it.
 *
 * Now the person sets it themselves: they get an invitation by mail and through it
 * a one-time link. So there is nothing left to type here for **either**
 * arm — the union now only distinguishes *how* somebody signs in later,
 * and that is the question it is there for.
 *
 * The administration's emergency path remains alongside it and is its own
 * act with its own route ({@link tenantMemberPasswordSchema}).
 */
export const tenantMemberCreateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local'),
    email: userEmailSchema,
    name: userNameSchema,
    groupId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('oidc'),
    email: userEmailSchema,
    name: userNameSchema,
    groupId: z.uuid(),
  }),
]);
export type TenantMemberCreate = z.infer<typeof tenantMemberCreateSchema>;

/**
 * Changing a member — role, name **and** address.
 *
 * ## Why more stands here today than the group
 *
 * This schema once carried only `groupId`, with the reasoning: „Name und E-Mail
 * gehören der Person, nicht der Organisation, und ein Organisationsadmin, der
 * sie umschreiben könnte, bearbeitete ein Konto, das auch anderswo arbeitet."
 * The sentence was right and the conclusion drawn too far: it describes a
 * boundary for **foreign** accounts, not a ban on one's own. An organisation
 * that creates a person could not touch a typo in that person's address
 * afterwards — and the person themselves could not either, because a
 * self-service profile did not exist.
 *
 * The boundary therefore now stands where it belongs, and it stands **on
 * the server**: the service refuses an address change as soon as the account belongs
 * to a second organisation, carries the system administration, or its address
 * is no longer a sign-in key at all (SSO). See
 * `apps/api/src/tenant-admin/users.service.ts` and ADR-0020.
 *
 * ## Why all three fields are mandatory
 *
 * `PUT` is a statement about the state a resource is to have, not
 * a list of changes. Optional fields would mean „was nicht dasteht, bleibt"
 * — and with that „Adresse löschen" would no longer be distinguishable from
 * „Adresse nicht anfassen". The service compares field by field against the stock and checks
 * only what **really** changes; whoever sends the same value again
 * gets no refusal for a change they are not making (the same rule
 * that already applies to `groupId`).
 */
export const tenantMemberUpdateSchema = z.strictObject({
  groupId: z.uuid(),
  name: userNameSchema,
  email: userEmailSchema,
});
export type TenantMemberUpdate = z.infer<typeof tenantMemberUpdateSchema>;

/**
 * **Setting** a password for a member — the administrative path.
 *
 * No `currentPassword`: whoever writes here is not the person but
 * somebody with `can_manage_users`, and they do not know the old password (and
 * are not meant to). What secures the act instead stands in the
 * service and in ADR-0020: only local accounts, only accounts of this one
 * organisation, never the system administration — and **all** of the person's sessions
 * end with it, otherwise setting it after a break-in would have no effect.
 */
export const tenantMemberPasswordSchema = z.strictObject({
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_HASH_INPUT_MAX),
});
export type TenantMemberPassword = z.infer<typeof tenantMemberPasswordSchema>;

// ---------------------------------------------------------------------------
// Groups of one organisation
// ---------------------------------------------------------------------------

/** Rank of the `admin` system group — the top of the scale (design handoff). */
export const ADMIN_GROUP_RANK = 100;

/** The three groups a new Organisation starts with (design handoff). */
export const DEFAULT_GROUP_RANKS = {
  admin: ADMIN_GROUP_RANK,
  editor: 60,
  viewer: 20,
} as const;

/**
 * One group card of the editor — name, tint, rank, five permissions.
 *
 * `color` reuses {@link hexColorSchema} rather than stating a colour rule of its
 * own: `groupSummarySchema` has validated group tints with that predicate from
 * early on, and branding colours are a separate module's file. One predicate, two callers.
 *
 * **`rank` stops below {@link ADMIN_GROUP_RANK}**, and that is a decision worth
 * naming: roles are compared by rank (the per-form cap is „auf
 * diese Gruppe herab"), so a second group at the system group's rank would make
 * „wer ist höher" ambiguous — and „Administratoren sind nie einschränkbar"
 * ambiguous with it. The system group is not writable through this schema
 * anyway, so nothing legitimate is lost.
 */
export const groupWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  color: hexColorSchema,
  rank: z
    .number()
    .int()
    .min(0)
    .max(ADMIN_GROUP_RANK - 1),
  permissions: permissionsSchema,
});
export type GroupWrite = z.infer<typeof groupWriteSchema>;

/**
 * A group as the editor reads it back: what was written, plus the two things
 * only the server knows — the id and whether it is the system group.
 *
 * `memberCount` is here because the requirement asks the application to
 * say „diese Gruppe ist in Benutzung" **before** the delete: the `NoAction`
 * foreign key underneath is the floor, and a 500 carrying a constraint name is
 * the variant that helps nobody.
 */
export const groupDetailSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  color: hexColorSchema,
  rank: z.number().int(),
  /** True for `admin`: always all five permissions, not editable, not deletable. */
  isSystem: z.boolean(),
  permissions: permissionsSchema,
  memberCount: z.number().int().min(0),
});
export type GroupDetail = z.infer<typeof groupDetailSchema>;

export const groupListSchema = z.strictObject({
  groups: z.array(groupDetailSchema),
});
export type GroupList = z.infer<typeof groupListSchema>;

// ---------------------------------------------------------------------------
// Per-form restriction
// ---------------------------------------------------------------------------

/**
 * What one person may do on one form — the read side of the design handoff.
 *
 * `restrictable` is the server's answer to „Administratoren sind gesperrt auf
 * *Sieht immer alles*". It travels because the page has to render the lock, and
 * it is computed on the server rather than derived in the browser from a rank
 * comparison: the same fact decided in two places is the shape that drifts, and
 * here the second place would be the one drawing a control the API refuses.
 */
export const formMemberSchema = z.strictObject({
  userId: z.uuid(),
  name: z.string().min(1),
  email: z.email(),
  /** The person's role in the organisation — the ceiling a restriction lowers from. */
  group: groupSummarySchema,
  /** False for administrators. */
  restrictable: z.boolean(),
  /** „Zugriff gesperrt" for this one form. */
  accessRevoked: z.boolean(),
  /** The group this person is capped to here, or null for „keine Deckelung". */
  cappedGroupId: z.uuid().nullable(),
});
export type FormMember = z.infer<typeof formMemberSchema>;

export const formMemberListSchema = z.strictObject({
  members: z.array(formMemberSchema),
  /** The organisation's groups, so the cap selector needs no second request. */
  groups: z.array(groupSummarySchema),
});
export type FormMemberList = z.infer<typeof formMemberListSchema>;

/**
 * The write side — **and it has no field that grants anything** .
 *
 * That is the structural half of „eine Restriktion kann nie hochstufen": there
 * is no `permissions`, no `grantedGroupId`, no flag that adds. `accessRevoked`
 * takes a form away, `cappedGroupId` names a group to be lowered *to*; whether
 * the named group is in fact lower than the person's own is the behavioural
 * half and is checked on the server, against the membership.
 *
 * A missing row means „keine Einschränkung", so writing
 * `{ accessRevoked: false, cappedGroupId: null }` is how a restriction is
 * lifted — the same document, not a second route.
 */
export const formMemberWriteSchema = z.strictObject({
  accessRevoked: z.boolean(),
  cappedGroupId: z.uuid().nullable(),
});
export type FormMemberWrite = z.infer<typeof formMemberWriteSchema>;

// ---------------------------------------------------------------------------
// Superadmin: creating an organisation and the overview
// ---------------------------------------------------------------------------

/**
 * „+ Neue Organisation" (design handoff).
 *
 * Three things are absent on purpose and each absence is deliberate:
 *
 * - **No form standards.** A new organisation's `form_defaults` stays `{}` so the system
 *   layer keeps reaching it. Copying them would look identical on
 *   the first day and never inherit again — and a field here would be the
 *   invitation to do exactly that.
 * - **No branding.** The installation's defaults apply until somebody opens the
 *   *Erscheinungsbild*-tab; the colours and the logo are a separate module's
 *   document, and a second spelling of them here is the duplication this file
 *   opens by refusing.
 * - **No OIDC.** An organisation that has never been configured has SSO off, which is
 *   also why the first admin is necessarily a **local** account: there is no
 *   provider yet to claim one.
 *
 * A first administrator is not optional. „Eine Organisation ist sofort
 * arbeitsfähig" is the whole requirement — without one only a
 * superadministrator reaches the new organisation.
 *
 * **Who that is may stay open, though**, and that is the one extension
 * (review finding 7): `admin: null` means „das angemeldete Superadmin-Konto".
 * The route via one's own, already existing address was previously the only one
 * the form offered and the server did not want — the same person would have had
 * to type in the name and password of an account that has long existed, and
 * inventing them would either have no effect (the existing account stays as it is)
 * or overwrite somebody else's credentials.
 *
 * **`null` and not `optional`**, for the same reason
 * `setupRequestSchema.tenant` is `nullable`: „ich selbst" is a
 * decision that stands in the document, not a forgotten key.
 *
 * **And no account id.** There is no `adminUserId` here, because a field
 * that names an arbitrary account is a field with which a superadministrator
 * makes somebody else the administrator of an organisation without
 * them ever learning of it. Who „ich selbst" is, the server knows from the session —
 * `AdminService.create` gets the id from the guard and never from the body.
 */
export const tenantFirstAdminSchema = z.strictObject({
  email: userEmailSchema,
  name: userNameSchema,
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_HASH_INPUT_MAX),
});

/**
 * The same block **without a password** — what „+ Neue Organisation" takes in
 * since ADR-0024.
 *
 * ## Why first-time setup keeps the password and this form does not
 *
 * Because the invitation is a mail. It presupposes an instance mail server and
 * a base address — and the **first** person of an installation creates
 * both only afterwards. A superadministrator waiting for an invitation
 * that nobody can send without them would be an installation that locks
 * itself out. `setupRequestSchema` therefore still uses
 * {@link tenantFirstAdminSchema}, with a password, and is the **only**
 * remaining place where somebody types a foreign password — for an account
 * that in that moment is their own.
 *
 * Derived and not copied out, for the same reason `setup.ts` names for
 * its derivation: two spellings of the same address and name rule
 * would be exactly the duplication where one half is later the weaker one.
 */
export const tenantInvitedAdminSchema = tenantFirstAdminSchema.omit({
  password: true,
});

export const tenantCreateSchema = z.strictObject({
  /**
   * Kurzname — unique across the installation and used in URLs and lists.
   * Letters, digits and hyphen, so it never needs escaping anywhere it appears.
   */
  shortName: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/, 'Nur Buchstaben, Ziffern und Bindestrich.'),
  /**
   * The organisation's name — **the second write path onto `tenant.name`**
   * and therefore single-line like the first (ADR-0026).
   *
   * `tenantBrandingWriteSchema.name` is the other one; the condition on both,
   * because a rule that stands on only one of two paths is no rule.
   * This path even weighs the heavier: the name goes straight into the
   * invitation of the first administrator (`AdminService.plannedInvitation`),
   * that is, into a mail the same call triggers.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(isSingleLineText, { message: SINGLE_LINE_TEXT_MESSAGE }),
  /**
   * The first administrator account — or `null` for „ich selbst".
   *
   * Without a password (ADR-0024): the person gets an invitation and sets it
   * themselves. With `null` **no** invitation goes out — the signed-in
   * superadmin account exists and knows its password.
   */
  admin: tenantInvitedAdminSchema.nullable(),
});
export type TenantCreate = z.infer<typeof tenantCreateSchema>;

/**
 * One row of the superadmin table (design handoff).
 *
 * The counters are the **only** cross-tenant query this application makes
 * outside the mail worker and the purge jobs — which
 * is why nothing but numbers and the tenant's own identity is on this schema:
 * no form title, no user name, no stored value of another organisation.
 */
export const tenantOverviewRowSchema = z.strictObject({
  tenant: tenantSummarySchema,
  forms: z.number().int().min(0),
  responses: z.number().int().min(0),
  users: z.number().int().min(0),
  /** „OIDC aktiv" against „nur lokal" — the Anmeldungs-Status column. */
  oidcEnabled: z.boolean(),
  /**
   * This organisation's AI quota per calendar month — **the number the superadmin sets**, not the consumption.
   *
   * It stands here and not on `AiQuota`, because the two answer different questions
   * and have different guards: `GET /api/ai/quota` tells an
   * **organisation** how much it has consumed and sits behind `can_build`; this
   * row tells the **superadmin** what they have set, and sits behind
   * `SuperadminGuard`. `0` means „für diese Organisation abgeschaltet".
   */
  aiMonthlyCallLimit: z.number().int().nonnegative(),
});
export type TenantOverviewRow = z.infer<typeof tenantOverviewRowSchema>;

/** The KPI tiles plus the table below them (design handoff). */
export const tenantOverviewSchema = z.strictObject({
  tenants: z.array(tenantOverviewRowSchema),
  totals: z.strictObject({
    tenants: z.number().int().min(0),
    forms: z.number().int().min(0),
    responses: z.number().int().min(0),
    users: z.number().int().min(0),
  }),
});
export type TenantOverview = z.infer<typeof tenantOverviewSchema>;

// ---------------------------------------------------------------------------
// Superadmin: deleting an organisation and bringing it back
// ---------------------------------------------------------------------------

/**
 * One organisation in the „Gelöschte Organisationen" section of the superadmin overview.
 *
 * **A section of that page and not a second trash**, and the wire contract
 * is where that decision becomes visible: the row carries the organisation's identity
 * and the moment it was deleted, and nothing of what is *inside* it. A deleted
 * Organisation stays unbetretbar — a payload listing its forms or its answers would be
 * the systemwide trash rejects, reaching fachliche Daten
 * without restoring the organisation first, which is precisely what the requirement denies a
 * superadmin.
 *
 * The counters of {@link tenantOverviewRowSchema} are absent for the same
 * reason and for a second one: they are four queries per row over tables that
 * are on their way out, answering a question („wie viele Formulare hat dieser
 * Organisation") that nobody can act on until the organisation is back.
 *
 * `deletedAt` travels because the 30 days of {@link TRASH_RETENTION_DAYS} are
 * counted from it, and the countdown is the client's subtraction — the same
 * split `trashViewSchema` makes.
 */
export const deletedTenantSchema = z.strictObject({
  tenant: tenantSummarySchema,
  deletedAt: z.iso.datetime(),
});
export type DeletedTenant = z.infer<typeof deletedTenantSchema>;

/** „Gelöschte Organisationen", newest deletion first. */
export const deletedTenantListSchema = z.strictObject({
  tenants: z.array(deletedTenantSchema),
});
export type DeletedTenantList = z.infer<typeof deletedTenantListSchema>;

/**
 * **Typing out the name of the organisation** — the confirmation Konzept asks for.
 *
 * The typed value is checked **on the server** against `tenant.name`, not only
 * in the dialog: a confirmation that lives in the client is a confirmation a
 * second client does not have, and this is the one verb of this application
 * that takes a whole organisation out of service in one request. The id in the path is
 * what identifies the row; this field is what makes the act deliberate.
 *
 * `name` and not `shortName`, because the wording of no. 59 says „den Namen"
 * and because the Kurzname is the shorter thing to type — a confirmation that
 * costs four keystrokes confirms nothing. Trimmed and compared exactly
 * otherwise: a case-insensitive comparison would accept „muster-nord" for „Dachorganisation
 * Nord", and the point is that somebody read the name off the row.
 */
export const tenantDeleteSchema = z.strictObject({
  confirmName: z.string().trim().min(1).max(120),
});
export type TenantDelete = z.infer<typeof tenantDeleteSchema>;

/**
 * What the server answers when the typed name does not match.
 *
 * It does **not** repeat the expected name: the caller has the row in front of
 * them, and echoing it would turn a mistyped confirmation into a way of reading
 * a name back out of a request that was refused.
 */
export const TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE =
  'Der eingegebene Name stimmt nicht mit dem Namen dieser Organisation überein.';

// ---------------------------------------------------------------------------
// Parsers. Foreign data is parsed, never cast.
// ---------------------------------------------------------------------------

export function parseDeletedTenantList(source: unknown): DeletedTenantList {
  return deletedTenantListSchema.parse(source);
}

export function parseOidcConfig(source: unknown): OidcConfig {
  return oidcConfigSchema.parse(source);
}

export function parseMailIdentityConfig(source: unknown): MailIdentityConfig {
  return mailIdentityConfigSchema.parse(source);
}

export function parseTenantBaseUrl(source: unknown): TenantBaseUrl {
  return tenantBaseUrlSchema.parse(source);
}

export function parseTenantReplyTo(source: unknown): TenantReplyTo {
  return tenantReplyToSchema.parse(source);
}

export function parseTestMailResult(source: unknown): TestMailResult {
  return testMailResultSchema.parse(source);
}

export function parseTenantMemberList(source: unknown): TenantMemberList {
  return tenantMemberListSchema.parse(source);
}

export function parseGroupList(source: unknown): GroupList {
  return groupListSchema.parse(source);
}

export function parseFormMemberList(source: unknown): FormMemberList {
  return formMemberListSchema.parse(source);
}

export function parseTenantOverview(source: unknown): TenantOverview {
  return tenantOverviewSchema.parse(source);
}
