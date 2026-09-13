import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_OIDC_SCOPES,
  parseOidcConfig,
  type ApiEnv,
  type OidcConfig,
  type OidcConfigWrite,
} from '@formsache/shared';

import { PublicUrlService } from '../common/public-url/public-url.service';
import { API_ENV } from '../config/env';
import type { TenantScope } from '../tenancy/tenant-scope';
import { acceptableIssuer, issuerAllowList } from './oidc-issuer';
import { OidcSecretsService } from './oidc-secrets.service';

/** The answer when the organisation behind an active session has disappeared. */
export const TENANT_NOT_FOUND_MESSAGE =
  'Die Organisation wurde nicht gefunden.';

/** What a refused issuer is told — the field, not the value. */
export const BAD_ISSUER_MESSAGE =
  'Der Issuer muss eine https-Adresse ohne Anmeldedaten, Query und Fragment sein.';

/** What switching SSO on without a usable secret is told (fail closed). */
export const MISSING_CLIENT_SECRET_MESSAGE =
  'Ohne gespeichertes Client-Secret kann SSO nicht aktiviert werden.';

/**
 * What the caller is told when the stored block does not match the contract.
 *
 * Without detail, exactly as `UNREADABLE_SETTINGS_MESSAGE`: whoever sees it is
 * an administrator, not an attacker, and the reason belongs in the log next to
 * the tenant it happened to.
 */
export const UNREADABLE_OIDC_MESSAGE =
  'Die gespeicherte OIDC-Konfiguration konnte nicht gelesen werden.';

/**
 * The `tenant` columns this service reads — nothing else of the row.
 *
 * Its own interface rather than Prisma's `Tenant`, so the login route can hand in
 * the row it fetched on the login path (where there is no session and therefore
 * no `TenantScope`) without this service growing a database of its own.
 */
export interface TenantOidcRow {
  readonly id: string;
  readonly oidcEnabled: boolean;
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  /** Prisma's `Bytes`, spelled out — see `OidcWrite` in `tenant-scope.ts`. */
  readonly oidcClientSecret: Uint8Array<ArrayBuffer> | null;
  readonly oidcScopes: readonly string[];
  /** Which claim of the ID token carries the address. */
  readonly oidcEmailClaim: string;
  /** Which claim vouches for it — `''` means „ohne Gegenprüfung". */
  readonly oidcEmailVerifiedClaim: string;
  readonly oidcButtonLabel: string | null;
}

/**
 * Everything the login route needs, or nothing at all.
 *
 * A single object rather than the six fields separately, because „SSO ist für
 * diese Organisation benutzbar" is one decision and must not be re-assembled by each
 * caller out of parts that individually look fine.
 */
export interface OidcSignIn {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /**
   * The claim the address is read from, and the claim that vouches for it
   * . Carried on this object rather than looked up again in the
   * provider service, for the reason this interface exists at all: „so meldet
   * dieser Organisation an" is one decision, and re-assembling it per caller is how two
   * callers come to read two different tokens.
   *
   * `emailVerifiedClaim` is `''` when this organisation has switched the counter-check
   * off; what that costs is written out, in as many words, on
   * the field that offers it.
   */
  readonly emailClaim: string;
  readonly emailVerifiedClaim: string;
  readonly buttonLabel: string | null;
  readonly redirectUri: string;
}

/**
 * The OIDC configuration of one organisation (handoff).
 *
 * **No `PrismaService` in the constructor**, like every other domain service
 * here: the only way to the row is the `TenantScope` the guard chain hands in,
 * and that scope has no way to name a *different* Organisation at all — which is why
 * „die Konfiguration einer fremden Organisation ist weder les- noch schreibbar" is
 * structural rather than checked (`CONTRIBUTING.md`, and the same
 * argument `TenantSettingsController` makes for the form standards).
 *
 * **What „gesetzt" means is decided here, not by a schema.** `clientSecretSet`
 * is `OidcSecretsService.isUsable`, so bytes that do not open in *this* Organisation
 * count as not stored — and SSO cannot be switched on against them. That is the
 * fail-closed half of the requirement: a secret carried into another
 * organisation's column by a raw write makes that organisation's login unavailable and visibly
 * unconfigured, instead of quietly signing people in with a foreign secret.
 */
@Injectable()
export class OidcConfigService {
  private readonly logger = new Logger(OidcConfigService.name);

  /** Bounded by the number of broken rows, not by traffic — see the service. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly secrets: OidcSecretsService,
    private readonly publicUrl: PublicUrlService,
    /**
     * The allow list of the operation (a review finding). Read here and passed
     * on to both gates, so that „which hosts may the server call" has **one**
     * answer instead of one per call site.
     */
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** The allow list, the way {@link acceptableIssuer} expects it. */
  private get allowList(): string[] {
    return issuerAllowList(this.env.OIDC_ISSUER_ALLOWLIST);
  }

  /** The block as the *Erscheinungsbild & Login* tab reads it. */
  async ofTenant(scope: TenantScope): Promise<OidcConfig> {
    return await this.toConfig(await this.requireTenant(scope));
  }

