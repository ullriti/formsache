import type { NodeEnv } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  SECURE_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
  buildClearedSessionCookies,
  buildSessionCookie,
  describeSessionCookieMode,
  readSessionToken,
  sessionCookieModeIsWeakened,
  sessionCookieName,
  usesSecureCookies,
} from './session-cookie';

/**
 * The environments this file measures — the whole cross product of the two
 * variables that decide the cookie's shape, written out rather than sampled.
 * `SESSION_COOKIE_SECURE: undefined` is „the operator said nothing", which is
 * what every installation predating the variable hands in.
 */
const ENVIRONMENTS: readonly {
  readonly NODE_ENV: NodeEnv;
  readonly SESSION_COOKIE_SECURE: boolean | undefined;
}[] = (['development', 'test', 'production'] as const).flatMap((NODE_ENV) =>
  [undefined, true, false].map((SESSION_COOKIE_SECURE) => ({
    NODE_ENV,
    SESSION_COOKIE_SECURE,
  })),
);

describe('usesSecureCookies', () => {
  /**
   * The behaviour every installation that never heard of the new variable
   * gets: `production` behind TLS, everything else over plain http. This is
   * the assertion that keeps adding the variable from being a change of the
   * shipped default.
   */
  it('falls back to NODE_ENV when nobody decided', () => {
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(
        usesSecureCookies({ NODE_ENV, SESSION_COOKIE_SECURE: undefined }),
      ).toBe(false);
    }
    expect(
      usesSecureCookies({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: undefined,
      }),
    ).toBe(true);
  });

  /**
   * **The point of the whole variable, and the reproduction behind it.**
   *
   * `docker-compose.prod.yml` pins `NODE_ENV: production`, so an installation
   * reached over plain http used to have no way to say so — the login answered
   * 200, the browser discarded the `Secure` cookie on any address but
   * `localhost`, and every request afterwards was anonymous. An explicit
   * `false` has to win against the operating mode, or that installation stays
   * broken.
   */
  it('lets an explicit decision win over NODE_ENV in both directions', () => {
    expect(
      usesSecureCookies({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: false,
      }),
    ).toBe(false);
    expect(
      usesSecureCookies({
        NODE_ENV: 'development',
        SESSION_COOKIE_SECURE: true,
      }),
    ).toBe(true);
  });

  /**
   * ⚠️ **The trap this function exists against**, stated as a test over every
   * environment: the *writer* of the cookie and its *reader* have to agree on
   * the name. If they ever disagreed, the login would set
   * `__Host-formsache_session` while the guard looked for `formsache_session`,
   * and every request after a successful login would come back 401 — measured
   * here through the pair that actually ships (`buildSessionCookie` writes,
   * `readSessionToken` reads), with the *same* environment on both sides and
   * nothing but this function in between.
   */
  it('gives writer and reader the same name in every environment', () => {
    for (const env of ENVIRONMENTS) {
      const secure = usesSecureCookies(env);
      const header = buildSessionCookie('a-token-value', {
        maxAgeSeconds: 60,
        secure,
      });
      const presented = header.split(';')[0];

      expect(header.startsWith(`${sessionCookieName(secure)}=`), header).toBe(
        true,
      );
      expect(readSessionToken(presented, usesSecureCookies(env))).toBe(
        'a-token-value',
      );
      // And the counter-proof: the *other* name is not a session token. Without
      // it the assertion above would also hold for a reader that accepted both.
      expect(readSessionToken(presented, !secure)).toBeUndefined();
    }
  });
});

