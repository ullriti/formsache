import { describe, expect, it } from 'vitest';

import { OWNED_LOGO_INCLUDE, ownedLogoRef } from './owned-logo';

/**
 * **The ownership answer comes out of the loaded relation, never out of the
 * column** (ADR-0014 no. 12).
 *
 * This is the half of the check that can be proven without a database: given
 * what the query returned, which reference counts as proven? The other half —
 * that `tenant.files` really is this organisation's own set — is a property of the
 * foreign key and is measured at the four shores in
 * `test/files/branding-shores.spec.ts`.
 *
 * *Reproductions, run while writing this file:*
 * - Returning `tenant.logoRef` instead of the matched row's `publicRef` → „a
 *   reference the relation does not contain" goes red (measured: red).
 * - Widening the include's `where` past `kind: 'tenant_logo'` → nothing here
 *   moves, which is why the shore suite measures that one against a database.
 */
describe('ownedLogoRef ', () => {
  const OWN = 'iM4a5oW1hLcVKQr3jd0lZQ';
  const OTHER = 'ZHkQ2rTaP9sLcVK1jd0liM';

  it('proves a reference the relation contains', () => {
    expect(ownedLogoRef({ logoRef: OWN, files: [{ publicRef: OWN }] })).toBe(
      OWN,
    );
  });

  it('proves nothing for a reference the relation does not contain', () => {
    // The organisation has a Logo file; the column names a **different** one. That is
    // what a foreign reference looks like after a tenant-bound query: the
    // foreign row is simply not in the set.
    expect(ownedLogoRef({ logoRef: OTHER, files: [{ publicRef: OWN }] })).toBe(
      null,
    );
  });

  it('proves nothing when the relation was not loaded', () => {
    // The default of ADR-0014 no. 12: a shore that forgets the include loses
    // the Logo and can never deliver somebody else's.
    expect(ownedLogoRef({ logoRef: OWN })).toBeNull();
    expect(ownedLogoRef({ logoRef: OWN, files: [] })).toBeNull();
  });

  it('leaves a shipped asset to the gate', () => {
    // Not an upload, so not this function's business — `deliverableBranding`
    // reads it off the column against `TENANT_LOGO_REFS`.
    expect(
      ownedLogoRef({
        logoRef: 'assets/beispiel-signet.svg',
        files: [{ publicRef: OWN }],
      }),
    ).toBeNull();
  });

  it.each(['javascript:alert(1)', '../../etc/passwd', ''])(
    'proves nothing for %j, even if the relation held it',
    (logoRef) => {
      // A `logo_ref` written past the API can hold anything, and „die Query hat
      // es gefunden" says nothing about the shape of the string.
      expect(ownedLogoRef({ logoRef, files: [{ publicRef: logoRef }] })).toBe(
        null,
      );
    },
  );

  /**
   * **`__proto__` is a well-formed reference, and it is proven** — written down
   * because the shipped-asset list refuses it and somebody will expect the same
   * here.
   *
   * The two are different questions. `isTenantLogoRef` refuses it because an
   * object lookup would „find" it on the prototype chain; this value is never
   * a key, it is 22-odd characters of the `public_ref` alphabet, and if a
   * tenant-bound query returned it then it *is* that organisation's file. What the
   * union then guarantees is that it can only become an **address**
   * (`/api/public/files/__proto__`, a clean 404 for a row that does not exist),
   * never an index into a table — which is the whole reason ADR-0014 no. 12
   * refuses the prefix-string spelling.
   */
  it('proves __proto__ like any other reference of that shape', () => {
    expect(
      ownedLogoRef({
        logoRef: '__proto__',
        files: [{ publicRef: '__proto__' }],
      }),
    ).toBe('__proto__');
  });

  it('narrows the include to Logo rows and to one column', () => {
    // Read off the constant the four shores share: an include that also
    // brought `response_attachment` rows would let an *attachment* reference
    // in `logo_ref` be proven — the one row shape the `CHECK` of no. 3 cannot
    // rule out, because it is about the file, not about the tenant column.
    expect(OWNED_LOGO_INCLUDE.files.where).toEqual({ kind: 'tenant_logo' });
    expect(Object.keys(OWNED_LOGO_INCLUDE.files.select)).toEqual(['publicRef']);
  });
});
