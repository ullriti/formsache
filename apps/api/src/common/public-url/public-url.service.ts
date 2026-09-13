import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  normaliseBaseUrl,
  responseDraftPath,
  responseEditPath,
} from '@formsache/shared';

import { SystemMailSettingsService } from '../../system-settings/system-mail-settings.service';
import { TenantBaseUrlRepository } from './tenant-base-url.repository';

/**
 * Where an identity provider sends a member back after they signed in
 * (the requirements).
 *
 * **Spelled once, here, because two places need the same string and neither
 * may guess it.** One shows it in the tenant administration so it can be
 * pasted into the IdP; the other mounts the callback route on it. A provider
 * compares `redirect_uri` byte for byte against what it has registered, so a
 * second spelling would not be a wrong link — it would be every login of every
 * Organisation failing at the provider, with an error message that names neither file.
 *
 * **It carries no organisation.** Which Organisation a callback belongs to travels in `state`,
 * which has to be checked anyway; a tenant in the path would be a
 * request-supplied segment in the one address that must not be
 * request-supplied, and it would force every organisation to register a different URI.
 *
 * The `/api` prefix is `GLOBAL_API_PREFIX` from `app.module.ts` and is repeated
 * rather than imported: importing it here would close a cycle through the
 * module that imports everything. A test pins the two together
 * (`test/tenant-admin/oidc-config.spec.ts`), so the repetition cannot drift.
 */
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

/**
 * The one place the server turns a path into an **absolute** address.
 *
 * ## Why this exists at all
 *
 * Every public URL of this application used to be assembled in the browser out
 * of `window.location.origin` (`BuilderView.tsx`). That is correct wherever it
 * is done — the browser is standing on the address — and it is unavailable in
 * the two places it is needed: the answer to a submission, which the
 * API builds, and a mail, which has no browser at all
 * (`umsetzungsplan-m2-etappe-c.md`).
 *
 * So the server has to know its own address, and it is told rather than allowed
 * to guess. **Not from the request**, which is the tempting shortcut and the
 * wrong one: `Host` and `X-Forwarded-Host` are written by the caller, so a link
 * built from them is a link an outsider chooses — and this link ends up in mail
 * to a whole organisation, where it cannot be recalled. The base address is
 * configuration, and configuration is not attacker-supplied.
 *
 * ## Why a named function and not string concatenation at the call site
 *
 * Two call sites already exist (`PublicFormsService.submit` and its edit
 * counterpart) and a third arrived later. Three concatenations are three
 * chances to forget the slash, to forget `encodeURIComponent`, or to keep the
 * old path after the route is renamed — and the failure mode of the last one is
 * a dead link in somebody's inbox rather than a red test.
 *
 * ## Why every method is asynchronous
 *
 * The address moved from `PUBLIC_BASE_URL` into `system_setting.public_base_url`
 * , and an organisation may override it for its own
 * forms. Both are reads, so „wo antworten wir?" is a query and no longer a
 * constructor argument. Nothing else about the argument changes: it is still
 * configuration, and configuration is still not attacker-supplied.
 *
 * ## The chain, and where it does and does not apply
 *
 * `resolveBaseUrl(tenantId)` is the primitive: an organisation's own address, then the
 * installation's, then `null` — nothing fachlich, so a second consumer can
 * reuse it without re-deriving the chain. {@link responseEditUrl} is built on
 * it, because an edit link is a promise about *this organisation's* form.
 *
 * `oidcCallbackUrl` and `appUrl` are **not**: `OIDC_CALLBACK_PATH` „carries no
 * Organisation" (see its own comment) — one provider registration per installation,
 * whichever Organisation started the login — so both stay on the installation's own
 * address only. Reading them from a tenant here would make an organisation's redirect
 * URI depend on which form happened to be open, which is not a chain, it is a
 * guess with extra steps.
 */
/**
 * What {@link PublicBaseUrlMissingError} tells whoever is looking — German,
 * because it can reach an unauthenticated route, and free of column names for
 * the same reason (`CONTRIBUTING.md`: no internal detail in an outward-facing
 * error).
 */
export const PUBLIC_BASE_URL_MISSING_MESSAGE =
  'Diese Installation hat noch keine Basis-Adresse hinterlegt; bitte später erneut versuchen.';

@Injectable()
export class PublicUrlService {
  private readonly logger = new Logger(PublicUrlService.name);

  /**
   * One line per **Organisation** with an unreadable override, not by traffic — see
   * {@link resolveBaseUrl} (a review finding). Keyed by `tenantId`, not by the
   * message text: unlike `SystemMailSettingsService.publicBaseUrl`, which has
   * exactly one row to ever be wrong about, this method is called once per
   * request for an organisation whose own column does not parse, and the same organisation
   * must not fill the log a second time just because the message is
   * generic.
   */
  private readonly reportedTenants = new Set<string>();

  constructor(
    private readonly systemSettings: SystemMailSettingsService,
    private readonly tenantBaseUrls: TenantBaseUrlRepository,
  ) {}

