import { randomBytes } from 'node:crypto';

/**
 * The capability that opens **one** submitted answer for editing.
 *
 * ## Why a stored random value and not a signed token
 *
 * `SigningService` was right there, `AccessProofService` and
 * `StartTokenService` are both built on it, and adding a third
 * `SigningPurpose` would have been two lines. It is deliberately not what
 * happened, and the design says why in its first sentence: „ein zufälliges
 * Token (≥ 128 Bit, **wie der `public_slug`**)". A slug is a stored value, and
 * the difference to a signature is *revocation*.
 *
 * - A **stored** value is revoked by writing the column. One answer, one row,
 *   nothing else affected. That matters the day a participant forwards their
 *   confirmation mail to the wrong list, or the day the trash empties
 *   an answer: the capability disappears with the thing it pointed at, because
 *   it *was* part of that thing.
 * - A **signature** cannot be revoked individually at all. It carries its own
 *   validity, so the only lever is rotating the subkey — which invalidates every
 *   edit link of the whole installation at once. There is no middle ground, and
 *   „wir können das nicht zurücknehmen" is the wrong sentence to have to say
 *   about a link that opens somebody's personal data.
 *
 * There is a second reason, smaller but pointing the same way: a self-carrying
 * token has to name the response *inside itself*. The response id is a UUIDv7
 * and therefore time-ordered — putting one into an address strangers hold is
 * precisely the property `Form.publicSlug` exists to avoid.
 *
 * What the stored value costs is one column and one indexed lookup per access.
 * What it does **not** cost is state: the row exists already.
 *
 * ## Why it is stored raw
 *
 * `Session.tokenHash` keeps only a digest, and the reasoning there is sound: a
 * session token is only ever *compared*, so a dump cannot be replayed. This one
 * is different in one respect that decides it — the value has to be **rendered
 * again**. The confirmation page shows it, and the mail worker
 * re-builds a message body when it retries a delivery (ADR-0004, `umsetzungsplan-m2-etappe-c.md`: `mail_log` keeps no body). Out of a digest
 * it could not.
 *
 * **What that costs, stated correctly.** A dump grants *reading*. Raw tokens in
 * it turn that into **writing against the live installation**: somebody else's
 * registration changed over a public route, with no session, no tenant scope and
 * no trace beyond `edited_at`. Read → write is a real escalation, and it is the
 * price of this decision — not, as an earlier version of this comment claimed,
 * „no privilege the dump did not already grant".
 *
 * **The third option, and why it is not taken.** There is one besides digest and
 * raw, and this project already chose it once for exactly this problem: sealed
 * and readable again (`SecretBoxService`) — the access word is stored that way for the same „has to be rendered
 * again" reason. It is refused *here* because a sealed value cannot be looked up:
 * AEAD is non-deterministic, so `findUnique({ editToken })` would need a
 * deterministic blind index (HMAC) **beside** the sealed value, i.e. two columns
 * and two things that can disagree — and the *public* path would have to be able
 * to decrypt, which is precisely the reach `public-forms.module.ts` is built to
 * keep away from it (the requirement: the one door into `AccessWordModule` is a predicate, and `SecretBoxService` is lint-forbidden under `src/public/**`). Raw is the
 * lesser of the two, with the escalation above named as its price and the
 * database dump itself — not this column — as the thing to defend.
 */

/**
 * 16 bytes → 128 bits, base64url — the same size and the same alphabet as
 * `Form.publicSlug` (`forms.service.ts`), which is what this design asks for.
 * 22 characters, no padding, safe in a URL and in the body of a mail that a
 * client may re-wrap.
 */
const EDIT_TOKEN_BYTES = 16;

export function mintEditToken(): string {
  return randomBytes(EDIT_TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a value from a URL is *shaped* like an edit token — **not** whether
 * one exists.
 *
 * The same two-part guard `isPublicSlug` carries, for the same two reasons, and
 * the second one is the one that bites: a percent escape is decoded before the
 * application sees it, `%00` arrives as a NUL byte, PostgreSQL refuses U+0000
 * inside `text`, and the query throws — a **500 where every unknown token
 * answers 404**. That difference is exactly the oracle the single 404 of the
 * public routes exists to close.
 *
 * Bounded well above the 22 characters a real token has, so that changing the
 * number of random bytes does not silently 404 every link already in circulation
 * — this is a sanity check, not a second definition of the format.
 */
const EDIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function isEditToken(value: unknown): value is string {
  return typeof value === 'string' && EDIT_TOKEN_PATTERN.test(value);
}