  /**
   * Replaces the block.
   *
   * The order is deliberate: the resulting secret is determined **first**, and
   * only then is „darf SSO an sein?" asked about it. Asking first and sealing
   * afterwards would answer the question about the *stored* value while the
   * request replaces it — the case where an administrator repairs a broken
   * secret and switches SSO on in the same save, which has to work.
   */
  async replaceOfTenant(
    scope: TenantScope,
    request: OidcConfigWrite,
  ): Promise<OidcConfig> {
    const tenant = await this.requireTenant(scope);
    const issuer = this.checkedIssuer(request.issuer);
    const clientSecret = this.nextSecret(
      request.clientSecret,
      tenant.oidcClientSecret,
      scope.tenantId,
    );

    // *Fail closed*, and the half the shared schema deliberately leaves open:
    // whether a secret is **stored** is server state a request document cannot
    // see, so `oidcConfigWriteSchema` checks issuer, client id and the `openid`
    // scope and stops there. This is the rest of it.
    if (
      request.enabled &&
      !this.secrets.isUsable(clientSecret, scope.tenantId)
    ) {
      throw fieldError('clientSecret', MISSING_CLIENT_SECRET_MESSAGE);
    }

    const result = await scope.tenant.updateOidc({
      oidcEnabled: request.enabled,
      oidcIssuer: issuer,
      oidcClientId: request.clientId,
      oidcScopes: request.scopes,
      oidcEmailClaim: request.emailClaim,
      oidcEmailVerifiedClaim: request.emailVerifiedClaim,
      oidcButtonLabel: request.buttonLabel,
      oidcClientSecret: clientSecret,
    });
    if (!result.written) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    // `issuer !== null` is not a second condition but the compiler's share of the
    // first: a `null` issuer re-stamps nothing (see `updateOidc`), so a count
    // above zero already means there is one — and the template below prints a
    // string rather than the word „null".
    if (result.restamped > 0 && issuer !== null) {
      /*
       * **The one thing about this save that nobody would otherwise see**
       * (Review-Runde 5 no. 3). Changing the issuer re-stamps the open SSO
       * invitations of this organisation, because they would otherwise be
       * unredeemable from here on (`ScopedTenantDelegate.updateOidc` says why).
       * That is a write on *accounts* triggered by a save on the *login*
       * configuration, and an operator reading the log of a support case has to
       * be able to find it — the counter-piece to the „found no redeemable
       * invitation" warning of `OidcIdentityService`, which is what the missing
       * re-stamp used to produce.
       *
       * The number, the organisation and the new issuer — **no address and no
       * name**. Which people were invited is not what makes this line
       * actionable, and it is the sort of value this module keeps out of the log
       * everywhere else.
       */
      this.logger.log(
        `Issuer of tenant ${scope.tenantId} changed to ${issuer}; re-stamped ${String(result.restamped)} open SSO invitation(s) onto it.`,
      );
    }

    return await this.toConfig({
      id: scope.tenantId,
      oidcEnabled: request.enabled,
      oidcIssuer: issuer,
      oidcClientId: request.clientId,
      oidcClientSecret: clientSecret,
      oidcScopes: request.scopes,
      oidcEmailClaim: request.emailClaim,
      oidcEmailVerifiedClaim: request.emailVerifiedClaim,
      oidcButtonLabel: request.buttonLabel,
    });
  }

  /**
   * What the login route signs people in with — **or `null`, meaning „dieser Organisation
   * bietet SSO nicht an"**.
   *
   * The two outcomes are different facts and are kept apart on purpose:
   *
   * - `null` is an organisation that is switched off or not finished configuring. Nothing
   *   is wrong, the button is simply absent, and what is required is absent
   *   **and** locked — so this is also what the callback route consults when it
   *   is called directly.
   * - A **throw** (from {@link OidcSecretsService.open}) is an organisation whose stored
   *   secret does not open here. That is not „nicht eingerichtet"; it is a value
   *   somebody put there, and continuing — with it or without it — is the fail
   *   open the requirement forbids.
   */
  async signIn(tenant: TenantOidcRow): Promise<OidcSignIn | null> {
    if (!tenant.oidcEnabled) {
      return null;
    }
    const issuer =
      tenant.oidcIssuer === null
        ? null
        : acceptableIssuer(tenant.oidcIssuer, this.allowList);
    if (
      issuer === null ||
      tenant.oidcClientId === null ||
      tenant.oidcClientSecret === null ||
      !tenant.oidcScopes.includes('openid')
    ) {
      return null;
    }
    return {
      issuer,
      clientId: tenant.oidcClientId,
      clientSecret: this.secrets.open(tenant.oidcClientSecret, tenant.id),
      scopes: tenant.oidcScopes,
      // Straight out of the column, **not** through a `?? DEFAULT`. The column
      // is `NOT NULL` with the shipped defaults, so there is no third state to
      // repair here — and a fallback would quietly re-enable the counter-check
      // for an organisation that switched it off, which is the one direction a default
      // must never take.
      emailClaim: tenant.oidcEmailClaim,
      emailVerifiedClaim: tenant.oidcEmailVerifiedClaim,
      buttonLabel: tenant.oidcButtonLabel,
      redirectUri: await this.publicUrl.oidcCallbackUrl(),
    };
  }

