import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  type ApiEnv,
} from '@formsache/shared';

import type { PublicUrlService } from '../../common/public-url/public-url.service';
import { SecretBoxService } from '../../common/secret-box/secret-box.service';
import {
  OidcConfigService,
  type TenantOidcRow,
} from '../../tenant-admin/oidc-config.service';
import { OidcSecretsService } from '../../tenant-admin/oidc-secrets.service';
import type { SessionService } from '../session.service';
import type { UserWithMemberships } from '../session-user';
import { OidcIdTokenRefusedError } from './oidc-diagnostics';
import type { OidcIdentityService } from './oidc-identity.service';
import { OidcLoginService } from './oidc-login.service';
import type {
  OidcProviderService,
  VerifiedIdToken,
} from './oidc-provider.service';
import type { OidcTenantsService } from './oidc-tenants.service';
import { newOidcTransaction, stateParameter } from './oidc-transaction';

/**
 * **Every path to a refused sign-in names its reason — in the log, and only
 * there.**
 *
 * The finding this file came out of read: „Ich habe OIDC konfiguriert, bekomme
 * eine Ablehnung und sehe in den Logs nicht, warum." Both were true.
 * `OidcLoginService` had ten branches that lead to a refusal, and six of them
 * wrote no line — the operator got the same coarse answer for all ten, and
 * silence beside it.
 *
 * Every case here therefore checks **two things at once**, and that is the
 * whole point:
 *
 * 1. The log names the cause, precisely enough for an operator to know what
 *    they are supposed to repair.
 * 2. The answer to the browser stays the coarse `OidcOutcome` — no reason, no
 *    hint as to whether an account exists.
 *
 * A test that checked only (1) would let through the extension that writes the
 * reason into the `?sso=` parameter one day, because that would be more
 * helpful, after all. A test that checked only (2) is the state the finding
 * came out of.
 */

const TEST_KEY = Buffer.alloc(32, 11);

const ALPHA = '019ff500-0000-7000-8000-0000000000a1';
const BETA = '019ff500-0000-7000-8000-0000000000b2';

const ISSUER = 'https://idp.alpha.invalid/realms/demo';
const REDIRECT_URI = 'https://formulare.demo.invalid/api/auth/oidc/callback';

function row(overrides: Partial<TenantOidcRow> = {}): TenantOidcRow {
  return {
    id: ALPHA,
    oidcEnabled: true,
    oidcIssuer: ISSUER,
    oidcClientId: 'formular-alpha',
    oidcClientSecret: new OidcSecretsService(
      new SecretBoxService(TEST_KEY),
    ).seal('client-secret-of-alpha', ALPHA),
    oidcScopes: ['openid', 'email'],
    oidcEmailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
    oidcEmailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
    oidcButtonLabel: null,
    ...overrides,
  };
}

/** A signed-in account with exactly one membership in {@link ALPHA}. */
function member(memberships: readonly { tenantId: string }[]) {
  return {
    id: '019ff500-0000-7000-8000-0000000000c3',
    isSuperadmin: false,
    memberships,
  } as unknown as UserWithMemberships;
}

/**
 * All the lines that are written during a case — per level.
 *
 * Through `Logger.prototype` instead of through a slipped-in instance, because
 * every service holds its own `new Logger(Name)`: the prototype mock thereby
 * sees the lines of the fellow players as well, which is wanted here.
 */
function captureLog() {
  const lines: { readonly level: string; readonly message: string }[] = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(
      (message: unknown): void => {
        lines.push({ level, message: String(message) });
      },
    );
  }
  return {
    /** The lines of one level, pulled together — for a `toContain`. */
    at: (level: 'log' | 'warn' | 'error' | 'debug'): string =>
      lines
        .filter((line) => line.level === level)
        .map((line) => line.message)
        .join('\n'),
    all: (): string => lines.map((line) => line.message).join('\n'),
    count: (): number => lines.length,
  };
}

