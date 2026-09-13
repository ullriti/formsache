import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { inspect } from 'node:util';

import { SECRET_BOX_KEY } from './secret-box-key';

/**
 * **AES-256-GCM**, from `node:crypto`. Two properties decide it:
 *
 * 1. It is an **AEAD**. `open()` has to *detect* a modified stored value and
 *    throw, not hand back plausible-looking rubbish. Without authentication,
 *    anyone able to write the JSONB column could flip bits in the ciphertext
 *    and steer the decrypted access word — a stream cipher gives that away for
 *    free. GCM's tag makes any change a failure.
 * 2. It is in the platform. No dependency, no native build, and the parameters
 *    below are the ones NIST SP 800-38D specifies rather than a library's
 *    defaults (`CONTRIBUTING.md`: justify dependencies, prefer the platform).
 *
 * **Not** a password hash: the access word is a *shared* word an editor has to
 * be able to read out and pass on (decision of 2026-07-27).
 * That requirement rules out Argon2id, which is what `apps/api/src/auth`
 * rightly uses for the thing this is not — a user credential.
 */
const ALGORITHM = 'aes-256-gcm';

/**
 * 96 bits, the size GCM is defined for; anything else makes the mode derive
 * the counter block through GHASH instead of using the nonce directly, which
 * is slower and buys nothing. Freshly random per `seal()` — never a counter,
 * because rows get copied (a form that switches its *Zugriff & Sicherheit*
 * section to "Angepasst" copies the sealed value into
 * `form.settings_override`) and two rows sharing a counter under one key is
 * the one way to break GCM outright.
 */
const IV_BYTES = 12;

/** The full 128-bit tag. Truncating it only weakens forgery resistance. */
const TAG_BYTES = 16;

/**
 * The stored string, and the reason it looks the way it does:
 *
 *     formsache1.<key-id>.<context-id>.<iv>.<ciphertext>.<tag>
 *     ^          ^        ^            ^     ^            ^
 *     |          |        |            |     |            base64url, 16 bytes
 *     |          |        |            |     base64url, variable
 *     |          |        |            base64url, 12 bytes
 *     |          |        first 4 bytes of a domain-separated SHA-256 over the
 *     |          |        context — a fingerprint, not the context itself
 *     |          first 4 bytes of a domain-separated SHA-256 over the key
 *     format version — implies cipher, IV size, tag size, encoding **and**
 *     the shape of the context (`secret-context.ts`)
 *
 * **"Self-describing" is not decoration, it is the exit.** A key rotation or a
 * cipher change is a question of *when*, not *if*, and at that moment the
 * column holds a mix of old and new values. Both switches have to be readable
 * off the value itself:
 *
 * - **Cipher / parameter change:** bump the version to `formsache2` and let `open()`
 *   dispatch on the prefix. Old rows keep saying `formsache1` and keep being read by
 *   the old branch; nothing has to be migrated in a single transaction, and no
 *   migration has to *guess* what a column contains.
 * - **Key rotation:** the key id says which key sealed a row, so a future
 *   deployment can hold two keys (`SECRET_BOX_KEY` plus a retired one) and
 *   re-seal lazily. Without it, `open()` under a new key can only report
 *   "authentication failed" and cannot tell a rotated key from an actual
 *   attack — the operational difference between "re-seal these rows" and
 *   "someone is writing to our database".
 *
 * Both ids are 4 bytes of `SHA-256(domain ‖ value)`, never of the value alone:
 * one-way, truncated, domain-separated fingerprints that identify without
 * being usable for anything else. Against a 256-bit random key the key id
 * carries nothing an attacker with a dump could use.
 *
 * **The context id diagnoses, the AAD enforces.** The fingerprint is public
 * information — anyone can compute it for any context — so it is not what
 * stops a value from being moved; the full context in the additional
 * authenticated data is. The id exists so that `open()` can *say* "wrong
 * context" instead of the flat "authentication failed" a bare AAD mismatch
 * gives, which is the same distinction the key id makes between a pending
 * rotation and someone writing to the database. The context itself is
 * deliberately **not** stored: it comes from the caller on every `open()`, so
 * a row can never carry its own justification for where it belongs.
 */
const FORMAT_VERSION = 'formsache1';