  /**
   * The stored block as the wire contract describes it — **and parsed against
   * that contract before it leaves.**
   *
   * `parseOidcConfig` is the second gate. The columns are plain `text` and
   * `text[]`; nothing stops a hand-edited row from holding a scope with a space
   * in it, which would become a second parameter in the authorisation request
   * the login route builds. Refusing is the same posture `SettingsSecretsService`
   * takes for a document that does not parse: a value somebody put there and we
   * cannot read is not something to paper over. The `PUT` stays reachable, so
   * the tab can still repair it.
   */
  private async toConfig(tenant: TenantOidcRow): Promise<OidcConfig> {
    const raw = tenant.oidcIssuer;
    const issuer = raw === null ? null : acceptableIssuer(raw, this.allowList);
    if (raw !== null && issuer === null) {
      // Gate two of the requirement's shape, applied to the issuer: a value that
      // never passed gate one because it was written straight into the column
      // is refused on the way out as well — reported as „nicht konfiguriert",
      // which is the fail-closed reading and the repairable one. The value is
      // not logged; it is foreign input, and the tenant id is what makes the
      // line actionable.
      this.reportOnce(
        `Stored OIDC issuer of tenant ${tenant.id} is not an acceptable discovery base; reporting it as unset.`,
      );
    }
    // Read **before** the `try` below, deliberately (a review finding).
    // `oidcCallbackUrl` is a database read and throws its own
    // `PublicBaseUrlMissingError` (a 503) when the installation has no base
    // address — a state the `catch` below must never see. Inside the `try` it
    // was swallowed and reported as „Stored OIDC configuration … does not
    // match the wire contract", which names the wrong cause and, worse,
    // reports it exactly once per process (`reportOnce`): every tenant behind
    // it stayed silently misdiagnosed for the rest of the process's life.
    const redirectUri = await this.publicUrl.oidcCallbackUrl();
    try {
      return parseOidcConfig({
        enabled: tenant.oidcEnabled,
        issuer,
        clientId: tenant.oidcClientId,
        // An **empty** column is „nichts entschieden", not „keine Scopes", and
        // reads as the shipped default — the same shape a missing settings key
        // has. It is a display default and nothing else: {@link signIn} asks the
        // stored array whether it contains `openid`, so an organisation that has never
        // saved this tab cannot sign anybody in on the strength of what the tab
        // *showed* it.
        scopes:
          tenant.oidcScopes.length === 0
            ? [...DEFAULT_OIDC_SCOPES]
            : tenant.oidcScopes,
        // **No display default beside these two, unlike `scopes` above.** An
        // empty `oidc_scopes` array is „nichts entschieden"; an empty
        // `oidc_email_verified_claim` is a decision, and showing
        // it as `email_verified` would put a check on the page that the login
        // does not make. The column carries the shipped defaults itself.
        emailClaim: tenant.oidcEmailClaim,
        emailVerifiedClaim: tenant.oidcEmailVerifiedClaim,
        buttonLabel: tenant.oidcButtonLabel,
        clientSecretSet: this.secrets.isUsable(
          tenant.oidcClientSecret,
          tenant.id,
        ),
        redirectUri,
      });
    } catch {
      // The `ZodError` is dropped rather than passed on: its issues quote the
      // offending values, and those values came out of a column.
      this.reportOnce(
        `Stored OIDC configuration of tenant ${tenant.id} does not match the wire contract.`,
      );
      throw new InternalServerErrorException(UNREADABLE_OIDC_MESSAGE);
    }
  }

  /** The issuer of a request, normalised — or a 400 naming the field. */
  private checkedIssuer(raw: string | null): string | null {
    if (raw === null) {
      return null;
    }
    const issuer = acceptableIssuer(raw, this.allowList);
    if (issuer === null) {
      throw fieldError('issuer', BAD_ISSUER_MESSAGE);
    }
    return issuer;
  }

  /**
   * The three states of `clientSecret`, resolved once.
   *
   * `undefined` — the field was not sent — means „lass das gespeicherte
   * Geheimnis stehen", and it is the ordinary case: the page never held the
   * secret, so it cannot send it back (`oidcConfigWriteSchema`). `null` removes
   * it, a string replaces it.
   */
  private nextSecret(
    requested: string | null | undefined,
    stored: Uint8Array<ArrayBuffer> | null,
    tenantId: string,
  ): Uint8Array<ArrayBuffer> | null {
    if (requested === undefined) {
      return stored;
    }
    if (requested === null) {
      return null;
    }
    return this.secrets.seal(requested, tenantId);
  }

  private async requireTenant(scope: TenantScope): Promise<TenantOidcRow> {
    const tenant = await scope.tenant.find();
    if (tenant === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return tenant;
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}

/**
 * A 400 in the shape `parseRequest` produces, so the tab can put the message
 * next to the field regardless of whether the schema or the server refused.
 */
function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({
    message: 'Die Anfrage ist ungültig.',
    issues: [{ path, message }],
  });
}
