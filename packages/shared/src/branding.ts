import { z } from 'zod';

import { fileRefSchema, isFileRef, type FileRef } from './file-types.ts';
import { SINGLE_LINE_TEXT_MESSAGE, isSingleLineText } from './html-text.ts';

/**
 * Branding of an organisation — the colour predicate, the logo allow-list, the shape
 * a save carries and the gate every delivery passes (design handoff *Erscheinungsbild & Login*).
 *
 * ## Why this file exists at all
 *
 * The colour rule used to stand **twice**, with two different alphabets:
 * `hexColorSchema` in `auth.ts` accepted `#rgb`, `#rgba`, `#rrggbb` and
 * `#rrggbbaa`, and `HEX_COLOR`/`isBrandColor` in
 * `apps/web/src/styles/tenant-theme.ts` repeated the same regular expression by
 * hand. Two copies of a security predicate are not defence in depth — they are
 * two places to narrow and one place to forget. This project has paid for that
 * exact duplication three times (`pickDefaultColumns`, the placeholder grammar,
 * a preview height), and `single-source.test.ts` now guards the identifiers
 * below so a third copy cannot come back quietly.
 *
 * ## The two gates, and why they are the same predicate
 *
 * A branding colour ends up in a CSS custom property on a page **strangers**
 * open. An editor is not an attacker, but `#fff; } body { … }` in a colour
 * column is a CSS injection all the same, and a value can reach the column past
 * the API — by hand, by an older version, by a restore. So the check happens
 * twice, on two different occasions:
 *
 * 1. **Saving** — {@link tenantBrandingWriteSchema} refuses the request.
 * 2. **Delivering** — {@link deliverableBranding} refuses to hand the stored
 *    value on, whatever put it there.
 *
 * Both ask {@link isBrandColor}, which is why a document that passes gate 1 and
 * fails gate 2 cannot exist. That has a consequence for the tests and it is
 * written down here rather than discovered later (the shape already established
 * for the redirect URL): an integration test that saves and then reads goes red
 * when **gate 1** falls or when both fall — never when only gate 2 falls. Each
 * gate therefore has a unit test of its own that establishes exactly its own
 * precondition, and gate 2's precondition is a row that gate 1 never saw.
 *
 * ## What is deliberately not here
 *
 * The **upload** of a logo. What this module offers is a *selection* from the assets that ship
 * with the application; an upload brings a file whitelist, size limits, a
 * storage abstraction and the `file` model with it, and that is the *Datei-
 * Upload* question type.
 */

/**
 * `#rrggbb`, and nothing else.
 *
 * **Narrower than what stood here before**, and the narrowing is the decision:
 * `#rgb`, `#rgba` and `#rrggbbaa` were accepted because "the colour pickers
 * emit them", but no colour picker in this application emits them — the pickers
 * are `<input type="color">`, whose value is `#rrggbb` by specification, and
 * every stored value in the seed, the fixtures and the design handoff is
 * already six digits. What the wider alphabet did buy was two shapes nobody
 * wanted: an **alpha channel** on an organisation's colours (a translucent header bar
 * over whatever happens to be behind it) and a second spelling of the same
 * colour, which makes "is this the organisation's red?" a question with two answers.
 *
 * The price of narrowing is stated rather than discovered: any stored value in
 * a short or alpha form stops being delivered and falls back to
 * {@link DEFAULT_TENANT_BRANDING}. Checked before deciding — the seed
 * (`apps/api/prisma/seed.ts`), the API fixtures and the web fixtures hold
 * `#rrggbb` throughout, so nothing in this repository is affected; a production
 * database from before this rule could only hold what the API accepted, and the API has
 * only ever been written by `<input type="color">`.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * True when `value` is a colour literal that is safe to hand to CSS.
 *
 * **The single predicate behind both gates.** A custom property value is an
 * almost arbitrary token sequence, so an unvalidated branding string such as
 * `red; background: url(https://evil.example/x)` would survive into the
 * declaration and could be substituted back out through `var()`. Restricting
 * the alphabet removes that class of injection entirely.
 */
export function isBrandColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** {@link isBrandColor} as a schema — the way a request states a colour. */
export const hexColorSchema = z.string().refine(isBrandColor, {
  error: 'Nur Farbwerte der Form #rrggbb sind erlaubt.',
});

/**
 * Branding of a tenant in the shape the app renders: these five axes map
 * one-to-one onto the `--tenant-*` custom properties of `tokens.css`.
 *
 * Every one of them has been through {@link deliverableBranding} by the time it
 * travels — the schema states the shape, the gate states the trust.
 */
