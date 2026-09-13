import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
  Injectable,
} from '@nestjs/common';
import type {
  FormMember,
  FormMemberList,
  FormMemberWrite,
} from '@formsache/shared';
import type { FormPermission, Group } from '@prisma/client';

import { toGroupSummary } from '../auth/session-user';
import { FORM_NOT_FOUND_MESSAGE } from '../common/form-not-found';
import { isUuid } from '../common/uuid';
import {
  capPermissions,
  groupPermissions,
  isRestrictable,
} from './form-restriction';
import {
  holdsRequirement,
  type PermissionName,
  type PermissionRequirement,
} from './require-permission.decorator';
import type { MembershipWithPerson, TenantScope } from './tenant-scope';

/**
 * Which permissions open the *Nutzerrechte je Formular* page — **one of
 * the two suffices**, and that is a decision.
 *
 * - `canManageUsers` is what it has always demanded: this page is
 *   the organization's user administration, narrowed to one form.
 * - `canManageFormSettings` is added with ADR-0021: whoever configures a
 *   form also decides who works on it. Otherwise the
 *   default group `editor` would stop at three of the four areas of the form
 *   menu.
 *
 * "Any" and not "all", because "all" would take away from an existing group with
 * `canManageUsers` and without the new permission a page that it has today — a
 * permission change that nobody ordered.
 *
 * **The list stands here and not in the controller**, because two places
 * read it: the guard in front of the route and {@link FormPermissionService.save},
 * which checks whether a cap on oneself locks this page. Two
 * copies would be two answers to "what opens this page?", and the
 * more generous one is the one nobody notices. The controller imports the
 * service anyway — the direction of the import is therefore the one that makes no
 * cycle.
 */
export const FORM_MEMBERS_PERMISSIONS = [
  'canManageFormSettings',
  'canManageUsers',
] as const satisfies readonly PermissionName[];

/** {@link FORM_MEMBERS_PERMISSIONS} in the shape that `holdsRequirement` reads. */
export const FORM_MEMBERS_REQUIREMENT: PermissionRequirement = {
  mode: 'any',
  permissions: FORM_MEMBERS_PERMISSIONS,
};

/**
 * The one answer for a person the caller may not reach — unknown, or a member
 * of another organisation. The same for both, for the reason `FORM_NOT_FOUND_MESSAGE`
 * spells out.
 */
export const MEMBER_NOT_FOUND_MESSAGE = 'Person nicht gefunden.';

/** The requirement, first half — and it says *why*, not just „nein". */
export const ADMIN_NOT_RESTRICTABLE_MESSAGE =
  'Administratoren sind nicht einschränkbar: Sie sehen immer alles.';

/**
 * The requirement, behavioural half.
 *
 * „Nur nach unten" is what the handoff promises the editor, so the refusal
 * names that rule rather than the rank arithmetic behind it.
 */
export const CAP_MUST_LOWER_MESSAGE =
  'Die Rolle für dieses Formular lässt sich nur nach unten einschränken.';

/**
 * A cap naming a group this organisation does not have — unknown or of another organisation,
 * and the same answer to both.
 *
 * 422 and not 404: the *member* and the *form* both exist and the caller may
 * see them, so this is a wrong field in an otherwise well-addressed document.
 * A 404 here would be a riddle about which of the three ids was the bad one.
 */
export const CAP_GROUP_UNKNOWN_MESSAGE =
  'Die gewählte Rolle gibt es in dieser Organisation nicht.';

/**
 * Nobody locks **themselves** out of a form (review finding).
 *
 * Structurally the same case as „der letzte Admin einer Organisation" , and it gets the same treatment: a refusal that names the reason,
 * not a write that succeeds and strands somebody. Revoking one's own access
 * makes this very page answer 404 — the rights editor stands behind the rule it
 * manages, on purpose — so the person who could undo it is the only one who no
 * longer can, and only an administrator could heal it.
 *
 * 409 like that refusal, not 422: the document is well-formed and every
 * id in it exists. What is wrong is the *state* it would leave behind.
 */
export const SELF_LOCKOUT_MESSAGE =
  'Sie können sich den Zugriff auf dieses Formular nicht selbst entziehen: ' +
  'Danach könnten Sie diese Seite nicht mehr öffnen.';

