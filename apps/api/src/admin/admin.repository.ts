import {
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ADMIN_GROUP_RANK,
  DEFAULT_GROUP_RANKS,
  DEFAULT_TENANT_BRANDING,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import {
  invitationRefusalMessage,
  type AccountInvitation,
  type InvitationPlan,
} from '../auth/invitation/account-invitation';
import { enqueueInvitation } from '../auth/invitation/enqueue-invitation';
import { OWNED_LOGO_INCLUDE } from '../files/owned-logo';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The two things the superadmin surface needs a database for — and the **only**
 * cross-tenant reads this application makes outside the mail worker and the
 * purge jobs (the requirements).
 *
 * ---------------------------------------------------------------------------
 * **This file uses `PrismaService` directly.** `apps/api/src/admin/**` is on the
 * allow-list in `eslint.config.js`; the entry is written out there and the
 * argument is repeated here, where somebody changing this code will actually be
 * looking:
 *
 * 1. **The question is installation-wide by its nature.** „Wie viele organisations,
 *    Formulare, Antworten und Nutzer gibt es?" cannot be asked inside one organisation,
 *    and a `TenantScope` would answer a different question. Creating an organisation is
 *    the same category: there is no scope yet, because the row the scope would
 *    be built from is what this call makes.
 * 2. **Nothing from a request selects an organisation.** {@link overview} takes no
 *    parameter at all, and {@link findById} takes an id that names a row this
 *    surface is *supposed* to be able to name — that is the whole of the requirement, and it is why the superadmin routes are a separate prefix instead of a
 *    tenant parameter bolted onto `/api/tenant/…`.
 * 3. **Only counters and identity leave.** The projection below is a positive
 *    list: it carries the organisation's own identity and its branding, and it does not
 *    carry `form_defaults` (which holds a sealed access word), the OIDC issuer,
 *    the client id or the encrypted client secret. A reader that never selects
 *    a secret cannot leak one, whatever a later mapper does.
 *
 * **The counter-check is what makes the entry defensible, and it is the line to
 * hold:** everything *fachlich* about an organisation — its users, its groups, its
 * form-level restrictions, its settings — stays on the `TenantScope`. There is
 * no method here that reads an organisation's members or forms, and there must not be
 * one. An `AdminService` that read an organisation's users because Prisma was within
 * arm's reach would be the regression every test survives. This class is provided inside `AdminModule` and deliberately **not**
 * exported.
 * ---------------------------------------------------------------------------
 */

/**
 * What the overview reads of an organisation — an **allow list**, so a column added to
 * `tenant` later has to be added here too before it can reach a payload.
 *
 * `formDefaults` is the one absence worth naming: it holds the organisation's sealed
 * access word, and there is no reason for a KPI table to have
 * it in memory. The same goes for the whole OIDC block except the one boolean
 * the *Anmeldungs-Status* column shows.
 */
const TENANT_OVERVIEW_SELECT = {
  id: true,
  shortName: true,
  name: true,
  logoRef: true,
  logoWide: true,
  stripeColors: true,
  accentColor: true,
  headerColor: true,
  canvasColor: true,
  /** „OIDC aktiv" against „nur lokal" — the Anmeldungs-Status column. */
  oidcEnabled: true,
  /** The AI quota that is set — the number „Verwalten" edits. */
  aiMonthlyCallLimit: true,
  /**
   * The fourth shore of ADR-0014 no. 12, and the one that reads **across**
   * organisations: the Logo files are loaded **per row**, not resolved once for the
   * viewer. A superadmin looking at twenty organisations has twenty ownership
   * questions, and one answer for all of them would be the bug this include
   * exists to make unspellable (`files/owned-logo.ts`).
   */
  files: OWNED_LOGO_INCLUDE.files,
} satisfies Prisma.TenantSelect;

/** One organisation as the overview sees it: identity, branding, and one flag. */
export type OverviewTenant = Prisma.TenantGetPayload<{
  select: typeof TENANT_OVERVIEW_SELECT;
}>;

/**
 * One organisation of the „Gelöschte Organisationen" section — the same projection plus the one
 * column that section is about.
 */
export type DeletedOverviewTenant = Prisma.TenantGetPayload<{
  select: typeof TENANT_OVERVIEW_SELECT & { deletedAt: true };
}>;

/** How many of one thing each organisation has, keyed by tenant id. */
export type CountsByTenant = ReadonlyMap<string, number>;

/** Everything the KPI tiles and the table are built from. */
export interface OverviewData {
  readonly tenants: readonly OverviewTenant[];
  readonly forms: CountsByTenant;
  readonly responses: CountsByTenant;
  readonly users: CountsByTenant;
}

/**
 * Who becomes the first administrator of the new organisation — **either an
 * account that is created or found, or one that is already settled**
 * (review finding 7).
 *
 * Two arms and no optional field: `{ userId }` is "the signed-in superadmin
 * account", and that id comes from the session (`AdminService.create`), never
 * from a request body. A `{ email, name, passwordHash, userId? }` would be the
 * same information with one state more — "both given" — that somebody would
 * have to resolve.
 */
export type TenantAdminData =
  | { readonly userId: string }
  | {
      readonly email: string;
      readonly name: string;
      /**
       * The invitation with which this person sets their password themselves
       * (ADR-0024) — or the refusal saying why the installation cannot send
       * one.
       *
       * A refusal is **no** silent permission to create the account anyway:
       * {@link resolveAdminId} throws it exactly when it *would have to*
       * create an account. An address that already has one is linked, and that
       * needs no mail — which is why the decision stands in here and not as a
       * pre-check at the caller, who does not yet know which of the two cases
       * occurs.
       */
      readonly invitation: InvitationPlan;
    };

/** What „eine Organisation anlegen" writes. */
export interface TenantCreateData {
  readonly shortName: string;
  readonly name: string;
  readonly admin: TenantAdminData;
}

/** The identity of a freshly created Organisation. */
export interface CreatedTenant {
  readonly id: string;
  readonly shortName: string;
}

/**
 * The three groups every organisation starts with (the design handoff).
 *
 * The ranks come from `@formsache/shared`, not from a second list here: the per-form
 * cap of the requirement compares roles by rank, so an organisation whose `editor` sat at a
 * different height than everybody else's would make „auf diese Gruppe herab"
 * mean something different in that organisation.
 *
 * `admin` is the **system** group: all six permissions, not editable, not
 * deletable, and created here and nowhere else — `ScopedGroupDelegate.create`
 * cannot express `isSystem: true`, which is what keeps „eine zweite
 * unlöschbare Gruppe" unspellable through any route.
 *
 * **Exported since ADR-0022**, and to exactly one second caller: the first
 * commissioning (`setup/first-superadmin.ts`) creates a first organisation if
 * the operator does not skip it, and has to produce the same three groups with
 * the same permissions. A second list there would be the sort of duplication
 * where the *first* organisation of an installation carries different rights
 * half a year later than every one created after it — and nobody noticed which
 * of the two lists did not get the next permission.
 * `apps/api/test/setup/setup.spec.ts` holds the two paths against each other.
 */
export const DEFAULT_GROUPS = [
  {
    name: 'admin',
    color: '#7c0800',
    rank: DEFAULT_GROUP_RANKS.admin,
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
    rank: DEFAULT_GROUP_RANKS.editor,
    isSystem: false,
    canBuild: true,
    canViewResponses: true,
    canExport: true,
    // Organisation-wide settings: **no**. The form standards of the
    // organisation, the appearance, the sending identity and SSO stay with
    // `admin`.
    canManageSettings: false,
    // The settings of one's own forms: **yes** (ADR-0021). Whoever builds a
    // form also configures it — form settings, notifications, dispatch log and
    // user rights per form. Without that, this group saw only Bearbeiten,
    // Vorschau and Antworten in the form menu and had to ask an administrator
    // for every deadline.
    canManageFormSettings: true,
    canManageUsers: false,
  },
  {
    name: 'viewer',
    color: '#5b6b52',
    rank: DEFAULT_GROUP_RANKS.viewer,
    isSystem: false,
    canBuild: false,
    canViewResponses: true,
    canExport: false,
    canManageSettings: false,
    canManageFormSettings: false,
    canManageUsers: false,
  },
] as const;

@Injectable()
export class AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every organisation with its three counters.
   *
   * Four statements regardless of how many organisations there are, not one per row:
   * the counts are `groupBy` aggregates the database performs, and the KPI
   * tiles are sums over them rather than a fifth query. A per-Organisation count would
   * be the shape that stops being affordable exactly when the overview starts
   * being interesting.
   */
  async overview(): Promise<OverviewData> {
    const tenants = await this.prisma.tenant.findMany({
      // **Filter 4 of the six of the requirement — `tenant.deleted_at`.** The
      // Superadmin-Übersicht is the one listing of this application that reads
      // across organisations, and „sofort unsichtbar" has to mean this table too. The
      // deleted ones are not simply dropped from the page: they come back in
      // their own section through {@link findDeleted} , which is
      // the only place they are listed at all.
      where: { deletedAt: null },
      select: TENANT_OVERVIEW_SELECT,
      // Decided here rather than left to the plan PostgreSQL happened to pick:
      // the table is a list a human reads, and „gleiche Reihenfolge bei jedem
      // Laden" is part of it being readable.
      orderBy: { shortName: 'asc' },
    });

    // Trash rows do not count in either table: a deleted form applies to
    // nobody and a deleted answer is on its way out (30 Tage).
    const forms = await this.prisma.form.groupBy({
      by: ['tenantId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const responses = await this.prisma.response.groupBy({
      by: ['tenantId'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    // „Nutzer einer Organisation" is a count over `membership`, never over `user`:
    // a person belongs to no organisation, a membership does (see `schema.prisma`).
    const users = await this.prisma.membership.groupBy({
      by: ['tenantId'],
      _count: { _all: true },
    });

    return {
      tenants,
      forms: countsOf(forms),
      responses: countsOf(responses),
      users: countsOf(users),
    };
  }

  /**
   * One organisation with its three counters, or `null`.
   *
   * Four statements again, but each of them bound to this one id rather than
   * walking every table: „Verwalten" on a table of fifty Organisationen must not cost
   * what the table itself costs.
   */
  async findById(id: string): Promise<OverviewData | null> {
    // Filter 4 again, on the single row: „Verwalten" on a deleted Organisation answers
    // the same 404 as an id that never existed. `findFirst`, because the
    // condition is no longer the primary key alone — and the state is a
    // predicate of the statement rather than an `if` behind it, so the two
    // refusals are one code path (the shape the requirement settled on).
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      select: TENANT_OVERVIEW_SELECT,
    });
    if (tenant === null) {
      return null;
    }

    const forms = await this.prisma.form.count({
      where: { tenantId: id, deletedAt: null },
    });
    const responses = await this.prisma.response.count({
      where: { tenantId: id, deletedAt: null },
    });
    const users = await this.prisma.membership.count({
      where: { tenantId: id },
    });

    return {
      tenants: [tenant],
      forms: new Map([[id, forms]]),
      responses: new Map([[id, responses]]),
      users: new Map([[id, users]]),
    };
  }

  // -------------------------------------------------------------------------
  // Deleting an organisation and fetching it back — the requirement, Konzept no. 59 and no. 64
  // -------------------------------------------------------------------------

  /**
   * The „Gelöschte Organisationen" section of the Superadmin-Übersicht.
   *
   * **The only listing in this application that reads deleted organisations**, and the
   * only one that may: everything else answers as if they were not there. It
   * carries identity and the moment of deletion and no counters — see
   * `deletedTenantSchema` for why a deleted organisation's contents stay unreachable.
   *
   * Newest deletion first, so the row somebody just deleted by mistake is the
   * one at the top.
   */
  async findDeleted(): Promise<readonly DeletedOverviewTenant[]> {
    return this.prisma.tenant.findMany({
      where: { deletedAt: { not: null } },
      select: { ...TENANT_OVERVIEW_SELECT, deletedAt: true },
      orderBy: { deletedAt: 'desc' },
    });
  }

  /**
   * The organisation's `name` — what the confirmation of Konzept no. 59 is compared
   * against — for an organisation that is **not** already deleted.
   *
   * `null` covers „gibt es nicht" and „liegt schon im Papierkorb" alike, so the
   * caller answers both with the one 404 {@link findById} answers. Reading the
   * name is the only thing this method does: a comparison performed here would
   * put „darf gelöscht werden" in the data layer, and the service is where the
   * two possible refusals (unbekannt, falsch abgetippt) are told apart.
   */
  async nameOfLive(id: string): Promise<string | null> {
    const row = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  /**
   * **Deleting leads into the trash** — `deleted_at` and nothing else.
   *
   * `updateMany` with `deletedAt: null` in the `where`, exactly as every other
   * trash write of this milestone: the state is a *condition* of the
   * statement, so a second click cannot overwrite the timestamp the 30 days are
   * counted from and shift the deadline forward without anybody noticing.
   *
   * `at` is handed in rather than read here, for the same reason: it comes
   * from the injected clock (`MailClock`), so the purge
   * can be proven at „29 Tage bleibt, 31 Tage ist weg" through the route rather
   * than against a row written into the table by hand.
   *
   * @returns whether a live Organisation was actually moved.
   */
  async softDelete(id: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: at },
    });
    return count === 1;
  }

  /**
   * Takes an organisation back out of the trash.
   *
   * Nothing else is touched, and nothing else has to be: the six filters read
   * `deleted_at`, so clearing it puts the organisation's people, forms, public
   * addresses and withheld mail back at once. That is the whole
   * argument for a soft delete over an export-and-recreate.
   *
   * @returns whether a deleted Organisation was actually restored — `false` for „gibt
   * es nicht" and for „war gar nicht gelöscht" alike.
   */
  async restore(id: string): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({
      where: { id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    return count === 1;
  }

  /**
   * **Sets the AI quota of an organisation** .
   *
   * `updateMany` with `deleted_at: null` in the `where`, for the same reason as
   * {@link softDelete}: the state is a **predicate of the statement**, not an
   * `if` in front of it. An organisation that wanders into the trash between
   * the reading of the row and this write gets no budget set any more — and
   * the caller learns of it from `false`, instead of from a silent change to a
   * row nobody sees any more.
   *
   * @returns whether a living organisation row was written — `false` for „gibt
   * es nicht" and „liegt im Papierkorb" alike, so that the service answers both
   * with the same 404.
   */
  async setAiMonthlyCallLimit(id: string, limit: number): Promise<boolean> {
    const { count } = await this.prisma.tenant.updateMany({
      where: { id, deletedAt: null },
      data: { aiMonthlyCallLimit: limit },
    });
    return count === 1;
  }

  /**
   * Creates an organisation together with its three groups and its first administrator
   * — **in one transaction** .
   *
   * All of it or none of it, and that is not tidiness: an organisation without its
   * `admin` group cannot be administered by anybody, and an organisation without a first
   * member can only be reached by a superadmin — the two states „sofort
   * arbeitsfähig" rules out. Three statements outside a transaction would leave
   * either of them behind on a failure, with no route to repair them.
   *
   * **`form_defaults` is deliberately not written**, so the column keeps its
   * `{}` default and the organisation goes on inheriting from the system row.
   * Copying the system values here
   * would look identical on the first day and cut the organisation off for good — the
   * same break already fixed for the first *save*. There is no field for it in
   * `tenantCreateSchema` either, which is the half of the promise a test cannot
   * make.
   *
   * The branding is the installation's default, not a copy of anybody's: a
   * fresh Organisation shows the shipped look until somebody opens the
   * *Erscheinungsbild* tab.
   *
   * The one read of `user` this class makes lives inside that transaction and
   * resolves an **address to an identity** — it is not an organisation's membership list
   * and must not grow into one (see the file header). It returns an id and
   * nothing else, and it runs where the write that depends on it runs, so there
   * is no window between „gibt es das Konto?" and „dann verknüpfe es".
   */
  async createTenant(data: TenantCreateData): Promise<CreatedTenant> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          shortName: data.shortName,
          name: data.name,
          logoRef: null,
          logoWide: false,
          // Fresh array: Prisma's generated input is mutable, and handing it
          // the shared constant would let a later `.push()` reach every organisation.
          stripeColors: [...DEFAULT_TENANT_BRANDING.stripeColors],
          accentColor: DEFAULT_TENANT_BRANDING.accent,
          headerColor: DEFAULT_TENANT_BRANDING.headerBg,
          canvasColor: DEFAULT_TENANT_BRANDING.canvasBg,
          // No `formDefaults` — see the doc above. This absence is deliberate, not an oversight.
        },
        select: { id: true, shortName: true },
      });

      await tx.group.createMany({
        data: DEFAULT_GROUPS.map((group) => ({
          ...group,
          tenantId: tenant.id,
        })),
      });

      const adminGroup = await tx.group.findUniqueOrThrow({
        where: {
          tenantId_name: { tenantId: tenant.id, name: adminGroupName() },
        },
        select: { id: true },
      });

      // **The signed-in superadmin account** (review finding 7): nothing is
      // searched for here and nothing created, the id is already settled — it
      // comes from the session, not from the request body. Nothing is written
      // to this account, for the same reason nothing is written to a found
      // foreign one: name and password belong to the person.
      //
      // **An address that already has an account is attached, not rewritten**.
      //
      // `user.email` is unique installation-wide (ADR-0012), so creating
      // unconditionally answered 409 for everybody who already serves *any*
      // Organisation — while „dieselbe Person kann mehreren Organisationen dienen" is precisely
      // the case the Tenant-Wechsler exists for. It forced a
      // second address on the one person a new Organisation is most likely to start
      // with.
      //
      // Nothing is written to that row, and that is the whole of the decision:
      // name and password belong to the person, not to the superadmin creating
      // this organisation. `TenantUsersService.create` draws the same line one level
      // down, and this is that rule applied to the
      // first administrator.
      //
      // **And no invitation goes to an existing account** (ADR-0024): the
      // person knows their password, „sofort arbeitsfähig" holds because their
      // credentials already work, and an invitation would be a second
      // authorisation for an account that does not belong to the new
      // organisation.
      const admin = await resolveAdminId(tx, data.admin);

      await tx.membership.create({
        data: { tenantId: tenant.id, userId: admin.id, groupId: adminGroup.id },
      });

      if (admin.invitation !== null) {
        // **In the same transaction as the account** — the same statement the
        // member administration of an organisation uses. An account without an
        // invitation would be one nobody gets into; an invitation without an
        // account a mail whose link points into the void.
        //
        // Only **after** the membership: `mail_log.tenant_id` points at this
        // organisation, and the row is meant to stand in the dispatch log
        // exactly where the person became a member.
        await enqueueInvitation(tx, tenant.id, admin.id, admin.invitation);
      }

      return tenant;
    });
  }
}

