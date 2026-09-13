import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import {
  ApiError,
  csrfHeaders,
  requestJson,
  requestUpload,
  requestVoid,
} from './http';

/**
 * **The transport seam of the frontend — and until 2026-08-12 without
 * assertions of its own** (a review finding).
 *
 * Every request of this application runs through `http.ts`. Of 19 modules in
 * `apps/web/src/api/`, two had a test; everything here was only dragged along
 * indirectly via view suites, and those assert on the **display**, never
 * on the **request**. As a result the CSRF header of every JSON mutation was
 * unmeasured: replacing `if (!SAFE_METHODS.has(…))` with `if (false)` left
 * `pnpm --filter @formsache/web test` completely green — the only occurrence in
 * the whole web codebase was a `toBeDefined()` on the *upload* path, which
 * does not touch `buildHeaders` at all.
 *
 * What stands here is therefore deliberately not an image of the implementation, but
 * the list of promises that this file makes to the outside.
 */
describe('http.ts — die Transportnaht', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'formsache_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie =
      '__Host-formsache_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  function headersOf(
    mock: ReturnType<typeof stubFetch>,
  ): Record<string, string> {
    const init = mock.mock.calls[0]?.[1];
    return (init?.headers ?? {}) as Record<string, string>;
  }

  describe('der CSRF-Header ', () => {
    it('reist bei jeder Mutation mit, mit dem Wert aus dem Cookie', async () => {
      document.cookie = 'formsache_csrf=der-echte-wert';
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

      await requestJson('/forms', { method: 'POST', body: { name: 'x' } });

      expect(headersOf(fetchMock)['X-CSRF-Token']).toBe('der-echte-wert');
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'auch bei %s',
      async (method) => {
        document.cookie = 'formsache_csrf=der-echte-wert';
        const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

        await requestJson('/etwas', { method });

        expect(headersOf(fetchMock)['X-CSRF-Token']).toBe('der-echte-wert');
      },
    );

    it('bleibt bei einem GET weg — dort erwartet der Server ihn nicht', async () => {
      document.cookie = 'formsache_csrf=der-echte-wert';
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

      await requestJson('/forms', { method: 'GET' });

      expect(headersOf(fetchMock)['X-CSRF-Token']).toBeUndefined();
    });

    /**
     * **The `__Host-` branch is not reachable via the e2e run**: it runs over
     * `http://`, so the server never sets the prefixed name. Server-side the
     * same promise is measured (`oidc-transaction.spec.ts`), client-side it was
     * not — changing `` `__Host-${…}` `` into `` `__Hst-${…}` `` left
     * `pnpm -r test` **and** `pnpm e2e` green, and a TLS installation would have
     * been unable to write.
     */
    it('liest hinter TLS den Namen mit __Host--Präfix', async () => {
      // `document.cookie = '__Host-…'` **is refused by jsdom** (the prefix
      // demands `Secure` and https), and that is exactly why this branch
      // was unmeasured at all. What is stubbed is the *source*, not the logic: what
      // is measured here is the client's name recognition — that a
      // browser sets the prefix is the promise of the server and checked there.
      vi.spyOn(document, 'cookie', 'get').mockReturnValue(
        '__Host-formsache_csrf=der-tls-wert',
      );
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

      await requestJson('/forms', { method: 'POST' });

      expect(headersOf(fetchMock)['X-CSRF-Token']).toBe('der-tls-wert');
    });

    it('geht ohne Token hinaus, statt die Anfrage zurückzuhalten', async () => {
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(200, {}));

      await requestJson('/forms', { method: 'POST' });

      // Before the first sign-in there is no session: the server then answers
      // 401 and not 403, and that is the answer the user
      // needs.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(headersOf(fetchMock)['X-CSRF-Token']).toBeUndefined();
      expect(csrfHeaders()).toStrictEqual({});
    });

    it('dekodiert den Cookie-Wert', () => {
      document.cookie = 'formsache_csrf=a%2Fb%2Bc';
      expect(csrfHeaders()).toStrictEqual({ 'X-CSRF-Token': 'a/b+c' });
    });
  });

  describe('Servermeldungen (nur 4xx)', () => {
    it('reicht den Satz einer 409 an den Aufrufer durch', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(409, { message: 'Das Formular hat keine E-Mail-Frage.' }),
      );

      await expect(requestJson('/x', { method: 'POST' })).rejects.toMatchObject(
        {
          status: 409,
          detail: 'Das Formular hat keine E-Mail-Frage.',
        },
      );
    });

    /**
     * **The 4xx boundary was documented and unmeasured.** `if (status < 400)`
     * instead of `if (status < 400 || status >= 500)` left the whole suite green —
     * and from then on Nest's "Internal server error" would stand in the interface where an
     * organisation admin expects a piece of advice.
     */
    it('nimmt die Meldung einer 500 **nicht** an', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(500, { message: 'Internal server error' }),
      );

      const error = await requestJson('/x', { method: 'POST' }).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).detail).toBeUndefined();
    });

    it('nimmt auch keine Meldung an, die kein Satz ist', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(400, { message: ['zu kurz', 'zu lang'] }),
      );

      const error = await requestJson('/x', { method: 'POST' }).catch(
        (thrown: unknown) => thrown,
      );
      expect((error as ApiError).detail).toBeUndefined();
    });
  });

  describe('Upload ', () => {
    /**
     * **The file name is percent-encoded** — a header carries no `ä`. The
     * existing case in `upload.spec.ts` encoded itself, so it measured its
     * own encoder instead of the client's.
     */
    it('kodiert den Dateinamen für den Header', async () => {
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(201, {}));
      const file = new File(['x'], 'Logo Größe.png', { type: 'image/png' });

      await requestUpload('/tenant/logo', file);

      expect(headersOf(fetchMock)['X-File-Name']).toBe(
        encodeURIComponent('Logo Größe.png'),
      );
      expect(headersOf(fetchMock)['X-File-Name']).not.toContain('ö');
    });

    it('nimmt die Kopfzeilen des Aufrufers mit — dort reist der CSRF-Header', async () => {
      document.cookie = 'formsache_csrf=der-echte-wert';
      const fetchMock = stubFetch().mockResolvedValue(jsonResponse(201, {}));
      const file = new File(['x'], 'w.png', { type: 'image/png' });

      await requestUpload('/tenant/logo', file, csrfHeaders());

      expect(headersOf(fetchMock)['X-CSRF-Token']).toBe('der-echte-wert');
    });
  });

  it('schickt die Sitzung nie über die Herkunft hinaus', async () => {
    const fetchMock = stubFetch().mockResolvedValue(emptyResponse(204));

    await requestVoid('/auth/logout', { method: 'POST' });

    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });
});
