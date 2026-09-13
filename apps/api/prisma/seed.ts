import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { baseUrlSchema } from '@formsache/shared';
import { z } from 'zod';

import { hashPassword } from '../src/auth/password';
import { loadEnvFile } from '../src/config/env';
import {
  INITIAL_MAIL_REVISION,
  SYSTEM_SETTING_ID,
} from '../src/system-settings/system-settings.repository';

/**
 * Development seed: the Dachorganisation tenant, its default groups and one
 * local administrator.
 *
 * Reproducible in the strict sense this needs — running it twice
 * must neither fail nor create duplicates. Every write is therefore an
 * `upsert` keyed on the natural unique column, not a `create`, and the script
 * makes no assumption about whether the database is empty.
 */

/**
 * Seed-only configuration. Deliberately *not* part of `apiEnvSchema`: these
 * variables are read by this script and never by the running API, and putting
 * them into the application's environment contract would suggest otherwise.
 */
/**
 * The default password of development — **a placeholder, not a secret**.
 *
 * It stands in `.env.example`, in this public source and in the
 * `migrate` image (ADR-0009 names that as a named exception). Precisely for
 * that reason no installation that is reachable from outside may run with it —
 * {@link refuseProductionPlaceholders} enforces that.
 */
const PLACEHOLDER_PASSWORD = 'change-me-locally';

const seedEnvSchema = z.object({
  SEED_ADMIN_EMAIL: z.email().default('admin@example.org'),
  /**
   * The second, deliberately *narrower* account.
   *
   * It is a member of two organisations and holds the `viewer` group in the Dachorganisation — so
   * the tenant switcher has something to switch between, and the permission
   * guard has someone to refuse. Without both, neither guarantee can be
   * demonstrated outside a unit test.
   */
  SEED_MEMBER_EMAIL: z.email().default('mitglied@example.org'),
  SEED_MEMBER_NAME: z.string().min(1).default('Mitglied Beispiel'),
  SEED_MEMBER_PASSWORD: z.string().min(8).default('change-me-locally'),
  /**
   * The third account: `admin` of the second organisation — every group permission
   * there is, `isSuperadmin: false` (the requirement).
   *
   * Neither of the accounts above can stand in for it: the administrator
   * above *is* the superadmin, so signing in as them can never show that a
   * organisation's own admin rights are not the same door. Without this account, „the
   * system settings' nav entry and route are closed to an organisation-Admin" could
   * only be demonstrated by an account that holds no permissions at all — the
   * fixture trap repeated in
   * `apps/api/test/system-settings/permissions.spec.ts`.
   */
  SEED_TENANT_ADMIN_EMAIL: z.email().default('orgadmin@musterstadt.example'),
  SEED_TENANT_ADMIN_NAME: z
    .string()
    .min(1)
    .default('Musterstadt Organisationsadmin'),
  SEED_TENANT_ADMIN_PASSWORD: z.string().min(8).default(PLACEHOLDER_PASSWORD),
  SEED_ADMIN_NAME: z.string().min(1).default('Administrator Beispiel'),
  /**
   * No default on purpose in production-like environments — but a development
   * default here, because what is required is a seed that simply runs. The
   * value is a placeholder, not a secret: it is documented in `.env.example`
   * and must be replaced anywhere that is reachable from outside.
   */
  SEED_ADMIN_PASSWORD: z.string().min(8).default(PLACEHOLDER_PASSWORD),
  /**
   * Where this installation answers, seen from outside
   * (`system_setting.public_base_url`) — **opt-in,
   * and deliberately without a default.**
   *
   * ## Why the knob exists at all
   *
   * The address was `PUBLIC_BASE_URL` in the `.env`, so every development and
   * test installation had one from the first minute. It was moved into the
   * database, and the third step of the requirement is explicit: no address
   * configured means **no link**, never a guessed one. That is right for a
   * production installation and it silently
   * removed the address from `pnpm dev` and `pnpm e2e`, where a Bearbeiten-Link
   * on the confirmation page is a thing under test — `e2e/response-edit.spec.ts`
   * found it, on all four of its cases.
   *
   * ## Why opt-in rather than a default here
   *
   * Two reasons, and either alone would be enough:
   *
   * 1. **There is no value to default to.** `pnpm dev`/`pnpm e2e` answer on
   *    `WEB_PORT` (5173), the container stack on `APP_PORT` (8080), and nothing
   *    tells this script which of the two is running (`docs/kb/04-build-run.md`,
   *    „Lokal gibt es zwei Adressen"). A guess would produce links to a port
   *    where nothing listens — which is exactly the failure mode the
   *    requirement's third step was written against, moved one layer down.
   * 2. **The Superadmin sets the system defaults through the
   *    interface, „ohne SQL, ohne Seed-Trick".** A seed that filled the column
   *    by default would hand that step its answer before the run begins. Unset
   *    by default, the seeded installation is exactly the fresh one; whoever
   *    needs an address says so, per run, and knows they did.
   *
   * Set it to the address the browser will actually use — `e2e/global-setup.ts`
   * passes its own `webBaseUrl`, which is the one address it cannot be wrong
   * about.
   */
  SEED_PUBLIC_BASE_URL: baseUrlSchema.optional(),
  DATABASE_URL: z.string().min(1),
});