  /**
   * The base address a given Organisation answers under: its own
   * address if it has set one, the installation's otherwise, `null` if
   * neither exists.
   *
   * **The whole of the chain, and nothing else.** No caller may skip a step —
   * reading the system row directly loses an organisation's override, and there
   * is no session or `Host` anywhere in this signature to read
   * by mistake. `tenantId` is the *form's* Organisation; every caller in this
   * application already has it from a row it resolved by slug or primary key,
   * never from a request parameter this method itself trusts.
   *
   * Both values are normalised on the way out — `tenant.public_base_url` and
   * `system_setting.public_base_url` are both plain `text`, and a value can
   * reach either column past the API (a hand-written row, an old migration).
   * A stored value that does not parse as a base address is treated exactly
   * like an absent one: the chain falls through, and the fail-closed reading
   * is „kein Link" rather than a link built from a string nobody validated.
   *
   * **The organisation's own column is reported when it fails to parse — the system
   * column already was (`SystemMailSettingsService.publicBaseUrl`); this one
   * was not, until a review found it.** Falling through silently is the right
   * *answer* — a guessed address must never leave the server — but an organisation
   * whose override never worked would otherwise send every mail under the
   * installation's own address forever, with nothing distinguishing that from
   * the organisation simply never having set one. The value itself is still not
   * logged, for the same reason the system column's is not: it is foreign
   * input a hand-written row or an old migration can put anything into.
   * `tenantId` is what makes the line actionable instead.
   */
  async resolveBaseUrl(tenantId: string): Promise<string | null> {
    const own = await this.tenantBaseUrls.findOwn(tenantId);
    if (own !== null) {
      const normalised = normaliseBaseUrl(own);
      if (normalised !== null) {
        return normalised;
      }
      this.reportUnusableTenantAddress(tenantId);
    }
    return this.systemSettings.publicBaseUrl();
  }

  /**
   * Where a participant changes their own answer — or `null`
   * when neither this organisation nor the installation has been told an address.
   *
   * **`null` rather than a guess, and the callers have to carry it.** The
   * mechanics exist since the freeze of the mail body: `{{bearbeiten}}`
   * resolves to nothing and the surrounding text stays (`renderEditLink`), and
   * the confirmation answer carries `editUrl: null`. A base address invented
   * here would go out by post to a whole organisation and be dead on arrival, which is
   * not something an application gets to retract.
   *
   * `tenantId` is the form's own Organisation — never the caller's session, which the
   * mail worker does not even have (the requirement's second reproduction).
   *
   * The path itself comes from `@formsache/shared`, where the browser's router reads
   * it too — a second spelling here would be a link that stops matching the
   * route the day somebody renames it.
   */
  async responseEditUrl(
    tenantId: string,
    editToken: string,
  ): Promise<string | null> {
    const base = await this.resolveBaseUrl(tenantId);
    return base === null ? null : `${base}${responseEditPath(editToken)}`;
  }

  /**
   * Where a participant continues their own half-filled form
   * — or `null` when neither this organisation nor the installation has been told an
   * address.
   *
   * The same chain and the same `null` as {@link responseEditUrl}, with one
   * difference in what the `null` costs: an edit link that cannot be built
   * leaves a *stored answer* the organisation already has, while a draft address that
   * cannot be built leaves a draft nobody can reach. Guessing an origin is still
   * not the answer — this address is shown to a participant who copies it, and a
   * copied address that points at the wrong host is not something an application
   * gets to retract. What the caller does with the `null` is
   * written down at `PublicFormsService.draftUrlOrNull`.
   *
   * `tenantId` is the form's own Organisation, from the row the slug or the token
   * resolved to — never a session and never the request's `Host`.
   */
  async responseDraftUrl(
    tenantId: string,
    draftToken: string,
  ): Promise<string | null> {
    const base = await this.resolveBaseUrl(tenantId);
    return base === null ? null : `${base}${responseDraftPath(draftToken)}`;
  }

  /**
   * The base address of the **installation**, without the chain over the
   * organisation — and `null` when none is stored (ADR-0020).
   *
   * ## What it exists for
   *
   * {@link resolveBaseUrl} answers „wo antwortet **diese Organisation**?", and
   * for an edit link that is right. For a **reset link** it is a privilege
   * escalation: `tenant.public_base_url` is set by whoever holds
   * `can_manage_settings` (`tenant-base-url.controller.ts`), and `baseUrlSchema`
   * accepts every absolute http(s) address without an allow-list. Whoever sets
   * it to a host of their own and then requests „Passwort vergessen" for a
   * foreign account gets a real, correctly worded mail to the victim whose only
   * link points at them — one click hands over the token.
   *
   * ADR-0020 expressly keeps `can_manage_settings` away from this account; over
   * the wire the boundary did not stand until here.
   *
   * ## Why `null` and not the 503 of {@link appUrl}
   *
   * The caller is the dispatch, not a request: it has nobody it could owe a
   * status code to. What it does with the `null` stands in
   * `QueuedBodyRenderer` — the delivery fails readably instead of letting a
   * reset mail out without a link.
   *
   * The same reasoning {@link oidcCallbackUrl} and {@link appUrl} already
   * carry: "an address that concerns the installation does not hang on an
   * organisation."
   */
  async installationBaseUrl(): Promise<string | null> {
    return this.systemSettings.publicBaseUrl();
  }

