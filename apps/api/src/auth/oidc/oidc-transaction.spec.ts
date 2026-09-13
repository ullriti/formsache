import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  OIDC_COOKIE_NAME,
  OIDC_TRANSACTION_TTL_SECONDS,
  SECURE_OIDC_COOKIE_NAME,
  buildClearedOidcCookies,
  buildOidcTransactionCookie,
  newOidcTransaction,
  readOidcTransaction,
  stateMatches,
  stateParameter,
} from './oidc-transaction';

/**
 * The transaction cookie of the OIDC login.
 *
 * Unit tests, next to the source, exactly like `cookie.spec.ts` and
 * `session-cookie.spec.ts`: the attributes that make this cookie safe are
 * asserted **literally**, because they are the ones a refactor could quietly
 * drop and no integration test would notice — a login works perfectly well
 * without `HttpOnly`.
 */

const TENANT = '01919c3f-0000-7000-8000-00000000abcd';

function transaction(now = new Date()) {
  return newOidcTransaction(TENANT, 'verifier-of-the-flow', now);
}

describe('the state that travels in the address', () => {
  it('is the digest of the cookie value, never the value itself', () => {
    const flow = transaction();
    expect(stateParameter(flow)).toBe(
      createHash('sha256').update(flow.stateSecret).digest('base64url'),
    );
    // The whole point: a `state` read out of a provider log, a browser history
    // or a `Referer` cannot be turned back into the secret that authorises the
    // callback.
    expect(stateParameter(flow)).not.toBe(flow.stateSecret);
  });

  it('accepts its own state and refuses another transaction’s', () => {
    const mine = transaction();
    const other = transaction();
    expect(stateMatches(mine, stateParameter(mine))).toBe(true);
    expect(stateMatches(mine, stateParameter(other))).toBe(false);
  });

  it('refuses a truncated or padded state', () => {
    const flow = transaction();
    const state = stateParameter(flow);
    expect(stateMatches(flow, state.slice(0, -1))).toBe(false);
    expect(stateMatches(flow, `${state}x`)).toBe(false);
    expect(stateMatches(flow, '')).toBe(false);
  });

  it('mints a fresh secret and nonce per flow', () => {
    const first = transaction();
    const second = transaction();
    expect(first.stateSecret).not.toBe(second.stateSecret);
    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe('the cookie', () => {
  it('carries HttpOnly, SameSite=Lax and a ten-minute life', () => {
    const header = buildOidcTransactionCookie(transaction(), { secure: false });
    expect(header.startsWith(`${OIDC_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('HttpOnly');
    // `Lax` and not `Strict`: the provider sends the browser back with a
    // top-level GET from *its* origin, and `Strict` would withhold the cookie
    // exactly there.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${String(OIDC_TRANSACTION_TTL_SECONDS)}`);
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Secure');
  });

  it('uses the `__Host-` name behind TLS', () => {
    const header = buildOidcTransactionCookie(transaction(), { secure: true });
    expect(header.startsWith(`${SECURE_OIDC_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('Secure');
  });

  it('never puts the state that travelled in the address into the cookie', () => {
    const flow = transaction();
    const header = buildOidcTransactionCookie(flow, { secure: false });
    expect(header).not.toContain(stateParameter(flow));
  });

  it('round-trips a transaction', () => {
    const flow = transaction();
    const header = buildOidcTransactionCookie(flow, { secure: false });
    const [pair] = header.split(';');
    expect(readOidcTransaction(pair, false)).toEqual(flow);
  });

  it('reads nothing under the other name', () => {
    const flow = transaction();
    const [pair] = buildOidcTransactionCookie(flow, { secure: false }).split(
      ';',
    );
    // Behind TLS only the `__Host-` name counts — the same rule
    // `readSessionToken` follows, and for the same cookie-tossing reason.
    expect(readOidcTransaction(pair, true)).toBeUndefined();
  });

  it('refuses a cookie that is not our own payload', () => {
    for (const value of [
      undefined,
      `${OIDC_COOKIE_NAME}=`,
      `${OIDC_COOKIE_NAME}=nicht-base64url-json`,
      `${OIDC_COOKIE_NAME}=${Buffer.from('{"t":"nope"}').toString('base64url')}`,
      `${OIDC_COOKIE_NAME}=${Buffer.from('[]').toString('base64url')}`,
    ]) {
      expect(readOidcTransaction(value, false)).toBeUndefined();
    }
  });

  it('refuses an expired transaction', () => {
    const start = new Date('2026-07-30T10:00:00Z');
    const flow = transaction(start);
    const [pair] = buildOidcTransactionCookie(flow, { secure: false }).split(
      ';',
    );
    const justInside = new Date(
      start.getTime() + OIDC_TRANSACTION_TTL_SECONDS * 1000 - 1,
    );
    const justOutside = new Date(
      start.getTime() + OIDC_TRANSACTION_TTL_SECONDS * 1000,
    );
    expect(readOidcTransaction(pair, false, justInside)).toBeDefined();
    expect(readOidcTransaction(pair, false, justOutside)).toBeUndefined();
  });

  it('clears both names, each with the attributes its name requires', () => {
    const cleared = buildClearedOidcCookies(false);
    expect(cleared).toHaveLength(2);
    // A `__Host-` cookie without `Secure` is one the browser refuses outright,
    // so the clearing one has to carry it too.
    expect(
      cleared.find((value) => value.startsWith(SECURE_OIDC_COOKIE_NAME)),
    ).toContain('Secure');
    for (const header of cleared) {
      expect(header).toContain('Max-Age=0');
    }
    // The name of the current environment comes first, as in
    // `buildClearedSessionCookies`.
    expect(cleared[0]?.startsWith(`${OIDC_COOKIE_NAME}=`)).toBe(true);
    expect(
      buildClearedOidcCookies(true)[0]?.startsWith(SECURE_OIDC_COOKIE_NAME),
    ).toBe(true);
  });
});
