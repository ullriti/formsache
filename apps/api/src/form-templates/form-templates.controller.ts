import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  renameFormTemplateRequestSchema,
  saveFormTemplateRequestSchema,
  updateFormTemplateContentRequestSchema,
  type FormTemplateInstance,
  type FormTemplateList,
  type FormTemplateSummary,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest as parse } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import {
  FormIdInParam,
  NoFormIdInRequest,
} from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import {
  RequireAllPermissions,
  RequirePermission,
} from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { FormTemplatesService } from './form-templates.service';

/**
 * „☆ Als Vorlage speichern" (the design handoff) — mounted under the
 * **form** it copies from.
 *
 * The path is `forms/:formId/templates` rather than a `POST /form-templates`
 * with a form id in the body, and both halves of that are deliberate: the
 * source is a property of the form, and the fourth link of the guard chain
 * finds it in the route without a second spelling — the same reasoning
 * `FormPermissionController` writes down for `forms/:formId/members`. Somebody
 * whose access to *this* form was revoked cannot save it as a template, and gets
 * the same 404 the form itself gives them.
 *
 * `canBuild`: **„Vorlagen anlegen darf, wer bauen darf."** It is the right
 * `create()` and „⧉ Duplizieren" ask for, and saving a template is the same
 * kind of act — a copy of a document this person may edit anyway.
 *
 * **Two routes, two permissions** by design: creating one is that
 * `canBuild`, overwriting an existing one from this form is the pair — it
 * throws away content that has no trash. The permission is on each route,
 * never on the class, so „geerbt und von niemandem entschieden" cannot happen
 * here.
 */
@Controller('forms/:formId/templates')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
@FormIdInParam('formId')
export class FormTemplateSaveController {
  constructor(private readonly templates: FormTemplatesService) {}

  @Post()
  @RequirePermission('canBuild')
  save(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
    @Body() body: unknown,
  ): Promise<FormTemplateSummary> {
    return this.templates.save(
      scope,
      formId,
      parse(saveFormTemplateRequestSchema, body),
    );
  }

  /**
   * „Aus diesem Formular aktualisieren" — the template's content is replaced by
   * this form's.
   *
   * **Here and not on the remaining template routes**, because this one names
   * a *form*: the content is copied out of it, exactly as `save` above copies
   * it, so the fourth link of the guard chain applies unchanged — somebody
   * whose access to this form was revoked cannot push its questions into a
   * template, and gets the same 404 the form itself gives them. The template's
   * own id is the second parameter; a template of another organisation is a 404 too, out
   * of the tenant-bound query rather than out of a check before it.
   *
   * **The permission pair, and the same reasoning as for physical deletion**
   * (which carries the same specification forward): the previous content is gone the
   * moment this succeeds — no trash for a template, no earlier version to
   * read back. `canViewResponses` is not asked for what it reads; it is the
   * signature this application gives to *irreversible*, and a third
   * rule for that same sentence would be the actual cost.
   *
   * **`PUT` and not `PATCH`**: the content is replaced whole, never merged —
   * a template that kept half of its old pages would be a document nobody built.
   * Renaming, which really is partial, is the `PATCH` on the other controller.
   */
  @Put(':id')
  @RequireAllPermissions('canViewResponses', 'canBuild')
  updateContent(
    @CurrentTenantScope() scope: TenantScope,
    @Param('formId') formId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<FormTemplateSummary> {
    return this.templates.updateContent(
      scope,
      formId,
      id,
      parse(updateFormTemplateContentRequestSchema, body),
    );
  }
}

/**
 * The templates of the active organisation — the drawer *Vorlagen & Blöcke* (the design handoff).
 *
 * **There is no route here that names another organisation's templates**, and that is
 * the shape of the design rather than an omission: „die Vorlagen
 * einer fremden Organisation" is not an address this API has. What a caller *can* try
 * is a foreign template id on the two routes below, and both answer 404 through
 * the one door `FORM_TEMPLATE_NOT_FOUND_MESSAGE` describes.
 *
 * `canBuild` opens **listing and inserting**: a template is a piece of a form
 * definition, so seeing the list is seeing what somebody built. Deliberately
 * *not* narrowed by a per-form restriction, and `@NoFormIdInRequest` says so —
 * **a template belongs to the organisation, not to the form**. Whoever
 * lost access to the form a template was once copied from still lists and
 * inserts it, and that is the rule rather than a gap: the template is a copy
 * with no handle back, so „welches Formular war das noch" is a
 * question this table cannot answer and must not learn to answer.
 *
 * **Deleting and renaming are the exceptions** — both ask for the pair, see
 * the routes. The third member of that group — „Aus diesem Formular
 * aktualisieren" — is deliberately **not** here but on the save controller
 * above, because it names a form to copy from. So: listing and inserting are
 * `canBuild`, and everything that changes a row somebody else may be relying on
 * is `canViewResponses` **and** `canBuild`.
 */
@Controller('form-templates')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
@NoFormIdInRequest(
  'a Vorlage belongs to the organisation, not to a form — it names none, and the ' +
    'tenant binding is the whole of its isolation ',
)
export class FormTemplatesController {
  constructor(private readonly templates: FormTemplatesService) {}