interface HarnessOptions {
  readonly rows?: Partial<Record<string, TenantOidcRow>>;
  readonly allowList?: string | undefined;
  readonly exchange?: () => Promise<VerifiedIdToken>;
  readonly resolve?: () => Promise<
    | { outcome: 'no-account' }
    | { outcome: 'signed-in'; user: UserWithMemberships }
  >;
  readonly authorizationRequest?: () => Promise<URL>;
}

/**
 * The real {@link OidcConfigService} over a real key holder, as in
 * `oidc-login.service.spec.ts` — a mock that answers a constant would make
 * "fail closed" irrefutable. Only the three fellow players beyond the provider
 * are staged: otherwise they talk over HTTP or with the database.
 */
function harness(options: HarnessOptions = {}) {
  const box = new SecretBoxService(TEST_KEY);
  const secrets = new OidcSecretsService(box);
  const env = { OIDC_ISSUER_ALLOWLIST: options.allowList } as ApiEnv;
  const config = new OidcConfigService(
    secrets,
    {
      oidcCallbackUrl: () => Promise.resolve(REDIRECT_URI),
    } as unknown as PublicUrlService,
    env,
  );

  const rows = options.rows ?? { [ALPHA]: row() };
  const login = new OidcLoginService(
    {
      findById: (id: string) => Promise.resolve(rows[id] ?? null),
      findOfferable: () => Promise.resolve(Object.values(rows)),
    } as unknown as OidcTenantsService,
    config,
    secrets,
    {
      newCodeVerifier: () => 'verifier-'.padEnd(43, 'x'),
      authorizationRequest:
        options.authorizationRequest ??
        (() => Promise.resolve(new URL('https://idp.alpha.invalid/auth'))),
      exchange:
        options.exchange ??
        (() =>
          Promise.resolve({
            issuer: ISSUER,
            subject: 'sub-1',
            verifiedEmail: 'max.mustermann@verein.example',
          })),
    } as unknown as OidcProviderService,
    {
      resolve:
        options.resolve ??
        (() =>
          Promise.resolve({
            outcome: 'signed-in' as const,
            user: member([{ tenantId: ALPHA }]),
          })),
    } as unknown as OidcIdentityService,
    {
      issue: () => Promise.resolve({ token: 'session-token' }),
    } as unknown as SessionService,
    env,
  );
  return login;
}

/** A transaction for {@link ALPHA}, together with a matching `state`. */
function transactionFor(tenantId: string = ALPHA) {
  const transaction = newOidcTransaction(tenantId, 'verifier-'.padEnd(43, 'x'));
  return { transaction, state: stateParameter(transaction) };
}

let log: ReturnType<typeof captureLog>;

