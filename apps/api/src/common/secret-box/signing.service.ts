import { Inject, Injectable } from '@nestjs/common';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

import { SECRET_BOX_KEY } from './secret-box-key';

/**
 * HMAC-SHA256 over short-lived, server-issued strings — today the start token
 * of the requirement.
 *
 * ## Why this hangs off `SECRET_BOX_KEY` and does not bring its own variable
 *
 * A signing key is key material like any other, so the honest options were a
 * second environment variable (`START_TOKEN_KEY`) or a derivation from the one
 * that already exists. The derivation wins on three counts:
 *
 * 1. **Operations.** A second required secret is a second thing to generate, to
 *    carry into `.env.example`, `docker-compose.yml` and the test app, to rotate
 *    and to lose. `docs/kb/04-build-run.md` already records how easily a `.env`
 *    and `.env.example` drift apart — and the failure mode of a *missed*
 *    variable is the expensive one: it runs silently on a default.
 * 2. **Blast radius.** Losing the signing key costs nothing: every start token
 *    lives for minutes, and a rotation makes participants reload. Losing
 *    `SECRET_BOX_KEY` costs every stored access word. Tying the cheap thing to
 *    the expensive one is only acceptable **because the derivation is one-way**
 *    — see below.
 * 3. **Key separation is kept, not dropped.** The raw key is never used as an
 *    HMAC key. Each purpose gets its own 32-byte subkey through HKDF-SHA256
 *    with a purpose-specific `info` string, so the signing key and the AES key
 *    are computationally unrelated: a subkey that leaked reveals nothing about
 *    `SECRET_BOX_KEY`, and two purposes can never produce the same subkey.
 *    Signing with the encryption key directly — reusing one key across two
 *    primitives — is the thing this avoids.
 *
 * ## What it deliberately is not
 *
 * It is **not** the session mechanism and not an authorisation. A start token
 * says „this attempt began at this instant, on this form, and we said so"; it
 * grants nothing. Rate limits, the deadline and the response limit all keep
 * applying to a request that carries a perfectly valid one.
 */

/**
 * The purposes a subkey exists for.
 *
 * A union rather than a free string: every purpose is a separate key, and a
 * typo would silently mint a new one instead of failing. Adding a member is the
 * deliberate act of introducing a second signed artefact.
 */
export type SigningPurpose =
  | 'public.start-token'
  /** The access proof a passed password gate hands out. */
  | 'public.access-proof'
  /**
   * **Not a signature that travels** — the MAC the access word is *compared*
   * through (third bullet).
   *
   * Two plaintext words of different lengths cannot be compared in constant
   * time: `timingSafeEqual` throws unless the buffers match, and the length
   * check in front of it would leak the length of the stored word to anyone
   * with a stopwatch. Running both through this subkey first turns the
   * comparison into one over two 43-character strings, which is the shape
   * `timingSafeEqual` is actually constant over.
   *
   * Its own purpose rather than the proof's, because the two do different
   * things with different inputs: one MACs a string this server wrote, the
   * other MACs a string a stranger sent. Sharing a subkey between them would
   * mean a value crafted for one is a valid input to the other.
   */
  | 'public.access-word'
  /**
   * **The reset link of „Passwort vergessen"** (ADR-0020) — and the one
   * signature of this application that does *not* travel along but is
   * **reconstructed**.
   *
   * What is signed is the id of the `password_reset` row; the result is the
   * token in the link. Of that, the database knows only the SHA-256, and the sending
   * rebuilds the value at the moment of delivery — which keeps it out of
   * `mail_log.body_text`, a column that the mail log of an Organisation
   * displays.
   *
   * A purpose of its own and not that of the start token: the one names an
   * attempt and grants nothing, this one **is** the authority over an
   * account. A shared subkey would mean that a value produced for the one
   * is a valid input to the other.
   */
  | 'auth.password-reset';

