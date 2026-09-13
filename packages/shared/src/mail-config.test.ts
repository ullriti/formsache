import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  describeMailConfigError,
  parseStoredSmtpBlock,
  smtpBlockSchema,
  type SmtpBlock,
} from './mail-config.ts';

/**
 * A complete block — the one shape that is allowed to exist. Every case below
 * is this minus something, which is the only way to test indivisibility: a test
 * that sends the *valid* block proves nothing about it.
 */
const BLOCK = {
  host: 'mail.organisation.example',
  port: 587,
  secure: false,
  auth: { user: 'Organisation', password: 'geheim' },
  from: 'post@organisation.example',
} as const;

/** The five fields a block cannot do without. */
const REQUIRED_FIELDS = ['host', 'port', 'secure', 'auth', 'from'] as const;

describe('ein gespeicherter Mailserver (ADR-0013, ADR-0023)', () => {
  it('accepts the one shape that exists', () => {
    expect(smtpBlockSchema.parse(BLOCK)).toStrictEqual(BLOCK);
  });

  /**
   * **The reproduction of the assurance.** Replacing the block with an object
   * of nothing but optional fields plus a rule above it lets every one of
   * these cases parse — and the whole section here goes green while the
   * promise is gone.
   */
  describe('a half-filled block does not parse, and the message names the field', () => {
    for (const field of REQUIRED_FIELDS) {
      it(`refuses a block without ${field}`, () => {
        // Built by *omission* rather than by spelling out five near-copies:
        // the point is „complete minus one", and a hand-written variant is one
        // typo away from testing something else.
        const half = Object.fromEntries(
          Object.entries(BLOCK).filter(([key]) => key !== field),
        );
        const result = smtpBlockSchema.safeParse(half);

        expect(result.success).toBe(false);
        // Not „it failed somehow": what matters is a message that names
        // the missing field, because it ends up in `mail_log.last_error` where
        // somebody has to act on it.
        const message = describeMailConfigError(
          result.error ?? new z.ZodError([]),
        );
        expect(message).toContain(field);
      });
    }

    it('refuses a block that is nothing but a sender address', () => {
      // The mixture this block exists for: somebody else's transport with
      // one's own sender address — signed, technically flawless forgery.
      // There is no type for it, so this parse can succeed for no other
      // reason than somebody having taken the block apart.
      expect(smtpBlockSchema.safeParse({ from: BLOCK.from }).success).toBe(
        false,
      );
    });
  });

  /**
   * The credentials are a pair or nothing — the middle state is what a
   * feldweise („one field at a time") shape would have allowed.
   */
  describe('authentication is an indivisible pair or null', () => {
    it('accepts a relay that wants no login', () => {
      expect(smtpBlockSchema.parse({ ...BLOCK, auth: null })).toMatchObject({
        auth: null,
      });
    });

    it.each([
      ['a user without a password', { user: 'Organisation' }],
      ['a password without a user', { password: 'geheim' }],
      ['an empty user', { user: '', password: 'geheim' }],
      ['an empty password', { user: 'Organisation', password: '' }],
    ])('refuses %s', (_name, auth) => {
      expect(smtpBlockSchema.safeParse({ ...BLOCK, auth }).success).toBe(false);
    });
  });

  /**
   * `secure` is a required boolean and not „absent decides from the port". The
   * default belongs in the surface that offers the field, where a human
   * sees it — a stored block has no open fields.
   */
  it('refuses a block that leaves the encryption open', () => {
    const withoutSecure: Record<string, unknown> = { ...BLOCK };
    delete withoutSecure.secure;
    expect(smtpBlockSchema.safeParse(withoutSecure).success).toBe(false);
    expect(smtpBlockSchema.safeParse({ ...BLOCK, secure: 'yes' }).success).toBe(
      false,
    );
  });

  /**
   * **The discriminator is gone, and for both rows** (ADR-0023).
   *
   * `{"source":"system"}` was once the spelling for „diese Organisation
   * erbt". A document the application can no longer produce is
   * refused and not interpreted — there is no installation on which such a
   * thing would stand (ADR-0023 „Context"), and a tolerated legacy document
   * would be a second meaning of „kein Mailserver".
   */
  it.each([
    ['a leftover „source": "system" document', { source: 'system' }],
    ['a leftover „source": "own" block', { ...BLOCK, source: 'own' }],
    ['an unknown key beside a complete block', { ...BLOCK, tls: 'yes' }],
  ])('refuses %s', (_name, document) => {
    expect(smtpBlockSchema.safeParse(document).success).toBe(false);
  });

  it('refuses a port that is not one, and a sender that is not an address', () => {
    expect(smtpBlockSchema.safeParse({ ...BLOCK, port: 0 }).success).toBe(
      false,
    );
    expect(smtpBlockSchema.safeParse({ ...BLOCK, port: '587' }).success).toBe(
      false,
    );
    expect(
      smtpBlockSchema.safeParse({
        ...BLOCK,
        from: 'Dachorganisation <post@organisation.example>',
      }).success,
    ).toBe(false);
  });
});

describe('reading what a column holds', () => {
  /**
   * **NULL means „noch keiner eingetragen" — the same meaning for both
   * rows** (ADR-0023).
   *
   * Until then the same NULL meant „erbt vom System" in `tenant.smtp` and
   * „nicht eingerichtet" in `system_setting.smtp`. One column, two
   * meanings, one reader — now it is one.
   */
  it('reads an empty column as „not configured yet" rather than as a fault', () => {
    expect(parseStoredSmtpBlock(null)).toBeNull();
    expect(parseStoredSmtpBlock(undefined)).toBeNull();
  });

  it('carries a stored block through unchanged', () => {
    expect(parseStoredSmtpBlock(BLOCK)).toStrictEqual(BLOCK);
  });

  /**
   * ADR-0013 no. 4: a mixed or unparsable stored block is **refused**, never
   * partially used. The row it belongs to goes `failed`; deducing the rest
   * would be the application inventing a configuration nobody wrote.
   */
  it.each([
    ['a mixed block', { from: BLOCK.from }],
    ['an empty document', {}],
    ['a document that is not one', 'system'],
    ['the old inheritance marker', { source: 'system' }],
  ])('refuses %s rather than reading past it', (_name, stored) => {
    expect(() => parseStoredSmtpBlock(stored)).toThrow();
  });
});

/**
 * ⚠️ **The load-bearing half of the requirement lives here and is checked by
 * `pnpm typecheck`, not by this suite.**
 *
 * Vitest runs through SWC, which strips types without checking them — every
 * line below passes at runtime no matter what the schema looks like. What they
 * assert is that the *type* refuses them, and the assertion is the
 * `@ts-expect-error`: it fails the build when the error it expects stops
 * happening, i.e. exactly when somebody replaces the block with an object of
 * optional fields. The same trap `PUBLIC_BASE_URL` set.
 */
describe('what cannot be written down at all', () => {
  it('has no type for an address without a transport', () => {
    // @ts-expect-error — „only a sender address" is the SPF/DKIM forgery.
    const forgery: SmtpBlock = { from: 'x@y.example' };
    // @ts-expect-error — a transport without an address is the other half.
    const halfway: SmtpBlock = { host: 'mail.example' };
    // @ts-expect-error — there is no „source" arm any more (ADR-0023).
    const inherited: SmtpBlock = { source: 'system' };

    // Used, so nothing here is dead — the assertions that matter already
    // happened at compile time.
    expect([forgery, halfway, inherited]).toHaveLength(3);
  });
});