/**
 * The same trap one field further along: a cap on **oneself** to a role that no
 * longer opens this page.
 *
 * It answers 403 rather than 404, which is the only difference — this page
 * needs one of {@link FORM_MEMBERS_PERMISSIONS}, and a cap that takes both away
 * on this form takes away the route that could put it back. Refused for the
 * same reason, and named separately because the way out is a different one
 * (choose a role that keeps the right).
 *
 * **It is measured against the intersection, not against the cap group alone.**
 * Previously `!cap.canManageUsers` stood here, which was only right as long as the
 * page demanded exactly *one* permission that the acting person demonstrably
 * held. Since ADR-0021 two permissions open the page, and whether after the cap
 * one is still left is answered by the same intersection that the guard
 * forms ({@link capPermissions}) — every second calculation would be a second
 * answer to "may I still do this afterwards?".
 */
export const SELF_CAP_LOCKOUT_MESSAGE =
  'Sie können sich auf diesem Formular nicht selbst die Nutzerverwaltung ' +
  'entziehen: Danach könnten Sie diese Seite nicht mehr öffnen.';

/**
 * Whether a cap on oneself still leaves this page open.
 *
 * Exactly the calculation of the fourth link: what one's own group grants,
 * intersected with what the cap group grants — and then the question
 * that the guard asks too. One order, one answer.
 */
function capKeepsFormMembersOpen(own: Group, cap: Group): boolean {
  return holdsRequirement(
    capPermissions(groupPermissions(own), groupPermissions(cap)),
    FORM_MEMBERS_REQUIREMENT,
  );
}

/**
 * The *Nutzerrechte je Formular* editor.
 *
 * The write side of the fourth link — the read side that every other route is
 * measured against lives in `FormRestrictionGuard` and `FormRestriction`. The
 * split is on purpose: what a restriction *means* is decided in one place for
 * all routes, and this class only decides what may be *stored*.
 *
 * The constructor is empty, like `GroupsService`'s: there is no
 * `PrismaService` here, so every statement this class causes carries the
 * tenant of the `TenantScope` a caller hands in. (The same
 * used to be said of `FormsService`; that one now holds
 * `SystemSettingsRepository` — the installation-wide row, no tenant column —
 * and says so at its own class doc. The property is „no Prisma client", not
 * „no dependency".)
 */
@Injectable()
export class FormPermissionService {
  /**
   * Everybody who works in this organisation, with what they may do on **this** form.
   *
   * The organisation's groups travel along so the cap selector needs no second request
   * (`formMemberListSchema`), and `restrictable` is computed here rather than
   * derived in the browser from a rank comparison: the same fact decided twice
   * is the shape that drifts, and the second place would be the one drawing a
   * control the API refuses.
   */
  async list(scope: TenantScope, formId: string): Promise<FormMemberList> {
    await this.requireForm(scope, formId);

    const [members, restrictions, groups] = await Promise.all([
      scope.memberships.findMany(),
      scope.formPermissions.findManyOfForm(formId),
      scope.groups.findMany({ orderBy: [{ rank: 'desc' }, { name: 'asc' }] }),
    ]);

    const byUser = new Map<string, FormPermission>(
      restrictions.map((row) => [row.userId, row]),
    );

    return {
      members: members.map((member) => toFormMember(member, byUser)),
      groups: groups.map(toGroupSummary),
    };
  }

