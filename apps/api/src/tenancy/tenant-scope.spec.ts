import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { AccountInvitation } from '../auth/invitation/account-invitation';
import {
  ScopedGroupDelegate,
  ScopedMembershipDelegate,
  ScopedTenantDelegate,
  type OidcWrite,
} from './tenant-scope';

/**
 * `ScopedGroupDelegate.removeIfEmpty` (the requirement follow-up), against a
 * fake `PrismaService` rather than a real database — a unit-level
 * reproduction the earlier integration test (`test/tenant-admin/groups.spec.ts`,
 * „spends exactly one $transaction on deleting an empty group") could not be
 * (review finding).
 *
 * That test spied on `PrismaService.$transaction` and asserted it was called
 * **once**. It measures the wrong thing: the old, racy shape —
 * `ScopedMembershipDelegate.memberCounts()` as a plain statement, then a
 * separate `ScopedGroupDelegate.remove(id)` whose own body called
 * `this.delegate.deleteMany(...)`, no `$transaction` anywhere — spends
 * **zero** `$transaction` calls, not one with the count and the delete
 * outside it. A count of `$transaction` calls cannot tell "count and delete
 * share one transaction" apart from "neither uses one" without also knowing
 * what a *correct* count should be for whichever shape is running — and it
 * would stay green for a shape that opened a transaction for the delete alone
 * and counted beside it, which is exactly the race the follow-up closed.
 *
 * What actually distinguishes the two shapes is *which* statements run
 * through the transaction's own `tx`, in what order. A fake `PrismaService`
 * whose `$transaction` hands the callback a **recording** stand-in for `tx`
 * can tell that apart deterministically: `membership.count` has to be called
 * on `tx`, `group.deleteMany` has to be called on the same `tx`, and
 * `membership.count` has to run first — a plain client method reached for
 * instead of `tx`'s has nothing recording it and throws (`fakePrisma` below
 * gives the plain client no `membership`/`group` delegates at all), and a
 * delete issued before the count would show up out of order.
 */