/**
 * The second tenant, so that "tenant-bound" is observable at all.
 *
 * A single-tenant development database cannot show the difference between a
 * query that is scoped and one that simply has nothing else to return — the
 * same argument the integration fixtures make, applied to the seed. Values
 * from the handoff's example Organisation (Ortsgruppe Musterstadt).
 */
const SECOND_TENANT = {
  shortName: 'MUS',
  name: 'Ortsgruppe Musterstadt',
  logoRef: 'assets/beispiel-emblem.svg',
  logoWide: false,
  stripeColors: ['#e30000', '#cad0d3', '#131313'],
  accentColor: '#e30000',
  headerColor: '#131313',
  canvasColor: '#e9e6df',
} as const;

/** Values from the design handoff's Dachorganisation tenant, not invented here. */
const UMBRELLA_TENANT = {
  shortName: 'DACH',
  name: 'Dachorganisation',
  logoRef: 'assets/beispiel-signet.svg',
  logoWide: true,
  stripeColors: ['#212226', '#7c0800', '#cea967'],
  accentColor: '#cea967',
  headerColor: '#212226',
  canvasColor: '#e9e6df',
} as const;

/**
 * The handoff's default groups. `admin` is the system group: it always holds
 * every permission and can neither be edited nor deleted. Evaluating the flags
 * happens elsewhere — this is the data model only.
 */
const DEFAULT_GROUPS = [
  {
    name: 'admin',
    color: '#7c0800',
    rank: 100,
    isSystem: true,
    canBuild: true,
    canViewResponses: true,
    canExport: true,
    canManageSettings: true,
    canManageFormSettings: true,
    canManageUsers: true,
  },
  {
    name: 'editor',
    color: '#8a6a12',
    rank: 60,
    isSystem: false,
    canBuild: true,
    canViewResponses: true,
    canExport: true,
    canManageSettings: false,
    // ADR-0021: „wer baut, stellt auch ein" — per form, not
    // organisation-wide. The same state as `DEFAULT_GROUPS` in
    // `admin.repository.ts`, which creates the same three groups for new
    // organisations.
    canManageFormSettings: true,
    canManageUsers: false,
  },
  {
    name: 'viewer',
    color: '#5b6b52',
    rank: 20,
    isSystem: false,
    canBuild: false,
    canViewResponses: true,
    canExport: false,
    canManageSettings: false,
    canManageFormSettings: false,
    canManageUsers: false,
  },
] as const;

/**
 * Prisma's generated input types take mutable `string[]`, while the constants
 * above are `as const` so that a typo in a colour is caught here rather than in
 * the database. Copying at the call site keeps both.
 */
function mutableColors(tenant: typeof UMBRELLA_TENANT | typeof SECOND_TENANT): {
  stripeColors: string[];
} {
  return {
    stripeColors: [...tenant.stripeColors],
  };
}

/** Upserts a tenant with the handoff's default groups, and returns it. */
async function upsertTenant(
  prisma: PrismaClient,
  values: typeof UMBRELLA_TENANT | typeof SECOND_TENANT,
): Promise<{ id: string; shortName: string }> {
  const tenant = await prisma.tenant.upsert({
    where: { shortName: values.shortName },
    create: { ...values, ...mutableColors(values) },
    // Branding is re-applied so that a changed handoff value reaches an
    // existing development database; nothing here is user-owned data.
    update: { ...values, ...mutableColors(values) },
  });

  for (const group of DEFAULT_GROUPS) {
    await prisma.group.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: group.name } },
      create: { ...group, tenantId: tenant.id },
      update: { ...group },
    });
  }

  return tenant;
}

/**
 * **The seed creates a superadministrator — in production never with the
 * placeholder.**
 *
 * The comment on `SEED_ADMIN_PASSWORD` said „no default on purpose in
 * production-like environments" and *nothing* enforced that: `seed.ts` did not
 * know `NODE_ENV`. `docker compose run --rm migrate db seed` is the only
 * documented way to an administrator (`docs/kb/04-build-run.md`), and it
 * delivered `admin@example.org` with a password that stands in the public
 * repository. The `!reset null` in `docker-compose.prod.yml` did not help:
 * it only takes back the passing-on, the Zod default fills it up again —
 * exactly the sort of protection that looks like one.
 *
 * The abort names the variable and suggests the way; it names **no**
 * value.
 */
