import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { readEnv } from '../tools/env-file';

/**
 * The development administrator the seed creates, resolved at
 * run time instead of written down here.
 *
 * Credentials are **never** literals in a spec. Even a placeholder password
 * committed into a test is a password committed into the repository, and the
 * next person who changes `SEED_ADMIN_PASSWORD` in their `.env` would then
 * watch the E2E suite fail for a reason no message explains. Resolution order:
 *
 * 1. the real environment (CI hands the values in),
 * 2. the local `.env`,
 * 3. `.env.example`, which documents the development defaults the seed itself
 *    falls back to (`apps/api/prisma/seed.ts`).
 *
 * Step 3 is what makes `pnpm e2e` work on a fresh clone whose `.env` is a
 * plain copy of the example — and it is the only reason the example file is
 * read at all.
 */

const EXAMPLE_FILE = fileURLToPath(new URL('../.env.example', import.meta.url));

let example: NodeJS.Dict<string> | undefined;

function fromExample(name: string): string | undefined {
  if (example === undefined) {
    try {
      example = parseEnv(readFileSync(EXAMPLE_FILE, 'utf8'));
    } catch {
      example = {};
    }
  }
  return example[name];
}

function seedValue(name: string): string {
  const value = readEnv(name) ?? fromExample(name);
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. The E2E suite signs in as the seeded administrator; ` +
        `set it in the environment or in .env (see .env.example).`,
    );
  }
  return value;
}

export const seedAdmin = {
  email: seedValue('SEED_ADMIN_EMAIL'),
  password: seedValue('SEED_ADMIN_PASSWORD'),
} as const;

/**
 * The seed's narrow account: member of **two** organisations and `viewer` in the Dachorganisation.
 *
 * It exists because the administrator cannot demonstrate either case. The
 * admin belongs to one organisation, so their login scopes a tenant unambiguously and
 * the switcher has nothing to switch; and they hold every permission, so no
 * refusal is observable through the UI. Same resolution order as above.
 */
export const seedMember = {
  email: seedValue('SEED_MEMBER_EMAIL'),
  password: seedValue('SEED_MEMBER_PASSWORD'),
} as const;

/**
 * The seed's `admin`-of-a-Organisation account: every group permission there is, and
 * explicitly **not** the superadmin. Neither `seedAdmin` —
 * who *is* the superadmin — nor `seedMember` — who holds no `admin` group
 * anywhere — can stand in for it: showing that an organisation's own admin rights do
 * not open the system settings needs someone who actually has those rights.
 * Same resolution order as above.
 */
export const seedTenantAdmin = {
  email: seedValue('SEED_TENANT_ADMIN_EMAIL'),
  password: seedValue('SEED_TENANT_ADMIN_PASSWORD'),
} as const;

/**
 * A password that is certainly not the administrator's.
 *
 * Derived rather than invented, so it cannot accidentally *be* the real one on
 * a machine that changed `SEED_ADMIN_PASSWORD` — and it stays long enough to
 * pass the client-side schema (`password: min(1).max(1024)`), which is the
 * point: the rejection under test must come from the server, not from the
 * form's own validation.
 */
export const wrongPassword = `${seedAdmin.password}-definitiv-falsch`;

/**
 * Where the signed-in browser state of the `setup` project is parked.
 *
 * `.playwright/` is already ignored by git (see `.gitignore`), which matters:
 * this file contains a live session cookie.
 */
export const authStateFile = fileURLToPath(
  new URL('../.playwright/auth/admin.json', import.meta.url),
);

/**
 * The same, for {@link seedTenantAdmin} — the `admin` of Musterstadt.
 *
 * A **second** parked session rather than a login per spec, and for the reason
 * `auth.setup.ts` gives: the whole body of evidence about an organisation that has
 * never saved its form standards runs under this identity (public colours,
 * the group editor, section-wise inheritance), and each of those cases
 * signing in for itself would spend the login budget on setup.
 *
 * It is deliberately not derived from `authStateFile` by string surgery: two
 * files, two names, and a spec picks the identity it means by importing it.
 */
export const tenantAdminStateFile = fileURLToPath(
  new URL('../.playwright/auth/tenant-admin.json', import.meta.url),
);
