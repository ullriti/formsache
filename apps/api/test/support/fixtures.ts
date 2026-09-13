import { createHash, randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import {
  ACCOUNT_INVITATION_TTL_DAYS,
  PASSWORD_RESET_LINK_MARK,
  type SmtpBlock,
} from '@formsache/shared';

import type { AccountInvitation } from '../../src/auth/invitation/account-invitation';
import { hashPassword } from '../../src/auth/password';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Fixtures for the authentication suite.
 *
 * Deliberately not the development seed: that one is a product of its own
 * requirements and would tie every auth assertion to whatever the Dachorganisation tenant
 * happens to look like. These rows state only what the tests reason about.
 */

export interface TenantFixture {
  readonly id: string;
  readonly shortName: string;
  readonly adminGroupId: string;
}

/**
 * The mail server of its own that a fixture organisation gets by default
 * (ADR-0023).
 *
 * ⚠️ **Without it nothing goes out any more since ADR-0023.** The inheritance
 * has been abolished: an empty `smtp` column means "this organisation sends
 * nothing", no longer "it inherits the installation's block". A fixture without
 * a block would therefore let every suite that sees a mail go out run silently
 * into `withhold` — nothing about that would be green, but the statement would
 * be gone.
 *
 * `auth: null` on purpose: a relay without login is a supported mode of
 * operation and the only block this module can write down without the
 * `MailSecretsService`. The values have no effect — the suites run against a
 * transport double; whoever means a real connection or credentials sets the
 * block themselves (`sealTenantBlock`).
 */
export const TEST_TENANT_SMTP_BLOCK = {
  host: 'smtp.organisation.invalid',
  port: 587,
  secure: false,
  auth: null,
  from: 'post@organisation.invalid',
} as const satisfies SmtpBlock;

/**
 * @param smtp The mail server of this organisation. `null` is **"and
 *   explicitly none"** — the state in which an organisation sends nothing
 *   (ADR-0023). It is a parameter and not a default because a suite has to
 *   *mean* it: it keeps every row of this organisation in
 *   the queue.
 */
export async function createTenant(
  prisma: PrismaService,
  shortName: string,
  smtp: SmtpBlock | null = TEST_TENANT_SMTP_BLOCK,
): Promise<TenantFixture> {
  const tenant = await prisma.tenant.create({
    data: {
      smtp: smtp ?? Prisma.DbNull,
      shortName,
      name: `Organisation ${shortName}`,
      // One of the *shipped* Logos. It used to be
      // `assets/<short>.svg`, which named no asset — harmless while nothing
      // checked, but the delivery gate now answers `null` for it, so every
      // fixture Organisation would silently have no Logo and a later test about logos
      // would be measuring the fixture rather than the code.
      logoRef: 'assets/beispiel-signet.svg',
      logoWide: false,
      // Valid hex literals, because the wire contract validates them — a
      // fixture with `red` in it would fail the response schema and blame the
      // endpoint for it.
      stripeColors: ['#212226', '#7c0800', '#cea967'],
      accentColor: '#cea967',
      headerColor: '#212226',
      canvasColor: '#e9e6df',
    },
  });

  const group = await prisma.group.create({
    data: {
      tenantId: tenant.id,
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
  });

  return { id: tenant.id, shortName, adminGroupId: group.id };
}

export interface GroupFixtureOptions {
  readonly name: string;
  readonly color?: string;
  readonly rank?: number;
}

/**
 * A further group inside a tenant, next to the `admin` one `createTenant`
 * makes.
 *
 * The isolation suite needs a tenant to hold more than one group: a test where
 * every tenant owns exactly one row cannot tell "the query is tenant-bound"
 * apart from "the query happened to return the only row there is".
 */
export async function createGroup(
  prisma: PrismaService,
  tenant: TenantFixture,
  options: GroupFixtureOptions,
): Promise<{ id: string; name: string }> {
  const group = await prisma.group.create({
    data: {
      tenantId: tenant.id,
      name: options.name,
      color: options.color ?? '#cea967',
      rank: options.rank ?? 60,
      isSystem: false,
      canBuild: true,
    },
  });
  return { id: group.id, name: group.name };
}

export interface UserFixtureOptions {
  readonly email: string;
  /** Omitted for an OIDC user, who legitimately has no password hash. */
  readonly password?: string;
  /**
   * The display name. Defaults to `Test <adresse>`.
   *
   * Added since a suite needs an account whose name carries a statement
   * („eine zweite Organisation schreibt ihn **nicht** um", ADR-0024) — before
   * that it could only be produced through the creation route, and that one has
   * since been creating an account without a password.
   */
  readonly name?: string;
  readonly tenants?: readonly TenantFixture[];
  readonly isSuperadmin?: boolean;
}

/**
 * Issuer used for the password-less fixtures.
 *
 * Since ADR-0024 a row without a password is **not** necessarily an IdP account
 * any more — a freshly invited local person has none either, and the CHECK
 * `user_local_or_oidc` allows both. This fixture nevertheless settles on the
 * IdP account, because `password: undefined` has always meant "an account that
 * logs in via SSO" here; whoever needs an **open invitation**
 * creates it through the route that issues it.
 */
const OIDC_ISSUER = 'https://idp.example.org';

export async function createUser(
  prisma: PrismaService,
  options: UserFixtureOptions,
): Promise<{ id: string; email: string }> {
  const user = await prisma.user.create({
    data: {
      // Lower-cased like the seed does: the unique index is what makes the
      // login's lookup case-insensitive.
      email: options.email.toLowerCase(),
      name: options.name ?? `Test ${options.email}`,
      passwordHash:
        options.password === undefined
          ? null
          : await hashPassword(options.password),
      oidcIssuer: options.password === undefined ? OIDC_ISSUER : null,
      oidcSubject:
        options.password === undefined ? options.email.toLowerCase() : null,
      isSuperadmin: options.isSuperadmin ?? false,
    },
  });

  for (const tenant of options.tenants ?? []) {
    await prisma.membership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        groupId: tenant.adminGroupId,
      },
    });
  }

  return { id: user.id, email: user.email };
}

