import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_OIDC_BUTTON_LABEL,
  type ApiEnv,
  type OidcOutcome,
  type OidcProvider,
} from '@formsache/shared';

import {
  OidcConfigService,
  type OidcSignIn,
  type TenantOidcRow,
} from '../../tenant-admin/oidc-config.service';
import {
  acceptableIssuer,
  issuerAllowList,
} from '../../tenant-admin/oidc-issuer';
import { API_ENV } from '../../config/env';
import {
  OidcClientSecretUnreadableError,
  OidcSecretsService,
} from '../../tenant-admin/oidc-secrets.service';
import { deriveActiveTenant } from '../auth.service';
import { SessionService } from '../session.service';
import { describeFailure, issuerScheme } from './oidc-diagnostics';
import { OidcIdentityService } from './oidc-identity.service';
import { OidcProviderService } from './oidc-provider.service';
import {
  OidcTenantsService,
  type OfferableTenant,
} from './oidc-tenants.service';
import {
  newOidcTransaction,
  stateMatches,
  stateParameter,
  type OidcTransaction,
} from './oidc-transaction';

/**
 * The OIDC login, end to end (ADR-0005 and ADR-0012).
 *
 * Three decisions live here and nowhere else:
 *
 * 1. **Whether an organisation offers SSO at all** — `OidcConfigService.signIn(row)`, and
 *    its two answers are kept strictly apart. `null` is „dieser Organisation bietet SSO
 *    nicht an"; a **throw** is „das gespeicherte Secret öffnet sich hier nicht",
 *    which is refused rather than degraded to „nicht eingerichtet" (*fail
 *    closed*). Asked on **every** route of this
 *    package, including the callback: „abwesend **und** verschlossen" is the
 *    whole of what the requirement asks for, and the offer list is the convenience half —
 *    which asks it **without a plaintext**, see {@link offers}.
 * 2. **Whether the callback belongs to the browser that started it** —
 *    {@link stateMatches} against the transaction cookie.
 * 3. **What a signed-in person without an organisation gets** — see {@link finish}.
 *
 * ## The asymmetry, and its second half
 *
 * Every refusal of this class answers the browser with a coarse
 * {@link OidcOutcome}: `fehlgeschlagen` covers twelve different causes, and
 * that is deliberate — none of them is anything an unauthenticated caller may
 * learn.
 *
 * **That fixes the other half, and it was missing** (a review finding): if the
 * answer says nothing, the log has to say it. Of ten ways to a refusal, six
 * wrote no line, and the remaining four named a class of error that was the
 * same word for nine different repairs. An operator got „unauthorized" and
 * silence beside it. Since then the following holds here:
 *
 * - **`warn`** wherever an operator has to act — a configuration nobody can
 *   use; a discovery that does not get through; a token that is refused; an
 *   account without a membership.
 * - **`debug`** for normal operation — an organisation without SSO, an unknown
 *   id, the successful path itself.
 * - **Never** a token, a `code`, a `state`, a client secret, an unmasked
 *   address or the message of a foreign library. What may pass through the
 *   seam is decided by {@link oidc-diagnostics.ts}; that it stays that way is
 *   checked by `oidc-login-diagnostics.spec.ts` and
 *   `test/observability/log-hygiene.spec.ts`.
 */
@Injectable()
export class OidcLoginService {
  private readonly logger = new Logger(OidcLoginService.name);

  /**
   * Which „SSO an, aber unbenutzbar"-lines have already been written, so each is
   * written **once per process lifetime** — the same set, for the same reason,
   * as in `OidcSecretsService`.
   *
   * Every route of this package is reachable **without a session**. A line per
   * call would turn one broken row into a log amplifier a stranger can pull,
   * which is the thing rate limits alone do not fix (they are per address).
   * Keyed by the finished message, and that message is built from a tenant id —
   * so the set is bounded by the number of broken rows, not by traffic.
   */
  private readonly reported = new Set<string>();

