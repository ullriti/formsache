import { UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';

import { AdminRepository, adminGroupName } from './admin.repository';

/**
 * **The id from the session is looked up, not believed**
 * (review finding 12).
 *
 * A unit test and not an integration one, because the case cannot otherwise be
 * produced: what is measured is the window between the guard and this transaction —
 * the superadmin account is deleted *after* the request was accepted.
 * Over the route that could only be brought about by a deletion in the middle of the
 * write; here the double simply answers with „diese Zeile gibt es
 * nicht", which is the same state.
 *
 * Without the check it is `membership.create` that first fails on the foreign key, and
 * the caller sees a 500 with Prisma wording. That is exactly what the second
 * part of the assertion measures: the link is **not written at all**.
 */

const TENANT_ID = '019ffc00-0000-7000-8000-0000000000a0';
const GROUP_ID = '019ffc00-0000-7000-8000-0000000000b0';
const MISSING_USER_ID = '019ffc00-0000-7000-8000-0000000000c0';

/**
 * The double of the transaction — only the five calls `createTenant` makes.
 *
 * `user.findUnique` answers with what the respective case prescribes: `null`
 * is „das Konto ist weg".
 */
function transactionDouble(user: { id: string } | null) {
  const membershipCreate = vi.fn();
  const tx = {
    tenant: {
      create: vi.fn().mockResolvedValue({ id: TENANT_ID, shortName: 'neu' }),
    },
    group: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: GROUP_ID }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      create: vi.fn(),
    },
    membership: { create: membershipCreate },
  };

  const prisma = {
    $transaction: (run: (client: Prisma.TransactionClient) => unknown) =>
      run(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaService;

  return { prisma, tx, membershipCreate };
}

describe('AdminRepository.createTenant with a session account', () => {
  it('refuses when the account behind the session is gone', async () => {
    const { prisma, membershipCreate } = transactionDouble(null);
    const repository = new AdminRepository(prisma);

    await expect(
      repository.createTenant({
        shortName: 'neu',
        name: 'Neue Organisation',
        admin: { userId: MISSING_USER_ID },
      }),
    ).rejects.toThrow(UnauthorizedException);

    // The statement behind the assertion: the foreign-key error does not come
    // about at all any more, because nothing is written.
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('links the account when it is still there', async () => {
    const { prisma, tx, membershipCreate } = transactionDouble({
      id: MISSING_USER_ID,
    });
    const repository = new AdminRepository(prisma);

    await expect(
      repository.createTenant({
        shortName: 'neu',
        name: 'Neue Organisation',
        admin: { userId: MISSING_USER_ID },
      }),
    ).resolves.toStrictEqual({ id: TENANT_ID, shortName: 'neu' });

    // What is looked up is the id from the session — and only it; a
    // second path (search for the address, create an account) must not run here.
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: MISSING_USER_ID },
      select: { id: true },
    });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.group.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        tenantId_name: { tenantId: TENANT_ID, name: adminGroupName() },
      },
      select: { id: true },
    });
    expect(membershipCreate).toHaveBeenCalledWith({
      data: { tenantId: TENANT_ID, userId: MISSING_USER_ID, groupId: GROUP_ID },
    });
  });
});