describe('describeSessionCookieMode', () => {
  /**
   * The line exists so that a misconfiguration is readable in the log instead
   * of in a browser's cookie inspector, so it has to carry three things: which
   * shape is running, the name that goes with it, and — because two variables
   * can produce it — which of them decided.
   */
  it('names the cookie, the shape and the variable that decided it', () => {
    expect(
      describeSessionCookieMode({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: undefined,
      }),
    ).toBe(
      `Session cookie: Secure, named ${SECURE_SESSION_COOKIE_NAME} ` +
        '(NODE_ENV=production) — TLS required in front of this process.',
    );
    expect(
      describeSessionCookieMode({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: false,
      }),
    ).toBe(
      `Session cookie: no Secure, named ${SESSION_COOKIE_NAME} ` +
        '(SESSION_COOKIE_SECURE=false) — suitable only for operation without ' +
        'TLS in a private network; a publicly reachable installation must set ' +
        'SESSION_COOKIE_SECURE=true.',
    );
  });

  /**
   * **The weaker shape has to be recognisable as the weaker one**, in every
   * environment that produces it — an operator scanning the startup output must
   * not have to know that `__Host-` implies anything.
   */
  it('warns in exactly the environments that run without Secure', () => {
    for (const env of ENVIRONMENTS) {
      const line = describeSessionCookieMode(env);
      expect(line).toContain(sessionCookieName(usesSecureCookies(env)));
      expect(line.includes('no Secure'), line).toBe(!usesSecureCookies(env));
      expect(line.includes('without'), line).toBe(!usesSecureCookies(env));
    }
  });

  /**
   * **The level, and the reason it is not simply „no Secure means warn".** A
   * development machine runs without `Secure` as a matter of course; a WARN on
   * every `pnpm dev` is noise that teaches people to skip warnings. What
   * deserves the line an operator greps for is the one combination somebody had
   * to ask for: `production` **and** no `Secure`.
   */
  it('reserves the warning for the shape somebody had to ask for', () => {
    expect(
      sessionCookieModeIsWeakened({
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: false,
      }),
    ).toBe(true);
    for (const env of ENVIRONMENTS.filter(
      (candidate) =>
        candidate.NODE_ENV !== 'production' ||
        candidate.SESSION_COOKIE_SECURE !== false,
    )) {
      expect(sessionCookieModeIsWeakened(env), JSON.stringify(env)).toBe(false);
    }
  });
});

