import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { sessionUser } from '../test/fixtures';
import { fetchSessionUser, login, logout } from './auth';
import { ApiError } from './http';

describe('auth API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchSessionUser', () => {
    it('parses the session payload through the shared schema', async () => {
      const user = sessionUser();
      stubFetch().mockResolvedValue(jsonResponse(200, user));

      await expect(fetchSessionUser()).resolves.toEqual(user);
    });

    it('sends the session cookie and asks the API for JSON', async () => {
      const fetchMock = stubFetch().mockResolvedValue(
        jsonResponse(200, sessionUser()),
      );

      await fetchSessionUser();

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/me',
        expect.objectContaining({
          method: 'GET',
          // Same-origin is what makes the httpOnly cookie travel without CORS.
          credentials: 'same-origin',
        }),
      );
    });

    it('reports "no session" for 401 instead of failing', async () => {
      stubFetch().mockResolvedValue(emptyResponse(401));

      await expect(fetchSessionUser()).resolves.toBeNull();
    });

    it('rejects a payload that lost a required field', async () => {
      // The regression this guards against: a response without `name` used to
      // render a header with an empty user instead of stopping here.
      const { name, ...withoutName } = sessionUser();
      expect(name).not.toBe('');
      stubFetch().mockResolvedValue(jsonResponse(200, withoutName));

      await expect(fetchSessionUser()).rejects.toThrow();
    });

    it('rejects a payload whose field has the wrong type', async () => {
      stubFetch().mockResolvedValue(
        jsonResponse(200, { ...sessionUser(), memberships: 'alle' }),
      );

      await expect(fetchSessionUser()).rejects.toThrow();
    });

    it('propagates a server error as an ApiError with its status', async () => {
      stubFetch().mockResolvedValue(emptyResponse(500));

      await expect(fetchSessionUser()).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('login', () => {
    it('posts the credentials and returns the parsed user', async () => {
      const user = sessionUser();
      const fetchMock = stubFetch().mockResolvedValue(
        jsonResponse(200, { user }),
      );

      await expect(
        login({ email: 'admin@example.org', password: 'secret' }),
      ).resolves.toEqual(user);

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          body: JSON.stringify({
            email: 'admin@example.org',
            password: 'secret',
          }),
        }),
      );
    });

    it('rejects a login response without a user', async () => {
      stubFetch().mockResolvedValue(jsonResponse(200, {}));

      await expect(
        login({ email: 'admin@example.org', password: 'secret' }),
      ).rejects.toThrow();
    });

    it('surfaces 401 as an ApiError with status 401', async () => {
      stubFetch().mockResolvedValue(emptyResponse(401));

      await expect(
        login({ email: 'admin@example.org', password: 'wrong' }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('logout', () => {
    it('posts to the logout endpoint and accepts an empty 204', async () => {
      const fetchMock = stubFetch().mockResolvedValue(emptyResponse(204));

      await expect(logout()).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/logout',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
        }),
      );
    });

    it('fails when the server refuses', async () => {
      stubFetch().mockResolvedValue(emptyResponse(500));

      await expect(logout()).rejects.toBeInstanceOf(ApiError);
    });
  });
});