  constructor(
    private readonly tenants: OidcTenantsService,
    private readonly config: OidcConfigService,
    private readonly secrets: OidcSecretsService,
    private readonly provider: OidcProviderService,
    private readonly identities: OidcIdentityService,
    private readonly sessions: SessionService,
    /** The deployment's allow list (a review finding). */
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * The Organisationen the login page offers a button for.
   *
   * **This route is reachable without a session, and it therefore never unseals
   * anything** (review finding). It used to call
   * `OidcConfigService.signIn(row)` per organisation — which returns an {@link OidcSignIn}
   * carrying the **client secret in clear** — only to read `buttonLabel` off it.
   * A stranger's `GET` thereby materialised every enabled organisation's client secret
   * as a plaintext value inside this package, and the only thing standing
   * between that value and a response body was that nobody had yet widened
   * `OidcProvider`. {@link offersSignIn} asks the same question as a boolean, so
   * on this path there is no expression in which a secret exists.
   *
   * *(What remains is `OidcSecretsService.isUsable`, which is implemented as
   * open-and-discard — the plaintext is created and dropped inside
   * `tenant-admin`, one statement wide. Removing that last step needs a
   * tag-only predicate there and is named as Folgearbeit in ADR-0012 no. 7.)*
   *
   * An organisation whose configuration is unusable is left out **and logged**: from
   * outside it is indistinguishable from one that has not finished configuring
   * itself, which is the fail-closed answer, and the log line is what tells an
   * operator that an organisation believes it has SSO on while nobody can use it.
   */
  async offers(requestHost: string | null): Promise<OidcProvider[]> {
    const rows = await this.tenants.findOfferable();
    const offers: OidcProvider[] = [];
    const usable: OfferableTenant[] = [];
    for (const row of rows) {
      // **Asked once, for both.** The reason *is* the answer to „does this
      // organisation offer SSO?" — a second call for the log line would mean
      // opening the secret a second time, and that is exactly what the test at
      // the end of `oidc-login.service.spec.ts` counts.
      const refusal = this.configRefusal(row);
      if (refusal !== null) {
        // **The reason, once per organisation and process.** Up to here only
        // the unreadable secret was reported; an organisation without a client
        // id, without `openid` in the scope or with an issuer the allow list
        // refuses fell out of the list silently — the button did not appear,
        // and nothing stood in the log. `findOfferable` delivers only rows
        // with `oidcEnabled`, so every omission here is one somebody wants to
        // repair.
        this.reportRefusalOnce(row, refusal, 'offer list');
        continue;
      }
      usable.push(row);
    }

    // **After the usability check, not before:** uniqueness counts among the
    // organisations that actually stand in the chooser. A second organisation
    // at the same address that does not offer SSO at all does not make the
    // match ambiguous for this purpose — it is not on offer.
    const atAddress = soleTenantAtHost(usable, requestHost);
    for (const row of usable) {
      offers.push({
        tenantId: row.id,
        name: row.name,
        shortName: row.shortName,
        buttonLabel: row.oidcButtonLabel ?? DEFAULT_OIDC_BUTTON_LABEL,
        atThisAddress: row.id === atAddress,
      });
    }
    return offers;
  }

  /**
   * Starts a login at one organisation — or `null`, meaning „nicht angeboten".
   *
   * `null` covers an unknown Organisation, an organisation with `oidcEnabled: false`, one that is
   * half configured and one whose secret does not open. The caller turns all
   * four into the same answer: a caller of this route has no session, and which
   * of the four it was is a fact about somebody else's Organisation.
   */
  async start(tenantId: string): Promise<StartedLogin | null> {
    const row = await this.tenants.findById(tenantId);
    if (row === null) {
      // `debug`, not `warn`: an unknown, an invalid or a deleted organisation
      // id is a mistake of the caller, not a state an operator can repair —
      // and the route is reachable without a session, so a `warn` line per
      // call would be a log file a stranger fills. The id goes in with it: it
      // is the value out of the path, checked for its shape (`findById` lets
      // only a canonical UUID reach the query at all), and without it the line
      // says nothing.
      this.logger.debug(
        `OIDC start refused: no organisation with id ${tenantId} (unknown, malformed or deleted).`,
      );
      return null;
    }
    const signIn = await this.signInOrNull(row);
    if (signIn === null) {
      this.reportConfigRefusal(row, 'start');
      return null;
    }

    const codeVerifier = this.provider.newCodeVerifier();
    const transaction = newOidcTransaction(row.id, codeVerifier);
    let authorizationUrl: URL;
    try {
      authorizationUrl = await this.provider.authorizationRequest(
        signIn,
        transaction,
        stateParameter(transaction),
        codeVerifier,
      );
    } catch (error) {
      // **The fifth way this route says „nicht angeboten"** (review finding). Everything above this line answers `null`; discovery does not,
      // and an unreachable, slow or non-conforming provider therefore left the
      // route as a **500** — a JSON error page in the middle of a browser
      // navigation, and, worse, an answer that tells an unauthenticated caller
      // „dieser Organisation hat SSO konfiguriert, sein IdP ist nur gerade tot" where
      // every other refusal says nothing at all. That difference is a fact
      // about somebody else's Organisation, and the route's own doc promises it is not
      // observable.
      //
      // The class of the failure, never its message: `openid-client` quotes the
      // discovery response, and that response is not ours to pass on.
      //
      // **The class on its own was too little** (a review finding). A
      // discovery that fails at name resolution, certificate or timeout
      // arrives in Node as `TypeError: fetch failed` — the line read „could
      // not build an authorization request: TypeError", and with that an
      // operator knows nothing. {@link describeFailure} appends the transport
      // code out of the `cause` chain (`ENOTFOUND`, `CERT_HAS_EXPIRED`,
      // `ECONNREFUSED`) and names the issuer the server tried to fetch — that
      // one has been through `acceptableIssuer` and is configuration, not
      // personal data.
      this.logger.warn(
        `OIDC start for tenant ${row.id} could not build an authorization request for issuer ${signIn.issuer}: ${describeFailure(error)}`,
      );
      return null;
    }
    this.logger.debug(
      `OIDC start for tenant ${row.id}: redirecting to issuer ${signIn.issuer}.`,
    );
    return { transaction, authorizationUrl };
  }

  /**
   * Finishes a login: `state`, code exchange, account, session.
   *
   * Every failure below answers with a coarse {@link OidcOutcome} and puts the
   * reason in the log. That asymmetry is the point — an operator needs to tell a
   * dead provider from a manipulated `state`, and a caller must not.
   */
  async finish(
    transaction: OidcTransaction,
    presentedState: string | undefined,
    callbackUrl: URL,
  ): Promise<FinishedLogin> {
    // **The state check**. Before anything is fetched and
    // before a code is spent: a callback that does not belong to this browser
    // is not a login attempt to be processed, it is somebody else's.
    if (
      presentedState === undefined ||
      !stateMatches(transaction, presentedState)
    ) {
      // The *value* does not go in — it is foreign input out of the query
      // string. Whether one arrived at all is the difference between „the
      // provider sends no `state` back" (a misconfiguration an operator can
      // fix) and „two values do not match here" (an expired or foreign
      // callback), and that is exactly what the line needed.
      this.logger.warn(
        `OIDC callback for tenant ${transaction.tenantId} refused: ${
          presentedState === undefined
            ? 'the provider sent no state parameter'
            : 'the state does not match the transaction cookie'
        }.`,
      );
      return { outcome: 'fehlgeschlagen' };
    }

    const row = await this.tenants.findById(transaction.tenantId);
    if (row === null) {
      // The organisation out of the transaction cookie no longer exists: it
      // was deleted during the ten minutes the transaction runs. Rare, and
      // therefore all the more expensive if there is no line about it.
      this.logger.warn(
        `OIDC callback refused: organisation ${transaction.tenantId} from the transaction cookie no longer exists (deleted while the login was in flight).`,
      );
      return { outcome: 'fehlgeschlagen' };
    }
    // Asked **again**, on the callback. An organisation that switched SSO off while a
    // login was in flight — or one that never had it on and whose callback is
    // being called directly — is refused here, not only in the offer list
    // („die Oberfläche ist Komfort").
    const signIn = await this.signInOrNull(row);
    if (signIn === null) {
      // The line now names the reason instead of „no usable configuration"
      // — the same seven codes as on the start route.
      this.reportConfigRefusal(row, 'callback');
      return { outcome: 'fehlgeschlagen' };
    }

    let token;
    try {
      token = await this.provider.exchange(signIn, transaction, callbackUrl);
    } catch (error) {
      // The provider's own message may quote the token endpoint's response, and
      // that response is not ours to pass on — only the tenant and the class of
      // failure go into the log, and nothing at all into the browser.
      //
      // **And here too the class on its own is not enough** (a review
      // finding). This one `catch` gathers everything that can go wrong
      // between the callback and a verified token: a wrong client secret
      // (`invalid_client`), a code redeemed twice or expired
      // (`invalid_grant`), a `redirect_uri` registered differently at the
      // provider (likewise `invalid_grant`), an abort by the person signing in
      // (`access_denied` out of the query), a signature that does not work
      // out, a missing or wrong `nonce`, an ID token that is none. Those are
      // nine different repairs, and the operator saw the same word for all
      // nine. {@link describeFailure} appends the standardised protocol error
      // code — and *only* that, never `error_description`, whose text the
      // provider writes freely.
      this.logger.warn(
        `OIDC code exchange for tenant ${row.id} at issuer ${signIn.issuer} failed: ${describeFailure(error)}`,
      );
      return { outcome: 'fehlgeschlagen' };
    }

    // The account key — `(issuer, subject)`, never the subject alone, and the
    // issuer is the **configured** one the exchange checked the token against.
    const identity = await this.identities.resolve(
      token.issuer,
      token.subject,
      token.verifiedEmail,
      // The organisation out of the transaction cookie, resolved to a row above — an
      // invitation is only redeemable by the organisation that issued it (ADR-0012
      // no. 3a), and „welcher Organisation" must not come from a token.
      row.id,
    );
    if (identity.outcome === 'no-account') {
      // ADR-0012 no. 3 step 3. „Keine Einladung" and „die Adresse gehört einem
      // lokalen Konto" arrive here as the same value and leave as the same
      // answer.
      return { outcome: 'abgelehnt' };
    }

    const user = identity.user;
    // **Anmelden verleiht keine Rechte** (ADR-0012 no. 5). Signing in through a
    // organisation's provider makes nobody a member of that organisation; membership is granted
    // in the Nutzerverwaltung by somebody with `can_manage_users`. What is
    // decided here is only the narrower question of what somebody with **no**
    // membership at all sees — and the answer is a stated dead end rather than
    // an empty shell: no session is issued, and the login page says why. A
    // superadmin is the one exception, because the installation-wide routes are
    // reachable without any Organisation.
    if (user.memberships.length === 0 && !user.isSuperadmin) {
      // Raised to `warn`: this is not a routine of normal operation but an
      // account somebody had created and that lacks the membership — and it is
      // the one refusal whose cause does **not** lie in the OIDC
      // configuration. That it names the organisation the login took place at
      // is half the way to the repair; the other half is that
      // `membershipInclude` hides memberships in **deleted** organisations —
      // an account whose only organisation lies in the trash ends up here
      // and looks exactly the same from outside.
      this.logger.warn(
        `OIDC login of user ${user.id} at tenant ${row.id} refused: the account holds no membership in any live organisation.`,
      );
      return { outcome: 'ohne-Organisation' };
    }

    const { token: sessionToken } = await this.sessions.issue(
      user.id,
      activeTenantOf(user, row.id),
    );
    this.logger.debug(
      `OIDC login of user ${user.id} at tenant ${row.id} succeeded.`,
    );
    return { outcome: 'angemeldet', sessionToken };
  }

  /**
   * `signIn`, with the throw turned into „bietet SSO nicht an" — **after** it
   * has been written down.
   *
   * The two are different facts (see the class comment) and only one of them is
   * anybody's business outside the server. Collapsing them for the *caller*
   * while keeping them apart in the *log* is what makes the fail-closed answer
   * operable instead of merely safe.
   */
  private async signInOrNull(row: TenantOidcRow): Promise<OidcSignIn | null> {
    try {
      return await this.config.signIn(row);
    } catch (error) {
      if (!(error instanceof OidcClientSecretUnreadableError)) {
        throw error;
      }
      this.reportUnusableSecret(row.id);
      return null;
    }
  }

  /**
   * The same question {@link OidcConfigService.signIn} answers — **without a
   * plaintext**, for the one route that has no business holding a secret, and
   * **with the reason** rather than a bare yes/no.
   *
   * The four conditions above the secret are `signIn`'s, restated rather than
   * called, because `signIn` cannot answer without opening the secret. That is a
   * second copy of a rule and it is the kind that drifts, so it is not left to
   * a comment: `oidc-login.service.spec.ts` runs both predicates over the same
   * table of rows and requires the **same** answer for every one of them. Change
   * either side alone and that goes red.
   *
   * The secret half is {@link OidcSecretsService.isUsable}, which is what the
   * tenant administration's „gesetzt / nicht gesetzt" already means: bytes that do
   * not open **here** are not a stored secret (*fail closed*).
   *
   * **Why a reason and not a truth value** (a review finding). The conditions
   * and their order are unchanged; only the answer is widened. That was the
   * core of the finding: the rule had long existed, there was only no way to
   * name its outcome — so nothing stood in the log, while
   * `OidcConfigService.signIn` handed the login path the same mute `null`.
   * None of these codes ever leaves the server.
   */
  private configRefusal(row: TenantOidcRow): OidcConfigRefusal | null {
    if (!row.oidcEnabled) {
      return 'sso-switched-off';
    }
    if (row.oidcIssuer === null) {
      return 'issuer-missing';
    }
    // Second gate, the same allow list (a review finding): a row written
    // before the hardening or edited by hand is as unusable here as it was at
    // the write — *fail closed*.
    const refusedIssuer = this.issuerRefusal(row.oidcIssuer);
    if (refusedIssuer !== null) {
      return refusedIssuer;
    }
    if (row.oidcClientId === null) {
      return 'client-id-missing';
    }
    if (!row.oidcScopes.includes('openid')) {
      return 'scope-openid-missing';
    }
    if (!this.secrets.isUsable(row.oidcClientSecret, row.id)) {
      // Only reached when everything *else* is configured — which is exactly
      // the situation an operator has to hear about: the organisation believes SSO is
      // on and nobody can use it.
      this.reportUnusableSecret(row.id);
      return 'client-secret-unusable';
    }
    return null;
  }

  /**
   * Which of `acceptableIssuer`'s gates refused the stored value — or `null`
   * when none did.
   *
   * **Two calls of the same checking logic, not a second copy of the rule.**
   * `tenant-admin/oidc-issuer.ts` answers „may this host?" with `null` and
   * does not say which of its conditions it was — and it is not supposed to
   * either: the rule belongs there and is not retold here. What this method
   * does instead is to put the question **twice to the same function**: once
   * with the deployment's allow list and once without. If the value passes it
   * without, the allow list was the gate. This answer is exact, and it does
   * not drift, because both answers come out of the same function.
   *
   * For everything else — protocol, credentials in the address, query, blocked
   * address range (SSRF) — it stays at one reason, which the caller's line
   * supplements with the *scheme*. More would be guessed.
   */
  private issuerRefusal(raw: string): OidcConfigRefusal | null {
    const allowList = issuerAllowList(this.env.OIDC_ISSUER_ALLOWLIST);
    if (acceptableIssuer(raw, allowList) !== null) {
      return null;
    }
    if (allowList.length > 0 && acceptableIssuer(raw, []) !== null) {
      return 'issuer-refused-by-allow-list';
    }
    return 'issuer-not-an-acceptable-discovery-base';
  }

  /**
   * The line for an {@link OidcConfigRefusal}, at the level the reason
   * deserves.
   *
   * `sso-switched-off` is **not** an operational error: an organisation
   * without SSO is the normal case, and whoever calls its start address
   * directly has only themselves to blame. Everything else means „somebody
   * here believes SSO is on and nobody can use it" — and an operator has to
   * see that without switching `debug` on.
   *
   * The value of the issuer never goes in with it (see {@link issuerScheme}).
   */
  private reportConfigRefusal(
    row: TenantOidcRow,
    where: 'start' | 'callback',
  ): void {
    // The route has already seen `signIn` answer `null`; the reason is looked
    // up **once** here, and only on the refusal path.
    const line = this.refusalLine(row, this.configRefusal(row), where);
    if (line === null) {
      return;
    }
    this.logger[line.level](line.message);
  }

  /**
   * The same line for the offer list — **once per organisation and process**.
   *
   * `GET /api/auth/oidc/providers` is reachable without a session and may be
   * called thirty times a minute. A line per call would turn one broken row
   * into an amplifier a stranger pulls — exactly the consideration
   * {@link reported} already makes for the unreadable secret, and therefore
   * the same set.
   *
   * The reason comes **from the call site** and is not determined again:
   * `configRefusal` opens the secret for an otherwise fully configured
   * organisation, and asking twice would mean opening it twice.
   */
  private reportRefusalOnce(
    row: TenantOidcRow,
    refusal: OidcConfigRefusal | null,
    where: RefusalSite,
  ): void {
    const line = this.refusalLine(row, refusal, where);
    if (line === null || this.reported.has(line.message)) {
      return;
    }
    this.reported.add(line.message);
    this.logger[line.level](line.message);
  }

  /** Level and text for a refusal, or `null` for „already written". */
  private refusalLine(
    row: TenantOidcRow,
    refusal: OidcConfigRefusal | null,
    where: RefusalSite,
  ): { readonly level: 'warn' | 'debug'; readonly message: string } | null {
    if (refusal === null) {
      // Can only happen if `signIn` and `configRefusal` diverge — which the
      // comparison in the spec forbids. A line all the same, because a silent
      // branch is precisely what this work removes.
      return {
        level: 'warn',
        message: `OIDC ${where} for tenant ${row.id} refused without a nameable reason; the two configuration predicates disagree.`,
      };
    }
    if (refusal === 'client-secret-unusable') {
      // Already written by `reportUnusableSecret` as an `error` — once per
      // process, because the routes are reachable without a session. No second
      // line per call, otherwise the bound there would be for nothing.
      return null;
    }
    if (refusal === 'sso-switched-off') {
      return {
        level: 'debug',
        message: `OIDC ${where} for tenant ${row.id}: SSO is switched off for this organisation.`,
      };
    }
    const detail =
      refusal === 'issuer-not-an-acceptable-discovery-base' &&
      row.oidcIssuer !== null
        ? ` (scheme ${issuerScheme(row.oidcIssuer)})`
        : '';
    return {
      level: 'warn',
      message: `OIDC ${where} for tenant ${row.id} refused: ${refusal}${detail}.`,
    };
  }

  /** Once per tenant per process — see {@link reported}. */
  private reportUnusableSecret(tenantId: string): void {
    const message = `Tenant ${tenantId} has SSO switched on, but its stored client secret cannot be opened here; offering no login for it (fail closed).`;
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}

/**
 * Why an organisation's stored OIDC configuration cannot sign anybody in.
 *
 * **A closed set of codes, and none of them leaves the server.** The answer to
 * the browser stays the coarse `fehlgeschlagen`; these values stand in log
 * lines exclusively. They are English like every other identifier and
 * `kebab-case` like the codes `OidcOutcome` uses, so that an operator can grep
 * them.
 */
export type OidcConfigRefusal =
  | 'sso-switched-off'
  | 'issuer-missing'
  | 'issuer-refused-by-allow-list'
  | 'issuer-not-an-acceptable-discovery-base'
  | 'client-id-missing'
  | 'scope-openid-missing'
  | 'client-secret-unusable';

/** Which of the three routes reported the refusal — only for the line. */
type RefusalSite = 'start' | 'callback' | 'offer list';

/** What the start route needs: the cookie to set and the address to send to. */
export interface StartedLogin {
  readonly transaction: OidcTransaction;
  readonly authorizationUrl: URL;
}

/**
 * How a callback ended. `sessionToken` exists for exactly one outcome, so the
 * type makes „redirect angemeldet, but forgot the cookie" unexpressible.
 */
export type FinishedLogin =
  | { readonly outcome: 'angemeldet'; readonly sessionToken: string }
  | { readonly outcome: Exclude<OidcOutcome, 'angemeldet'> };

/**
 * Which Organisation a fresh SSO session starts in.
 *
 * The organisation that was signed in at, when there is a membership in it — that is
 * where the person just said they wanted to work, and it is verified against the
 * memberships loaded with the account rather than taken from the flow.
 *
 * **Everything else is `deriveActiveTenant` verbatim, and it is now called
 * rather than repeated** (review finding). This function used to carry
 * its own copy of „genau eine Mitgliedschaft, sonst `null`". Two copies of a
 * *session scope* rule drift precisely where a wrong answer reads „alle Organisationen",
 * so the wrapper is the whole of the difference: one extra case on top of the
 * shared rule, and nothing restated.
 */
function activeTenantOf(
  user: { readonly memberships: readonly { readonly tenantId: string }[] },
  signedInAt: string,
): string | null {
  if (
    user.memberships.some((membership) => membership.tenantId === signedInAt)
  ) {
    return signedInAt;
  }
  return deriveActiveTenant(user.memberships);
}

/**
 * Which of the offered organisations is reachable under **this** address — or
 * `null` when that is none of them or more than one.
 *
 * ## Why "more than one" is the same answer as "none"
 *
 * `tenant.public_base_url` carries no unique index; two organisations may hold
 * the same address. "Two matches" is no answer to "which one is meant", and a
 * guessed pre-selection would be worse than none: it would look like a
 * statement of fact.
 *
 * ## What is compared
 *
 * The `host` of both sides — name **including port**, lower-cased: `URL.host`
 * on the stored address, the raw value on the request's side. A stored address
 * that does not parse as a URL counts as no match, which is the posture
 * `PublicUrlService.resolveBaseUrl` already takes towards such values ("treated
 * exactly like an absent one") and not an exception escaping upwards.
 */
function soleTenantAtHost(
  rows: readonly OfferableTenant[],
  requestHost: string | null,
): string | null {
  if (requestHost === null || requestHost === '') {
    return null;
  }
  const wanted = requestHost.toLowerCase();
  let found: string | null = null;
  for (const row of rows) {
    if (row.publicBaseUrl === null || hostOf(row.publicBaseUrl) !== wanted) {
      continue;
    }
    if (found !== null) {
      // A second match: not unambiguous, so none. No early exit on the first —
      // this case is precisely the one the rule is about.
      return null;
    }
    found = row.id;
  }
  return found;
}

/** The `host` of a stored base address, or `null`. */
function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}