describe('buildSessionCookie', () => {
  const options = { maxAgeSeconds: 43_200, secure: false };

  /**
   * `httpOnly` and `SameSite=Lax` explicitly. Asserted
   * literally rather than through the options object, so that a change to the
   * policy has to be made here as well — silently is not an option.
   */
  it('sets HttpOnly and SameSite=Lax', () => {
    const header = buildSessionCookie('token', options);

    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
  });

  it('scopes the cookie to the whole site and to the session lifetime', () => {
    const header = buildSessionCookie('token', options);

    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=43200');
  });

  it('carries the token under the documented name', () => {
    expect(buildSessionCookie('abc', options)).toContain(
      `${SESSION_COOKIE_NAME}=abc`,
    );
  });

  it('marks the cookie Secure in production and nowhere else', () => {
    expect(buildSessionCookie('abc', options)).not.toContain('Secure');
    expect(buildSessionCookie('abc', { ...options, secure: true })).toContain(
      '; Secure',
    );
  });

  /**
   * The name follows `secure`, and that is the whole point of the prefix:
   * `__Host-` makes the browser refuse the cookie unless it is `Secure`, has
   * `Path=/` and no `Domain` — so no other host can write it. Without it, any
   * subdomain may set `formsache_session` for the parent domain, and the browser
   * presents it next to ours with nothing to tell them apart (cookie tossing).
   * Over plain http the prefix cannot be used: the browser would drop the
   * cookie without a word, and the local login would look broken.
   */
  it('uses the __Host- prefix exactly where Secure is set', () => {
    const secure = buildSessionCookie('abc', { ...options, secure: true });
    expect(secure).toContain(`${SECURE_SESSION_COOKIE_NAME}=abc`);
    expect(secure.startsWith('__Host-')).toBe(true);

    const local = buildSessionCookie('abc', options);
    expect(local).not.toContain('__Host-');
    expect(local.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  /** A `__Host-` cookie that broke one of the three conditions is dropped. */
  it('satisfies the conditions the __Host- prefix imposes', () => {
    const secure = buildSessionCookie('abc', { ...options, secure: true });

    expect(secure).toContain('; Secure');
    expect(secure).toContain('Path=/;');
    expect(secure).not.toContain('Domain=');
  });

  it('reports the same name the builder uses', () => {
    expect(sessionCookieName(true)).toBe(SECURE_SESSION_COOKIE_NAME);
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE_NAME);
  });
});

describe('buildClearedSessionCookie', () => {
  /**
   * A browser replaces a cookie only when name, path and domain match. A
   * clearing cookie that differed in any of them would leave the original in
   * place — and the user would look logged out while still holding a valid
   * token.
   */
  it('matches the installing cookie in everything but value and lifetime', () => {
    const installed = buildSessionCookie('token', {
      maxAgeSeconds: 60,
      secure: true,
    });
    const cleared = buildClearedSessionCookie({ secure: true });

    const attributesOf = (header: string): string[] =>
      header
        .split('; ')
        .slice(1)
        .filter((part) => !part.startsWith('Max-Age='));

    expect(attributesOf(cleared)).toStrictEqual(attributesOf(installed));
    expect(cleared).toContain(`${SECURE_SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain('Max-Age=0');
  });

  /** Clearing `formsache_session` would not touch a `__Host-formsache_session`. */
  it('clears the name that belongs to the setting it was set with', () => {
    expect(buildClearedSessionCookie({ secure: false })).toContain(
      `${SESSION_COOKIE_NAME}=;`,
    );
    expect(buildClearedSessionCookie({ secure: false })).not.toContain(
      '__Host-',
    );
  });
});

describe('buildClearedSessionCookies', () => {
  /**
   * A logout clears both names although each environment only *accepts* one.
   * The other one is not a way in — it is left-over state: it rides along on
   * every request, and it becomes live again the day the deployment moves off
   * TLS. Clearing a name that is not there costs one header.
   */
  it('clears both names in either environment', () => {
    for (const secure of [false, true]) {
      const headers = buildClearedSessionCookies(secure);

      expect(headers).toHaveLength(2);
      expect(
        headers.some((header) =>
          header.startsWith(`${SECURE_SESSION_COOKIE_NAME}=;`),
        ),
      ).toBe(true);
      expect(
        headers.some((header) => header.startsWith(`${SESSION_COOKIE_NAME}=;`)),
      ).toBe(true);
      for (const header of headers) {
        expect(header).toContain('Max-Age=0');
      }
    }
  });

  /**
   * The `__Host-` variant keeps `Secure` even when the environment does not
   * use it — a `__Host-` cookie without it is one the browser refuses, so the
   * clearing cookie would be discarded and the cookie it was meant to remove
   * would stay.
   */
  it('gives each name the attributes that name requires', () => {
    const [host, bare] = buildClearedSessionCookies(true);

    expect(host).toContain(`${SECURE_SESSION_COOKIE_NAME}=;`);
    expect(host).toContain('; Secure');
    expect(bare).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(bare).not.toContain('Secure');
  });

  /** The name of the current environment comes first. */
  it('leads with the name this environment sets', () => {
    expect(buildClearedSessionCookies(true)[0]).toContain(
      `${SECURE_SESSION_COOKIE_NAME}=;`,
    );
    expect(buildClearedSessionCookies(false)[0]).toStrictEqual(
      buildClearedSessionCookie({ secure: false }),
    );
  });
});

describe('readSessionToken', () => {
  it('reads back what buildSessionCookie wrote', () => {
    for (const secure of [false, true]) {
      const header = buildSessionCookie('a-token-value', {
        maxAgeSeconds: 60,
        secure,
      });
      const cookieHeader = header.split(';')[0];

      expect(readSessionToken(cookieHeader, secure)).toBe('a-token-value');
    }
  });

  /**
   * The point of the `__Host-` prefix, stated as a test: behind TLS a cookie
   * under the bare name is **not** a session token, no matter how well formed
   * it looks. Only a subdomain can produce one — no other host can write a
   * `__Host-` cookie — so accepting it would mean accepting a token an
   * attacker chose. This is the assertion that makes the prefix worth having;
   * without it the name is decoration.
   */
  it('refuses the bare name behind TLS, even on its own', () => {
    expect(
      readSessionToken(`${SESSION_COOKIE_NAME}=tossed`, true),
    ).toBeUndefined();
    expect(
      readSessionToken(
        `${SESSION_COOKIE_NAME}=tossed; ${SECURE_SESSION_COOKIE_NAME}=real`,
        true,
      ),
    ).toBe('real');
  });

  /**
   * And the mirror image over plain http, where a `__Host-` cookie cannot
   * exist at all — a browser refuses to store one without `Secure`. Reading
   * one there would mean trusting something no browser of ours ever sent.
   */
  it('refuses the __Host- name over plain http', () => {
    expect(
      readSessionToken(`${SECURE_SESSION_COOKIE_NAME}=real`, false),
    ).toBeUndefined();
    expect(
      readSessionToken(
        `${SECURE_SESSION_COOKIE_NAME}=real; ${SESSION_COOKIE_NAME}=local`,
        false,
      ),
    ).toBe('local');
  });

  it('reports no token for a cleared cookie', () => {
    expect(readSessionToken(`${SESSION_COOKIE_NAME}=`, false)).toBeUndefined();
    expect(
      readSessionToken(`${SECURE_SESSION_COOKIE_NAME}=`, true),
    ).toBeUndefined();
  });

  it('reports no token when no cookie header was sent', () => {
    expect(readSessionToken(undefined, false)).toBeUndefined();
    expect(readSessionToken(undefined, true)).toBeUndefined();
  });
});
