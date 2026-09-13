import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE,
  deliverableBranding,
  type AiQuotaWrite,
  type DeletedTenantList,
  type TenantCreate,
  type TenantDelete,
  type TenantOverview,
  type TenantOverviewRow,
} from '@formsache/shared';
import { Prisma } from '@prisma/client';

import type { InvitationPlan } from '../auth/invitation/account-invitation';
import { AccountInvitationService } from '../auth/invitation/account-invitation.service';
import { translateConcurrency } from '../common/prisma-error';
import { isUuid } from '../common/uuid';
import { ownedLogoRef } from '../files/owned-logo';
import { MailClock } from '../mail/mail-clock';
import {
  AdminRepository,
  type CountsByTenant,
  type DeletedOverviewTenant,
  type OverviewTenant,
} from './admin.repository';

/**
 * The answer when an organisation named in the path does not exist.
 *
 * 404 here, not the 403 the guard gives: whoever reached this point *is* the
 * installation's administrator, so „diese Organisation gibt es nicht" is an honest
 * answer rather than a leak. The boundary that must not tell an id apart from a
 * stranger's is the *tenant* one, and it is drawn earlier and elsewhere
 * (`TenantScopeGuard`).
 */
export const TENANT_NOT_FOUND_MESSAGE = 'Diese Organisation gibt es nicht.';

/**
 * The answer when the Kurzname is taken.
 *
 * It is unique across the installation (`tenant.short_name`) and it is
 * something the person filling the form can fix — so the message says so, and
 * nothing else.
 */
export const SHORT_NAME_TAKEN_MESSAGE =
  'Diesen Kurznamen gibt es in dieser Installation schon.';

/**
 * Two „+ Neue Organisation" requests naming the **same, so far unknown** address at
 * the same moment.
 *
 * An address that already has an account is **attached** rather than refused
 * (see `AdminRepository.createTenant`), so this is no longer the answer to
 * „diese Person gibt es schon" — it is the answer to a race: the row did not
 * exist when this request looked, and existed when it wrote. One of the two
 * loses at `user.email @unique`, which untranslated is a 500 naming a
 * PostgreSQL index. The honest instruction is to try again, at which point the
 * address resolves and the person is attached.
 *
 * The wording deliberately carries no hint about *where* an address is in use:
 * that would be a report about another organisation's membership, made to somebody who
 * did not ask about it.
 */
export const ADMIN_EMAIL_TAKEN_MESSAGE =
  'Diese E-Mail-Adresse wurde soeben vergeben. Bitte noch einmal versuchen.';

/**
 * The superadmin overview and „+ Neue Organisation" (the requirements, the design handoff).
 *
 * **This service reaches across organisations and is the only domain service that
 * does.** What makes it tolerable is written at {@link AdminRepository}, and
 * the shape of it is here: the repository hands out counters and identity, this
 * class turns them into the wire document, and neither of them has a method
 * that reads an organisation's users, forms or settings. Everything *fachlich* about a
 * Organisation keeps going through the `TenantScope` — including the administration of
 * that organisation, which is `apps/api/src/tenant-admin/**` and takes a scope built
 * from a membership.
 */