describe('ScopedGroupDelegate.removeIfEmpty', () => {
  const TENANT_ID = '019fb000-0000-7000-8000-000000000001';
  const GROUP_ID = '019fb000-0000-7000-8000-000000000002';

  /**
   * A fake `PrismaService` whose `$transaction` hands the callback a `tx`
   * that records every call made on it, in order.
   *
   * `membership.count` and `group.deleteMany` are the only two members this
   * delegate ever asks of a transaction, so a fake needs no more. The plain
   * client (`prisma.membership`, `prisma.group`) is deliberately absent: a
   * delegate that regressed to counting or deleting on the plain client
   * instead of on `tx` throws `TypeError: Cannot read properties of
   * undefined`, which fails this test for the right reason instead of
   * passing it by accident.
   */
  function fakePrisma(memberCount: number): {
    prisma: PrismaService;
    calls: string[];
    transaction: ReturnType<typeof vi.fn>;
  } {
    const calls: string[] = [];
    const tx = {
      membership: {
        count: vi.fn(() => {
          calls.push('membership.count');
          return Promise.resolve(memberCount);
        }),
      },
      group: {
        deleteMany: vi.fn(() => {
          calls.push('group.deleteMany');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    // Bound out to its own variable, not read back off `prisma.$transaction`
    // at the assertion site: `PrismaService` declares `$transaction` as a
    // method, and `@typescript-eslint/unbound-method` flags a reference to it
    // detached from its receiver — exactly what `expect(prisma.$transaction)`
    // would be. The mock itself has no `this` to lose, so keeping the
    // reference here is what the rule actually asks for, not a workaround.
    const transaction = vi.fn(
      (callback: (fakeTx: typeof tx) => Promise<unknown>) => callback(tx),
    );
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    return { prisma, calls, transaction };
  }

  it('counts and deletes inside one transaction, count strictly before delete', async () => {
    const { prisma, calls, transaction } = fakePrisma(0);
    const delegate = new ScopedGroupDelegate(prisma, TENANT_ID);

    const outcome = await delegate.removeIfEmpty(GROUP_ID);

    expect(outcome).toEqual({ kind: 'removed' });
    expect(calls).toEqual(['membership.count', 'group.deleteMany']);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of "decided in one transaction": a non-zero count must
   * stop the method before it ever reaches the delete, inside the same `tx`
   * — not as a separate check the caller could race against.
   */
  it('never reaches the delete when the count is not zero', async () => {
    const { prisma, calls } = fakePrisma(2);
    const delegate = new ScopedGroupDelegate(prisma, TENANT_ID);

    const outcome = await delegate.removeIfEmpty(GROUP_ID);

    expect(outcome).toEqual({ kind: 'has-members', memberCount: 2 });
    expect(calls).toEqual(['membership.count']);
  });
});

/**
 * `ScopedTenantDelegate.updateOidc` — **the configuration and the stamps of the
 * open invitations in one transaction** (Review-Runde 5 no. 3).
 *
 * Against a fake `PrismaService` for the same reason the block above is: what
 * has to be shown is *which* statements run through the transaction's own `tx`
 * and in what order, and a count of `$transaction` calls cannot tell that
 * apart. The integration half — that a re-stamped invitation is really redeemed
 * by a login, and that a foreign one is really not — needs a database and
 * stands in `test/auth/oidc-issuer-change.spec.ts`; this one pins the shape.
 *
 * The reproduction of the finding: drop the `user.updateMany` from `updateOidc`
 * and „re-stamps …" below goes red on the recorded call list, not merely on a
 * count.
 */
describe('ScopedTenantDelegate.updateOidc', () => {
  const TENANT_ID = '019fb000-0000-7000-8000-000000000011';
  const OLD_ISSUER = 'https://idp.alt.invalid/realms/hv';
  const NEW_ISSUER = 'https://idp.neu.invalid/realms/hv';

  /** The block the tab sends, with only the issuer worth varying here. */
  function block(oidcIssuer: string | null): OidcWrite {
    return {
      oidcEnabled: oidcIssuer !== null,
      oidcIssuer,
      oidcClientId: 'formsache',
      oidcScopes: ['openid', 'email'],
      oidcEmailClaim: 'email',
      oidcEmailVerifiedClaim: 'email_verified',
      oidcButtonLabel: null,
      oidcClientSecret: null,
    };
  }

  /**
   * A fake client whose `$transaction` hands the callback a recording `tx`.
   *
   * The plain client carries **no** `tenant` and no `user` delegate: a shape
   * that wrote the configuration or the stamps outside the transaction would
   * throw here rather than pass by accident. (`this.delegate = prisma.tenant`
   * in the constructor stays `undefined`, which is exactly that trap.)
   */
  function fakePrisma(options: {
    readonly before: string | null;
    readonly tenantRowExists?: boolean;
    readonly restamped?: number;
  }): {
    prisma: PrismaService;
    calls: string[];
    userUpdateMany: ReturnType<typeof vi.fn>;
  } {
    const exists = options.tenantRowExists ?? true;
    const calls: string[] = [];
    const userUpdateMany = vi.fn(() => {
      calls.push('user.updateMany');
      return Promise.resolve({ count: options.restamped ?? 0 });
    });
    const tx = {
      tenant: {
        findUnique: vi.fn(() => {
          calls.push('tenant.findUnique');
          return Promise.resolve(
            exists ? { oidcIssuer: options.before } : null,
          );
        }),
        updateMany: vi.fn(() => {
          calls.push('tenant.updateMany');
          return Promise.resolve({ count: exists ? 1 : 0 });
        }),
      },
      user: { updateMany: userUpdateMany },
    };
    const prisma = {
      $transaction: vi.fn((callback: (fakeTx: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    return { prisma, calls, userUpdateMany };
  }

  it('re-stamps the open invitations of this organisation when the issuer changes', async () => {
    const { prisma, calls, userUpdateMany } = fakePrisma({
      before: OLD_ISSUER,
      restamped: 2,
    });
    const delegate = new ScopedTenantDelegate(prisma, TENANT_ID);

    const result = await delegate.updateOidc(block(NEW_ISSUER));

    expect(result).toEqual({ written: true, restamped: 2 });
    // Read before the write, written before the stamps travel — all three on
    // the same `tx`.
    expect(calls).toEqual([
      'tenant.findUnique',
      'tenant.updateMany',
      'user.updateMany',
    ]);
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: {
        oidcSubject: null,
        passwordHash: null,
        AND: [
          { oidcIssuer: { not: null } },
          { oidcIssuer: { not: NEW_ISSUER } },
        ],
        isSuperadmin: false,
        memberships: {
          some: { tenantId: TENANT_ID },
          none: { tenantId: { not: TENANT_ID } },
        },
      },
      // The organisation's **own** new issuer, never a value from a request.
      data: { oidcIssuer: NEW_ISSUER },
    });
  });

  /**
   * **Der Stempel ist der Wert, gegen den die Anmeldung vergleicht**
   * (Review-Runde 5 Nr. 3) — und die liest die Spalte durch `acceptableIssuer`.
   * Eine unnormalisierte alte Zeile („…/realms/hv/", von Hand repariert oder aus
   * einem älteren Stand) ist deshalb ein **Wechsel**: der Vergleich unten sieht
   * einen Unterschied, und gestempelt wird die normalisierte Fassung. Ohne
   * `issuerStamp` schriebe dieselbe Stelle den Wert weiter, den kein Login
   * trifft — die Reparatur reparierte nichts.
   */
  it('stempelt die normalisierte Fassung, auch wenn die Spalte unnormalisiert war', async () => {
    const { prisma, userUpdateMany } = fakePrisma({
      before: `${NEW_ISSUER}/`,
      restamped: 1,
    });
    const delegate = new ScopedTenantDelegate(prisma, TENANT_ID);

    const result = await delegate.updateOidc(block(`${NEW_ISSUER}/`));

    expect(result).toEqual({ written: true, restamped: 1 });
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { oidcIssuer: NEW_ISSUER } }),
    );
  });

  /**
   * The ordinary save of the tab: everything else may change, the issuer does
   * not. Re-stamping would be a write on every open invitation of the
   * organisation for nothing — and a log line about something that did not
   * happen.
   */
  it('touches no invitation when the issuer stays the same', async () => {
    const { prisma, calls } = fakePrisma({ before: OLD_ISSUER });
    const delegate = new ScopedTenantDelegate(prisma, TENANT_ID);

    const result = await delegate.updateOidc(block(OLD_ISSUER));

    expect(result).toEqual({ written: true, restamped: 0 });
    expect(calls).toEqual(['tenant.findUnique', 'tenant.updateMany']);
  });

  /**
   * **SSO switched off, and the stamps stay as they are.** A stamp of `null`
   * would be an invitation no login can ever match — `oidcIssuer` is part of
   * the redemption's `where` (ADR-0012 no. 3) — so „nicht anfassen" is the
   * repairable direction: configuring SSO again re-stamps it.
   */
  it('re-stamps nothing when the issuer is cleared', async () => {
    const { prisma, calls } = fakePrisma({ before: OLD_ISSUER });
    const delegate = new ScopedTenantDelegate(prisma, TENANT_ID);

    const result = await delegate.updateOidc(block(null));

    expect(result).toEqual({ written: true, restamped: 0 });
    expect(calls).toEqual(['tenant.findUnique', 'tenant.updateMany']);
  });

  /** An organisation that disappeared between the guard and here writes nothing. */
  it('re-stamps nothing when the configuration was not written', async () => {
    const { prisma, calls } = fakePrisma({
      before: null,
      tenantRowExists: false,
    });
    const delegate = new ScopedTenantDelegate(prisma, TENANT_ID);

    const result = await delegate.updateOidc(block(NEW_ISSUER));

    expect(result).toEqual({ written: false, restamped: 0 });
    expect(calls).toEqual(['tenant.findUnique', 'tenant.updateMany']);
  });
});

/**
 * `ScopedMembershipDelegate.resendInvitation` — **the mail and the stamp go out
 * together** (Review-Runde 5 no. 3).
 *
 * Before, „Einladung erneut senden" renewed the link and left the issuer stamp
 * where it was, so the one state it could not repair was the one an issuer
 * change had produced: a fresh mail against a stamp no login matches any more.
 *
 * The same fake `tx` as the two blocks above, and here it is what makes the
 * order provable: the stamp is renewed **inside** the transaction that enqueues,
 * from the organisation's own row and from no argument. The database half —
 * that the login then really redeems the invitation — stands in
 * `test/auth/oidc-issuer-change.spec.ts`.
 */
describe('ScopedMembershipDelegate.resendInvitation renews the issuer stamp', () => {
  const TENANT_ID = '019fb000-0000-7000-8000-000000000021';
  const USER_ID = '019fb000-0000-7000-8000-000000000022';
  const CURRENT_ISSUER = 'https://idp.neu.invalid/realms/hv';

  /** An SSO invitation: `token: null` is what makes it one. */
  const SSO_INVITATION: AccountInvitation = {
    subject: 'Willkommen',
    bodyText: 'Melde dich an.',
    bodyHtml: '<p>Melde dich an.</p>',
    replyTo: null,
    stampedAt: new Date('2026-09-05T09:00:00.000Z'),
    token: null,
  };

  function fakePrisma(options: {
    /** What the account carries today — an open invitation of an old issuer. */
    readonly accountIssuer: string | null;
    readonly accountSubject?: string | null;
    /** What the organisation is configured with now. */
    readonly tenantIssuer: string | null;
  }): {
    prisma: PrismaService;
    calls: string[];
    userUpdateMany: ReturnType<typeof vi.fn>;
  } {
    const calls: string[] = [];
    const userUpdateMany = vi.fn(() => {
      calls.push('user.updateMany');
      return Promise.resolve({ count: 1 });
    });
    const tx = {
      membership: {
        findUnique: vi.fn(() => {
          calls.push('membership.findUnique');
          return Promise.resolve({
            user: {
              passwordHash: null,
              oidcSubject: options.accountSubject ?? null,
              oidcIssuer: options.accountIssuer,
            },
          });
        }),
      },
      tenant: {
        findUnique: vi.fn(() => {
          calls.push('tenant.findUnique');
          return Promise.resolve({ oidcIssuer: options.tenantIssuer });
        }),
      },
      user: {
        updateMany: userUpdateMany,
        findUniqueOrThrow: vi.fn(() => {
          calls.push('user.findUniqueOrThrow');
          return Promise.resolve({ email: 'eingeladen@alpha.invalid' });
        }),
      },
      mailLog: {
        create: vi.fn(() => {
          calls.push('mailLog.create');
          return Promise.resolve({ id: 'mail-1' });
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (fakeTx: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    return { prisma, calls, userUpdateMany };
  }

  it('stamps the organisation’s current issuer before the mail is enqueued', async () => {
    const { prisma, calls, userUpdateMany } = fakePrisma({
      accountIssuer: 'https://idp.alt.invalid/realms/hv',
      tenantIssuer: CURRENT_ISSUER,
    });
    const delegate = new ScopedMembershipDelegate(prisma, TENANT_ID);

    const result = await delegate.resendInvitation(USER_ID, SSO_INVITATION);

    expect(result).toBe('ok');
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        // The shared boundary (`restampableAccount`) — the same one the issuer
        // change draws, restated in the statement that acts.
        oidcSubject: null,
        passwordHash: null,
        isSuperadmin: false,
        memberships: {
          some: { tenantId: TENANT_ID },
          none: { tenantId: { not: TENANT_ID } },
        },
        oidcIssuer: { not: null },
      },
      // Out of the organisation's row — `resendInvitation` has no parameter in
      // which a caller could name an issuer (ADR-0012).
      data: { oidcIssuer: CURRENT_ISSUER },
    });
    // The stamp is renewed **before** the mail row exists, and both on the same
    // `tx`: a mail that went out against the old stamp would be the finding.
    expect(calls).toEqual([
      'membership.findUnique',
      'tenant.findUnique',
      'user.updateMany',
      'user.findUniqueOrThrow',
      'mailLog.create',
    ]);
  });

  /**
   * Dieselbe Zusage wie beim Issuer-Wechsel: gestempelt wird die **normalisierte**
   * Fassung der eigenen Spalte (Review-Runde 5 Nr. 3). „Erneut senden" ist der
   * Weg aus einem veralteten Stempel — schriebe es den Rohwert einer
   * unnormalisierten Zeile zurück, ginge die Mail hinaus und der eine kaputte
   * Wert bliebe stehen.
   */
  it('stempelt die normalisierte Fassung der eigenen Spalte', async () => {
    const { prisma, userUpdateMany } = fakePrisma({
      accountIssuer: 'https://idp.alt.invalid/realms/hv',
      tenantIssuer: `${CURRENT_ISSUER}/`,
    });
    const delegate = new ScopedMembershipDelegate(prisma, TENANT_ID);

    expect(await delegate.resendInvitation(USER_ID, SSO_INVITATION)).toBe('ok');
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { oidcIssuer: CURRENT_ISSUER } }),
    );
  });

  /**
   * The organisation has cleared SSO. A stamp of `null` would be an invitation
   * no login can ever match, so the stale one stays — the repairable direction,
   * exactly as in `updateOidc`.
   */
  it('leaves the stamp alone when the organisation has no issuer', async () => {
    const { prisma, calls } = fakePrisma({
      accountIssuer: 'https://idp.alt.invalid/realms/hv',
      tenantIssuer: null,
    });
    const delegate = new ScopedMembershipDelegate(prisma, TENANT_ID);

    const result = await delegate.resendInvitation(USER_ID, SSO_INVITATION);

    expect(result).toBe('ok');
    expect(calls).not.toContain('user.updateMany');
  });

  /**
   * **An account that has already signed in is not re-stamped** — the
   * precondition „noch nicht eingerichtet" is unchanged, and it stands before
   * the write rather than beside it.
   */
  it('re-stamps nothing for an account that is already bound', async () => {
    const { prisma, calls } = fakePrisma({
      accountIssuer: 'https://idp.alt.invalid/realms/hv',
      accountSubject: 'bereits-angemeldet',
      tenantIssuer: CURRENT_ISSUER,
    });
    const delegate = new ScopedMembershipDelegate(prisma, TENANT_ID);

    const result = await delegate.resendInvitation(USER_ID, SSO_INVITATION);

    expect(result).toBe('already-set-up');
    expect(calls).toEqual(['membership.findUnique']);
  });
});