function refuseProductionPlaceholders(env: {
  SEED_ADMIN_PASSWORD: string;
  SEED_TENANT_ADMIN_PASSWORD: string;
}): void {
  /*
   * ⚠️ **The condition is turned around, and that is the point** (review
   * finding of 2026-08-12). The first version checked
   * `NODE_ENV === 'production'` — and was thereby without effect on exactly
   * the way it was meant to close: the `migrate` service got a `NODE_ENV` in
   * **no** compose file, the runtime image deliberately does not set it, so
   * `docker compose … run --rm migrate db seed` ran through the barrier with
   * `undefined`. *A protection that has to recognise an environment in order
   * to take hold takes hold nowhere that nobody has told it where it is.*
   *
   * Now it holds: the placeholder is **only** allowed if `development` or
   * `test` explicitly stands there. Everything else — nothing included — is
   * the protected case. Both compose files have since passed `NODE_ENV`
   * through to the `migrate` service, so that the documented development way
   * (the requirement: „ein Seed, der einfach läuft") keeps running.
   */
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'development' || nodeEnv === 'test') return;

  const onPlaceholder = (
    [
      ['SEED_ADMIN_PASSWORD', env.SEED_ADMIN_PASSWORD],
      ['SEED_TENANT_ADMIN_PASSWORD', env.SEED_TENANT_ADMIN_PASSWORD],
    ] as const
  )
    .filter(([, value]) => value === PLACEHOLDER_PASSWORD)
    .map(([name]) => name);

  if (onPlaceholder.length > 0) {
    throw new Error(
      `NODE_ENV=${nodeEnv ?? '(nicht gesetzt)'} und ` +
        `${onPlaceholder.join(' sowie ')} steht auf dem ` +
        'Vorgabewert aus dem öffentlichen Repository. Der Seed legt einen ' +
        'Superadministrator an — mit diesem Kennwort wäre er ab der ersten ' +
        'Minute für jeden offen. Setze die Variable, oder lege den ersten ' +
        'Zugang ohne den Seed an (docs/kb/09-betrieb.md, „Erste ' +
        'Inbetriebnahme").',
    );
  }
}

