import type { TenantReplyTo, TenantReplyToWrite } from '@formsache/shared';

import { trimmedOrNull } from '../trimmed-or-null';

/**
 * The draft of the *Antwortadresse* section — one string, held next to the
 * field that builds and reads it; the same division `tenant-base-url-draft.ts`
 * uses for its card.
 */

/** What the field shows: the stored address, or empty for „keine". */
export interface TenantReplyToDraft {
  readonly value: string;
}

export function tenantReplyToDraftOf(
  config: TenantReplyTo,
): TenantReplyToDraft {
  return { value: config.replyTo ?? '' };
}

/** Whether saving the draft would change anything against the server state. */
export function tenantReplyToDirty(
  config: TenantReplyTo,
  draft: TenantReplyToDraft,
): boolean {
  return trimmedOrNull(draft.value) !== config.replyTo;
}

/**
 * The draft as the write contract of the wire wants it.
 *
 * An empty field is `null` — „keine eigene, die Systemvorgabe gilt" — never
 * the empty string: `replyToAddressSchema` demands an address, and `''` would
 * be a 400 for a save that meant "delete".
 */
export function tenantReplyToWriteOf(
  draft: TenantReplyToDraft,
): TenantReplyToWrite {
  return { replyTo: trimmedOrNull(draft.value) };
}