/**
 * Every purpose, as a **record over the union** — so that forgetting one is a
 * compile error rather than a 500 on a public route.
 *
 * A `readonly SigningPurpose[]` does not have to exhaust the union: adding a
 * member to `SigningPurpose` and not to the list compiled cleanly and blew up
 * at the first `sign()` of the new purpose — on the public fill-in path, where
 * the password proof and the edit token plug in. `satisfies Record<…, true>`
 * refuses both mistakes at once: a missing key fails the constraint, an extra
 * one fails the excess-property check.
 */
const SIGNING_PURPOSE_KEYS = {
  'public.start-token': true,
  'public.access-proof': true,
  'public.access-word': true,
  'auth.password-reset': true,
} as const satisfies Record<SigningPurpose, true>;

// Safe: the object above is a literal constrained to exactly the members of
// `SigningPurpose`, so its keys are that union and nothing else. Same pattern
// and same reason as `keysOf` in `packages/shared/src/form-settings.ts`.
const SIGNING_PURPOSES = Object.keys(
  SIGNING_PURPOSE_KEYS,
) as readonly SigningPurpose[];

/** Domain separation of the whole scheme, versioned with it. */
const HKDF_INFO_PREFIX = 'formsache.signing.v1.';

/** HMAC-SHA256 takes any length; 32 bytes matches the output size. */
const SUBKEY_BYTES = 32;

@Injectable()
export class SigningService {
  /**
   * One subkey per purpose, derived **eagerly in the constructor**.
   *
   * Eager, so that the raw key can be dropped here rather than kept as a field:
   * the only key material this object holds afterwards is a set of subkeys that
   * cannot be turned back into it. That is what makes the module boundary
   * meaningful — `SecretBoxModule` exports this service to the public fill-in
   * module, and what travels with it is not the key.
   */
  private readonly subkeys: ReadonlyMap<SigningPurpose, Buffer>;

  constructor(@Inject(SECRET_BOX_KEY) key: Buffer) {
    this.subkeys = new Map(
      SIGNING_PURPOSES.map((purpose) => [
        purpose,
        Buffer.from(
          hkdfSync(
            'sha256',
            key,
            // No salt. HKDF's salt adds nothing when the input keying material
            // is already 256 bits of CSPRNG output; the `info` string is what
            // separates the purposes, and it is not optional.
            Buffer.alloc(0),
            `${HKDF_INFO_PREFIX}${purpose}`,
            SUBKEY_BYTES,
          ),
        ),
      ]),
    );
  }

  /** base64url MAC over `message`, under the subkey of `purpose`. */
  sign(purpose: SigningPurpose, message: string): string {
    return createHmac('sha256', this.subkeyOf(purpose))
      .update(message, 'utf8')
      .digest('base64url');
  }

  /**
   * Whether `signature` is one this application produced for `message`.
   *
   * Compared with {@link timingSafeEqual} rather than `===`: the caller is a
   * stranger on a public route who may try as often as the rate limit allows,
   * and a byte-by-byte early exit is the classic way a MAC is forged one
   * character at a time. The length check in front of it leaks only the length
   * of a value the sender wrote themselves.
   */
  verify(purpose: SigningPurpose, message: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(purpose, message), 'utf8');
    const offered = Buffer.from(signature, 'utf8');
    if (expected.length !== offered.length) {
      return false;
    }
    return timingSafeEqual(expected, offered);
  }

  private subkeyOf(purpose: SigningPurpose): Buffer {
    const subkey = this.subkeys.get(purpose);
    if (subkey === undefined) {
      // Unreachable: `SIGNING_PURPOSES` is derived from a record over the very
      // union this parameter has, so the compiler — not a test — is what keeps
      // the map complete. Kept as a throw rather than a `!`, because an empty
      // buffer here would sign with nothing and still look like a signature.
      throw new Error(`no signing subkey for purpose ${purpose}`);
    }
    return subkey;
  }

  /**
   * Keeps the subkeys out of anything that prints this object — the same two
   * hooks and the same reasoning as `SecretBoxService`: `util.inspect` ignores
   * `toJSON`, and `JSON.stringify` ignores the inspect hook.
   */
  toJSON(): Record<string, string> {
    return { subkeys: '[redacted]' };
  }

  [inspect.custom](): string {
    return 'SigningService { subkeys: [redacted] }';
  }
}
