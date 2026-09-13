import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * **The seed creates a superadministrator — and in production never with the
 * default password from the public repository** (review finding of
 * 2026-08-12).
 *
 * `SEED_ADMIN_PASSWORD` carried the Zod default `change-me-locally`, the comment
 * next to it claimed „no default on purpose in production-like environments",
 * and **nothing** enforced that: `seed.ts` did not know `NODE_ENV`. Since
 * `docker compose run --rm migrate db seed` is the only documented way to
 * an administrator, the documented way delivered an account whose
 * password stands in this repository.
 *
 * **The script itself is run**, as a child process, not an exported
 * function out of it. The case needs no database — the abort lies
 * before the first query, and exactly that is part of the promise.
 *
 * ⚠️ **What this file alone does *not* prove** (review finding of 2026-08-12,
 * and the reason for the second version of the lock): it **sets** `NODE_ENV`
 * itself. Whether the value arrives at all on the documented way is a
 * question for `docker-compose*.yml` and is measured there —
 * `scripts/tests/compose-prod.test.sh` demands it at the `migrate` service. The first
 * version checked `NODE_ENV === 'production'` and was therefore without effect
 * exactly there: the `migrate` service got no `NODE_ENV` at all. Since then the
 * condition is turned around — the placeholder is allowed **only** for
 * `development`/`test` —, and the case "any other value" below is the
 * proof of it.
 *
 * *Counter-check:* remove `refuseProductionPlaceholders(env)` from `seed()` →
 * both cases below turn red (the seed keeps running and fails only at
 * the missing database, with a completely different message).
 */
describe('der Seed in einer Produktionsumgebung (Review 2026-08-12)', () => {
  // `apps/api` is CommonJS (`"type": "commonjs"`), `import.meta` does not exist
  // here — the path therefore comes from `__dirname`.
  const API_ROOT = resolve(__dirname, '..', '..');

  async function seedWith(
    env: Record<string, string>,
  ): Promise<{ code: number; output: string }> {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ['--require', '@swc-node/register', 'prisma/seed.ts'],
        {
          cwd: API_ROOT,
          env: {
            ...process.env,
            // An address that does not exist: if the run reaches the database,
            // it fails **differently** — and the case below sees the
            // difference.
            DATABASE_URL:
              'postgresql://nobody:nothing@127.0.0.1:1/keine-datenbank',
            ...env,
          },
        },
      );
      return { code: 0, output: stdout + stderr };
    } catch (error: unknown) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: failure.code ?? 1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  }

  it('bricht ab, wenn das Kennwort auf dem Platzhalter steht', async () => {
    const { code, output } = await seedWith({ NODE_ENV: 'production' });

    expect(code).not.toBe(0);
    expect(output).toContain('SEED_ADMIN_PASSWORD');
    expect(output).toContain('Superadministrator');
    // And it did **not** get as far as the database — otherwise its error would stand there.
    expect(output).not.toContain('keine-datenbank');
  }, 60_000);

  it('nennt auch das Organisationsadmin-Kennwort, wenn beide auf dem Platzhalter stehen', async () => {
    const { output } = await seedWith({
      NODE_ENV: 'production',
      SEED_ADMIN_PASSWORD: 'ein-echtes-langes-kennwort',
    });

    expect(output).toContain('SEED_TENANT_ADMIN_PASSWORD');
    expect(output).not.toContain('SEED_ADMIN_PASSWORD steht');
  }, 60_000);

  it('lehnt auch jeden anderen Wert ab, nicht nur „production"', async () => {
    // The actual protection: everything except `development`/`test` is the
    // protected case — **including a missing `NODE_ENV`**, as would be the case in
    // the `migrate` container without the compose line.
    const { code, output } = await seedWith({ NODE_ENV: 'staging' });

    expect(code).not.toBe(0);
    expect(output).toContain('Superadministrator');
    expect(output).toContain('NODE_ENV=staging');
  }, 60_000);

  it('lässt die Entwicklung in Ruhe — dort ist der Platzhalter der Zweck', async () => {
    const { output } = await seedWith({ NODE_ENV: 'development' });

    // Without `NODE_ENV=production` the lock does not take hold; the run keeps
    // going and fails at the address above. That is the proof that the
    // lock strikes **only** in production: a seed that no longer ran
    // locally would be the bug the requirement explicitly rules out.
    expect(output).not.toContain('Superadministrator');
  }, 60_000);
});
