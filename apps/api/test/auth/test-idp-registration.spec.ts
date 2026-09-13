import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIdp, type FakeIdp } from '@formsache/test-idp';

import { TEST_REDIRECT_URI } from './oidc-flow';

/**
 * **The test provider itself, at the one place at which it could be more
 * generous than Keycloak** (a review finding).
 *
 * No database, no application: here stands nothing about the form system,
 * but about the test double on which all statements of the requirement
 * rest. That is the reason why this file exists — a provider that accepts a
 * `redirect_uri` that is not registered makes the third reproduction
 * (the open redirector) unobservable, and namely in a run that is
 * green. A test double that demands less than reality lets the
 * application look better than it is.
 *
 * **Both** are checked, because there are two operating surfaces on
 * the same code: the programmatic path (`authorize`, which the
 * supertest suite drives) and the browser path (`POST /authorize`, which Playwright
 * drives). Only one case for the programmatic one proved nothing about the
 * return jump, and exactly the return jump is what is new.
 */

const CLIENT_ID = 'formular-registriert';
const CLIENT_SECRET = 'secret-of-registriert';
const FOREIGN_REDIRECT_URI = 'https://angreifer.invalid/faengt-den-code';

/** A PKCE pair, so a refusal below is never merely the missing challenge. */
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

/**
 * An authorization request as the application composes one — with every field
 * this provider requires, so exactly the deviation under test is the deviation.
 */
function authorizationUrl(
  idp: FakeIdp,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    scope: 'openid email',
    state: 'der-ausgestellte-state',
    nonce: 'der-ausgestellte-nonce',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  });
  return `${idp.origin}/authorize?${parameters.toString()}`;
}

/** The browser's half: fill in the provider's form and submit it. */
async function submitSignInForm(idp: FakeIdp, url: string): Promise<Response> {
  const body = new URLSearchParams({
    request: new URL(url).search.replace(/^\?/u, ''),
    sub: 'a-1',
    email: 'a-1@example.invalid',
  });
  return fetch(`${idp.origin}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    // Manual, because *whether* it redirects is the assertion.
    redirect: 'manual',
  });
}

describe('the test provider is registered, not obliging (@formsache/test-idp)', () => {
  let idp: FakeIdp;

  beforeAll(async () => {
    idp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET, {
      redirectUri: TEST_REDIRECT_URI,
    });
  });

  afterAll(async () => {
    await idp.close();
  });

  describe('the programmatic surface — what `apps/api`s suite drives', () => {
    it('issues a code for the registered client and address', () => {
      // The control: everything below refuses, so one case has to succeed, or
      // „refuses" would be indistinguishable from „refuses everything".
      const code = idp.authorize(authorizationUrl(idp), { sub: 'a-1' });
      expect(code.length).toBeGreaterThan(0);
    });

    it('refuses an unregistered `redirect_uri`', () => {
      expect(() =>
        idp.authorize(
          authorizationUrl(idp, { redirect_uri: FOREIGN_REDIRECT_URI }),
          { sub: 'a-1' },
        ),
      ).toThrow(/unregistered redirect_uri/u);
    });

    it('refuses a foreign `client_id`', () => {
      expect(() =>
        idp.authorize(authorizationUrl(idp, { client_id: 'fremder-client' }), {
          sub: 'a-1',
        }),
      ).toThrow(/unknown client/u);
    });
  });

  describe('the browser surface — what `e2e/` drives', () => {
    it('redirects to the registered address with `code` and `state`', async () => {
      const response = await submitSignInForm(idp, authorizationUrl(idp));

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(TEST_REDIRECT_URI);
      expect(location.searchParams.get('code')).not.toBeNull();
      expect(
        location.searchParams.get('state'),
        'Ohne `state` im Rücksprung könnte die Anwendung ihn gar nicht prüfen.',
      ).toBe('der-ausgestellte-state');
    });

    it('does not redirect anywhere when the `redirect_uri` is unregistered', async () => {
      const response = await submitSignInForm(
        idp,
        authorizationUrl(idp, { redirect_uri: FOREIGN_REDIRECT_URI }),
      );

      expect(
        response.status,
        'Der Browser-Weg darf nicht nachsichtiger sein als der programmatische.',
      ).toBe(400);
      expect(
        response.headers.get('location'),
        'Eine Ablehnung, die trotzdem weiterleitet, wäre selbst der offene ' +
          'Weiterleiter.',
      ).toBeNull();
      expect(await response.text()).toContain('unregistered redirect_uri');
    });

    it('does not redirect anywhere for a foreign `client_id`', async () => {
      const response = await submitSignInForm(
        idp,
        authorizationUrl(idp, { client_id: 'fremder-client' }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toContain('unknown client');
    });
  });
});