/**
 * The id of the first administrator, resolved inside the transaction.
 *
 * The case "myself" is **one field less**, not one special path more: the id is
 * already settled, there is nothing to search for and nothing to create. The
 * other arm is the previous one — look the address up, otherwise create an
 * account —, and it still runs *here*, in the same write, so that between
 * "does the account exist?" and "then link it" there is no window.
 */
async function resolveAdminId(
  tx: Prisma.TransactionClient,
  admin: TenantAdminData,
): Promise<ResolvedAdmin> {
  if ('userId' in admin) {
    // Looked up and not passed through: the id comes from the session, and
    // between the guard and this transaction the account can have been deleted
    // — then `membership.create` would fail at the foreign key and the caller
    // would see a 500 with Prisma wording. The same statement as
    // `ProfileService.reload`, because it is the same situation.
    const self = await tx.user.findUnique({
      where: { id: admin.userId },
      select: { id: true },
    });
    if (self === null) {
      throw new UnauthorizedException('Diese Sitzung gehört niemandem mehr.');
    }
    // One's own account does not invite itself: it exists and knows its
    // password (ADR-0024).
    return { id: self.id, invitation: null };
  }

  const existing = await tx.user.findUnique({
    where: { email: admin.email },
    select: { id: true },
  });
  if (existing !== null) {
    // Linked, not rewritten — and therefore not invited either.
    return { id: existing.id, invitation: null };
  }

  if (admin.invitation.kind !== 'ready') {
    // **Here and only here is "no invitation possible" a refusal**
    // (ADR-0024): an account without a password is about to come into being,
    // and without an invitation nobody would ever get in — the organisation
    // would have an administrator who does not exist. The transaction rolls
    // back, no half organisation is left standing.
    throw new UnprocessableEntityException(
      invitationRefusalMessage(admin.invitation),
    );
  }

  const created = await tx.user.create({
    // Field by field rather than spread: this is the one place a first
    // administrator is minted, and `isSuperadmin` must not be able to travel in
    // with the payload. An organisation's admin administers an organisation.
    //
    // **Without `passwordHash`** (ADR-0024): the account comes into being
    // empty, and the person sets their password over the invitation's link.
    data: { email: admin.email, name: admin.name },
    select: { id: true },
  });
  return { id: created.id, invitation: admin.invitation.invitation };
}