  /**
   * The `redirect_uri` of the OIDC login.
   *
   * **Server-decided, and there is no field in which to send one.** The write
   * schema of the tenant administration has no `redirectUri`
   * (`oidcConfigWriteSchema` in `@formsache/shared`); the read schema has one, and it
   * is this. Taking the address from a request would turn the login into an
   * open redirector — the third reproduction of the requirement.
   *
   * **On the installation's own address only — never an organisation's override.**
   * `OIDC_CALLBACK_PATH` carries no organisation (see its own comment); the same
   * physical route answers for every provider registration, so it has to
   * stay at one fixed origin regardless of which organisation's login is in progress.
   *
   * **Throws (503) when the installation has no address**, where the edit
   * link answers `null`, and the difference is what the two are for: a mail
   * without a link is still a mail, while an OIDC login without a
   * `redirect_uri` is a login that cannot exist. Refusing is the honest
   * answer, and the repair — put the address into the Systemeinstellungen —
   * is the same one either way. A 503 rather than the 500 an ordinary `Error`
   * would answer with (a review finding): a fresh installation that has
   * not reached the Systemeinstellungen yet is „noch nicht eingerichtet", not
   * „kaputt", and both the login's own routes and the tenant administration's
   * config read (`oidc-config.service.ts`) reach this through nothing more
   * than the `await` — an `HttpException` needs no call site to translate it.
   */
  async oidcCallbackUrl(): Promise<string> {
    return `${await this.requiredSystemBase()}${OIDC_CALLBACK_PATH}`;
  }

  /**
   * Back into the browser application — where the OIDC callback sends someone
   * once it is done with them.
   *
   * **The one redirect target of this application that is not a link in a mail,
   * and the one that must not be a caller's choice.** It is built from the
   * configured base address exactly like every other absolute address here,
   * which is what keeps the callback from becoming an open redirector: there is
   * no `next=` parameter to honour, so there is nothing to smuggle a foreign
   * origin through. The argument is a fixed path plus, at most, the query string
   * the server itself composed from a closed set of outcome codes
   * (`oidcOutcomeSchema` in `@formsache/shared`).
   *
   * On the installation's own address only, for the same reason
   * {@link oidcCallbackUrl} is: this is the browser landing back from the
   * *provider*, not from an organisation's form.
   */
  async appUrl(path: string): Promise<string> {
    if (!path.startsWith('/')) {
      throw new Error(`app path must start with a slash: ${path}`);
    }
    return `${await this.requiredSystemBase()}${path}`;
  }

  /**
   * The installation's own address, required rather than optional — the two
   * OIDC-facing methods above have no path that tolerates `null`.
   */
  private async requiredSystemBase(): Promise<string> {
    const base = await this.systemSettings.publicBaseUrl();
    if (base === null) {
      throw new PublicBaseUrlMissingError();
    }
    return base;
  }

  /**
   * Writes „dieser Organisation hat eine Basis-Adresse, aber sie ist unbrauchbar"
   * once per organisation, never again for the same one (a review finding) — see
   * {@link reportedTenants} for why the key is `tenantId` rather than the
   * message.
   */
  private reportUnusableTenantAddress(tenantId: string): void {
    if (this.reportedTenants.has(tenantId)) {
      return;
    }
    this.reportedTenants.add(tenantId);
    this.logger.error(
      `tenant.public_base_url of tenant ${tenantId} is not an absolute ` +
        'http(s) base address; falling back to the system default.',
    );
  }
}

/**
 * What the two absolute addresses that cannot be omitted answer when the
 * installation has none — a 503, not a 500 (a review finding).
 *
 * An `HttpException` rather than a plain `Error`: Nest's default filter turns
 * an unrecognised `Error` into a 500, which reads as „kaputt" to whoever
 * opens the OIDC tab of a freshly set-up installation, when the honest answer
 * is „noch nicht eingerichtet" — repairable by the same step either way, and
 * the message says so without naming a column (this exception can reach an
 * unauthenticated route, `GET /auth/oidc/callback`).
 *
 * Still not a fallback: the only conceivable one is a guessed origin, and a
 * guessed origin in an OIDC `redirect_uri` is either a failed login (the
 * provider compares byte for byte) or, worse, a redirect somewhere nobody
 * intended.
 */
export class PublicBaseUrlMissingError extends ServiceUnavailableException {
  constructor() {
    super(PUBLIC_BASE_URL_MISSING_MESSAGE);
    this.name = 'PublicBaseUrlMissingError';
  }
}
