import { TENANT_LOGO_REFS } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import { resolveTenantLogo } from './tenant-logo';

describe('resolveTenantLogo', () => {
  it.each(TENANT_LOGO_REFS)('resolves the shipped reference %s', (ref) => {
    // The completeness half of the requirement: the server delivers this list as
    // the choice an organisation has, so a reference it offers that resolves to nothing
    // would be a logo an admin can pick and never see. The type system covers
    // the other direction — a table entry that is not on the list will not
    // compile.
    //
    // This is the *only* place that direction is measured, and it goes through
    // `resolveTenantLogo`, so it measures the table itself. A second test used
    // to sit beside it comparing `BUNDLED_LOGO_REFS` with `TENANT_LOGO_REFS` —
    // but that export was a plain alias of the shared list, so it compared a
    // value with itself and stayed green whatever the table held. The export
    // existed for nothing else and went with it.
    expect(resolveTenantLogo({ kind: 'asset', ref })).toBeDefined();
  });

  it('has nothing for a tenant without a logo', () => {
    expect(resolveTenantLogo(null)).toBeUndefined();
  });

  it('has nothing for an unknown asset reference', () => {
    // The table is explicit for this reason: a reference from the database
    // must never become a URL the browser goes and fetches.
    expect(
      resolveTenantLogo({
        kind: 'asset',
        // The arm the payload schema would have refused — this function is the
        // second gate, and it holds without one.
        ref: 'uploads/../../etc/passwd' as never,
      }),
    ).toBeUndefined();
    expect(
      resolveTenantLogo({
        kind: 'asset',
        ref: 'https://example.org/logo.svg' as never,
      }),
    ).toBeUndefined();
  });

  it('has nothing for a name off the prototype chain', () => {
    // An object literal would answer these: `'__proto__'` with
    // `Object.prototype`, `'constructor'` with a function — values that are
    // not `undefined`, are typed `string`, and would end up in an `<img src>`.
    // `logoRef` comes from the database, so these are inputs, not curiosities.
    for (const key of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(
        resolveTenantLogo({ kind: 'asset', ref: key as never }),
      ).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // The uploaded logo (ADR-0014 no. 11a and no. 12)
  // -------------------------------------------------------------------------

  it('resolves an uploaded logo to the public file route', () => {
    expect(
      resolveTenantLogo({ kind: 'upload', ref: 'iM4a5oW1hLcVKQr3jd0lZQ' }),
    ).toBe('/api/public/files/iM4a5oW1hLcVKQr3jd0lZQ');
  });

  /**
   * The upload arm is the one that builds an address out of a database value,
   * so it is the one that has to be bounded — and it is bounded by the *shared*
   * predicate, not by a second spelling here.
   *
   * *reproduction:* drop the `isFileRef` guard in `tenant-logo.ts` → every case
   * below turns into an `<img src>` this application built out of a column, two
   * of them pointing at another origin.
   */
  it.each([
    '../../../etc/passwd',
    'https://fremd.example/logo.png',
    'javascript:alert(1)',
    'a b',
    '',
  ])('has nothing for the upload reference %j', (ref) => {
    expect(resolveTenantLogo({ kind: 'upload', ref })).toBeUndefined();
  });

  /**
   * The two arms do not share a resolver, and this is where that is measured:
   * a shipped reference in the `upload` arm does **not** become the bundled
   * asset, and a file reference in the `asset` arm does not become a URL.
   */
  it('never resolves one arm through the other resolver', () => {
    expect(
      resolveTenantLogo({ kind: 'upload', ref: 'assets/beispiel-signet.svg' }),
    ).toBeUndefined();
    expect(
      resolveTenantLogo({
        kind: 'asset',
        ref: 'iM4a5oW1hLcVKQr3jd0lZQ' as never,
      }),
    ).toBeUndefined();
  });
});
