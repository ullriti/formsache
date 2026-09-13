import {
  isFileRef,
  type DeliverableLogo,
  type TenantLogoRef,
} from '@formsache/shared';

import { API_BASE } from '../api/http';
import beispielSignetUrl from '../assets/beispiel-signet.svg';
import beispielEmblemUrl from '../assets/beispiel-emblem.svg';

/**
 * Resolves a tenant's `logoRef` to an image URL.
 *
 * **Two kinds, two resolvers, and the discriminator is what picks** (ADR-0014 no. 12): a shipped asset comes out of the bundled table
 * below, an uploaded logo out of the public file route, and neither resolver
 * ever sees the other's value.
 *
 * The table is explicit on purpose, and the upload branch is bounded for the
 * same reason: turning `logoRef` into a URL by string concatenation would let a
 * database value choose what the browser loads, which is how a tenant record
 * becomes an outbound request to somewhere else — `javascript:…` on a page a
 * organisation's members trust, or `https://fremd.example/…`, which is an outbound call
 * from inside an organisation's own page and tells a third party who opened which form.
 */

/**
 * The bundled asset behind each shipped reference.
 *
 * **Keyed by {@link TenantLogoRef}**, so the set this table answers and the
 * allow-list the server enforces are the *same* list rather than two that
 * happen to agree: adding a reference in `packages/shared/src/branding.ts`
 * without bundling the file here is a type error, and the completeness test
 * covers the other direction — a reference this table cannot resolve would
 * otherwise just show nothing, the failure mode of two hand-kept lists that
 * quietly drifted apart.
 *
 * A `Map`, not an object literal: `logoRef` is a database value, and indexing
 * an object with it hands the lookup the prototype chain as well. `'__proto__'`
 * would resolve to `Object.prototype` and `'constructor'` to a function — both
 * are "found", neither is a URL, and TypeScript calls the result `string`
 * either way. That type lie is the opposite of what this module promises. A
 * `Map` only ever answers with what was put into it.
 */
const BUNDLED_LOGOS: ReadonlyMap<TenantLogoRef, string> = new Map<
  TenantLogoRef,
  string
>([
  // Neutral placeholders on purpose: what ships with the application must not
  // be any real organisation's mark. A tenant's own logo is uploaded.
  ['assets/beispiel-signet.svg', beispielSignetUrl],
  ['assets/beispiel-emblem.svg', beispielEmblemUrl],
]);

/**
 * The image URL for `logo`, or `undefined` when it resolves to nothing.
 * Callers fall back to the tenant name in PT Serif — a missing logo must never
 * leave the header empty.
 *
 * **The reference is re-checked even though a schema parsed it.** `isFileRef`
 * runs here as well, because what this function returns goes into an `src`
 * attribute, and „ein Schema hat es geprüft" is a statement about one code path
 * — a fixture, a hand-built object, a future caller that skipped the parse are
 * the others. The predicate is the shared one (`@formsache/shared`), never a second
 * spelling of the alphabet. Same posture as the asset arm, where the lookup
 * itself is the check.
 *
 * `API_BASE` rather than a literal `'/api'`: a prefix written twice stops
 * matching the day the mount point moves, and a logo that silently 404s is a
 * header that silently empties.
 */
export function resolveTenantLogo(logo: DeliverableLogo): string | undefined {
  if (logo === null) {
    return undefined;
  }

  if (logo.kind === 'upload') {
    // The route the server delivers logos from — `kind = 'tenant_logo'` is in
    // its `where`, so an attachment reference finds nothing there and answers
    // the same 404 an invented one does (ADR-0014 no. 11a). Encoded although
    // the alphabet has nothing to encode: escaping belongs to the place that
    // builds an address, not to an assumption about tomorrow's alphabet.
    return isFileRef(logo.ref)
      ? `${API_BASE}/public/files/${encodeURIComponent(logo.ref)}`
      : undefined;
  }

  // A `Map` only ever answers with what was put into it, so a reference that
  // is not a key answers `undefined` — including one off the prototype chain,
  // which an object literal would „find".
  return BUNDLED_LOGOS.get(logo.ref);
}
