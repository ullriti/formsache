import { z } from 'zod';

import { smtpBlockSchema } from './mail-config.ts';

/**
 * **The reply-to address — a value of its own beside the SMTP block, not inside it**.
 *
 * ## Why it does not belong in the block
 *
 * The block is indivisible because it carries a **secret** (`mail-config.ts`):
 * whoever does not have the password to hand cannot rewrite it, and an
 * installation without a mail server has no block at all for anything to fit
 * into. A reply-to address is not a secret and hangs on no
 * SPF/DKIM authorisation: it stands *in the body* of the mail and only says where
 * an answer is to go. Were it inside the block, it would not be changeable
 * without the SMTP password — and on an installation without a mail server not
 * settable at all.
 *
 * That is the same separation ADR-0013 no. 3 already draws for the **base address**,
 * and this module therefore deliberately stands beside `base-url.ts` instead of in
 * `mail-config.ts`.
 *
 * ## The inheritance, and that there is only one
 *
 * Three levels, from top to bottom: **notification → organisation → system**. The
 * first one set wins; if none is set, the mail goes out **without** the header
 * (see {@link effectiveReplyTo}). The same shape
 * `PublicUrlService.resolveBaseUrl` has for the base address — a chain that
 * stands in exactly one place and that no caller may shortcut.
 */

/**
 * A reply-to address, checked — **the same check the sender address
 * has**, and literally the same one.
 *
 * Not `z.email()` written out a second time, but the `from` field of the
 * block: a second version would be a second opinion about what „eine
 * nackte Adresse, nie `Name <adresse>`" means — and the copy that drifts
 * is always the one that stands further from the original (`CONTRIBUTING.md`). It
 * thereby also holds what applies to the sender address: `Max <evil@example.com>`,
 * `a@b.de, c@d.de` and anything with CR/LF is refused, so that no value
 * can become a second SMTP header.
 */
export const replyToAddressSchema = smtpBlockSchema.shape.from;

/**
 * Whether a **stored** value is unusable — set, but not an address.
 *
 * The difference from „nicht gesetzt" is the whole purpose: `null`, `undefined`
 * and a field holding nothing but spaces are *no* entry and
 * deserve no report; `geschaeftsstelle@example` is an entry that does not
 * keep what it promises. {@link effectiveReplyTo} treats both alike —
 * it falls through —, and precisely for that reason the second case needs somebody
 * who *notices* it: otherwise all of an installation's mails go out without the
 * header, nothing stands in the log, and in the surface the address
 * still stands in the field.
 *
 * Only the predicate stands here. Who reports — and how often — is decided by the
 * side that reads a column (`SystemMailSettingsService`); no second
 * version of the question „ist das eine Adresse?" arises in doing so, because both
 * ask the same {@link replyToAddressSchema}.
 */
export function isUnusableReplyTo(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim() === '') {
    return false;
  }
  return !replyToAddressSchema.safeParse(value).success;
}

/**
 * **Which level of the chain has won** (the requirement).
 *
 * The three levels of Konzept no. 67, named instead of counted. An index would be the
 * cheaper answer and the wrong one: it only holds as long as every caller
 * assembles the same chain at the same length — and the test mail assembles
 * *two* levels, the public sending path *three*. „Ebene 1" would then mean
 * different things in two places, and the origin would be a calculation of the
 * caller instead of a statement of the chain.
 *
 * The fourth case — „keine" — is not a value of this enumeration but the
 * `null` in {@link effectiveReplyToSchema}: it does not say *which* level applies
 * but that none applies.
 */
export const replyToOriginSchema = z.enum(['notification', 'tenant', 'system']);
export type ReplyToOrigin = z.infer<typeof replyToOriginSchema>;

/**
 * One level of the chain, as {@link effectiveReplyTo} takes it in: the
 * raw column value **with its origin**.
 *
 * `undefined` is permitted here and not on the wire ({@link
 * replyToLevelSchema}): on the server side there is sometimes a field at the end of a
 * chain that a projection did not load at all, and that is the same as
 * „nicht gesetzt". JSON does not know the difference, so it does not exist there
 * either.
 */
export interface ReplyToLevel {
  readonly origin: ReplyToOrigin;
  readonly value: string | null | undefined;
}

/**
 * One level as it stands **on the wire** — the two *inherited* levels
 * of a notification list (the requirement, `notificationListResponse
 * Schema`).
 *
 * **Raw, not evaluated, and that is the purpose.** The editor answers
 * „was gilt, wenn ich *dieses* Feld so speichere?" — a question about a
 * draft the server does not know. To do so it puts the topmost level in front
 * itself and calls {@link effectiveReplyTo}, that is, **the same** function the
 * server uses; no second chain arises in doing so. Were it given
 * a finished result instead, it would have to rebuild the precedence rule in order to
 * work the draft in — and that is exactly the copy that drifts.
 *
 * **`undefined` does not exist here** (see {@link ReplyToLevel}), and an
 * unusable value is deliberately *not* refused: it stands in a
 * `text` column, the chain lets it fall through, and a list that could not be
 * loaded because of it would take away from the editor the very page on which the
 * error would be visible.
 */
