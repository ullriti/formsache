import { ConflictException, Injectable } from '@nestjs/common';
import type {
  AccountKind,
  AiProvider,
  AiQuota,
  AiUsageSample,
  SeatPosition,
  TenantBrandingWrite,
} from '@formsache/shared';
import type {
  AiOutcome,
  Form,
  FormPermission,
  FormTemplate,
  FormTemplateKind,
  FormVersion,
  Group,
  MailFormat,
  MailStatus,
  Membership,
  Notification,
  NotificationTrigger,
  Prisma,
  Response,
  Tenant,
} from '@prisma/client';

import {
  OWNED_LOGO_INCLUDE,
  type TenantWithLogoFiles,
} from '../files/owned-logo';
// The **same** two statements the public write paths use, imported rather than
// restated. They live under `src/public/` because that is
// where the participant limit is enforced, but neither is about the public
// surface: one is a `SELECT … FOR UPDATE` on `form`, the other the sum over
// `event_registration`. A second spelling of either here would be a second lock
// order and a second definition of „belegt" — see `restoreResponse`.
import { lockForm, registeredSeats, takenSeats } from '../public/event-seats';
import { issuerStamp } from '../tenant-admin/oidc-issuer';
// The four personal columns of `mail_log` and the one statement that empties
// them. Imported rather than restated for the reason the
// constant's own comment gives: a fifth such column has to have one place to be
// added to.
import { eraseMailLogLines } from '../mail-log/mail-log-erasure';
// The one version of „that was the `unique` index" — shared with the
// redemption of an SSO invitation (`auth/oidc/oidc-identity.service.ts`).
import { invalidateOpenTokens } from '../auth/password-reset/password-reset-invalidation';
// The one statement that enqueues an invitation (ADR-0024) — the same
// shape and the same reason as `invalidateOpenTokens` one line above:
// a **statement** rather than a service class, so that its dependencies
// (signing key, clock, system settings) do not wander into the import graph of
// nearly every request path.
import { enqueueInvitation } from '../auth/invitation/enqueue-invitation';
import type { AccountInvitation } from '../auth/invitation/account-invitation';
import { isUniqueViolation } from '../common/prisma-error';
import { PrismaService } from '../prisma/prisma.service';
// „Does this account still belong to anybody?" — the one version of the rule,
// shared with the 30-day purge. Imported rather than repeated here: two
// versions would be two answers to „who is never deleted".
import { deleteHomelessAccount } from './homeless-account';

/**
 * The tenant boundary as an object.
 *
 * The shape is chosen so that a *tenant-less* query cannot be written down at
 * all, not merely so that it is discouraged:
 *
 * - A `TenantScope` cannot be constructed without a tenant id, and only
 *   `TenantScopeGuard` constructs one — from a membership the request's user
 *   actually holds.
 * - It is the **only** handle a domain service receives. `GroupsService` has no
 *   `PrismaService` in its constructor, so there is no unscoped client in
 *   reach; "forgetting" the tenant would mean injecting Prisma, which is a
 *   visible change to a constructor rather than an omitted `where` key.
 * - The scoped delegates below do not *accept* a tenant at all: `where` is
 *   typed without `tenantId`, and the binding is merged in last, so a caller
 *   can neither omit nor override it.
 *
 * That last point is what separates this from the "filter afterwards" shape
 * the rule rules out: the tenant is part of the statement sent to PostgreSQL, and
 * for a single row it is part of the *unique key* the row is looked up by.
 *
 * The surface is deliberately narrow, and narrowness is the forcing function,
 * not an oversight: a model or an operation a feature needs has to be added
 * here, in the one file whose only job is the tenant binding, and is reviewed
 * there. It got by at first with two read operations; more were added later
 * for the writes the builder needs, under the same rule — the tenant is never a parameter.
 */
export class TenantScope {
  /** Groups of {@link tenantId}. The only way to read `group` rows. */
  readonly groups: ScopedGroupDelegate;

  /** Forms of {@link tenantId}, with their versions and answers. */
  readonly forms: ScopedFormDelegate;

  /** The organisation's own row — its form standards live there. */
  readonly tenant: ScopedTenantDelegate;

  /** Notifications configured on this organisation's forms. */
  readonly notifications: ScopedNotificationDelegate;

  /** The organisation's mail log — and the only boundary that table has. */
  readonly mailLog: ScopedMailLogDelegate;

  /**
   * The people who work in this organisation — **and the only way to reach a
   * `user` row from anything tenant-bound.**
   *
   * There is deliberately no `scope.users`. A user belongs to no organisation (see the
   * comment on `User` in `schema.prisma`); what belongs to an organisation is the
   * membership, and „die Nutzer dieser Organisation" is therefore a query over
   * `membership`, joined to `user`. A `users` delegate would have to invent a
   * tenant binding for a table that has none, and the first method somebody
   * added to it — „find by e-mail", say — would reach across every organisation of the
   * installation.
   */
  readonly memberships: ScopedMembershipDelegate;

  /** Per-form restrictions of this organisation's forms. */
  readonly formPermissions: ScopedFormPermissionDelegate;

  /** The attachments of this organisation's answers — see the delegate. */
  readonly files: ScopedFileDelegate;

  /**
   * The templates this organisation has saved for itself.
   *
   * **Every template has an organisation**, which is the whole of the requirement:
   * there is no installation-wide catalogue next to this delegate that a „and
   * also the shipped ones" branch could ever read from — that branch
   * was removed on 2026-08-03 . A template of another organisation is not
   * something this class can express.
   */
  readonly formTemplates: ScopedFormTemplateDelegate;

  /**
   * The AI quota of this organisation and its calls.
   *
   * **The read path *and* the write path of the AI go through here**, and that
   * is the counter-check that makes the entry `apps/api/src/ai/purge/**` on the
   * Prisma allow-list defensible (ADR-0015 no. 8): the purge works
   * across organisations and holds `PrismaService`, everything else about the AI holds
   * this delegate. Organisation A can therefore neither spend nor read the budget of organisation B
   * — not because a service remembers to, but because `tenant_id`
   * is in every statement and no caller can set it.
   */
  readonly aiUsage: ScopedAiUsageDelegate;

  /**
   * The one deliberately cross-tenant corner of this class — finding
   * and creating `user` rows by e-mail, for „Person hinzufügen".
   *
   * This is **not** the `scope.users` the comment on {@link memberships} rules
   * out. That comment is about a *tenant-scoped* view of `user` rows, which the
   * table cannot honestly support. `AccountDirectory` claims no such thing: it
   * is unscoped on purpose, and the reason it is safe to be is the same reason
   * `AuthService.login` already reads `user.email` across every organisation of the
   * installation — `email` has been one namespace, not one per organisation, since the
   * unique index. Reusing that same read here is what lets „Person
   * hinzufügen" attach an existing account instead of racing that index into a
   * raw constraint violation, or minting a second row for one person.
   *
   * What it answers is deliberately thin: whether an account with a given
   * e-mail exists, and which kind of credential it carries — never *which*
   * other organisation it belongs to or what role it holds there. That is the line
   * `TenantUsersService` is built not to cross.
   */
  readonly accounts: AccountDirectory;

  constructor(
    prisma: PrismaService,
    /** The tenant every query made through this scope is bound to. */
    readonly tenantId: string,
  ) {
    this.groups = new ScopedGroupDelegate(prisma, tenantId);
    this.forms = new ScopedFormDelegate(prisma, tenantId);
    this.tenant = new ScopedTenantDelegate(prisma, tenantId);
    this.notifications = new ScopedNotificationDelegate(prisma, tenantId);
    this.mailLog = new ScopedMailLogDelegate(prisma, tenantId);
    this.memberships = new ScopedMembershipDelegate(prisma, tenantId);
    this.formPermissions = new ScopedFormPermissionDelegate(prisma, tenantId);
    this.files = new ScopedFileDelegate(prisma, tenantId);
    this.formTemplates = new ScopedFormTemplateDelegate(prisma, tenantId);
    this.aiUsage = new ScopedAiUsageDelegate(prisma, tenantId);
    this.accounts = new AccountDirectory(prisma);
  }
}

/** What {@link AccountDirectory.findByEmail} answers — nothing tenant-bound. */
export interface AccountLookup {
  readonly id: string;
  /**
   * Which of the three shapes of `user` this account is (ADR-0012) —
   * derived exactly once, by {@link deriveAccountKind}, and handed straight
   * to `tenant-admin/users.service.ts`'s `toView`, the same function that
   * derives the badge for the *member* view. An earlier shape carried two
   * separate booleans here (`hasOidcIdentity`, `hasOidcInvitation`) that
   * `TenantUsersService.create` then re-derived into the same three cases a
   * second time by hand — this field is that derivation, done once, reused
   * twice (a review finding).
   *
   * Never the issuer itself: which provider stands behind an address is
   * which Organisation invited the person, and that is the one thing the doc on
   * {@link TenantScope.accounts} says this class must not hand out.
   * `deriveAccountKind` only ever answers `'invited'`, never the issuer
   * string — the same boolean-shaped answer the two booleans it replaces
   * gave, because `user.email` is unique installation-wide and a caller has
   * to learn the address is spoken for either way (ADR-0012).
   */
  readonly kind: AccountKind;
}

/**
 * Finds `user` rows by e-mail — see the doc on {@link TenantScope.accounts}
 * for why this is allowed to be the one class in this file that is not bound
 * to a tenant.
 *
 * **Read-only, on purpose (coordinator review).** Minting a fresh local
 * account belongs next to the membership it must never exist without —
 * {@link ScopedMembershipDelegate.createLocal} — so that the two are one
 * transaction rather than two statements a failure could land between. A
 * `createLocal` here would be exactly the second, orphan-shaped path this
 * class exists not to be.
 */
export class AccountDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /** An account by its (already normalised, lower-cased) e-mail, or `null`. */
  async findByEmail(email: string): Promise<AccountLookup | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      // **Without `passwordHash`** (ADR-0024). It stood here for a
      // `hasPassword` that `TenantUsersService.create` read „is this an
      // SSO account?" off — indirectly, as long as „local" meant „has a password".
      // Since a local account is invited, that inference no longer holds,
      // and the question is put directly to {@link AccountLookup.kind}. What
      // remains is one query less on the hash.
      select: { id: true, oidcSubject: true, oidcIssuer: true },
    });
    if (user === null) {
      return null;
    }
    return {
      id: user.id,
      // The issuer, if any, is read by `deriveAccountKind` and then **thrown
      // away** — only `'invited'` leaves this method. See the doc on
      // {@link AccountLookup.kind}.
      kind: deriveAccountKind(user),
    };
  }
}

/**
 * The one place `user`'s two OIDC columns become the wire's `AccountKind`
 * (a review finding) — every caller that needs the
 * badge, here and in `tenant-admin/users.service.ts`, goes through this
 * function rather than re-reading the columns.
 *
 * **Three shapes in `user` since ADR-0012, three values on the wire**
 * (`accountKindSchema`): a stamped `oidc_subject` is `'oidc'` — the account
 * has signed in at least once, the identity is bound; an `oidc_issuer`
 * **without** a subject yet is `'invited'` — an organisation's admin sent an
 * invitation nobody has redeemed with a first SSO login; neither column set
 * is `'local'`.
 *
 * `passwordHash` plays no part in this — see the review finding on
 * `AccountLookup.kind`'s call site (`tenant-admin/users.service.ts`) for why
 * that is a documented, currently unreachable gap rather than an oversight.
 */
export function deriveAccountKind(account: {
  readonly oidcSubject: string | null;
  readonly oidcIssuer: string | null;
}): AccountKind {
  if (account.oidcSubject !== null) {
    return 'oidc';
  }
  if (account.oidcIssuer !== null) {
    return 'invited';
  }
  return 'local';
}

/**
 * Builds scopes — and is the reason a domain module never sees Prisma.
 *
 * `TenantScopeGuard` is applied inside feature modules, and Nest resolves a
 * guard's constructor in the module that *uses* it. A guard that injected
 * `PrismaService` would therefore force every such module to import
 * `PrismaModule`, which would put an unscoped client back within reach of the
 * very services this design keeps it away from. `TenancyModule` exports this
 * factory instead: the client stays on its side of the module boundary, and
 * `GroupsModule` imports no database access at all.
 */
@Injectable()
export class TenantScopeFactory {
  constructor(private readonly prisma: PrismaService) {}

  create(tenantId: string): TenantScope {
    return new TenantScope(this.prisma, tenantId);
  }
}

/**
 * What a caller may say about *which* groups it wants.
 *
 * `tenantId` is omitted from `where` on purpose. Not because saying it would
 * be wrong, but because a type that accepts it invites a caller to believe the
 * binding is theirs to make — and the moment it is theirs to make, it is
 * theirs to forget.
 */
export interface ScopedGroupQuery {
  readonly where?: Omit<Prisma.GroupWhereInput, 'tenantId'>;
  readonly orderBy?:
    | Prisma.GroupOrderByWithRelationInput
    | Prisma.GroupOrderByWithRelationInput[];
}

/**
 * What {@link ScopedGroupDelegate.removeIfEmpty} answers — the count and the
 * delete are decided in one transaction, so the caller never sees a count
 * that could already be stale by the time it acts on it (a review finding: see the doc on {@link ScopedGroupDelegate.removeIfEmpty}).
 */
export type GroupRemovalOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'has-members'; readonly memberCount: number };

/** A `group` delegate that has the tenant of its scope built in. */
export class ScopedGroupDelegate {
  private readonly delegate: PrismaService['group'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {
    this.delegate = prisma.group;
  }

  /**
   * The tenant's groups. The binding is spread **last**, so it survives any
   * `where` the caller passes — the type already forbids naming it, and this
   * makes the guarantee independent of the type.
   */
  findMany(query: ScopedGroupQuery = {}): Promise<Group[]> {
    return this.delegate.findMany({
      ...query,
      where: { ...query.where, tenantId: this.tenantId },
    });
  }

  /**
   * One group of this tenant, or `null` — and `null` for a group of another
   * tenant just as much as for one that does not exist.
   *
   * `findUnique` on the composite key `(id, tenant_id)` rather than
   * `findFirst({ where: { id, tenantId } })`. Both are tenant-bound in the
   * query, but this one cannot degrade into a lookup by id alone: dropping the
   * tenant leaves `id_tenantId` incomplete, which is a type error, whereas
   * dropping a key from a `where` object still compiles and still returns a
   * row. The `@@unique([id, tenantId])` index the schema keeps for the
   * composite foreign key is what makes this spelling available.
   */
  findById(id: string): Promise<Group | null> {
    return this.delegate.findUnique({
      where: { id_tenantId: { id, tenantId: this.tenantId } },
    });
  }

  /** Adds a group to this organisation. Never a system group. */
  create(data: GroupWrite): Promise<Group> {
    return this.delegate.create({
      data: {
        // Named one by one rather than `...data` (a review finding):
        // `GroupWrite` is a TypeScript interface, which is nothing at
        // runtime — an object that somehow carried `tenantId` or `isSystem`
        // at the call site would otherwise reach Prisma unfiltered. Writing
        // out every field is what makes the two lines below the *only*
        // place those two columns are decided, not merely the last ones in
        // an object literal.
        name: data.name,
        color: data.color,
        rank: data.rank,
        canBuild: data.canBuild,
        canViewResponses: data.canViewResponses,
        canExport: data.canExport,
        canManageSettings: data.canManageSettings,
        canManageFormSettings: data.canManageFormSettings,
        canManageUsers: data.canManageUsers,
        // `isSystem` is not in {@link GroupWrite}: the `admin` group is
        // created with the organisation and nowhere else, so a route
        // that could mint a second one would be a way to make a group that
        // then cannot be edited or deleted through any route at all.
        tenantId: this.tenantId,
        isSystem: false,
      },
    });
  }

  /**
   * Replaces the editable properties of one group. Returns whether a row
   * matched — `false` means „not this organisation's, gone, **or the system group**",
   * and the caller resolves which through {@link findById} before it answers
   * (the requirement wants a readable reason, not a bare miss).
   *
   * **`isSystem: false` is part of the condition, not a check before it.** The
   * `admin` group therefore matches no update statement this application can
   * send: „ihr ein Recht nehmen, sie umbenennen" is impossible in the same way
   * a cross-tenant read is impossible — because the statement does not select
   * the row, not because somebody remembered to ask.
   *
   * `data` is named field by field rather than passed through (review
   * finding): an interface is nothing at runtime, so a `data` argument that
   * somehow carried `tenantId` or `isSystem` would otherwise be applied as-is.
   */
  async update(id: string, data: GroupWrite): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id, tenantId: this.tenantId, isSystem: false },
      data: {
        name: data.name,
        color: data.color,
        rank: data.rank,
        canBuild: data.canBuild,
        canViewResponses: data.canViewResponses,
        canExport: data.canExport,
        canManageSettings: data.canManageSettings,
        canManageFormSettings: data.canManageFormSettings,
        canManageUsers: data.canManageUsers,
      },
    });
    return result.count === 1;
  }

  /**
   * Deletes a group of this organisation **only if it currently has no members** —
   * the member count and the delete decided in **one transaction**, not as
   * two independent statements (a review finding).
   *
   * **This is the only delete this class has** (a review finding):
   * an earlier shape also had a bare `remove(id)` — `deleteMany` with no
   * member check — that `TenantGroupsService.remove` called as a second,
   * entirely separate `await` *after* `ScopedMembershipDelegate.memberCounts()`,
   * with whatever the rest of the event loop cared to run in between. The
   * `NO ACTION` foreign key on `membership.group_id` still refused a delete
   * a membership had appeared underneath, so nothing was ever *lost*, but the
   * window a caller needed a lucky insert to land in was as wide as "however
   * long two independent `await`s take to interleave with other requests",
   * not "the time between two statements sent back to back on one
   * connection" — the shape every other guarded write in this file already
   * uses (`ScopedFormDelegate.publish`, `.updateSettingsOverride`,
   * `ScopedMembershipDelegate.write`). `TenantGroupsService` was moved onto
   * this method instead of being fixed to call the bare delete more
   * carefully, and the bare delete itself was deleted with it — one boundary
   * a group can be removed through, not two that a future caller could pick
   * the wrong one of.
   *
   * **The foreign key stays the floor.** A membership stamped onto this
   * group *inside* this transaction's own, now much narrower window still
   * refuses the `deleteMany` with `P2003` — `TenantGroupsService.remove`
   * still translates that into the readable {@link GROUP_IN_USE_MESSAGE}
   * this method's caller announces. What changed is only how rare that path
   * is, not that it is gone.
   *
   * `isSystem: false` is part of the `where` for the same reason {@link
   * update} gives it one: the `admin` group matches no statement this method
   * can send either, so it is never a row the caller has to notice being
   * skipped.
   */
  async removeIfEmpty(id: string): Promise<GroupRemovalOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const memberCount = await tx.membership.count({
        where: { tenantId: this.tenantId, groupId: id },
      });
      if (memberCount > 0) {
        return { kind: 'has-members', memberCount };
      }

      const result = await tx.group.deleteMany({
        where: { id, tenantId: this.tenantId, isSystem: false },
      });
      return result.count === 1 ? { kind: 'removed' } : { kind: 'not-found' };
    });
  }
}

/**
 * The editable properties of a group — the six permission
 * flags, the tint, the name and the rank.
 *
 * Spelled out rather than taken from `Prisma.GroupUpdateInput`, for the reason
 * {@link NotificationWrite} is spelled out: the Prisma type also carries
 * `isSystem`, `tenantId` and the relations, and a `where`-less `data` object
 * that *can* say `isSystem: true` is a promotion waiting for a spread operator.
 */
export interface GroupWrite {
  readonly name: string;
  /** `#rrggbb` — validated on the way in by `hexColorSchema` in `@formsache/shared`. */
  readonly color: string;
  readonly rank: number;
  readonly canBuild: boolean;
  readonly canViewResponses: boolean;
  readonly canExport: boolean;
  readonly canManageSettings: boolean;
  readonly canManageFormSettings: boolean;
  readonly canManageUsers: boolean;
}

/**
 * The organisation's own row, reachable **only** as "the one this scope is bound to".
 *
 * There is no `findById` here and there is not meant to be one: the tenant
 * standards are addressed by the session's active tenant, never by an id in a
 * URL. That is what makes „der Standard eines fremden Tenants ist weder les-
 * noch schreibbar"  structural rather than checked — a
 * request has no way to *name* another organisation, so there is nothing to refuse.
 * Superadmin reach across tenants belongs elsewhere and will need its own,
 * separately reviewed way in.
 */
