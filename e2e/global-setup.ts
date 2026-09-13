import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { webBaseUrl } from './env';
import { openInstanceMailStore, recordInstanceMail } from './instance-mail';
import { startSmtpCatcher } from './smtp-catcher';

/**
 * Brings the database into a known state before a single test runs: schema
 * migrated, **data emptied**, seed applied (the requirements).
 *
 * Without this the suite would sign in as an account that may or may not
 * exist — a green run would then mean "somebody happened to have seeded this
 * machine", which is not evidence of anything. Emptying is the same argument
 * one step further: a suite that runs on top of its own history measures that
 * history too, and did (see `apps/api/prisma/reset-data.ts`). **`pnpm e2e`
 * therefore owns the database it points at.**
 *
 * Applying the seed on every run is safe by construction: * for an idempotent seed, and `apps/api/prisma/seed.ts` upserts on the natural
 * unique columns. It deliberately does **not** reset an existing password, so
 * a database seeded once with a different `SEED_ADMIN_PASSWORD` keeps it — that
 * is the one failure mode this step cannot repair, and `auth.setup.ts` reports
 * it as such.
 *
 * Nothing here is skipped when the database is unreachable. A suite that
 * quietly passes over its own precondition is worse than a red one
 * (`CONTRIBUTING.md`), so every failure below aborts the run with the command
 * that failed and the next step to take.
 *
 * **`DATABASE_URL` is deliberately not passed in.** `apps/api/prisma.config.ts`
 * loads the nearest `.env` itself; letting these commands inherit a bare
 * environment is what keeps that true — if the config ever stops doing it, the
 * E2E run says so instead of papering over it.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Step {
  readonly label: string;
  readonly args: readonly string[];
  /** What the operator should do when this step fails. */
  readonly remedy: string;
  /** Added on top of the inherited environment for this step alone. */
  readonly env?: Readonly<Record<string, string>>;
}

const STEPS: readonly Step[] = [
  {
    label: 'prisma migrate deploy',
    args: ['--filter', '@formsache/api', 'exec', 'prisma', 'migrate', 'deploy'],
    remedy:
      'Check that DATABASE_URL in .env points at a reachable server and that ' +
      'apps/api/prisma.config.ts still loads .env.',
  },
  {
    /*
      Between migrating and seeding, because it needs the tables to exist and
      the seed has to put the fixtures back afterwards.

      Nothing could delete a form before recently, so every run used to leave its
      forms behind and the next run measured them too. Two stalls of ~2.8 s
      inside one `newForm`, six of seven failures in one run, and none of it
      visible in CI — see the header of `apps/api/prisma/reset-data.ts` for the
      measurement. **`pnpm e2e` owns the database it points at**; that contract
      is stated in `docs/kb/04-build-run.md`.
    */
    label: 'reset data',
    args: ['--filter', '@formsache/api', 'run', 'reset-data'],
    remedy:
      'The suite empties its database before every run. Point DATABASE_URL at ' +
      'a database you are willing to lose, or see apps/api/prisma/reset-data.ts.',
  },
  {
    label: 'prisma db seed',
    args: ['--filter', '@formsache/api', 'run', 'seed'],
    remedy: 'See apps/api/prisma/seed.ts for what the seed expects.',
    /*
      The one precondition this suite has to state itself.

      The base address of an installation used to be `PUBLIC_BASE_URL` in the
      `.env`, so it was simply there; it moved into
      `system_setting.public_base_url`, and an installation
      without one hands out **no** Bearbeiten-Link rather than a guessed one.
      An unconfigured E2E database therefore made `response-edit.spec.ts` fail
      on all four of its cases — correctly: it was measuring a fresh
      installation, which is not what this suite is here to measure.

      `webBaseUrl` rather than a literal, and that is the whole reason this
      lives here instead of in the seed's own defaults: `pnpm e2e` answers on
      `WEB_PORT` (5173) and the container stack on `APP_PORT` (8080)
      (`docs/kb/04-build-run.md`), and `E2E_BASE_URL` can move it anywhere. This
      file is the one place that already knows which of them the browser will
      open — `playwright.config.ts` builds its own `baseURL` from the same
      constant, so the address under test and the address in the links cannot
      drift apart.

      Passed per step rather than exported into `process.env`: nothing else in
      this run may pick it up (see the file header on `NODE_ENV`).
    */
    env: { SEED_PUBLIC_BASE_URL: webBaseUrl },
  },
];

/** Postgres is not answering — by far the most common cause, so it is named. */
const UNREACHABLE = [
  "Can't reach database server",
  'ECONNREFUSED',
  'Connection refused',
  'server closed the connection',
];

function looksUnreachable(output: string): boolean {
  return UNREACHABLE.some((marker) => output.includes(marker));
}

function run(step: Step): void {
  const result = spawnSync('pnpm', [...step.args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Inherited so a wrong `DATABASE_URL` in the shell beats `.env` here
    // exactly as it does for the API itself.
    env: { ...process.env, ...step.env },
  });

  if (result.error !== undefined) {
    throw new Error(
      `[e2e] could not run "${step.label}": ${result.error.message}\n` +
        'Is pnpm on PATH? `corepack enable` provides the pinned version.',
    );
  }

  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const hint = looksUnreachable(output)
    ? 'The database is not answering. Start it with: pg_ctlcluster 16 main start\n' +
      '(or `docker compose up -d db` where a Docker daemon is available).'
    : step.remedy;

  throw new Error(
    `[e2e] database preparation failed at "${step.label}" (exit ${String(result.status)}).\n` +
      `${hint}\n\n--- command output ---\n${output}`,
  );
}

/**
 * And the one mail server the installation has for this run.
 *
 * **Why this stands here and not in a spec.** Since ADR-0024 no account comes
 * into being without an invitation and no invitation without the mail server of
 * the *installation* — so every file that creates a person needs a
 * configured `system_setting` mail half. That is an installation-wide
 * single row, and `fullyParallel` would let three files of the same project
 * write to it at the same time. One for the whole run is the
 * resolution; the whole reasoning stands in `instance-mail.ts`.
 *
 * It runs in the **main process**, which lives until the last worker. What it
 * catches goes line by line into a file, because the workers are their own
 * processes and never see its `messages`.
 *
 * It is not entered here but in `auth.setup.ts`: that needs
 * a signed-in superadmin session, and that comes into being there.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const step of STEPS) {
    run(step);
  }
  console.info('[e2e] database migrated and seeded');

  const catcher = await startSmtpCatcher('e2e-instance', {
    onMessage: recordInstanceMail,
  });
  openInstanceMailStore(catcher.port);
  console.info(
    `[e2e] instance mail catcher on 127.0.0.1:${String(catcher.port)}`,
  );

  // Playwright calls the return value of `globalSetup` after the last test —
  // without it the listener would stay open and the process would hang at the
  // end.
  return async () => {
    await catcher.close();
  };
}