@Injectable()
export class AdminService {
  /**
   * **The protocol of the most destructive verb this application has**
   * (a security review finding, `CONTRIBUTING.md`).
   *
   * Taking a whole organisation out of service, bringing it back, and a confirmation
   * that did not match left no trace at all, while the file purge, the redeeming
   * of an invitation and the mail purge beside them all write a line. „Wer hat
   * VICTIM gelöscht, und wann" was answerable only from the column the restore
   * then clears.
   *
   * **Two ids and nothing else.** The tenant, the acting user — never a name,
   * never an e-mail address, and never the string that was typed into the
   * confirmation: that one is caller input, and the refusal deliberately does
   * not hand the expected name back out either
   * ({@link TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE}). The moment comes from
   * Nest's own log stamp, so there is no second clock to disagree with
   * `tenant.deleted_at`.
   */
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly repository: AdminRepository,
    /**
     * **The one clock**, `MailClock` — the same one the trash takes
     * for `form.deleted_at` and `response.deleted_at`.
     *
     * `tenant.deleted_at` is where the 30 days of the requirement start, and
     * the evidence is measured „mit injizierter Uhr". A `new Date()` here
     * would mean the only way to a 31-day-old Organisation is to write the column by
     * hand — i.e. to prove the purge against a state the application is not
     * shown to produce. That was a finding on exactly this shape.
     */
    private readonly clock: MailClock,
    /**
     * The invitation of the first administrator (ADR-0024) — the same service
     * the member administration of an Organisation uses, so that deadline,
     * wording and refusal do not come into being twice.
     */
    private readonly invitations: AccountInvitationService,
  ) {}

  /** The KPI tiles and the table below them. */
  async overview(): Promise<TenantOverview> {
    const data = await this.repository.overview();
    const tenants = data.tenants.map((tenant) =>
      toRow(tenant, data.forms, data.responses, data.users),
    );

    return {
      tenants,
      totals: {
        tenants: tenants.length,
        // Summed over the rows rather than counted a second time in the
        // database: two numbers for one question are two numbers that can
        // disagree, and the one on the tile is the one somebody would trust.
        forms: sumOf(tenants, (row) => row.forms),
        responses: sumOf(tenants, (row) => row.responses),
        users: sumOf(tenants, (row) => row.users),
      },
    };
  }

  /** One row of that table — what „Verwalten" opens with. */
  async find(id: string): Promise<TenantOverviewRow> {
    requireTenantId(id);
    const data = await this.repository.findById(id);
    const tenant = data?.tenants[0];
    if (data === null || tenant === undefined) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return toRow(tenant, data.forms, data.responses, data.users);
  }

  // -------------------------------------------------------------------------
  // Deleting an Organisation and bringing it back — the requirement, concept
  // -------------------------------------------------------------------------

  /** The „Gelöschte Organisationen" section of the overview. */
  async listDeleted(): Promise<DeletedTenantList> {
    const tenants = await this.repository.findDeleted();
    return { tenants: tenants.map(toDeletedRow) };
  }

  /**
   * **Putting an Organisation into the trash** .
   *
   * Three refusals, and the order they are asked in is the whole of the method:
   *
   * 1. the id is not an organisation this superadmin can delete — **404**, the same
   *    answer for „gibt es nicht" and „liegt schon im Papierkorb", so a repeated
   *    click and a typo are indistinguishable and neither confirms anything;
   * 2. the typed name does not match — **409**, and the message does not repeat
   *    the expected name (`TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE`);
   * 3. somebody else deleted it between the read and the write — **404** again,
   *    because `softDelete` carries `deleted_at IS NULL` as a *condition* and
   *    answers `false` rather than moving the deadline of a deletion that
   *    already ran.
   *
   * There is **no membership check**, and that is the decision rather than an
   * omission: deleting an organisation is Verwaltung, not fachliche Daten, and requiring
   * a membership would mean a superadmin has to join an organisation to take it out of
   * service — which is exactly the cross-tenant reach the SuperadminGuard denies them. The
   * guard chain of this controller is `SessionGuard → SuperadminGuard` and
   * nothing else.
   *
   * **The organisation is not touched apart from one column.** Its people, its forms,
   * its answers and its queued mail stay exactly as they are; the six filters
   * are what make it unusable, and clearing the column makes it usable again.
   *
   * **Two of the three refusals are silent on purpose, one is not.** „Gibt es
   * nicht" needs no line — nothing happened, and a log entry per mistyped id
   * would be a way to fill the protocol from outside. The mismatched
   * confirmation does get one: somebody stood in front of this dialog with the
   * right id and the wrong name, and that is the shape a mistake and an attempt
   * share (see {@link logger}).
   *
   * `actorId` is the signed-in superadmin, handed in by the controller from
   * `@CurrentAuth()` rather than read from a request here — this class has no
   * HTTP in it (`AdminTenantsController`).
   */
  async remove(
    id: string,
    request: TenantDelete,
    actorId: string,
  ): Promise<void> {
    requireTenantId(id);

    const name = await this.repository.nameOfLive(id);
    if (name === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    if (request.confirmName !== name) {
      // The typed value is **not** in the line: it is caller input, and the
      // refusal itself deliberately does not repeat the expected name either.
      this.logger.warn(
        `tenant ${id}: deletion refused, the typed confirmation did not match (user ${actorId})`,
      );
      throw new ConflictException(TENANT_DELETE_CONFIRM_MISMATCH_MESSAGE);
    }

    const deleted = await this.repository.softDelete(id, this.clock.now());
    if (!deleted) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }

    // After the write, never before: a line about a deletion that then lost its
    // `deleted_at IS NULL` condition would be a protocol of something that did
    // not happen.
    this.logger.log(
      `tenant ${id} moved to the Papierkorb, 30 days (user ${actorId})`,
    );
  }

  /**
   * **Bringing back a deleted Organisation** — from the „Gelöschte Organisationen" section
   * of the Superadmin-Übersicht.
   *
   * No confirmation to type: restoring is the reversal of the destructive act,
   * not a second one, and a hurdle in front of the way back is what turns a
   * mistake into a permanent one — the same reading `FormsController.restoreForm`
   * takes for a form.
   *
   * 404 for „gibt es nicht" and for „war gar nicht gelöscht" alike, from the
   * one condition in `restore`.
   */
  async restore(id: string, actorId: string): Promise<void> {
    requireTenantId(id);
    if (!(await this.repository.restore(id))) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    // Protocolled like the deletion is, and for the same reason: „die Organisation war
    // eine Woche weg und ist wieder da" is a fact about the installation that
    // the cleared column no longer holds (see the doc on `logger`).
    this.logger.log(
      `tenant ${id} restored from the Papierkorb (user ${actorId})`,
    );
  }

  /**
   * **Sets the AI quota of an Organisation** (the requirement:
   * „das Nutzungslimit ist in der UI setzbar").
   *
   * It is deliberately **here** and not in the Organisation administration: an Organisation admin
   * who could raise their own budget would be a cost lever no
   * guard watches — and the bill is carried by the operator, not by the Organisation.
   * The guard of this controller is `SessionGuard → SuperadminGuard`,
   * the same as when deleting an Organisation.
   *
   * **No membership, no `TenantScopeGuard`**, for the same reason as
   * {@link remove}: it is Verwaltung, and nothing fachlich of the Organisation is
   * read or handed back in the process — only a number the operator
   * sets anyway.
   *
   * The number itself is checked by the schema (`aiQuotaWriteSchema`): whole, not
   * negative, at most {@link AI_MONTHLY_CALL_LIMIT_MAX}. `0` is valid and
   * means „für diese Organisation abgeschaltet" — not „unbegrenzt".
   *
   * **A lowered quota does not undo calls already spent**:
   * `used` stays where it is, `aiQuotaRemaining` falls to 0, and the next
   * call gets the 429. That is the intended direction — the alternative
   * would be that a lowering resets the counter and thereby allows *more*
   * calls than before.
   *
   * Logged like the deletion, and for the same reason: who gave which budget to
   * which Organisation and when is a fact about the installation that
   * the overwritten column no longer carries.
   */
  async setAiQuota(
    id: string,
    request: AiQuotaWrite,
    actorId: string,
  ): Promise<void> {
    requireTenantId(id);
    if (
      !(await this.repository.setAiMonthlyCallLimit(
        id,
        request.monthlyCallLimit,
      ))
    ) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    this.logger.log(
      `tenant ${id} ai quota set to ${String(request.monthlyCallLimit)} (user ${actorId})`,
    );
  }

  /**
   * „+ Neue Organisation" — the organisation, its three groups and its first administrator.
   *
   * There is no uniqueness check in front of the transaction, and that is
   * deliberate rather than missing: a check outside the write is a window, and
   * `tenant.short_name` and `user.email` are `@unique` underneath anyway. Two
   * superadmins racing therefore land on PostgreSQL's index and one of them
   * gets the 409 below — not a duplicated row. What the caller gains from
   * {@link uniquenessConflict} is a message naming the field instead of a
   * constraint violation.
   *
   * ## The first administrator is **invited** (ADR-0024)
   *
   * There is no password field any more. The invitation is built **before** the
   * transaction and handed in; whether it is needed at all is decided
   * only by the write, because an address that already has an account is
   * linked and not created — that account knows its password and needs
   * no invitation.
   *
   * What is handed in is the **whole `InvitationPlan`** — including the one that
   * means „it cannot be done" (no mail server of the instance, no base address), and
   * exactly for that reason no `null`: the refusal carries its own sentence, and the
   * transaction only speaks it out once it would actually have to create an
   * account (`AdminRepository`, `admin.invitation.kind !== 'ready'`). `null`
   * stands at a wholly different place and means something else: it is the
   * result for a **linked** account, for which no mail goes out. Pulling the check forward to here would be the convenient variant and
   * would forbid creating an Organisation even when no mail
   * would go out at all — with `admin: null`, say, the case in which a
   * superadministrator enters themselves.
   *
   * ## „Mich selbst als ersten Administrator eintragen" (review finding 7)
   *
   * `admin: null` means **the account of this session**, and `actorId` is the
   * only place this id comes from: the guard resolved it
   * before this method runs. A field in the request body that names an
   * account does not exist and shall not exist — it would be the way to make a
   * stranger the administrator of an Organisation without them
   * ever learning of it. That an id *from the session* stands here is
   * therefore no detail of convenience but the permission rule itself.
   *
   * The way via one's own address as a *typed* address existed before
   * (`AdminRepository.createTenant` links an existing account), but it
   * demanded the name and password of an account that has long existed — both without
   * effect, and the mask did not say so.
   */
  async create(
    request: TenantCreate,
    actorId: string,
  ): Promise<TenantOverviewRow> {
    const created = await this.repository
      .createTenant({
        shortName: request.shortName,
        name: request.name,
        admin:
          request.admin === null
            ? { userId: actorId }
            : {
                email: request.admin.email,
                name: request.admin.name,
                invitation: await this.plannedInvitation(
                  request.admin.name,
                  request.name,
                ),
              },
      })
      .catch((cause: unknown) => {
        throw uniquenessConflict(cause);
      });

    this.logger.log(
      `tenant ${created.id} created (user ${actorId}${
        request.admin === null ? ', as its first administrator' : ''
      })`,
    );

    return this.find(created.id);
  }

  /**
   * The invitation of the first administrator — or the refusal why there
   * can be none (ADR-0024).
   *
   * The refusal is **not** thrown **here** but handed in: the
   * transaction only refuses once it would actually have to create an account.
   * An address that already has one is linked, and that needs
   * no mail. The whole plan travels along, so that the refusal keeps its **own**
   * sentence instead of melting both into one.
   *
   * The name of the Organisation comes out of the **request** and not out of the
   * freshly written row: that does not exist at this point yet, and
   * it is the same value — `tenantCreateSchema.name` is exactly what will stand
   * in `tenant.name` in a moment.
   */
  private plannedInvitation(
    personName: string,
    tenantName: string,
  ): Promise<InvitationPlan> {
    return this.invitations.plan({
      // Always local: a freshly created Organisation has SSO off and no
      // provider that could claim an account (`tenantCreateSchema`).
      accountKind: 'local',
      personName,
      tenantName,
    });
  }
}

