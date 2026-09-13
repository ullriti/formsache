import { describe, expect, it } from 'vitest';

import { baseUrlSchema, normaliseBaseUrl } from './base-url.ts';

/**
 * The cases used to live in `env.test.ts`, where `PUBLIC_BASE_URL` was an
 * environment variable. The requirement moved the address into the database;
 * the predicate moved with it, and so did its tests — the alternative was a
 * second alphabet for „was ist eine Basis-Adresse?" in the settings wire.
 */
describe('a base address ', () => {
  /**
   * Normalised on the way in, so every caller may append a path by plain
   * concatenation and exactly one place had to think about the slash.
   */
  it.each([
    ['https://formulare.example.org', 'https://formulare.example.org'],
    ['https://formulare.example.org/', 'https://formulare.example.org'],
    ['https://formulare.example.org///', 'https://formulare.example.org'],
    [
      'https://organisation.example/forms/',
      'https://organisation.example/forms',
    ],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normaliseBaseUrl(raw)).toBe(expected);
    expect(baseUrlSchema.parse(raw)).toBe(expected);
  });

  /**
   * An origin, optionally with a path — nothing else. The four refusals below
   * are the ones a hand-typed value actually produces.
   */
  it.each([
    ['no scheme', 'formulare.example.org'],
    ['a scheme a browser must not follow', 'javascript:alert(1)'],
    ['a query string', 'https://formulare.example.org/?tenant=muster'],
    ['a fragment', 'https://formulare.example.org/#/f'],
  ])('rejects a base address with %s', (_name, value) => {
    expect(normaliseBaseUrl(value)).toBeNull();
    expect(baseUrlSchema.safeParse(value).success).toBe(false);
  });

  it('rejects an empty value rather than reading it as „keine Adresse"', () => {
    // The column is nullable, and that is where „nicht gesetzt" is expressed.
    // An empty *string* is somebody having saved a field they left blank, and
    // taking that as a decision would build links starting with nothing.
    expect(baseUrlSchema.safeParse('').success).toBe(false);
  });

  /** The message has to say what shape is expected — it is read by a human. */
  it('says what it wants', () => {
    const result = baseUrlSchema.safeParse('formulare.example.org');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('https://');
  });
});
