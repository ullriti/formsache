import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  GroupDetail,
  GroupList,
  GroupWrite as GroupWriteRequest,
} from '@formsache/shared';
import { Prisma, type Group } from '@prisma/client';

import { translateConcurrency } from '../common/prisma-error';
import { isUuid } from '../common/uuid';
import type {
  GroupMemberCount,
  GroupRemovalOutcome,
  GroupWrite,
  TenantScope,
} from '../tenancy/tenant-scope';

/**
 * The group editor of one organisation (handoff *Gruppen & Rechte*).
 *
 * **No `PrismaService` in the constructor.** The only way to a `group` row is
 * `TenantScope.groups`, exactly as `GroupsService` (the read-only module at
 * `apps/api/src/groups/`) already demonstrates — this service is that pattern
 * applied to the write side.
 *
 * **The `admin` system group's protection is layered, not a single check.**
 * `ScopedGroupDelegate.update`/`.remove` already exclude `isSystem: true` rows
 * from the statement they send — a floor no caller here can get around by
 * mistake. What this service adds on top is the *readable* half: resolving the group first so a request against `admin` answers
 * „das ist die Systemgruppe" instead of a bare, indistinguishable miss.
 */

/** The one answer for a group the caller may not see — 404, same as the read-only route. */
export const GROUP_NOT_FOUND_MESSAGE = 'Gruppe nicht gefunden.';

/**
 * The requirement: taking a permission from `admin`, renaming or
 * deleting it fails — and says why, rather than behaving like a miss.
 */
export const SYSTEM_GROUP_MESSAGE =
  'Die Systemgruppe „admin" hat immer alle Rechte und kann weder geändert ' +
  'noch gelöscht werden.';

/**
 * The requirement: a group still in use is refused **before** the
 * database's `NO ACTION` foreign key would refuse it anyway (`Membership.group`
 * in `schema.prisma`) — the floor is the database, the message is this.
 */
export function groupHasMembersMessage(memberCount: number): string {
  const noun = memberCount === 1 ? 'Mitglied' : 'Mitgliedern';
  return (
    `Diese Gruppe hat noch ${String(memberCount)} ${noun} und kann nicht ` +
    'gelöscht werden.'
  );
}

export const GROUP_NAME_TAKEN_MESSAGE =
  'Dieser Gruppenname wird in dieser Organisation bereits verwendet.';

/**
 * The race between {@link groupHasMembersMessage}'s count and the delete
 * (review finding) — narrower since the follow-up that put both into
 * one transaction (`ScopedGroupDelegate.removeIfEmpty`), not gone.
 *
 * Somebody can still be added to the group *inside* that transaction's own
 * window — and the `NO ACTION` foreign key on `membership.group_id` then
 * refuses the delete with `P2003`. Untranslated that reached the caller as a
 * **500**, which is precisely the answer this refusal exists to rule out: the
 * database behaved correctly and the person deleting a group was told the
 * server was broken.
 *
 * The message carries no number, and that is the honest difference from
 * {@link groupHasMembersMessage}: by the time PostgreSQL refuses, whatever this
 * request counted is out of date. „Es ist jemand dazugekommen, lade die Seite
 * neu" is what actually happened.
 */
export const GROUP_IN_USE_MESSAGE =
  'Diese Gruppe hat inzwischen wieder Mitglieder und kann nicht gelöscht ' +
  'werden. Bitte die Seite neu laden.';

@Injectable()
export class TenantGroupsService {
  async list(scope: TenantScope): Promise<GroupList> {
    const [groups, counts] = await Promise.all([
      scope.groups.findMany({ orderBy: [{ rank: 'desc' }, { name: 'asc' }] }),
      scope.memberships.memberCounts(),
    ]);
    return {
      groups: groups.map((group) => toView(group, countOf(counts, group.id))),
    };
  }

