/**
 * The public addresses of this application, spelled **once** .
 *
 * Two consumers need the same string and they sit on opposite sides of the
 * wire:
 *
 * - the browser routes on it (`apps/web/src/router/routes.ts`), and
 * - the **server** has to build an absolute link out of it — for the
 *   confirmation answer and, since mail delivery needs one too, for a mail
 *   (`apps/api/src/common/public-url/public-url.service.ts`).
 *
 * Until then, the second consumer did not exist: every public URL was assembled in
 * the browser from `window.location.origin`, which is a source a mail does not
 * have. That is why the path lives here rather than in the router — a second
 * spelling in the API would be a link that goes somewhere else the day somebody
 * renames the route, and the failure would show up in a stranger's inbox where
 * it cannot be taken back.
 *
 * **Paths only, never a host.** Which host the application answers under is a
 * deployment question and comes from `PUBLIC_BASE_URL`; putting it here would
 * bake one installation's domain into a package the browser also ships.
 */

/** First segment of a published form's public address (`/f/<slug>`). */
export const PUBLIC_FORM_SEGMENT = 'f';

/**
 * First segment of the edit address of one submitted answer (`/a/<token>`).
 *
 * Short like `/f/`, and for the same reason: this address is written into a
 * confirmation page and into an e-mail, where it is read, retyped and wrapped by
 * mail clients. `a` for *Antwort*.
 */
export const RESPONSE_EDIT_SEGMENT = 'a';

/**
 * First segment of the address a half-filled form is continued under
 * (`/e/<token>`).
 *
 * Short like `/f/` and `/a/`, and for a reason this one has more of than the
 * other two: nothing mails this address. The participant reads it off the
 * screen and copies it — or, on a second device, types it — so every character
 * is one somebody has to get right by hand. `e` for *Entwurf*.
 *
 * A segment of its own rather than `/a/` with a second kind of token behind it:
 * the two capabilities open different things (a submitted answer against its
 * own snapshot, a draft that is not an answer at all), they live in different
 * tables, and one route resolving two token populations would have to answer
 * „welche Sorte war das?" before it could answer anything else.
 */
export const RESPONSE_DRAFT_SEGMENT = 'e';

/**
 * First segment of the address under which a reset link is redeemed
 * (`/password/<token>`, ADR-0020).
 *
 * Written out and not shortened to a single letter like `/f/`, `/a/` and
 * `/e/`: those three are addresses somebody types out or reads aloud, this one
 * is exclusively **clicked** — it stands in exactly one mail and
 * nowhere else. What counts here is the opposite of brevity: whoever sees the link in
 * their mailbox should recognise without instruction what it is about.
 *
 * ⚠️ **English, like every other path of this application**
 * (Review-Runde 4 Nr. 8): „URL Pfade enthalten deutsche Namen (Einladung,
 * Verwaltung, ueberwachung, …). Das widerspricht massiv der Vorgabe." Sie
 * hieß bisher `passwort`. Die Umstellung ist ein **harter Schnitt** ohne
 * Weiterleitung — die Begründung dazu, und was das für bereits verschickte
 * Links heißt, steht in `apps/web/src/router/routes.ts`.
 *
 * A segment of its own and not `/a/` with a second kind of token behind it —
 * the same reasoning as with {@link RESPONSE_DRAFT_SEGMENT}: the two open
 * different things, live in different tables, and a route that resolves two
 * token populations would have to answer „welche Sorte war das?" before
 * it could answer anything at all.
 */
export const PASSWORD_RESET_SEGMENT = 'password';

/**
 * Site-relative address under which a reset link is redeemed.
 *
 * The token is the whole capability: it names no account, no organisation
 * and no address, and the server resolves it over the hash of itself
 * (`apps/api/src/auth/password-reset/password-reset-token.ts`).
 */
export function passwordResetPath(token: string): string {
  return `/${PASSWORD_RESET_SEGMENT}/${encodeURIComponent(token)}`;
}

/**
 * First segment of the address under which an **invitation** is redeemed
 * (`/invitation/<token>`, ADR-0024).
 *
 * ## Why a second segment and not {@link PASSWORD_RESET_SEGMENT}
 *
 * The server does **not** distinguish the two links: they live in the same
 * table, carry the same capability and are redeemed over the same route
 * (`POST /api/auth/password-reset/confirm`). What differs is
 * exclusively the **sentence** the page says — and „Neues Passwort
 * vergeben" is simply wrong for somebody who has never had one.
 *
 * The alternative would be a route that reveals, for a token, which kind it
 * is. For good reason there is none (ADR-0020: no `GET` on a token),
 * so the information has to come out of the address — and an address that only
 * determines the heading reveals nothing: whoever rewrites it by hand to `/password/`
 * gets the same page with different words and the same answer
 * from the server.
 */
export const ACCOUNT_INVITATION_SEGMENT = 'invitation';

/**
 * Site-relative address under which an invitation is redeemed.
 *
 * Like {@link passwordResetPath}: the token is the whole capability, it names
 * no account, no organisation and no address.
 */
export function accountInvitationPath(token: string): string {
  return `/${ACCOUNT_INVITATION_SEGMENT}/${encodeURIComponent(token)}`;
}

/** Site-relative path of a published form. */
export function publicFormPath(slug: string): string {
  return `/${PUBLIC_FORM_SEGMENT}/${encodeURIComponent(slug)}`;
}

/**
 * Site-relative path under which a participant may change their own answer.
 *
 * The token is the whole capability — it is the random value stored on the
 * response row, not an id and not a signature over one, so this path names no
 * form, no organisation and no response (`apps/api/src/public/edit-token.ts`).
 */
export function responseEditPath(token: string): string {
  return `/${RESPONSE_EDIT_SEGMENT}/${encodeURIComponent(token)}`;
}

/**
 * Site-relative path under which a participant continues their own half-filled
 * form.
 *
 * The token is the whole capability, exactly as it is for the edit address: a
 * stored random value on the draft's own row, not an id and not a signature
 * over one (`apps/api/src/public/draft-token.ts`), so this path names no form,
 * no organisation and no draft.
 */
export function responseDraftPath(token: string): string {
  return `/${RESPONSE_DRAFT_SEGMENT}/${encodeURIComponent(token)}`;
}