export class ScopedTenantDelegate {
  private readonly delegate: PrismaService['tenant'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {
    this.delegate = prisma.tenant;
  }

  /**
   * The organisation's sending identity column, and nothing else (a review
   * finding).
   *
   * `find()` reads the whole row, `oidc_client_secret` included, and
   * `SmtpConfigService` asks for it **twice per `PUT`** — once to know what
   * password a save without one should keep, once more to answer with what
   * is now in the column. A projection of its own is the shape every other
   * settings read in this file already takes ({@link
   * ScopedFormDelegate.findSettingsById}), not a new one invented for this
   * column.
   */
  smtp(): Promise<{ readonly smtp: Prisma.JsonValue | null } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { smtp: true },
    });
  }

  /**
   * The organisation's own base address column, and nothing else — the same narrow projection {@link smtp} takes, for the
   * same reason: `TenantBaseUrlService` has no business reading the rest of
   * the row for one `text` column.
   */
  /**
   * This organisation's own AI switch, and nothing else — the same narrow projection {@link smtp} and
   * {@link publicBaseUrl} take.
   *
   * `null` in the column means „inherits the system default"; `null` as a *row*
   * means that this organisation does not exist. Telling the two apart is
   * the caller's business — here it is `AiFeatureGuard`, and for it
   * both lead to the same question put to the system layer.
   */
  aiEnabled(): Promise<{ readonly aiEnabled: boolean | null } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { aiEnabled: true },
    });
  }

  /**
   * Sets this organisation's own AI switch.
   *
   * `null` puts it back to „inherits the system default" — the third state is
   * writable, not merely readable, or there would be no way back out of a
   * decision once taken.
   *
   * ⚠️ **The write path cannot switch on anything the installation does not
   * have.** It sets a column; whether the feature exists as a result is decided by
   * `AiSettingsService` at its next resolution, and there the link is an
   * **and**. An organisation that writes `true` while the system layer is off
   * has a true column and no feature — exactly the promise described above.
   */
  async setAiEnabled(value: boolean | null): Promise<void> {
    await this.delegate.updateMany({
      where: { id: this.tenantId },
      data: { aiEnabled: value },
    });
  }

  publicBaseUrl(): Promise<{ readonly publicBaseUrl: string | null } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { publicBaseUrl: true },
    });
  }

  /**
   * The reply address of this organisation, and nothing else — the same
   * narrow projection that {@link publicBaseUrl} one method further up
   * takes, and for the same reason. In particular **not** through {@link smtp}:
   * the reply address sits beside the block, not inside it.
   */
  replyTo(): Promise<{ readonly replyTo: string | null } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { replyTo: true },
    });
  }

  /** The organisation itself. Never null through the normal chain — the scope was
   * built from a membership that points at this row — but typed honestly, so
   * a deleted tenant is a case the caller handles rather than a crash. */
  find(): Promise<Tenant | null> {
    return this.delegate.findUnique({ where: { id: this.tenantId } });
  }

  /**
   * The organisation's name and nothing else — for the printed head of an HTML export.
   *
   * A projection for the same reason {@link smtp} is one: `find()` reads the
   * whole row, `oidc_client_secret` and `smtp` included, and an export runs on
   * every download of every format. What may end up inside a file an organisation hands
   * to somebody else should be exactly the column that is meant to be in it.
   */
  name(): Promise<{ readonly name: string } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { name: true },
    });
  }

  /**
   * **Physically deletes the organisation if it has been in the trash since `cutoff`**.
   *
   * ## The condition is in the statement, and it is the only guard there is
   *
   * `deleted_at <= cutoff` is a *predicate of the `DELETE`*, not a check the
   * caller made a moment earlier. A `tenant.delete()` by primary key would
   * remove a live Organisation with every one of its forms and answers, and it would do
   * so silently. So the question „is this organisation due" is asked by the database,
   * in the same statement that acts on the answer, and a restore that lands
   * between the caller's own check and this one makes the `DELETE` match
   * nothing rather than race it.
   *
   * `IS NOT NULL` beside it is **redundant in SQL and kept on purpose**
   * (measured 2026-08-03): `deleted_at <= $1` is NULL for a live Organisation and
   * therefore never true, so the second predicate changes no row. It stays
   * because it says out loud what three-valued logic says quietly, in the one
   * statement of this application that can destroy an organisation.
   *
   * ## What goes with it
   *
   * Twelve tables cascade from `tenant` — `group`, `membership`, `form`,
   * `form_version`, `response`, `event_registration`, `notification`,
   * `mail_log`, `form_permission`, `file`, `response_draft`,
   * `form_template` — and `session.active_tenant_id` is
   * `ON DELETE SET NULL`, so a session left open on a purged Organisation keeps
   * existing without a scope. (The requirement predicts eight children; the schema
   * says twelve and one nulled reference. The prediction is not the
   * measurement — and it stays behind again with every table a later change
   * adds, which is why the count is read off `schema.prisma` and not restated here.)
   *
   * **`file` is the one that cannot simply cascade**, and it is why this method
   * is not the whole of the deletion: `file.form_id` is `ON DELETE NO ACTION`,
   * so as long as one attachment row of this organisation is standing, removing its
   * forms fails and this statement raises. That constraint is the database
   * floor under ADR-0014 no. 16 — bytes before rows — and the caller
   * ({@link PermanentDeletionService.deleteTenant}) removes them first, one
   * file per transaction. An organisation whose storage will not release a file is
   * therefore not purged at all, rather than half purged.
   *
   * ## And it has a limit (a review finding)
   *
   * The cascade runs under a `SET LOCAL statement_timeout` of
   * {@link TENANT_PURGE_STATEMENT_TIMEOUT_MS}. Why this statement needs a limit
   * and why it is this one is written down at the constant. `SET LOCAL` holds
   * until the end of the transaction — which is why there is a transaction around a
   * single statement at all, and why its own `timeout` is **above** the
   * limit: otherwise Prisma's clock would come first, ahead of PostgreSQL's, and the abort would arrive
   * as `P2028` rather than as what it is.
   *
   * @returns whether an organisation was actually removed. `false` means „does not
   * exist", „is not in the trash" or „not yet 30 days".
   */
  async purgeIfDeletedBefore(cutoff: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        // `SET LOCAL` takes no bind parameter — PostgreSQL wants a literal
        // here. The value is a module constant of this file, never anything a
        // caller supplies, so `Unsafe` names the API and not the input.
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = ${String(TENANT_PURGE_STATEMENT_TIMEOUT_MS)}`,
        );
        const { count } = await tx.tenant.deleteMany({
          where: { id: this.tenantId, deletedAt: { not: null, lte: cutoff } },
        });
        return count === 1;
      },
      {
        maxWait: BULK_TRANSACTION_BOUNDS.maxWait,
        // Above the statement timeout, so PostgreSQL's cancellation is what
        // ends this and Prisma's own clock never gets there first.
        timeout: TENANT_PURGE_STATEMENT_TIMEOUT_MS + 10_000,
      },
    );
  }

  /**
   * The organisation itself **with its own Logo files** — the third shore of
   * ADR-0014 no. 12 (the *Erscheinungsbild* tab).
   *
   * A method of its own rather than an include on {@link find}: six callers
   * read that one, and five of them want a column, not a join. Which read
   * needs the relation is a decision that belongs at the read
   * (`files/owned-logo.ts` says why the relation and not a comparison).
   */
  findWithLogoFile(): Promise<TenantWithLogoFiles | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      include: OWNED_LOGO_INCLUDE,
    });
  }

  /**
   * Replaces the tenant-wide form standards **only if** nobody else did since
   * `expectedRevision`.
   *
   * A whole-document write, not a patch: the merge that turns a partial write
   * into a complete document happens in the service, against what was read a
   * moment earlier, so the rule "a missing key means the system default" stays
   * in one place (`packages/shared/src/form-settings.ts`).
   *
   * `updateMany` rather than `update`, exactly as `ScopedFormDelegate` does it:
   * a non-unique `where` is what lets the revision be part of the *condition*
   * instead of being read first and compared afterwards. A read-then-write
   * leaves open precisely the window two editors land in.
   *
   * **`revokeParticipantLinks` reaches the forms that inherit** . The organisation's standard *is* the access word of every form that has
   * not taken *Zugriff & Sicherheit* over, so switching the protection on here
   * switches it on for all of them — and the addresses they handed out while
   * they were open would otherwise keep serving their field definitions past
   * the new gate, which is the same hole one level up. Forms that have taken
   * the section over are untouched here and are revoked by their own save.
   *
   * **Two kinds of address, one rule.** *Whether* a write revokes is
   * `revokesEditLinks` in `@formsache/shared` and is not asked here; *what* is taken
   * back is both public capabilities a participant may be holding — the
   * `edit_token` of a submitted answer and the zwischengespeicherter
   * Entwurf. Leaving the drafts would defeat the whole measure: a draft
   * address is an unauthenticated `GET` that hands out the **complete field
   * definition**, which is precisely what the requirement promises cannot exist behind a
   * gate.
   *
   * **`capDraftsAt` is the deadline of this standard, one level up** (a review
   * finding) — see {@link updateSettingsOverride} for the whole rule.
   * It reaches the forms that inherit *Verfügbarkeit*, which is a **different**
   * list from the one above: the two writes follow two sections.
   */
  async updateFormDefaults(
    expectedRevision: number,
    formDefaults: Prisma.InputJsonValue,
    options: {
      readonly revokeParticipantLinks?: boolean;
      readonly capDraftsAt?: Date | null;
    } = {},
  ): Promise<boolean> {
    const capDraftsAt = options.capDraftsAt ?? null;
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.tenant.updateMany({
        where: { id: this.tenantId, formDefaultsRevision: expectedRevision },
        data: { formDefaults, formDefaultsRevision: { increment: 1 } },
      });
      if (result.count !== 1) {
        return false;
      }

      if (options.revokeParticipantLinks !== true && capDraftsAt === null) {
        return true;
      }

      // Read **once** for both writes below: two walks over the same table in
      // one transaction could only produce two opinions about which form
      // inherits what.
      const forms = await tx.form.findMany({
        where: { tenantId: this.tenantId },
        select: { id: true, settingsOverride: true },
      });

      if (options.revokeParticipantLinks === true) {
        const inheriting = forms
          .filter((form) => !takesOverSection(form.settingsOverride, 'access'))
          .map((form) => form.id);

        await tx.response.updateMany({
          where: { tenantId: this.tenantId, formId: { in: inheriting } },
          data: { editToken: null },
        });
        // The drafts of the same forms, in the same transaction and from the
        // same list. **Deleted, not cleared**: a draft's token
        // is `NOT NULL` and is the only way to reach the row, so emptying it
        // would leave a document nobody can open sitting in the table until its
        // retention runs out. The price is the participants' side and is the
        // same one the cleared `edit_token` names — their half-filled form is
        // gone — except that here there is nothing left behind to come back to.
        await tx.responseDraft.deleteMany({
          where: { tenantId: this.tenantId, formId: { in: inheriting } },
        });
      }

      if (capDraftsAt !== null) {
        const inheriting = forms
          .filter((form) => !takesOverSection(form.settingsOverride, 'avail'))
          .map((form) => form.id);

        await tx.responseDraft.updateMany({
          where: {
            tenantId: this.tenantId,
            formId: { in: inheriting },
            expiresAt: { gt: capDraftsAt },
          },
          data: { expiresAt: capDraftsAt },
        });
      }

      return true;
    });
  }

  /**
   * Replaces the organisation's branding **only if** nobody else did since
   * `expectedRevision`.
   *
   * `updateMany` rather than `update`, exactly as {@link updateFormDefaults}
   * does it: a non-unique `where` is what lets the revision be part of the
   * *condition* instead of being read first and compared afterwards. A
   * read-then-write leaves open precisely the window two admins land in — and
   * the branding is written as a whole document, so the loser of that race
   * loses every colour, not one field.
   *
   * The colours arrive validated: {@link BrandingWrite} is built from
   * `tenantBrandingWriteSchema`, which is the same predicate the delivery gate
   * asks. Nothing is re-checked here, because a second, weaker restatement in
   * the data layer is what this exists to prevent.
   */
  async updateBranding(
    expectedRevision: number,
    data: BrandingWrite,
  ): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id: this.tenantId, brandingRevision: expectedRevision },
      data: {
        name: data.name,
        // **The one place where the union becomes the column** (ADR-0014
        // no. 12). `logo_ref` is a single `text` column and always has been:
        // the union is what travels and what the type system checks, `ref` is
        // what the row holds, and `deliverableBranding` reads the arm back out
        // of the string on the way out. Written once, here, so „wie sieht ein
        // Logo in der Datenbank aus" has one answer.
        logoRef: data.logoRef?.ref ?? null,
        logoWide: data.logoWide,
        // Fresh array: Prisma's generated input is mutable, and handing it a
        // caller's `readonly string[]` would either not compile or share a
        // reference the caller still holds.
        stripeColors: [...data.stripeColors],
        accentColor: data.accent,
        headerColor: data.headerBg,
        canvasColor: data.canvasBg,
        brandingRevision: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /**
   * Replaces the organisation's sending identity.
   *
   * **One column, one argument, and the argument is a whole document.** The
   * block is indivisible (ADR-0013 no. 1), so there is deliberately no way to
   * write a field of it: a `updateSmtpHost` would be exactly the „feldweises
   * Überschreiben" the ADR ruled out, and the rule against it would then live
   * in a service instead of in the shape of this method.
   *
   * **The password arrives sealed**, in the same posture {@link updateOidc}
   * takes for the client secret: the value is built by `MailSecretsService`,
   * which is the only holder of the key in this direction, and this class never
   * sees a plaintext. It cannot be typed as narrowly as `oidcClientSecret` — a
   * JSONB column is `InputJsonValue` — which is why the sealing seam is guarded
   * by its own marker type there rather than here (`SealedSmtpPassword`).
   *
   * `Prisma.DbNull` is „dieser Organisation erbt vom System", and it is the **only**
   * spelling this application writes for it.
   *
   * `updateMany` rather than `update`, for the reason this file gives above: a
   * Organisation that disappeared between the guard and here is a `false` the caller
   * answers, not a thrown Prisma error. Last-write-wins, like the OIDC block —
   * the tab replaces the whole document and carries no revision.
   */
  async updateSmtp(
    smtp: Prisma.InputJsonValue | typeof Prisma.DbNull,
  ): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id: this.tenantId },
      data: { smtp },
    });
    return result.count === 1;
  }

  /**
   * Replaces the organisation's OIDC configuration — **and takes its open
   * invitations along** (Review-Runde 5 no. 3).
   *
   * `updateMany` rather than `update`, for the reason the file gives above: a
   * Organisation that disappeared between the guard and here is a `false` the caller
   * answers, not a thrown Prisma error. There is no revision to compare — the
   * write schema carries none, and the tab replaces the whole block — so this
   * is deliberately last-write-wins.
   *
   * **The secret arrives sealed and is typed as bytes.** `oidcClientSecret` is
   * `Uint8Array | null`, so a plaintext `string` is a compile error here rather
   * than a value in the column; sealing happens in `OidcSecretsService`, which
   * is the only holder of the key in this direction.
   *
   * ## Why a stamp travels with the issuer
   *
   * An SSO invitation is a `user` row stamped with the issuer of the **inviting**
   * organisation (`createOidcInvitation`), and the first login redeems it only
   * against exactly that value (`auth/oidc/oidc-identity.service.ts`). A stamp
   * therefore ages the moment this write puts a different issuer in the column:
   * every invitation of this organisation that nobody has redeemed yet becomes
   * unredeemable — silently, with the invited person locked out and nobody able
   * to see it. „Einladung erneut senden" renewed the link and not the stamp, so
   * there was not even a way back. Hence the re-stamp, in the **same
   * transaction** as the configuration: either both stand or neither does, and
   * there is no window in which a login could read the new issuer against the
   * old stamps.
   *
   * ## Why this cannot reach an invitation of another organisation (ADR-0012)
   *
   * The value written is the one going into **this** organisation's column, never
   * anything a caller could name — the rule ADR-0012 lays down for every stamp:
   * it comes from the configuration of the inviting organisation and never from
   * a request. And the rows it reaches are bounded twice over: they
   * must hold a membership in this organisation and **none anywhere else** (the
   * boundary {@link ScopedMembershipDelegate.accountFacts} draws as
   * `belongsElsewhere`), so an invitation two organisations share is out of
   * reach here. Even that is only half of it: ADR-0012 no. 3a decided that the
   * redemption condition carries the organisation itself, so a re-stamped
   * invitation stays redeemable **only** at the organisation that holds the
   * membership — the stamp was never what separated two organisations, and
   * moving it hands nobody a key to a foreign one.
   *
   * A `null` issuer (SSO cleared or switched off) re-stamps **nothing**: a stamp
   * of `null` would be an invitation no login can ever match — see step 2 of the
   * redemption, where `oidcIssuer` is part of the `where`.
   */
  async updateOidc(data: OidcWrite): Promise<OidcUpdateResult> {
    return this.prisma.$transaction(async (tx) => {
      // Read **inside** the transaction and before the write: whether the
      // issuer really changes is what decides whether anything has to travel
      // with it, and a value read before the transaction could already be the
      // one a parallel save replaced.
      const before = await tx.tenant.findUnique({
        where: { id: this.tenantId },
        select: { oidcIssuer: true },
      });
      const result = await tx.tenant.updateMany({
        where: { id: this.tenantId },
        data: {
          oidcEnabled: data.oidcEnabled,
          oidcIssuer: data.oidcIssuer,
          oidcClientId: data.oidcClientId,
          // A fresh array: Prisma's generated input is mutable, and handing it
          // the caller's own array would let a later mutation reach the client.
          oidcScopes: [...data.oidcScopes],
          oidcEmailClaim: data.oidcEmailClaim,
          oidcEmailVerifiedClaim: data.oidcEmailVerifiedClaim,
          oidcButtonLabel: data.oidcButtonLabel,
          oidcClientSecret: data.oidcClientSecret,
        },
      });
      if (result.count !== 1) {
        return { written: false, restamped: 0 };
      }

      // `issuerStamp` obendrauf, obwohl `checkedIssuer` den Wert schon
      // normalisiert hat: der Stempel muss **immer** das sein, was die Anmeldung
      // aus der Spalte errechnet (Review-Runde 5 Nr. 3). Für den Weg über den
      // Reiter ist das ein No-op — geschrieben steht es, damit ein künftiger
      // Aufrufer dieses Delegats die Zusage nicht aus Versehen bricht.
      const issuer = issuerStamp(data.oidcIssuer);
      if (issuer === null || issuer === before?.oidcIssuer) {
        // Nothing to carry: no issuer to stamp with, or the same one as before.
        // „Unverändert" is a no-op and not a write — a statement that touched
        // every open invitation of the organisation on every save of the tab
        // would make the log line below say something that did not happen.
        return { written: true, restamped: 0 };
      }

      const restamped = await tx.user.updateMany({
        where: {
          // Which rows this organisation may re-stamp at all — spelled once,
          // for both writes that do it ({@link restampableAccount}).
          ...restampableAccount(this.tenantId),
          AND: [
            // Stamped at all — a local invitation carries no issuer and must
            // not get one here, or an account waiting for its password link
            // would turn into an SSO account nobody invited …
            { oidcIssuer: { not: null } },
            // … and stamped with something else, so the number in the log line
            // is the number of invitations that really were stale.
            { oidcIssuer: { not: issuer } },
          ],
        },
        data: { oidcIssuer: issuer },
      });
      return { written: true, restamped: restamped.count };
    });
  }

  /**
   * Replaces the organisation's own base address —
   * `null` for „keine eigene, die Systemvorgabe gilt", never the string
   * `'null'` or an empty string (`tenantBaseUrlWriteSchema` normalises before
   * this is called, the same `normaliseBaseUrl` the system row and
   * `PublicUrlService` use).
   *
   * **Deliberately its own column and its own write, not folded into {@link
   * updateSmtp}.** ADR-0013 no. 3 draws that line for a reason that is not
   * cosmetic: the address is not part of the indivisible mail block, so a
   * Organisation sets or clears it independently of whether it sends over the
   * system's mail server or its own — mixing the two into one document would
   * make „nur die Adresse ändern" look like a field-by-field edit of the
   * block the rule rules out.
   *
   * `updateMany`, for the same reason {@link updateSmtp} and {@link
   * updateOidc} use it: an organisation that disappeared between the guard and here is
   * a `false` the caller answers, not a thrown Prisma error. No revision —
   * last-write-wins, exactly like the other two single-column writes of this
   * class.
   */
  async updatePublicBaseUrl(publicBaseUrl: string | null): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id: this.tenantId },
      data: { publicBaseUrl },
    });
    return result.count === 1;
  }

  /**
   * Sets the reply address of this organisation, or clears it.
   *
   * `null` means „none of its own, the system default applies" — never the empty string
   * (`tenantReplyToWriteSchema` already refuses that).
   *
   * **Its own column and its own write, not folded into {@link
   * updateSmtp}**, for the same reason
   * {@link updatePublicBaseUrl} stands beside it — and here it is even compulsory: the
   * block is indivisible, *because it carries a secret*, and a
   * reply address that could only be saved together with the SMTP password
   * would be out of reach for every organisation that sends over the system and
   * has no block at all.
   *
   * `updateMany` and no revision counter — last-write-wins like the three
   * other single-column writes of this class.
   */
  async updateReplyTo(replyTo: string | null): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id: this.tenantId },
      data: { replyTo },
    });
    return result.count === 1;
  }

  /**
   * The legal texts of this organisation and their counter (ADR-0028) —
   * the same narrow projection that {@link smtp} and {@link publicBaseUrl}
   * take, and for the same reason.
   */
  legal(): Promise<{
    readonly legalPages: Prisma.JsonValue | null;
    readonly legalRevision: number;
  } | null> {
    return this.delegate.findUnique({
      where: { id: this.tenantId },
      select: { legalPages: true, legalRevision: true },
    });
  }

  /**
   * Replaces the legal texts of this organisation — **with** an optimistic
   * lock, unlike the four single-column writes above.
   *
   * The difference is not an inconsistency but the same yardstick: there
   * the document is *one* value that a second write deliberately replaces;
   * here they are two whole legal texts with dozens of fields, and the
   * loser of a race would lose not one field but both pages. It
   * is exactly the situation `updateFormDefaults` and `updateBranding`
   * carry their counter for — and the counter is in the `where`, so that the check
   * *is* the condition and not a read followed by a write.
   */
  async updateLegal(
    expectedRevision: number,
    legalPages: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const result = await this.delegate.updateMany({
      where: { id: this.tenantId, legalRevision: expectedRevision },
      data: { legalPages, legalRevision: { increment: 1 } },
    });
    return result.count === 1;
  }
}

/**
 * The branding of one organisation, on its way into the row.
 *
 * Derived from the shared write schema minus its `revision`, which the delegate
 * takes as its own argument because it belongs in the `where`, not the `data`.
 * Spelled out as a type rather than as `Prisma.TenantUpdateInput` for the
 * reason {@link OidcWrite} gives: the Prisma type also carries `formDefaults`
 * and the whole OIDC block, and a `data` object that *can* say
 * `oidcClientSecret` is a login write hidden inside a colour write.
 */
export type BrandingWrite = Omit<TenantBrandingWrite, 'revision'>;

/**
 * What {@link ScopedTenantDelegate.updateOidc} did.
 *
 * Two facts and not one, because the caller answers them differently: `written`
 * is „gibt es diese Organisation noch" and becomes a 404, `restamped` is how
 * many open SSO invitations travelled with the new issuer and becomes a line in
 * the log. The count lives here rather than in a log line of the delegate: this
 * file holds no `Logger`, and „was ist passiert" is reported where the request
 * is (`tenant-admin/oidc-config.service.ts`).
 */
export interface OidcUpdateResult {
  /** `false` — the organisation disappeared between the guard and the write. */
  readonly written: boolean;
  /**
   * How many unredeemed SSO invitations of this organisation were re-stamped
   * onto the new issuer. `0` whenever the issuer did not change, was cleared,
   * or the organisation had no open invitation of its own.
   */
  readonly restamped: number;
}

/**
 * **Which accounts an organisation may move an issuer stamp on** — one
 * spelling, two writes (Review-Runde 5 no. 3).
 *
 * Both places that re-stamp an SSO invitation use it: the issuer change
 * ({@link ScopedTenantDelegate.updateOidc}) and „Einladung erneut senden"
 * ({@link ScopedMembershipDelegate.resendInvitation}). A second version would be
 * a second answer to „wessen Einladung ist das", and the one somebody forgets is
 * the one at the newer call site — the same argument
 * {@link TenantUsersService.requireOwnAccount} makes for its three conditions.
 *
 * Every clause is load-bearing:
 *
 * - `oidcSubject` — an account that has signed in once is bound, not invited.
 *   Re-pointing it would move a person's **identity** to another provider
 *   (ADR-0012: the key is the pair).
 * - `passwordHash` — **no provider ever reaches a local account**, in the same
 *   words the redemption uses. Belt and braces beside the CHECK
 *   `user_local_or_oidc`, which already forbids password *and* issuer together.
 * - `isSuperadmin` — the refusal `TenantUsersService.resendInvitation` gives
 *   with `SUPERADMIN_ACCOUNT_MESSAGE`: no organisation decides which provider
 *   may claim an account that administers the whole installation, and
 *   `SuperadminsService.promote` can turn an open invitation into exactly such
 *   an account. ⚠️ Those accounts therefore keep a stale stamp, and no route of
 *   an organisation repairs it — the way back is „Superadmin entziehen, erneut
 *   senden, wieder befördern", or the system administration sets a password.
 * - `memberships` — a member of **this** organisation and of no other: the
 *   boundary {@link ScopedMembershipDelegate.accountFacts} draws as
 *   `belongsElsewhere`. An invitation that belongs to a second organisation as
 *   well is none of this one's business to re-point.
 *
 * The **issuer** condition is deliberately *not* in here: the two callers ask
 * different things of it (»anything but the new value« versus »exactly this
 * row«), and folding both into one fragment would make the shared part say
 * something neither caller means.
 */
function restampableAccount(tenantId: string): Prisma.UserWhereInput {
  return {
    oidcSubject: null,
    passwordHash: null,
    isSuperadmin: false,
    memberships: {
      some: { tenantId },
      none: { tenantId: { not: tenantId } },
    },
  };
}

/**
 * The OIDC block of one organisation, on its way into the row.
 *
 * Spelled out rather than taken from `Prisma.TenantUpdateInput`, for the reason
 * {@link GroupWrite} is spelled out: the Prisma type also carries
 * `formDefaults`, `formDefaultsRevision` and every branding column, and a
 * `data` object that *can* say `formDefaults` is a settings write hidden inside
 * a login write — reviewed as the latter, effective as the former.
 */
export interface OidcWrite {
  readonly oidcEnabled: boolean;
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  readonly oidcScopes: readonly string[];
  /** The claim the address is read from — never empty. */
  readonly oidcEmailClaim: string;
  /** The claim that vouches for it, or `''` for „ohne Gegenprüfung". */
  readonly oidcEmailVerifiedClaim: string;
  readonly oidcButtonLabel: string | null;
  /**
   * **Ciphertext or nothing** — see {@link ScopedTenantDelegate.updateOidc}.
   *
   * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array` because that is
   * what Prisma's `Bytes` is; the bare form also admits a `SharedArrayBuffer`
   * view, which the client rejects.
   */
  readonly oidcClientSecret: Uint8Array<ArrayBuffer> | null;
}