export const tenantBrandingSchema = z.object({
  accent: hexColorSchema,
  headerBg: hexColorSchema,
  canvasBg: hexColorSchema,
  /** Colour stripe in display order. Three colours is the handoff default. */
  stripe: z.array(hexColorSchema),
  /** True for wide word marks (Dachorganisation), false for a square logo. */
  wideLogo: z.boolean(),
});
export type TenantBranding = z.infer<typeof tenantBrandingSchema>;

// ---------------------------------------------------------------------------
// The Logo — a selection, not an upload
// ---------------------------------------------------------------------------

/**
 * The logo assets that ship with the application.
 *
 * **This list is the allow-list**, and it is the only reason a
 * `logo_ref` may become an `src` attribute. A reference is a database value; if
 * it reached an `<img>` by string concatenation, a tenant row would decide what
 * a visitor's browser goes and fetches — `javascript:…` on a page an organisation's
 * members trust, or `https://fremd.example/…`, which is an outbound call from
 * inside an organisation's own page and tells a third party who opened which form.
 *
 * `as const` on purpose: {@link TenantLogoRef} is derived from it, so the
 * bundled asset table in `apps/web/src/shell/tenant-logo.ts` is *type-checked*
 * against this list instead of agreeing with it by hand.
 */
export const TENANT_LOGO_REFS = [
  'assets/beispiel-signet.svg',
  'assets/beispiel-emblem.svg',
] as const;

/** One of the shipped references — see {@link TENANT_LOGO_REFS}. */
export type TenantLogoRef = (typeof TENANT_LOGO_REFS)[number];

/**
 * True when `ref` names a shipped asset.
 *
 * `readonly string[]` is searched with `includes` after a widening cast-free
 * `some`, so a value off the prototype chain (`'__proto__'`, `'constructor'`)
 * is answered `false` like any other unknown string — an object lookup would
 * "find" both.
 */
export function isTenantLogoRef(ref: string | null): ref is TenantLogoRef {
  return ref !== null && TENANT_LOGO_REFS.some((known) => known === ref);
}

/** {@link isTenantLogoRef} as a schema — the way a save states a shipped logo. */
export const tenantLogoRefSchema = z.enum(TENANT_LOGO_REFS);

/**
 * **What a logo is on the wire — a discriminated union, not a string with a
 * prefix convention** (ADR-0014 no. 12).
 *
 * `'upload:xyz'` would have been the cheaper spelling and is refused for the
 * reason ADR-0013 no. 1 gives: a convention is a promise made at runtime, a
 * union is a statement of the type system. Concretely it keeps what
 * {@link TENANT_LOGO_REFS} has kept out — an `src={logoRef}` built
 * by string concatenation, in which a database column decides what a visitor's
 * browser goes and fetches. With the union, `kind` says *which resolver*
 * applies, and neither resolver ever sees the other's value: `'asset'` goes
 * into the bundled table of `apps/web/src/shell/tenant-logo.ts`, `'upload'`
 * into `GET /api/public/files/:ref` and nowhere else.
 *
 * `null` is the third arm and carries the safety: a reference that is neither a
 * shipped asset nor a **proven** upload of this organisation loses its logo. Visible,
 * harmless, and never somebody else's file — see {@link deliverableBranding}.
 *
 * **One schema for four payloads.** The session (`auth.ts`), the public fill-in
 * page (`public-form.ts`), the *Erscheinungsbild* tab's read and its write all
 * spell the logo with this constant, so „was ist ein Logo" cannot come to
 * mean four things.
 */
export const tenantLogoSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('asset'), ref: tenantLogoRefSchema }),
    z.object({ kind: z.literal('upload'), ref: fileRefSchema }),
  ])
  .nullable();

/**
 * What a `logo_ref` is allowed to become on the way out — see
 * {@link tenantLogoSchema}.
 *
 * Derived with `z.infer` rather than written out beside the schema: two
 * descriptions of one shape are what `CONTRIBUTING.md` rules out, and this one had
 * already drifted once (the hand-written type carried `readonly` members the
 * schema could not produce, so every parse needed a widening).
 */
export type DeliverableLogo = z.infer<typeof tenantLogoSchema>;

// ---------------------------------------------------------------------------
// Gate 1 — saving („Ablehnung beim Speichern")
// ---------------------------------------------------------------------------

