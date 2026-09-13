/**
 * What a public address may consist of — the base64url alphabet a slug is
 * minted from (`forms.service.ts`), bounded well above the 22 characters one
 * actually has.
 *
 * Deliberately wider than 22: a longer bound keeps this a *sanity* check rather
 * than a second definition of the slug format, so changing the number of random
 * bytes does not silently 404 every existing address. What it is not allowed to
 * be is unbounded.
 *
 * **Both halves earn their place.** The length, because an unbounded string has
 * no business becoming a query parameter. The alphabet, because a percent-escape
 * is decoded before the application sees it: `%00` arrived as a NUL byte,
 * PostgreSQL refuses U+0000 inside `text`, and the query threw — a **500 where
 * every other unknown address answers 404**, which is exactly the probe this
 * closes, and exactly the kind of oracle this forbids.
 *
 * It lives in a module of its own because two call sites need it and they are
 * not in the same layer: the service refuses an address that cannot name a form,
 * and the rate limiter of the password gate uses it to decide whether a slug is
 * fit to key a counter by (`public-forms.rate-limit.ts`).
 */
const PUBLIC_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function isPublicSlug(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_SLUG_PATTERN.test(value);
}