/**
 * Whether a stored `settings_override` says „dieses Formular hat diesen
 * Abschnitt übernommen" — and **only** if it says so in as many words.
 *
 * Read off the raw JSON rather than through `parseFormSettingsOverride`,
 * because this runs inside the tenant write and must not be able to fail: the
 * document also carries the sealed access word, and opening it needs a key
 * holder this file has no business importing (`CONTRIBUTING.md`, the module
 * boundary of `SettingsSecretsService`). Only one boolean is needed and it is
 * not a secret.
 *
 * Anything that is not a literal `true` — an absent column (an older form), a
 * document from an older version, a row somebody hand-edited — counts as
 * *inheriting*. That is the safe direction for both readers below: an edit link
 * too many taken away costs a participant a fresh registration, one too few
 * leaves the gate open; and a draft expiry pulled down too eagerly costs
 * at most somebody's half-filled form, one left standing outlives a deadline.
 *
 * **Two sections are asked about, and they are not the same question**
 * (a review finding): the revocation rule follows *Zugriff &
 * Sicherheit* (`access`, where the access word lives), the draft expiry follows
 * *Verfügbarkeit* (`avail`, where the deadline lives). A single list for both would
 * be wrong in both directions — a form with its own word but the organisation's deadline
 * inherits exactly one of the two writes.
 */
function takesOverSection(
  stored: Prisma.JsonValue,
  section: 'access' | 'avail',
): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return false;
  }
  const overridden = (stored as Record<string, Prisma.JsonValue>).overridden;
  if (
    typeof overridden !== 'object' ||
    overridden === null ||
    Array.isArray(overridden)
  ) {
    return false;
  }
  return (overridden as Record<string, Prisma.JsonValue>)[section] === true;
}

/**
 * What a caller may say about *which* forms it wants — `tenantId` omitted for
 * the reason spelled out at {@link ScopedGroupQuery}.
 */
export interface ScopedFormQuery {
  readonly where?: Omit<Prisma.FormWhereInput, 'tenantId'>;
  readonly orderBy?:
    Prisma.FormOrderByWithRelationInput | Prisma.FormOrderByWithRelationInput[];
  /**
   * One page of the result — `skip`/`take` in Prisma's own
   * spelling, so the offset contract of `@formsache/shared` translates without a
   * second vocabulary in between.
   *
   * They are **optional and unbounded here** on purpose: this delegate's job is
   * the tenant binding, not the page size. The ceiling belongs to the wire
   * contract (`FORM_PAGE_SIZE_MAX`), where a caller can read it, and a second
   * clamp in here would be a second answer to „wie groß darf eine Seite sein".
   */
  readonly skip?: number;
  readonly take?: number;
}

/** A form together with the version participants currently fill in. */
export type FormWithPublished = Form & {
  publishedVersion: FormVersion | null;
};

/** …plus the number of answers it has collected. */
export type FormWithCounts = FormWithPublished & {
  _count: { responses: number };
};

/** What the settings routes read of a form, and nothing else. */
export type FormSettingsRow = Pick<
  Form,
  | 'id'
  | 'deletedAt'
  | 'settingsOverride'
  | 'settingsRevision'
  /**
   * The privacy notice of this form (ADR-0028 no. 4).
   *
   * It is in this projection because it is edited on the **same** page
   * and saved with the same `PUT` as the settings: a
   * second route for a field of the same card would be a second guard, a
   * second revision and a second save button for one operation that
   * a person experiences as one.
   */
  | 'privacyNotice'
>;

/**
 * A deleted answer with everything a restore decides from —
 * the snapshot it was given under, and the live form behind it.
 *
 * The two settings documents (`tenant.formDefaults`, `form.settingsOverride`)
 * travel because the Antwortlimit is theirs, and the *published* snapshot
 * because the Obergrenze is an operating limit read from the live form rather
 * than from the version this answer was given under (`withLiveCapacity`).
 */
export type DeletedResponseRow = Response & {
  formVersion: { schema: Prisma.JsonValue };
  form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    publishedVersion: { schema: Prisma.JsonValue } | null;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  };
};

/**
 * What a restore is allowed to decide from — read **under the form's lock** by
 * {@link ScopedFormDelegate.restoreResponse} and handed to the caller's verdict.
 *
 * `liveResponses` counts the answers that are not in the trash, i.e. the
 * same `where` the submission path's Antwortlimit counts with.
 * `takenSeats` is keyed by `seatKey` and does **not** contain the seats of the
 * answer being restored — it is still deleted while the sum is read.
 * `restoringSeats` is what the sum will grow by: the answer's own
 * `event_registration` rows, which never went away.
 */
export interface RestoreFacts {
  readonly liveResponses: number;
  readonly takenSeats: ReadonlyMap<string, number>;
  readonly restoringSeats: readonly (SeatPosition & { seats: number })[];
}

/**
 * What {@link ScopedFormDelegate.restoreResponse} answers.
 *
 * `not-found` is not the same as `refused`: the first means the row stopped
 * matching between the caller's read and the write — somebody restored it in
 * another tab, or deleted the form — and the second means the row is still
 * there and deliberately stays there. Collapsing the two would tell an
 * editor „ausgebucht" about an answer that is no longer in the trash
 * at all.
 */
export type RestoreOutcome<TRefusal> =
  | { readonly kind: 'restored' }
  | { readonly kind: 'refused'; readonly refusal: TRefusal }
  | { readonly kind: 'not-found' };

/**
 * The rollback signal of {@link ScopedFormDelegate.softDeleteResponses}.
 *
 * Module-private and never thrown out of that method: it exists because a
 * Prisma interactive transaction is rolled back by an exception and by nothing
 * else, and „not every id matched" has to roll back rather than commit.
 */
class IncompleteBulkDelete extends Error {}

/**
 * The forms of one tenant, and everything hanging off them.
 *
 * Forms, their versions and the answers to them share one delegate rather than
 * getting three, because they share one invariant: an answer belongs to a
 * version, a version belongs to a form, and all three belong to the tenant of
 * this scope. Splitting them would make it possible to reach a version through
 * one delegate and a form through another, and the two would have to be
 * checked against each other by hand — which is the class of mistake this
 * whole design exists to make unspellable.
 *
 * Writes are here too, unlike's read-only surface. The rule stays the
 * same: the tenant is never a parameter, it is merged in last and it is part
 * of the *unique key* wherever a single row is addressed.
 */
