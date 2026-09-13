import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  formOverrideContext,
  systemSecretContext,
  tenantDefaultsContext,
  tenantOidcContext,
  tenantSmtpContext,
} from './secret-context';

const TENANT = randomUUID();
const FORM = randomUUID();

describe('secret contexts', () => {
  it('name the holder, the row and the field', () => {
    expect(formOverrideContext(TENANT, FORM, 'access.password')).toBe(
      `form-override:${TENANT}:${FORM}:access.password`,
    );
    expect(tenantDefaultsContext(TENANT, 'access.password')).toBe(
      `tenant-defaults:${TENANT}:access.password`,
    );
    expect(tenantOidcContext(TENANT, 'oidc.client_secret')).toBe(
      `tenant-oidc:${TENANT}:oidc.client_secret`,
    );
    expect(tenantSmtpContext(TENANT, 'smtp.password')).toBe(
      `tenant-smtp:${TENANT}:smtp.password`,
    );
  });

  /**
   * The holder with **no id** : `system_setting` has exactly
   * one row and belongs to no organisation, so an id here would be a constant
   * pretending to be a discriminator.
   */
  it('names the installation itself without an id', () => {
    expect(systemSecretContext('smtp.password')).toBe('system:smtp.password');
  });

  /**
   * The direction ADR-0013 no. 6 is about: the installation's mail password and
   * an organisation's are two different secrets, and no id can bring their contexts
   * together — not even an organisation whose id is the other holder's own literal.
   */
  it('cannot open the system’s mail password in any Organisation’s row', () => {
    expect(systemSecretContext('smtp.password')).not.toBe(
      tenantSmtpContext('system', 'smtp.password'),
    );
    expect(systemSecretContext('smtp.password')).not.toBe(
      tenantOidcContext('system', 'smtp.password'),
    );
  });

  /**
   * The collision argument, made a test rather than a claim: the two kinds
   * disagree in their first segment, which no id can supply — so no
   * combination of ids can make a form override's context equal a tenant
   * standard's. Without that, a form whose id happened to match could be
   * opened as a standard.
   */
  it('cannot be made to collide across the two kinds', () => {
    // The most adversarial ids available: the other kind's own literal.
    const asForm = formOverrideContext(
      'tenant-defaults',
      'tenant-defaults',
      'access.password',
    );
    const asDefaults = tenantDefaultsContext(
      'form-override',
      'access.password',
    );
    expect(asForm).not.toBe(asDefaults);
    expect(asForm.startsWith('form-override:')).toBe(true);
    expect(asDefaults.startsWith('tenant-defaults:')).toBe(true);
  });

  /**
   * The same argument for the third kind, and it needs its own
   * case: `tenant-oidc` has the **same arity** as `tenant-defaults`, so the
   * differing segment count that separated the first two says nothing here. The
   * fixed literal in position one is the whole of it — which is why the comment
   * on the constants insists the argument rests on that segment alone.
   */
  it('keeps the tenant’s two secrets apart although both name one row', () => {
    const asDefaults = tenantDefaultsContext(TENANT, 'oidc.client_secret');
    const asOidc = tenantOidcContext(TENANT, 'oidc.client_secret');
    expect(asDefaults).not.toBe(asOidc);
    // The most adversarial tenant id available: the other kind's own literal.
    expect(tenantOidcContext('tenant-defaults', 'access.password')).not.toBe(
      tenantDefaultsContext('tenant-oidc', 'access.password'),
    );
  });

  /**
   * The field segment, which is what the requirement's reproduction takes away.
   *
   * Same holder, same tenant, different field → different context, so a sealed
   * OIDC client secret cannot be moved into the access word of the same organisation and
   * read out through the settings page that is allowed to show one in clear.
   */
  it('separates the two secrets of one tenant by their field', () => {
    expect(tenantDefaultsContext(TENANT, 'access.password')).not.toBe(
      tenantDefaultsContext(TENANT, 'oidc.client_secret'),
    );
    expect(tenantDefaultsContext(TENANT, 'access.password')).not.toBe(
      tenantDefaultsContext(TENANT, 'smtp.password'),
    );
    expect(formOverrideContext(TENANT, FORM, 'access.password')).not.toBe(
      formOverrideContext(TENANT, FORM, 'oidc.client_secret'),
    );
  });

  it('separates different tenants, forms and fields', () => {
    const other = randomUUID();
    const contexts = new Set([
      formOverrideContext(TENANT, FORM, 'access.password'),
      formOverrideContext(other, FORM, 'access.password'),
      formOverrideContext(TENANT, other, 'access.password'),
      tenantDefaultsContext(TENANT, 'access.password'),
      tenantDefaultsContext(other, 'access.password'),
      tenantDefaultsContext(TENANT, 'oidc.client_secret'),
      tenantOidcContext(TENANT, 'oidc.client_secret'),
      tenantOidcContext(other, 'oidc.client_secret'),
      // The two mail passwords of the requirement: same tenant, same field, and
      // apart only because the holder differs — plus the installation's own,
      // which no tenant id can reach.
      tenantSmtpContext(TENANT, 'smtp.password'),
      tenantSmtpContext(other, 'smtp.password'),
      tenantOidcContext(TENANT, 'smtp.password'),
      systemSecretContext('smtp.password'),
    ]);
    expect(contexts.size).toBe(12);
  });

  /**
   * The separator may never be part of a value it separates — otherwise an id
   * could shift the segment boundary and impersonate another context. The
   * allowlist is what makes that impossible instead of merely unlikely, so an
   * id that does not come from the database is refused rather than encoded.
   */
  it('refuses a part that could shift the boundaries', () => {
    for (const evil of [
      `${TENANT}:${FORM}`,
      '',
      'has space',
      'quote"',
      `${TENANT}\n`,
    ]) {
      expect(() =>
        formOverrideContext(evil, FORM, 'access.password'),
      ).toThrow();
      expect(() =>
        formOverrideContext(TENANT, evil, 'access.password'),
      ).toThrow();
      expect(() => tenantDefaultsContext(evil, 'access.password')).toThrow();
      expect(() => tenantOidcContext(evil, 'oidc.client_secret')).toThrow();
      expect(() => tenantSmtpContext(evil, 'smtp.password')).toThrow();
    }
  });

  /** The failing part is named, because it is an id and never a secret. */
  it('says which part was wrong', () => {
    expect(() => formOverrideContext('a:b', FORM, 'access.password')).toThrow(
      /tenantId/,
    );
    expect(() => formOverrideContext(TENANT, 'a:b', 'access.password')).toThrow(
      /formId/,
    );
  });
});
