import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD_ENV_VAR } from '../../src/setup/create-superadmin.main';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';

/**
 * **The second path to the first administrator** (ADR-0022 no. 4) — the
 * command, for operators who never want to release the setup page.
 *
 * The command is **really started** here, as its own process, against a real
 * database. That is the point: a test that only called `createFirstSuperadmin`
 * once more would say nothing about the path an operator walks — and exactly
 * this path is the one nobody tries out before they need it. What can go wrong
 * here and would stay invisible in a function call: an argument that does not
 * arrive; an `.env` that overwrites the database; an Argon2id that does not
 * load on the script path.
 *
 * ## The forbidden cases
 *
 * - **A second run creates nothing** and ends with exit code 1. The same
 *   condition as the route, because it is the same function.
 * - **A password that is too short is rejected** — the command is no back door
 *   past the password rule.
 * - **The password stands in no output.** It comes from the environment, not
 *   from `argv`, and it does not leave again in an error message either.
 */

const execFileAsync = promisify(execFile);
const API_ROOT = resolve(__dirname, '..', '..');
const ENTRY = 'src/setup/create-superadmin.main.ts';
const PASSWORD = 'kommandozeile-2026-xyz';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe('create-superadmin', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // The application itself is booted only for the Prisma access of the
    // assertions; the command below speaks over its own connection.
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * Starts the command the way `scripts/create-superadmin.sh` starts it.
   *
   * `DATABASE_URL` is set and **must** win: `loadEnvFile()` reads the nearest
   * `.env` of the repository, and Node overwrites nothing with it that is
   * already in the environment. That the assertions below find the row in the
   * test database is the proof of that — if the command found the development
   * database, there would be nothing here.
   */
  async function run(
    args: readonly string[],
    password: string = PASSWORD,
  ): Promise<Run> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--require', '@swc-node/register', ENTRY, ...args],
        {
          cwd: API_ROOT,
          env: {
            ...process.env,
            DATABASE_URL: database?.url ?? '',
            [PASSWORD_ENV_VAR]: password,
          },
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error: unknown) {
      // `execFile` throws on an exit code other than 0 and attaches the streams
      // to the error. Read out instead of rethrown: the exit code **is** the
      // measurement result here, not the defect.
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: failure.code ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  it('weist ein zu kurzes Passwort ab und nennt es dabei nicht', async () => {
    const short = 'zu-kurz';
    const result = await run(
      ['--email', 'kurz@example.org', '--name', 'Zu Kurz'],
      short,
    );

    expect(result.code).toBe(1);
    expect(await testApp.prisma.user.count()).toBe(0);
    // The one promise that an error message easily breaks: a `ZodError`
    // carries checked values with it, and one of them is the password.
    expect(`${result.stdout}${result.stderr}`).not.toContain(short);
  }, 60_000);

  it('legt den ersten Superadministrator mit erster Organisation an', async () => {
    const result = await run([
      '--email',
      'Betrieb@Example.ORG',
      '--name',
      'Betriebsführung',
      '--tenant-short',
      'DACH',
      '--tenant-name',
      'Dachorganisation',
    ]);

    expect(result.code).toBe(0);

    const user = await testApp.prisma.user.findUniqueOrThrow({
      // Lower-cased, because the same schema path runs as in the browser.
      where: { email: 'betrieb@example.org' },
      select: {
        isSuperadmin: true,
        passwordHash: true,
        memberships: { select: { group: { select: { name: true } } } },
      },
    });
    expect(user.isSuperadmin).toBe(true);
    expect(user.passwordHash?.startsWith('$argon2id$')).toBe(true);
    expect(user.memberships).toStrictEqual([{ group: { name: 'admin' } }]);

    // The three default groups, as with every other organisation.
    expect(
      await testApp.prisma.group.count({
        where: { tenant: { shortName: 'DACH' } },
      }),
    ).toBe(3);

    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  }, 60_000);

  it('legt beim zweiten Lauf nichts an und meldet das', async () => {
    const result = await run([
      '--email',
      'zweiter@example.org',
      '--name',
      'Zweiter',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('bereits Konten');
    expect(await testApp.prisma.user.count()).toBe(1);
  }, 60_000);

  it('nimmt die beiden Organisationsangaben nur zusammen an', async () => {
    const result = await run([
      '--email',
      'halb@example.org',
      '--name',
      'Halb',
      '--tenant-short',
      'HALB',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nur zusammen');
  }, 60_000);

  it('bricht bei einer vertippten Angabe ab, statt sie zu übergehen', async () => {
    // A silently ignored `--tenant-nme` would mean „organisation skipped", and
    // nobody notices that — least of all with a command that runs exactly
    // once.
    const result = await run([
      '--email',
      'tippfehler@example.org',
      '--name',
      'Tippfehler',
      '--tenant-nme',
      'Dachorganisation',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unbekannte Angabe');
  }, 60_000);
});