/**
 * A path segment that is not a uuid is „diese Organisation gibt es nicht", not a 500.
 *
 * `tenant.id` is a PostgreSQL `uuid`, so a malformed literal makes the driver
 * raise and the route answer 500 — a reply that differs from the 404 every
 * unknown id gets, and therefore something a caller can read a fact out of.
 * `OidcTenantsService.findById` guards the same column for the same reason.
 *
 * It has a second, blunter job here: `GET /api/admin/tenants/deleted` and
 * `GET /api/admin/tenants/:tenantId` share a prefix, and route order is what
 * keeps the literal segment from reaching {@link AdminService.find}. Order is
 * the fix; this is the floor under it, so a reordering fails as a 404 in a test
 * rather than as a 500 in an installation.
 */
function requireTenantId(id: string): void {
  if (!isUuid(id)) {
    throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
  }
}

/** One organisation of the „Gelöschte Organisationen" section. */
function toDeletedRow(tenant: DeletedOverviewTenant): {
  tenant: TenantOverviewRow['tenant'];
  deletedAt: string;
} {
  // The delivery gate, exactly as the live rows take it:
  // a deleted organisation's colours end up in the same CSS custom properties as
  // everybody else's, and „gelöscht" is no reason to hand on a value that
  // reached the column past the API.
  const { logoRef, branding } = deliverableBranding(
    tenant,
    ownedLogoRef(tenant),
  );
  return {
    tenant: {
      id: tenant.id,
      shortName: tenant.shortName,
      name: tenant.name,
      logoRef,
      branding,
    },
    // Non-null by the `where` of `findDeleted` — the row is only in this list
    // because `deleted_at IS NOT NULL`. Prisma types the column nullable
    // regardless, so the fallback is unreachable rather than a default.
    deletedAt: (tenant.deletedAt ?? new Date(0)).toISOString(),
  };
}