export class ScopedFormDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * Forms of this tenant with the number of answers each has — what the
   * dashboard card shows.
   *
   * Counted in the database rather than by loading the rows: a Jahrestagung
   * registration has hundreds of answers and the dashboard needs none of them.
   */
  findManyWithCounts(query: ScopedFormQuery = {}): Promise<FormWithCounts[]> {
    return this.prisma.form.findMany({
      ...query,
      where: { ...query.where, tenantId: this.tenantId },
      include: {
        publishedVersion: true,
        _count: { select: { responses: { where: { deletedAt: null } } } },
      },
    });
  }

  /**
   * **How many forms of this tenant match** — the `total` of one page.
   *
   * It takes the **same** `where` fragment {@link findManyWithCounts} takes,
   * and callers are expected to hand it literally the same object. That is the
   * whole design: „24 von 2748" is only true if the 2748 was counted under the
   * conditions the 24 was selected under — a count that forgot the trash
   * filter, the search term or the form restriction would report forms the
   * caller may never reach, on every page, forever.
   *
   * The tenant is merged in last here exactly as it is there, so a count
   * cannot be the one read that escaped the organisation.
   */
  countMatching(
    where: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
  ): Promise<number> {
    return this.prisma.form.count({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  /**
   * **How many answers the matching forms hold together** — the „Antworten
   * gesamt" of the dashboard, counted in PostgreSQL.
   *
   * Counted rather than summed out of the page for the reason the page exists:
   * the page is twenty-four forms and the figure is about all of them. The
   * `form` relation carries the **same** fragment the list is selected under,
   * so „gesamt" means „gesamt über genau die Formulare, die Liste zeigt" —
   * including under a search, and excluding a form the caller is locked out of.
   *
   * The tenant is merged in **twice on purpose**: once on the answer and once
   * on the form it hangs off. Either alone would be enough today; both together
   * mean no future edit to one of them can widen this count past the organisation.
   */
  countResponsesIn(
    where: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
  ): Promise<number> {
    return this.prisma.response.count({
      where: {
        tenantId: this.tenantId,
        deletedAt: null,
        form: { ...where, tenantId: this.tenantId },
      },
    });
  }

  /**
   * One form of this tenant, or `null` — and `null` for a form of another organisation
   * just as much as for one that does not exist.
   *
   * `findUnique` on the composite key `(id, tenant_id)`, not
   * `findFirst({ where: { id, tenantId } })`: dropping the tenant here leaves
   * the key incomplete and fails to compile, whereas dropping a key from a
   * `where` object compiles and still returns a row.
   */
  findById(id: string): Promise<FormWithCounts | null> {
    return this.prisma.form.findUnique({
      where: { id_tenantId: { id, tenantId: this.tenantId } },
      include: {
        publishedVersion: true,
        // Counted here as well, not only in the list. An earlier draft
        // returned a hard-coded 0 on this route with the argument that the
        // builder does not show the number — but the wire contract has the
        // field, so a consumer cannot tell "no answers" from "not counted".
        // A wrong value is worse than an extra count on an indexed column.
        _count: { select: { responses: { where: { deletedAt: null } } } },
      },
    });
  }

  /**
   * A new form of this organisation.
   *
   * `settingsOverride` is optional and means „nichts entschieden": the column
   * has `@default("{}")`, and an absent decision *is* the decision (the
   * model's own comment). It is present at all because „aus einer Vorlage
   * anlegen"  starts a form with the settings the template carries —
   * server-side, because the access word is not a value a client ever holds.
   */
  create(data: {
    title: string;
    draftSchema: Prisma.InputJsonValue;
    publicSlug: string;
    settingsOverride?: Prisma.InputJsonValue;
  }): Promise<Form> {
    return this.prisma.form.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  /**
   * Creates a duplicate of a form: a fresh draft row plus its notifications,
   * in one transaction.
   *
   * Everything the row and its notifications need has already been decided by
   * the caller (`FormsService.duplicate`) — a fresh public address, a
   * settings document with its access word taken out
   * (`stripOverridePassword`), and notification bodies/recipients already
   * naming the **new** question ids (`duplicateFormDefinition`,
   * `rewriteQuestionPlaceholders`, `rewriteRecipientQuestionIds`, all
   * `@formsache/shared`). This method only writes what it is handed, and writes all
   * of it or none: a form without the notifications it is supposed to carry —
   * or notifications pointing at a form id that never committed — is not a
   * partial duplicate an editor can work with, it is a broken one, and the
   * price of avoiding that is one transaction on a route nobody calls in a
   * hot loop.
   *
   * Deliberately absent from `data`, and absent for a reason each: no
   * `FormVersion` (the duplicate is a draft — there
   * is nothing to snapshot yet), no `Response`/`EventRegistration`/`File`
   * (nothing was ever submitted to *this* row), no `FormPermission` (a
   * duplicate starts like any other new form, governed by group rights alone,
   * the same as `create()` above).
   */
  async duplicate(data: {
    title: string;
    draftSchema: Prisma.InputJsonValue;
    publicSlug: string;
    settingsOverride: Prisma.InputJsonValue;
    /**
     * The privacy notice of the source, or `undefined` — see the caller.
     *
     * `undefined` and not `Prisma.DbNull`: Prisma reads a missing field
     * as „not specified", and the column is `NULL` anyway. The difference
     * is that this file thereby manages without a **value** import of `Prisma`
     * — it imports the namespace as a type, and that is meant to stay
     * that way.
     */
    privacyNotice?: Prisma.InputJsonValue;
    notifications: readonly NotificationWrite[];
  }): Promise<Form> {
    return this.prisma.$transaction(async (tx) => {
      const form = await tx.form.create({
        data: {
          title: data.title,
          draftSchema: data.draftSchema,
          publicSlug: data.publicSlug,
          settingsOverride: data.settingsOverride,
          ...(data.privacyNotice === undefined
            ? {}
            : { privacyNotice: data.privacyNotice }),
          tenantId: this.tenantId,
        },
      });

      if (data.notifications.length > 0) {
        await tx.notification.createMany({
          data: data.notifications.map((notification) => ({
            ...notification,
            formId: form.id,
            tenantId: this.tenantId,
          })),
        });
      }

      return form;
    });
  }

  /**
   * Saves a draft **only if** nobody else saved since `expectedRevision`.
   *
   * `updateMany` rather than `update`, and that is the whole point:
   * `updateMany` takes a non-unique `where`, so the revision can be part of the
   * condition instead of being read first and compared afterwards. A
   * read-then-write would leave the window between the two open — which is
   * exactly the window two editors land in.
   *
   * Returns whether a row matched. `false` means "someone was faster", never
   * "no such form" — the caller has already resolved the form through
   * {@link findById}.
   */
  async updateDraft(
    id: string,
    expectedRevision: number,
    data: { title: string; draftSchema: Prisma.InputJsonValue },
  ): Promise<boolean> {
    const result = await this.prisma.form.updateMany({
      where: { id, tenantId: this.tenantId, revision: expectedRevision },
      data: { ...data, revision: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Publishes the current draft as the next immutable version.
   *
   * One transaction, because three writes have to agree: the next version
   * number is read, the snapshot is inserted and the form is pointed at it. A
   * second publish running in between would otherwise pick the same version
   * number — and `@@unique([formId, version])` would turn that into an error
   * from PostgreSQL rather than a wrong row, but an error whose message names
   * a constraint is not an answer an editor can act on.
   *
   * The revision guard from {@link updateDraft} applies here too: you publish
   * what you last saw.
   */
  async publish(
    id: string,
    expectedRevision: number,
    schema: Prisma.InputJsonValue,
  ): Promise<FormVersion | null> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.form.updateMany({
        where: { id, tenantId: this.tenantId, revision: expectedRevision },
        data: { revision: { increment: 1 }, status: 'active' },
      });
      if (claimed.count !== 1) {
        return null;
      }

      const latest = await tx.formVersion.findFirst({
        where: { formId: id, tenantId: this.tenantId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const version = await tx.formVersion.create({
        data: {
          tenantId: this.tenantId,
          formId: id,
          version: (latest?.version ?? 0) + 1,
          schema,
        },
      });

      await tx.form.update({
        where: { id_tenantId: { id, tenantId: this.tenantId } },
        data: { publishedVersionId: version.id },
      });

      return version;
    });
  }

  /**
   * The columns the settings routes actually read.
   *
   * A projection of its own next to {@link findById}, because the settings
   * surface needs none of what that one joins: the published version and the
   * answer count are two extra pieces of work per request for a page that
   * shows neither.
   */
  findSettingsById(id: string): Promise<FormSettingsRow | null> {
    return this.prisma.form.findUnique({
      where: { id_tenantId: { id, tenantId: this.tenantId } },
      select: {
        id: true,
        deletedAt: true,
        settingsOverride: true,
        settingsRevision: true,
        privacyNotice: true,
      },
    });
  }

  /**
   * Replaces a form's `settings_override` **only if** nobody else did since
   * `expectedRevision`.
   *
   * `updateMany` on the tenant-bound `where` rather than `update` on the
   * composite key: a non-unique `where` is what lets the revision be part of
   * the condition, and `update` would raise instead of reporting a miss.
   *
   * Returns whether a row matched. The caller has already resolved the form, so
   * `false` means „somebody was faster", not „no such form".
   *
   * **`form.revision` is deliberately not touched.** The optimistic lock
   * belongs to the *definition*: bumping it here would make an open
   * builder tab fail its next save with „bitte neu laden" because somebody
   * changed a deadline in another window — a conflict between two edits that
   * never touched the same document.
   *
   * **`revokeParticipantLinks` takes back both public addresses of this form, in
   * the same transaction**  — the `edit_token` of every
   * answer and every zwischengespeicherter Entwurf. *Whether* a
   * write revokes is the caller's question and is answered once, in
   * `@formsache/shared` (`revokesEditLinks`); *that* it happens together with the
   * settings write is this method's job. A half revocation — new word stored,
   * old links alive, or links cleared while the save lost its optimistic lock —
   * is worse than none, because both halves would then have to be reconstructed
   * by hand from a settings page that shows neither.
   *
   * **The drafts are not an afterthought of the same rule, they are the sharper
   * half of it.** An edit link opens one answer; a draft address opens the
   * **complete field definition** of the form to an unauthenticated `GET`, which
   * is exactly the thing the requirement promises does not exist behind the gate.
   *
   * The transaction wraps the plain case too. One statement is atomic on its
   * own, so it buys nothing there except that the guarantee does not depend on
   * which branch a reader happens to be looking at; a settings save is an
   * editor action a few times a day, not a hot path.
   *
   * ## `capDraftsAt` — the deadline pulls the drafts after it (a review finding)
   *
   * A draft dies with the deadline of its form, and the boundary is
   * computed **when the draft is written** and stored on its row. So a deadline
   * that moves afterwards used to leave every existing draft where it was.
   * *Measured on 2026-08-05:* a draft without a deadline got `expiresAt`
   * 2026-09-04; the deadline was then set to 2026-08-06 — the row stayed
   * unchanged, i.e. **29 days past the deadline**, and the promise „it
   * disappears when the deadline ends" was wrong for exactly the drafts that
   * already existed.
   *
   * **Only downwards, and that is the decision, not the convenient way.**
   * The caller hands in the *deadline* (`draftDeadline` in `@formsache/shared`), and
   * the statement below moves only rows that sit **after** it. The other
   * reading — re-applying `draftExpiresAt` to the new settings — was rejected
   * because of what it does when there is no deadline: it would hand every draft of
   * the form thirty fresh days measured from an **editor's click**, so changing
   * a display flag would lengthen a retention on somebody else's personal data.
   * The visible difference is a deadline that is **extended**: the drafts do not
   * follow it up. That is deliberate — their boundary was already promised, a
   * participant who wants longer resumes the draft (`updateDraft` recomputes it
   * from the new settings), and „kürzer als versprochen" is the direction
   * data minimisation is on.
   *
   * `null` therefore means „diese Einstellungen haben keine Frist" and touches
   * nothing.
   */
  async updateSettingsOverride(
    id: string,
    expectedRevision: number,
    settingsOverride: Prisma.InputJsonValue,
    /**
     * The privacy notice of this form, in the **same** write
     * (ADR-0028 no. 4).
     *
     * An argument of its own and not an option: it is edited on the same page
     * and sent with the same `PUT`, so it belongs in the same
     * statement. Two statements would be two outcomes — the notice
     * stored and the settings failed on the revision, or the other way
     * round —, and the person in front of it pressed *Speichern* once.
     *
     * `undefined` means **„not touched"**: Prisma leaves a missing field
     * out of the `UPDATE`, so the column stays as it was. That is
     * not the same as an empty document, and it is the reason why the
     * field may be optional on the wire without silence becoming a
     * deletion.
     */
    privacyNotice: Prisma.InputJsonValue | undefined,
    options: {
      readonly revokeParticipantLinks?: boolean;
      readonly capDraftsAt?: Date | null;
    } = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.form.updateMany({
        where: {
          id,
          tenantId: this.tenantId,
          settingsRevision: expectedRevision,
        },
        data: {
          settingsOverride,
          ...(privacyNotice === undefined ? {} : { privacyNotice }),
          settingsRevision: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        // Somebody was faster. Nothing was stored, so nothing is revoked
        // either — the write this revocation belongs to did not happen.
        return false;
      }

      if (options.revokeParticipantLinks === true) {
        await tx.response.updateMany({
          // Answers in the trash are included on purpose: a deleted answer
          // that is restored later must not come back with a link that was
          // supposed to be revoked while it was away.
          where: { formId: id, tenantId: this.tenantId },
          data: { editToken: null },
        });
        // The drafts of this form — **deleted, not cleared**, for the reason
        // written out at {@link updateFormDefaults}: their token is the row's
        // only door, so a cleared one would leave a document nobody can reach.
        await tx.responseDraft.deleteMany({
          where: { formId: id, tenantId: this.tenantId },
        });
      }

      // After the revocation and not before it: what that statement deleted
      // needs no boundary, and running the two the other way round would move
      // the expiry of rows that are about to go — a write for nothing.
      const capDraftsAt = options.capDraftsAt ?? null;
      if (capDraftsAt !== null) {
        await tx.responseDraft.updateMany({
          where: {
            formId: id,
            tenantId: this.tenantId,
            // Only what sits **after** the new deadline. This is what makes the
            // statement a floor rather than a reset: a draft that already dies
            // earlier keeps its own boundary.
            expiresAt: { gt: capDraftsAt },
          },
          data: { expiresAt: capDraftsAt },
        });
      }

      return true;
    });
  }

  /**
   * Every published snapshot of one form of this tenant, oldest first.
   *
   * The responses view is built from all of them, not from the newest and not
   * from the draft: a question that was removed keeps its column and its
   * answers stay exportable. Ordered here rather than by the caller, because
   * "newest wins" decides both the label of a merged column and the column
   * order, and an unordered read would make that depend on the plan PostgreSQL
   * happened to pick.
   */
  versionsOf(formId: string): Promise<FormVersion[]> {
    return this.prisma.formVersion.findMany({
      where: { formId, tenantId: this.tenantId },
      orderBy: { version: 'asc' },
    });
  }

  /**
   * The versions that answers actually point at — usually far fewer than the
   * published ones.
   *
   * `distinct` in the database rather than a `Set` over loaded rows: the answers
   * of a Jahrestagung registration run into the hundreds and none of their
   * contents is wanted here, only which handful of snapshots has to travel with
   * the responses view.
   */
  async answeredVersionIds(formId: string): Promise<string[]> {
    const rows = await this.prisma.response.findMany({
      where: { formId, tenantId: this.tenantId, deletedAt: null },
      distinct: ['formVersionId'],
      select: { formVersionId: true },
    });
    return rows.map((row) => row.formVersionId);
  }

  /** Answers to one form of this tenant, newest first. */
  responsesOf(
    formId: string,
  ): Promise<(Response & { formVersion: FormVersion })[]> {
    return this.prisma.response.findMany({
      where: { formId, tenantId: this.tenantId, deletedAt: null },
      include: { formVersion: true },
      orderBy: { submittedAt: 'desc' },
    });
  }

  // ---- Trash  ---------------------------------

  /**
   * The forms of this organisation that are **in** the trash, newest deletion
   * first.
   *
   * The mirror image of {@link findManyWithCounts}'s `deletedAt: null`, and
   * written as its own method rather than as a flag on that one: a boolean
   * parameter that decides whether a query returns live or deleted rows is one
   * a caller can pass the wrong way round, and the wrong way round here is a
   * dashboard listing the trash.
   *
   * The answer count excludes answers that are themselves deleted — they are
   * their own rows in {@link deletedResponses} and counting them in both
   * sections would make the trash add up to more than it holds.
   *
   * It takes a `where` fragment and **not** a {@link ScopedFormQuery}, unlike
   * its live counterpart: the order is „zuletzt gelöscht zuerst" and that is
   * the trash's, not a caller's. A parameter for it would be one a caller
   * could set to something under which „was verschwindet zuerst" stops meaning
   * anything.
   */
  findManyDeleted(
    where: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
  ): Promise<(Form & { _count: { responses: number } })[]> {
    return this.prisma.form.findMany({
      where: {
        ...where,
        tenantId: this.tenantId,
        deletedAt: { not: null },
      },
      include: {
        _count: { select: { responses: { where: { deletedAt: null } } } },
      },
      orderBy: { deletedAt: 'desc' },
    });
  }

  /**
   * The answers of this organisation that are in the trash, newest deletion
   * first, with the title of the form each belongs to.
   *
   * **Answers of a form that is itself deleted are left out**, and that is a
   * decision rather than an omission: the trash offers one verb per row,
   * and „wiederherstellen" on an answer whose form is in the section above
   * would put the answer back into a form nobody can open. Restoring the form
   * brings the answer's row back into this section, where the verb means what
   * it says.
   */
  deletedResponses(
    formWhere: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
  ): Promise<(Response & { form: { id: string; title: string } })[]> {
    return this.prisma.response.findMany({
      where: {
        tenantId: this.tenantId,
        deletedAt: { not: null },
        // The caller's fragment names *forms* (it is `FormRestriction`'s), and
        // it is spread **before** the two conditions this method owns, so
        // neither can be overwritten by it.
        form: { ...formWhere, deletedAt: null },
      },
      include: { form: { select: { id: true, title: true } } },
      orderBy: { deletedAt: 'desc' },
    });
  }

  /**
   * Moves a form of this organisation into the trash.
   *
   * `updateMany` with `deletedAt: null` in the `where`, not `update` on the
   * composite key: deleting twice must write **one** deletion moment, or the
   * 30-day countdown restarts every time somebody presses the button
   * again on a stale page. Returns whether a row matched — `false` means „not
   * this organisation's, unknown, or already in the trash", and the caller has
   * already resolved which through {@link findById}.
   */
  async softDelete(id: string, deletedAt: Date): Promise<boolean> {
    const result = await this.prisma.form.updateMany({
      where: { id, tenantId: this.tenantId, deletedAt: null },
      data: { deletedAt },
    });
    return result.count === 1;
  }

  /** One form of this organisation **including** a deleted one — the trash's read. */
  findDeletedById(id: string): Promise<Form | null> {
    return this.prisma.form.findUnique({
      where: { id_tenantId: { id, tenantId: this.tenantId } },
    });
  }

  /**
   * Takes a form back out of the trash.
   *
   * **Nothing to check.** Unlike an answer (see {@link restoreResponse}), a
   * form occupies no seat and counts against no limit; its own answers were
   * never deleted with it and were counted all along. `deletedAt: { not: null }`
   * in the `where` keeps a double press from being a write.
   */
  async restore(id: string): Promise<boolean> {
    const result = await this.prisma.form.updateMany({
      where: { id, tenantId: this.tenantId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    return result.count === 1;
  }

  /**
   * Moves one answer of one form of this organisation into the trash.
   *
   * **No lock and no transaction, unlike {@link restoreResponse}**, and the
   * asymmetry is the whole reason that one is hard: deleting only ever *frees*
   * a seat and lowers the answer count. A submission or a correction that read
   * the sum before this statement committed decided against the larger number
   * and can only have refused somebody who would have fit — the direction that
   * is recoverable by pressing the button again.
   *
   * `formId` is in the `where` beside the id: the route names both, and a
   * statement that matched the answer alone would delete an answer of a
   * *different* form of the same organisation if the two ids were ever mixed up at the
   * call site.
   */
  async softDeleteResponse(
    where: { id: string; formId: string },
    deletedAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.response.updateMany({
      where: {
        id: where.id,
        formId: where.formId,
        tenantId: this.tenantId,
        deletedAt: null,
      },
      data: { deletedAt },
    });
    return result.count === 1;
  }

  /**
   * **Moves several answers of one form into the trash — all of them or
   * none** (the action bar of the responses table).
   *
   * ## Why the `where` is the whole rights check, and why it is per id
   *
   * The guard chain runs once per request, over the **form** in the path — it
   * says „diese Person darf Antworten dieses Formulars löschen" and cannot say
   * anything about a single id in the body. What decides *per answer* is this
   * `where`: `tenantId` and `formId` beside `id: { in: … }`, so an id of
   * another organisation or of another form of the same organisation simply does not match. It
   * is the same condition {@link softDeleteResponse} carries for one id, and it
   * is the reason a foreign id in the middle of an otherwise permitted list
   * cannot be deleted by naming it next to twenty legitimate ones.
   *
   * ## All or nothing, and why that is the right refusal
   *
   * `count !== ids.length` rolls the transaction back and answers `false`; the
   * caller turns that into the same 404 one unknown id produces. The
   * alternative — delete what matched and report the rest — is the worst of the
   * three possible answers: „teilweise gelöscht, 404 gemeldet" leaves the
   * caller with a refusal in front of them and a table that has changed
   * underneath, and the one honest recovery from it (press again) would then
   * delete *nothing*, because the ids that did go through are gone. All or
   * nothing is repeatable: the reader takes the row that vanished out of the
   * selection and presses again.
   *
   * **The ids must be unique.** `[a, a]` matches one row and would look like a
   * partial match to the count; {@link TrashService.deleteResponses} dedupes
   * before calling.
   *
   * **No lock, like {@link softDeleteResponse}** and for the same reason:
   * deleting only ever frees a Veranstaltungsplatz and lowers the answer count,
   * so a submission that read the sum before this statement committed can only
   * have refused somebody who would have fit — the recoverable direction.
   *
   * **{@link BULK_TRANSACTION_BOUNDS} rather than Prisma's defaults** (a review
   * finding). `maxWait` 2 s and `timeout` 5 s are the numbers the purge
   * transactions below already refuse, and for the same reason: this is one
   * `UPDATE` over up to `RESPONSE_BULK_DELETE_MAX` rows, on a table with the
   * organisation's whole answer history in it, and running out of the default budget
   * ends in `P2028` — a 500 with nothing to say, where the caller was told
   * „ganz oder gar nicht". It was the last mass statement of this file still on
   * the defaults: the purges below do the same kind of work and were
   * deliberately taken off them, and this is the one whose row count a *caller*
   * chooses, up to a thousand at a time.
   */
  async softDeleteResponses(
    where: { ids: readonly string[]; formId: string },
    deletedAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const result = await tx.response.updateMany({
          where: {
            id: { in: [...where.ids] },
            formId: where.formId,
            tenantId: this.tenantId,
            deletedAt: null,
          },
          data: { deletedAt },
        });
        if (result.count !== where.ids.length) {
          // Thrown rather than returned: a value would commit what has already
          // been written. The rollback *is* the promise of this method.
          throw new IncompleteBulkDelete();
        }
      }, BULK_TRANSACTION_BOUNDS);
      return true;
    } catch (error) {
      if (error instanceof IncompleteBulkDelete) {
        return false;
      }
      throw error;
    }
  }

  /**
   * One deleted answer of this organisation with everything a restore has to decide
   * from — the snapshot it was given under, and the live form with the two
   * settings documents behind it.
   *
   * A form that is itself in the trash answers `null`, for the reason
   * {@link deletedResponses} states.
   */
  findDeletedResponse(where: {
    id: string;
    formId: string;
  }): Promise<DeletedResponseRow | null> {
    return this.prisma.response.findFirst({
      where: {
        id: where.id,
        formId: where.formId,
        tenantId: this.tenantId,
        deletedAt: { not: null },
        form: { deletedAt: null },
      },
      include: {
        formVersion: { select: { schema: true } },
        form: {
          select: {
            id: true,
            settingsOverride: true,
            publishedVersion: { select: { schema: true } },
            tenant: { select: { id: true, formDefaults: true } },
          },
        },
      },
    });
  }

  /**
   * **Takes an answer back out of the trash — under the form's lock**.
   *
   * ## Why the lock is not optional here
   *
   * This is the route the note on `heldSeats` names. That function argues its
   * difference can only come out too *small*, and the argument holds „solange
   * nichts wiederherstellt": a restore raises the committed sum, so one landing
   * between another transaction's `takenSeats` and its `COMMIT` lowers the very
   * number that transaction decided on — and the `deleted_at IS NULL` of its own
   * `UPDATE` has nothing to object to, because that condition is about the
   * answer *being edited*, not about the one coming back.
   *
   * The lock is {@link lockForm}, i.e. the **same object and the same function**
   * the submission and the correction take (`public/event-seats.ts`). Not a
   * lock of its own: two lock objects on the write paths of one form are two
   * lock orders, and two lock orders are a deadlock waiting for the first form
   * that has both an Antwortlimit and a Veranstaltung.
   *
   * **Taken unconditionally**, unlike the submission path, which takes it only
   * when something is actually bounded. That branch exists there because the
   * public route is what a whole organisation hits in the minute a registration opens;
   * a restore is an editor pressing a button a few times a day. Deciding
   * „gibt es hier überhaupt eine Grenze?" a second time, in a second place, so
   * that the two readings have to agree, would buy nothing but a way for them
   * to disagree.
   *
   * ## What it decides, and what it does not
   *
   * The facts are read here, under the lock; the **verdict** is the caller's
   * ({@link decide}). That split is the one this file makes everywhere: the
   * tenant and the lock are this class's business, the Antwortlimit and the
   * Obergrenze are the trash service's, and neither can be forgotten by
   * the other. `decide` answering `null` means „nichts spricht dagegen".
   *
   * The answer's **own** seats are absent from `takenSeats` — that sum joins
   * `response` and filters `deleted_at IS NULL`, and this answer is deleted
   * while the sum is read. So the caller asks for its full seat count, not for
   * a difference: this is not a correction, it is an arrival.
   */
  async restoreResponse<TRefusal>(
    where: { id: string; formId: string },
    decide: (facts: RestoreFacts) => TRefusal | null,
  ): Promise<RestoreOutcome<TRefusal>> {
    return this.prisma.$transaction(async (tx) => {
      await lockForm(tx, where.formId, this.tenantId);

      /*
       * **Is the form still there?** — asked here, under the lock this
       * transaction already holds, and nowhere else (a review finding).
       *
       * The caller resolved the form *outside* this transaction
       * (`findDeletedResponse`, which does filter `form.deletedAt`), and
       * {@link softDelete} takes no lock at all, so a form can be moved into
       * the trash inside that window. The `updateMany` below would not
       * notice: its `where` names the answer, the tenant and `deleted_at`, and
       * none of those is a statement about the form. The outcome was a 204 for
       * an answer that now lives in a deleted form — listed in **neither**
       * section of the trash ({@link deletedResponses} leaves it out),
       * counted by `takenSeats` all the same, and nobody able to free its seats
       * until somebody restores the form.
       *
       * It costs one indexed read of a row this transaction holds exclusively.
       */
      const form = await tx.form.findUnique({
        where: { id_tenantId: { id: where.formId, tenantId: this.tenantId } },
        select: { deletedAt: true },
      });
      // `?.` covers both refusals at once: no row (`undefined`) and a deleted
      // one (a `Date`) are both „nicht null", an alive one is not.
      if (form?.deletedAt !== null) {
        // `not-found`, never `refused`: the answer is not restorable at all
        // here, and „ausgebucht" would be a sentence about a form that is gone.
        return { kind: 'not-found' };
      }

      const liveResponses = await tx.response.count({
        where: {
          formId: where.formId,
          tenantId: this.tenantId,
          deletedAt: null,
        },
      });
      const taken = await takenSeats(tx, where.formId, this.tenantId);
      const restoringSeats = await registeredSeats(tx, {
        responseId: where.id,
        tenantId: this.tenantId,
      });

      const refusal = decide({
        liveResponses,
        takenSeats: taken,
        restoringSeats,
      });
      if (refusal !== null) {
        // Nothing is written and the answer stays in the trash — the
        // load-bearing half of what proves this requirement holds.
        return { kind: 'refused', refusal };
      }

      const written = await tx.response.updateMany({
        where: {
          id: where.id,
          formId: where.formId,
          tenantId: this.tenantId,
          deletedAt: { not: null },
        },
        data: { deletedAt: null },
      });
      return written.count === 1 ? { kind: 'restored' } : { kind: 'not-found' };
    });
  }

  // -------------------------------------------------------------------------
  // Physical deletion — the requirement
  // -------------------------------------------------------------------------

  /**
   * Every form of this organisation that is in the trash, ids only — what
   * „Papierkorb leeren" walks.
   *
   * The same `where` fragment {@link findManyDeleted} takes and for the same
   * reason: a form somebody's `form_permission` row revokes them from must not
   * be destroyable by them either, and „im Papierkorb" is not an exception to a
   * revocation. Oldest deletion first, so a run that gives up part-way — or
   * one that fills its batch — has removed the rows whose 30 days are closest
   * to being up.
   *
   * `take` is not optional decoration: „Papierkorb leeren" is one HTTP request
   * that opens one transaction per item, so the listing it walks has to be
   * bounded (a review finding, `TRASH_PURGE_BATCH_SIZE`).
   */
  async deletedFormIds(
    where: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
    take?: number,
  ): Promise<string[]> {
    const rows = await this.prisma.form.findMany({
      where: { ...where, tenantId: this.tenantId, deletedAt: { not: null } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
      ...(take === undefined ? {} : { take }),
    });
    return rows.map((row) => row.id);
  }

  /**
   * Every answer of this organisation that is in the trash **in its own right**,
   * with the form it belongs to.
   *
   * Answers of a form that is itself deleted are left out, exactly as
   * {@link deletedResponses} leaves them out of the view: they are not a second
   * item to destroy, they go with their form. Counting them here would make
   * „Papierkorb leeren" report more than the page ever showed.
   */
  async deletedResponseKeys(
    formWhere: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
    take?: number,
  ): Promise<{ id: string; formId: string }[]> {
    return this.prisma.response.findMany({
      where: {
        tenantId: this.tenantId,
        deletedAt: { not: null },
        form: { ...formWhere, deletedAt: null },
      },
      select: { id: true, formId: true },
      orderBy: { deletedAt: 'asc' },
      ...(take === undefined ? {} : { take }),
    });
  }

  /**
   * **How many items are still in the trash** under the caller's own
   * conditions — forms plus separately deleted answers (a review finding).
   *
   * The number `TrashPurgeResult.remaining` reports, and it is *counted after
   * the run* rather than derived from it: the two listings above are bounded by
   * a batch, and „wie viel steht noch da" must not be arithmetic over what this
   * one call happened to see. It counts the same two populations the listings
   * select, with the same fragment, so „0" means the same thing as „the two
   * listings would return nothing".
   */
  async countDeletedItems(
    formWhere: Omit<Prisma.FormWhereInput, 'tenantId'> = {},
  ): Promise<number> {
    const [forms, responses] = await Promise.all([
      this.prisma.form.count({
        where: {
          ...formWhere,
          tenantId: this.tenantId,
          deletedAt: { not: null },
        },
      }),
      this.prisma.response.count({
        where: {
          tenantId: this.tenantId,
          deletedAt: { not: null },
          form: { ...formWhere, deletedAt: null },
        },
      }),
    ]);
    return forms + responses;
  }

  /**
   * **Physically deletes an answer** — and empties the four personal columns of
   * its mail log rows first.
   *
   * ## The order inside the transaction is the whole point
   *
   * `mail_log.response_id` is `ON DELETE SET NULL`: the moment the answer row
   * goes, nothing connects those log lines to it any more. Blanking them
   * afterwards would therefore be blanking nothing — the `where` would match no
   * rows — and the participant's address, subject and frozen mail body would
   * stay in the table for the rest of the 90 days. The erasure is the
   * first statement of this transaction for that reason, not for tidiness.
   *
   * ## What the database takes along, and what it does not
   *
   * `event_registration` cascades from `response` (its seats are free again the
   * moment the row goes, which the trash already promises). `mail_log`
   * keeps its rows with `response_id` nulled — the
   * operational record survives the person, by design.
   *
   * **`file` does not appear here, and that is not an omission.** The
   * attachments have to lose their *bytes* before their rows, and bytes are not
   * transactional (ADR-0014 no. 16); they are removed by the caller, one file
   * per transaction, **before** this one opens. `file.response_id` is
   * `ON DELETE SET NULL` rather than `Cascade` precisely so that a caller who
   * forgets leaves rows the purge of no. 15 can still find, instead of bytes
   * nothing can.
   *
   * @returns whether an answer was actually removed. `false` means „already
   * gone, not this organisation's, not this form's, or not in the trash" — the
   * caller has resolved which.
   */
  async purgeResponse(where: { id: string; formId: string }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // **The form's lock, the same one a restore takes** (`lockForm`). Without
      // it, `POST …/restore` could land between the check below and the
      // `DELETE`: the restore would win, the `DELETE` would match nothing — and
      // the erasure in between would already have blanked the log lines of an
      // answer that is alive again. One lock object for every write path of a
      // form, as `restoreResponse` states.
      await lockForm(tx, where.formId, this.tenantId);

      // **Asked before anything is written**, and that ordering is the guard
      // rather than a style: the erasure below is destructive on its own, so a
      // method that blanked first and discovered afterwards that the answer was
      // never in the trash would have destroyed a live submission's
      // mail log for nothing.
      const target = await tx.response.findFirst({
        where: {
          id: where.id,
          formId: where.formId,
          tenantId: this.tenantId,
          deletedAt: { not: null },
        },
        select: { id: true },
      });
      if (target === null) {
        // „Gibt es nicht", „anderer Organisation", „anderes Formular" and „liegt nicht
        // im Papierkorb" — the caller has already resolved which.
        return false;
      }

      await eraseMailLogLines(tx, {
        responseId: where.id,
        tenantId: this.tenantId,
      });

      const removed = await tx.response.deleteMany({
        where: {
          id: where.id,
          formId: where.formId,
          tenantId: this.tenantId,
          // **Only out of the trash**, restated in the statement that
          // actually removes the row. A route that could destroy a live answer
          // would make `deleted_at` a suggestion rather than a step.
          deletedAt: { not: null },
        },
      });
      return removed.count === 1;
    }, BULK_TRANSACTION_BOUNDS);
  }

  /**
   * **Physically deletes a form, with everything that hangs off it** .
   *
   * ## The children, gone through in the schema rather than guessed
   *
   * | Table | How it goes |
   * |---|---|
   * | `form_version` | `ON DELETE CASCADE` |
   * | `response` | `ON DELETE CASCADE` — but deleted **explicitly** below |
   * | `event_registration` | `ON DELETE CASCADE`, from both `form` and `response` |
   * | `notification` | `ON DELETE CASCADE` |
   * | `form_permission` | `ON DELETE CASCADE` |
   * | `mail_log` | `ON DELETE SET NULL` — the row survives, blanked first |
   * | `file` | `ON DELETE NO ACTION` — **the caller removes them beforehand** |
   *
   * ## Why the answers are deleted explicitly although they cascade
   *
   * `response.form_version_id` is `ON DELETE RESTRICT` (migration
   * `20260727103336_forms_versions_responses`) while `form_version.form_id` is
   * `ON DELETE CASCADE`. Deleting the form alone therefore asks PostgreSQL to
   * remove both tables in one statement with an **immediately-checked**
   * constraint pointing from one to the other, and which of the two cascades
   * runs first is a property of the server rather than of anything this schema
   * states.
   *
   * **Measured on 2026-08-03, and the honest result is that it works without
   * this statement:** removing the `DELETE` below left all thirteen cases of
   * `test/trash/permanent-delete.spec.ts` green on PostgreSQL 16.13. So this is
   * not a bug fix and is not claimed as one — it is one indexed statement over
   * rows that were going anyway, bought so that „ein gelöschtes Formular nimmt
   * seine Antworten mit" does not rest on undocumented ordering the day the
   * installation moves to another major version.
   *
   * ## `file` is `NO ACTION` on purpose, and this method relies on it
   *
   * If any attachment row still points at this form the `DELETE` **fails**, and
   * that failure is the database floor under ADR-0014 no. 16: it is what keeps
   * a forgotten enumeration from becoming bytes with no index. The caller
   * removes bytes and rows first, file by file; this method does not paper over
   * a leftover row by deleting it here, because deleting it here is exactly the
   * „Zeile weg, Bytes bleiben" the constraint exists to prevent.
   *
   * @returns whether a form was removed.
   */
  async purgeForm(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // The same lock and for the same reason as {@link purgeResponse}: a
      // restore landing between the check and the `DELETE` would leave a live
      // form with its answers deleted and its mail log blanked.
      await lockForm(tx, id, this.tenantId);

      // **Asked first, written afterwards.** Both statements below are
      // destructive with no regard for `deleted_at` — they have to be, because
      // a form's answers are not individually in the trash — so „ist
      // dieses Formular überhaupt gelöscht?" cannot be left to the last
      // statement of the transaction.
      const target = await tx.form.findFirst({
        where: { id, tenantId: this.tenantId, deletedAt: { not: null } },
        select: { id: true },
      });
      if (target === null) {
        return false;
      }

      // **Every line of this form**, not only the ones with a `response_id`.
      // A form's log lines are its confirmations and its test mails; once the
      // form is gone none of them can be related to anything but the delivery
      // record, and leaving a participant's address behind because its line
      // happened to carry no answer reference would be the same promise broken
      // in a narrower case.
      await eraseMailLogLines(tx, { formId: id, tenantId: this.tenantId });

      // **The log lines let go of the form here instead of waiting for the
      // cascade** — a bug fix, measured 2026-09-13.
      //
      // All three references are `ON DELETE SET NULL`, so the end state is the
      // same either way. But an `UPDATE` on a row this transaction has already
      // written (the erasure above) makes PostgreSQL recheck *every* foreign
      // key of that row, and the queued check for
      // `mail_log_notification_id_fkey` then runs after the notifications are
      // cascade-deleted — „endgültig löschen" answered 500. Letting go here
      // leaves the deletes below nothing to cascade into `mail_log`, and no
      // constraint order to depend on (the long version, including why no
      // schema can state that order: `docs/kb/02-data-model.md`).
      //
      // `form_id` alone is filter enough: it is never NULL while
      // `notification_id` or `response_id` are set. And it has to come after
      // the erasure, which finds its lines by the `form_id` this empties.
      await tx.mailLog.updateMany({
        where: { formId: id, tenantId: this.tenantId },
        data: { formId: null, notificationId: null, responseId: null },
      });

      await tx.response.deleteMany({
        where: { formId: id, tenantId: this.tenantId },
      });

      const removed = await tx.form.deleteMany({
        where: { id, tenantId: this.tenantId, deletedAt: { not: null } },
      });
      return removed.count === 1;
    }, BULK_TRANSACTION_BOUNDS);
  }
}

/**
 * **What a transaction carrying a *Mengen*-Anweisung is allowed to take**
 * (a review finding, widened by a later one).
 *
 * Prisma's defaults are `maxWait` 2 s and `timeout` 5 s, and both of them are
 * wrong here for reasons the neighbours already noticed:
 * `ScopedFileDelegate.purgeAttachment` and `purgeFile` name these very numbers
 * because their transaction waits on a filesystem. The transactions that read
 * this constant wait on something just as unbounded — a form with thousands of
 * answers deletes them, their registrations and their log lines in one
 * statement each, and `ScopedFormDelegate.softDeleteResponses` updates up to
 * `RESPONSE_BULK_DELETE_MAX` rows in one. On the default the run ends in
 * `P2028`: „Papierkorb leeren" answers 500 with no counts while everything
 * already committed stays deleted, and the action bar answers 500 after
 * promising „ganz oder gar nicht".
 *
 * **It was named `PURGE_TRANSACTION_BOUNDS` while the two purges were the only
 * readers.** The name is gone rather than stretched: the bulk delete is not a
 * purge, and a constant whose name says „purge" is one a later reader skips
 * when looking for the bound that applies to *their* mass statement — which is
 * exactly how the widest statement in this file came to run unbounded.
 *
 * The same order of magnitude as the neighbours, deliberately: one number for
 * „how long may this application hold a form's lock", not four.
 */
const BULK_TRANSACTION_BOUNDS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * **How long the `DELETE` of a whole organisation may run** (a
 * review finding).
 *
 * {@link ScopedTenantDelegate.purgeIfDeletedBefore} is a single
 * statement whose cascade runs through ten child tables — and until this
 * finding the **only** one of the package entirely without a limit. As long as only a
 * superadmin route triggered it, that was one long request; since the
 * 30-day purge it runs unattended over *every* due organisation, without
 * anybody watching.
 *
 * What that costs is not confined to the job: the connection pool is
 * **shared** with the request path, and its size is Prisma's machine-dependent
 * default (`num_cpus * 2 + 1`), not a ten one could build on. An organisation
 * with a hundred thousand answers would therefore hold a connection and the locks on
 * ten tables for as long as PostgreSQL needs — at the expense of people who have
 * never touched the trash.
 *
 * `SET LOCAL statement_timeout` rather than an upper bound of due organisations per run:
 * the upper bound limits *how many* organisations, not *how long one of them takes*, and the
 * expensive case is precisely the single large one. If the limit is exceeded,
 * PostgreSQL aborts the statement (`57014`), the transaction rolls back —
 * **nothing** is half deleted —, the purge counts the organisation as `failed` and
 * the next run tries again. An organisation that is fundamentally too large
 * therefore fails visibly and repeatedly instead of blocking invisibly.
 *
 * Two minutes: generous towards any realistic organisation and still
 * a limit. It is **deliberately** not an environment variable — it
 * does not describe the environment but what this application allows
 * itself, like {@link BULK_TRANSACTION_BOUNDS} next door.
 */
const TENANT_PURGE_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * What a caller may say about *which* notifications it wants — `tenantId`
 * omitted for the reason spelled out at {@link ScopedGroupQuery}.
 */
export interface ScopedNotificationQuery {
  readonly where?: Omit<Prisma.NotificationWhereInput, 'tenantId' | 'formId'>;
  readonly orderBy?:
    | Prisma.NotificationOrderByWithRelationInput
    | Prisma.NotificationOrderByWithRelationInput[];
}

/** What a create or an update may set on a notification row. */
export interface NotificationWrite {
  readonly name: string;
  /**
   * The database enum, not the narrower one the API accepts. The service
   * refuses `save` on the way in (`notificationTriggersInputSchema` in
   * `@formsache/shared`); the delegate stays able to express what the column can
   * hold, so the fixture the non-goal is proven with — a `save` row
   * written straight into the database — does not need a second way in.
   *
   * A **set** since the acceptance run: a notification fires on „Bei
   * Absendung", on „Bei Bearbeitung", or on both.
   */
  readonly triggers: NotificationTrigger[];
  readonly format: MailFormat;
  readonly toSubmitter: boolean;
  readonly recipients: Prisma.InputJsonValue;
  readonly subject: string;
  readonly body: string;
  /**
   * The reply address of this notification, or `null` for „what the
   * organisation or the system prescribes applies" .
   *
   * Required and nullable, not optional: the route replaces the whole
   * document (`PUT`), and an omissible field would be one that a second
   * write path would quietly leave standing — exactly the half-measure that
   * `mailIdentityColumns` one level further down rules out.
   */
  readonly replyTo: string | null;
  readonly active: boolean;
}

/**
 * The notifications of one organisation's forms.
 *
 * The database carries a second floor here, unlike for {@link
 * ScopedMailLogDelegate} below: `notification` has the composite foreign key
 * `(form_id, tenant_id)` that `FormVersion` and `Response` also stand on, so a
 * row physically cannot point at a form of another organisation. This delegate is
 * therefore the *first* boundary rather than the only one — which is exactly
 * the sentence that does **not** hold one class further down.
 */
export class ScopedNotificationDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * The notifications of one form of this tenant, oldest first.
   *
   * `formId` is a parameter and the tenant is not — the caller decides which
   * form it is looking at, never which Organisation. Both are merged in **last**, so
   * neither a `where` nor a future refactor can talk either of them away.
   */
  findManyOfForm(
    formId: string,
    query: ScopedNotificationQuery = {},
  ): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      orderBy: query.orderBy ?? { createdAt: 'asc' },
      where: { ...query.where, formId, tenantId: this.tenantId },
    });
  }

  /**
   * One notification of this tenant, or `null` — and `null` for one belonging
   * to another organisation just as much as for one that does not exist.
   *
   * `findFirst` rather than the `findUnique` spelling the other delegates use:
   * `notification` has no `@@unique([id, tenantId])`, because nothing needs a
   * composite foreign key *onto* it. The tenant is still part of the statement
   * PostgreSQL runs, which is what the rule asks for.
   */
  findById(id: string): Promise<Notification | null> {
    return this.prisma.notification.findFirst({
      where: { id, tenantId: this.tenantId },
    });
  }

  /**
   * Adds a notification to one form of this tenant.
   *
   * The `formId` is trusted to have been resolved through
   * {@link ScopedFormDelegate.findById} first — and if it was not, the
   * composite foreign key refuses the insert rather than storing a row under
   * the wrong Organisation.
   */
  create(formId: string, data: NotificationWrite): Promise<Notification> {
    return this.prisma.notification.create({
      data: { ...data, formId, tenantId: this.tenantId },
    });
  }

  /**
   * Replaces a notification of this tenant. Returns whether a row matched —
   * `false` means "not this organisation's, or gone", and the caller answers 404 to
   * both, because the two are the same answer to an outsider.
   *
   * `updateMany` rather than `update`: a non-unique `where` is what lets the
   * tenant be part of the condition instead of being checked beforehand, and
   * it reports a miss instead of raising.
   */
  async update(id: string, data: NotificationWrite): Promise<boolean> {
    const result = await this.prisma.notification.updateMany({
      where: { id, tenantId: this.tenantId },
      data,
    });
    return result.count === 1;
  }

  /**
   * Deletes a notification of this tenant. Physical, not a flag: a
   * notification is configuration, not personal data, and the trash
   * is about forms and answers.
   *
   * The `mail_log` rows it produced survive — `notification_id` is `SetNull`
   * . What went out stays visible after the template that
   * produced it is gone.
   */
  async remove(id: string): Promise<boolean> {
    const result = await this.prisma.notification.deleteMany({
      where: { id, tenantId: this.tenantId },
    });
    return result.count === 1;
  }
}

