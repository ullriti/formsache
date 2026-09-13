import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnv, OidcConfigWrite } from '@formsache/shared';

import type { PublicUrlService } from '../common/public-url/public-url.service';
import type { OidcUpdateResult, TenantScope } from '../tenancy/tenant-scope';
import { OidcConfigService } from './oidc-config.service';
import type { OidcSecretsService } from './oidc-secrets.service';

/**
 * **What the log says when a save re-stamps invitations** (Review-Runde 5 no. 3).
 *
 * The re-stamp itself is a statement of `ScopedTenantDelegate.updateOidc` and is
 * measured there (`tenancy/tenant-scope.spec.ts`) and against a real database
 * (`test/auth/oidc-issuer-change.spec.ts`). What is measured **here** is
 * the other half of the finding: the write was invisible. An operator who reads
 * „found no redeemable invitation" in the log of a support case has to be able
 * to find the moment the stamps moved.
 *
 * **Nicht** gemessen wird hier „und keine Adresse in der Zeile": in diesem
 * Aufbau betritt keine Adresse das System unter Test, die Zusicherung wäre also
 * grün, egal was die Zeile tut (Befund des Reviews). Der Anspruch steht am Code
 * und ist dort messbar, wo Adressen vorliegen.
 *
 * Without a database and without HTTP, because both halves are properties of
 * this one method: it either passes the count on or it does not.
 */
describe('OidcConfigService reports a re-stamping', () => {
  const TENANT_ID = '019fb000-0000-7000-8000-0000000000a1';
  const ISSUER = 'https://konto.hilaren.invalid/realms/hv';

  const REQUEST: OidcConfigWrite = {
    enabled: true,
    issuer: ISSUER,
    clientId: 'formsache',
    scopes: ['openid', 'email'],
    emailClaim: 'email',
    emailVerifiedClaim: 'email_verified',
    buttonLabel: null,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The service with doubles for its three dependencies, and a `TenantScope`
   * whose `updateOidc` answers whatever the case is about.
   */
  function service(result: OidcUpdateResult): {
    readonly service: OidcConfigService;
    readonly scope: TenantScope;
  } {
    const secrets = {
      isUsable: () => true,
      seal: () => new Uint8Array([1, 2, 3]),
      open: () => 'ein-geheimnis',
    } as unknown as OidcSecretsService;
    const publicUrl = {
      oidcCallbackUrl: () =>
        Promise.resolve(
          'https://formulare.test.invalid/api/auth/oidc/callback',
        ),
    } as unknown as PublicUrlService;
    const scope = {
      tenantId: TENANT_ID,
      tenant: {
        find: () =>
          Promise.resolve({
            id: TENANT_ID,
            oidcEnabled: false,
            oidcIssuer: 'https://idp.alt.invalid/realms/hv',
            oidcClientId: 'formsache',
            oidcClientSecret: new Uint8Array([1, 2, 3]),
            oidcScopes: ['openid', 'email'],
            oidcEmailClaim: 'email',
            oidcEmailVerifiedClaim: 'email_verified',
            oidcButtonLabel: null,
          }),
        updateOidc: () => Promise.resolve(result),
      },
    } as unknown as TenantScope;
    return {
      service: new OidcConfigService(secrets, publicUrl, {
        OIDC_ISSUER_ALLOWLIST: undefined,
      } as unknown as ApiEnv),
      scope,
    };
  }

  it('names the count, the organisation and the new issuer', async () => {
    const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      // Swallowed rather than printed: the assertion is on the argument.
    });
    const { service: subject, scope } = service({
      written: true,
      restamped: 3,
    });

    await subject.replaceOfTenant(scope, REQUEST);

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('3');
    expect(line).toContain(TENANT_ID);
    expect(line).toContain(ISSUER);
    /*
      **Hier stand „und keine Adresse".** Die Zusicherung ist gestrichen, weil
      sie nichts gemessen hat: in diesem Aufbau betritt keine Adresse das System
      unter Test — es gibt kein Konto, keine Zeile, kein Repository —, und ein
      Issuer enthält kein `@`. Sie wäre grün geblieben, was die Logzeile auch
      täte. Der Anspruch bleibt und steht dort, wo er hingehört: an der Zeile
      selbst (`oidc-config.service.ts`) und an der Auswahl, die sie zählt
      (`restampableAccount`) — messbar ist er nur, wo Adressen wirklich
      vorliegen, und das ist die Integrationsprüfung.
    */
  });

  /**
   * **Silence when nothing moved.** The ordinary save of the tab changes no
   * issuer, and a line on every save would make the one that matters
   * unfindable — the same reasoning `reportOnce` follows one method further
   * down.
   */
  it('says nothing when no invitation was re-stamped', async () => {
    const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {
      // See above.
    });
    const { service: subject, scope } = service({
      written: true,
      restamped: 0,
    });

    await subject.replaceOfTenant(scope, REQUEST);

    expect(logged).not.toHaveBeenCalled();
  });
});
