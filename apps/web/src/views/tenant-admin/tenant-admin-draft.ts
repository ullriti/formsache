import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  type DeliverableLogo,
  type OidcConfig,
  type OidcConfigWrite,
  type TenantBrandingSettings,
  type TenantBrandingWrite,
  type TenantLogoRef,
} from '@formsache/shared';

import { trimmedOrNull } from '../trimmed-or-null';

/**
 * The two drafts of the *Erscheinungsbild & Login* tab, kept next to the fields that build and read them — the same split
 * `settings-draft.ts` uses for the settings sections.
 *
 * Both are typed **without `revision`**: `useServerDraft` (`CONTRIBUTING.md`) owns the local copy, and the revision travels alongside it
 * as the loaded document's own field, never as part of what an editor types.
 */

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export type BrandingDraft = Omit<TenantBrandingWrite, 'revision'>;

/** What the fields show before anything is typed. */
export function brandingDraftOf(
  document: TenantBrandingSettings,
): BrandingDraft {
  return {
    name: document.name,
    // Copied rather than passed through, for the reason the arrays below are:
    // the wire type is mutable, and handing the query cache's own object on
    // would let a later edit here reach back into the cached document.
    logoRef: document.logoRef === null ? null : { ...document.logoRef },
    logoWide: document.logoWide,
    // Copied rather than passed through: the wire type is a mutable array, and
    // handing the query cache's own array on would let a later `.push()` here
    // reach back into the cached document.
    stripeColors: [...document.stripeColors],
    accent: document.accent,
    headerBg: document.headerBg,
    canvasBg: document.canvasBg,
  };
}

function sameColors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((color, index) => color === b[index]);
}

/**
 * Whether two logos are the same one.
 *
 * `===` stopped working when `logoRef` became the union of ADR-0014 no. 12: two
 * objects describing the same asset are two objects, so the „Speichern" button
 * would have looked enabled from the moment the document loaded. Compared by
 * both fields rather than by `ref` alone — the discriminator decides which
 * resolver applies, and „gleicher String, anderer Arm" is a different logo.
 */
function sameLogo(a: DeliverableLogo, b: DeliverableLogo): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.kind === b.kind && a.ref === b.ref;
}

/** Whether saving `draft` would change anything the server has. */
export function brandingDirty(
  document: TenantBrandingSettings,
  draft: BrandingDraft,
): boolean {
  return (
    document.name !== draft.name ||
    !sameLogo(document.logoRef, draft.logoRef) ||
    document.logoWide !== draft.logoWide ||
    !sameColors(document.stripeColors, draft.stripeColors) ||
    document.accent !== draft.accent ||
    document.headerBg !== draft.headerBg ||
    document.canvasBg !== draft.canvasBg
  );
}

export function brandingWriteOf(
  draft: BrandingDraft,
  revision: number,
): TenantBrandingWrite {
  return { ...draft, revision };
}

// ---------------------------------------------------------------------------
// OIDC / SSO
// ---------------------------------------------------------------------------

/**
 * What „Client-Secret" carries in the draft — the three states the write
 * contract itself distinguishes (`oidcConfigWriteSchema`'s comment): the page
 * never holds the stored secret, so „unchanged" cannot be a copied string.
 */
export type ClientSecretDraft =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'remove' };

export interface OidcDraft {
  readonly enabled: boolean;
  readonly issuer: string;
  readonly clientId: string;
  /** Space-separated, the way the handoff's single „Scopes" field edits them. */
  readonly scopesText: string;
  /**
   * The two claim names of Konzept no. 70, as text.
   *
   * An **empty** `emailClaim` reads as „die Vorgabe" and is sent as `email` —
   * the write contract has no room for an empty address claim, and a save that
   * refuses because a field was cleared would be a worse answer than the one the
   * placeholder already announces.
   *
   * An empty `emailVerifiedClaim` is the opposite: it is **sent as empty**,
   * because empty is the decision „ohne Gegenprüfung" and not a missing value.
   * The two look alike in the markup and must not behave alike.
   */
  readonly emailClaim: string;
  readonly emailVerifiedClaim: string;
  readonly buttonLabel: string;
  readonly clientSecret: ClientSecretDraft;
}

export function oidcDraftOf(config: OidcConfig): OidcDraft {
  return {
    enabled: config.enabled,
    issuer: config.issuer ?? '',
    clientId: config.clientId ?? '',
    scopesText: config.scopes.join(' '),
    emailClaim: config.emailClaim,
    emailVerifiedClaim: config.emailVerifiedClaim,
    buttonLabel: config.buttonLabel ?? '',
    clientSecret: { kind: 'keep' },
  };
}

export function oidcDirty(config: OidcConfig, draft: OidcDraft): boolean {
  return (
    config.enabled !== draft.enabled ||
    (config.issuer ?? '') !== draft.issuer.trim() ||
    (config.clientId ?? '') !== draft.clientId.trim() ||
    config.scopes.join(' ') !== normalizedScopesText(draft.scopesText) ||
    config.emailClaim !== emailClaimOf(draft) ||
    config.emailVerifiedClaim !== draft.emailVerifiedClaim.trim() ||
    (config.buttonLabel ?? '') !== draft.buttonLabel.trim() ||
    draft.clientSecret.kind !== 'keep'
  );
}

function normalizedScopesText(text: string): string {
  return splitScopes(text).join(' ');
}

function splitScopes(text: string): string[] {
  return text.split(/\s+/).filter((scope) => scope !== '');
}

/**
 * The address claim a cleared field stands for — see {@link OidcDraft}.
 *
 * Deliberately **only** for the address claim. The verification claim has no
 * such fallback: emptying it is the choice Konzept no. 70 offers, and a default
 * applied here would silently take it back.
 */
function emailClaimOf(draft: OidcDraft): string {
  const trimmed = draft.emailClaim.trim();
  return trimmed === '' ? DEFAULT_OIDC_EMAIL_CLAIM : trimmed;
}

export function oidcWriteOf(draft: OidcDraft): OidcConfigWrite {
  return {
    enabled: draft.enabled,
    issuer: trimmedOrNull(draft.issuer),
    clientId: trimmedOrNull(draft.clientId),
    scopes: splitScopes(draft.scopesText),
    emailClaim: emailClaimOf(draft),
    emailVerifiedClaim: draft.emailVerifiedClaim.trim(),
    buttonLabel: trimmedOrNull(draft.buttonLabel),
    // Absent means „lass das gespeicherte Geheimnis stehen" — the three-state
    // contract of `oidcConfigWriteSchema`, carried through rather than
    // defaulted to a fourth, wrong state.
    ...(draft.clientSecret.kind === 'keep'
      ? {}
      : {
          clientSecret:
            draft.clientSecret.kind === 'remove'
              ? null
              : draft.clientSecret.value,
        }),
  };
}

/** Re-exported for callers that only need the allow-list type, not the draft. */
export type { TenantLogoRef };
