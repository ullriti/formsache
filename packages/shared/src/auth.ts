import { z } from 'zod';

import {
  hexColorSchema,
  tenantBrandingSchema,
  tenantLogoSchema,
} from './branding.ts';
import { PASSWORD_MIN } from './form-settings.ts';
import { SINGLE_LINE_TEXT_MESSAGE, isSingleLineText } from './html-text.ts';

/**
 * Wire contract of the authentication endpoints — the shared truth for client
 * and server. This file cuts the contract; the implementation fills it
 * with the actual endpoints; the login view of the web app is built against
 * exactly these schemas.
 *
 * The one rule that shapes everything below: **nothing secret travels in a
 * response.** The session token lives in an httpOnly cookie the browser never
 * exposes to JavaScript (ADR-0005), and a password hash has no business
 * leaving the database at all. None of the schemas here has a
 * field for either — and because Zod object schemas drop unknown keys, parsing
 * a payload through them actively removes such a field should a future
 * handler ever add one. `auth.test.ts` pins that behaviour down.
 */

/**
 * The longest string this application ever pushes through Argon2id.
 *
 * **A named constant rather than a literal in each schema, because two schemas
 * disagreeing about it is a lockout, not a mismatch:** a password that can be
 * *set* but not *entered* leaves an account nobody can sign in to, and the two
 * places are `tenantMemberCreateSchema` (setting) and `loginRequestSchema`
 * (entering). The bound exists so an oversized string cannot be pushed through
 * a deliberately slow hash — it is a payload limit, not a password policy; the
 * policy (the minimum) belongs where a password is set and lives in
 * `form-settings.ts` as `PASSWORD_MIN`.
 *
 * Not to be confused with `PASSWORD_MAX` of `form-settings.ts` (200): that one
 * bounds a form's *Zugangswort*, which is typed by participants and shown to
 * editors, and is a different thing that happens to also be a password field.
 */
export const PASSWORD_HASH_INPUT_MAX = 1024;

/**
 * An e-mail address as this application accepts **and stores** it.
 *
 * Trimmed and lower-cased *before* the check: people type their address in the
 * spelling that comes to mind, and the stored one is normalised just the same
 * — which makes the comparison over the `unique` index
 * case-insensitive, without a functional index.
 *
 * The length limit stands on the string itself, **before** the pipe: 254 is
 * the upper bound from RFC 5321 and at the same time a cheap payload limit, so
 * it has to be reached before the address runs through the e-mail pattern. In
 * the target of the pipe it would only apply to inputs that already fit —
 * exactly the other way round from how the limit is meant.
 *
 * **One spelling, not three.** Signing in, „Passwort vergessen" and the
 * address change in the profile each spelled out the same five calls anew;
 * that was the same normalisation three times with three occasions to
 * drift apart — and a path that normalises *differently* no longer finds the
 * other one's row.
 */
export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