export const replyToLevelSchema = z.strictObject({
  origin: replyToOriginSchema,
  value: z.string().nullable(),
});

/**
 * The effective value **and its origin** — the result of the chain, and the
 * shape in which it stands on the wire (read document of the notification,
 * the requirement).
 *
 * **Both fields or neither.** `origin` is `null` exactly when `address`
 * is: „keine Ebene hat etwas beigetragen". An address without an origin would leave
 * the question that produced this field in the first place — *why this one?* —
 * unanswered.
 *
 * **Two alternatives instead of two independently nullable fields**, since the
 * review of package 0-A. A `strictObject` with `address: string | null` and
 * `origin: ReplyToOrigin | null` *asserted* the sentence above and let
 * `{ address: 'a@b.de', origin: null }` through — a combination the
 * chain never produces but that nobody refused. Worse than the parse was the
 * reader: the editor checked `address === null || origin === null` and displayed
 * „keine" for exactly this combination — so a real reply-to address would have been
 * **kept silent about** instead of standing out.
 *
 * A `.refine()` check would have repaired the parse and left the *type*
 * wide; every reader would still have to check both fields, and the same error
 * would again be available to the next reader. As a pair of alternatives
 * the impossible combination is **not representable**: TypeScript narrows at
 * `address === null` to the case without an origin, and the check that produced
 * the error is no longer there to be written.
 */
export const effectiveReplyToSchema = z.union([
  z.strictObject({ address: z.string(), origin: replyToOriginSchema }),
  z.strictObject({ address: z.null(), origin: z.null() }),
]);
export type EffectiveReplyTo = z.infer<typeof effectiveReplyToSchema>;

/**
 * The **effective** value of a chain of levels — the first one that carries a
 * usable address, otherwise `null` —, **together with the level that contributed it**.
 *
 * ⚠️ **The order of the array decides; `origin` only labels.**
 * Since the levels carry names, this easily reads the other way round — as if
 * `notification` took precedence over `tenant` because that is what it is called. It does
 * not: this function runs from front to back and knows no rank. Whoever assembles
 * the chain thereby sets the precedence (notification → organisation → system) — and that is why it arises in exactly two places
 * (`SystemMailSettingsService.replyToDefaults` for the two lower levels,
 * and the caller who puts its topmost one in front).
 *
 * ## Why the origin comes out here and not at the caller
 *
 * It is not a second calculation but the same one: whoever determines it alongside
 * („das Feld der Benachrichtigung ist gesetzt, also gilt es") writes the
 * chain a second time — and the copy does not know the second gate at which a
 * *set but unusable* value falls through. It would then say `notification`
 * about a mail that carries the organisation's address. Exactly this piece of information is the
 * purpose of the field, so it arises where the decision is made.
 *
 * ## Why `null` and not the sender address, and why certainly not a
 * refusal
 *
 * Konzept no. 67 calls `Reply-To` „erforderlich"; what is required is thereby that
 * **there is always an effective value** — and here that is expressly also
 * „keine Kopfzeile". The two alternatives are worse:
 *
 * - **Refusing to send** would mean that an installation that has never
 *   filled in the system default no longer sends any confirmation. A
 *   missing reply-to address is no reason to hold back a promised
 *   mail — that would be the most expensive conceivable way of making a field
 *   mandatory.
 * - **The sender address as a fallback** is *by RFC 5322 exactly what
 *   happens anyway without the header*: if `Reply-To` is missing, every
 *   mail client replies to `From`. Setting the header would change nothing about the result
 *   and would additionally assert a decision nobody has made —
 *   and it would assert it, of all things, with the address of the *installation*
 *   when the organisation sends over the system.
 *
 * So: no header. The difference is measurable on the sent header and is
 * measured there (`apps/api/test/mail/reply-to.spec.ts`).
 *
 * ## Checking happens on the way **out**, not only on the way in
 *
 * All three levels lie in ordinary `text` columns, and a value can reach them
 * past the API (a hand-written row, an old
 * migration). A stored value that is not an address therefore counts like
 * one that is not set: the chain **falls through** to the next level. The same
 * second gate that `SystemMailSettingsService.publicBaseUrl` and
 * `PublicUrlService.resolveBaseUrl` set up for the base address — and the
 * fail-closed direction, because an unusable header would go out to a whole
 * organisation and could not be recalled.
 */
export function effectiveReplyTo(
  levels: readonly ReplyToLevel[],
): EffectiveReplyTo {
  for (const level of levels) {
    if (level.value === null || level.value === undefined) {
      continue;
    }
    const parsed = replyToAddressSchema.safeParse(level.value);
    if (parsed.success) {
      return { address: parsed.data, origin: level.origin };
    }
  }
  return { address: null, origin: null };
}