/**
 * A unique-constraint violation as the message it deserves, everything else
 * unchanged (`translateConcurrency` for the one other failure that is not a
 * defect).
 *
 * The cause is recognised by its Prisma class and code, never by its message
 * text: a service that turned *every* failure into „Kurzname vergeben" would
 * answer a broken database with a form validation error, and one that matched
 * on a string would start doing so the first time Prisma reworded itself.
 */
function uniquenessConflict(cause: unknown): unknown {
  if (
    !(cause instanceof Prisma.PrismaClientKnownRequestError) ||
    cause.code !== 'P2002'
  ) {
    return translateConcurrency(cause);
  }
  return new ConflictException(
    namesEmail(cause.meta)
      ? ADMIN_EMAIL_TAKEN_MESSAGE
      : SHORT_NAME_TAKEN_MESSAGE,
  );
}

/**
 * Whether a `P2002` is about `user.email` rather than about `tenant.short_name`.
 *
 * The whole `meta` is searched rather than one field of it, because the shape
 * is not one: with the pg driver adapter Prisma reports
 * `{ modelName, driverAdapterError: { cause: { constraint: { fields } } } }`,
 * while the classic engine reports `{ target }`. Reading either field by name
 * would work today and fail silently on the next Prisma release — silently,
 * because the fallback below is a *plausible* message rather than an error.
 *
 * Only two unique indexes can be hit by {@link AdminRepository.createTenant},
 * so „does not mention the address" means „the Kurzname" — including the case
 * where Prisma reports nothing usable at all. The alternative there is a 500
 * about a situation the person filling the form can fix in one keystroke.
 */