  @Get()
  @RequirePermission('canBuild')
  list(@CurrentTenantScope() scope: TenantScope): Promise<FormTemplateList> {
    return this.templates.list(scope);
  }

  /**
   * „Einfügen" — the block with fresh ids, for the builder to append.
   *
   * `POST` although nothing is stored: the answer is **different every time**
   * (new ids on every call), so it is neither idempotent nor cacheable, and a
   * `GET` would invite exactly the caching that turns two insertions into one
   * duplicated id. It creates the *instance*, the builder's next save creates
   * the row.
   */
  @Post(':id/instance')
  @HttpCode(200)
  @RequirePermission('canBuild')
  instance(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<FormTemplateInstance> {
    return this.templates.instance(scope, id);
  }

  /**
   * „Endgültig löschen" — physically, at once, **no trash**.
   *
   * The pair and not `canBuild` alone, and the second right is not picked for
   * what it reads: it is the signature this project already gives to
   * *irreversible* deletion — `TrashController.empty` and the
   * form's own „Endgültig löschen" carry the identical
   * `@RequireAllPermissions('canViewResponses', 'canBuild')`. **A third
   * rule for that same sentence would be the actual cost**: a reader who has
   * learnt what „endgültig" costs on one screen would have to learn it again
   * here, and the two would drift.
   *
   * *(Rejected: „der Speichernde plus eine Verwaltungs-Berechtigung". It would
   * need a `created_by` on `form_template` — and the application deletes
   * `user` rows physically as soon as somebody loses their last organisation, so
   * the column would stand at `NULL` regularly and the rule would fall back on
   * its second half anyway. A migration and a special case so that **more**
   * people may delete, while the finding reads: too many.)*
   *
   * What is deliberately **not** here: a per-form restriction. A caller whose
   * access to the source form was revoked is refused by this route only if
   * they lack the pair — never because of that form.
   */
  @Delete(':id')
  @HttpCode(204)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  remove(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<void> {
    return this.templates.remove(scope, id);
  }

  /**
   * „Umbenennen" — the name alone.
   *
   * **The same pair as deleting and updating**, and it is the *route* that
   * had to change rather than the decision: the concept says renaming exists and is
   * the reversible of the two, and it still is — no confirmation, no content in
   * the body. Who may press it is what was measured wrong. The argument for
   * `canBuild` alone was „wer bauen darf, muss seine **eigenen** Karteileichen
   * loswerden", and this route has no notion of „eigen": *measured on
   * 2026-08-06*, a `canBuild` member renamed the admin's template (200) and
   * created one of their own under the freed-up name (201) — exactly the
   * replacement of content under an established name that the pair on `PUT`
   * stands against. The same member got 403 on `PUT` and `DELETE` of the same
   * row. The service's own comment carries the second half
   * („umkehrbar" holds only for whoever renamed).
   *
   * `PATCH` because it is genuinely partial: this body touches one field of a
   * row and says nothing about the content.
   */
  @Patch(':id')
  @RequireAllPermissions('canViewResponses', 'canBuild')
  rename(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<FormTemplateSummary> {
    return this.templates.rename(
      scope,
      id,
      parse(renameFormTemplateRequestSchema, body).name,
    );
  }
}