/*
 * **There are exactly three colour axes that actually colour anything**: `accent`
 * (primary buttons, switches, focus rings, progress — dozens of stylesheets
 * read `--color-accent`), `headerBg` (the header bar) and `stripe` (the
 * stripe, `stripeColors`). Every colour is maintained in exactly one place —
 * nowhere a second list from which a button would first have to copy it.
 *
 * The stripe has no fixed count ({@link STRIPE_COLOR_MAX} is an
 * upper bound, not a measure): a fixed number that counts nothing would be the next
 * constant somebody takes for an assurance.
 */

/** Upper bound on the stripe, so a payload cannot grow a gradient unboundedly. */
export const STRIPE_COLOR_MAX = 8;

/**
 * What the *Erscheinungsbild* tab writes back.
 *
 * A `strictObject` and a **whole-document** write: the tab shows all of these
 * at once, so a patch protocol would only add a way to mean "leave that one" —
 * which is the same as sending it unchanged.
 *
 * **`shortName` is not in here**, although the tab shows it. The Kurzname is
 * unique across the installation and is the handle other organisations are told about;
 * renaming it is a superadmin act with a uniqueness conflict attached to it
 * , not a branding change. Leaving it out means this route can
 * never answer 409 for a reason that has nothing to do with colours.
 *
 * `revision` is the optimistic lock — see {@link tenantBrandingSettingsSchema}.
 */
export const tenantBrandingWriteSchema = z.strictObject({
  /**
   * The organisation's displayed name — **single-line**
   * (ADR-0026).
   *
   * The same two-gate consideration as with the colours above, only with a
   * different target: a colour lands in a CSS property, this value
   * lands in the **body of a system mail** (`localInvitationBody`,
   * `passwordResetMailBody`, `passwordSetNoticeBody`) and in the display name of the
   * sender. In the text version a `\n` is not a character but a new
   * line — whoever holds `can_manage_settings` would thereby write into a mail that
   * goes out over the identity of the installation. {@link isSingleLineText}
   * is gate 1; `collapseWhitespace` immediately before the substitution is gate 2.
   *
   * `tenantCreateSchema.name` in `tenant-admin.ts` is the second write path
   * onto the same column and carries the same condition.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(isSingleLineText, { message: SINGLE_LINE_TEXT_MESSAGE }),
  /**
   * `null` for an organisation that shows its name instead of a logo.
   *
   * **The `upload` arm means „behalte mein hochgeladenes Logo", never
   * „nimm dieses"** . Choosing an upload is what the upload
   * route does — it writes the column itself, in the transaction that mints the
   * row — so this schema can only ever *keep* what is already there, and the
   * server refuses any other reference (`TenantBrandingService`).
   *
   * That is a narrowing with a purpose rather than a convenience: a save is the
   * one place where a client hands back a reference it read some time ago, and
   * „irgendein Upload-Verweis darf in diese Spalte" is exactly how a stale tab
   * — or a crafted request — would re-point `logo_ref` at a row the sweep is
   * removing, or at another organisation's file. The delivery gate would still refuse
   * the foreign one ({@link deliverableBranding}); this keeps it from being
   * written in the first place.
   */
  logoRef: tenantLogoSchema,
  logoWide: z.boolean(),
  /**
   * The colours of the header stripe, in display order — the
   * **organisation colours**, maintained directly.
   *
   * Count and order are the organisation's choice (handoff,
   * „Streifenreihenfolge"), between one colour and {@link STRIPE_COLOR_MAX}.
   */
  stripeColors: z.array(hexColorSchema).min(1).max(STRIPE_COLOR_MAX),
  accent: hexColorSchema,
  headerBg: hexColorSchema,
  canvasBg: hexColorSchema,
  revision: z.number().int().positive(),
});
export type TenantBrandingWrite = z.infer<typeof tenantBrandingWriteSchema>;

/**
 * What the *Erscheinungsbild* tab reads.
 *
 * An allow list, like every read schema of the tenant administration: a column
 * added to `tenant` later has to be added here too, and the test that pins the
 * payload down fails until somebody looks at it. The OIDC half of the same tab
 * has its own schema in `tenant-admin.ts` and its own route — a client secret
 * has no business travelling next to a colour.
 *
 * **`logoChoices` is delivered rather than compiled into the view**, so the set
 * the tab offers and the set the server accepts cannot drift: the allow-list's whole claim
 * is that a `logo_ref` outside the shipped set is refused, and a view with its
 * own hard-coded list would be the second description that makes that claim
 * false the day one of them grows an entry.
 */
