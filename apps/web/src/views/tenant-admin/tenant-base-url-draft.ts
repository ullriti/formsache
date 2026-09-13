import type { TenantBaseUrl, TenantBaseUrlWrite } from '@formsache/shared';

import { trimmedOrNull } from '../trimmed-or-null';

/**
 * The draft of the *Basis-Adresse*-Abschnitt —
 * one string, kept next to the field that builds and reads it, the same split
 * `mail-identity-draft.ts` uses for its own card.
 */

/** What the field shows: the stored address, or the empty string for „keine". */
export interface TenantBaseUrlDraft {
  readonly value: string;
}

export function tenantBaseUrlDraftOf(
  config: TenantBaseUrl,
): TenantBaseUrlDraft {
  return { value: config.baseUrl ?? '' };
}

/** Whether saving `draft` would change anything the server has. */
export function tenantBaseUrlDirty(
  config: TenantBaseUrl,
  draft: TenantBaseUrlDraft,
): boolean {
  return trimmedOrNull(draft.value) !== config.baseUrl;
}

/**
 * The draft, as the wire's write contract wants it.
 *
 * A blank field is `null` — „keine eigene, die Systemvorgabe gilt" — never
 * the empty string: `tenantBaseUrlWriteSchema`'s `baseUrlSchema` requires at
 * least one character, and sending `''` would be a 400 for a save that meant
 * „clear it" — the exact trap the shared `trimmedOrNull` exists against, for
 * this field and for the three others that once each carried their own copy of
 * it.
 */
export function tenantBaseUrlWriteOf(
  draft: TenantBaseUrlDraft,
): TenantBaseUrlWrite {
  return { baseUrl: trimmedOrNull(draft.value) };
}
