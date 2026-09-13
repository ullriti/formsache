import { describe, expect, it } from 'vitest';

import type { SystemMailSettingsService } from '../../system-settings/system-mail-settings.service';
import { captureStdio } from '../../../test/mail/stdio-capture';
import { PublicUrlService } from './public-url.service';
import type { TenantBaseUrlRepository } from './tenant-base-url.repository';

/**
 * **A review finding.** `resolveBaseUrl`'s normalisation
 * branch for the *tenant* column had no unit proof at all — every DB-backed
 * suite that touches this service only ever writes a value that already
 * passes `normaliseBaseUrl` (`TEST_PUBLIC_BASE_URL`, or nothing). An edit
 * that dropped `normaliseBaseUrl(own)` from `resolveBaseUrl` — returning the
 * raw column whenever it is non-null — would leave every existing test green
 * while `public_base_url = ''` produced `'' + '/a/<token>'`: a relative path
 * in a mail nobody can recall.
 *
 * Fakes instead of `TestDatabase`: the whole subject is a pure function of
 * two strings and their precedence, and a database round trip would measure
 * the fixture rather than the branch. `PublicUrlService` takes both
 * collaborators through its constructor already — no `PrismaService`
 * anywhere in this file (`eslint.config.js`'s allow-list stays about the two
 * files that actually read a row).
 */
function serviceWith(options: {
  readonly ownTenant: string | null;
  readonly system: string | null;
}): PublicUrlService {
  const tenantBaseUrls = {
    findOwn: () => Promise.resolve(options.ownTenant),
  } as unknown as TenantBaseUrlRepository;
  const systemSettings = {
    publicBaseUrl: () => Promise.resolve(options.system),
  } as unknown as SystemMailSettingsService;
  return new PublicUrlService(systemSettings, tenantBaseUrls);
}

describe('PublicUrlService.resolveBaseUrl normalises the organisation column, not only the system one (a review finding)', () => {
  it('falls through to the system default when the tenant column is an empty string', async () => {
    const service = serviceWith({
      ownTenant: '',
      system: 'https://system.test.invalid',
    });
    expect(await service.resolveBaseUrl('tenant-a')).toBe(
      'https://system.test.invalid',
    );
  });

  it('falls through to the system default when the tenant column does not parse as a base address', async () => {
    const service = serviceWith({
      ownTenant: 'nicht-url',
      system: 'https://system.test.invalid',
    });
    expect(await service.resolveBaseUrl('tenant-a')).toBe(
      'https://system.test.invalid',
    );
  });

  it('normalises a valid tenant address — trailing slash dropped — and prefers it over a set system default', async () => {
    const service = serviceWith({
      ownTenant: 'https://a.test/',
      system: 'https://system.test.invalid',
    });
    expect(await service.resolveBaseUrl('tenant-a')).toBe('https://a.test');
  });

  it('answers null when neither the tenant column nor the system default is usable', async () => {
    const service = serviceWith({ ownTenant: '', system: null });
    expect(await service.resolveBaseUrl('tenant-a')).toBeNull();
  });

  it('answers null when the tenant has never set a column and the system has none either', async () => {
    const service = serviceWith({ ownTenant: null, system: null });
    expect(await service.resolveBaseUrl('tenant-a')).toBeNull();
  });
});

/**
 * **A review finding.** An unparseable *system* default was already reported
 * (`SystemMailSettingsService.publicBaseUrl`); an unparseable *tenant*
 * override was not, so an organisation whose own address never worked sent every mail
 * under the installation's address with nothing telling anyone why. The value
 * itself stays out of the line — same posture as the system column and the
 * OIDC issuer — but the tenant id has to be there, and it has to be
 * there only once per organisation, not once per request.
 */
describe('an unusable tenant override is reported once per organisation, without the value (a review finding)', () => {
  it('logs the tenant id, not the stored value, the first time', async () => {
    const service = serviceWith({
      ownTenant: 'www.Organisation-a.de',
      system: 'https://system.test.invalid',
    });
    const capture = captureStdio();
    try {
      await service.resolveBaseUrl('tenant-a');
      expect(capture.countOf('tenant-a')).toBeGreaterThanOrEqual(1);
      expect(capture.text()).not.toContain('www.Organisation-a.de');
    } finally {
      capture.restore();
    }
  });

  it('does not repeat the line for the same organisation on a second call', async () => {
    const service = serviceWith({
      ownTenant: 'www.Organisation-a.de',
      system: 'https://system.test.invalid',
    });
    const capture = captureStdio();
    try {
      await service.resolveBaseUrl('tenant-a');
      await service.resolveBaseUrl('tenant-a');
      expect(capture.countOf('tenant.public_base_url of tenant tenant-a')).toBe(
        1,
      );
    } finally {
      capture.restore();
    }
  });
});