/**
 * What the mail log may be narrowed by.
 *
 * The status filter is for the KPI tiles, `formId` the prefilter one
 * arrives with from a form. Both absent means "everything of this organisation" —
 * tenant-wide is the decided shape.
 */
export interface MailLogScopeFilter {
  readonly status?: MailStatus | undefined;
  readonly formId?: string | undefined;
  /**
   * The forms whose lines this read must not return — the fourth link of the
   * guard chain, applied to `mail_log` (review finding).
   *
   * **Form ids, not a user id.** The earlier shape took the person and spelled
   * the condition out here as a relation filter on `access_revoked` — which
   * read well and closed only *half* of the link: a cap („auf diesem Formular
   * nur `nur-lesen`") is not a column this `where` can compare, because whether
   * it bites depends on the permissions the caller holds *and* on what the
   * route demands. Expressing that here a second time is exactly the second
   * calculation the review found; the one evaluation lives in
   * `FormRestriction.verdictFor`, and what arrives here is its outcome.
   *
   * The rows it is computed from are the caller's own `form_permission` rows —
   * a handful — so „in der Query, nicht danach" still holds where it matters:
   * no `mail_log` row a caller may not see leaves the database.
   *
   * Empty means „nothing to narrow", which is also what an administrator
   * produces (`FormRestriction.restrictedUserId()`).
   */
  readonly hiddenForms?: readonly string[] | undefined;
}

/**
 * What the mail log reads — every column of `mailLogEntrySchema` and
 * the notification's name, **and not the body**.
 *
 * Spelled as a `select` rather than an `include` since the body was frozen into
 * the table (2026-07-28): the view does not show it (the requirement grants
 * `can_view_responses` for the *subject* alone), and a query that never asks
 * for it cannot leak it into a payload by a later `...row` spread. It is also
 * the difference between a page of 200 rows and a page of 200 rendered mails.
 */
const MAIL_LOG_VIEW_SELECT = {
  id: true,
  createdAt: true,
  sentAt: true,
  recipient: true,
  subject: true,
  formId: true,
  status: true,
  attempts: true,
  lastError: true,
  nextAttemptAt: true,
  // **Under whose identity the line last went out** (the requirement). Two
  // scalars, on the *list* and not only on the detail: „über welchen Mailserver
  // ging das raus" is asked about a batch after an organisation switches System→eigen,
  // and one row at a time is the wrong instrument for it. Neither column
  // carries anything personal or secret — see `MailLog.senderIdentity` in
  // `schema.prisma` — which is why they may be read this widely at all.
  senderIdentity: true,
  senderAddress: true,
  // **The reply address that was frozen at enqueue time** (the requirement) — `mail_log.reply_to`, not today's chain. It is in
  // this `select` because it is in `mailLogEntrySchema`: the two are
  // the two ends of the same statement, and a column that is missing here never
  // arrives, while one that is missing from the schema breaks the parse. A
  // configuration line, nothing personal — see `MailLog.replyTo` in
  // `schema.prisma`.
  replyTo: true,
  // **What triggered the line** — on the list, since the table row needs the
  // answer: „↻ Erneut" is refused for a system line
  // (`MailLogService.retry`, ADR-0021), and without this column the row could
  // not hold the button back, only the 409 afterwards could. An
  // enum value, nothing personal.
  trigger: true,
  notification: { select: { name: true } },
} satisfies Prisma.MailLogSelect;

/** A log line together with the name of the notification that produced it. */
export type MailLogWithNotification = Prisma.MailLogGetPayload<{
  select: typeof MAIL_LOG_VIEW_SELECT;
}>;

/**
 * What {@link ScopedMailLogDelegate.findById} reads — the list's columns plus
 * what only the detail route needs („Die gerenderte Mail
 * ansehen"): `responseId` (to resolve `{{bearbeiten}}` — see
 * `MailLogService.detail`) and the two frozen body columns. `trigger` used to
 * be the third of them and now comes with {@link MAIL_LOG_VIEW_SELECT}.
 *
 * One `select`, built on {@link MAIL_LOG_VIEW_SELECT} rather than a second,
 * independent list of columns, for the reason that constant is already
 * spelled as a `select`: a query that names every column it reads is a
 * decision visible in a diff, and `...MAIL_LOG_VIEW_SELECT` is what keeps this
 * one from silently drifting out of step with the list's.
 *
 * `findById` also backs „↻ Erneut", which only ever reads `status` off the
 * result — the wider `select` costs it one join it does not use, for a single
 * row, which is the trade `findMany` (200 rows) makes the other way.
 */
const MAIL_LOG_DETAIL_SELECT = {
  ...MAIL_LOG_VIEW_SELECT,
  responseId: true,
  bodyText: true,
  bodyHtml: true,
} satisfies Prisma.MailLogSelect;

/** A log line with everything the detail route needs to render it. */
export type MailLogWithBody = Prisma.MailLogGetPayload<{
  select: typeof MAIL_LOG_DETAIL_SELECT;
}>;

/** The four KPI counters, counted over the whole tenant. */
export interface MailLogStatusCounts {
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly queued: number;
}

/**
 * The mail log of one organisation.
 *
 * ---------------------------------------------------------------------------
 * **Read this before adding a method, and before reading `mail_log` anywhere
 * else: this class is the *only* tenant boundary the table has.**
 *
 * Every other domain table has two. `form_version` and `response` carry the
 * composite foreign key `(form_id, tenant_id)`, so a row physically cannot
 * point at a form of another organisation — a forgotten binding in application code
 * would have been caught by PostgreSQL. `mail_log` has **no** such key, and
 * that is a Prisma constraint rather than an oversight: an optional relation
 * requires *all* of its scalar fields to be optional, and `tenant_id` is
 * required here, because a log line always belongs to an organisation even after its
 * form is deleted (`apps/api/prisma/schema.prisma`).
 *
 * The consequence is concrete. Here, a query that forgets the tenant returns
 * another organisation's recipient addresses and subjects, and **nothing underneath
 * catches it**. The tenant boundary test therefore proves the only
 * boundary there is, not the second of two — which is why the reads of the
 * mail log go through this class strictly, and why the worker,
 * which legitimately works *across* tenants over `$queryRaw` with
 * `FOR UPDATE SKIP LOCKED`, has its own repository and its own ESLint
 * allow-list entry (`eslint.config.js`). Two callers, two ways in, on purpose:
 * a `MailLogService` that reached for the worker's repository because it was
 * within arm's length would be the regression every test survives.
 * ---------------------------------------------------------------------------
 */
export class ScopedMailLogDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * The log lines of this tenant, newest first.
   *
   * `take` is a parameter and not optional-with-no-limit: the log of an organisation
   * grows by one row per recipient per submission and is only purged after 90
   * days, so "all of them" is a page that gets slower every Jahrestagung.
   */
  findMany(
    filter: MailLogScopeFilter = {},
    take = 200,
  ): Promise<MailLogWithNotification[]> {
    return this.prisma.mailLog.findMany({
      where: this.where(filter),
      select: MAIL_LOG_VIEW_SELECT,
      // `id` breaks the tie, and it is not decoration: one submission writes a
      // row **per recipient** in one statement, so they share `created_at` to
      // the millisecond. Ordering on the timestamp alone leaves their order
      // undefined — Postgres may return them either way, and it does: the same
      // page reloaded twice can swap two lines, and a test that reads „the
      // first row" is flaky for a reason nobody looks for in the sort. `id` is
      // a UUIDv7 and therefore time-ordered itself, so the tie-break agrees
      // with the timestamp instead of fighting it.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /**
   * The `where` of every read here — built rather than spread, because
   * `exactOptionalPropertyTypes` makes `{ ...filter }` mean „status may be
   * literally undefined", which Prisma reads as a different query than „no
   * status filter".
   *
   * `tenantId` is assigned **last and unconditionally**, so it survives whatever
   * the filter said — the same discipline the other delegates get from spreading
   * it last.
   *
   * ## The per-form restriction is **here**, in the condition
   *
   * A guard says yes or no to one request; it cannot narrow a result set. The
   * mail log is a list, so „Zeilen zu Formularen, die ich hier nicht
   * sehen darf" has to be part of the statement PostgreSQL runs — exactly as
   * `FormRestriction.formFilter()` is for the form list (the requirement's first
   * reproduction). Filtering the rows after the load would leave every locked
   * line in the payload: recipient, subject, and a subject may carry
   * `{{antworten}}`.
   *
   * Which forms those are is **not decided here**, it arrives decided — see
   * {@link MailLogScopeFilter.hiddenForms} for why a `where` cannot answer
   * „gedeckelt" on its own and what the one evaluation is.
   *
   * **A line without a form stays** (`OR: [{ formId: null }, …]`), and that is
   * a decision rather than a Prisma detail: `mail_log.form_id` is `SetNull`, so
   * a line survives the deletion of the form it came from. Such a row belongs
   * to no form at all, so no `form_permission` row can point at it — there is
   * nothing to be locked out **of**. Dropping it would mean a restriction on
   * form X quietly hiding lines of form Y, which is not what „gesperrt auf X"
   * says. `notIn` alone would do exactly that: in SQL `form_id NOT IN (…)` is
   * `NULL`, never `true`, for a row whose `form_id` is null — so the `OR` is
   * what keeps every unattached line visible instead of making it disappear
   * silently, and only for restrictable people.
   */
  private where(filter: MailLogScopeFilter): Prisma.MailLogWhereInput {
    const where: Prisma.MailLogWhereInput = {};
    if (filter.status !== undefined) {
      where.status = filter.status;
    }
    if (filter.formId !== undefined) {
      where.formId = filter.formId;
    }
    if (filter.hiddenForms !== undefined && filter.hiddenForms.length > 0) {
      // Under `AND`, so it can only ever narrow — whatever the filter above
      // said, and whatever a later field here might say.
      where.AND = [
        {
          OR: [
            { formId: null },
            { formId: { notIn: [...filter.hiddenForms] } },
          ],
        },
      ];
    }
    where.tenantId = this.tenantId;
    return where;
  }

  /**
   * The KPI counters — counted in the database over the **whole** tenant, not
   * over the page {@link findMany} happened to return.
   *
   * `formId` is honoured so the tiles agree with the prefiltered table; the
   * status filter deliberately is not, because the tiles *are* the status
   * filter and clicking one must not make the other three disappear.
   */
  async counts(
    filter: Pick<MailLogScopeFilter, 'formId' | 'hiddenForms'> = {},
  ): Promise<MailLogStatusCounts> {
    const grouped = await this.prisma.mailLog.groupBy({
      by: ['status'],
      where: this.where(filter),
      _count: { _all: true },
    });
    const of = (status: MailStatus): number =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;
    const sent = of('sent');
    const failed = of('failed');
    const queued = of('queued');
    return { total: sent + failed + queued, sent, failed, queued };
  }

  /**
   * One log line of this tenant, or `null` — the same `null` for a
   * stranger's, which is what makes this method the tenant
   * boundary for both of its callers: „↻ Erneut" and the detail route.
   *
   * `select`, not the implicit „every scalar column": read this way, the fact
   * that the result carries the rendered body is a decision made **here**,
   * where the tenant binding also lives, rather than an accident of Prisma's
   * default. See {@link MAIL_LOG_DETAIL_SELECT}.
   */
  findById(id: string): Promise<MailLogWithBody | null> {
    return this.prisma.mailLog.findFirst({
      where: { id, tenantId: this.tenantId },
      select: MAIL_LOG_DETAIL_SELECT,
    });
  }

  /**
   * „↻ Erneut" : hands one line back to the worker.
   *
   * `attempts` goes back to 0 and `next_attempt_at` to `now`, both deliberately
   *  — on a row that has used up its attempts, a retry
   * that only recoloured the status would be a click without effect, and the
   * requirement says in as many words „tatsächlich erneut versucht, nicht nur
   * umgefärbt". `last_error` stays until the next result replaces it, so the
   * editor can still read why it failed while it is queued again.
   *
   * No new log row: one row per recipient is the shape,
   * and a retry is another attempt at the same delivery, not a second one.
   *
   * **The recorded sending identity goes with `sent_at`** (the requirement).
   * It describes the attempt that has just been discarded, and leaving it
   * standing is precisely the falsehood this is built to prevent: a
   * Organisation that presses „↻ Erneut" *because* it has switched System→eigen would
   * read „System" on a line that is now waiting for its own block. Null means
   * „noch kein Versuch", which is exactly what this row is again; the next send
   * resolves and writes afresh.
   */
  async requeue(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.mailLog.updateMany({
      where: { id, tenantId: this.tenantId },
      data: {
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        sentAt: null,
        /*
          **`failed_at` goes with it** — for the same reason as `sent_at` above
          (review follow-up): the column describes an outcome that
          this row has just left again. If it stayed, the
          operational alarm would count a waiting line as failed; and if it fails
          again, `markFailed` overwrites it with the *new* moment —
          which is the point of the whole column.
        */
        failedAt: null,
        senderIdentity: null,
        senderAddress: null,
      },
    });
    return result.count === 1;
  }
}

/**
 * What the *Nutzerrechte (Tenant-Ebene)* tab reads about one member — the
 * person, the role, and **nothing that belongs to the account rather than to
 * this organisation**.
 *
 * A `select` and not the implicit „every scalar", for the reason
 * {@link MAIL_LOG_DETAIL_SELECT} gives: what leaves the database is then a
 * decision made here, next to the tenant binding, instead of an accident of
 * Prisma's default. Concretely, `password_hash` is not on this list and a later
 * `...member.user` spread therefore cannot carry it into a payload.
 *
 * `oidcSubject` is on it because the „OIDC"/„Lokal" badge has to come
 * from somewhere, and it is the harmless half of the pair: the *subject* names
 * an account at a provider, the hash is the credential. Deriving the badge from
 * `passwordHash !== null` would mean reading the hash to render a label.
 *
 * `oidcIssuer` joined it for the third shape (review finding): an
 * **unclaimed invitation** carries an issuer and no subject yet (ADR-0012),
 * so a badge derived from the subject alone called it „Lokal" — a label that
 * says „dieses Konto hat ein Passwort" about a row that has none and cannot
 * sign in at all. Like the subject, the issuer is read and never handed out;
 * what leaves the server is the derived kind (`tenant-admin/users.service.ts`).
 */
const MEMBER_VIEW_SELECT = {
  userId: true,
  groupId: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      email: true,
      name: true,
      oidcSubject: true,
      oidcIssuer: true,
    },
  },
  group: true,
} satisfies Prisma.MembershipSelect;

/** One member of an organisation: the membership, the person and the role. */
export type MembershipWithPerson = Prisma.MembershipGetPayload<{
  select: typeof MEMBER_VIEW_SELECT;
}>;

/**
 * What `ScopedMembershipDelegate.accountFacts` answers — the facts that
 * stand over the **account** of a member before an organisation
 * rewrites it (finding 12, ADR-0020).
 *
 * Three of them never leave the server as a value, only as a refusal:
 * `isSuperadmin` and `belongsElsewhere` are information about the installation,
 * and `email`/`name` are in the member list anyway. The reason
 * why they stand together here is one single query instead of three.
 */
