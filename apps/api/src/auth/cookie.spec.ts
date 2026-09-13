import { describe, expect, it } from 'vitest';

import { readCookie, serializeCookie } from './cookie';

const attributes = {
  maxAgeSeconds: 3600,
  httpOnly: true,
  sameSite: 'Lax',
  secure: false,
  path: '/',
} as const;

describe('serializeCookie', () => {
  it('writes the attributes the requirement requires', () => {
    const header = serializeCookie(
      'formsache_session',
      'token-value',
      attributes,
    );

    expect(header).toBe(
      'formsache_session=token-value; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly',
    );
  });

  it('adds Secure only when asked, so plain http keeps working locally', () => {
    expect(serializeCookie('a', 'b', attributes)).not.toContain('Secure');
    expect(
      serializeCookie('a', 'b', { ...attributes, secure: true }),
    ).toContain('; Secure');
  });

  it('omits HttpOnly when it is switched off — the flag is not decorative', () => {
    expect(
      serializeCookie('a', 'b', { ...attributes, httpOnly: false }),
    ).not.toContain('HttpOnly');
  });

  it('emits Max-Age=0 for a deletion', () => {
    expect(serializeCookie('a', '', { ...attributes, maxAgeSeconds: 0 })).toBe(
      'a=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly',
    );
  });

  /**
   * The injection case: a value carrying `;` would end the cookie and let the
   * rest be read as attributes — `Path`, or a second cookie entirely.
   */
  it('refuses a value that could forge further attributes', () => {
    expect(() =>
      serializeCookie(
        'formsache_session',
        'x; Path=/; HttpOnly=false',
        attributes,
      ),
    ).toThrow(/RFC 6265/);
  });

  it('refuses values with whitespace, quotes, commas or backslashes', () => {
    for (const value of ['a b', 'a"b', 'a,b', 'a\\b', 'a\nb']) {
      expect(() =>
        serializeCookie('formsache_session', value, attributes),
      ).toThrow();
    }
  });

  /**
   * The other end of the `cookie-octet` range. A check that only looks for
   * control characters and the four forbidden punctuation marks lets every
   * character above DEL through — an umlaut would then be serialised as UTF-8
   * bytes RFC 6265 does not allow in a cookie value.
   */
  it('refuses values above the printable ASCII range', () => {
    for (const value of ['grüß', 'a\u007Fb', 'a\u00A0b', 'a\u{1F511}b']) {
      expect(() =>
        serializeCookie('formsache_session', value, attributes),
      ).toThrow(/RFC 6265/);
    }
  });

  /**
   * `Path` goes into the header verbatim, so it is checked as strictly as the
   * value: a `;` there ends the attribute and everything after it is read as
   * attributes of its own — the same injection, one field over.
   */
  it('refuses a Path that could forge further attributes', () => {
    expect(() =>
      serializeCookie('formsache_session', 'v', {
        ...attributes,
        path: '/; SameSite=None',
      }),
    ).toThrow(/Path/);
  });

  it('refuses a Path that is not absolute or carries control characters', () => {
    for (const path of ['', 'api', '/a\nb', '/a\u0000b']) {
      expect(() =>
        serializeCookie('formsache_session', 'v', { ...attributes, path }),
      ).toThrow(/Path/);
    }
  });

  /**
   * A browser discards a `__Host-`/`__Secure-` cookie whose attributes do not
   * match the promise in its name — silently, which is the worst way to fail:
   * the login would look successful and every request after it would be
   * anonymous. Refusing to build such a header turns that into an error at the
   * one moment somebody can still act on it.
   */
  it('refuses a prefixed name whose attributes break the promise', () => {
    expect(() =>
      serializeCookie('__Host-formsache_session', 'v', attributes),
    ).toThrow(/Secure/);
    expect(() =>
      serializeCookie('__Secure-formsache_session', 'v', attributes),
    ).toThrow(/Secure/);
    expect(() =>
      serializeCookie('__Host-formsache_session', 'v', {
        ...attributes,
        secure: true,
        path: '/api',
      }),
    ).toThrow(/Path=\//);
  });

  it('accepts a prefixed name that keeps it', () => {
    const header = serializeCookie('__Host-formsache_session', 'v', {
      ...attributes,
      secure: true,
    });

    expect(header).toContain('__Host-formsache_session=v');
    expect(header).toContain('Path=/;');
    expect(header).toContain('; Secure');
    // `__Host-` also forbids `Domain`; this serialiser never emits one.
    expect(header).not.toContain('Domain');
  });

  /**
   * The same silent-discard class as the name prefixes above, one attribute
   * over: a browser drops a `SameSite=None` cookie that is not `Secure` and
   * says nothing about it. The type admits `None`, so the check has to be in
   * the serialiser — "no caller passes it today" is not a property that
   * survives the second caller, which is exactly the reasoning `Path` and the
   * prefixes already carry.
   */
  it('refuses SameSite=None without Secure', () => {
    expect(() =>
      serializeCookie('formsache_session', 'v', {
        ...attributes,
        sameSite: 'None',
      }),
    ).toThrow(/SameSite=None requires Secure/);
  });

  it('accepts SameSite=None together with Secure', () => {
    expect(
      serializeCookie('formsache_session', 'v', {
        ...attributes,
        sameSite: 'None',
        secure: true,
      }),
    ).toBe(
      'formsache_session=v; Path=/; Max-Age=3600; SameSite=None; HttpOnly; Secure',
    );
  });

  /** `Lax` and `Strict` carry no such requirement and must stay unaffected. */
  it('leaves Lax and Strict alone without Secure', () => {
    expect(
      serializeCookie('formsache_session', 'v', {
        ...attributes,
        sameSite: 'Strict',
      }),
    ).toContain('SameSite=Strict');
    expect(serializeCookie('formsache_session', 'v', attributes)).toContain(
      'SameSite=Lax',
    );
  });

  it('accepts an ordinary nested path', () => {
    expect(
      serializeCookie('formsache_session', 'v', {
        ...attributes,
        path: '/api/v1',
      }),
    ).toContain('Path=/api/v1');
  });

  it('never echoes the offending value into the error message', () => {
    // The value may be a session token; an error text is a log line waiting to
    // happen.
    expect(() =>
      serializeCookie('formsache_session', 'secret-token;evil', attributes),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('secret-token') as unknown,
      }) as Error,
    );
  });

  it('refuses a name that is not an HTTP token', () => {
    expect(() => serializeCookie('app session', 'v', attributes)).toThrow();
    expect(() => serializeCookie('', 'v', attributes)).toThrow();
  });

  it('refuses a negative or fractional Max-Age', () => {
    expect(() =>
      serializeCookie('a', 'b', { ...attributes, maxAgeSeconds: -1 }),
    ).toThrow();
    expect(() =>
      serializeCookie('a', 'b', { ...attributes, maxAgeSeconds: 1.5 }),
    ).toThrow();
  });

  it('accepts base64url output unchanged, which is all it ever carries', () => {
    const token = 'aA0_-zZ9';
    expect(serializeCookie('formsache_session', token, attributes)).toContain(
      `formsache_session=${token}`,
    );
  });
});