export const tenantBrandingSettingsSchema = z.strictObject({
  name: z.string().min(1),
  /** Read-only here — see {@link tenantBrandingWriteSchema}. */
  shortName: z.string().min(1),
  /** The Logo through the gate — a shipped asset, this organisation's upload, or none. */
  logoRef: tenantLogoSchema,
  logoWide: z.boolean(),
  stripeColors: z.array(hexColorSchema),
  accent: hexColorSchema,
  headerBg: hexColorSchema,
  canvasBg: hexColorSchema,
  /** The shipped logo an organisation may choose from — a selection, not an upload. */
  logoChoices: z.array(tenantLogoRefSchema),
  /**
   * Send this back with the next write.
   *
   * Its own counter next to `form_defaults_revision`, not a shared one: the two
   * documents are edited on two different tabs, and a shared counter would make
   * a colleague's change to the form standards reject a colour change that has
   * nothing to do with it. Same reason `form.revision` and
   * `form.settings_revision` are separate.
   */
  revision: z.number().int().positive(),
});
export type TenantBrandingSettings = z.infer<
  typeof tenantBrandingSettingsSchema
>;

export const parseTenantBrandingSettings = (
  value: unknown,
): TenantBrandingSettings => tenantBrandingSettingsSchema.parse(value);

// ---------------------------------------------------------------------------
// Gate 2 — delivering („und beim Ausliefern", allow-list)
// ---------------------------------------------------------------------------

/**
 * The look an organisation falls back to when its stored branding cannot be trusted —
 * the Dachorganisation defaults of `tokens.css`, stated once here.
 *
 * **Substituting rather than omitting**, and the reason is the wire contract:
 * {@link tenantBrandingSchema} has no room for "no accent colour", so a payload
 * carrying a rejected value would fail to parse on the client and take the
 * whole session read (`GET /api/auth/me`) or the whole public fill-in page down
 * with it. One poisoned column must cost an organisation its colours, not its login and
 * not its forms. The frontend degrades the same way one layer further down:
 * `tenantThemeStyle()` omits an axis it cannot trust, and the `:root` default
 * then stays in effect — which is exactly this look.
 *
 * **The same three colours therefore stand in `apps/web/src/styles/tokens.css`
 * as well, and that copy cannot be removed:** a CSS custom property cannot
 * import a TypeScript constant. It is guarded instead — `tokens.test.ts`
 * („the fallback branding") reads the stylesheet and compares it with this
 * constant, so the two cannot drift into „one accent on the page, another one in
 * the editor that claims to show the fallback".
 *
 * The seed's umbrella tenant (`apps/api/prisma/seed.ts`) spells them a third time
 * and is deliberately *not* guarded: that is one organisation's branding on its way into
 * a database column, free to be recoloured without this constant moving.
 */
export const DEFAULT_TENANT_BRANDING = {
  stripeColors: ['#212226', '#7c0800', '#cea967'],
  accent: '#cea967',
  headerBg: '#212226',
  canvasBg: '#e9e6df',
} as const;

/**
 * A tenant row as it comes out of the database — the column names, not the
 * wire names, because that is what the gate is *for*: it stands between the two
 * so that no mapper can put a column into a payload without passing here.
 */
export interface StoredTenantBranding {
  readonly logoRef: string | null;
  readonly logoWide: boolean;
  readonly stripeColors: readonly string[];
  readonly accentColor: string;
  readonly headerColor: string;
  readonly canvasColor: string;
}

/** What a stored branding is allowed to become on the way out. */
export interface DeliverableBranding {
  /** The Logo, through the gate — see {@link DeliverableLogo}. */
  readonly logoRef: DeliverableLogo;
  /**
   * The five render axes — and **only** those. Every field here is one a
   * page actually renders; there is no second colour list beside it that a
   * button would have to keep in sync.
   */
  readonly branding: TenantBranding;
}

/** A single colour, or the default when the stored one cannot be trusted. */
function safeColor(stored: string, fallback: string): string {
  return isBrandColor(stored) ? stored : fallback;
}

/**
 * A colour list, all or nothing.
 *
 * Dropping only the offending entry would render a stripe the organisation never
 * configured — three colours silently becoming two is a different design, not
 * a repaired one. An empty list is rejected too: `stripeGradient()` cannot
 * build a gradient from it, so it would degrade in the view anyway, and
 * degrading in one place is easier to reason about than in two.
 */
function safeColors(
  stored: readonly string[],
  fallback: readonly string[],
): string[] {
  // Copied, not passed through: the wire type is a mutable array, and handing
  // a caller's array on would let a mapper's `.push()` reach back into a row
  // object — or into {@link DEFAULT_TENANT_BRANDING}, which every organisation shares.
  return stored.length > 0 && stored.every(isBrandColor)
    ? [...stored]
    : [...fallback];
}

