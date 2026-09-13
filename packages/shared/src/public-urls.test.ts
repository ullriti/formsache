import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_INVITATION_SEGMENT,
  PASSWORD_RESET_SEGMENT,
  PUBLIC_FORM_SEGMENT,
  RESPONSE_EDIT_SEGMENT,
  accountInvitationPath,
  passwordResetPath,
  publicFormPath,
  responseEditPath,
} from './public-urls.ts';

/**
 * The public paths.
 *
 * They live in `packages/shared` because two consumers on opposite sides of the
 * wire need the same string — the browser's router and the server, which has to
 * turn one into an absolute link for a mail. What these tests pin down is the
 * property that makes the sharing worth anything: the two segments are stable,
 * and nothing a token or a slug can contain escapes the path.
 */
describe('public paths', () => {
  it('addresses a published form under /f/', () => {
    expect(publicFormPath('AbCd_1234-xyz')).toBe('/f/AbCd_1234-xyz');
    expect(PUBLIC_FORM_SEGMENT).toBe('f');
  });

  it('addresses one submitted answer under /a/', () => {
    expect(responseEditPath('AbCd_1234-xyz')).toBe('/a/AbCd_1234-xyz');
    expect(RESPONSE_EDIT_SEGMENT).toBe('a');
  });

  /**
   * The two segments must not collide — `/a/<token>` and `/f/<slug>` are read
   * by the same router, and a shared prefix would make one of them unreachable.
   */
  it('keeps the two public segments distinct', () => {
    expect(RESPONSE_EDIT_SEGMENT).not.toBe(PUBLIC_FORM_SEGMENT);
  });

  /**
   * Reset and invitation (ADR-0020, ADR-0024) — **two addresses, one
   * token**.
   *
   * The server does not distinguish the two on redemption; what the address
   * carries is the wording of the page. Two things therefore have to be right: the
   * segments are different (otherwise the difference would not exist), and both
   * escape their token (otherwise a hand-written link would address
   * a different route).
   */
  it('addresses the two account links under distinct segments', () => {
    expect(passwordResetPath('AbCd_1234-xyz')).toBe('/password/AbCd_1234-xyz');
    expect(accountInvitationPath('AbCd_1234-xyz')).toBe(
      '/invitation/AbCd_1234-xyz',
    );
    expect(ACCOUNT_INVITATION_SEGMENT).not.toBe(PASSWORD_RESET_SEGMENT);
  });

  it('escapes the token of an invitation link too', () => {
    expect(accountInvitationPath('a/b')).toBe('/invitation/a%2Fb');
  });

  /**
   * A real token is base64url and needs no escaping — which is exactly why the
   * probe here is *not* one. A value that could break out of its segment has to
   * come back escaped, or a token from an older format (or a hand-typed link)
   * would silently address a different route.
   */
  it.each([
    ['a slash', 'a/b', '/a/a%2Fb'],
    ['a question mark', 'a?b', '/a/a%3Fb'],
    ['a hash', 'a#b', '/a/a%23b'],
    ['a space', 'a b', '/a/a%20b'],
  ])('escapes %s in the token', (_name, token, expected) => {
    expect(responseEditPath(token)).toBe(expected);
  });
});
