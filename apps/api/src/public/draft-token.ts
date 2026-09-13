import { randomBytes } from 'node:crypto';

import { draftTokenSchema } from '@formsache/shared';

/**
 * The capability that opens **one** half-filled form.
 *
 * ## Why a stored random value and not a signed token
 *
 * The same question `edit-token.ts` answers, the same answer, and — worth saying
 * — the same *reason*, not merely the same shape. `SigningService` is right
 * there, a fourth `SigningPurpose` would be two lines, and it is deliberately
 * not what happened:
 *
 * - A **stored** value is revoked by writing this table. One draft, one row,
 *   nothing else affected. That is what makes Konzept no. 36 expressible at all: the
 *   moment a form goes behind the access word, the drafts of *that form* stop
 *   opening, in the same transaction as the settings write, and no other organisation's
 *   participant notices anything.
 * - A **signature** carries its own validity, so the only lever is rotating the
 *   subkey — which invalidates **every** draft and every edit link of the whole
 *   installation at once. There is no per-form middle ground, and „wir können
 *   das nicht zurücknehmen" is the wrong sentence to have to say about an
 *   address that hands out a form's full field definition without a session.
 *
 * The second reason points the same way and is smaller: a self-carrying token
 * has to name its row *inside itself*, and this row's id is a UUIDv7 —
 * time-ordered, i.e. precisely the property `Form.publicSlug` exists to avoid.
 *
 * ## Why it is stored raw, and why that argument is **weaker** here
 *
 * `Response.editToken` has to be raw for a reason that does not carry over: the
 * mail worker re-builds a message body when it retries a delivery and has no
 * token in hand, so out of a digest it could not render the link at all. There
 * is no mail here, and every place this address is rendered — the
 * answer to the first save, the answer to a continued one — happens inside a
 * request that already carries the token or has just minted it. **A digest
 * (`Session.tokenHash`'s shape) would therefore work**, and it would be strictly
 * better against a database dump.
 *
 * It is raw all the same, for one reason, stated as the trade it is: this is the
 * second of two participant capabilities on the same surface, revoked by the
 * same rule, resolved by the same kind of lookup — and two
 * mechanisms for one thing is what this project keeps removing. The price is the
 * one `edit-token.ts` names: a dump grants *reading*, and raw tokens turn that
 * into **writing** against the live installation over a public route. It is a
 * smaller escalation than the edit token's — a draft is not a filed answer and
 * holds nothing an organisation has recorded — but it is the same kind, and it is a
 * named open point rather than something this comment claims away.
 *
 * Sealed-and-readable (`SecretBoxService`) is refused here for
 * exactly the reason it is refused next door: AEAD is non-deterministic, so a
 * lookup would need a blind index **beside** the sealed value — two columns that
 * can disagree — and the public path would have to be able to decrypt, which is
 * the reach `public-forms.module.ts` is built to keep away from it.
 */

/**
 * 16 bytes → 128 bits, base64url — the same size and the same alphabet as
 * `Form.publicSlug` and `Response.editToken`, which is what * for („Größe und Alphabet wie `public_slug`"). 22 characters, no padding, and
 * short enough that somebody reading the address off one screen and typing it
 * into another gets to the end of it.
 */
const DRAFT_TOKEN_BYTES = 16;

export function mintDraftToken(): string {
  return randomBytes(DRAFT_TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a value is *shaped* like a draft token — **not** whether one exists.
 *
 * The guard `isPublicSlug` and `isEditToken` carry, for the same two reasons,
 * and the second is the one that bites: a percent escape is decoded before the
 * application sees it, `%00` arrives as a NUL byte, PostgreSQL refuses U+0000
 * inside `text`, and the query throws — a **500 where every unknown token
 * answers 404**, which is exactly the oracle the single 404 of the public routes
 * exists to close.
 *
 * **The rule itself comes from `@formsache/shared`** rather than from a pattern of its
 * own, and that is the one thing this function does differently from its two
 * neighbours: this token also travels in a **body**
 * (`submitResponseRequestSchema.draftToken`), where the wire schema is what
 * bounds it. Two spellings of „ist das überhaupt ein Token" — one for the path,
 * one for the body — would be two answers to one question, and the route that
 * gets the looser one is the route nobody tested.
 */
export function isDraftToken(value: unknown): value is string {
  return draftTokenSchema.safeParse(value).success;
}