export interface MemberAccountFacts {
  /** The stored address — to check „does anything change at all?". */
  readonly email: string;
  readonly name: string;
  /** Does this account carry the system administration? */
  readonly isSuperadmin: boolean;
  readonly kind: AccountKind;
  /**
   * Does this account already have a password? (ADR-0024)
   *
   * Since local accounts are invited, `kind: 'local'` **no** longer means
   * „has one": between the creation and the redemption of the invitation link
   * an account is local and without a password. It is exactly in this window that an
   * invitation still means something — afterwards it is nothing but a second authorisation.
   */
  readonly hasPassword: boolean;
  /** Does this account work in another organisation **as well**? */
  readonly belongsElsewhere: boolean;
}

/**
 * The notice that accompanies an administratively set password
 * (ADR-0020).
 *
 * **The text comes from the service, the row from the delegate** — the same split as
 * everywhere in this file: here lies the organisation binding, there the
 * German language. The recipient is deliberately *not* in it: it is read by
 * {@link ScopedMembershipDelegate.setPassword} in the same transaction, out of the
 * row it has just written, so that it cannot be the one from before.
 */
export interface PasswordNotice {
  readonly subject: string;
  readonly bodyText: string;
  /** The effective `Reply-To` value, or `null` for „no header line". */
  readonly replyTo: string | null;
  /** The moment of enqueueing — from the clock of the queue. */
  readonly stampedAt: Date;
}

/** How many people hold each group of this organisation. */
export interface GroupMemberCount {
  readonly groupId: string;
  readonly members: number;
}

/**
 * What a membership write can come back with.
 *
 * Three answers rather than a boolean, because the caller owes three different
 * ones: `unknown` is 404 and must be **byte-identical** to
 * the answer for a member of another organisation — a lesson learned before, where dropping the
 * tenant from a lookup left the suite green and only the status code differed.
 * `would-empty-group` is the readable refusal, and it is not a
 * 404: the row exists, the caller may see it, and „das ist der letzte Admin" is
 * the whole point of saying so.
 */
export type MembershipWriteResult = 'ok' | 'unknown' | 'would-empty-group';

/**
 * What „Einladung erneut senden" answers (ADR-0024).
 *
 * Three answers and no boolean, for the same reason as with
 * {@link MembershipWriteResult}: `unknown` is the 404 that must be
 * **byte-identical** for „does not exist" and „belongs to another organisation",
 * and `already-set-up` is the readable refusal — the row exists, the
 * caller may see it, and „this account has long been set up" is
 * exactly the information it needs.
 */
export type InvitationResendResult = 'ok' | 'unknown' | 'already-set-up';

/**
 * An organisation without its `admin` system group — a broken installation, not a
 * situation a caller caused, and therefore not one of the three results above.
 *
 * It is refused rather than reported, because the guard this state disables is
 * the last-administrator one: „ich konnte nicht nachsehen" must never read as
 * „es ist in Ordnung" (a review finding — see
 * {@link ScopedMembershipDelegate.write}).
 */
export const ADMIN_GROUP_MISSING_MESSAGE =
  'Systemgruppe dieser Organisation nicht gefunden.';

/**
 * What creates a fresh local account and its membership together (see
 * {@link ScopedMembershipDelegate.createLocal}).
 *
 * **No `passwordHash` any more** (ADR-0024): the account comes into being without a
 * password, and the person sets it themselves over the link in {@link invitation}. What is
 * missing here is therefore not a forgotten field but the whole change — there was
 * no reason why the administration should know the password of another
 * person.
 */
export interface LocalMemberWrite {
  readonly email: string;
  readonly name: string;
  /**
   * The invitation, **with** token: without it the account would have neither a password
   * nor a way to one. The type makes that unspellable — there is no
   * overload of this interface without an invitation.
   */
  readonly invitation: AccountInvitation;
}

/**
 * What creates an **unclaimed OIDC invitation** and its membership together
 * (see {@link ScopedMembershipDelegate.createOidcInvitation}).
 *
 * There is deliberately **no `oidcSubject`**: the subject cannot be known when
 * somebody is invited — it is minted by the provider and first seen in an ID
 * token (ADR-0012). It is also no field a caller could supply, which is the
 * point: a subject accepted here would let an admin of one organisation claim an
 * identity at somebody else's provider.
 */
export interface OidcInvitationWrite {
  readonly email: string;
  readonly name: string;
  /**
   * The issuer of the **inviting** Organisation, stamped from its configuration and
   * never from a request (ADR-0012, last paragraph). The caller reads it off
   * `ScopedTenantDelegate.find()`; passing it in rather than reading it here
   * keeps this class free of „which tenant column means what" and lets the
   * service refuse an organisation whose SSO is off before any row is written.
   */
  readonly oidcIssuer: string;
  /**
   * The invitation — **without** a token (ADR-0024). An SSO account gets no
   * password, so there is nothing to set; what the mail achieves is that
   * the person learns at all that the account exists and by which way
   * they get into it.
   */
  readonly invitation: AccountInvitation;
}

/**
 * The people of one organisation — reached through `membership`,
 * never through `user`.
 *
 * **Removing somebody from an organisation deletes a membership, not a person.** That is
 * the whole point and the reason this delegate has no `deleteUser`: the
 * same person may serve several organisations, and an organisation admin who could delete the
 * account would reach past their own boundary into every other one. What such a
 * removal *does* have to take along is this organisation's `form_permission` rows for
 * that person — otherwise somebody re-added next semester returns with
 * restrictions nobody remembers granting; {@link remove} takes both along in
 * one transaction.
 *
 * **The last-administrator guard is not something a
 * caller opts into.** An earlier shape took a `keepAtLeastOneIn` option on
 * {@link remove} and {@link updateGroup} — forgetting it on either path left
 * an organisation's last admin removable with nothing to notice (coordinator review). Both methods now resolve this organisation's `admin` system group and guard
 * it themselves, inside the same transaction as the write; there is no
 * parameter left to omit.
 */
export class ScopedMembershipDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * A brand-new local account **and** its membership, in one transaction
   * (coordinator review). Two separate statements — mint the `user`
   * row, then insert the `membership` — would leave an orphaned account with
   * no membership at all if the second one failed (a group deleted
   * underneath this request, say): a row `user` carries no `tenant_id` on, so
   * no admin route could ever find it again.
   *
   * The `groupId` is trusted to have been resolved through
   * {@link ScopedGroupDelegate.findById} first, exactly as {@link create}
   * trusts it — the composite foreign key `(group_id, tenant_id)` refuses the
   * membership insert (and rolls the user insert back with it) if it was not.
   * `email` is trusted to have been checked against
   * {@link TenantScope.accounts}'s `findByEmail` a moment earlier; `email`
   * is still `@unique` underneath, so a race lands on PostgreSQL's
   * constraint, not on a duplicated row.
   */
  async createLocal(
    groupId: string,
    data: LocalMemberWrite,
  ): Promise<Membership> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        // Named field by field, not spread from `data` (review finding): an
        // interface is nothing at runtime, and this is the one place a
        // caller could otherwise smuggle `isSuperadmin` or an OIDC identity
        // into what is supposed to be a plain local account.
        //
        // **`passwordHash` stays at its `null` default because nothing sets
        // it** (ADR-0024) — the same wording as at
        // {@link createOidcInvitation}, now for the third column. The account
        // cannot sign in until the invitation is redeemed, and the CHECK
        // `user_local_or_oidc` (migration `20260818090000_account_invitations`)
        // thereby holds only the one line that really applies: local **or**
        // bound to a provider, never both.
        data: { email: data.email, name: data.name },
      });
      const membership = await tx.membership.create({
        data: { tenantId: this.tenantId, userId: user.id, groupId },
      });
      await enqueueInvitation(tx, this.tenantId, user.id, data.invitation);
      return membership;
    });
  }

  /**
   * An **unclaimed OIDC invitation** and its membership, in one transaction
   * (ADR-0012).
   *
   * The row this writes is the one thing that makes SSO usable at all: a
   * `user` with `oidc_issuer` set, `oidc_subject` **null** and `password_hash`
   * **null**. The first login through that issuer looks it up by exactly those
   * three properties plus the verified e-mail and stamps the subject onto it
   * (`auth/oidc`). Until the migration
   * `20260730154134_relax_user_credential_checks_for_oidc_invitation` the two
   * CHECKs refused this shape outright, so **no** SSO account could ever
   * come into existence.
   *
   * One transaction, and the same reason as {@link createLocal}, sharpened:
   * an invitation without a membership would not merely be an orphan nothing
   * tenant-bound can find — it would also hold the installation-wide unique
   * `email` hostage, so the person could not be invited again anywhere
   * (ADR-0012, a known open point).
   *
   * **The issuer is stamped, never accepted from a request** — see
   * {@link OidcInvitationWrite.oidcIssuer}. Without that, the invitation of
   * Organisation A would be redeemable at the provider of Organisation B, which is the whole
   * point ADR-0012 was written to prevent.
   */
  async createOidcInvitation(
    groupId: string,
    data: OidcInvitationWrite,
  ): Promise<Membership> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        // Field by field, like {@link createLocal}: `oidcSubject` and
        // `passwordHash` stay at their `null` default *because nothing sets
        // them here*, and `isSuperadmin` has no way in. A spread would make
        // all three a property of whatever the caller happened to pass.
        data: {
          email: data.email,
          name: data.name,
          oidcIssuer: data.oidcIssuer,
        },
      });
      const membership = await tx.membership.create({
        data: { tenantId: this.tenantId, userId: user.id, groupId },
      });
      await enqueueInvitation(tx, this.tenantId, user.id, data.invitation);
      return membership;
    });
  }

  /**
   * Everybody who works in this organisation, strongest role first and then by name —
   * the order the page shows and therefore decided here rather than
   * left to the plan PostgreSQL happened to pick.
   */
  findMany(): Promise<MembershipWithPerson[]> {
    return this.prisma.membership.findMany({
      where: { tenantId: this.tenantId },
      select: MEMBER_VIEW_SELECT,
      orderBy: [{ group: { rank: 'desc' } }, { user: { name: 'asc' } }],
    });
  }

  /**
   * One member of this organisation, or `null` — and `null` for a member of another
   * Organisation just as much as for somebody who does not exist (and it has to be the *same* null: the answers are compared
   * byte for byte).
   *
   * `findUnique` on `@@unique([tenantId, userId])`, not
   * `findFirst({ where: { userId, tenantId } })`: dropping the tenant here
   * leaves the key incomplete and fails to compile, whereas dropping a key from
   * a `where` object compiles and still returns a row.
   */
  findByUserId(userId: string): Promise<MembershipWithPerson | null> {
    return this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId: this.tenantId, userId } },
      select: MEMBER_VIEW_SELECT,
    });
  }

  /**
   * Adds a person to this organisation.
   *
   * The `groupId` is trusted to have been resolved through
   * {@link ScopedGroupDelegate.findById} first — and if it was not, the
   * composite foreign key `(group_id, tenant_id)` refuses the insert rather than
   * storing a membership in a group of another organisation.
   */
  create(userId: string, groupId: string): Promise<Membership> {
    return this.prisma.membership.create({
      data: { tenantId: this.tenantId, userId, groupId },
    });
  }

  /**
   * Changes somebody's role in this organisation. Refuses if this person is the last
   * member of the `admin` system group — see the
   * class doc on why that guard needs no option to enable.
   */
  updateGroup(userId: string, groupId: string): Promise<MembershipWriteResult> {
    return this.write(userId, async (tx) => {
      const result = await tx.membership.updateMany({
        where: { tenantId: this.tenantId, userId },
        data: { groupId },
      });
      return result.count === 1;
    });
  }

  /**
   * Removes somebody from this organisation. **The `user` row survives as long as
   * somebody else holds it** — their access to every other organisation, and their
   * session there, are untouched. The session scoped
   * to *this* Organisation stops working on its next request, because permissions are
   * resolved per request from the membership that no longer exists.
   *
   * **But what belongs to nobody any more goes with it** : if this was the
   * last membership of this person, the `user` row is deleted in the **same**
   * transaction — see {@link deleteHomelessAccount} for the one
   * version of this rule and for why the rule no longer reads „has
   * never signed in".
   *
   * **Takes this organisation's `form_permission` rows against that person along, in
   * the same statement pair.** A restriction is meaningless once its subject
   * has no role to restrict, and leaving it behind is not neutral: somebody
   * re-added next semester — to the same or a different group — would return
   * with a cap or a revocation nobody watching today granted. This is
   * documented in the delegate's own note on
   * {@link ScopedFormPermissionDelegate.findManyOfUser}, and it is folded into
   * `remove` itself rather than left to the caller: a second statement issued
   * from `TenantUsersService` after this one returns would not share this
   * method's transaction, and „in einer Transaktion" is not optional here.
   * Refuses if this person is the last member of the `admin` system group
   *  — see the class doc on why that guard needs no
   * option to enable. That refusal happens in {@link write}, **before** this
   * body runs at all, so no account deletion can slip past it: a call that
   * would empty the system group never reaches the statements below.
   */
  remove(userId: string): Promise<MembershipWriteResult> {
    return this.write(userId, async (tx) => {
      const result = await tx.membership.deleteMany({
        where: { tenantId: this.tenantId, userId },
      });
      if (result.count !== 1) {
        return false;
      }
      await tx.formPermission.deleteMany({
        where: { tenantId: this.tenantId, userId },
      });
      // **After** the membership is gone, never before: the rule counts what
      // stands in `membership` now, so asking first would count the row this
      // very transaction just removed and delete nobody, ever.
      await deleteHomelessAccount(tx, userId);
      return true;
    });
  }

  /**
   * What has to be established about a member **before** anybody touches their account
   * (finding 12, ADR-0020) — or `null` for a member who does not belong to this
   * organisation.
   *
   * ## Why this is a query of its own and not `MEMBER_VIEW_SELECT`
   *
   * Because two things are needed here that the list view deliberately does not
   * have: `is_superadmin` and **how many other organisations** this account
   * still carries. Both are information about the installation and do not belong in
   * a list an organisation looks at (see the comment on
   * {@link TenantScope.accounts} and the one on the removal confirmation in
   * `TenantMembersTab.tsx`). They are read here **individually** and only for the
   * decision they make — and the answer leaves the server
   * as a refusal, never as a number.
   *
   * ## Why the way in is nevertheless bound to the organisation
   *
   * The entry point is `membership.findUnique` over `@@unique([tenantId, userId])`
   * — the same door as {@link findByUserId}, with the same `null` for „does not
   * exist" and „belongs to another organisation". What hangs off it is an
   * `include` projection onto the person this organisation employs
   * anyway.
   *
   * ## `password_hash` is read — since ADR-0024, and only here
   *
   * It used to say here: „`deriveAccountKind` answers ‚local or SSO' from
   * the two OIDC columns, and the `user_has_credentials` CHECK turns that into
   * ‚local ⟹ has a password'." That inference **no longer holds**: since a
   * local account is invited, there is a fourth shape — local, without a
   * password, until the invitation link is redeemed. „Already has one" is thereby
   * a question of its own, and it decides whether an invitation still means
   * something ({@link TenantUsersService.resendInvitation}).
   *
   * The hash is read **for a decision**, never for a display, and
   * what this method returns is a boolean. That is the same handling
   * {@link AccountDirectory.findByEmail} already gives the same column —
   * and the difference to `MEMBER_VIEW_SELECT`, which still does not
   * know it: a list an organisation looks at does not need it, and
   * what is not selected cannot be taken along by a later spread.
   */
  async accountFacts(userId: string): Promise<MemberAccountFacts | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId: this.tenantId, userId } },
      select: {
        user: {
          select: {
            email: true,
            name: true,
            isSuperadmin: true,
            oidcSubject: true,
            oidcIssuer: true,
            // For {@link MemberAccountFacts.hasPassword} — see above for why
            // this hash is read here (and only here).
            passwordHash: true,
            // Only count, do not list: **which** other organisations
            // an account carries is none of this one's business — that there are
            // some is, because whether it may rewrite the account depends on it.
            _count: { select: { memberships: true } },
          },
        },
      },
    });
    if (membership === null) {
      return null;
    }
    const user = membership.user;
    return {
      email: user.email,
      name: user.name,
      isSuperadmin: user.isSuperadmin,
      kind: deriveAccountKind(user),
      // A boolean, never the value: what leaves this method about the hash
      // is „yes/no", and the decision about it is taken in the service.
      hasPassword: user.passwordHash !== null,
      // This membership is counted in and is subtracted: „does it still belong to
      // somebody else" is the question, not „to how many".
      belongsElsewhere: user._count.memberships > 1,
    };
  }

  /**
   * Writes the name and address **of a member of this organisation** (finding 12).
   *
   * ## The organisation is in the `WHERE`, not in front of it
   *
   * `updateMany` with `memberships: { some: { tenantId } }` — a statement that
   * does not touch a person **without** a membership here at all. A
   * `user.update({ where: { id } })` after a prior check would be the same
   * result with a window in between: somebody removed from the
   * organisation in the meantime would still be rewritten. The same shape that
   * `OidcIdentityService.resolve` uses for the redemption of an invitation.
   *
   * Whether the address **may** be changed at all — local account, no
   * second organisation, no system administration — is decided by
   * `TenantUsersService` on the basis of {@link accountFacts}. This method is the
   * write, not the rule; what it contributes is the
   * organisation boundary and the translation of the one database refusal it
   * can legitimately hit.
   */
  async updateAccount(
    userId: string,
    data: { readonly name: string; readonly email: string },
  ): Promise<'ok' | 'unknown' | 'email-taken'> {
    try {
      const result = await this.prisma.user.updateMany({
        where: {
          id: userId,
          memberships: { some: { tenantId: this.tenantId } },
        },
        // Field by field, as everywhere in this file: an interface is
        // nothing at runtime, and this is one of the places where a
        // `...data` could otherwise carry `isSuperadmin` or an OIDC identity
        // along.
        data: { name: data.name, email: data.email },
      });
      return result.count === 1 ? 'ok' : 'unknown';
    } catch (error) {
      if (isUniqueViolation(error)) {
        // `user.email @unique` — the address already belongs to somebody. Answered
        // readably instead of as a 500 with an index name.
        return 'email-taken';
      }
      throw error;
    }
  }

  /**
   * Sets the password of a member of this organisation and ends every one of their
   * sessions in the **same** transaction (finding 12).
   *
   * ## Why the two lie together here
   *
   * An administratively set password that leaves the running sessions
   * standing is without effect after a break-in — the intruder carries on working with
   * their session token, for up to 720 hours (`SESSION_TTL_HOURS`).
   * Two calls one after the other would have a window in between and, worse,
   * a second caller who can forget the second one. One transaction,
   * one promise.
   *
   * The open reset links go with it for the same reason: they are the
   * third way to this account (ADR-0020).
   *
   * ## Why the two OIDC columns are in the condition
   *
   * So that there is no statement that could **give** an SSO account a
   * password. The service checks that beforehand and answers readably; this condition
   * is the floor underneath — a provider account with an additional, quiet
   * way in is exactly what ADR-0012 rules out.
   *
   * Until ADR-0024 this said `passwordHash: { not: null }`, which achieved the same
   * **indirectly** (an unclaimed SSO invitation has none) and,
   * since local accounts are invited, excludes too much: a person whose
   * invitation never arrived could no longer be saved by anybody — the administration
   * could not reach their account, and a password would not have one either. The
   * condition now says what it means (`oidc_issuer IS NULL AND oidc_subject
   * IS NULL`), excludes the same two shapes as before and makes this
   * way the **emergency way** for an invitation that has not arrived.
   *
   * Answers **how many** sessions were ended: the same number
   * {@link SessionService.revokeAllOf} delivers, and the same confirmation.
   */
  async setPassword(
    userId: string,
    passwordHash: string,
    notice: PasswordNotice,
    now: Date = new Date(),
  ): Promise<number | 'unknown'> {
    return this.prisma.$transaction(async (tx) => {
      const written = await tx.user.updateMany({
        where: {
          id: userId,
          memberships: { some: { tenantId: this.tenantId } },
          oidcIssuer: null,
          oidcSubject: null,
        },
        data: { passwordHash },
      });
      if (written.count !== 1) {
        return 'unknown';
      }
      // The **exported** version, not a copied-out one (a
      // review finding): the same statement that the redemption, the person's own
      // change and a fresh request run, and the only one that
      // changes along if „open" ever means more than `used_at IS NULL`.
      await invalidateOpenTokens(tx, userId, now);
      const revoked = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      // **The person concerned learns of it** (a security finding): without
      // this line somebody sets a password, ends every session, and the
      // person only sees that they suddenly cannot get in any more. A
      // takeover would look exactly the same.
      //
      // In the **same** transaction as the setting: a notice about a
      // change that was rolled back would be a false report, and a
      // change without a notice is the state the finding names. The
      // address is read here and not passed in — so it cannot be the
      // one from before.
      const person = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      });
      await tx.mailLog.create({
        data: {
          tenantId: this.tenantId,
          recipient: person.email,
          subject: notice.subject,
          bodyText: notice.bodyText,
          replyTo: notice.replyTo,
          status: 'queued',
          // **System mail** (ADR-0020): it goes over the identity of the
          // installation, not over the mail server of this organisation.
          trigger: 'system',
          createdAt: notice.stampedAt,
        },
      });
      return revoked.count;
    });
  }

  /**
   * Sends a member's invitation **once more** (ADR-0024).
   *
   * ## What it is there for
   *
   * An invitation is a mail, and mails get lost, land in spam and
   * expire (`ACCOUNT_INVITATION_TTL_DAYS`). Without this way the only
   * repair would be to remove the person and create them anew — which takes their role and
   * their form restrictions along.
   *
   * ## Why the condition „not yet set up" is **here**
   *
   * Because an invitation to an account that already has a password would no longer
   * be an invitation but a second authorisation — issued by
   * somebody who does not own the account, and delivered to a mailbox that
   * they do not control. It is thereby weaker than what
   * {@link setPassword} is allowed to do anyway, but it is a **different** action with
   * a different name, and an „Einladung erneut senden" that in truth
   * sends a reset link would be exactly the sort of quiet
   * shift of meaning this code refuses everywhere else. Whoever wants to replace a
   * forgotten password takes „Passwort vergessen" or
   * {@link setPassword}.
   *
   * `Serializable` and not read-then-write in two calls: the redemption must not
   * slip through between „still has no password" and „here is a new link",
   * or a living link would stand in the end beside a
   * freshly set password. The same level and the same reasoning as in
   * {@link write}; sending an invitation is a handful of clicks a
   * semester, not a hot path.
   *
   * **The new link devalues the older ones** — the same rule as with a newly
   * requested reset: the one sent last applies. Three links in three
   * mailboxes would be three windows.
   */
  async resendInvitation(
    userId: string,
    invitation: AccountInvitation,
  ): Promise<InvitationResendResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: this.tenantId, userId } },
          select: {
            user: {
              select: {
                passwordHash: true,
                oidcSubject: true,
                oidcIssuer: true,
              },
            },
          },
        });
        if (membership === null) {
          // „Does not exist" and „belongs to another organisation" are
          // the same `unknown` — the same door as {@link findByUserId}.
          return 'unknown';
        }

        const account = membership.user;
        if (invitation.token === null) {
          // An SSO invitation: issuer set, subject not yet. An account
          // that has already signed in once is set up.
          if (account.oidcIssuer === null || account.oidcSubject !== null) {
            return 'already-set-up';
          }
          await this.restampInvitation(tx, userId);
        } else {
          if (
            account.oidcIssuer !== null ||
            account.oidcSubject !== null ||
            account.passwordHash !== null
          ) {
            return 'already-set-up';
          }
          await invalidateOpenTokens(tx, userId, invitation.stampedAt);
        }

        await enqueueInvitation(tx, this.tenantId, userId, invitation);
        return 'ok';
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Renews the issuer stamp of an open SSO invitation — **the link and the stamp
   * go out together** (Review-Runde 5 no. 3).
   *
   * ## Why the stamp has to travel with the mail
   *
   * Because otherwise „erneut senden" is a repair that repairs nothing. The
   * mail is the way out of every state in which an invitation got stuck, and
   * since the organisation's issuer can change under an open invitation
   * ({@link ScopedTenantDelegate.updateOidc}) „steckt fest" includes „trägt
   * einen Issuer, gegen den sich niemand mehr anmelden kann". A route that then
   * sent a fresh mail against the old stamp would answer 204 and change nothing
   * about the one thing that was broken.
   *
   * ## Where the value comes from, and why not from the caller
   *
   * Out of **this organisation's own row**, read here, inside the transaction
   * that sends. The rule ADR-0012 lays down is „der Stempel kommt aus der
   * Konfiguration der einladenden Organisation, nie aus einer Anfrage": an
   * issuer a caller could choose would let organisation A mint an invitation
   * redeemable at the provider of organisation B. {@link createOidcInvitation}
   * keeps that rule with a parameter its own caller reads out of the tenant row
   * a line earlier; this method keeps it one step more narrowly, by reading the
   * row itself — so here not even the service can name a value.
   *
   * Which organisation this is, is not in question — `this.tenantId` is the
   * scope, and the caller has already found a membership in it. The invitation
   * can therefore only become redeemable where it already belonged; ADR-0012
   * no. 3a's condition (a membership in the organisation signed in at) does the
   * rest.
   *
   * A `null` issuer leaves the stamp alone: the organisation has cleared SSO or
   * switched it off, and a stamp of `null` would be an invitation no login can
   * ever match. The stale one at least still fits the provider it was written
   * for, and re-configuring SSO re-stamps it.
   *
   * The conditions of the write are restated in its `where` rather than trusted
   * to the read three lines above — the same posture the redemption takes: the
   * statement that acts carries the condition, so a shape that ever loses the
   * read cannot silently re-point a redeemed account.
   */
  private async restampInvitation(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const tenant = await tx.tenant.findUnique({
      where: { id: this.tenantId },
      select: { oidcIssuer: true },
    });
    /*
      **`issuerStamp` und nicht der rohe Spaltenwert.** Die Anmeldung vergleicht
      gegen `acceptableIssuer(spalte)`; wer hier den Rohwert stempelte, erneuerte
      bei einer unnormalisierten Zeile („…/realms/hv/") genau den Stempel, den
      kein Login trifft — die Reparatur reparierte dann nichts. `null` heißt
      „damit darf nicht gestempelt werden" und lässt den alten Stempel stehen: er
      passt wenigstens noch zu dem Anbieter, für den er geschrieben wurde.
    */
    const issuer = issuerStamp(tenant?.oidcIssuer ?? null);
    if (issuer === null) {
      return;
    }
    await tx.user.updateMany({
      where: {
        id: userId,
        // The same boundary the issuer change draws, and here it stands **in the
        // transaction** rather than only in the service: `belongsElsewhere` and
        // „nicht die Systemverwaltung" are checked before the mail
        // ({@link TenantUsersService.resendInvitation}), but that check has a
        // window, and a stamp is the one thing that must not travel through it.
        // A row that slipped out of the boundary in between gets a mail that
        // still fits the provider it was written for — not a re-pointed
        // invitation.
        ...restampableAccount(this.tenantId),
        oidcIssuer: { not: null },
      },
      data: { oidcIssuer: issuer },
    });
  }

  /**
   * How many people hold each group — what „x Mitglieder" on a group card shows
   * and what makes „diese Gruppe ist in Benutzung" an answer the application
   * gives *before* the delete.
   *
   * Counted in the database and for every group at once: a card list that asked
   * per group would issue one query per card.
   */
  async memberCounts(): Promise<GroupMemberCount[]> {
    const grouped = await this.prisma.membership.groupBy({
      by: ['groupId'],
      where: { tenantId: this.tenantId },
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      groupId: row.groupId,
      members: row._count._all,
    }));
  }

  /**
   * The guarded write both {@link updateGroup} and {@link remove} share, in
   * one transaction — the last-administrator check runs here unconditionally,
   * for every call, on every path (see the class doc).
   *
   * `Serializable` rather than a `SELECT … FOR UPDATE` on the group row: the
   * thing being protected is a *count* over `membership`, not a row, so there is
   * nothing to lock that would still be there after the delete. The price is
   * that heavy contention can abort a transaction, which the caller sees as an
   * error and a person sees as „bitte noch einmal" — the direction that never
   * leaves an organisation without an administrator. Membership edits are a handful of
   * clicks a semester, not a hot path.
   */
  private async write(
    userId: string,
    apply: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ): Promise<MembershipWriteResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: this.tenantId, userId } },
          select: { groupId: true },
        });
        if (current === null) {
          return 'unknown';
        }

        // The group this organisation's last administrator must not be left without
        // — resolved fresh, every call, inside this same transaction. Not an
        // option a caller passes: see the class doc for why that shape was
        // the finding (coordinator review).
        const admin = await tx.group.findFirst({
          where: { tenantId: this.tenantId, isSystem: true },
          // Deterministic, although an organisation has exactly one system group
          // : „exactly one" is a fact about how tenants are
          // created, not a constraint PostgreSQL holds up, and without an
          // order the row a second one shadows is whichever the plan happened
          // to return first. An unordered `findFirst` that decides an
          // authorisation question is a coin toss with a stable-looking name.
          orderBy: [{ rank: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (admin === null) {
          // *Fail closed*, and it is the whole point of moving the guard in
          // here (review finding): `if (admin !== null && …)` skipped the
          // check silently whenever the group could not be found, so an organisation
          // whose system group is missing — a botched migration, a
          // hand-edited database — was one where the last administrator could
          // be removed by anybody who asked. Refusing the write is the
          // direction that never leaves an organisation unadministrable; it is the
          // answer the earlier, caller-side resolution gave too.
          throw new ConflictException(ADMIN_GROUP_MISSING_MESSAGE);
        }
        if (current.groupId === admin.id) {
          const remaining = await tx.membership.count({
            where: { tenantId: this.tenantId, groupId: admin.id },
          });
          if (remaining <= 1) {
            return 'would-empty-group';
          }
        }
        return (await apply(tx)) ? 'ok' : 'unknown';
      },
      { isolationLevel: 'Serializable' },
    );
  }
}

