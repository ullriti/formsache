import { Injectable, NotFoundException } from '@nestjs/common';
import type { GroupSummary } from '@formsache/shared';

import { toGroupSummary } from '../auth/session-user';
import { isUuid } from '../common/uuid';
import type { TenantScope } from '../tenancy/tenant-scope';

/**
 * The one answer for a group the caller may not see.
 *
 * Deliberately the same for "no such group" and "a group of another organisation": a
 * 403 on the second would confirm that the id exists somewhere on the
 * platform, and ids travel — in URLs, in mails, in exports. * for 403 **or** 404; the choice here is 404 because only 404 keeps the two
 * cases indistinguishable.
 */
export const GROUP_NOT_FOUND_MESSAGE = 'Gruppe nicht gefunden.';

/**
 * Groups of the current tenant.
 *
 * Note the constructor: it is empty. There is no `PrismaService` here, so
 * there is no client in this class that could run an unscoped query — the only
 * way to reach a row is the `TenantScope` a caller passes in, and that object
 * has the tenant built into every statement it issues. A method
 * that "forgot" the tenant would first have to acquire a Prisma client, which
 * is a change to this constructor and not an omission inside a method body.
 */
@Injectable()
export class GroupsService {
  /**
   * Every group of the scope's tenant — and no other, because the scope cannot
   * express another.
   *
   * Sorted by rank first: the handoff shows admin above editor above viewer,
   * and `name` only decides between groups of equal rank so the order is
   * stable across requests.
   */
  async list(scope: TenantScope): Promise<GroupSummary[]> {
    const groups = await scope.groups.findMany({
      orderBy: [{ rank: 'desc' }, { name: 'asc' }],
    });
    return groups.map(toGroupSummary);
  }

  /**
   * One group, looked up by the composite key `(id, tenant_id)`.
   *
   * `id` is foreign input and is checked against the id format before it
   * reaches the database — an unparseable uuid literal would otherwise make
   * PostgreSQL raise, and a 500 tells the sender their string got that far.
   * The malformed case answers exactly like the unknown one.
   *
   * Through `common/uuid.ts`, which says in its own comment that it is *the*
   * place for this pattern. A second copy stood here until a review;
   * two regular expressions for „was PostgreSQL als uuid akzeptiert" is two
   * places for the „malformed answers like unknown" promise to stop holding,
   * and only one of them would have a test on it.
   */
  async byId(scope: TenantScope, id: string): Promise<GroupSummary> {
    if (!isUuid(id)) {
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }

    const group = await scope.groups.findById(id);
    if (group === null) {
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }
    return toGroupSummary(group);
  }
}