async function seed(): Promise<void> {
  loadEnvFile();
  const env = seedEnvSchema.parse(process.env);
  refuseProductionPlaceholders(env);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });

  try {
    const tenant = await upsertTenant(prisma, UMBRELLA_TENANT);
    const second = await upsertTenant(prisma, SECOND_TENANT);

    const adminGroup = await prisma.group.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenant.id, name: 'admin' } },
    });

    // Lower-cased because the unique index is what makes the login's
    // case-insensitive lookup exact (see `schema.prisma`).
    const email = env.SEED_ADMIN_EMAIL.toLowerCase();
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: env.SEED_ADMIN_NAME,
        passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
        isSuperadmin: true,
      },
      // The password is *not* re-applied on update: a developer who changed it
      // in their local database should not have it reset by a second seed run.
      update: { name: env.SEED_ADMIN_NAME },
    });

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      create: { tenantId: tenant.id, userId: user.id, groupId: adminGroup.id },
      update: { groupId: adminGroup.id },
    });

    await seedNarrowMember(prisma, env, tenant.id, second.id);
    await seedTenantAdmin(prisma, env, second.id);
    await seedPublicBaseUrl(prisma, env.SEED_PUBLIC_BASE_URL);

    // Never the password, and never the hash.
    console.info(
      `[seed] tenants=${tenant.shortName},${second.shortName} groups=${String(DEFAULT_GROUPS.length)} per tenant admin=${user.email}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The account the requirements are demonstrated with.
 *
 * Two memberships, so the login leaves the session **without** an active
 * tenant (`resolveActiveTenantId` only scopes an unambiguous one) and the
 * switcher has a job. And `viewer` in the Dachorganisation rather than `admin`, so the
 * permission guard has someone to refuse: a seed in which everybody is an
 * administrator can demonstrate that permissions exist, never that they bite.
 */
async function seedNarrowMember(
  prisma: PrismaClient,
  env: z.infer<typeof seedEnvSchema>,
  /** The `DACH` row — the Dachorganisation in which this account is `viewer`. */
  umbrellaTenantId: string,
  secondTenantId: string,
): Promise<void> {
  const email = env.SEED_MEMBER_EMAIL.toLowerCase();
  const member = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: env.SEED_MEMBER_NAME,
      passwordHash: await hashPassword(env.SEED_MEMBER_PASSWORD),
      isSuperadmin: false,
    },
    // Like the admin above: a locally changed password is not reset.
    update: { name: env.SEED_MEMBER_NAME },
  });

  const roles: { tenantId: string; group: 'viewer' | 'editor' }[] = [
    { tenantId: umbrellaTenantId, group: 'viewer' },
    // Editor in their own Organisation — which is also what makes "the permissions of
    // the *active* tenant decide" visible by hand, not just in a test.
    { tenantId: secondTenantId, group: 'editor' },
  ];

  for (const role of roles) {
    const group = await prisma.group.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: role.tenantId, name: role.group } },
    });
    await prisma.membership.upsert({
      where: {
        tenantId_userId: { tenantId: role.tenantId, userId: member.id },
      },
      create: {
        tenantId: role.tenantId,
        userId: member.id,
        groupId: group.id,
      },
      update: { groupId: group.id },
    });
  }
}

/**
 * The seed's `admin`-of-a-Organisation account (E2E case 5) —
 * every one of the six group permissions, and `isSuperadmin: false` set
 * explicitly rather than left to the column default, so a reviewer does not
 * have to check the schema to know this account is the negative case.
 *
 * Second Organisation on purpose: the Dachorganisation's `admin` group already has a member — the
 * seed's superadmin — and giving them a second, non-superadmin admin there
 * would blur which one the E2E suite means when it signs in as „the" admin.
 */
async function seedTenantAdmin(
  prisma: PrismaClient,
  env: z.infer<typeof seedEnvSchema>,
  secondTenantId: string,
): Promise<void> {
  const email = env.SEED_TENANT_ADMIN_EMAIL.toLowerCase();
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: env.SEED_TENANT_ADMIN_NAME,
      passwordHash: await hashPassword(env.SEED_TENANT_ADMIN_PASSWORD),
      isSuperadmin: false,
    },
    // Like the two accounts above: a locally changed password is not reset.
    update: { name: env.SEED_TENANT_ADMIN_NAME, isSuperadmin: false },
  });

  const adminGroup = await prisma.group.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: secondTenantId, name: 'admin' } },
  });
  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: secondTenantId, userId: admin.id } },
    create: {
      tenantId: secondTenantId,
      userId: admin.id,
      groupId: adminGroup.id,
    },
    update: { groupId: adminGroup.id },
  });
}

/**
 * Writes `system_setting.public_base_url` — **only when
 * `SEED_PUBLIC_BASE_URL` was given**, see the schema entry for why that is
 * opt-in.
 *
 * Three properties, each of which a plain `upsert` would have lost:
 *
 * 1. **Absent means untouched, not cleared.** A developer who set the address
 *    in the interface keeps it across the next `pnpm --filter @formsache/api seed`,
 *    the same posture the three accounts above take with their passwords.
 * 2. **Idempotent down to the lock.** The row is only written when the stored
 *    value actually differs, so a second run does not move `mail_revision` —
 *    a counter that ticked on every seed would hand a 409 to a settings page
 *    that was loaded before it and had changed nothing.
 * 3. **`mail_revision` is incremented when it does write.** That counter is the
 *    optimistic lock of the mail block; a page loaded *before*
 *    this write must be refused rather than silently overwrite it.
 *
 * The row is created with the same number `SystemSettingsRepository.writeMail`
 * would leave behind on a fresh installation — „hat schon einmal gespeichert"
 * is one state there, and it has to be one state here too.
 */
async function seedPublicBaseUrl(
  prisma: PrismaClient,
  baseUrl: string | undefined,
): Promise<void> {
  if (baseUrl === undefined) {
    return;
  }

  const current = await prisma.systemSetting.findUnique({
    where: { id: SYSTEM_SETTING_ID },
    select: { publicBaseUrl: true },
  });

  if (current === null) {
    await prisma.systemSetting.create({
      data: {
        id: SYSTEM_SETTING_ID,
        publicBaseUrl: baseUrl,
        mailRevision: INITIAL_MAIL_REVISION + 1,
      },
    });
  } else if (current.publicBaseUrl !== baseUrl) {
    await prisma.systemSetting.update({
      where: { id: SYSTEM_SETTING_ID },
      data: { publicBaseUrl: baseUrl, mailRevision: { increment: 1 } },
    });
  }

  // The address is not a secret and being able to read it back is the point:
  // a link built on the wrong port is the failure this knob exists to prevent.
  console.info(`[seed] system public_base_url=${baseUrl}`);
}

seed().catch((error: unknown) => {
  console.error('[seed] failed:', error);
  process.exitCode = 1;
});
