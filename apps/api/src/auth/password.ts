import { hash, verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, written out.
 *
 * The library declares `Algorithm` as an ambient `const enum`, which
 * `isolatedModules` forbids reading — the compiler would have to inline a value
 * it is not allowed to assume. The numeric constant is part of the library's
 * public surface, and pinning it here fails loudly if it ever changes: the
 * assertion below is checked on every hash.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters, following the OWASP Password Storage Cheat Sheet
 * (19 MiB memory, two iterations, one lane).
 *
 * They are written down here rather than left to the library default so that
 * a dependency bump cannot silently weaken every hash written afterwards. The
 * values are also embedded in each PHC string, so raising them later only
 * affects new hashes — old ones stay verifiable.
 */
const ARGON2ID_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a plaintext password into a PHC string (salt and parameters included).
 *
 * The result is checked to actually say `argon2id`. Without it, a library that
 * renumbered its algorithm constants would silently downgrade every new hash to
 * Argon2i or Argon2d — a change no test asserting "login works" would notice.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const phc = await hash(plaintext, ARGON2ID_OPTIONS);
  if (!phc.startsWith('$argon2id$')) {
    throw new Error('password hashing did not produce an Argon2id hash');
  }
  return phc;
}

/**
 * Verifies a password against a stored PHC string.
 *
 * A malformed or truncated hash makes the library throw. That is answered with
 * `false` rather than a propagated error: to the caller "this login does not
 * succeed" is the whole truth, and letting the exception through would turn a
 * single corrupt row into a 500 that distinguishes it from every other account
 * — exactly the oracle the requirement forbids.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2ID_OPTIONS);
  } catch {
    return false;
  }
}