  /**
   * Stores one person's restriction on one form — „Zugriff sperren" and „Rolle
   * herab", and nothing that adds (structural half:
   * `formMemberWriteSchema` has no granting field to parse).
   *
   * The order of the four refusals is the guard chain's order carried into the
   * service, and it is required rather than tidiness:
   *
   * 1. the **form** is resolved through the scope — a form of another organisation is a
   *    404 here, before anything asks about roles (second floor;
   *    the first is the composite foreign key, which would refuse the row even
   *    if this check were deleted);
   * 2. the **person** is resolved through the membership of *this* Organisation — again
   *    404, byte-identical to an unknown id;
   * 3. **administrators are refused** (first half);
   * 4. the **cap** must name a group of this organisation and must rank *below* the
   *    person's own role;
   * 5. **nobody locks themselves out** — see {@link SELF_LOCKOUT_MESSAGE}.
   *
   * The fifth is checked last on purpose: „das bist du selbst" is only worth
   * saying once the write would otherwise have been accepted, and saying it
   * earlier would answer a request about an unknown form or an unknown person
   * with a sentence about oneself.
   *
   * Returns the whole list rather than the one row: the page it serves shows
   * exactly that list, `parseFormMemberList` is the parser `@formsache/shared` offers
   * for it, and a client that had to merge one row into its own copy would be a
   * second place where „was gilt jetzt?" is answered.
   */
  async save(
    scope: TenantScope,
    formId: string,
    userId: string,
    write: FormMemberWrite,
    actingUserId: string,
  ): Promise<FormMemberList> {
    await this.requireForm(scope, formId);

    if (!isUuid(userId)) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    const member = await scope.memberships.findByUserId(userId);
    if (member === null) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }

    if (!isRestrictable(member.group)) {
      throw new UnprocessableEntityException(ADMIN_NOT_RESTRICTABLE_MESSAGE);
    }

    const isSelf = userId === actingUserId;
    if (isSelf && write.accessRevoked) {
      throw new ConflictException(SELF_LOCKOUT_MESSAGE);
    }

    if (write.cappedGroupId !== null) {
      const cap = await scope.groups.findById(write.cappedGroupId);
      if (cap === null) {
        throw new UnprocessableEntityException(CAP_GROUP_UNKNOWN_MESSAGE);
      }
      // Strictly below, so „auf die eigene Rolle deckeln" is refused too: it
      // changes nothing and would leave a row claiming a restriction that is
      // none. Rank is the handoff's ordering of roles; it is *not* what makes
      // the cap safe — `capPermissions` intersects, so even a cap this check
      // let through could not hand out a permission the person does not hold.
      if (cap.rank >= member.group.rank) {
        throw new UnprocessableEntityException(CAP_MUST_LOWER_MESSAGE);
      }
      if (isSelf && !capKeepsFormMembersOpen(member.group, cap)) {
        throw new ConflictException(SELF_CAP_LOCKOUT_MESSAGE);
      }
    }

    // „Keine Einschränkung" is the **absence** of a row, exactly as an absent
    // `settings_override` means „alle vier Abschnitte auf Tenant-Standard".
    // Storing `{ false, null }` instead would leave rows that say nothing and
    // make „hat diese Person eine Einschränkung?" a question about contents
    // rather than about existence.
    if (!write.accessRevoked && write.cappedGroupId === null) {
      await scope.formPermissions.remove(formId, userId);
    } else {
      await scope.formPermissions.set(formId, userId, {
        accessRevoked: write.accessRevoked,
        cappedGroupId: write.cappedGroupId,
      });
    }

    return this.list(scope, formId);
  }

  /**
   * Resolves the form, or raises the one 404 — the same door the malformed id,
   * the foreign id, the unknown id and the one in the trash leave through.
   *
   * `findSettingsById` rather than the full projection: this surface needs
   * neither the published version nor the answer count, and the settings routes
   * made the same choice for the same reason.
   */
  private async requireForm(scope: TenantScope, formId: string): Promise<void> {
    if (!isUuid(formId)) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
    const form = await scope.forms.findSettingsById(formId);
    if (form === null) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
    if (form.deletedAt !== null) {
      // In the trash — answers like an unknown id, as everywhere else.
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
  }
}

/**
 * One row of the editor.
 *
 * **An unrestrictable person reports no restriction, whatever the table says**
 * — the read-side half of the requirement. A row smuggled onto an
 * administrator is ignored by the guard, and it has to be ignored here too:
 * a page showing a lock that the evaluation does not honour would be the same
 * promise answered two ways, and the one people believe is the one on screen.
 */
function toFormMember(
  member: MembershipWithPerson,
  restrictions: ReadonlyMap<string, FormPermission>,
): FormMember {
  const restrictable = isRestrictable(member.group);
  const stored = restrictable ? restrictions.get(member.userId) : undefined;

  return {
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    group: toGroupSummary(member.group),
    restrictable,
    accessRevoked: stored?.accessRevoked ?? false,
    cappedGroupId: stored?.cappedGroupId ?? null,
  };
}