  async create(
    scope: TenantScope,
    request: GroupWriteRequest,
  ): Promise<GroupDetail> {
    try {
      const group = await scope.groups.create(toWrite(request));
      return toView(group, 0);
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  /**
   * Replaces a group's editable properties. Refuses the system group with the
   * readable reason rather than the bare 404/false the delegate
   * alone would produce, and leaves the row untouched when it does — the
   * delegate's `where` never selects `admin` in the first place.
   */
  async update(
    scope: TenantScope,
    id: string,
    request: GroupWriteRequest,
  ): Promise<GroupDetail> {
    const current = await this.requireGroup(scope, id);
    if (current.isSystem) {
      throw new ConflictException(SYSTEM_GROUP_MESSAGE);
    }

    let written: boolean;
    try {
      written = await scope.groups.update(id, toWrite(request));
    } catch (error) {
      throw translateWriteError(error);
    }
    if (!written) {
      // Resolved a moment ago through `requireGroup` — a miss here means
      // somebody deleted it in between, the same 404 an outsider would see.
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }

    const updated = await this.requireGroup(scope, id);
    const counts = await scope.memberships.memberCounts();
    return toView(updated, countOf(counts, id));
  }

  /**
   * Deletes a group — refusing the system group and a group
   * still in use, the latter decided in the **same transaction**
   * as the delete itself (`ScopedGroupDelegate.removeIfEmpty`, a review
   * finding), so the database's `NO ACTION` foreign key
   * stays a floor nothing here relies on to produce a readable answer rather
   * than the one place a stale count could still slip through.
   */
  async remove(scope: TenantScope, id: string): Promise<void> {
    const current = await this.requireGroup(scope, id);
    if (current.isSystem) {
      throw new ConflictException(SYSTEM_GROUP_MESSAGE);
    }

    let outcome: GroupRemovalOutcome;
    try {
      outcome = await scope.groups.removeIfEmpty(id);
    } catch (error) {
      // Count and delete now share one transaction, so this is only reached
      // when a membership is stamped onto the group *inside* that
      // transaction's own — much narrower — window. The database stays the
      // floor; its refusal still arrives as a readable 409 instead of a 500
      // (review finding).
      throw translateWriteError(error);
    }
    if (outcome.kind === 'has-members') {
      throw new ConflictException(groupHasMembersMessage(outcome.memberCount));
    }
    if (outcome.kind === 'not-found') {
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }
  }

  /** One group of this organisation, or the single 404 (the requirement's rule). */
  private async requireGroup(scope: TenantScope, id: string): Promise<Group> {
    if (!isUuid(id)) {
      // An unparseable uuid literal makes PostgreSQL raise, and a 500 would
      // tell the sender their string got that far.
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }
    const group = await scope.groups.findById(id);
    if (group === null) {
      throw new NotFoundException(GROUP_NOT_FOUND_MESSAGE);
    }
    return group;
  }
}

function countOf(counts: readonly GroupMemberCount[], groupId: string): number {
  return counts.find((row) => row.groupId === groupId)?.members ?? 0;
}

/** A request as the delegate takes it — flattening `permissions` once, here. */
function toWrite(request: GroupWriteRequest): GroupWrite {
  return {
    name: request.name,
    color: request.color,
    rank: request.rank,
    canBuild: request.permissions.canBuild,
    canViewResponses: request.permissions.canViewResponses,
    canExport: request.permissions.canExport,
    canManageSettings: request.permissions.canManageSettings,
    canManageFormSettings: request.permissions.canManageFormSettings,
    canManageUsers: request.permissions.canManageUsers,
  };
}

function toView(group: Group, memberCount: number): GroupDetail {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    rank: group.rank,
    isSystem: group.isSystem,
    permissions: {
      canBuild: group.canBuild,
      canViewResponses: group.canViewResponses,
      canExport: group.canExport,
      canManageSettings: group.canManageSettings,
      canManageFormSettings: group.canManageFormSettings,
      canManageUsers: group.canManageUsers,
    },
    memberCount,
  };
}

/**
 * The three database refusals this editor can legitimately provoke, each turned
 * into the answer a person holding the group editor can act on rather than the
 * 500 that would otherwise name a PostgreSQL constraint at them.
 *
 * - `P2002` — `@@unique([tenantId, name])`: a duplicate name, refused by the
 *   index rather than silently overwriting a row;
 * - `P2003` — the `NO ACTION` foreign key on `membership.group_id`: a member
 *   appeared between the count and the delete (see {@link GROUP_IN_USE_MESSAGE});
 * - `P2034` — a serialization failure, translated in one shared place for the
 *   whole application (`common/prisma-error.ts`).
 */
function translateWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new ConflictException(GROUP_NAME_TAKEN_MESSAGE);
    }
    if (error.code === 'P2003') {
      return new ConflictException(GROUP_IN_USE_MESSAGE);
    }
  }
  return translateConcurrency(error);
}
