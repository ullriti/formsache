import { describe, expect, it } from 'vitest';

import {
  USER_PASSWORD_MAX,
  USER_PASSWORD_MIN,
  tenantCreateSchema,
} from './index.ts';
import {
  parseSetupState,
  setupRequestSchema,
  setupStateSchema,
} from './setup.ts';

/**
 * The wire contract of the first-run setup (ADR-0022).
 *
 * What is measured here is **not** that a valid document gets through — that is
 * the boring part —, but the three promises whose breach nobody would see:
 *
 * 1. `isSuperadmin` is not writable in the body (the `strictObject` rejects
 *    it instead of dropping it silently);
 * 2. the password minimum is **the same** as everywhere else, because it comes
 *    from the same place;
 * 3. „Organisation überspringen" is an explicit `null` and not an
 *    omitted field.
 *
 * ## Negative checks, measured while writing
 *
 * - `admin` rebuilt with its own `z.object({…})` instead of from
 *   `tenantCreateSchema` and the minimum set to `8`: the case „dasselbe Minimum
 *   wie überall" turns red and names both numbers. Without it the whole file
 *   would stay green — every other case derives its input from the constant itself.
 * - `strictObject` replaced by `object`: the two `isSuperadmin` cases
 *   turn red. Before, the field would have vanished silently, which is exactly the
 *   ineffectiveness that cannot be told apart from a rejection.
 */

const ADMIN = {
  email: 'erste@example.org',
  name: 'Erste Superadministratorin',
  password: 'x'.repeat(USER_PASSWORD_MIN),
} as const;

describe('setupStateSchema', () => {
  it('trägt genau ein Feld', () => {
    expect(parseSetupState({ setupRequired: true })).toStrictEqual({
      setupRequired: true,
    });
  });

  it.each([
    ['eine Zahl', { setupRequired: true, users: 0 }],
    ['einen Namen', { setupRequired: false, adminEmail: 'a@b.example' }],
    ['eine Organisation', { setupRequired: false, tenants: ['DACH'] }],
  ])('weist ein Feld zurück, das %s mitschickte', (_what, payload) => {
    expect(setupStateSchema.safeParse(payload).success).toBe(false);
  });

  it('weist eine Antwort ohne das Feld zurück', () => {
    expect(setupStateSchema.safeParse({}).success).toBe(false);
  });
});

describe('setupRequestSchema', () => {
  it('nimmt einen Superadministrator mit erster Organisation an', () => {
    const parsed = setupRequestSchema.parse({
      admin: { ...ADMIN, email: '  Erste@Example.ORG  ' },
      tenant: { shortName: 'DACH', name: 'Dachorganisation' },
    });

    // Address trimmed and lower-cased — the same normalisation the sign-in
    // applies later. Without it the first account would be the one that
    // cannot sign in.
    expect(parsed.admin.email).toBe('erste@example.org');
    expect(parsed.tenant?.shortName).toBe('DACH');
  });

  it('nimmt „Organisation überspringen" als ausdrückliches null an', () => {
    const parsed = setupRequestSchema.parse({ admin: ADMIN, tenant: null });

    expect(parsed.tenant).toBeNull();
  });

  it('weist ein weggelassenes `tenant` zurück — Überspringen wird gesagt', () => {
    expect(setupRequestSchema.safeParse({ admin: ADMIN }).success).toBe(false);
  });

  it.each([
    ['auf oberster Ebene', { admin: ADMIN, tenant: null, isSuperadmin: true }],
    [
      'im Administratorblock',
      { admin: { ...ADMIN, isSuperadmin: true }, tenant: null },
    ],
  ])('weist `isSuperadmin` %s zurück', (_where, payload) => {
    expect(setupRequestSchema.safeParse(payload).success).toBe(false);
  });

  it('fordert dasselbe Passwortminimum wie jede andere Stelle', () => {
    expect(
      setupRequestSchema.safeParse({
        admin: { ...ADMIN, password: 'x'.repeat(USER_PASSWORD_MIN - 1) },
        tenant: null,
      }).success,
    ).toBe(false);
    expect(
      setupRequestSchema.safeParse({
        admin: { ...ADMIN, password: 'x'.repeat(USER_PASSWORD_MIN) },
        tenant: null,
      }).success,
    ).toBe(true);
  });

  it('begrenzt das Passwort nach oben, bevor es in Argon2id läuft', () => {
    expect(
      setupRequestSchema.safeParse({
        admin: { ...ADMIN, password: 'x'.repeat(USER_PASSWORD_MAX + 1) },
        tenant: null,
      }).success,
    ).toBe(false);
  });

  it('nimmt für die Organisation genau die Regeln von „+ Neue Organisation"', () => {
    // Not a comparison of two numbers, but of the two schemas against the
    // same value: a short name with a space is invalid there, so it is here too.
    //
    // The administrator block is inserted **without a password** (ADR-0024): „+
    // Neue Organisation" invites, the first-run setup sets. With `ADMIN`
    // the case would be red as well, but for the wrong reason — and thereby
    // blind to whether the short-name rule is even still the same.
    const shortName = 'Dach Organisation';
    expect(
      tenantCreateSchema.safeParse({
        shortName,
        name: 'Dachorganisation',
        admin: { email: ADMIN.email, name: ADMIN.name },
      }).success,
    ).toBe(false);
    expect(
      setupRequestSchema.safeParse({
        admin: ADMIN,
        tenant: { shortName, name: 'Dachorganisation' },
      }).success,
    ).toBe(false);
  });

  it('lässt kein Feld der Organisationsmaske durch, das es hier nicht gibt', () => {
    expect(
      setupRequestSchema.safeParse({
        admin: ADMIN,
        // `formDefaults` deliberately does not exist in `tenantCreateSchema`;
        // the `pick` above must not change that.
        tenant: {
          shortName: 'DACH',
          name: 'Dachorganisation',
          formDefaults: {},
        },
      }).success,
    ).toBe(false);
  });
});
