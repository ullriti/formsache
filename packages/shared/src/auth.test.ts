import { describe, expect, it } from 'vitest';

import {
  PASSWORD_RESET_RETENTION_DAYS,
  PASSWORD_RESET_TTL_MINUTES,
  emailChangeSchema,
  loginRequestSchema,
  parseLoginRequest,
  parseLoginResponse,
  parseSessionUser,
  passwordChangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  profileUpdateSchema,
  type LoginResponse,
} from './auth.ts';
import { PASSWORD_MIN } from './form-settings.ts';

const branding = {
  accent: '#cea967',
  headerBg: '#212226',
  canvasBg: '#e9e6df',
  stripe: ['#212226', '#7c0800', '#cea967'],
  wideLogo: true,
};

const tenant = {
  id: '01923f5a-0000-7000-8000-000000000001',
  shortName: 'muster',
  name: 'Dachorganisation',
  logoRef: null,
  branding,
};

const group = {
  id: '01923f5a-0000-7000-8000-000000000002',
  name: 'admin',
  color: '#7c0800',
  rank: 100,
  isSystem: true,
};

const permissions = {
  canBuild: true,
  canViewResponses: true,
  canExport: true,
  canManageSettings: true,
  canManageFormSettings: true,
  canManageUsers: true,
};

const sessionUser = {
  id: '01923f5a-0000-7000-8000-000000000003',
  email: 'admin@example.org',
  name: 'Beispiel-Admin',
  isSuperadmin: true,
  // By now `/api/auth/me` always sends this field — an example without it
  // would describe an answer no route can produce.
  aiFormsAvailable: false,
  memberships: [{ tenant, group, permissions }],
  activeTenantId: tenant.id,
};

