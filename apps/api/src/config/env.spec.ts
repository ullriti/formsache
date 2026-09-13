import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SECRET_BOX_KEY_BYTES } from '../common/secret-box/secret-box-key';
import { findEnvFile, loadEnv, loadEnvFile } from './env';

function makeEnvFile(contents: string): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'formsache-env-'));
  const file = join(directory, '.env');
  writeFileSync(file, contents);
  return { directory, file };
}

describe('findEnvFile', () => {
  it('finds a .env in a parent directory', () => {
    const { directory, file } = makeEnvFile('X=1\n');
    try {
      expect(findEnvFile(join(directory, 'apps', 'api'))).toBe(file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns undefined when no .env exists up to the filesystem root', () => {
    expect(findEnvFile(sep)).toBeUndefined();
  });
});

describe('loadEnvFile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FS_TEST_ONLY_UNSET;
  });

  it('fills in variables that the real environment does not provide', () => {
    const { directory, file } = makeEnvFile('FS_TEST_ONLY_UNSET=from-file\n');
    try {
      loadEnvFile(file);
      expect(process.env.FS_TEST_ONLY_UNSET).toBe('from-file');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The whole point of the precedence: a host or CI runner must be able to
  // override a checked-out .env. If Node ever changed this, the API would
  // silently pick up local development values in production.
  it('never overrides a variable that is already set', () => {
    vi.stubEnv('FS_TEST_ONLY_PRESET', 'from-environment');
    const { directory, file } = makeEnvFile('FS_TEST_ONLY_PRESET=from-file\n');
    try {
      loadEnvFile(file);
      expect(process.env.FS_TEST_ONLY_PRESET).toBe('from-environment');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does nothing when there is no .env', () => {
    expect(() => {
      loadEnvFile(undefined);
    }).not.toThrow();
  });
});

describe('loadEnv', () => {
  const DATABASE_URL = 'postgresql://user:pw@127.0.0.1:5432/db';

  const NODE_ENV = 'test';

  /**
   * Minted per run rather than written down: a key constant in a test file is
   * exactly as copy-pasteable into a deployment as a real one, and the requirement asks that a search over the repository find no key material at all.
   */
  const SECRET_BOX_KEY = randomBytes(SECRET_BOX_KEY_BYTES).toString('base64');

  /**
   * The variables without a default — everything the API needs *in order to
   * reach its settings* , plus,, the one place it
   * writes to that is not the database. The address it answers under used to be
   * among them; it is a row now.
   */
  const FILE_STORAGE_DIR = '/srv/formsache/files';

  const REQUIRED = {
    DATABASE_URL,
    NODE_ENV,
    SECRET_BOX_KEY,
    FILE_STORAGE_DIR,
  };

  it('validates the environment through the shared schema', () => {
    expect(loadEnv({ ...REQUIRED, API_PORT: '4100' }).API_PORT).toBe(4100);
    expect(() => loadEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow();
  });

  it('refuses an environment without a database connection', () => {
    expect(() =>
      loadEnv({ NODE_ENV, SECRET_BOX_KEY, FILE_STORAGE_DIR }),
    ).toThrow();
  });

  // `NODE_ENV` decides whether the session cookie carries `Secure`; a
  // deployment that forgets it must fail here, not hand out an insecure cookie.
  it('refuses an environment without NODE_ENV', () => {
    expect(() =>
      loadEnv({ DATABASE_URL, SECRET_BOX_KEY, FILE_STORAGE_DIR }),
    ).toThrow();
  });

  /**
   * The requirement, run through `loadEnv()` — the function `main.ts` calls, so
   * this is the moment a deployment actually stops. Without the variable the
   * API does **not** start; it does not fall back to a temporary directory and
   * it does not come up healthy to answer `503` at the first upload (ADR-0014
   * no. 2).
   */
  it('refuses an environment without a directory for uploaded files', () => {
    expect(() => loadEnv({ DATABASE_URL, NODE_ENV, SECRET_BOX_KEY })).toThrow(
      /FILE_STORAGE_DIR/,
    );
    expect(() => loadEnv({ ...REQUIRED, FILE_STORAGE_DIR: '' })).toThrow(
      /FILE_STORAGE_DIR/,
    );
  });

  /**
   * The whole point of the variable: there is no fallback to clear text, so a
   * deployment that forgets the key stops here — in `main.ts`, before the
   * server listens — and not at the first form that switches on password
   * protection.
   */
  it('refuses an environment without a key for the stored secrets', () => {
    expect(() => loadEnv({ DATABASE_URL, NODE_ENV })).toThrow();
    expect(() => loadEnv({ ...REQUIRED, SECRET_BOX_KEY: '' })).toThrow();
  });

  /**
   * And the more dangerous half: a key that *looks* configured. The shared
   * schema only sees a non-empty string, so the byte length is checked right
   * here — at startup — rather than by the cipher hours later.
   */
  it('refuses a key that is present but not 32 bytes', () => {
    expect(() =>
      loadEnv({
        ...REQUIRED,
        SECRET_BOX_KEY: randomBytes(16).toString('base64'),
      }),
    ).toThrow(/SECRET_BOX_KEY/);
    expect(() =>
      loadEnv({ ...REQUIRED, SECRET_BOX_KEY: 'obviously-not-a-key' }),
    ).toThrow(/SECRET_BOX_KEY/);
  });

  it('keeps the configured key out of the startup failure', () => {
    const wrong = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadEnv({ ...REQUIRED, SECRET_BOX_KEY: wrong });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('SECRET_BOX_KEY');
    expect(message).not.toContain(wrong);
  });
});