/** What a per-form restriction may say — and it can only take away. */
export interface FormPermissionWrite {
  /** „Zugriff gesperrt" for this one form. */
  readonly accessRevoked: boolean;
  /** The group this person is lowered **to** here, or null for no cap. */
  readonly cappedGroupId: string | null;
}

/**
 * The per-form restrictions of one organisation — the fourth link of
 * the chain *tenant scope → group permissions → form restriction*.
 *
 * **This delegate is the second boundary, not the only one.** `form_permission`
 * carries the composite foreign keys `(form_id, tenant_id)` and
 * `(capped_group_id, tenant_id)`, so a row physically cannot name a form or a
 * group of another organisation — which is what makes „die Kette beginnt beim
 * Tenant-Scope"  true even for a caller that got the order wrong.
 * Compare {@link ScopedMailLogDelegate}, where the key is missing and the class
 * is all there is.
 *
 * **Reading a *list* of forms is not this delegate's job**, and that is worth
 * saying here because it is where the obvious mistake lives. The requirement's
 * first reproduction is „die Restriktion nach dem Laden anwenden statt in der
 * Query": the row would be loaded and merely not displayed, and a test that
 * searches the whole payload of the list route catches it. The restriction
 * therefore belongs *in* the form query, and {@link ScopedFormQuery} already
 * takes it — `where: { permissions: { none: { userId, accessRevoked: true } } }`
 * is a relation filter PostgreSQL evaluates, with the tenant still merged in
 * last. No method here needs to exist for that, and adding one would be the
 * invitation to filter afterwards.
 */
export class ScopedFormPermissionDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * Every restriction on one form of this organisation — what the *Nutzerrechte je
   * Formular* page overlays onto the member list.
   *
   * `formId` is a parameter and the tenant is not: the caller decides which form
   * it is looking at, never which Organisation. Both are merged in last.
   */
  findManyOfForm(formId: string): Promise<FormPermission[]> {
    return this.prisma.formPermission.findMany({
      where: { formId, tenantId: this.tenantId },
    });
  }

  /**
   * The restriction of one person on one form, or `null` for „keine
   * Einschränkung" — the read the guard makes on every request.
   *
   * `findUnique` on `@@unique([form_id, user_id])` **plus** the tenant in the
   * same `where`. The unique key alone would already be tenant-bound in effect,
   * because `(form_id, tenant_id)` is a foreign key and a form belongs to one
   * Organisation — but „in effect" is an argument about another table's constraints, and
   * this file's promise is that the tenant is in the statement PostgreSQL runs.
   * Both are cheap, so both are said.
   */
  findFor(formId: string, userId: string): Promise<FormPermission | null> {
    return this.prisma.formPermission.findUnique({
      where: {
        formId_userId: { formId, userId },
        tenantId: this.tenantId,
      },
    });
  }

  /**
   * Stores the restriction of one person on one form, creating the row if there
   * is none.
   *
   * Not `upsert`: the update half of an upsert is addressed by the unique key,
   * and this way both halves carry the tenant — the update in its `where`, the
   * create in the row it writes, where the composite foreign key then refuses a
   * form of another organisation. One transaction, so a concurrent first write is a
   * unique-key error rather than a lost decision; the editor here is
   * one person clicking, so the retry is the cheaper answer than a lock.
   */
  async set(
    formId: string,
    userId: string,
    data: FormPermissionWrite,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.formPermission.updateMany({
        where: { formId, userId, tenantId: this.tenantId },
        data,
      });
      if (updated.count === 0) {
        await tx.formPermission.create({
          data: { ...data, formId, userId, tenantId: this.tenantId },
        });
      }
    });
  }

  /**
   * Lifts a restriction by deleting the row — „keine Einschränkung" is the
   * absence, exactly as an absent `settings_override` means „alle vier
   * Abschnitte auf Tenant-Standard".
   *
   * Returns whether a row was there. `false` means „nothing to lift", which is
   * not an error: the desired state is reached either way.
   */
  async remove(formId: string, userId: string): Promise<boolean> {
    const result = await this.prisma.formPermission.deleteMany({
      where: { formId, userId, tenantId: this.tenantId },
    });
    return result.count === 1;
  }

  /**
   * Every restriction this organisation holds against one person — what has to go when
   * that person leaves the organisation (removing a membership leaves the `user` row
   * alone, so nothing else clears these).
   *
   * Deliberately not a `deleteMany` of its own: the removal belongs in the same
   * transaction as {@link ScopedMembershipDelegate.remove}, and the caller
   * writes that transaction. This method is what its test reads afterwards.
   */
  findManyOfUser(userId: string): Promise<FormPermission[]> {
    return this.prisma.formPermission.findMany({
      where: { userId, tenantId: this.tenantId },
    });
  }
}

/**
 * One attachment as the retrieval of ADR-0014 no. 11b needs it.
 *
 * Three columns for the delivery and **two** form ids, and the second one is
 * not redundant — see {@link ScopedFileDelegate.findAttachmentByRef}.
 */
export interface ScopedAttachment {
  /** The storage key (no. 4) — never the reference, never the name. */
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  /** `file.form_id` — condition 3 of the claim (no. 13). */
  readonly formId: string | null;
  /** `response.form_id` — the form the answer this file hangs on belongs to. */
  readonly responseFormId: string;
}

/**
 * „Anlage **dieser** Antwort, und die Antwort liegt im Papierkorb" — as a
 * condition, written once (review findings from a security review).
 *
 * Two callers ask it and they have to ask the *same* thing:
 * {@link ScopedFileDelegate.attachmentIdsOfResponse}, which enumerates what to
 * remove, and {@link ScopedFileDelegate.purgeAttachment}, which asks again
 * under the row's lock immediately before the bytes go. A second spelling would
 * be a second reading of „whose file is this", and the removal is the half that
 * cannot be taken back.
 *
 * `tenantId` is deliberately not in it: it belongs to the scope and is merged
 * in by the delegate, so this fragment can only narrow (the reading
 * `ScopedFormQuery` states).
 */
function responseAttachmentWhere(
  responseId: string,
  formId: string,
): Prisma.FileWhereInput {
  return {
    kind: 'response_attachment',
    response: { is: { id: responseId, formId, deletedAt: { not: null } } },
  };
}

/**
 * The same for a whole form — both arms of
 * {@link ScopedFileDelegate.attachmentIdsOfForm}, in one place for the reason
 * {@link responseAttachmentWhere} gives.
 */
function formAttachmentWhere(formId: string): Prisma.FileWhereInput {
  return {
    kind: 'response_attachment',
    OR: [
      { form: { is: { id: formId, deletedAt: { not: null } } } },
      {
        response: {
          is: { formId, form: { is: { deletedAt: { not: null } } } },
        },
      },
    ],
  };
}

/**
 * „Datei einer Organisation, deren 30 Tage um sind" — as a **condition**, and the
 * only thing that keeps {@link ScopedFileDelegate.purgeFile} and
 * {@link ScopedFileDelegate.dueFileIds} away from a living Organisation (security
 * review findings).
 *
 * Both of them hang off the `ScopedFileDelegate` that `TenantScopeGuard` puts
 * on **every** guarded request, and both destroy bytes before rows. Until this
 * fragment existed, what stood between them and a live organisation's Logo was a
 * sentence in a doc comment — „reached only from the purge of an organisation that no
 * longer exists in any listing" — i.e. a claim about *callers*, not a predicate
 * of the statement. Its sibling {@link attachmentOwnerWhere} had been given the
 * opposite treatment one review earlier, with the reason spelled out at
 * `purgeAttachment`: a condition a caller supplies is a condition a caller can
 * get wrong.
 *
 * The same shape as {@link ScopedTenantDelegate.purgeIfDeletedBefore}'s `where`,
 * deliberately: the file walk and the `DELETE` that ends the organisation now ask one
 * question, so an organisation that is not due matches neither.
 *
 * `IS NOT NULL` beside `lte` is redundant in SQL for the reason that method
 * gives (`deleted_at <= $1` is NULL for a live Organisation, therefore never true) and
 * is kept for the same reason: it says out loud what three-valued logic says
 * quietly, in the two statements that spend an organisation's bytes.
 */
function dueTenantFileWhere(cutoff: Date): Prisma.FileWhereInput {
  return { tenant: { is: { deletedAt: { not: null, lte: cutoff } } } };
}

/**
 * Which item an attachment is being destroyed **for** — what the caller of
 * {@link PermanentDeletionService} knows and the delegate turns into the
 * condition above.
 *
 * A descriptor rather than a `Prisma.FileWhereInput` at the service boundary,
 * so `permanent-deletion.service.ts` states *what* it is deleting and this file
 * stays the only place that knows how that is spelled in a query.
 */
export type AttachmentOwner =
  | {
      readonly kind: 'response';
      readonly responseId: string;
      readonly formId: string;
    }
  | { readonly kind: 'form'; readonly formId: string };

/** The descriptor as the condition both readers of it use. */
export function attachmentOwnerWhere(
  owner: AttachmentOwner,
): Prisma.FileWhereInput {
  return owner.kind === 'response'
    ? responseAttachmentWhere(owner.responseId, owner.formId)
    : formAttachmentWhere(owner.formId);
}

/**
 * **The attachments of this organisation's answers — and the tenant boundary of the
 * retrieval** (ADR-0014 no. 11b).
 *
 * It exists so that `apps/api/src/files/**` needs no `PrismaService`: that
 * directory is *not* on the allow-list in `eslint.config.js`, the ADR foresees
 * exactly one further entry and it belongs to the purge. The download
 * therefore reads through this delegate, i.e. through `tenant_id` in the
 * `where` — the same shape every other domain read of this application takes.
 *
 * That is not a formality for this table. `file` has **no** composite foreign
 * key on `(form_id, tenant_id)` — Prisma requires every scalar of an optional
 * relation to be optional while `tenant_id` is required (no. 3) — so unlike
 * `response`, a forgotten tenant binding here is caught by nothing underneath:
 * PostgreSQL would hand out another organisation's attachment. The `where` below is the
 * boundary, and what is required is the reproduction that proves it: remove
 * `tenantId` from it and the „Anlage einer fremden Organisation" case turns green
 * where it must be red.
 */