beforeEach(() => {
  log = captureLog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('die Start-Route benennt jede Ablehnung', () => {
  it('sagt bei einer unbekannten Organisation, dass es sie nicht gibt — auf debug', async () => {
    // An error of the caller, not a state an operator repairs. At `warn` this
    // would be a log file a stranger fills: the route is reachable without a
    // session.
    const login = harness({ rows: {} });

    await expect(login.start(BETA)).resolves.toBeNull();

    expect(log.at('debug')).toContain('no organisation with id');
    expect(log.at('warn')).toBe('');
  });

  it.each([
    ['issuer-missing', row({ oidcIssuer: null })],
    ['client-id-missing', row({ oidcClientId: null })],
    ['scope-openid-missing', row({ oidcScopes: ['email'] })],
  ] as const)(
    'nennt eine halb eingerichtete Organisation beim Namen: %s',
    async (expected, broken) => {
      const login = harness({ rows: { [ALPHA]: broken } });

      // The answer stays "not offered" — indistinguishable from an
      // organisation that has never switched SSO on.
      await expect(login.start(ALPHA)).resolves.toBeNull();
      expect(log.at('warn')).toContain(expected);
      expect(log.at('warn')).toContain(ALPHA);
    },
  );

  it('nennt bei einem unbrauchbaren Issuer das Schema, nie den Wert', async () => {
    const login = harness({
      rows: { [ALPHA]: row({ oidcIssuer: 'http://idp.alpha.invalid/geheim' }) },
    });

    await expect(login.start(ALPHA)).resolves.toBeNull();

    expect(log.at('warn')).toContain(
      'issuer-not-an-acceptable-discovery-base (scheme http)',
    );
    // The column has never gone through the write gate, so it is foreign input.
    expect(log.all()).not.toContain('geheim');
  });

  it('unterscheidet die Positivliste des Betriebs vom Rest', async () => {
    // Twice **the same** checking logic, once with and once without the
    // allow-list — if the value passes it without, the list was the gate.
    // Exactly this piece of information was missing for an operator who had
    // set `OIDC_ISSUER_ALLOWLIST` and set the organisation up afterwards.
    const login = harness({ allowList: 'sso.betreiber.example' });

    await expect(login.start(ALPHA)).resolves.toBeNull();

    expect(log.at('warn')).toContain('issuer-refused-by-allow-list');
  });

  it('schreibt für eine Organisation ohne SSO nur debug', async () => {
    const login = harness({ rows: { [ALPHA]: row({ oidcEnabled: false }) } });

    await expect(login.start(ALPHA)).resolves.toBeNull();

    expect(log.at('debug')).toContain('SSO is switched off');
    expect(log.at('warn')).toBe('');
  });

  /**
   * **The case that triggered the finding.** A failing discovery arrived as
   * `TypeError: fetch failed`, and the line read "… could not build an
   * authorization request: TypeError".
   */
  it('nennt bei fehlgeschlagener Discovery den Transportcode und den Issuer', async () => {
    const login = harness({
      authorizationRequest: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('…'), { code: 'ENOTFOUND' }),
          }),
        ),
    });

    await expect(login.start(ALPHA)).resolves.toBeNull();

    expect(log.at('warn')).toContain('ENOTFOUND');
    expect(log.at('warn')).toContain(ISSUER);
  });
});