describe('loginRequestSchema', () => {
  it('normalises the e-mail so the lookup is case-insensitive', () => {
    const parsed = parseLoginRequest({
      email: '  Admin@Example.ORG ',
      password: 'secret',
    });
    expect(parsed.email).toBe('admin@example.org');
  });

  it('rejects an address that is not an e-mail', () => {
    expect(() =>
      parseLoginRequest({ email: 'admin', password: 'secret' }),
    ).toThrow();
  });

  /**
   * 254 is the RFC 5321 bound and doubles as a payload limit. The assertion is
   * on the *issue*, not merely on "it throws": with the bound inside the pipe
   * target the address would first be run through the e-mail pattern and the
   * issue would read `invalid_format`, so a `too_big` here is what pins the
   * order the comment in `auth.ts` describes.
   */
  it('rejects an oversized address by length, before matching the pattern', () => {
    const oversized = 'x'.repeat(300);
    const result = loginRequestSchema.safeParse({
      email: oversized,
      password: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('too_big');
    expect(() =>
      parseLoginRequest({
        email: `${'x'.repeat(250)}@example.org`,
        password: 'secret',
      }),
    ).toThrow();
  });

  it('rejects an empty password instead of trying to verify it', () => {
    expect(() =>
      parseLoginRequest({ email: 'admin@example.org', password: '' }),
    ).toThrow();
  });

  // A payload limit, not a policy: an unbounded string would be handed to
  // Argon2id, which is expensive by design.
  it('rejects an oversized password', () => {
    expect(() =>
      parseLoginRequest({
        email: 'admin@example.org',
        password: 'x'.repeat(1025),
      }),
    ).toThrow();
  });

  // The login must not leak a session token back into the body, and it must
  // not accept one either — see the header comment of auth.ts.
  it('drops fields the contract does not know', () => {
    const parsed: unknown = parseLoginRequest({
      email: 'admin@example.org',
      password: 'secret',
      isSuperadmin: true,
    });
    expect(parsed).toStrictEqual({
      email: 'admin@example.org',
      password: 'secret',
    });
  });
});

describe('loginResponseSchema', () => {
  it('accepts the payload the API will produce', () => {
    const parsed = parseLoginResponse({ user: sessionUser });
    expect(parsed.user.memberships[0]?.tenant.shortName).toBe('muster');
  });

  /**
   * At the level of the contract: even if a handler put a token
   * or a password hash into the object, parsing the response through the
   * schema removes it. That makes the schema a barrier, not just a
   * description.
   */
  it('strips a token or password hash smuggled into the payload', () => {
    const leaky = {
      user: { ...sessionUser, passwordHash: '$argon2id$v=19$...' },
      sessionToken: 'a3f1…',
    };

    const parsed: LoginResponse = parseLoginResponse(leaky);

    expect(JSON.stringify(parsed)).not.toContain('argon2id');
    expect(JSON.stringify(parsed)).not.toContain('a3f1');
    expect(Object.keys(parsed)).toStrictEqual(['user']);
    expect(Object.keys(parsed.user)).not.toContain('passwordHash');
  });
});

describe('sessionUserSchema', () => {
  it('allows a session without an active tenant', () => {
    expect(
      parseSessionUser({ ...sessionUser, activeTenantId: null }).activeTenantId,
    ).toBeNull();
  });

  it('rejects a branding colour that is not a hex literal', () => {
    const injected = {
      ...sessionUser,
      memberships: [
        {
          tenant: {
            ...tenant,
            branding: {
              ...branding,
              accent: 'red; background: url(https://evil.example/x)',
            },
          },
          group,
          permissions,
        },
      ],
    };
    expect(() => parseSessionUser(injected)).toThrow();
  });

  it('requires every one of the six permissions to be stated', () => {
    const incomplete = {
      ...sessionUser,
      memberships: [
        {
          tenant,
          group,
          permissions: { canBuild: true },
        },
      ],
    };
    expect(() => parseSessionUser(incomplete)).toThrow();
  });
});

/**
 * **One's own profile and „Passwort vergessen" — the contract** (finding 12,
 * ADR-0020).
 *
 * What is held here are the promises a number in a schema can give at all. The
 * limits themselves — enumeration, one-time use, deadlines — are server
 * behaviour and stand in `apps/api/test/auth/password-reset.spec.ts`.
 */
describe('profileUpdateSchema', () => {
  it('nimmt einen Namen an und schneidet ihn zu', () => {
    expect(profileUpdateSchema.parse({ name: '  Anna Beispiel  ' }).name).toBe(
      'Anna Beispiel',
    );
  });

  it('weist einen leeren Namen ab', () => {
    expect(profileUpdateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  /**
   * **The third write path onto `user.name`** (ADR-0026).
   *
   * The name ends up in the body of a mail that goes out over the
   * installation's mail server. Two of the three paths got the condition right
   * away; this one lagged behind, because at that point its file belonged to
   * somebody else. Since then all three share `personNameSchema`.
   *
   * *Reproduction:* take the `refine` line out of `personNameSchema` → this
   * case and the two in `tenant-admin.test.ts` go red.
   */
  it('weist einen Namen mit Zeilenumbruch ab — er wandert in eine Mail', () => {
    const injected = 'Anna\n\nDein Zugang läuft ab: https://boese.example';
    expect(profileUpdateSchema.safeParse({ name: injected }).success).toBe(
      false,
    );
    // The invisible stuff too, not only `\n`.
    expect(
      profileUpdateSchema.safeParse({ name: 'Anna\u0000Beispiel' }).success,
    ).toBe(false);
    expect(
      profileUpdateSchema.safeParse({ name: 'Anna\u200bBeispiel' }).success,
    ).toBe(false);
  });

  it('hat kein Feld für eine fremde Person', () => {
    // The core of the self-service: there is no parameter through which
    // somebody reaches another account. `strictObject` turns that into a
    // rejected body instead of a silent extra.
    expect(
      profileUpdateSchema.safeParse({
        name: 'Anna',
        userId: '01923f5a-0000-7000-8000-000000000001',
      }).success,
    ).toBe(false);
  });
});

describe('passwordChangeSchema', () => {
  it('verlangt das Mindestmaß beim **neuen** Passwort und keines beim alten', () => {
    // The old one is verified, not set: an account with an older, shorter
    // password must still be able to enter it.
    expect(
      passwordChangeSchema.safeParse({
        currentPassword: 'x',
        newPassword: 'y'.repeat(PASSWORD_MIN),
      }).success,
    ).toBe(true);
    expect(
      passwordChangeSchema.safeParse({
        currentPassword: 'x',
        newPassword: 'y'.repeat(PASSWORD_MIN - 1),
      }).success,
    ).toBe(false);
  });

  it('weist ein leeres aktuelles Passwort ab', () => {
    expect(
      passwordChangeSchema.safeParse({
        currentPassword: '',
        newPassword: 'y'.repeat(PASSWORD_MIN),
      }).success,
    ).toBe(false);
  });
});

describe('emailChangeSchema', () => {
  it('normalisiert die Adresse genauso wie das Anmelden', () => {
    // The same spelling (`emailAddressSchema`) and therefore the same
    // normalisation: the new address has to hit the `unique` index the way the
    // sign-in later queries it — otherwise the change creates a row nobody
    // finds any more.
    const parsed = emailChangeSchema.parse({
      currentPassword: 'x',
      email: '  Neue@Example.ORG ',
    });
    expect(parsed.email).toBe('neue@example.org');
    expect(
      loginRequestSchema.parse({ email: ' Neue@Example.ORG ', password: 'x' })
        .email,
    ).toBe(parsed.email);
  });

  it('verlangt das aktuelle Passwort — und zwar im selben Rumpf', () => {
    // The address change is an account takeover; without this proof an
    // unattended machine with an open session would be exactly that.
    expect(
      emailChangeSchema.safeParse({ email: 'neue@example.org' }).success,
    ).toBe(false);
    expect(
      emailChangeSchema.safeParse({
        currentPassword: '',
        email: 'neue@example.org',
      }).success,
    ).toBe(false);
  });

  it('trägt kein Minimum am aktuellen Passwort', () => {
    // It is verified, not set — an account with an older, shorter password
    // must still be able to enter it (as with `passwordChangeSchema`).
    expect(
      emailChangeSchema.safeParse({
        currentPassword: 'x',
        email: 'neue@example.org',
      }).success,
    ).toBe(true);
  });

  it('weist eine Adresse ab, die keine ist — und hat kein Feld für eine fremde Kennung', () => {
    expect(
      emailChangeSchema.safeParse({ currentPassword: 'x', email: 'kein-at' })
        .success,
    ).toBe(false);
    expect(
      emailChangeSchema.safeParse({
        currentPassword: 'x',
        email: 'neue@example.org',
        userId: '01923f5a-0000-7000-8000-000000000001',
      }).success,
    ).toBe(false);
  });
});

describe('passwordResetRequestSchema', () => {
  it('normalisiert die Adresse wie das Anmelden', () => {
    // Both paths find the row over the same `unique` index; that one is the
    // case-insensitive lookup only as long as both normalise alike.
    expect(
      passwordResetRequestSchema.parse({ email: '  Anna@Example.ORG ' }).email,
    ).toBe('anna@example.org');
  });

  it('weist etwas ab, das keine Adresse ist', () => {
    expect(
      passwordResetRequestSchema.safeParse({ email: 'kein-at-zeichen' })
        .success,
    ).toBe(false);
  });
});

describe('passwordResetConfirmSchema', () => {
  it('verlangt Token und ein Passwort über dem Mindestmaß', () => {
    expect(
      passwordResetConfirmSchema.safeParse({
        token: 'A'.repeat(43),
        password: 'y'.repeat(PASSWORD_MIN),
      }).success,
    ).toBe(true);
    expect(
      passwordResetConfirmSchema.safeParse({
        token: 'A'.repeat(43),
        password: 'kurz',
      }).success,
    ).toBe(false);
    expect(
      passwordResetConfirmSchema.safeParse({
        token: '',
        password: 'y'.repeat(PASSWORD_MIN),
      }).success,
    ).toBe(false);
  });
});

describe('die Fristen der Rücksetzung', () => {
  it('gilt eine Stunde und räumt nach einer Woche auf', () => {
    // Both numbers stand in `docs/kb/10-datenschutz.md`;
    // `retention-doc.test.ts` holds the table and the constant together. What
    // stands here is only that the lifetime is **considerably** shorter than
    // the retention — a row that is valid longer than it is kept would be a
    // contradiction neither of the two checks would see.
    expect(PASSWORD_RESET_TTL_MINUTES).toBeLessThan(
      PASSWORD_RESET_RETENTION_DAYS * 24 * 60,
    );
  });
});
