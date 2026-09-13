import { Injectable } from '@nestjs/common';

import {
  SigningService,
  type SigningPurpose,
} from '../common/secret-box/signing.service';

/**
 * The signed start token of the requirement.
 *
 * Reading a public form mints one; submitting hands it back. The server then
 * knows when the attempt began **because it said so itself**, and refuses a
 * submission that took longer than `timeLimitMin`.
 *
 * ## The shape, and why each part is in it
 *
 *     s1.<issued-at, base36 ms>.<base64url HMAC>
 *      ^        ^                     ^
 *      |        |                     over „s1.<issued-at>\0<slug>"
 *      |        the instant the read happened, in Unix milliseconds
 *      format version — implies the signing purpose and this layout
 *
 * - **The instant travels in the token, not in a server-side row.** There is no
 *   per-attempt state to hang it on: `response_draft` is a separate concern, and inventing one
 *   here would be that table under another name. A signed instant is the same
 *   fact without the storage.
 * - **The slug is signed but not carried.** It binds the token to one form —
 *   a token minted on an open form cannot be replayed against a closed one —
 *   while keeping it out of the string, so the token says nothing a reader did
 *   not already have. The NUL separator cannot occur in a slug (CSPRNG
 *   base64url), so the two parts of the signed message cannot be shifted into
 *   each other.
 * - **Nothing else is in it.** Not `timeLimitMin`, not the form id, not a
 *   counter. The limit is read from the settings at *submission* time, so an
 *   editor who shortens it does not have to wait for old tokens to age out, and
 *   a token cannot claim its own allowance.
 *
 * ## The gap that is part of the requirement, not a footnote
 *
 * **Reloading the page mints a new token and therefore grants new time.** That
 * is decided and stated where the editor sets the
 * switch, not only here: without saving a draft there is nothing a
 * fill-in session could hang on, so the time limit is a promise to the honest
 * participant („nimm dir 30 Minuten"), not a barrier against the dishonest one.
 * Everything that *is* a barrier — the deadline, the response limit — is
 * enforced independently and is never replaced by this.
 */

const PURPOSE: SigningPurpose = 'public.start-token';

/**
 * Format version. Bumping it invalidates every token in flight, which costs a
 * reload — the reason the layout can be changed freely, unlike the sealed
 * values of `secret-box.service.ts`.
 */
const VERSION = 's1';

/** Version, instant, signature. */
const PART_COUNT = 3;

/** Base 36, so a millisecond instant is eight characters instead of thirteen. */
const RADIX = 36;

/**
 * Separates the token body from the form it belongs to inside the signed
 * message. See the note above — a slug cannot contain it.
 */
const BINDING_SEPARATOR = '\u0000';

@Injectable()
export class StartTokenService {
  constructor(private readonly signing: SigningService) {}

  /**
   * A token for an attempt on `slug` that began at `issuedAt`.
   *
   * `issuedAt` is a parameter rather than `new Date()` inside, for the reason
   * every other clock in this codebase is passed in (`availabilityOf`): a test
   * has to be able to stand on a boundary, and a stale token has to be
   * producible without waiting for one to become stale.
   */
  issue(slug: string, issuedAt: Date = new Date()): string {
    const body = `${VERSION}.${issuedAt.getTime().toString(RADIX)}`;
    return `${body}.${this.signing.sign(PURPOSE, this.message(body, slug))}`;
  }

  /**
   * When the attempt behind `token` began, or `null`.
   *
   * `null` covers **every** way a token can fail to be one of ours — malformed,
   * an unknown version, an unparseable instant, a forged signature, a valid
   * signature for a different form. The caller must not tell them apart in what
   * it answers: a refusal that distinguished „falsche Signatur" from „zu alt"
   * would be an oracle on the MAC, and a participant cannot act on the
   * difference anyway.
   *
   * The signature is verified **before** the instant is believed. That order is
   * the whole point of the requirement: the content is not trusted, it is
   * checked.
   */
  issuedAt(token: string, slug: string): Date | null {
    const parts = token.split('.');
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
    // insists the whole part round-trips, so a token whose instant was edited
    // fails here even in the impossible case that it also verified.
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
