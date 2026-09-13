import { Injectable } from '@nestjs/common';

import {
  SigningService,
  type SigningPurpose,
} from '../common/secret-box/signing.service';

/**
 * The proof a participant holds after passing the password gate
 * (last paragraph: „signiert, formular-gebunden und
 * kurzlebig").
 *
 * Built exactly like `start-token.service.ts` next door, on purpose — the two
 * are the same kind of artefact, and a second layout would be a second thing to
 * review:
 *
 *     p1.<issued-at, base36 ms>.<base64url HMAC>
 *      ^        ^                     ^
 *      |        |                     over „p1.<issued-at>\0<slug>"
 *      |        the instant the gate was passed, in Unix milliseconds
 *      format version — implies the signing purpose and this layout
 *
 * - **Signed.** Nothing about the string is believed before the MAC verifies.
 *   The order matters and is the whole point of the design: the content is
 *   not trusted, it is checked.
 * - **Form-bound, by signing the slug rather than carrying it.** A proof minted
 *   for one form does not verify against another, and the binding cannot be
 *   edited because it is not in the string. The NUL separator cannot occur in a
 *   slug (`public-slug.ts`), so the two halves of the signed message cannot be
 *   shifted into each other.
 * - **Short-lived**, see {@link PROOF_LIFETIME_MS}.
 *
 * ## What it is not
 *
 * It is **not** an authorisation, and the fill-in path is written so that it
 * cannot become one. Holding a proof gets a participant the questions; it does
 * not open a form that has closed, does not create a place in a full one and
 * does not extend a time limit. Those are checked on every request that carries
 * it (`public-forms.service.ts`), which is the technical form of the sentence:
 * das Wort ist eine Hürde, keine Autorisierung.
 *
 * It also carries no identity. There are no participant accounts,
 * so there is nobody to name — the proof says „someone knew the word for this
 * form at this instant" and nothing else. Two people who were given the same
 * word are indistinguishable to it, which is what a shared word means.
 */

const PURPOSE: SigningPurpose = 'public.access-proof';

/**
 * Format version. Bumping it invalidates every proof in flight, which costs the
 * participants who hold one a second look at the word — the same cheap failure
 * the start token's version bump has.
 */
const VERSION = 'p1';

/** Version, instant, signature. */
const PART_COUNT = 3;

/** Base 36, so a millisecond instant is eight characters instead of thirteen. */
const RADIX = 36;

/** @see start-token.service.ts — a slug cannot contain it. */
const BINDING_SEPARATOR = '\u0000';

const MINUTE_MS = 60_000;

/**
 * How long a proof opens its form — **one hour**.
 *
 * The number is a compromise between two failures, and neither of them is
 * hypothetical:
 *
 * - Too short and a participant who was let in, went through four pages of a
 *   Jahrestagung registration and pressed „Absenden" is refused with
 *   `password_required` and has to type everything again. That is the failure
 *   that costs an organisation actual registrations.
 * - Too long and the proof becomes a second, weaker copy of the word: something
 *   that can be forwarded, that outlives the reason it was handed out, and that
 *   an editor cannot revoke by changing the word.
 *
 * An hour is far above the longest time limit an editor is likely to set (the
 * schema caps `timeLimitMin` at a day, the prototype's example is 30 minutes)
 * and far below the weeks a registration period runs. It is „kurzlebig" measured
 * against the thing it stands in for: the word itself lives as long as the
 * registration does.
 */
const PROOF_LIFETIME_MS = 60 * MINUTE_MS;

/**
 * How far a proof may claim to come from the *future* before it stops counting.
 *
 * Same value and same reasoning as the start token's grace: a proof can only
 * carry this server's own signature, so the only way to hold one from the future
 * is a clock that moved, and punishing a participant for that would be the wrong
 * end of the problem. Finite, because „negative age always passes" would mean
 * two replicas with drifted clocks silently stop expiring proofs at all.
 */
const CLOCK_SKEW_GRACE_MS = 5 * MINUTE_MS;

@Injectable()
export class AccessProofService {
  constructor(private readonly signing: SigningService) {}

  /**
   * A proof that the gate of `slug` was passed at `issuedAt`.
   *
   * `issuedAt` is a parameter rather than `new Date()` inside, for the same
   * reason every other clock in this codebase is passed in: a test has to be
   * able to produce an expired proof without waiting an hour for one.
   */
  issue(slug: string, issuedAt: Date = new Date()): string {
    const body = `${VERSION}.${issuedAt.getTime().toString(RADIX)}`;
    return `${body}.${this.signing.sign(PURPOSE, this.message(body, slug))}`;
  }

  /**
   * Whether `proof` is a live proof for `slug`.
   *
   * `false` covers **every** way it can fail to be one — absent, malformed, an
   * unknown version, an unparseable instant, a forged signature, a valid
   * signature for a different form, and simply too old. The caller must not tell
   * them apart: a refusal that distinguished „falsche Signatur" from „abgelaufen"
   * would be an oracle on the MAC, and a participant cannot act on the
   * difference — the answer to all of them is to enter the word again.
   */
  holds(proof: string | undefined, slug: string, now: Date): boolean {
    if (proof === undefined) {
      return false;
    }
    const issuedAt = this.issuedAt(proof, slug);
    if (issuedAt === null) {
      return false;
    }
    const ageMs = now.getTime() - issuedAt.getTime();
    return ageMs >= -CLOCK_SKEW_GRACE_MS && ageMs <= PROOF_LIFETIME_MS;
  }

  /** When the gate behind `proof` was passed, or `null`. @see holds */
  private issuedAt(proof: string, slug: string): Date | null {
    const parts = proof.split('.');
    if (parts.length !== PART_COUNT) {
      return null;
    }
    // The defaults are unreachable — the length is checked above — and exist
    // only so `noUncheckedIndexedAccess` does not widen these to `undefined`.
    const [version = '', instant = '', signature = ''] = parts;
    if (version !== VERSION) {
      return null;
    }

    const body = `${version}.${instant}`;
    if (!this.signing.verify(PURPOSE, this.message(body, slug), signature)) {
      return null;
    }

    // Only now is the payload read. `parseInt` would accept „12xyz"; this
    // insists the whole part round-trips, so an instant that was edited fails
    // here even in the impossible case that it also verified.
    const milliseconds = Number.parseInt(instant, RADIX);
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds.toString(RADIX) !== instant
    ) {
      return null;
    }
    return new Date(milliseconds);
  }

  private message(body: string, slug: string): string {
    return `${body}${BINDING_SEPARATOR}${slug}`;
  }
}
