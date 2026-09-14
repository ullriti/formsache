import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OIDC_OUTCOME_PARAM, type ApiEnv } from '@formsache/shared';

import type { PublicUrlService } from '../../common/public-url/public-url.service';
import type { SessionService } from '../session.service';
import type { OidcLoginService } from './oidc-login.service';
import { OidcLoginController } from './oidc-login.controller';
import {
  OIDC_COOKIE_NAME,
  SECURE_OIDC_COOKIE_NAME,
  buildOidcTransactionCookie,
  newOidcTransaction,
} from './oidc-transaction';

/**
 * **A callback without a usable transaction cookie** — four situations, one
 * answer, and up to this finding not a single log line.
 *
 * `readOidcTransaction` answers „kein Cookie", „Cookie unter dem *anderen*
 * Namen", „parst nicht" and „abgelaufen" with the same `undefined`, and the
 * controller turned that into a `fehlgeschlagen`. Outwardly that is right —
 * which of the four it was is nothing a caller is meant to learn. Inwardly
 * it was the place at which an installation behind TLS-less `http` with
 * `NODE_ENV=production` loses **every** sign-in: the browser does not even accept a
 * `Secure` cookie there, and nothing said so.
 *
 * The line therefore names the **expected name**. That is a function of
 * `secure`, and thus the misconfiguration is readable at a glance.
 */

const TENANT = '019ff500-0000-7000-8000-0000000000a1';
const APP_URL = 'https://formulare.demo.invalid';

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
    at: (level: string) =>
      lines
        .filter((line) => line.level === level)
        .map((line) => line.message)
        .join('\n'),
  };
}

/** The response, as far as the controller touches it: `Location` and cookies. */
function response() {
  const headers = new Map<string, string | readonly string[]>();
  return {
    headers,
    setHeader: (name: string, value: string | readonly string[]) =>
      headers.set(name, value),
    status: () => undefined,
    location: () => String(headers.get('Location') ?? ''),
  };
}

function controller(secure: boolean, finish = vi.fn()) {
  return new OidcLoginController(
    { finish } as unknown as OidcLoginService,
    { ttlSeconds: 3600 } as unknown as SessionService,
    {
      appUrl: (path: string) => Promise.resolve(`${APP_URL}${path}`),
      oidcCallbackUrl: () =>
        Promise.resolve(`${APP_URL}/api/auth/oidc/callback`),
    } as unknown as PublicUrlService,
    { NODE_ENV: secure ? 'production' : 'development' } as ApiEnv,
  );
}

let log: ReturnType<typeof captureLog>;

beforeEach(() => {
  log = captureLog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Only the handover to `offers()` is checked here — where the host comes
 * from is Express' own `req.host`, and re-testing that would just be
 * testing the framework. `TRUST_PROXY_HOPS` actually biting is covered by
 * the integration suite.
 */
describe('der Host, den die Angebotsliste liest', () => {
  function offering() {
    const offers = vi.fn().mockResolvedValue([]);
    const subject = new OidcLoginController(
      { offers } as unknown as OidcLoginService,
      { ttlSeconds: 3600 } as unknown as SessionService,
      {} as unknown as PublicUrlService,
      { NODE_ENV: 'production' } as ApiEnv,
    );
    return { subject, offers };
  }

  it('reicht den Host der Anfrage an die Angebotsliste weiter', async () => {
    const { subject, offers } = offering();

    await subject.providers({ host: 'formulare.alpha.example' });

    expect(offers).toHaveBeenCalledWith('formulare.alpha.example');
  });

  it('antwortet ohne Host mit null — keine Vorbelegung', async () => {
    const { subject, offers } = offering();

    await subject.providers({});

    expect(offers).toHaveBeenCalledWith(null);
  });
});

describe('der Rückruf ohne Transaktions-Cookie', () => {
  it('nennt den erwarteten Cookie-Namen — hinter TLS den mit __Host-', async () => {
    const secure = controller(true);
    const answer = response();

    await secure.callback('irgendein-state', { headers: {} }, answer);

    expect(log.at('debug')).toContain(SECURE_OIDC_COOKIE_NAME);
  });

  it('… und über schlichtes http den ohne', async () => {
    const plain = controller(false);
    const answer = response();

    await plain.callback('irgendein-state', { headers: {} }, answer);

    expect(log.at('debug')).toContain(OIDC_COOKIE_NAME);
    expect(log.at('debug')).not.toContain(SECURE_OIDC_COOKIE_NAME);
  });

  /**
   * **Exactly the misconfiguration that produces the finding.** The browser of an
   * `http` installation files the cookie under the *insecure* name; a
   * server with `NODE_ENV=production` looks for the `__Host-` name and finds
   * nothing. From outside: „unauthorized". In the log: now the name it
   * expected.
   */
  it('meldet auch dann, wenn ein Cookie da ist — aber unter dem anderen Namen', async () => {
    const secure = controller(true);
    const transaction = newOidcTransaction(TENANT, 'verifier-'.padEnd(43, 'x'));
    const planted = buildOidcTransactionCookie(transaction, { secure: false });
    const answer = response();

    await secure.callback(
      'irgendein-state',
      { headers: { cookie: planted.split(';')[0] ?? '' } },
      answer,
    );

    expect(log.at('debug')).toContain(SECURE_OIDC_COOKIE_NAME);
  });

  it('verrät dem Browser trotzdem nichts — dieselbe grobe Antwort wie immer', async () => {
    const plain = controller(false);
    const answer = response();

    await plain.callback(undefined, { headers: {} }, answer);

    // The reason stays inside: a `?sso=` code from the closed set,
    // and the transaction cookies are cleared on **every** path.
    expect(answer.location()).toBe(
      `${APP_URL}/?${OIDC_OUTCOME_PARAM}=fehlgeschlagen`,
    );
    expect(answer.location()).not.toContain(OIDC_COOKIE_NAME);
    const cookies = answer.headers.get('Set-Cookie') ?? [];
    expect(cookies).toHaveLength(2);
  });

  it('schreibt debug, nicht warn — die Route ist ohne Sitzung erreichbar', async () => {
    // A callback that came too late or twice is the normal case. A
    // stranger must not be able to force lines an operator has to read.
    const plain = controller(false);

    await plain.callback('x', { headers: {} }, response());

    expect(log.at('warn')).toBe('');
    expect(log.at('error')).toBe('');
  });
});
