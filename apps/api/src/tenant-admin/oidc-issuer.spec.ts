import { describe, expect, it } from 'vitest';

import { acceptableIssuer, issuerAllowList, issuerStamp } from './oidc-issuer';

/**
 * The predicate both gates of the requirement share.
 *
 * It needs its own unit test for the reason with a ⚠️:
 * the write gate and the delivery gate check the *same* predicate, so a
 * document that passes one and fails the other cannot exist — an integration
 * test can therefore never separate "gate two is gone" from "both are gone".
 * Each gate gets its own integration case that establishes its own
 * precondition (`test/tenant-admin/oidc-config.spec.ts`); this file is what
 * says the predicate itself is right.
 */
describe('acceptableIssuer', () => {
  it('accepts an https discovery base and hands it back unchanged', () => {
    expect(acceptableIssuer('https://idp.example.org')).toBe(
      'https://idp.example.org',
    );
    expect(acceptableIssuer('https://idp.example.org/realms/demo')).toBe(
      'https://idp.example.org/realms/demo',
    );
    // A non-standard port is a deployment detail, not a smell.
    expect(acceptableIssuer('https://idp.example.org:8443/realms/demo')).toBe(
      'https://idp.example.org:8443/realms/demo',
    );
  });

  /**
   * The normalisation, and the reason it exists: OIDC discovery appends
   * `/.well-known/openid-configuration`, and `…org//.well-known` is a 404 at
   * some providers and a different issuer at others.
   */
  it('removes trailing slashes so discovery is plain concatenation', () => {
    expect(acceptableIssuer('https://idp.example.org/')).toBe(
      'https://idp.example.org',
    );
    expect(acceptableIssuer('https://idp.example.org/realms/demo///')).toBe(
      'https://idp.example.org/realms/demo',
    );
  });

  /**
   * **The case that made this file necessary.** Zod 4's `z.url()` — which the
   * shared write schema uses — accepts every one of these: they parse as a
   * `URL`. `javascript:` is the one that matters most, because the value is
   * shown in the tab and would end up in an `href` the moment any view renders
   * it as a link; it is the same hole the Logo allow-list closes for
   * `logo_ref`.
   */
  it('refuses schemes that are not an OIDC discovery base', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://idp.example.org',
      'file:///etc/passwd',
      'not a url',
      '',
      '/realms/demo',
    ]) {
      expect(acceptableIssuer(raw), raw).toBeNull();
    }
  });

  /** Credentials in the address, a query and a fragment — all refused. */
  it('refuses an address that carries more than a base', () => {
    for (const raw of [
      'https://user:pw@idp.example.org',
      'https://user@idp.example.org',
      'https://idp.example.org/realms/demo?client_id=other',
      'https://idp.example.org/realms/demo#fragment',
    ]) {
      expect(acceptableIssuer(raw), raw).toBeNull();
    }
  });

  /**
   * Plain `http` only on loopback — the local test IdP of
   * `docs/kb/04-build-run.md`. Anywhere else it would put the client secret and
   * the authorization code on the wire in clear, and "it is only the test
   * environment after all" is how such a value reaches production.
   */
  it('allows http on loopback and nowhere else', () => {
    expect(acceptableIssuer('http://localhost:8080/realms/demo')).toBe(
      'http://localhost:8080/realms/demo',
    );
    expect(acceptableIssuer('http://127.0.0.1:8080/realms/demo')).toBe(
      'http://127.0.0.1:8080/realms/demo',
    );
    expect(acceptableIssuer('http://[::1]:8080/realms/demo')).toBe(
      'http://[::1]:8080/realms/demo',
    );
    for (const raw of [
      'http://idp.example.org',
      // The hostnames an attacker reaches for when "localhost" is matched by
      // substring rather than equality.
      'http://localhost.example.org',
      'http://notlocalhost',
      'http://127.0.0.1.example.org',
    ]) {
      expect(acceptableIssuer(raw), raw).toBeNull();
    }
  });
});

/**
 * **SSRF through configuration (a review finding).**
 *
 * An organisation admin — not the superadmin — chooses the host that the server then
 * calls up of its own accord. Before this hardening every `https` address was allowed,
 * so also the metadata service of the cloud (`169.254.169.254`) and every service
 * in the internal network.
 *
 * The counter-check to this file is the check itself: without the two
 * `isBlocked*` branches the cases below return the address instead of `null`.
 */