/**
 * Who the first administrator is — **and whether they still have to be
 * invited** (ADR-0024).
 *
 * Two fields instead of one id, because the answer to "does a mail have to go
 * out?" arises exactly where it is decided whether an account is created or an
 * existing one linked. To derive it once more afterwards would mean answering
 * the same question a second time — and the second answer would be the one
 * that deviates at some point.
 */
interface ResolvedAdmin {
  readonly id: string;
  /** `null` when the account already existed: it knows its password. */
  readonly invitation: AccountInvitation | null;
}

/**
 * The name of the system group, read off the list rather than typed again.
 *
 * A literal `'admin'` here and a `name: 'admin'` above are two spellings of one
 * fact, and the lookup right after the insert is exactly where they would first
 * disagree — with a `findUniqueOrThrow` that fails at Organisation creation.
 *
 * Exported for the same reason as {@link DEFAULT_GROUPS}: the first
 * commissioning has to find the same group, and `'admin'` typed there once
 * more would be the third spelling of one name.
 */
export function adminGroupName(): string {
  const group = DEFAULT_GROUPS.find(
    (candidate) => candidate.rank === ADMIN_GROUP_RANK,
  );
  if (group === undefined) {
    throw new Error('The default groups carry no admin group.');
  }
  return group.name;
}

/** A Prisma `groupBy` result as a map — the shape the mapper reads. */
function countsOf(
  rows: readonly { tenantId: string; _count: { _all: number } }[],
): CountsByTenant {
  return new Map(rows.map((row) => [row.tenantId, row._count._all]));
}