/** Version, key id, context id, IV, ciphertext, tag. */
const PART_COUNT = 6;

const ID_BYTES = 4;

/**
 * Domain separation, so neither fingerprint can coincide with some other
 * SHA-256 over the same input computed elsewhere for another purpose — and so
 * a key and a context can never produce the same id.
 */
const KEY_ID_DOMAIN = 'formsache.secret-box.key-id.v1';
const CONTEXT_ID_DOMAIN = 'formsache.secret-box.context-id.v1';

/**
 * Separates the header from the context inside the AAD.
 *
 * A NUL byte, because `secret-context.ts` allows neither it nor anything else
 * outside `[A-Za-z0-9._-]` in a context part. Without an unambiguous
 * separator, a crafted context could imitate a header and shift the boundary —
 * the classic way a concatenated AAD stops authenticating what it looks like
 * it authenticates.
 */
const AAD_SEPARATOR = '\u0000';

/**
 * The failure type of `open()`.
 *
 * **Every message is a fixed constant.** None of them interpolates the input,
 * the plaintext or the key, and none carries a `cause`. That is the whole
 * point of the class: a thrown error is the ordinary way a secret reaches a
 * log — an exception filter prints `message` and `stack`, and an aggregator
 * keeps them — so there must be nothing in either worth reading
 * (proof 4).
 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

const MALFORMED = 'sealed value is malformed';
const UNKNOWN_VERSION = 'sealed value uses an unknown format version';
const FOREIGN_KEY = 'sealed value was sealed with a different key';
const NOT_AUTHENTIC = 'sealed value failed authentication';
const EMPTY_PLAINTEXT = 'refusing to seal an empty secret';
const EMPTY_CONTEXT = 'refusing to seal or open without a context';
const FOREIGN_CONTEXT = 'sealed value belongs to a different context';

function deriveKeyId(key: Buffer): string {
  return createHash('sha256')
    .update(KEY_ID_DOMAIN, 'utf8')
    .update(key)
    .digest()
    .subarray(0, ID_BYTES)
    .toString('base64url');
}

function deriveContextId(context: string): string {
  return createHash('sha256')
    .update(CONTEXT_ID_DOMAIN, 'utf8')
    .update(context, 'utf8')
    .digest()
    .subarray(0, ID_BYTES)
    .toString('base64url');
}

/**
 * An empty context would silently reinstate the portability the context exists
 * to remove — every value sealed with `''` opens against every other. Refusing
 * it means a caller that forgot to pass one finds out immediately.
 */
function requireContext(context: string): string {
  if (context.length === 0) {
    throw new SecretBoxError(EMPTY_CONTEXT);
  }
  return context;
}

/** The authenticated header and context, unambiguously joined. */
function aad(header: string, context: string): Buffer {
  return Buffer.from(`${header}${AAD_SEPARATOR}${context}`, 'utf8');
}

/**
 * Decodes one base64url part.
 *
 * `Buffer.from` silently *skips* characters outside the alphabet, so a
 * corrupted part could decode to something shorter instead of failing. Two
 * checks close that: the re-encoded bytes must equal the input, and the byte
 * count must be the one the format promises.
 */
function decodePart(part: string, expectedBytes?: number): Buffer {
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) {
    throw new SecretBoxError(MALFORMED);
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new SecretBoxError(MALFORMED);
  }
  return bytes;
}

/**
 * Encrypts and decrypts a value that has to stay readable to the people
 * allowed to read it — today the form access word (`access.password`).
 *
 * The service knows nothing about forms, tenants or permissions on purpose.
 * *Who* may see a plaintext is a guard's decision
 * (`can_manage_settings`); this class only makes sure that what sits in the
 * database is not readable without the key.
 */
@Injectable()
export class SecretBoxService {
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(@Inject(SECRET_BOX_KEY) key: Buffer) {
    this.key = key;
    this.keyId = deriveKeyId(key);
  }