/**
 * A membership in a group that is **not** `admin` — what the requirement needs.
 *
 * The permission flags are given explicitly rather than defaulted, because the
 * whole point of a test like this is the *pair*: one member with the flag, one
 * without. A fixture with a convenient default would make half of each pair
 * accidental.
 */
export async function createRestrictedMember(
  prisma: PrismaService,
  tenant: TenantFixture,
  options: {
    readonly email: string;
    readonly groupName: string;
    readonly permissions: {
      readonly canBuild?: boolean;
      readonly canViewResponses?: boolean;
      readonly canExport?: boolean;
      /**
       * The **organisation-wide** settings permission: the organisation's form
       * defaults, appearance, sending identity, SSO.
       */
      readonly canManageSettings?: boolean;
      /**
       * The settings permission **per form** (ADR-0021): form settings,
       * notifications, mail log, user permissions per form.
       *
       * To be given separately and **not** derived from `canManageSettings`:
       * exactly the combination "the one without the other" is what has to
       * prove the separation — a default that couples the two would make half
       * of every such pair accidental.
       */
      readonly canManageFormSettings?: boolean;
      /**
       * Needed: the member who must be refused there holds **all
       * four other** permissions and only lacks the one under test. A member
       * who happens to hold nothing would prove that *some* guard fires, which
       * is the trap the requirements name outright.
       */
      readonly canManageUsers?: boolean;
    };
  },
): Promise<{ id: string; email: string; groupId: string }> {
  const group = await prisma.group.create({
    data: {
      tenantId: tenant.id,
      name: options.groupName,
      color: '#5b6b52',
      rank: 20,
      isSystem: false,
      canBuild: options.permissions.canBuild ?? false,
      canViewResponses: options.permissions.canViewResponses ?? false,
      canExport: options.permissions.canExport ?? false,
      canManageSettings: options.permissions.canManageSettings ?? false,
      canManageFormSettings: options.permissions.canManageFormSettings ?? false,
      canManageUsers: options.permissions.canManageUsers ?? false,
    },
  });

  const user = await prisma.user.create({
    data: {
      email: options.email.toLowerCase(),
      name: `Test ${options.email}`,
      passwordHash: await hashPassword('test-password'),
    },
  });

  await prisma.membership.create({
    data: { tenantId: tenant.id, userId: user.id, groupId: group.id },
  });

  return { id: user.id, email: user.email, groupId: group.id };
}

/**
 * An invitation as a write operation gets it (ADR-0024).
 *
 * **Not through `AccountInvitationService`**, and that is deliberate: the tests
 * of the write side (`ScopedMembershipDelegate.createLocal`,
 * `AdminRepository.createTenant`) talk about the transaction, not about the
 * wording of the mail and not about the question whether the installation has a
 * mail server. A value made by hand keeps the two statements apart — whoever
 * wants to check the service checks it through the route.
 *
 * The `tokenHash` is the SHA-256 of the row's id and therefore **not** what the
 * real dispatch would build (there it is the HMAC over the id).
 * For everything that only asks "is the row there?" this suffices and is
 * unambiguous; whoever checks the **link** goes through the route and the real
 * signing key.
 */
export function testAccountInvitation(
  options: { readonly withToken?: boolean; readonly stampedAt?: Date } = {},
): AccountInvitation {
  const id = randomUUID();
  const stampedAt = options.stampedAt ?? new Date();
  return {
    subject: 'Formsache: Einladung zu deinem Konto',
    bodyText: `Einladung\n${PASSWORD_RESET_LINK_MARK}\n`,
    bodyHtml: `<p style="margin:0">Einladung</p>${PASSWORD_RESET_LINK_MARK}`,
    replyTo: null,
    stampedAt,
    token:
      options.withToken === false
        ? null
        : {
            id,
            tokenHash: Uint8Array.from(
              createHash('sha256').update(id, 'utf8').digest(),
            ),
            expiresAt: new Date(
              stampedAt.getTime() + ACCOUNT_INVITATION_TTL_DAYS * 86_400_000,
            ),
          },
  };
}