describe('acceptableIssuer — SSRF-Grenzen', () => {
  it('weist Adress-Literale aus privaten und Link-Local-Bereichen ab', () => {
    for (const raw of [
      'https://169.254.169.254/',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/realms/demo',
      'https://192.168.1.10/realms/demo',
      'https://172.16.0.1/realms/demo',
      'https://172.31.255.254/realms/demo',
      'https://100.64.0.1/realms/demo',
      'https://127.0.0.1/realms/demo',
      'https://0.0.0.0/realms/demo',
      'https://[::1]/realms/demo',
      'https://[fe80::1]/realms/demo',
      'https://[fd00::1]/realms/demo',
      'https://[::ffff:10.0.0.5]/realms/demo',
    ]) {
      expect(acceptableIssuer(raw), raw).toBeNull();
    }
  });

  /**
   * The floor under the block: a check that refuses *everything* would pass the
   * cases above just as well — and nobody could sign in any more.
   */
  it('lässt öffentliche Adressen durch, auch als Literal', () => {
    expect(acceptableIssuer('https://sso.example.org/realms/demo')).toBe(
      'https://sso.example.org/realms/demo',
    );
    // 172.15.x lies **outside** 172.16.0.0/12 — the edge of the range
    // at which a too widely drawn regular expression shows up.
    expect(acceptableIssuer('https://172.15.0.1/realms/demo')).toBe(
      'https://172.15.0.1/realms/demo',
    );
    expect(acceptableIssuer('https://100.63.0.1/realms/demo')).toBe(
      'https://100.63.0.1/realms/demo',
    );
  });

  /** The exception for development stays — it hangs on the `http` branch. */
  it('lässt die Loopback-Ausnahme für http unangetastet', () => {
    expect(acceptableIssuer('http://localhost:8080/realms/demo')).toBe(
      'http://localhost:8080/realms/demo',
    );
  });

  describe('die Positivliste des Betriebs', () => {
    it('lässt leer alles Öffentliche zu', () => {
      expect(issuerAllowList(undefined)).toStrictEqual([]);
      expect(issuerAllowList('  ')).toStrictEqual([]);
      expect(acceptableIssuer('https://sso.example.org', [])).toBe(
        'https://sso.example.org',
      );
    });

    it('lässt genannte Hosts und ihre Unterdomänen zu, sonst nichts', () => {
      const list = issuerAllowList('sso.example.org, idp.demo.de');
      expect(list).toStrictEqual(['sso.example.org', 'idp.demo.de']);

      expect(
        acceptableIssuer('https://sso.example.org/realms/demo', list),
      ).toBe('https://sso.example.org/realms/demo');
      expect(acceptableIssuer('https://a.idp.demo.de/realms/demo', list)).toBe(
        'https://a.idp.demo.de/realms/demo',
      );
      expect(acceptableIssuer('https://fremd.example.org', list)).toBeNull();
      // And the suffix trick: `bösesso.example.org` ends on the same
      // characters, but is a different host.
      expect(acceptableIssuer('https://boesesso.example.org', list)).toBeNull();
    });
  });
});

/**
 * **Der Stempel einer SSO-Einladung** (Review-Runde 5 Nr. 3).
 *
 * Er muss genau das sein, was die Anmeldung aus der Spalte errechnet — sonst
 * trägt eine Einladung einen Wert, den kein Login je trifft, und im Log steht
 * „the invitation was stamped with a different issuer" über eine Einladung, die
 * nie eine Chance hatte. Deshalb messen die drei Fälle nicht die Normalisierung
 * selbst (die steht oben), sondern die **Gleichheit** mit ihr.
 */
describe('issuerStamp', () => {
  it('ist für einen brauchbaren Wert dasselbe wie die Rechnung der Anmeldung', () => {
    for (const raw of [
      'https://konto.example.org/realms/hv',
      'https://konto.example.org/realms/hv/',
      'https://konto.example.org/realms/hv///',
      'http://localhost:8081/realms/test',
    ]) {
      expect(issuerStamp(raw)).toBe(acceptableIssuer(raw));
    }
  });

  it('nimmt der Spalte den Schluss-Schrägstrich, mit dem sie kein Login trifft', () => {
    expect(issuerStamp('https://konto.example.org/realms/hv/')).toBe(
      'https://konto.example.org/realms/hv',
    );
  });

  it('antwortet mit null, wenn nichts oder etwas Unbrauchbares hinterlegt ist', () => {
    // `null` heißt „damit darf nicht gestempelt werden": die Aufrufer machen
    // daraus eine Absage, statt eine Zeile zu schreiben, die niemand einlösen
    // kann.
    expect(issuerStamp(null)).toBeNull();
    expect(issuerStamp('javascript:alert(1)')).toBeNull();
    expect(issuerStamp('http://idp.example.org/realms/hv')).toBeNull();
  });
});
