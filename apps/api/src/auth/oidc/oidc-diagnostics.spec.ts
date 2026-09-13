import { describe, expect, it } from 'vitest';

import {
  NON_STANDARD_CODE,
  OidcIdTokenRefusedError,
  describeFailure,
  issuerScheme,
  maskAddress,
} from './oidc-diagnostics';

/**
 * **The one seam through which foreign data reach the log** — and the check
 * that it stays narrow.
 *
 * Every case here has two halves, and the second is the real one: *what
 * is in it* (so that an operator gets something out of it) **and** *what is not
 * in it* (so that the line may be passed on). A test that checked only the
 * first half would let through the extension that next year
 * takes `error_description` along, because it is so helpful after all.
 */

describe('describeFailure', () => {
  it('nennt die Klasse einer Ausnahme', () => {
    expect(describeFailure(new TypeError('fetch failed'))).toBe('TypeError');
  });

  it('gibt die **Meldung** einer Ausnahme nie weiter', () => {
    // The message of `openid-client` quotes the provider's response, that of
    // Prisma the values of the query. Both are the reason why
    // `test/observability/log-hygiene.spec.ts` forbids `error.message` across the
    // project — and why this function exists.
    const secretish = new Error('client_secret=hunter2 rejected by idp');
    expect(describeFailure(secretish)).toBe('Error');
    expect(describeFailure(secretish)).not.toContain('hunter2');
  });

  it('hängt den normierten Protokollfehlercode an', () => {
    // The shape in which `oauth4webapi` throws them: the class plus an `error` field.
    const refused = Object.assign(new Error('…'), {
      name: 'ResponseBodyError',
      error: 'invalid_client',
      error_description: 'Client authentication failed for realm demo',
    });

    expect(describeFailure(refused)).toBe('ResponseBodyError/invalid_client');
    // **The second half.** `error_description` is written freely by the provider; it
    // is the most convenient and the wrong way to make a line more helpful.
    expect(describeFailure(refused)).not.toContain('realm demo');
  });

  it('ersetzt einen Code, den keine Norm kennt, durch einen festen', () => {
    // With the redirect error, `error` comes from the **query string** of the
    // callback — which the caller writes. Unfiltered, a string chosen from
    // outside would stand in the operator's log file, which `requestId`
    // has long since prevented for `X-Request-Id` elsewhere.
    const forged = Object.assign(new Error('…'), {
      name: 'AuthorizationResponseError',
      error: 'gewählt-von-aussen\n{"level":"error"}',
    });

    expect(describeFailure(forged)).toBe(
      `AuthorizationResponseError/${NON_STANDARD_CODE}`,
    );
  });

  it('lässt einen normierten Code des Autorisierungsendpunkts durch', () => {
    const cancelled = Object.assign(new Error('…'), {
      name: 'AuthorizationResponseError',
      error: 'access_denied',
    });

    expect(describeFailure(cancelled)).toBe(
      'AuthorizationResponseError/access_denied',
    );
  });

  /**
   * **The case that triggered the finding.** A discovery that fails at
   * name resolution, certificate or timeout arrives in Node
   * as `TypeError: fetch failed`. The old line read „… failed:
   * TypeError" — the actual reason lay one `cause` layer deeper and was
   * never read.
   */
  it('holt den Transportcode aus der cause-Kette', () => {
    const dns = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND sso.example.org'), {
        code: 'ENOTFOUND',
      }),
    });

    expect(describeFailure(dns)).toBe('TypeError/ENOTFOUND');
  });

  it('findet ihn auch zwei Lagen tief — undici verpackt gern noch einmal', () => {
    const tls = new TypeError('fetch failed', {
      cause: new Error('outer', {
        cause: Object.assign(new Error('inner'), {
          code: 'CERT_HAS_EXPIRED',
        }),
      }),
    });

    expect(describeFailure(tls)).toBe('TypeError/CERT_HAS_EXPIRED');
  });

  it('nimmt als Transportcode nur, was wie einer aussieht', () => {
    // Shape-checked, because `code` is an arbitrary field of an arbitrary object.
    const odd = new TypeError('fetch failed', {
      cause: { code: 'irgendein Freitext mit Leerzeichen und \n Umbruch' },
    });

    expect(describeFailure(odd)).toBe('TypeError');
  });

  it('läuft in einer selbstbezüglichen cause-Kette nicht fest', () => {
    const loop: { cause?: unknown; code?: unknown } = {};
    loop.cause = loop;
    const error = new Error('x', { cause: loop });

    expect(describeFailure(error)).toBe('Error');
  });

  it('nennt bei unserer eigenen Ablehnung, welche es war', () => {
    // Both cases were bare `new Error(...)` and visible in the log as `Error`
    // — indistinguishable from a timeout. That is exactly
    // the defect the named class fixes.
    expect(
      describeFailure(new OidcIdTokenRefusedError('issuer-mismatch')),
    ).toBe('OidcIdTokenRefusedError/issuer-mismatch');
    expect(describeFailure(new OidcIdTokenRefusedError('no-id-token'))).toBe(
      'OidcIdTokenRefusedError/no-id-token',
    );
  });

  it('kommt auch mit etwas zurecht, das gar keine Ausnahme ist', () => {
    expect(describeFailure('boom')).toBe('unknown failure');
    expect(describeFailure(undefined)).toBe('unknown failure');
  });
});

describe('maskAddress', () => {
  it('lässt Anfangsbuchstabe und Domäne stehen', () => {
    expect(maskAddress('max.mustermann@verein.example')).toBe(
      'm***@verein.example',
    );
  });

  it('gibt den lokalen Teil nie preis', () => {
    const masked = maskAddress('vorstand.geschaeftsstelle@verein.example');
    expect(masked).not.toContain('vorstand');
    expect(masked).not.toContain('geschaeftsstelle');
  });

  /**
   * `readVerifiedEmail` only checks that the claim is a non-empty string
   * — **not** that it is an address. A provider that puts free text
   * in there would otherwise write it into the operator's log file.
   */
  it('kürzt und säubert, was ein Anbieter statt einer Adresse schickt', () => {
    const flood = `a@${'x'.repeat(500)}.example`;
    expect(maskAddress(flood).length).toBeLessThanOrEqual(46);

    const injected = maskAddress('a@verein.example\n{"level":"error"}');
    expect(injected).not.toContain('\n');
    expect(injected).toBe('a***@verein.example');
  });

  it('antwortet mit nichts Verwertbarem, wenn da keine Adresse steht', () => {
    expect(maskAddress('kein-at-zeichen')).toBe('***');
    expect(maskAddress('@verein.example')).toBe('***');
    expect(maskAddress('a@')).toBe('***');
  });
});

describe('issuerScheme', () => {
  it('nennt das Schema — die häufigste Ursache einer abgelehnten Spalte', () => {
    expect(issuerScheme('https://sso.example.org/realms/demo')).toBe('https');
    expect(issuerScheme('http://sso.example.org')).toBe('http');
    expect(issuerScheme('javascript:alert(1)')).toBe('javascript');
  });

  it('gibt den Wert selbst nicht zurück', () => {
    // A refused column has by definition never gone through the write gate,
    // and is therefore foreign input — the same decision as in
    // `OidcConfigService.toConfig`, with the same reasoning.
    expect(issuerScheme('https://user:pw@idp.example.org')).not.toContain('pw');
    expect(issuerScheme('nicht einmal eine Adresse')).toBe('not-a-url');
  });
});
