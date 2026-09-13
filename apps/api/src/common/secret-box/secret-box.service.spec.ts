import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from './secret-box-key';
import { SecretBoxError, SecretBoxService } from './secret-box.service';
import { formOverrideContext, tenantDefaultsContext } from './secret-context';

/**
 * Keys are minted per test, never written down: no key material belongs in the
 * repository, and that includes its tests (proof 2).
 */
function newService(): SecretBoxService {
  return new SecretBoxService(randomBytes(SECRET_BOX_KEY_BYTES));
}

/** The kind of thing this actually protects — a shared access word. */
const ACCESS_WORD = 'Jahrestagung-2026-Waldkater';

/** Two tenants and two of their forms, as the real callers would name them. */
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const FORM_1 = randomUUID();
const FORM_2 = randomUUID();

const CONTEXT = formOverrideContext(TENANT_A, FORM_1, 'access.password');
const OTHER_FORM = formOverrideContext(TENANT_A, FORM_2, 'access.password');

/** Replaces one character of a base64url part, keeping the length intact. */
function flip(part: string): string {
  const first = part.slice(0, 1);
  return `${first === 'A' ? 'B' : 'A'}${part.slice(1)}`;
}

function partsOf(sealed: string): string[] {
  return sealed.split('.');
}

describe('SecretBoxService', () => {
  describe('round trip', () => {
    it('returns exactly what was sealed', () => {
      const box = newService();
      expect(box.open(box.seal(ACCESS_WORD, CONTEXT), CONTEXT)).toBe(
        ACCESS_WORD,
      );
    });

    // The access word is typed by a human into a German UI; a byte-counting
    // bug in the encoding would only show up on the umlaut.
    it('survives non-ASCII and long values unchanged', () => {
      const box = newService();
      const values = ['Grüße aus Jena', '🔑 Schlüssel', 'x'.repeat(4096)];
      for (const value of values) {
        expect(box.open(box.seal(value, CONTEXT), CONTEXT)).toBe(value);
      }
    });

    /**
     * The heart of proof 1: whatever ends up in the JSONB column, the access
     * word is not in it. The parallel work on persistence reads the raw column
     * for the same assertion one layer up; this one holds even if that layer
     * is later rewritten.
     */
    it('produces a stored string that does not contain the plaintext', () => {
      const sealed = newService().seal(ACCESS_WORD, CONTEXT);
      expect(sealed).not.toContain(ACCESS_WORD);
      expect(sealed).not.toContain('Jahrestagung');
      // …and not in any of the obvious encodings either.
      expect(sealed).not.toContain(Buffer.from(ACCESS_WORD).toString('base64'));
      expect(sealed).not.toContain(
        Buffer.from(ACCESS_WORD).toString('base64url'),
      );
      expect(sealed).not.toContain(Buffer.from(ACCESS_WORD).toString('hex'));
    });

    /**
     * The context is authenticated, not stored. A stored string that carried
     * its own tenant and form ids would hand a database dump a ready-made map
     * of which row belongs where — and, worse, would tempt a later `open()`
     * into trusting the value's own claim about where it belongs.
     */
    it('does not store the context it is bound to', () => {
      const sealed = newService().seal(ACCESS_WORD, CONTEXT);
      expect(sealed).not.toContain(TENANT_A);
      expect(sealed).not.toContain(FORM_1);
      expect(sealed).not.toContain('access.password');
      expect(sealed).not.toContain(CONTEXT);
    });

    /**
     * A fresh IV per call. Without it, two forms with the same access word
     * would store the same string — and anyone with read access could tell
     * that they match without decrypting anything.
     */
    it('seals the same value differently every time', () => {
      const box = newService();
      const first = box.seal(ACCESS_WORD, CONTEXT);
      const second = box.seal(ACCESS_WORD, CONTEXT);
      expect(first).not.toBe(second);
      expect(box.open(first, CONTEXT)).toBe(ACCESS_WORD);
      expect(box.open(second, CONTEXT)).toBe(ACCESS_WORD);
    });
  });

  describe('stored format', () => {
    /**
     * The format is a promise to the future, not an implementation detail: a
     * later key or cipher change reads the version, the key id and the context
     * id off the stored value instead of guessing what the column holds. A
     * change to any of them has to be a deliberate one, so it is asserted.
     */
    it('is version-, key- and context-tagged and made of six parts', () => {
      const parts = partsOf(newService().seal(ACCESS_WORD, CONTEXT));
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('formsache1');
      expect(parts[1]).toMatch(/^[\w-]{6}$/);
      expect(parts[2]).toMatch(/^[\w-]{6}$/);
    });

    it('tags values from different keys differently', () => {
      const [a, b] = [newService(), newService()];
      expect(partsOf(a.seal(ACCESS_WORD, CONTEXT))[1]).not.toBe(
        partsOf(b.seal(ACCESS_WORD, CONTEXT))[1],
      );
    });

    /** The same key always produces the same id, or rotation cannot use it. */
    it('tags every value of one key with the same id', () => {
      const box = newService();
      expect(partsOf(box.seal('a', CONTEXT))[1]).toBe(
        partsOf(box.seal('b', CONTEXT))[1],
      );
    });

    it('tags values from different contexts differently', () => {
      const box = newService();
      expect(partsOf(box.seal(ACCESS_WORD, CONTEXT))[2]).not.toBe(
        partsOf(box.seal(ACCESS_WORD, OTHER_FORM))[2],
      );
    });
  });

  /**
   * The isolation rule — and `CONTRIBUTING.md` asks for the case that must fail,
   * not the one that must work: a value opens only where it was sealed. Every
   * move a hand on the database could make is tried here, and every one of
   * them has to be refused.
   */
  describe('a value opens only in its own context', () => {
    it('does not open in another form of the same tenant', () => {
      const box = newService();
      const sealed = box.seal(ACCESS_WORD, CONTEXT);
      expect(() => box.open(sealed, OTHER_FORM)).toThrow(SecretBoxError);
      expect(() => box.open(sealed, OTHER_FORM)).toThrow(/different context/);
    });

    /** The tenant boundary — a security boundary here, not a display question. */
    it('does not open under another tenant', () => {
      const box = newService();
      const sealed = box.seal(ACCESS_WORD, CONTEXT);
      const otherTenant = formOverrideContext(
        TENANT_B,
        FORM_1,
        'access.password',
      );
      expect(() => box.open(sealed, otherTenant)).toThrow(/different context/);
    });

    /**
     * A form override is not a tenant standard. Without the distinct prefixes
     * of `secret-context.ts`, a word copied from `tenant.form_defaults` into a
     * form's `settings_override` would open as if it had always been there.
     */
    it('does not open a tenant standard as a form override, or the reverse', () => {
      const box = newService();
      const defaults = tenantDefaultsContext(TENANT_A, 'access.password');
      const sealedDefault = box.seal(ACCESS_WORD, defaults);
      const sealedOverride = box.seal(ACCESS_WORD, CONTEXT);

      expect(() => box.open(sealedDefault, CONTEXT)).toThrow(
        /different context/,
      );
      expect(() => box.open(sealedOverride, defaults)).toThrow(
        /different context/,
      );
      // …and each still opens where it belongs, so this measures a boundary
      // and not a service that has simply started refusing everything.
      expect(box.open(sealedDefault, defaults)).toBe(ACCESS_WORD);
      expect(box.open(sealedOverride, CONTEXT)).toBe(ACCESS_WORD);
    });

    /**
     * The escalation this forestalls: once a second secret exists (the
     * per-tenant OIDC client secret named in the concept), moving it into
     * `access.password` would let anyone with `can_manage_settings` read it
     * out in clear — that field is *meant* to be readable.
     */
    it('does not open in another field of the same row', () => {
      const box = newService();
      const sealed = box.seal(ACCESS_WORD, CONTEXT);
      // The future field is spelled out here rather than added to
      // `SecretField`: that union grows with the column that holds the secret,
      // not with a test.
      const otherField = CONTEXT.replace(
        'access.password',
        'oidc.clientSecret',
      );
      expect(() => box.open(sealed, otherField)).toThrow(/different context/);
    });

    /**
     * Forging the fingerprint changes which error is reported, never the
     * outcome: what binds is the full context in the AAD, and that is not in
     * the stored string to be edited.
     */
    it('still refuses when the context fingerprint is forged to match', () => {
      const box = newService();
      const parts = partsOf(box.seal(ACCESS_WORD, CONTEXT));
      // The fingerprint an attacker would need: the one belonging to the
      // context they want the value to open in.
      const forgedId = partsOf(box.seal('irrelevant', OTHER_FORM))[2];
      const forged = [parts[0], parts[1], forgedId, ...parts.slice(3)].join(
        '.',
      );
      expect(() => box.open(forged, OTHER_FORM)).toThrow(
        /failed authentication/,
      );
    });

    it('refuses to seal or open without a context at all', () => {
      const box = newService();
      expect(() => box.seal(ACCESS_WORD, '')).toThrow(/without a context/);
      expect(() => box.open(box.seal(ACCESS_WORD, CONTEXT), '')).toThrow(
        /without a context/,
      );
    });
  });

  describe('open() refuses rather than guesses', () => {
    it('throws on a value sealed with a different key', () => {
      const sealed = newService().seal(ACCESS_WORD, CONTEXT);
      expect(() => newService().open(sealed, CONTEXT)).toThrow(SecretBoxError);
      // Reported as a *key* problem, so operations can tell a pending
      // rotation from someone writing to the database.
      expect(() => newService().open(sealed, CONTEXT)).toThrow(/different key/);
    });

    /**
     * The reason for an AEAD instead of plain AES-CTR: every one of these
     * would otherwise return a plausible-looking string, and a steered access
     * word is a lock the attacker chose.
     */
    it('throws on a modified ciphertext, tag or IV', () => {
      const box = newService();
      const parts = partsOf(box.seal(ACCESS_WORD, CONTEXT));
      const withFlipped = (index: number): string =>
        parts.map((part, at) => (at === index ? flip(part) : part)).join('.');

      for (const index of [3, 4, 5]) {
        expect(() => box.open(withFlipped(index), CONTEXT)).toThrow(
          /failed authentication/,
        );
      }
    });

    /**
     * Version, key id and context id travel as additional authenticated data,
     * so the tag covers them too. Once there is an `formsache2`, this is what stops
     * an attacker from downgrading a row back to a weaker `formsache1`.
     */
    it('throws when the header is rewritten', () => {
      const box = newService();
      const parts = partsOf(box.seal(ACCESS_WORD, CONTEXT));
      expect(() =>
        box.open(['formsache2', ...parts.slice(1)].join('.'), CONTEXT),
      ).toThrow(/unknown format version/);
      // A key id that is well-formed but not ours: rejected before the cipher
      // is even constructed.
      expect(() =>
        box.open(
          [parts[0], flip(parts[1] ?? ''), ...parts.slice(2)].join('.'),
          CONTEXT,
        ),
      ).toThrow(/different key/);
    });

    it('throws on structurally broken input instead of returning something', () => {
      const box = newService();
      for (const broken of [
        '',
        'formsache1',
        'formsache1.a.b.c',
        'formsache1.a.b.c.d',
        'formsache1.a.b.c.d.e.f',
        ACCESS_WORD,
        '{"password":"offen"}',
      ]) {
        expect(() => box.open(broken, CONTEXT)).toThrow(SecretBoxError);
      }
    });

    /**
     * An empty access word must not be representable. A sealed empty string is
     * indistinguishable in the column from a sealed real one, so it would
     * quietly mean "password protection on, password empty" — a lock that
     * opens for everybody.
     */
    it('refuses to seal an empty secret', () => {
      expect(() => newService().seal('', CONTEXT)).toThrow(/empty secret/);
    });
  });

  describe('gives nothing away', () => {
    /**
     * Proof 3, from this side: whatever a caller does with the failure, there
     * is nothing in it worth reading. Messages are fixed constants — no input,
     * no plaintext, no key, no context — and no `cause` chains a crypto error
     * that a later refactoring could make carry the input along.
     */
    it('never puts input, plaintext or key into an error', () => {
      const key = randomBytes(SECRET_BOX_KEY_BYTES);
      const box = new SecretBoxService(key);
      const sealed = box.seal(ACCESS_WORD, CONTEXT);
      const tampered = `${sealed.slice(0, -1)}${flip(sealed.slice(-1))}`;

      const failures = [
        (): unknown => box.open(tampered, CONTEXT),
        (): unknown => box.open('kaputt', CONTEXT),
        (): unknown => box.open(sealed, OTHER_FORM),
        (): unknown => newService().open(sealed, CONTEXT),
        (): unknown => box.seal('', CONTEXT),
      ];
      for (const failing of failures) {
        let dump = '';
        try {
          failing();
          expect.unreachable('the call was supposed to throw');
        } catch (error) {
          dump = inspect(error, { depth: null });
        }
        expect(dump).not.toContain(ACCESS_WORD);
        expect(dump).not.toContain(sealed);
        expect(dump).not.toContain(key.toString('base64'));
        expect(dump).not.toContain(key.toString('base64url'));
        expect(dump).not.toContain(key.toString('hex'));
      }
    });

    /**
     * The other way a key escapes: something prints the provider. Both hooks
     * are checked because different printers use different ones — Node's
     * console goes through `util.inspect`, structured loggers through
     * `JSON.stringify`.
     */
    it('redacts the key when the service itself is printed', () => {
      const key = randomBytes(SECRET_BOX_KEY_BYTES);
      const box = new SecretBoxService(key);
      for (const rendered of [inspect(box), JSON.stringify(box)]) {
        expect(rendered).toContain('[redacted]');
        expect(rendered).not.toContain(key.toString('base64'));
        expect(rendered).not.toContain(key.toString('base64url'));
        expect(rendered).not.toContain(key.toString('hex'));
      }
    });

    /**
     * Proof 4, and the half no assertion on a return value can reach: the log.
     * Built like the login's counterpart in `test/auth/auth.spec.ts` —
     * everything the process writes during a full cycle is captured through
     * the two streams every logger ends up in, and then searched.
     *
     * The cycle deliberately includes the **failing** paths. A thrown error
     * that carries its input is the ordinary way a secret reaches a log, so a
     * test that only seals and opens successfully would prove the easy half.
     */
    it('writes neither the secret nor the key to stdout or stderr', () => {
      const key = randomBytes(SECRET_BOX_KEY_BYTES);
      const box = new SecretBoxService(key);

      const captured: string[] = [];
      const record = (chunk: unknown): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      };
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(record);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(record);

      let sealed = '';
      try {
        // Set …
        sealed = box.seal(ACCESS_WORD, CONTEXT);
        // … check …
        box.open(sealed, CONTEXT);
        // … and fail, in every way there is. Each failure is logged the way a
        // careless caller would log it, so the assertions below measure what
        // the error *carries*, not merely that nobody called `console.log`.
        const failures = [
          (): unknown =>
            box.open(
              `${sealed.slice(0, -1)}${flip(sealed.slice(-1))}`,
              CONTEXT,
            ),
          (): unknown => box.open('formsache1.a.b.c.d.e', CONTEXT),
          (): unknown => box.open(sealed, OTHER_FORM),
          (): unknown => newService().open(sealed, CONTEXT),
          (): unknown => box.seal('', CONTEXT),
          (): unknown => box.seal(ACCESS_WORD, ''),
        ];
        for (const failing of failures) {
          try {
            failing();
          } catch (error) {
            console.error(error);
          }
        }
        console.error(box);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }

      const log = captured.join('');
      expect(log).not.toBe('');
      expect(log).not.toContain(ACCESS_WORD);
      expect(log).not.toContain(sealed);
      expect(log).not.toContain(key.toString('base64'));
      expect(log).not.toContain(key.toString('base64url'));
      expect(log).not.toContain(key.toString('hex'));
    });
  });
});
