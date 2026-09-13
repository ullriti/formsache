import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { setupRequestSchema } from '@formsache/shared';
import { z } from 'zod';

import { hashPassword } from '../auth/password';
import { loadEnvFile } from '../config/env';
import { createFirstSuperadmin } from './first-superadmin';

/**
 * **`create-superadmin` — the second way to the first administrator** (ADR-0022
 * no. 4), for operators who never want to release the setup page: behind
 * a proxy, in an environment in which the application may only be reachable
 * once it **is** set up.
 *
 * Called through `scripts/create-superadmin.sh`, which carries the operation and the
 * password entry; in development directly through
 * `pnpm --filter @formsache/api create-superadmin`, in operation inside the image through
 * `node dist/setup/create-superadmin.main.js`.
 *
 * ## What it is **not**
 *
 * Not a second creation path. It calls the same function as the route
 * (`createFirstSuperadmin`) with the same condition, the same advance lock and
 * the same transaction. Two versions would be two opportunities to lose the
 * uniqueness — and this one would run unobserved on a
 * server. What this file contributes is only the operation and the output.
 *
 * ## Why the password is not in `argv`
 *
 * A `--password` on the command line is in `ps`, in the shell history
 * and in every process log that records along — for a password that unlocks the
 * whole installation from the next moment on. It therefore comes
 * exclusively from {@link PASSWORD_ENV_VAR}; the entry itself (hidden,
 * typed twice) is done by the script above it. This file receives and
 * checks, it does not ask.
 */

/**
 * The environment variable the password comes from — **the only source**.
 *
 * As a constant and not as a string in two places: the second place
 * is `scripts/create-superadmin.sh`, and a typo there would be a command
 * that says „no password given" although one was entered.
 * `scripts/tests/create-superadmin.test.sh` holds the two spellings against each other.
 */
export const PASSWORD_ENV_VAR = 'FORMSACHE_ADMIN_PASSWORD';

/** What is displayed when something is missing or `--help` arrives. */
const USAGE = `create-superadmin — der erste Superadministrator einer Installation

  --email <adresse>          Anmeldeadresse (Pflicht)
  --name  <name>             Anzeigename (Pflicht)
  --tenant-short <kurzname>  erste Organisation: Kurzname (optional)
  --tenant-name  <name>      erste Organisation: Name (optional)

Das Passwort kommt aus ${PASSWORD_ENV_VAR} und niemals von der Kommandozeile.
Die beiden --tenant-Angaben gelten nur zusammen; ohne sie entsteht ein
Superadministrator ohne Organisation, was ein gültiger Endzustand ist.`;

/**
 * The command line, parsed rather than read.
 *
 * `--name value` in two pieces, not `--name=value`: that is the form
 * `scripts/create-superadmin.sh` produces, and a second accepted form would be
 * a second place at which a value arrives wrongly. An unknown word
 * aborts instead of being quietly ignored — a mistyped `--tenant-nme`
 * would otherwise mean „organisation skipped", and nobody notices that.
 */
function parseArgs(argv: readonly string[]): Record<string, string> {
  const known = new Set([
    '--email',
    '--name',
    '--tenant-short',
    '--tenant-name',
  ]);
  const values: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === undefined || !known.has(flag)) {
      throw new Error(`Unbekannte Angabe: ${flag ?? '(leer)'}\n\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} braucht einen Wert.\n\n${USAGE}`);
    }
    values[flag] = value;
  }

  return values;
}

const cliEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  [PASSWORD_ENV_VAR]: z
    .string()
    .min(1, `${PASSWORD_ENV_VAR} ist nicht gesetzt.`),
});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.info(USAGE);
    return;
  }

  loadEnvFile();
  const env = cliEnvSchema.parse(process.env);
  const args = parseArgs(argv);

  const short = args['--tenant-short'];
  const tenantName = args['--tenant-name'];
  if ((short === undefined) !== (tenantName === undefined)) {
    throw new Error(
      `--tenant-short und --tenant-name gelten nur zusammen.\n\n${USAGE}`,
    );
  }

  // **The same schema as the route.** Not „roughly the same rules": the
  // minimum length of the password, the normalisation of the address and the
  // character set of the short name are the same here as in the browser, because it is
  // the same schema. An account that came into being over this way with a weaker
  // password would be the back door inside the front door.
  const request = setupRequestSchema.parse({
    admin: {
      email: args['--email'],
      name: args['--name'],
      password: env[PASSWORD_ENV_VAR],
    },
    tenant:
      short === undefined || tenantName === undefined
        ? null
        : { shortName: short, name: tenantName },
  });

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  try {
    const outcome = await createFirstSuperadmin(prisma, {
      email: request.admin.email,
      name: request.admin.name,
      passwordHash: await hashPassword(request.admin.password),
      tenant: request.tenant,
    });

    if (outcome.kind === 'already-set-up') {
      // No error abort with a stack trace: this is a result, not a defect.
      // An operator who runs the command twice should read what is the case.
      console.error(
        '[create-superadmin] Diese Installation hat bereits Konten — es wurde nichts angelegt.',
      );
      process.exitCode = 1;
      return;
    }

    // The address is deliberately in the output and the password deliberately is not:
    // „which account came into being" is the confirmation the operator
    // waits for, and it is in the login form a moment later anyway.
    console.info(
      `[create-superadmin] angelegt: ${request.admin.email}` +
        (request.tenant === null
          ? ' (ohne Organisation)'
          : ` (Organisation ${request.tenant.shortName})`),
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Execution happens only when this module is **the one that was started**.
 *
 * Without this condition the command would already run on `import` — and the first
 * to notice that would have been `create-superadmin.spec.ts`: the suite
 * imports {@link PASSWORD_ENV_VAR} from here so that the spelling of the
 * variable does not stand there twice, and the import alone would have started the command in the
 * test process. That was measured while writing it — a
 * „fehlgeschlagen: FORMSACHE_ADMIN_PASSWORD" in the middle of the run, from a
 * process that never wanted to set anything up, and with it a case that would have been
 * green for the wrong reason.
 */
if (require.main === module) {
  runFromCommandLine();
}

function runFromCommandLine(): void {
  main().catch((error: unknown) => {
    // Only the message, never the object: a `ZodError` carries the checked values
    // with it, and one of them is the password.
    console.error(
      '[create-superadmin] fehlgeschlagen:',
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')
        : error instanceof Error
          ? error.message
          : 'unbekannter Fehler',
    );
    process.exitCode = 1;
  });
}
