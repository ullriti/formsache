import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import {
  tenantBrandingWriteSchema,
  type TenantBrandingSettings,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest } from '../common/parse-request';
import { FILE_NAME_HEADER } from '../files/upload-pipeline';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TenantBrandingService } from './tenant-branding.service';
import { TenantLogoService } from './tenant-logo.service';

/**
 * The transport shape the upload route touches — three headers and the body as
 * a stream, exactly like `public/public-files.controller.ts`.
 *
 * A structural interface keeps `@types/express` out of the dependency list and
 * makes the seam obvious: the body is a `Readable` and nothing else, which is
 * the whole of ADR-0014 no. 14.
 */
interface LogoUploadRequest extends Readable {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * The organisation's appearance — the *Erscheinungsbild & Login* tab, colour half
 * (the requirements, handoff). The login half is `oidc-config.*`: a
 * client secret has no business travelling next to a colour.
 *
 * **There is no tenant id in the path, and that is the security design, not a
 * shortcut** — the same statement `/api/tenant/form-defaults` makes. The branding addressed here is always the one of the session's
 * *active* Organisation, resolved by `TenantScopeGuard` from a membership the caller
 * actually holds, so a request has no way to *name* another organisation and there is
 * nothing to refuse. Someone who wants another organisation's colours has to switch
 * into it first, which is exactly the boundary the tenant switcher draws.
 *
 * The guard chain follows the same order: session → tenant
 * scope → group permission. `canManageSettings` is the *Einstellungen* right of
 * the handoff's five; branding is an organisation-wide setting like the form standards
 * next to it, so it is the same right, not a new one — five permissions are
 * what the group editor offers, and a sixth would be a right nobody can grant.
 */
@Controller('tenant/branding')
@UseGuards(SessionGuard, TenantScopeGuard, GroupPermissionGuard)
export class TenantBrandingController {
  constructor(
    private readonly branding: TenantBrandingService,
    private readonly logos: TenantLogoService,
  ) {}

  @Get()
  @RequirePermission('canManageSettings')
  read(
    @CurrentTenantScope() scope: TenantScope,
  ): Promise<TenantBrandingSettings> {
    return this.branding.read(scope);
  }

  @Put()
  @RequirePermission('canManageSettings')
  replace(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
  ): Promise<TenantBrandingSettings> {
    // `parseRequest`, not a cast: the payload is foreign data, and gate 1 of
    // the requirement *is* this parse — the colours and the Logo are refused
    // here or nowhere.
    return this.branding.replace(
      scope,
      parseRequest(tenantBrandingWriteSchema, body),
    );
  }

  /**
   * **Das eigene Logo** — one file as the raw body (ADR-0014 no. 14).
   *
   * `POST` rather than `PUT` beside the branding document, and it answers the
   * whole `TenantBrandingSettings` rather than a reference: the upload *is* the
   * replacement (`TenantLogoService`), so the tab's document — including its
   * `revision` — has moved by the time this returns, and handing back only a
   * reference would leave the next save answering 409 for a change the same
   * admin just made.
   *
   * **Not `@CsrfExempt()`**, unlike the public upload two modules away. That
   * one authenticates nobody, so there is no session to ride on; this one is a
   * mutating administration route on a session, and the global `CsrfGuard`
   * applies to it exactly like it does to `PUT` above (ADR-0014 no. 14).
   *
   * The guards are the controller's, so this route inherits the chain rather
   * than restating it — and `canManageSettings` is the same right the colours
   * need: a Logo is an organisation-wide setting, not a sixth permission nobody can
   * grant.
   */
  @Post('logo')
  @RequirePermission('canManageSettings')
  logo(
    @CurrentTenantScope() scope: TenantScope,
    @Req() request: LogoUploadRequest,
    @Headers(FILE_NAME_HEADER) encodedFileName?: string,
  ): Promise<TenantBrandingSettings> {
    return this.logos.replaceLogo(scope, {
      requestType: headerValue(request.headers['content-type']),
      encodedFileName,
      declaredLength: headerValue(request.headers['content-length']),
      // The request itself is the body — `express.json` is registered for
      // `application/json` and does not touch an `application/octet-stream`
      // one (ADR-0014 assumption A6).
      body: request,
    });
  }
}

/** One header value; a repeated header is not a file name (nor a length). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
