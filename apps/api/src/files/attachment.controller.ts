import {
  Controller,
  Get,
  Header,
  Param,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';

import { SessionGuard } from '../auth/session.guard';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import { NoFormIdInRequest } from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import {
  CurrentFormRestriction,
  type FormRestriction,
} from '../tenancy/form-restriction';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import { RequirePermission } from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { AttachmentService } from './attachment.service';

/**
 * **The attachment of an answer — behind the whole guard chain** (ADR-0014 no. 11b).
 *
 * The counterpart of `public/public-logo.controller.ts`, and the *difference*
 * between the two is what matters: a Logo is deliberately public and
 * embedded, an answer's attachment is explicitly neither. It carries personal
 * data a stranger uploaded — a certificate, a power of attorney, a scanned form — and
 * nothing but this chain stands between it and the internet.
 *
 * The guards are declared at the **controller**, in the chain's order
 * (*session → tenant scope → group permissions → form restriction*), for the
 * reason `FormsController` states: a route added here later inherits them
 * instead of having to remember them. The one route that had to be remembered
 * once already was `GET:id/export.csv`, and a review found it open.
 *
 * `can_view_responses`, the same right the answers themselves need: this file
 * *is* part of an answer. There is deliberately no second, weaker right for
 * „nur die Anlage" — `can_export` alone opening the CSV was exactly that shape,
 * and it is not being reopened.
 *
 * **`Content-Disposition: attachment` and a fixed type**, never the stored one
 * (`file-delivery.ts`). Plus `X-Content-Type-Options: nosniff`, because a PDF
 * or an image whose bytes a stranger chose is served from the **same origin**
 * as the application, and a browser deciding to read it as HTML would be XSS
 * here.
 *
 * `Cache-Control: no-store` comes from the global handler and is not carved out:
 * these are the bytes of one participant's registration, and a shared cache
 * that kept one is a failure outside the application.
 */
@Controller('responses/files')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
export class AttachmentController {
  constructor(private readonly attachments: AttachmentService) {}

  @Get(':ref')
  @RequirePermission('canViewResponses')
  // The `:ref` is a **file**, not a form. The fourth link reads the form off
  // the request and there is none here — it hangs off the answer this file was
  // claimed by, two reads further in — so the check lands in
  // `AttachmentService`, with the same 404 an unknown reference gets. Declaring
  // it is mandatory: a route carrying the guard without a declaration is
  // refused rather than passed (review finding).
  @NoFormIdInRequest(
    'the :ref is a file row; its form hangs off the response and is checked ' +
      'in AttachmentService.byRef',
  )
  @Header('X-Content-Type-Options', 'nosniff')
  attachment(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
    @Param('ref') ref: string,
  ): Promise<StreamableFile> {
    return this.attachments.byRef(scope, ref, restriction);
  }
}
