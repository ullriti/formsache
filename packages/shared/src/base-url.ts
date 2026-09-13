import { z } from 'zod';

import { safeExternalUrl } from './form-settings.ts';

/**
 * Where an installation — or one organisation of it — answers, seen from **outside**:
 * the origin every absolute link the server builds starts with.
 *
 * ## Why the server has to be told, and may not guess
 *
 * It did not always need to know: every public URL was assembled in the
 * browser out of `window.location.origin`, which is always right because the
 * browser is *standing* on the address. The edit link broke that — it
 * belongs on the confirmation page **and** in the confirmation mail, and a mail
 * has no `window`. A relative path in a mail is not a link.
 *
 * **Never from the request.** `Host` and `X-Forwarded-Host` are written by
 * whoever sends the request, so a link built from them is a link an outsider
 * chooses — and this one goes out by mail to a whole organisation, where it cannot be
 * recalled.
 *
 * ## Why this is its own module
 *
 * It used to live inside `apiEnvSchema`, because `PUBLIC_BASE_URL` was an
 * environment variable. The address moved into the database
 * (`system_setting.public_base_url`, and per organisation `tenant.public_base_url`), and
 * it is now read by two layers and written by a route. One predicate for all of
 * them: two spellings of „was ist eine Basis-Adresse?" would be two alphabets,
 * and the narrower one would be the one somebody forgets to update — the exact
 * shape of the `hexColorSchema` duplication.
 */

/**
 * The base address as everything downstream may assume it: absolute,
 * `http`/`https`, no query, no fragment, **no trailing slash** — or `null` when
 * the value is none of that.
 *
 * A function rather than something inline in the schema, because Zod runs a
 * refinement and a transform separately and both need the same answer.
 */
export function normaliseBaseUrl(raw: string): string | null {
  const absolute = safeExternalUrl(raw);
  if (absolute === null) {
    return null;
  }
  const parsed = new URL(absolute);
  if (parsed.search !== '' || parsed.hash !== '') {
    // Refused rather than trimmed: they cannot be part of a base address, and
    // silently discarding half of a configured value is how somebody ends up
    // debugging a link they did configure correctly, once.
    return null;
  }
  // `URL.href` always leaves a slash after a bare origin (`https://x` →
  // `https://x/`), and a path may or may not end in one. Dropping it here is
  // what lets `base + '/a/token'` be a plain concatenation everywhere else.
  return absolute.replace(/\/+$/, '');
}

/**
 * A base address as it travels and as it is stored — normalised on the way in,
 * so every reader may append a path by plain concatenation.
 *
 * It accepts a path (`https://organisation.example/forms`), so an installation
 * served under a sub-path works.
 */
export const baseUrlSchema = z
  .string()
  .min(1)
  .refine((raw) => normaliseBaseUrl(raw) !== null, {
    message:
      'must be an absolute http(s) base URL without query or fragment, e.g. https://formulare.example.org',
  })
  .transform((raw) => {
    const normalised = normaliseBaseUrl(raw);
    if (normalised === null) {
      // Unreachable: the refine above already rejected everything this answers
      // `null` for. Not a fallback — guessing a base address is how a dead link
      // ends up in somebody's inbox.
      throw new Error('base URL: refine and transform disagree');
    }
    return normalised;
  });