describe('readCookie', () => {
  it('returns undefined when there is no Cookie header at all', () => {
    expect(readCookie(undefined, 'formsache_session')).toBeUndefined();
  });

  it('returns undefined when the header holds other cookies', () => {
    expect(
      readCookie('theme=dark; lang=de', 'formsache_session'),
    ).toBeUndefined();
  });

  it('finds the cookie among several, in any position', () => {
    const header = 'theme=dark; formsache_session=abc; lang=de';
    expect(readCookie(header, 'formsache_session')).toBe('abc');
    expect(readCookie(header, 'theme')).toBe('dark');
    expect(readCookie(header, 'lang')).toBe('de');
  });

  it('tolerates missing and excess whitespace around the separators', () => {
    expect(
      readCookie('theme=dark;formsache_session=abc', 'formsache_session'),
    ).toBe('abc');
    expect(
      readCookie('   formsache_session   =   abc   ', 'formsache_session'),
    ).toBe('abc');
  });

  /**
   * The trap this whole function exists for: `startsWith` would hand out the
   * value of `formsache_session_theme` for `formsache_session`, and a guard would then
   * authenticate against an attacker-chosen cookie the browser lets any script
   * set.
   */
  it('does not match a name that merely shares a prefix', () => {
    expect(
      readCookie('formsache_session_theme=dark', 'formsache_session'),
    ).toBeUndefined();
    expect(
      readCookie('xformsache_session=evil', 'formsache_session'),
    ).toBeUndefined();
    expect(
      readCookie(
        'formsache_session_theme=dark; formsache_session=real',
        'formsache_session',
      ),
    ).toBe('real');
  });

  it('keeps everything after the first = inside the value', () => {
    expect(readCookie('formsache_session=abc=def==', 'formsache_session')).toBe(
      'abc=def==',
    );
  });

  it('treats a cleared cookie as absent', () => {
    expect(
      readCookie('formsache_session=', 'formsache_session'),
    ).toBeUndefined();
    expect(
      readCookie('formsache_session=   ', 'formsache_session'),
    ).toBeUndefined();
  });

  it('takes the first occurrence, as browsers do', () => {
    expect(
      readCookie(
        'formsache_session=first; formsache_session=second',
        'formsache_session',
      ),
    ).toBe('first');
  });

  /**
   * The two rules above meet here, and the combination is the interesting one:
   * "an empty value counts as absent" and "the first occurrence wins" together
   * used to mean that an empty cookie *hid* the real one behind it — which is
   * a header anybody who controls a subdomain can produce, since a cookie set
   * for the parent domain is presented alongside ours and the server cannot
   * tell the two apart. It failed closed, so it was never a way in; it was a
   * way to log every visitor out with one response. The search therefore skips
   * empty values and keeps looking.
   */
  it('looks past an empty value to the real cookie behind it', () => {
    expect(
      readCookie(
        'formsache_session=; formsache_session=real',
        'formsache_session',
      ),
    ).toBe('real');
    expect(
      readCookie(
        'formsache_session=   ; formsache_session=real',
        'formsache_session',
      ),
    ).toBe('real');
    expect(
      readCookie(
        'theme=dark; formsache_session=; x=1; formsache_session=real',
        'formsache_session',
      ),
    ).toBe('real');
    // Still absent when every occurrence is empty.
    expect(
      readCookie('formsache_session=; formsache_session=', 'formsache_session'),
    ).toBeUndefined();
  });

  it('skips a malformed segment instead of giving up on the header', () => {
    expect(
      readCookie('broken; formsache_session=abc', 'formsache_session'),
    ).toBe('abc');
    expect(
      readCookie('formsache_session', 'formsache_session'),
    ).toBeUndefined();
  });

  it('returns undefined for an empty header', () => {
    expect(readCookie('', 'formsache_session')).toBeUndefined();
  });
});
