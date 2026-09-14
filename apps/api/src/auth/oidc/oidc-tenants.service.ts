import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { TenantOidcRow } from '../../tenant-admin/oidc-config.service';

/**
 * The `tenant` rows the **login** reads — the one place in this package that
 * touches the database without a `TenantScope`.
 *
 * That is not an exception being carved out, it is the same exception
 * `AuthService.login` already is: a scope is *derived* from a session, and
 * nobody has a session yet when they click „Mit Organisationskonto anmelden".
 * `OidcConfigService` was built for this — its {@link TenantOidcRow} interface
 * exists precisely so the login path can hand in the row it fetched itself
 * instead of that service growing a second way to the database.
 *
 * **What keeps it honest is what it selects.** Nine columns, named one by one:
 * the id plus the eight the OIDC configuration lives in — two of them the claim
 * names of Konzept no. 70 — plus, on the offer list, the two names it shows and
 * `public_base_url`, which is **only compared and never answered with**
 * ({@link findOfferable}). No `form_defaults`, no branding, no members — a
 * widening of this `select` is the only way an unauthenticated route here could
 * start reading an organisation's data, and it is a visible line in a diff.
 */
@Injectable()
export class OidcTenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Exactly the columns {@link OidcConfigService.signIn} consults. */
  private static readonly OIDC_COLUMNS = {
    id: true,
    oidcEnabled: true,
    oidcIssuer: true,
    oidcClientId: true,
    oidcClientSecret: true,
    oidcScopes: true,
    oidcEmailClaim: true,
    oidcEmailVerifiedClaim: true,
    oidcButtonLabel: true,
  } as const;

  /**
   * One organisation by id, or `null` — and `null` for an id that does not exist just
   * as much as for one that is not a uuid.
   *
   * The uuid guard is not cosmetic: `tenant.id` is a Postgres `uuid`, and a
   * malformed literal makes the driver raise an error the route would carry out
   * as a 500 — an answer that differs from „unbekannter Organisation" and therefore
   * tells a caller something about their input. Refused here, both cases look
   * the same from outside.
   */
  async findById(tenantId: string): Promise<TenantOidcRow | null> {
    if (!UUID.test(tenantId)) {
      return null;
    }
    // **Filter 3 of the six of the requirement — `tenant.deleted_at`**, the
    // other half of „Anmeldung". Filter 1 keeps a deleted Organisation out of the
    // membership list *after* somebody is signed in; this route runs **before**
    // anybody is, and it is the one place a stranger can name an organisation by id
    // without a session. Without the condition, „Mit Organisationskonto anmelden"
    // would still start a flow into a deleted Organisation and mint a session there —
    // the scope would be empty by filter 1, but the answer would differ from
    // an unknown id, and that difference is a probe.
    //
    // `findFirst`, because the condition is no longer the primary key alone.
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: OidcTenantsService.OIDC_COLUMNS,
    });
  }

  /**
   * Every organisation that has SSO switched on, with the two names the button needs.
   *
   * `oidcEnabled` is the only filter applied in the **query**; whether the
   * configuration is actually usable is `OidcConfigService.signIn`'s decision
   * and is made by the caller over these rows. Two reasons: „ist das Secret
   * lesbar?" is not expressible as a `where`, and duplicating half the rule
   * into SQL is how the offer list and the start route come to disagree about
   * which Organisationen offer SSO.
   */
  async findOfferable(): Promise<readonly OfferableTenant[]> {
    return this.prisma.tenant.findMany({
      // `deletedAt` beside `oidcEnabled` — filter 3 again, on the list this
      // time: a deleted Organisation offers no login button, or the Anmeldeseite would
      // advertise a way into something that is out of service.
      where: { oidcEnabled: true, deletedAt: null },
      select: {
        ...OidcTenantsService.OIDC_COLUMNS,
        name: true,
        shortName: true,
        // **The column that never leaves the server.** It is compared
        // against the host the request arrived under so the offer list can say
        // which organisation belongs to the address in the browser's bar
        // (`OidcProvider.atThisAddress`); what travels is that boolean, not the
        // address. Widening a select on this route is the visible line the
        // class doc asks for — this is that line, and the sentence above is
        // what keeps it narrow.
        publicBaseUrl: true,
      },
      // Stable order, so the login page does not reshuffle its buttons between
      // reloads — the same reason `membershipInclude` orders the switcher.
      orderBy: { shortName: 'asc' },
    });
  }
}

/** A row of {@link OidcTenantsService.findOfferable}. */
export interface OfferableTenant extends TenantOidcRow {
  readonly name: string;
  readonly shortName: string;
  /**
   * This organisation's own base address, or `null` for „die Systemvorgabe
   * gilt" — read **only** to be compared against the request's host, never to
   * be answered with. See the note at the `select` that fetches it.
   */
  readonly publicBaseUrl: string | null;
}

/** Canonical uuid form, as Postgres accepts it for a `uuid` column. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