function namesEmail(meta: unknown): boolean {
  if (meta === undefined) {
    return false;
  }
  return JSON.stringify(meta).includes('email');
}

/**
 * One organisation as the table shows it.
 *
 * **The branding passes the delivery gate** , exactly as
 * the session payload and the public page do: a colour ends up in a CSS custom
 * property, and a value that reached the column past the API — by hand, by a
 * restore — must not be handed on. A missing count is 0 rather than absent: a
 * Organisation with no forms has none, and `groupBy` simply has no row for it.
 */
function toRow(
  tenant: OverviewTenant,
  forms: CountsByTenant,
  responses: CountsByTenant,
  users: CountsByTenant,
): TenantOverviewRow {
  // Per row, with that row's own Logo files (ADR-0014 no. 12, shore 4).
  const { logoRef, branding } = deliverableBranding(
    tenant,
    ownedLogoRef(tenant),
  );
  return {
    tenant: {
      id: tenant.id,
      shortName: tenant.shortName,
      name: tenant.name,
      // The gate's own answer (ADR-0014 no. 12). This shore reads **across**
      // Organisationen, so the relation is loaded per row rather than resolved once for
      // the viewer — otherwise „eigenes Logo" would mean the superadmin's.
      logoRef,
      branding,
    },
    forms: forms.get(tenant.id) ?? 0,
    responses: responses.get(tenant.id) ?? 0,
    users: users.get(tenant.id) ?? 0,
    oidcEnabled: tenant.oidcEnabled,
    aiMonthlyCallLimit: tenant.aiMonthlyCallLimit,
  };
}

function sumOf(
  rows: readonly TenantOverviewRow[],
  of: (row: TenantOverviewRow) => number,
): number {
  return rows.reduce((total, row) => total + of(row), 0);
}