export class ScopedFileDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * One **claimed** attachment of this organisation, by its public reference.
   *
   * Every condition is in the statement rather than in an `if` afterwards, and
   * each answers a different way of not being deliverable:
   *
   * - `tenantId` — the boundary above, and the only one this table has;
   * - `kind` — a Logo is not an answer's attachment, and the public route
   *   next door is the one that delivers those. The `CHECK` and the
   *   `BEFORE UPDATE` trigger of no. 3 keep the column from being rewritten
   *   into the other kind;
   * - `status` — a `pending` row is the crash window of no. 4: a row without
   *   bytes, which must read as „gibt es nicht" rather than as a truncated
   *   download;
   * - `response` — **claimed, to an answer that is not in the trash, and
   *   to a form that is not either.** An unclaimed upload belongs to no answer
   *   at all; delivering one would hand an editor a stranger's in-flight file,
   *   and it is exactly what the purge of no. 15 removes after a day.
   *
   * `deletedAt: null` on the answer follows the rule every read of `response`
   * in this application follows; the bytes themselves are removed by the final
   * deletion of no. 16, not by this filter.
   *
   * **And the same question about the form** (a review finding). Deleting
   * a *form* leaves its answers at `deleted_at IS NULL` — the trash holds
   * the form, not each answer separately — so the answer-only filter let this
   * one route carry on delivering: the answers table, the export, the public
   * address and every edit link answered 404 while `GET /api/responses/files/…`
   * still handed out the bytes of an uploaded power of attorney to anybody who had
   * noted a `public_ref` down beforehand. In the `where` beside the others,
   * because „ist das Formular gelöscht?" is a condition and not a second read.
   */
  async findAttachmentByRef(ref: string): Promise<ScopedAttachment | null> {
    const row = await this.prisma.file.findFirst({
      where: {
        publicRef: ref,
        tenantId: this.tenantId,
        kind: 'response_attachment',
        status: 'stored',
        response: { is: { deletedAt: null, form: { deletedAt: null } } },
      },
      select: {
        id: true,
        fileName: true,
        contentType: true,
        formId: true,
        response: { select: { formId: true } },
      },
    });
    if (row?.response == null) {
      // Both halves in one condition: no row, or a row whose owner the
      // relation filter above already excluded. Prisma types `response` as
      // nullable because the column is, and „beansprucht" is what the `where`
      // asked for — this is the type system catching up, not a second check.
      return null;
    }
    return {
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      formId: row.formId,
      responseFormId: row.response.formId,
    };
  }

  // -------------------------------------------------------------------------
  // Physical deletion — the requirement, ADR-0014 no. 16
  // -------------------------------------------------------------------------

  /**
   * Every attachment row this organisation holds for one answer **that is in the
   * trash** — ids only.
   *
   * Ids and nothing else, like the file purge's own listing: the caller removes
   * bytes by key, and a file name is a participant's datum that has no business
   * travelling through a deletion routine.
   *
   * ## `deleted_at` is in this `where`, and that is not tidiness
   *
   * Removing bytes is the one step of physical deletion that cannot be taken
   * back, and it happens **before** the transaction that would find out the
   * answer was never in the trash (`purgeResponse` refuses that with a
   * 404). Without this condition the refusal came *after* the attachments of a
   * live submission had already been destroyed — measured by
   * `test/trash/permanent-delete.spec.ts` („refuses an answer that is not in
   * the Papierkorb, and blanks nothing"), which is why it is here as a
   * condition and not as an `if` at the caller.
   *
   * ## `form_id` is in it too, and it was missing
   *
   * The route names a form *and* an answer
   * (`DELETE /forms/:id/responses/:responseId/permanent`), and `purgeResponse`
   * checks both. This listing checked only the answer (a review finding), so
   * naming form **A** with an answer of form **B** — both in the same organisation,
   * including one the caller is revoked from — destroyed B's attachment bytes
   * and rows, left the answer standing and reported **404**, i.e. „nothing
   * happened". A stale form id in an open tab was enough. It is the same
   * mistake `deleted_at` fixed one line further along, in the same statement.
   *
   * **What it does not close, said plainly:** a restore landing between this
   * statement and the caller's `remove()` — see {@link purgeAttachment}, which
   * asks this same condition a second time under the row's own lock, one
   * statement before the bytes go.
   */
  async attachmentIdsOfResponse(
    responseId: string,
    formId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.file.findMany({
      where: {
        tenantId: this.tenantId,
        ...responseAttachmentWhere(responseId, formId),
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Every attachment row this organisation holds **for one form**, claimed or not.
   *
   * Two arms, and both are needed:
   *
   * - `formId` — the column `file.form_id`, which is what the `NO ACTION`
   *   foreign key checks when the form is deleted. It also covers the uploads
   *   of fill-in sessions that were never submitted (`response_id IS NULL`),
   *   which nothing else in this routine would find;
   * - `response.formId` — the belt to that braces. `file.form_id` and
   *   `file.response_id` are two separate simple keys with no composite
   *   constraint tying them together (the model comment says so), so „claimed
   *   by an answer of this form" is not implied by the first arm, only made
   *   overwhelmingly likely by the claim's own condition 3.
   *
   * Both arms carry `form.deletedAt`, for the reason spelled out at
   * {@link attachmentIdsOfResponse}: a form that is not in the trash
   * yields no files, so the 404 of `purgeForm` arrives with nothing destroyed.
   */
  async attachmentIdsOfForm(formId: string): Promise<string[]> {
    const rows = await this.prisma.file.findMany({
      where: { tenantId: this.tenantId, ...formAttachmentWhere(formId) },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * **Every file row this organisation holds — provided the organisation's 30 days are up** —
   * what the physical deletion of a whole organisation walks.
   *
   * Ids only, like the two listings above and for the same reason: a file name
   * is a participant's datum and has no business travelling through a deletion
   * routine.
   *
   * **No `kind` and no `status` condition**, unlike {@link
   * attachmentIdsOfForm}: a `kind` filter would leave the Logo behind — bytes
   * on the volume with no row and no `list()` to ever find them again — and a
   * `status` filter would leave the `pending` rows of ADR-0014 no. 4 behind for
   * the same price.
   *
   * **`cutoff` is not optional and there is no method without it** (a security
   * review finding). This used to be `allFileIds()`, with no
   * condition beyond the tenant of the scope, and the argument for it was that
   * „here the whole organisation is past its 30 days" — true of the one caller, said
   * about none of the rows. The delegate is on every guarded request, so the
   * enumeration of a *living* organisation's files was one call away, and the caller of
   * it removes bytes. {@link dueTenantFileWhere} makes „fällig" a predicate of
   * the statement, which is what the name of this method can now honestly
   * claim.
   */
  async dueFileIds(cutoff: Date): Promise<string[]> {
    const rows = await this.prisma.file.findMany({
      where: { tenantId: this.tenantId, ...dueTenantFileWhere(cutoff) },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * **One file of an organisation whose 30 days are up, whatever kind: lock it, ask
   * again whether the organisation is still due, remove the bytes, delete the row** —
   * the shape of {@link purgeAttachment} with {@link dueTenantFileWhere} where
   * that one has its owner condition.
   *
   * Its own method rather than a parameter on that one, because the two say
   * different things and only one of them is safe to widen: `purgeAttachment`
   * is reached from a route where a Logo must **not** be destroyable, and a
   * `kind` that arrived as an argument would be a `kind` a caller can get
   * wrong.
   *
   * ## The due-check is in this statement, and that is both findings at once
   *
   * It used to take no cut-off at all: it deleted *any* `file` row of the
   * scope's tenant, of any kind and any status, bytes first and irreversibly,
   * and the only thing standing in front of it was a sentence about who calls
   * it (a security review finding). A Logo of a living Organisation was one
   * call away from being destroyed by the delegate every request carries.
   *
   * And the same predicate closes a second finding
   * ({@link PermanentDeletionService.deleteTenant}). The caller asked
   * „ist dieser Organisation fällig" **once, before the loop**; a restore landing while
   * the loop ran left the final `DELETE` correctly matching nothing while every
   * file the loop had already reached was gone — an organisation back in service whose
   * answers name attachments that answer 404, with nothing recording which. Now
   * every iteration re-asserts it, inside the transaction and under the row's
   * `FOR UPDATE`, one statement before the bytes go.
   *
   * **What that still does not close, said plainly:** a restore committing
   * between this check and the `remove()` costs that one file, and every file
   * removed *before* the restore stays removed — bytes and row. The window is
   * one statement wide instead of the length of the whole run, and closing it
   * entirely would mean holding a lock on `tenant` across filesystem calls,
   * which is the long transaction a security review took apart.
   *
   * @returns `false` when the row was already gone **or the organisation is not (or no
   * longer) due** — idempotent, so a second run over a half-finished purge is
   * not an error.
   */
  async purgeFile(
    id: string,
    cutoff: Date,
    removeBytes: (id: string) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"
            FROM "file"
           WHERE "id"        = ${id}::uuid
             AND "tenant_id" = ${this.tenantId}::uuid
             FOR UPDATE`;
        if (locked.length === 0) {
          return false;
        }

        // Under the lock and **before** the irreversible half, exactly as
        // `purgeAttachment` asks its owner again: a restore that landed since
        // the enumeration makes this match nothing, and the bytes stay.
        const stillDue = await tx.file.findFirst({
          where: {
            id,
            tenantId: this.tenantId,
            ...dueTenantFileWhere(cutoff),
          },
          select: { id: true },
        });
        if (stillDue === null) {
          return false;
        }

        await removeBytes(id);
        await tx.file.deleteMany({ where: { id, tenantId: this.tenantId } });
        return true;
      },
      // The same two bounds `purgeAttachment` names, for the same reason: this
      // transaction waits on a filesystem, and the defaults are five and two
      // seconds.
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  /**
   * **One attachment: lock it, let the caller remove the bytes, delete the
   * row** — one file, one transaction (ADR-0014 no. 16).
   *
   * The shape is `FilePurgeService.purgeOne`'s, and taking it rather than
   * inventing a second one is deliberate: that shape is what a security
   * review arrived at after measuring the batch version, where an abort
   * in the middle rolled the *rows* back and could not roll the *bytes* back —
   * three files, the middle one unremovable, all three rows alive and the first
   * one's bytes already gone.
   *
   * - **`FOR UPDATE`**, so a submission trying to claim this row in the same
   *   moment waits and then re-evaluates its own `WHERE` against a row that is
   *   gone, instead of claiming a file whose bytes are disappearing;
   * - **bytes first, row second.** A `remove()` that throws aborts the
   *   transaction with the row still standing — visible, and repeatable. The
   *   other order leaves bytes with no index, and the storage seam has no
   *   `list()` to ever find them again;
   * - **`tenant_id` in the `WHERE`**, which for this table is the only boundary
   *   there is (see the class comment).
   *
   * ## The owner is asked a second time, here, and that is what closes the
   * window
   *
   * The caller enumerated these ids a moment ago, under a condition that
   * included „the answer/form is in the trash". Between that listing and
   * this `remove()` a restore can land, and the bytes do not come back — the
   * window used to be described as „two operators inside one second", which was
   * too small by the length of the whole run: it is the enumeration **plus
   * every preceding `remove()`, on a network volume seconds each**.
   *
   * Closing it was also cheaper than the note claimed (a review finding). It
   * said the only way was to hold the form's lock across filesystem calls — the
   * long transaction a security review took apart. But this method
   * already opens a transaction and already holds `FOR UPDATE` on the `file`
   * row, so the owner condition can simply be asked again **inside it**, one
   * statement before the bytes go. That shrinks the window from „enumeration +
   * N removals" to a single statement, and costs no lock this transaction was
   * not taking anyway.
   *
   * `owner` is the very fragment the listing selected by
   * ({@link responseAttachmentWhere}, {@link formAttachmentWhere}) — the same
   * condition, not a second spelling of it, so a restore makes this answer
   * `false` and the caller's own `purgeResponse`/`purgeForm` then answers 404
   * about a row that is alive again.
   *
   * @returns `false` when the row was already gone **or no longer belongs to
   * the item being deleted** — idempotent, so a second run over a half-finished
   * deletion is not an error.
   */
  async purgeAttachment(
    id: string,
    owner: AttachmentOwner,
    removeBytes: (id: string) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"
            FROM "file"
           WHERE "id"        = ${id}::uuid
             AND "tenant_id" = ${this.tenantId}::uuid
             AND "kind"      = 'response_attachment'::"file_kind"
             FOR UPDATE`;
        if (locked.length === 0) {
          return false;
        }

        // Under the lock and **before** the irreversible half: a restore that
        // landed since the enumeration makes this match nothing, and the bytes
        // stay.
        const stillOurs = await tx.file.findFirst({
          where: {
            id,
            tenantId: this.tenantId,
            ...attachmentOwnerWhere(owner),
          },
          select: { id: true },
        });
        if (stillOurs === null) {
          return false;
        }

        await removeBytes(id);
        await tx.file.deleteMany({ where: { id, tenantId: this.tenantId } });
        return true;
      },
      {
        // Both bounds named for the reason `FilePurgeService.purgeOne` names
        // them: this transaction waits on a filesystem, and the defaults are
        // five and two seconds.
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  }

  // -------------------------------------------------------------------------
  // The Logo of this organisation — the requirement, ADR-0014 no. 12 and no. 15
  // -------------------------------------------------------------------------

  /**
   * The `tenant_logo` row of an upload in flight — **before** its bytes
   * (ADR-0014 no. 4).
   *
   * `formId` and `responseId` are absent rather than null-by-accident: the
   * `CHECK` constraint of no. 3 refuses a `tenant_logo` that carries either,
   * which is what keeps „ein Logo mit `response_id`" — the row that would
   * push a stranger's attachment into the public Logo route — from being
   * expressible at all.
   */
  createLogo(data: {
    readonly publicRef: string;
    readonly fileName: string;
    readonly contentType: string;
  }): Promise<{ readonly id: string }> {
    return this.prisma.file.create({
      data: {
        tenantId: this.tenantId,
        kind: 'tenant_logo',
        publicRef: data.publicRef,
        fileName: data.fileName,
        contentType: data.contentType,
      },
      select: { id: true },
    });
  }

  /**
   * The bytes are written **and the organisation adopts them** — in one transaction.
   *
   * The two used to be separate statements, and the comment on `adoptLogo`
   * claimed they were one; two separate reviews found that. What lay between
   * them was a `tenant_logo` row that was `stored` and named by nobody: the
   * purge does not touch a Logo (no. 15) and the sweep only runs on the next
   * branding write of this same organisation, so a crash in that window left bytes that
   * only chance would collect. „Hochgeladen, nie übernommen" is empty by
   * construction only if the construction actually is one step.
   *
   * **Both counts are checked**, and that is the second half. `updateMany`
   * answers „nought rows" as readily as „one", so a row that disappeared
   * meanwhile — a concurrent sweep, a second tab — used to no-op twice and let
   * the route answer 201 for an upload that left nothing behind. The organisation then
   * discovered it at the next read, as a Logo that was silently gone. Failing
   * here names the moment instead.
   */
  async markLogoStoredAndAdopt(
    id: string,
    byteSize: number,
    publicRef: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Scoped and kind-scoped even though the id came from this delegate a
      // moment ago: `updateMany` with the full condition costs one predicate and
      // removes the question „was the id still ours" from the reader's head.
      const stored = await tx.file.updateMany({
        where: { id, tenantId: this.tenantId, kind: 'tenant_logo' },
        data: { status: 'stored', byteSize },
      });
      if (stored.count !== 1) {
        throw new Error(
          'the uploaded logo row was gone before it could be stored',
        );
      }

      // `brandingRevision` is incremented like any other branding write: an
      // open *Erscheinungsbild* tab holding the previous revision must fail
      // loudly on its next save rather than quietly write the old `logo_ref`
      // back over the new one — which would delete the file just uploaded.
      const adopted = await tx.tenant.updateMany({
        where: { id: this.tenantId },
        data: { logoRef: publicRef, brandingRevision: { increment: 1 } },
      });
      if (adopted.count !== 1) {
        throw new Error(
          'the organisation was gone before it could adopt its logo',
        );
      }
    });
  }

  /**
   * Removes one `tenant_logo` **row** of this organisation.
   *
   * The **bytes go first** and are the caller's job (ADR-0014 no. 16): if
   * `remove()` fails, the row must still be standing, or the file would be
   * bytes without an index — unfindable, since the storage seam has no
   * `list()`, and outliving every deletion guarantee already in place.
   */
  async deleteLogo(id: string): Promise<void> {
    await this.prisma.file.deleteMany({
      where: { id, tenantId: this.tenantId, kind: 'tenant_logo' },
    });
  }

  /**
   * Every `tenant_logo` of this organisation the organisation no longer points at.
   *
   * **This is the expression ADR-0014 no. 15 said the purge does not have** —
   * and the difference is the scope. A purge would have to read *backwards*
   * across every organisation and parse every `logo_ref`, where a parse failure, a new
   * union arm or a row being written deletes a **live** Logo. Inside one
   * Organisation, in the same request that just wrote the column, the question is a
   * single comparison against a value that has already been read.
   *
   * An organisation whose `logo_ref` is null or names a shipped asset points at no file
   * at all, so *every* row it holds is unreferenced — which is exactly what
   * „zurück auf ein ausgeliefertes Logo" has to mean if the way back is not
   * to leave a file behind.
   */
  async unreferencedLogoIds(): Promise<string[]> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.tenantId },
      select: { logoRef: true },
    });
    const rows = await this.prisma.file.findMany({
      where: {
        tenantId: this.tenantId,
        kind: 'tenant_logo',
        // **Only finished rows** — a security review measured what the
        // missing predicate cost. A row is written `pending` *before* its bytes
        // (no. 4), and the sweep runs on every branding write of this organisation, so
        // an upload in flight looked unreferenced to a colour save happening in
        // another tab: the row was deleted, `put()` then wrote the bytes with
        // no row left, and the storage seam has no `list()` to find them again.
        // Measured: 201 with `logoRef: null`, a dangling `tenant.logo_ref`,
        // nought `file` rows and 520 bytes on the volume that nothing in this
        // application could ever delete. A failed upload cleans up after itself
        // through `discard`; this sweep has no business touching a row whose
        // bytes are still arriving.
        status: 'stored',
        ...(tenant?.logoRef == null
          ? {}
          : { publicRef: { not: tenant.logoRef } }),
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

/**
 * The templates of one organisation.
 *
 * Every statement below carries `tenant_id` **in the `where`**, and the single-
 * row reads carry it in the *unique key* — `findUnique` on `(id, tenant_id)`,
 * so dropping the organisation from the lookup leaves the key incomplete and fails to
 * compile rather than widening the query (the rule set here and `find`/`update`
 * on `form` follow). That is the whole point: „die Vorlage eines fremden
 * Organisation ist nicht sichtbar und nicht einfügbar" is not a filter this class
 * applies afterwards, it is a key it cannot form.
 */
export class ScopedFormTemplateDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /** The drawer's list — newest first, content included for the count. */
  findMany(): Promise<FormTemplate[]> {
    return this.prisma.formTemplate.findMany({
      where: { tenantId: this.tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** One template of this organisation, or `null` — for another organisation's just as much. */
  findById(id: string): Promise<FormTemplate | null> {
    return this.prisma.formTemplate.findUnique({
      where: { id_tenantId: { id, tenantId: this.tenantId } },
    });
  }

  create(data: {
    kind: FormTemplateKind;
    name: string;
    content: Prisma.InputJsonValue;
  }): Promise<FormTemplate> {
    return this.prisma.formTemplate.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  /**
   * Writes over one template of this organisation — the name, the content, or both.
   *
   * `updateMany` and not `update`, the same reason this file gives at
   * {@link ScopedFormDelegate.updateDraft} and four times after it: the tenant
   * belongs in the **predicate of the statement**. A template of another organisation
   * matches nothing and answers `false`, which the caller turns into the one
   * 404 — rather than `update` raising `P2025`, which would leave a 500 where a
   * 404 was promised.
   *
   * No revision and no optimistic lock, deliberately: `form_template` carries
   * none (`schema.prisma`), and last-write-wins is the honest shape for a row
   * two editors of one organisation can overwrite the same way by pressing „☆ als
   * Vorlage speichern" twice. What it is **not** is a reason to skip the
   * confirmation on the surface — the caller's own comment says why.
   */
  async update(
    id: string,
    data: {
      name?: string;
      content?: Prisma.InputJsonValue;
    },
  ): Promise<boolean> {
    const { count } = await this.prisma.formTemplate.updateMany({
      where: { id, tenantId: this.tenantId },
      data,
    });
    return count === 1;
  }

  /**
   * Removes one template of this organisation, physically.
   *
   * `deleteMany` and not `delete`: the tenant belongs in the predicate of the
   * statement, and `deleteMany` is the shape that takes a non-unique `where`
   * (the same reasoning `updateDraft` writes down for the revision). A template
   * of another organisation matches nothing and answers `false` — the caller turns that
   * into the one 404.
   *
   * No trash, and the model comment in `schema.prisma` says why.
   */
  async delete(id: string): Promise<boolean> {
    const { count } = await this.prisma.formTemplate.deleteMany({
      where: { id, tenantId: this.tenantId },
    });
    return count === 1;
  }
}

/**
 * What a reservation answered — **the call is paid for, or it never happens**
 * (ADR-0015 no. 7).
 *
 * Two arms and no third: there is no „reserved, we will see later" and above
 * all no way to hand a reservation back. A refund path is the one thing that
 * would make „ein Fehlschlag zählt einmal" a rule somebody has to remember
 * instead of a shape of the code.
 */
export type AiReservation =
  | {
      readonly granted: true;
      /** The `ai_usage` row that now holds the seat — and the free text. */
      readonly id: string;
      /** Including this call, so the interface can say „3 von 50". */
      readonly quota: AiQuota;
    }
  | {
      readonly granted: false;
      /** Unchanged: a refusal writes nothing at all. */
      readonly quota: AiQuota;
    };

/** The verdict of one call, written onto the row it reserved. */
export interface AiCallVerdict {
  readonly outcome: AiOutcome;
  /** What the provider said about the cost, already parsed — or `null`. */
  readonly usage: AiUsageSample | null;
}

/**
 * The widest value an `INTEGER` column holds.
 *
 * A token count is a provider's account of itself (ADR-0015 assumption A8), and
 * the shared schema bounds it to „integer, not negative" and nothing else. A
 * provider answering `1e15` would therefore pass the parse and blow up the
 * `UPDATE` — **after** the call, i.e. it would turn a successfully generated
 * form into a 500 over an observation nobody asked for. It costs the
 * observation instead; see {@link ScopedAiUsageDelegate.recordVerdict}.
 */
const MAX_INT32 = 2_147_483_647;

/**
 * **The quota of an organisation: lock, count, write** (* ADR-0015 no. 7).
 *
 * ## Why the lock and not `count()` + `insert`
 *
 * Because `count()` + `insert` passes the sequential run and overbooks in
 * parallel — measured on exactly this shape, 15 instead of 10. Two
 * simultaneous calls both read „4 of 5 spent" and both write;
 * the result is an organisation with six paid calls on a quota
 * of five, and no test that runs one after the other sees anything of it. The
 * lock on the quota row serialises exactly the reservations of **one**
 * organisation and nothing else.
 *
 * ## The row comes into being **before** the call
 *
 * That is the expensive half of it: a counter behind the call costs money and
 * not only state. {@link reserve} commits **before** anything addresses the
 * provider; only then does the call run, and {@link recordVerdict}
 * enters its verdict afterwards. That is also why the transaction here is as short as it
 * is — one that enclosed the network call would hold the quota row of an
 * organisation for up to sixty seconds and turn the provider's time limit into a
 * lock on `tenant`.
 */
export class ScopedAiUsageDelegate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantId: string,
  ) {}

  /**
   * Takes one call off the quota of this organisation — or refuses it.
   *
   * The three steps in one transaction, in this order:
   *
   * 1. **`SELECT … FOR UPDATE`** on the quota row. From here on every
   *    further reservation of *this* organisation waits, and none counts against an
   *    outdated state.
   * 2. **count** what has been spent since `monthStart` — under the lock, i.e.
   *    including what a parallel reservation has just committed.
   * 3. **write**, if there is still room. Otherwise nothing at all: a refusal
   *    leaves no row behind, because it has cost no call.
   *
   * **A deleted organisation spends nothing.** If the lock matches no row
   * (`deleted_at IS NOT NULL`, or the row is gone), the answer is a
   * refusal with quota 0 — the same answer as „switched off", and the
   * call does not happen. The guard chain keeps a deleted organisation away
   * anyway; this here is the floor underneath, not its replacement.
   *
   * `now` and `monthStart` **both** come from the caller's injected
   * clock and never from the database: the month that is counted against, and
   * the stamp that will be counted, have to read the same clock — otherwise
   * a call falls into one month and is counted in the other.
   */
  async reserve(input: {
    readonly userId: string;
    readonly prompt: string;
    readonly provider: AiProvider;
    readonly model: string;
    /**
     * The fixed version behind {@link model}, or `null` — resolved by the
     * caller, not here. The same consideration as with
     * `provider`/`model`: a second resolution around the same call would be
     * two opportunities to disagree.
     */
    readonly modelResolved: string | null;
    readonly now: Date;
    readonly monthStart: Date;
  }): Promise<AiReservation> {
    return this.prisma.$transaction(
      async (tx): Promise<AiReservation> => {
        const locked = await tx.$queryRaw<{ ai_monthly_call_limit: number }[]>`
          SELECT "ai_monthly_call_limit"
            FROM "tenant"
           WHERE "id"         = ${this.tenantId}::uuid
             AND "deleted_at" IS NULL
             FOR UPDATE`;
        const limit = locked[0]?.ai_monthly_call_limit;
        if (limit === undefined) {
          return { granted: false, quota: { used: 0, limit: 0 } };
        }

        // Through Prisma's own API rather than a second raw statement: the
        // tenant is in the `where` either way, and the lock above is the only
        // thing this table needs raw SQL for.
        const used = await tx.aiUsage.count({
          where: {
            tenantId: this.tenantId,
            createdAt: { gte: input.monthStart },
          },
        });
        if (used >= limit) {
          return { granted: false, quota: { used, limit } };
        }

        const row = await tx.aiUsage.create({
          data: {
            tenantId: this.tenantId,
            userId: input.userId,
            createdAt: input.now,
            provider: input.provider,
            model: input.model,
            modelResolved: input.modelResolved,
            // The text belongs to the call and comes into being with it.
            // A second write „right afterwards" would be the second
            // write path that a third caller forgets.
            prompt: input.prompt,
          },
          select: { id: true },
        });
        return {
          granted: true,
          id: row.id,
          // „Including this call" — the number the interface shows is the
          // one after the reservation, not the one before it.
          quota: { used: used + 1, limit },
        };
      },
      {
        // Both bounds named, because both decide what a rush
        // costs: `maxWait` is otherwise two seconds — under twenty
        // simultaneous reservations the twentieth waits for nineteen
        // predecessors and would fail with P2028 instead of with a 429. `timeout`
        // caps how long a hanging reservation holds the row; the
        // transaction contains no network call, so fifteen seconds are
        // safety margin and not an expectation.
        maxWait: 15_000,
        timeout: 15_000,
      },
    );
  }

  /**
   * Enters the verdict of a call on its row afterwards.
   *
   * **There is no way here to give the quota back** — only columns
   * that describe how it turned out. That is the shape behind „a failure
   * counts exactly once" (ADR-0015 no. 7): no refund, no `catch` that
   * decrements, no method that deletes a reservation.
   *
   * `updateMany` instead of `update`: the organisation belongs in the predicate of the statement,
   * and `id` alone would be the unique key that made it superfluous —
   * exactly the place where a tenant boundary is otherwise lost. A row
   * of another organisation matches nothing.
   *
   * The model identifier is **overwritten** when the provider reports one
   * back: what is billed is what actually ran, not what
   * was configured.
   */
  async recordVerdict(id: string, verdict: AiCallVerdict): Promise<void> {
    const sample = verdict.usage;
    await this.prisma.aiUsage.updateMany({
      where: { id, tenantId: this.tenantId },
      data: {
        outcome: verdict.outcome,
        ...(sample === null ? {} : { model: sample.model }),
        inputTokens: asInt32(sample?.inputTokens ?? null),
        outputTokens: asInt32(sample?.outputTokens ?? null),
      },
    });
  }

  /**
   * The consumption and remainder of this organisation in the current calendar month
   * — the reading half that the interface shows.
   *
   * Without a lock, because nothing is decided: the number is a display and
   * outdated a moment later anyway. What is decided is decided in
   * {@link reserve}, and the lock lies **there**. Locking this method as well
   * would be the second truth about the same budget.
   *
   * A deleted organisation reads 0 of 0 — the same answer {@link reserve}
   * gives it.
   */
  async quota(monthStart: Date): Promise<AiQuota> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: this.tenantId, deletedAt: null },
      select: { aiMonthlyCallLimit: true },
    });
    const used = await this.prisma.aiUsage.count({
      where: { tenantId: this.tenantId, createdAt: { gte: monthStart } },
    });
    return { used, limit: tenant?.aiMonthlyCallLimit ?? 0 };
  }
}

/**
 * A token count as the `INTEGER` column can hold it — or `null`.
 *
 * The clamp is deliberately **not** a truncation to `MAX_INT32`: a number that
 * large is not a token count, and storing a plausible-looking maximum would put
 * a fabricated figure into the basis of a cost attribution. „Der Anbieter hat
 * nichts Brauchbares gemeldet" is what `null` already means.
 */
function asInt32(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value)) {
    return null;
  }
  return value >= 0 && value <= MAX_INT32 ? value : null;
}