/** Credentials of a local login (ADR-0005: e-mail plus Argon2id password). */
export const loginRequestSchema = z.object({
  email: emailAddressSchema,
  /**
   * Only "not empty" and an upper bound. A minimum length here would state a
   * password policy the login has no business enforcing — that belongs to the
   * place where passwords are *set*. The bound exists so an oversized string
   * cannot be pushed through Argon2id, and it is the *same* bound the setting
   * side applies — see {@link PASSWORD_HASH_INPUT_MAX}.
   */
  password: z.string().min(1).max(PASSWORD_HASH_INPUT_MAX),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The six group permissions.
 *
 * ## Why there are two „Einstellungen" permissions (ADR-0021)
 *
 * {@link Permissions.canManageSettings} and
 * {@link Permissions.canManageFormSettings} sound like the same permission and
 * are deliberately two: they unlock **two different reaches**.
 *
 * - `canManageFormSettings` applies **per form**: the form settings,
 *   the notifications, the mail log and the user permissions of *this*
 *   form. Whoever builds a form also configures it.
 * - `canManageSettings` applies **organisation-wide**: the form defaults of
 *   the organisation (which every form falls back to), the appearance,
 *   the sending identity and the SSO connection.
 *
 * Being able to do the one without the other is the whole purpose of the
 * separation: the standard group `editor` holds `canManageFormSettings` and
 * **not** `canManageSettings`, so it can configure its forms completely without
 * being able to change the defaults of all the other forms of the organisation.
 *
 * The direction „the narrower permission implies the wider one" does **not**
 * exist here, and in neither of the two reading directions: no schema and no
 * guard derives the one from the other. Whoever needs both holds both — an
 * implication would be a permission a group was never assigned.
 */
export const permissionsSchema = z.object({
  /** Bearbeiten — build and edit forms. */
  canBuild: z.boolean(),
  /** Antworten ansehen. */
  canViewResponses: z.boolean(),
  /** Export. */
  canExport: z.boolean(),
  /**
   * Settings of the **organisation** — form defaults, appearance,
   * sending identity, SSO. Not those of a single form: that is
   * {@link Permissions.canManageFormSettings}.
   */
  canManageSettings: z.boolean(),
  /**
   * Settings **of one form** — form settings,
   * notifications, mail log, user permissions per form (ADR-0021).
   */
  canManageFormSettings: z.boolean(),
  /** Nutzer verwalten. */
  canManageUsers: z.boolean(),
});
export type Permissions = z.infer<typeof permissionsSchema>;

/** A tenant as the header and the tenant switcher need it. */
export const tenantSummarySchema = z.object({
  id: z.uuid(),
  /** Kurzname, shown next to the name in the switcher and superadmin view. */
  shortName: z.string().min(1),
  name: z.string().min(1),
  /**
   * The logo — a shipped asset, this organisation's own upload, or null.
   *
   * **The allow-list is part of the wire contract, not only of
   * the write path.** A wider read schema — plain `z.string()`, say — would
   * make `TenantSummary['logoRef']` a plain `string`, and a consumer writing
   * it straight into an `<img src>` would compile. The narrow type is what
   * makes that a type error instead of a review finding — the resolver in the
   * web app (`resolveTenantLogo`) still re-checks at runtime, because a
   * payload is a payload, but no caller has to remember to.
   *
   * The type is the **union** of {@link tenantLogoSchema} rather
   * than the asset enum: an organisation may upload its own logo, and `kind` is what
   * decides which of the two resolvers a reference reaches. What it is *not* is
   * a widening of trust — an `upload` arm only ever leaves the server for a
   * file the reading query proved to be this organisation's own (ADR-0014 no. 12).
   */
  logoRef: tenantLogoSchema,
  branding: tenantBrandingSchema,
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

/** The group a person belongs to inside one tenant. */
export const groupSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  color: hexColorSchema,
  /** Higher wins when roles are compared (admin 100, editor 60, viewer 20). */
  rank: z.number().int(),
  /** True for the built-in `admin` group: all permissions, not editable. */
  isSystem: z.boolean(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

/** One tenant the signed-in person may work in, with the role they hold. */
export const membershipSummarySchema = z.object({
  tenant: tenantSummarySchema,
  group: groupSummarySchema,
  permissions: permissionsSchema,
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/**
 * The signed-in person, as `GET /auth/me` reports them and as the app shell
 * renders them.
 *
 * `memberships` is the authoritative list for the tenant switcher, and
 * `activeTenantId` says which of them the current session is scoped to. Null
 * means *no* tenant scope — never "all tenants": a superadmin who has not
 * picked a tenant still sees nothing tenant-bound until they do.
 */
export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  isSuperadmin: z.boolean(),
  memberships: z.array(membershipSummarySchema),
  activeTenantId: z.uuid().nullable(),
  /**
   * Whether this installation has the KI-Formularerstellung at all
   * (ADR-0015 no. 9).
   *
   * **One function, two consumers**, and this is the browser's one: the same
   * `aiAvailable(env)` answer that the guard in front of the route reads. That
   * is what keeps „der Eintrag ist da" and „die Route antwortet" from drifting
   * — the failure this guards against: „den Schalter nur die Oberfläche
   * ausblenden lassen".
   *
   * It is **not** a permission and says nothing about `can_build`: it answers
   * „gibt es die Funktion hier?", never „darf diese Person sie benutzen?".
   * The shell reads both, and the route asks its guard chain regardless
   * (`CONTRIBUTING.md`).
   *
   * **Required, not optional.** It was `.optional()` for exactly as long as
   * the server did not send it; since `toSessionUser`
   * carries it, an answer without the field describes a payload no route can
   * produce, and accepting one would only hide a broken server behind a
   * silent „Funktion nicht da".
   */
  aiFormsAvailable: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * Answer to a successful login.
 *
 * Carries the user and nothing else — the session itself is transported by the
 * `Set-Cookie` header, not by the body. A failed login has no schema on
 * purpose: it answers 401 with a message that does not reveal whether the
 * e-mail exists.
 */
export const loginResponseSchema = z.object({
  user: sessionUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * Body of `PUT /api/session/tenant` — the tenant switcher.
 *
 * Lives here rather than in the API because the switcher exists on both sides:
 * the server parses it, and the header's tenant list will send it (`CONTRIBUTING.md`
 * makes these schemas the truth for client and server alike).
 *
 * `z.uuid()` rather than a bare string: the column is `uuid`, and PostgreSQL
 * answers a malformed literal with an error the request would otherwise carry
 * out as a 500 — a parse failure that tells a sender their input reached the
 * database. Note that passing this schema says nothing about whether the
 * tenant may be entered: that is a membership check, and it happens on the
 * server, every time.
 */
export const switchTenantRequestSchema = z.object({
  tenantId: z.uuid(),
});
export type SwitchTenantRequest = z.infer<typeof switchTenantRequestSchema>;

/**
 * One organisation that actually offers SSO — an entry of `GET /api/auth/oidc/providers`.
 *
 * **This list is the „bietet den Weg an"-half of this rule, and it is only that
 * half.** An organisation appears here when `OidcConfigService.signIn` produces a usable
 * configuration for it; an organisation with `oidcEnabled: false` — or with a client
 * secret that does not open — is simply absent. The *other* half is that the
 * start and callback routes refuse such an organisation when they are called directly,
 * because this list is a convenience and the surface is never the protection.
 *
 * **Nothing about the provider travels.** No issuer, no client id, no redirect
 * URI: everything the browser needs is which Organisation to start at and what to write
 * on the button. The issuer in particular is configuration of the organisation and has
 * no business in an unauthenticated response.
 */
export const oidcProviderSchema = z.strictObject({
  /** The organisation to start the flow at — the `:tenantId` of the start route. */
  tenantId: z.uuid(),
  name: z.string().min(1),
  shortName: z.string().min(1),
  /** Caption of the button, already resolved to the shipped default if unset. */
  buttonLabel: z.string().min(1),
  /**
   * Whether **this** organisation is the one the address in the browser's bar
   * belongs to — `tenant.public_base_url` matched against the host the request
   * arrived under, resolved server-side.
   *
   * At most one entry of a list carries `true`, and only when the match is
   * unambiguous: two organisations may hold the same base address (the column
   * has no unique index), and „zwei Treffer" is not an answer to „welche ist
   * gemeint", so it counts as none.
   *
   * **A boolean, never the address.** The comparison happens on the server and
   * only its outcome travels — the same posture `OidcSecretsService.isUsable`
   * takes with a client secret, for a weaker but real reason: this route is
   * reachable without a session, and handing out where every organisation is
   * reachable would widen an answer that is already more talkative than it
   * ought to be.
   *
   * **It decides nothing.** The client pre-selects the entry in its chooser and
   * that is all; whoever is signing in sees the selection and may change it.
   * That is what makes it sound to derive this from a request header at all —
   * see `OidcLoginController.providers`.
   */
  atThisAddress: z.boolean(),
});
export type OidcProvider = z.infer<typeof oidcProviderSchema>;

export const oidcProvidersSchema = z.array(oidcProviderSchema);

/**
 * What the login page writes on the button when an organisation has not chosen a label.
 *
 * Shared rather than server-only so that the fallback is applied **once**, on
 * the server: a client-side default would be a second wording that drifts, and
 * `oidcProviderSchema` could then not require the field at all.
 */
export const DEFAULT_OIDC_BUTTON_LABEL = 'Mit Organisationskonto anmelden';

/**
 * Why an OIDC login ended where it did — the `?sso=` parameter the callback
 * sends the browser back with (ADR-0012 no. 3).
 *
 * **A closed set of codes, never a server message echoed into the address.**
 * The browser turns a code into one of a handful of German sentences that live
 * in `LoginView`; a text carried in the query string would be an open channel
 * for putting arbitrary wording on our own login page.
 *
 * The set is deliberately coarse. `abgelehnt` is the whole of ADR-0012 no. 3
 * step 3: „es liegt keine Einladung vor" and „die Adresse gehört einem lokalen
 * Konto" must read identically, or the login becomes a directory of the
 * installation. `fehlgeschlagen` covers everything before that — a manipulated
 * `state`, a missing `nonce`, an organisation whose SSO is off, an unreadable client
 * secret, a provider that answered with an error — because none of those
 * differences is anything an unauthenticated caller may learn.
 */
export const oidcOutcomeSchema = z.enum([
  /** Signed in; the session cookie is set. */
  'angemeldet',
  /** The provider vouched for somebody this installation does not know here. */
  'abgelehnt',
  /** Authenticated, but the account belongs to no organisation — a dead end, not a shell. */
  'ohne-Organisation',
  /** Anything else, deliberately undifferentiated. */
  'fehlgeschlagen',
]);
export type OidcOutcome = z.infer<typeof oidcOutcomeSchema>;

/** Name of the query parameter {@link oidcOutcomeSchema} travels in. */
export const OIDC_OUTCOME_PARAM = 'sso';

/** Parses foreign login input. Never cast — parse. */
export function parseLoginRequest(source: unknown): LoginRequest {
  return loginRequestSchema.parse(source);
}

/** Parses the SSO offer list — never cast. */
export function parseOidcProviders(source: unknown): OidcProvider[] {
  return oidcProvidersSchema.parse(source);
}

export function parseLoginResponse(source: unknown): LoginResponse {
  return loginResponseSchema.parse(source);
}

export function parseSessionUser(source: unknown): SessionUser {
  return sessionUserSchema.parse(source);
}

/**
 * The answer to a session revocation: **how many** were ended.
 *
 * A number and not a `204`, because it is the actual information. „3 Sitzungen
 * beendet" confirms that there were any; „0 Sitzungen beendet" is the
 * equally important counter-statement to somebody who suspects a break-in.
 *
 * Identifiers are deliberately not in it: which devices a person uses
 * would need a session list, and that would be a decision of its own with a
 * data protection consequence of its own.
 */
export const sessionRevocationSchema = z.object({
  revoked: z.number().int().min(0),
});
export type SessionRevocation = z.infer<typeof sessionRevocationSchema>;

/** Parses the answer to a revocation — never cast. */
export function parseSessionRevocation(source: unknown): SessionRevocation {
  return sessionRevocationSchema.parse(source);
}

// ---------------------------------------------------------------------------
// One's own profile — name and password of the signed-in person
// ---------------------------------------------------------------------------

/**
 * The name somebody changes about themselves.
 *
 * The same limits as `userNameSchema` in `tenant-admin.ts`, because it is the
 * same column: `user.name`, `text`, not empty. The number stands there and
 * here, and this is the one case in which two versions are bearable — they are
 * two write paths onto **one** column, and a drift apart would only mean that
 * one path allows more than the other, not that something becomes unreachable.
 *
 * **Only the name, and that is no longer a gap:** one's own address is changed
 * by {@link emailChangeSchema} — with the query for the current password
 * that the name has not earned. Why the two are separate stands there.
 */
/**
 * The name of a person — **the one spelling**, like
 * {@link emailAddressSchema} for the address.
 *
 * ## Why it has to be single-line (ADR-0026)
 *
 * It travels into the body of a mail that goes out over the mail server of the
 * **installation**: invitation, reset, the notice about a password that has
 * been set. The HTML half is covered by `escapeHtml`, the text
 * version is not — a line break in the name would set a line of its own
 * there, and that reads like a sentence of the application. That is why the
 * condition stands here, where the value comes into being, and not only where
 * it is inserted.
 *
 * It once stood written out three times — here, in `tenant-admin.ts` and at
 * the creation paths. When the condition was added, two of them got it; this
 * place was left behind, because its file happened to belong to somebody else.
 * That is exactly what there is now a name for instead of three copies.
 */
export const personNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isSingleLineText, { message: SINGLE_LINE_TEXT_MESSAGE });

export const profileUpdateSchema = z.strictObject({
  name: personNameSchema,
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/**
 * Changing one's own password — **with the old one being asked for**.
 *
 * The old password is not a courtesy but the boundary: an
 * unattended computer with an open session would otherwise be an account that
 * the next person takes over for good. `currentPassword` therefore carries
 * **no** minimum — it is checked, not set, and an account with an old,
 * shorter password must still be able to enter it (the same consideration as
 * with {@link loginRequestSchema}). `newPassword` carries the minimum, because
 * it is the place at which a password is *set*.
 */
export const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_HASH_INPUT_MAX),
  newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_HASH_INPUT_MAX),
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

/**
 * Changing one's own **e-mail address** — with the current password asked for.
 *
 * ## Why this does not stand in {@link profileUpdateSchema}
 *
 * Because the address is not the same thing as the name. The name grants
 * nothing: whoever changes it is called something else afterwards. The address
 * **is the sign-in key** — changing it means redirecting the login and every
 * „Passwort vergessen" link of this account to another mailbox. That is the
 * takeover path that an unattended computer with an open session otherwise
 * opens up, and exactly the same one that {@link passwordChangeSchema} demands
 * the old password against.
 *
 * Putting both into *one* schema would mean chaining the name to the same
 * query — a password prompt for a corrected typo in a first name.
 * Two schemas and two routes are the more honest division here: two
 * actions with two prices. Address and password therefore travel in the
 * **same** call, as with the password change too — the check is part of the
 * action, not a preceding second call whose result somebody would have to
 * park in between.
 *
 * `currentPassword` carries **no** minimum, for the same reason as there: it
 * is checked, not set.
 *
 * ⚠️ Whether the address is free (`user.email @unique`) and whether this
 * account has a local address at all — an SSO account only mirrors what its
 * sign-in service reports — is decided exclusively by the server. A schema
 * cannot know either.
 */
export const emailChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_HASH_INPUT_MAX),
  email: emailAddressSchema,
});
export type EmailChange = z.infer<typeof emailChangeSchema>;

// ---------------------------------------------------------------------------
// Passwort vergessen (ADR-0020)
// ---------------------------------------------------------------------------

/**
 * How long a reset link is valid.
 *
 * One hour: long enough for the path „request the mail, open the mailbox,
 * click the link" including a queue that is not empty right then, and short
 * enough that a link that stays lying in a shared mailbox or in a
 * mail archive does not sit there as permanent access.
 *
 * A constant and not an environment variable, for the same reason as the
 * deletion periods: the rhythm of operation is configurable, the promise is not.
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;

/**
 * How long a **dead** reset row still stays standing — expired or
 * redeemed.
 *
 * The same number as `SESSION_RETENTION_DAYS` and deliberately not a second
 * one: the row carries the same personal reference (who, when) and answers the
 * same downstream question („wurde mein Passwort zurückgesetzt, und wann?").
 * Two periods for two sign-in artefacts would be two numbers without two reasons.
 *
 * The clean-up run is the one for the sessions (`session-purge.service.ts`) —
 * see there why it did not become a second run with a tile of its own.
 */
export const PASSWORD_RESET_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Invitation of a newly created account (ADR-0024)
// ---------------------------------------------------------------------------

/**
 * How long an **invitation link** is valid — days, not minutes.
 *
 * ## Why not {@link PASSWORD_RESET_TTL_MINUTES}
 *
 * Because the two links arise from different occasions and are therefore
 * needed for different lengths of time:
 *
 * | | Reset | Invitation |
 * |---|---|---|
 * | who triggers it | the person themselves, just now | somebody else, without notice |
 * | when is it clicked | in the next few minutes | when the person next looks into their mailbox |
 * | what does an expiry cost | a new request, done by oneself | a request to the administration |
 *
 * One hour would, for an invitation that drops into a mailbox on a Friday
 * afternoon, practically always be expired — and the way out would not be
 * „request it again" but „ask somebody", that is, the path this change is
 * doing away with.
 *
 * **Seven days** and not thirty: the number covers a full weekend and
 * a week with a bridging day and still does not let a link that stays lying in
 * a shared or archived mailbox be valid for more than a semester.
 * It is thereby of the same order of magnitude as
 * {@link PASSWORD_RESET_RETENTION_DAYS} — for a different reason, but without
 * contradiction —, and the price of an expiry is capped, because an
 * invitation can be sent again (`POST /api/tenant/users/:id/invitation`).
 *
 * A constant and not an environment variable, for the same reason as the
 * reset period: the rhythm of operation is configurable, the promise is not.
 */
export const ACCOUNT_INVITATION_TTL_DAYS = 7;

/**
 * „Passwort vergessen" — the request.
 *
 * Only the address, and it is normalised just as when signing in: the
 * row is found over the `unique` index, and that is the
 * case-insensitive search only as long as both paths apply the same
 * normalisation.
 *
 * ⚠️ **The answer of this route is independent of the address** — same
 * status code, same (empty) body, whether the account exists or not. There is
 * therefore deliberately *no* response schema: a field that told something
 * would be exactly the channel ADR-0020 closes.
 */
export const passwordResetRequestSchema = z.strictObject({
  email: emailAddressSchema,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/**
 * The redemption: the value from the link plus the new password.
 *
 * `token` is base64url over 32 random bytes, so 43 characters; the limit here
 * is more generous and serves only as a payload limit — a value that does not
 * fit *exactly* is rejected anyway, and a length error must not
 * look different from a wrong value.
 */
export const passwordResetConfirmSchema = z.strictObject({
  token: z.string().min(1).max(256),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_HASH_INPUT_MAX),
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

/**
 * The **one** refusal of the redemption.
 *
 * One sentence for „I do not know it", „expired", „already used" and „the
 * account signs in via SSO". Not out of convenience: every distinction would
 * be information to somebody who presents a foreign or guessed value.
 *
 * **Du-Form**, like the rest of the application. The sentence was the only one
 * to address the reader formally — that did not stand out as long as it was
 * seen only by whoever had forgotten their password. Since ADR-0024 it also
 * greets every invited person, and then it stands next to pages that use the
 * informal address throughout.
 */
export const PASSWORD_RESET_INVALID_MESSAGE =
  'Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.';