describe('die Rückruf-Route benennt jede Ablehnung', () => {
  const callbackUrl = new URL(`${REDIRECT_URI}?code=abc`);

  it('unterscheidet „kein state" von „falscher state"', async () => {
    const login = harness();
    const { transaction, state } = transactionFor();

    await expect(
      login.finish(transaction, undefined, callbackUrl),
    ).resolves.toStrictEqual({ outcome: 'fehlgeschlagen' });
    expect(log.at('warn')).toContain('sent no state parameter');

    log = captureLog();
    await expect(
      login.finish(transaction, `${state}-verdreht`, callbackUrl),
    ).resolves.toStrictEqual({ outcome: 'fehlgeschlagen' });
    expect(log.at('warn')).toContain('does not match the transaction cookie');
    // The presented value is foreign input out of the query string.
    expect(log.all()).not.toContain('verdreht');
  });

  it('sagt es, wenn die Organisation während der Anmeldung gelöscht wurde', async () => {
    const login = harness({ rows: {} });
    const { transaction, state } = transactionFor();

    await expect(
      login.finish(transaction, state, callbackUrl),
    ).resolves.toStrictEqual({ outcome: 'fehlgeschlagen' });

    expect(log.at('warn')).toContain('no longer exists');
  });

  it('nennt auf dem Rückruf denselben Konfigurationsgrund wie beim Start', async () => {
    // "SSO switched off while a sign-in was on its way" — until now it said
    // "does not offer a usable SSO configuration", which does not name the
    // reason.
    const login = harness({ rows: { [ALPHA]: row({ oidcClientId: null }) } });
    const { transaction, state } = transactionFor();

    await expect(
      login.finish(transaction, state, callbackUrl),
    ).resolves.toStrictEqual({ outcome: 'fehlgeschlagen' });

    expect(log.at('warn')).toContain('callback');
    expect(log.at('warn')).toContain('client-id-missing');
  });

  /**
   * **The one `catch` that made nine repairs into one word.** A wrong client
   * secret, a code redeemed twice, a deviating `redirect_uri`, an abort by the
   * person, signature, `nonce`, a missing ID token — the operator saw "Error"
   * for all of them.
   */
  it.each([
    [
      'ein falsches Client-Secret',
      Object.assign(new Error('…'), {
        name: 'ResponseBodyError',
        error: 'invalid_client',
        error_description: 'Client authentication failed for realm demo',
      }),
      'ResponseBodyError/invalid_client',
    ],
    [
      'ein ID-Token, das keines ist',
      new OidcIdTokenRefusedError('no-id-token'),
      'OidcIdTokenRefusedError/no-id-token',
    ],
    [
      'einen Issuer, der nicht der konfigurierte ist',
      new OidcIdTokenRefusedError('issuer-mismatch'),
      'OidcIdTokenRefusedError/issuer-mismatch',
    ],
  ])('unterscheidet im Protokoll: %s', async (_name, thrown, expected) => {
    const login = harness({ exchange: () => Promise.reject(thrown) });
    const { transaction, state } = transactionFor();

    const finished = await login.finish(transaction, state, callbackUrl);

    // Outwardly unchanged, coarse.
    expect(finished).toStrictEqual({ outcome: 'fehlgeschlagen' });
    expect(log.at('warn')).toContain(expected);
    // And nothing that the provider has worded freely.
    expect(log.all()).not.toContain('realm demo');
  });

  it('gibt „kein Konto" als abgelehnt zurück, ohne selbst zu raten', async () => {
    // The *reason* stands in `OidcIdentityService` — here all that counts is
    // that the answer to the browser gives nothing away about the existence of
    // an account.
    const login = harness({
      resolve: () => Promise.resolve({ outcome: 'no-account' as const }),
    });
    const { transaction, state } = transactionFor();

    const finished = await login.finish(transaction, state, callbackUrl);

    expect(finished).toStrictEqual({ outcome: 'abgelehnt' });
  });

  it('nennt bei einem Konto ohne Mitgliedschaft die Organisation, an der es sich anmeldete', async () => {
    const login = harness({
      resolve: () =>
        Promise.resolve({ outcome: 'signed-in' as const, user: member([]) }),
    });
    const { transaction, state } = transactionFor();

    const finished = await login.finish(transaction, state, callbackUrl);

    expect(finished).toStrictEqual({ outcome: 'ohne-Organisation' });
    // At `warn`: this is an account somebody has to give a membership to —
    // and it is the refusal whose cause does **not** lie in the OIDC
    // configuration.
    expect(log.at('warn')).toContain('no membership in any live organisation');
    expect(log.at('warn')).toContain(ALPHA);
  });
});

describe('was in keiner dieser Zeilen steht', () => {
  const callbackUrl = new URL(`${REDIRECT_URI}?code=abc`);

  /**
   * The counter-check to everything above: the lines are talkative **about
   * configuration**, not about secrets. Measured over the whole sign-in path
   * at once, so that no single branch slips through.
   */
  it('kein Client-Secret, kein state, kein code, kein subject', async () => {
    const { transaction, state } = transactionFor();
    const login = harness({
      exchange: () =>
        Promise.reject(
          Object.assign(new Error('…'), {
            name: 'ResponseBodyError',
            error: 'invalid_client',
          }),
        ),
    });

    await login.start(ALPHA);
    await login.finish(transaction, state, new URL(`${REDIRECT_URI}?code=abc`));
    await login.finish(transaction, undefined, callbackUrl);

    const written = log.all();
    expect(written).not.toContain('client-secret-of-alpha');
    expect(written).not.toContain(transaction.stateSecret);
    expect(written).not.toContain(transaction.codeVerifier);
    expect(written).not.toContain(transaction.nonce);
    expect(written).not.toContain(state);
    expect(written).not.toContain('code=abc');
    // And the counter-check to that: something was written at all.
    expect(log.count()).toBeGreaterThan(2);
  });
});
