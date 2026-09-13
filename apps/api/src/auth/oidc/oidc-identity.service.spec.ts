import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { OidcIdentityService } from './oidc-identity.service';

/**
 * **The quietest refusal of the whole login path** — and the line it was
 * missing.
 *
 * A provider confirms somebody, the five conditions of the invitation find
 * nothing, the browser gets `abgelehnt`. The class comment of
 * {@link OidcIdentityService} already promised „an operator finds the
 * difference in the log line" — for **this** branch the line did not exist.
 * When setting things up this is the case one meets most often: one tries SSO
 * with one's own account, which has a password, and ADR-0012 forbids every
 * provider to take over a local account — rightly, only invisibly.
 *
 * Every case again checks both: the reason stands in the log, **and** the
 * answer to the caller stays the same `no-account` for every reason (ADR-0012
 * no. 3 step 3 — otherwise the login page becomes the directory of the
 * installation).
 */

const ISSUER = 'https://idp.alpha.invalid/realms/demo';
const TENANT = '019ff500-0000-7000-8000-0000000000a1';
const ADDRESS = 'max.mustermann@verein.example';

/** The line that matters here — the double sits on the prototype. */
function captureLog() {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(
      (message: unknown): void => {
        lines.push(String(message));
      },
    );
  }
  return () => lines.join('\n');
}

/**
 * What `prisma.user` is asked in this flow — and nothing else.
 *
 * `findUnique` is asked two things: for the pair *(issuer, subject)* and for
 * the address. The double tells the two apart by the shape of the `where`, the
 * way the service poses them; one that always answered the same would blur the
 * very difference this is about.
 */
function prismaWith(byAddress: {
  readonly row: {
    readonly oidcIssuer: string | null;
    readonly oidcSubject: string | null;
    readonly memberships: readonly { readonly tenantId: string }[];
  } | null;
  readonly hasPassword?: boolean;
}) {
  const count = vi.fn(() => Promise.resolve(byAddress.hasPassword ? 1 : 0));
  const findUnique = vi.fn((args: { where: Record<string, unknown> }) =>
    Promise.resolve(
      'oidcIssuer_oidcSubject' in args.where ? null : byAddress.row,
    ),
  );
  // No invitation meets the five conditions.
  const updateMany = vi.fn(() => Promise.resolve({ count: 0 }));
  return {
    prisma: {
      user: { findUnique, updateMany, count },
    } as unknown as PrismaService,
    count,
    findUnique,
    updateMany,
  };
}

let read: () => string;

beforeEach(() => {
  read = captureLog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warum keine Einladung eingelöst werden konnte', () => {
  it('sagt, dass zu der Adresse überhaupt kein Konto gehört', async () => {
    const { prisma } = prismaWith({ row: null });
    const identities = new OidcIdentityService(prisma);

    await expect(
      identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT),
    ).resolves.toStrictEqual({ outcome: 'no-account' });

    expect(read()).toContain('no account carries this address');
  });

  /**
   * **The case at the first setting up.** The operator tries SSO with their own
   * account, which has a password. The rule is right and stays —
   * `passwordHash: null` in the `where` is what keeps every organisation that
   * may configure an issuer from claiming a superadmin's account. What was
   * missing was the line.
   */
  it('sagt, dass die Adresse einem lokalen Konto gehört', async () => {
    const { prisma } = prismaWith({
      row: { oidcIssuer: null, oidcSubject: null, memberships: [] },
      hasPassword: true,
    });
    const identities = new OidcIdentityService(prisma);

    await expect(
      identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT),
    ).resolves.toStrictEqual({ outcome: 'no-account' });

    expect(read()).toContain('belongs to a local account');
  });

  it('sagt, dass das Konto längst an ein Subject gebunden ist', async () => {
    const { prisma } = prismaWith({
      row: {
        oidcIssuer: ISSUER,
        oidcSubject: 'sub-von-frueher',
        memberships: [{ tenantId: TENANT }],
      },
    });
    const identities = new OidcIdentityService(prisma);

    await identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT);

    expect(read()).toContain('already bound to a subject');
    // The foreign subject is a person's id at their provider.
    expect(read()).not.toContain('sub-von-frueher');
  });

  it('sagt, dass die Einladung mit einem anderen Issuer gestempelt ist', async () => {
    const { prisma } = prismaWith({
      row: {
        oidcIssuer: 'https://idp.beta.invalid/realms/demo',
        oidcSubject: null,
        memberships: [{ tenantId: TENANT }],
      },
    });
    const identities = new OidcIdentityService(prisma);

    await identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT);

    expect(read()).toContain('stamped with a different issuer');
    // The foreign value is not — it stands in the tenant administration.
    expect(read()).not.toContain('idp.beta.invalid');
  });

  /**
   * ADR-0012 no. 3a: an operator who runs **one** Keycloak realm with one
   * client per organisation shares the issuer — then the stamp separates
   * nobody any more, and the membership is the condition that does.
   */
  it('sagt, dass die Einladung einer anderen Organisation gehört', async () => {
    const { prisma } = prismaWith({
      row: { oidcIssuer: ISSUER, oidcSubject: null, memberships: [] },
    });
    const identities = new OidcIdentityService(prisma);

    await identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT);

    expect(read()).toContain('belongs to another organisation');
  });

  it('nennt die Adresse maskiert und die Organisation, an der es geschah', async () => {
    const { prisma } = prismaWith({ row: null });
    const identities = new OidcIdentityService(prisma);

    await identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT);

    const written = read();
    // The domain is the information — it shows „the provider delivers the
    // `upn` instead of the mail address" at a glance. The local part is not.
    expect(written).toContain('m***@verein.example');
    expect(written).not.toContain('max.mustermann');
    expect(written).toContain(TENANT);
    expect(written).toContain(ISSUER);
  });

  it('lädt den Passwort-Hash nicht, sondern zählt ihn', async () => {
    // The hash has no business in any object of this module — `count` answers
    // the question without loading it.
    const { prisma, count, findUnique } = prismaWith({
      row: { oidcIssuer: null, oidcSubject: null, memberships: [] },
      hasPassword: true,
    });
    const identities = new OidcIdentityService(prisma);

    await identities.resolve(ISSUER, 'sub-1', ADDRESS, TENANT);

    expect(count).toHaveBeenCalledOnce();
    const asked = findUnique.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .join(' ');
    expect(asked).not.toContain('passwordHash');
  });

  /**
   * The branch **above it**: without a confirmed address step 2 cannot be
   * expressed at all, and the line for it already existed. It stands here so
   * that the two paths can be told apart — and so that the additional queries
   * of this branch demonstrably do **not** run.
   */
  it('fragt bei fehlendem Adress-Claim gar nicht erst nach einer Einladung', async () => {
    const { prisma, count, updateMany } = prismaWith({ row: null });
    const identities = new OidcIdentityService(prisma);

    await expect(
      identities.resolve(ISSUER, 'sub-1', null, TENANT),
    ).resolves.toStrictEqual({ outcome: 'no-account' });

    expect(read()).toContain('carried no verified e-mail claim');
    expect(updateMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });
});