  /**
   * Plaintext -> opaque, self-describing stored string, bound to `context`.
   *
   * The context says **where this value belongs** and is built by
   * `secret-context.ts`, never by hand at the call site. It is authenticated
   * but not stored, so the same value cannot be moved to another form, another
   * tenant or another field: `open()` needs the caller to name the place
   * again, and a different place fails.
   *
   * **An empty plaintext throws** rather than producing a valid-looking token.
   * A sealed empty string is indistinguishable at the storage layer from a
   * sealed real one, so it would quietly mean "password protection is on, with
   * an empty password" — a lock that opens for everybody. The absence of an
   * access word is expressed by the absence of a value in the column, never by
   * an encrypted nothing. (The settings schema already rejects an
   * empty `access.password` while `passwordEnabled` is true; this is the same
   * rule one layer down, where it cannot be forgotten.)
   */
  seal(plaintext: string, context: string): string {
    requireContext(context);
    if (plaintext.length === 0) {
      throw new SecretBoxError(EMPTY_PLAINTEXT);
    }
    const iv = randomBytes(IV_BYTES);
    const header = `${FORMAT_VERSION}.${this.keyId}.${deriveContextId(context)}`;
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    // Header **and** full context travel as additional authenticated data, so
    // the tag covers both. Without the header, version and key id would be the
    // part of the stored string an attacker could rewrite unnoticed — and a
    // downgrade to a weaker `formsache…` version is exactly what they would rewrite
    // it to once there is more than one. Without the *full* context only its
    // four-byte fingerprint would be bound, which is short enough to search
    // for a collision offline; binding the string itself leaves nothing to
    // search for.
    cipher.setAAD(aad(header, context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      header,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  /**
   * The inverse; throws on tampered or unreadable input, or on a value that
   * belongs somewhere else.
   *
   * It never returns a best effort. Every path out of here that is not the
   * original plaintext is a `SecretBoxError`, and the three interesting ones
   * are told apart on purpose — a **different key** means a rotation was done
   * without its data, a **different context** means a value was moved between
   * rows, and a **failed authentication** means the bytes themselves were
   * edited. Operations has to be able to separate "re-seal these rows" from
   * "someone is writing to our database"; a single flat error would hide the
   * attack behind the maintenance task.
   */
  open(sealed: string, context: string): string {
    requireContext(context);
    const parts = sealed.split('.');
    if (parts.length !== PART_COUNT) {
      throw new SecretBoxError(MALFORMED);
    }
    // The defaults are unreachable — the length is checked above — and exist
    // only so `noUncheckedIndexedAccess` does not widen these to `undefined`.
    const [
      version = '',
      keyId = '',
      contextId = '',
      ivPart = '',
      ciphertextPart = '',
      tagPart = '',
    ] = parts;

    if (version !== FORMAT_VERSION) {
      throw new SecretBoxError(UNKNOWN_VERSION);
    }
    if (keyId !== this.keyId) {
      throw new SecretBoxError(FOREIGN_KEY);
    }
    // Diagnosis only — the binding that actually holds is the AAD below. A
    // forged fingerprint therefore does not open anything; it merely changes
    // which of the two errors is reported.
    if (contextId !== deriveContextId(context)) {
      throw new SecretBoxError(FOREIGN_CONTEXT);
    }

    const iv = decodePart(ivPart, IV_BYTES);
    const tag = decodePart(tagPart, TAG_BYTES);
    const ciphertext = decodePart(ciphertextPart);
    if (ciphertext.length === 0) {
      // `seal()` never produces this, and an empty plaintext must not be a
      // reachable result of `open()` either.
      throw new SecretBoxError(MALFORMED);
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(`${version}.${keyId}.${contextId}`, context));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // The library's own error is dropped rather than chained: `cause` is
      // printed by most log formatters, and a chained crypto error is one
      // refactoring away from carrying the input along with it.
      throw new SecretBoxError(NOT_AUTHENTIC);
    }
  }

  /**
   * Keeps the key out of anything that prints this object.
   *
   * `console.log(service)`, a Nest logger given a provider, `JSON.stringify`
   * of a context object — all of them walk own properties, and the key is one.
   * Both hooks are needed because they are used by different printers:
   * `util.inspect` (which Node's console uses) ignores `toJSON`, and
   * `JSON.stringify` ignores the inspect hook.
   */
  toJSON(): Record<string, string> {
    return { key: '[redacted]', keyId: this.keyId };
  }

  [inspect.custom](): string {
    return `SecretBoxService { key: [redacted], keyId: '${this.keyId}' }`;
  }
}
