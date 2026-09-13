import { describe, expect, it } from 'vitest';

import {
  parseSuperadminList,
  superadminAddedSchema,
  superadminPromoteSchema,
  superadminSchema,
} from './superadmins.ts';

/**
 * **The wire contract of the superadmin administration** (ADR-0029).
 *
 * The three assurances that are measured here and only here:
 *
 * 1. **No permission field travels along.** The appointment is the route, not a
 *    value in a document (ADR-0022 §6, here one installation later). A
 *    `strictObject` is what turns that into a 400 instead of a quietly ignored
 *    field — and a field that somebody takes to be without effect is one that
 *    the next mapper builds in.
 * 2. **An address is normalised as at the login.** Whoever writes it
 *    differently here does not find the row that the login finds.
 * 3. **The answer carries no hash and no identity.** The `strictObject` is
 *    there for that as well: a later `...user` in the mapper would be a parse
 *    error and no quiet addition.
 */

const ROW = {
  userId: '3f1d2b5e-7c8a-4b6d-9e0f-1a2b3c4d5e6f',
  email: 'zweite@example.org',
  name: 'Zweite Person',
  hasMembership: true,
  invitationPending: false,
} as const;

describe('superadminPromoteSchema', () => {
  it('normalisiert die Adresse wie die Anmeldung', () => {
    const parsed = superadminPromoteSchema.parse({
      email: '  ZWEITE@Example.ORG ',
      name: '  Zweite Person  ',
    });

    expect(parsed).toEqual({
      email: 'zweite@example.org',
      name: 'Zweite Person',
    });
  });

  it.each([
    [
      'auf oberster Ebene',
      { email: ROW.email, name: ROW.name, isSuperadmin: true },
    ],
    [
      'als Kennung statt Adresse',
      { email: ROW.email, name: ROW.name, userId: ROW.userId },
    ],
  ])('weist ein zusätzliches Feld %s zurück', (_where, payload) => {
    expect(superadminPromoteSchema.safeParse(payload).success).toBe(false);
  });

  it('verlangt eine Adresse, die eine ist', () => {
    expect(
      superadminPromoteSchema.safeParse({
        email: 'kein-postfach',
        name: ROW.name,
      }).success,
    ).toBe(false);
    expect(superadminPromoteSchema.safeParse({}).success).toBe(false);
  });

  /**
   * **Der Name ist Pflicht, nicht optional** (Review-Runde 3 Nr. 13).
   *
   * Er entscheidet nichts — was geschieht, entscheidet allein „gibt es diese
   * Adresse schon?". Aber er wird gebraucht, sobald ein Konto entsteht, und
   * ein optionales Feld, dessen Fehlen erst der Server zur Absage macht, wäre
   * die Sorte Vertrag, die man am Fehlerfall lernt. Die Begründung in voller
   * Länge steht am Schema.
   */
  it('verlangt einen Namen', () => {
    expect(
      superadminPromoteSchema.safeParse({ email: ROW.email }).success,
    ).toBe(false);
    expect(
      superadminPromoteSchema.safeParse({ email: ROW.email, name: '   ' })
        .success,
    ).toBe(false);
  });
});

/**
 * **Die Antwort sagt, was geschehen ist** (Review-Runde 3 Nr. 13): ernannt
 * oder eingeladen. Aus der Zeile allein ist das nicht zu lesen, und die
 * Ansicht braucht zwei verschiedene Sätze dafür.
 */
describe('superadminAddedSchema', () => {
  it('trägt die Zeile plus „invited"', () => {
    expect(superadminAddedSchema.parse({ ...ROW, invited: true })).toEqual({
      ...ROW,
      invited: true,
    });
  });

  it('verlangt das Feld — eine Zeile ohne ist kein Ergebnis dieser Route', () => {
    expect(superadminAddedSchema.safeParse(ROW).success).toBe(false);
  });

  it('bleibt streng: kein Passwort-Hash reist mit', () => {
    expect(
      superadminAddedSchema.safeParse({
        ...ROW,
        invited: false,
        passwordHash: '$argon2id$…',
      }).success,
    ).toBe(false);
  });
});

describe('superadminSchema', () => {
  it('nimmt eine Zeile, wie die Liste sie schickt', () => {
    expect(superadminSchema.parse(ROW)).toEqual(ROW);
  });

  it.each([
    ['passwordHash', { ...ROW, passwordHash: '$argon2id$…' }],
    ['oidcSubject', { ...ROW, oidcSubject: 'sub-42' }],
    ['isSuperadmin', { ...ROW, isSuperadmin: true }],
  ])('weist ein mitgereistes `%s` zurück', (_field, payload) => {
    expect(superadminSchema.safeParse(payload).success).toBe(false);
  });

  it('parst die Liste als Dokument, nicht als nacktes Array', () => {
    expect(parseSuperadminList({ superadmins: [ROW] })).toEqual({
      superadmins: [ROW],
    });
    expect(() => parseSuperadminList([ROW])).toThrow();
  });
});