/**
 * **Gate 2** — everything a stored branding is allowed to become on the way to
 * a browser.
 *
 * Every output site of the application goes through here: the session payload
 * (`apps/api/src/auth/session-user.ts`), the public fill-in page
 * (`apps/api/src/public/public-forms.service.ts`) and the *Erscheinungsbild*
 * tab itself. The public one is the case that makes this gate load-bearing: it
 * has **no session**, so the colours come from the organisation of the *form* and there
 * is no signed-in editor whose row could stand in for it.
 *
 * Pure and total — it never throws. A gate that can throw is a gate that takes
 * a page down when a column is wrong, and "the organisation's colours are wrong" must
 * not become "the form cannot be filled in".
 *
 * ## Why the ownership check is a **parameter** and not a line in here
 *
 * An organisation may upload its own logo, so `logo_ref` may name a `file` row —
 * and „gehört diese Datei dieser Organisation?" is a question this function cannot
 * answer: it is pure, it has no database, and it sees one column. Putting the
 * check here would mean either making it impure or comparing two values that
 * both come out of the same row, which proves nothing.
 *
 * So the check happens **before** the gate and structurally (ADR-0014 no. 12):
 * the reading query loads the logo file **through the tenant relation**, so a
 * reference to another organisation's file finds nothing — not because a comparison
 * afterwards rejects it. What arrives here is the result: `ownedUpload` is the
 * reference the *query* proved to be this organisation's property, or `null`.
 *
 * **The default is the point.** A caller that does not load the relation loses
 * the logo (visible, harmless, falls back to no logo) — it can never hand out
 * a foreign one. A forgotten shore is therefore a display bug and not a data
 * leak.
 */
export function deliverableBranding(
  stored: StoredTenantBranding,
  /** The reference the **query** proved to be this organisation's own (no. 12). */
  ownedUpload: FileRef | null = null,
): DeliverableBranding {
  return {
    logoRef: deliverableLogo(stored.logoRef, ownedUpload),
    branding: {
      accent: safeColor(stored.accentColor, DEFAULT_TENANT_BRANDING.accent),
      headerBg: safeColor(stored.headerColor, DEFAULT_TENANT_BRANDING.headerBg),
      canvasBg: safeColor(stored.canvasColor, DEFAULT_TENANT_BRANDING.canvasBg),
      stripe: safeColors(
        stored.stripeColors,
        DEFAULT_TENANT_BRANDING.stripeColors,
      ),
      wideLogo: stored.logoWide,
    },
  };
}

/**
 * The one rule behind {@link DeliverableLogo}, written once.
 *
 * Asset **first**: a shipped reference can never be re-read as an upload, so a
 * future `TENANT_LOGO_REFS` entry that happened to match {@link isFileRef}
 * could not change arms under an installation.
 *
 * The upload arm asks **two** things and needs both. `isFileRef` bounds the
 * shape — a stored value is foreign data even when it comes out of our own
 * column — and the identity with `ownedUpload` is the ownership, which the
 * caller's query established. Either one alone would be the bug: the predicate
 * alone delivers any organisation's reference, the comparison alone would hand an
 * unbounded column value to whoever builds an address out of it.
 */
function deliverableLogo(
  stored: string | null,
  ownedUpload: FileRef | null,
): DeliverableLogo {
  if (isTenantLogoRef(stored)) {
    return { kind: 'asset', ref: stored };
  }
  if (stored !== null && ownedUpload !== null && stored === ownedUpload) {
    return isFileRef(stored) ? { kind: 'upload', ref: stored } : null;
  }
  return null;
}

/**
 * Is this the organisation's **own uploaded** Logo? — the one question a life-cycle
 * decision asks of a delivered logo.
 *
 * Written here rather than as `logo?.kind === 'upload'` at each caller because
 * the callers are the ones that *delete bytes*: the sweep of
 * `TenantLogoService` compares what an organisation now shows against the rows it holds,
 * and a mis-typed comparison there removes a live logo. One predicate, one
 * place to get it wrong.
 *
 * *(This replaces `assetLogoRef()`, the seam that narrowed the wire to the
 * shipped assets before uploads existed. The wire now carries the union
 * itself — `tenantLogoSchema` — so there is nothing left to narrow.)*
 */
export function uploadedLogoRef(logo: DeliverableLogo): FileRef | null {
  return logo?.kind === 'upload' ? logo.ref : null;
}
