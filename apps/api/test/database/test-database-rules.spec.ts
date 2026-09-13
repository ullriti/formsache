import { describe, expect, it } from 'vitest';

import { redactCredentials } from './migrations';
import {
  acquireTestDatabase,
  creationTimeOf,
  readEnvironment,
  requireOwnDatabase,
  resolveStrategy,
  selectBaseUrl,
  uniqueDatabaseName,
} from './test-database';

/**
 * The rules the provider promises, proven without any infrastructure — no
 * Docker, no database. They deliberately live apart from the provider's
 * self-test: these must hold on every machine, whereas that one needs a
 * server. The most important of them, "an enforced Testcontainers run must
 * fail rather than quietly fall back", was the load-bearing claim of ADR-0008
 * and had no test at all.
 */
describe('resolveStrategy', () => {
  it('picks Testcontainers when a runtime answers', () => {
    expect(resolveStrategy('auto', true)).toBe('testcontainers');
  });

  it('falls back to the external server when none answers', () => {
    expect(resolveStrategy('auto', false)).toBe('external');
  });

  it('refuses to fall back when Testcontainers is demanded', () => {
    expect(() => resolveStrategy('testcontainers', false)).toThrow(
      /no container runtime answered/,
    );
  });

  it('uses Testcontainers when demanded and available', () => {
    expect(resolveStrategy('testcontainers', true)).toBe('testcontainers');
  });

  // Not symmetric with the case above on purpose: forcing `external` is a
  // choice about where the database comes from, not a promise about Docker.
  it('stays external even when a runtime is available', () => {
    expect(resolveStrategy('external', true)).toBe('external');
  });
});

describe('readEnvironment', () => {
  it('treats an empty variable as absent', () => {
    const env = readEnvironment({ TEST_DATABASE_URL: '  ' });
    expect(env.TEST_DATABASE_URL).toBeUndefined();
    expect(env.TEST_DATABASE_STRATEGY).toBe('auto');
  });

  it('rejects an unknown strategy instead of guessing', () => {
    expect(() =>
      readEnvironment({ TEST_DATABASE_STRATEGY: 'docker' }),
    ).toThrow();
  });

  it('rejects a base URL that is not a URL', () => {
    expect(() =>
      readEnvironment({ TEST_DATABASE_URL: 'localhost:5432' }),
    ).toThrow();
  });
});

describe('selectBaseUrl', () => {
  const test = 'postgresql://u:p@host:5432/test_base';
  const app = 'postgresql://u:p@host:5432/app';

  it('prefers TEST_DATABASE_URL over DATABASE_URL', () => {
    const env = readEnvironment({ TEST_DATABASE_URL: test, DATABASE_URL: app });
    expect(selectBaseUrl(env)).toBe(test);
  });

  it('falls back to DATABASE_URL', () => {
    expect(selectBaseUrl(readEnvironment({ DATABASE_URL: app }))).toBe(app);
  });

  it('names both ways out when neither is configured', () => {
    expect(() => selectBaseUrl(readEnvironment({}))).toThrow(
      /TEST_DATABASE_URL/,
    );
  });
});

// Exercises the `source` parameter end to end: forcing `external` skips the
// runtime probe, so this behaves identically on a machine with Docker and on
// one without.
describe('acquireTestDatabase with an unusable configuration', () => {
  it('fails loudly instead of silently using some other database', async () => {
    await expect(
      acquireTestDatabase({ TEST_DATABASE_STRATEGY: 'external' }),
    ).rejects.toThrow(/no base database is configured/);
  });
});

describe('database names', () => {
  it('carries the creation time so leftovers can be swept', () => {
    const at = 1_700_000_000_000;
    expect(creationTimeOf(uniqueDatabaseName(at))).toBe(at);
  });

  it('is different on every call', () => {
    expect(uniqueDatabaseName()).not.toBe(uniqueDatabaseName());
  });

  it('ignores databases that are not ours', () => {
    expect(creationTimeOf('mydb')).toBeUndefined();
    expect(creationTimeOf('formsache_test_nope')).toBeUndefined();
  });
});

describe('requireOwnDatabase', () => {
  const base = 'postgresql://u:p@host:5432/mydb';

  it('accepts a URL that addresses the created database', () => {
    expect(() => {
      requireOwnDatabase(
        base,
        'postgresql://u:p@host:5432/formsache_test_1_ab',
        'formsache_test_1_ab',
      );
    }).not.toThrow();
  });

  // The regression the isolation test caught during development: an assembly
  // bug that hands every caller the shared base database. The provider has to
  // refuse that itself, not rely on a test noticing later.
  it('refuses to hand out the base database', () => {
    expect(() => {
      requireOwnDatabase(base, base, 'formsache_test_1_ab');
    }).toThrow(/refusing to hand out a shared database/);
  });
});

describe('redactCredentials', () => {
  it('removes the password from a connection string', () => {
    expect(
      redactCredentials('Error: P1000 at postgresql://user:s3cret@db:5432/x'),
    ).toBe('Error: P1000 at postgresql://user:***@db:5432/x');
  });

  it('leaves text without credentials alone', () => {
    expect(redactCredentials('no url here')).toBe('no url here');
  });
});
