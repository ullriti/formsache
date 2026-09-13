import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  bulkDeleteResponsesRequestSchema,
  createFormRequestSchema,
  exportFormatSchema,
  formListQuerySchema,
  publishFormRequestSchema,
  updateFormRequestSchema,
  type FormDetail,
  type FormListPage,
  type PublishPreview,
  type ResponseColumnSet,
  type ResponseDetail,
} from '@formsache/shared';

import { SessionGuard } from '../auth/session.guard';
import { parseRequest as parse } from '../common/parse-request';
import { CurrentTenantScope } from '../tenancy/current-tenant-scope.decorator';
import {
  FormIdInParam,
  NoFormIdInRequest,
} from '../tenancy/form-id-source.decorator';
import { FormRestrictionGuard } from '../tenancy/form-permission.guard';
import {
  CurrentFormRestriction,
  type FormRestriction,
} from '../tenancy/form-restriction';
import { GroupPermissionGuard } from '../tenancy/group-permission.guard';
import {
  RequireAllPermissions,
  RequireAnyPermission,
  RequirePermission,
} from '../tenancy/require-permission.decorator';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TenantScopeGuard } from '../tenancy/tenant-scope.guard';
import { TrashService } from '../trash/trash.service';
import { FormsService } from './forms.service';

/**
 * Forms of the active Organisation — behind the **whole** guard chain (`CONTRIBUTING.md`):
 * *tenant scope → group permissions → form restriction*. The last link arrived
 * later and is the one that can only take away.
 *
 * The guards are declared **at the controller**, and that is not
 * merely convenient, it is the point: a route added later inherits the chain
 * instead of having to remember it. The one that had to be remembered once
 * already is `GET:id/export.csv` — a review found it open when the
 * responses next to it were closed — and a per-route list is exactly the shape
 * in which that happens twice. The order here is the chain's order.
 *
 * The **permission** stays per route, because it differs per route: reading a
 * form needs a different right than rebuilding it.
 *
 * No handler takes a tenant, an id of its own or a Prisma client. All any of
 * them can pass on is the scope and the restriction — which is why "this
 * endpoint forgot the tenant" has no spelling here.
 */
@Controller('forms')
@UseGuards(
  SessionGuard,
  TenantScopeGuard,
  GroupPermissionGuard,
  FormRestrictionGuard,
)
// Every route below addresses its form under `:id`; the two that address none
// say so on themselves. Stated once at the controller for the same reason the
// guards are — a route added later inherits it instead of having to remember it
// (a review finding: the fourth link is no longer allowed to guess).
@FormIdInParam('id')
export class FormsController {
  constructor(
    private readonly forms: FormsService,
    /**
     * The trash writes. Its own service because deleting and
     * restoring are one subject with one set of rules — and its routes are
     * here, because what they address is a form under `:id` and the guard
     * chain of this class already points at it.
     */
    private readonly trash: TrashService,
  ) {}

  /**
   * The dashboard list — reachable with **either** right.
   *
   * Until a change this required `canBuild`, which left a member who may
   * only see answers unable to find a single form: their role listed a right
   * they had no way to reach. The list is the way into both worlds, so either
   * right opens it. What each of them may then *do* with a form is still
   * decided per route below.
   *
   * **The one route the fourth link cannot guard, and therefore the one that
   * carries it as a value** : a guard refuses a request, it
   * does not narrow a result set. The restriction travels into
   * `FormsService.list` and lands in the `where` — so a form the caller is
   * locked out of is never read, never serialised and never in this payload.
   *
   * **It answers one page, never the whole organisation** . The
   * query is `limit` / `offset` / `q` / `id`, **parsed** through
   * `formListQuerySchema` rather than read off the request object: `limit` is
   * *clamped* to `FORM_PAGE_SIZE_MAX` — a number out of the address bar is a
   * wish, not an instruction — and the answer echoes what was **applied**, so a
   * client can page correctly without having to know the ceiling.
   *
   * The **search is a query parameter and not a client-side filter**, which is
   * the evidence: a filter over the loaded page answers „keine
   * Treffer" for a form that sits on page three.
   *
   * `id` narrows this same statement to one form. It is deliberately *not* a
   * second route: reading „darf ich hier etwas?" off `GET /forms/:id` is what
   * the fourth link refuses with 403 for a capped caller — the very person
   * whose answer is needed. Going through the list keeps one `where`, so a
   * revoked form is as absent from `?id=…` as it is from page one.
   *
   * ⚠️ **A form id in a query parameter, declared as „names no form" — read
   * this before assuming it is the `mail-log` hole again.** It is the same
   * *shape* as the defect `FormIdInQuery` was created for (a review:
   * `GET /api/mail-log?formId=…` slipped past a guard that only looked in the
   * path), and the difference is which direction the parameter works in.
   * There, the parameter **selected rows** and nothing else looked at the
   * restriction, so it widened what a locked-out caller could reach. Here it
   * can only **narrow** a statement that already carries
   * `FormRestriction.formFilter()` and the tenant of the scope: intersecting a
   * restricted set with one id cannot produce a row that was not in the
   * restricted set. Declaring `FormIdInQuery('id')` instead would make the
   * guard **refuse** a capped caller — and a capped caller getting an answer is
   * the entire purpose of the parameter (the requirement).
   * Measured, not argued: „answers an empty page for a revoked form asked for
   * by id" in `test/forms/form-list-pagination.spec.ts`.
   */
  @Get()
  @RequireAnyPermission('canBuild', 'canViewResponses')
  @NoFormIdInRequest(
    'the list names no form — the restriction travels as a query fragment ' +
      'into FormsService.list instead (first Nachstellung). ' +
      'The optional `id` parameter narrows that same statement rather than ' +
      'addressing a form: it intersects a set that already carries the ' +
      'restriction, so it can hide a row and never reveal one. See the ' +
      'doc comment for why this is not the mail-log hole ',
  )
  list(
    @CurrentTenantScope() scope: TenantScope,
    @CurrentFormRestriction() restriction: FormRestriction,
    @Query() query: unknown,
  ): Promise<FormListPage> {
    return this.forms.list(
      scope,
      restriction,
      parse(formListQuerySchema, query),
    );
  }

  /**
   * One form with its definition — `canBuild` **or** `canViewResponses`.
   *
   * The second right is what makes the responses table reachable at all: it
   * renders the questions, and it reads them from here. Guarding this on
   * `canBuild` alone left the viewer one click further along the same dead end
   * the form list used to be — they saw the form, pressed „Antworten" and got
   * a load error. Seeing the *questions* of a form whose *answers* one may read
   * grants nothing extra; the draft it returns is the same document the
   * published form was made from, and every route that **changes** anything
   * below still asks for `canBuild`.
   */
  @Get(':id')
  @RequireAnyPermission('canBuild', 'canViewResponses')
  byId(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormDetail> {
    return this.forms.byId(scope, id, restriction);
  }

  @Post()
  @RequirePermission('canBuild')
  @NoFormIdInRequest(
    'the form does not exist yet — there is nothing to be restricted on',
  )
  create(
    @CurrentTenantScope() scope: TenantScope,
    @Body() body: unknown,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormDetail> {
    return this.forms.create(
      scope,
      parse(createFormRequestSchema, body),
      restriction,
    );
  }

  /**
   * „⧉ Duplizieren" (the design handoff) — a fresh draft, computed
   * and written entirely by `FormsService.duplicate`; the route itself takes
   * no body, because nothing about a duplicate is the caller's to choose.
   *
   * `POST`, not `PUT`: it creates a row, the same reasoning `create()` above
   * follows. `canBuild` — the same right `create()` needs, and the answer to
   * "wer darf duplizieren?" this decision states in as many words.
   */
  @Post(':id/duplicate')
  @RequirePermission('canBuild')
  duplicate(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormDetail> {
    return this.forms.duplicate(scope, id, restriction);
  }

  @Put(':id')
  @RequirePermission('canBuild')
  update(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormDetail> {
    return this.forms.update(
      scope,
      id,
      parse(updateFormRequestSchema, body),
      restriction,
    );
  }

  /**
   * `POST`, not `PUT`: publishing creates a new version, and calling it twice
   * creates two — the operation is deliberately not idempotent, and the
   * revision check is what keeps a double click from being one.
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('canBuild')
  publish(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentFormRestriction() restriction: FormRestriction,
  ): Promise<FormDetail> {
    const request = parse(publishFormRequestSchema, body);
    return this.forms.publish(scope, id, request.revision, restriction);
  }

  /**
   * **Deleting leads into the trash** .
   *
   * `canBuild` — „löschen darf, wer bauen darf", the same right that made
   * the form and can rebuild it. Nothing is removed: the row keeps its answers,
   * its versions and its public address, and stops being reachable through any
   * of them until it is restored or the 30 days run out.
   *
   * **`can_view_responses` is deliberately not asked for**, although a form with
   * forty Anmeldungen goes with it (decision of 2026-08-03, a review finding). The
   * right to delete a *single* answer is the pair `can_view_responses` +
   * `can_build` (see `deleteResponse`), and the asymmetry is on purpose: this is
   * reversible for 30 days and restorable by the same person with everything
   * still in it, so it is „ausser Betrieb nehmen" rather than „wegnehmen". The
   * pair returns where reversibility ends — physical deletion and „Papierkorb
   * leeren" require both.
   *
   * 204, because there is nothing to return that the caller does not have: the
   * form they deleted is the form they were looking at.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('canBuild')
  deleteForm(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<void> {
    return this.trash.deleteForm(scope, id);
  }

  /**
   * **Physical deletion of a form** .
   *
   * **Both permissions**, unlike {@link deleteForm} one method up
   * (a decision, 2026-08-03, out of a review). Moving a
   * form into the trash is `can_build` alone because it is reversible for
   * 30 days, by the same person, with everything still in it — „ausser Betrieb
   * nehmen". Here nothing comes back: the answers, their attachments' bytes and
   * the personal columns of the mail log are gone, and an editor who
   * may not so much as *read* one Anmeldung must not be the one to destroy
   * forty. Where reversibility ends, the pair comes back.
   *
   * `DELETE :id/permanent` and not a query parameter on `DELETE :id`: a flag
   * that turns a reversible verb into an irreversible one is a flag somebody
   * sets by accident, and it would have to carry a *stronger* permission than
   * the route it sits on.
   *
   * 204: there is nothing to return about something that no longer exists.
   */
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  purgeForm(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<void> {
    return this.trash.purgeForm(scope, id);
  }

  /**
   * Takes a form back out of the trash.
   *
   * `POST` and not `DELETE`/`PUT`: it is an action on a form, not a
   * representation somebody replaces, and it is the one route of this
   * controller that deliberately addresses a **deleted** form — every other one
   * answers 404 for exactly that state.
   *
   * `canBuild` — „wiederherstellen ebenso". Deliberately not a stronger
   * right than deleting: a right that can undo less than it can do turns every
   * mistake into a permanent one.
   */
  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('canBuild')
  restoreForm(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<void> {
    return this.trash.restoreForm(scope, id);
  }

  /**
   * Moves one answer into the trash.
   *
   * **Both permissions** — this is the „eigene Entscheidung" the requirement
   * asks for, and `canBuild` is what it resolves to. The five group permissions of
   * the handoff are a closed list („x/5 Rechte" in the group editor), so
   * „löschen" is not a sixth flag; it is the pairing that says *whose*
   * decision it is. `can_view_responses` alone is the right to **read** a
   * registration — the Schriftführer sorting through Anmeldungen — and reading
   * is not deciding that somebody's registration goes away. Deleting an answer
   * disposes of the form's own record, and the person who answers for the form
   * is the person who may build it.
   *
   * The pair is the same shape `GET :id/export.csv` uses and the same argument:
   * the stronger act carries the stronger requirement.
   *
   * ⚠️ **What the pair guards is this route, not „ungesehen löschen" as such**,
   * and the difference is worth spelling out because an earlier version of this
   * comment claimed the larger thing. An editor without `can_view_responses`
   * is refused *here* — and gets 204 on `DELETE :id` for the whole form with its
   * forty registrations, because deleting a form is `can_build` (decision of
   * 2026-08-03). The two are not the contradiction they look like: this route
   * disposes of one person's registration and there is nothing to undo it from,
   * whereas the form goes into the trash — reversible, for 30 days, by the
   * same person, with everything still in it. Somebody trusted to build the form
   * is trusted to take it out of service; that is not the same trust as reaching
   * into a single Anmeldung one may not read.
   *
   * **Where it stops being reversible, the pair comes back**: physical
   * deletion and „Papierkorb leeren" require `can_view_responses` as well.
   * That is where „ungesehen löschen" would
   * actually be true.
   */
  @Delete(':id/responses/:responseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  deleteResponse(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Param('responseId') responseId: string,
  ): Promise<void> {
    return this.trash.deleteResponse(scope, id, responseId);
  }

  /**
   * **Moves several answers into the trash at once**  —
   * the „Löschen" of the action bar the responses table grew with the
   * Mehrfachauswahl.
   *
   * **The same pair as deleting one answer**, `can_view_responses` **and**
   * `can_build` — deliberately not the weaker half. Nothing about
   * naming twenty registrations in one request makes it a smaller decision than
   * naming one, and a bulk route with a lower bar would be the way around the
   * single route rather than a convenience next to it.
   *
   * **`POST … /delete` and not `DELETE …/responses`.** The body is what says
   * *which* answers, and a `DELETE` whose body decides its scope is the one
   * shape where a proxy that drops the body turns „diese drei" into a request
   * about the whole collection. The verb-suffixed `POST` is the shape this
   * controller already uses for `…/restore`.
   *
   * **All or nothing** — one foreign or unknown id in the middle of the list
   * refuses the whole call and writes nothing; see
   * {@link TrashService.deleteResponses} for why the partial answer would be
   * the worst of the three.
   */
  @Post(':id/responses/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  deleteResponses(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { responseIds } = parse(bulkDeleteResponsesRequestSchema, body);
    return this.trash.deleteResponses(scope, id, responseIds);
  }

  /**
   * **Physical deletion of an answer** .
   *
   * The same pair as moving it into the trash, and here the pair needs no
   * asymmetry argument: it is strictly the harder act of the two. What goes with
   * the row is the `event_registration` rows (the seats were free from the
   * moment of the soft delete), the bytes of every attachment
   * (ADR-0014 no. 16), and the four personal columns of its mail log
   * lines — `recipient`, `subject`, `body_text`, `body_html`. The log lines
   * themselves stay: „wie ging es aus und über welchen Mailserver" is the
   * operational record that has to survive the participant's data.
   *
   * 503 when the storage will not release an attachment's bytes: nothing was
   * deleted, and the request is repeatable.
   */
  @Delete(':id/responses/:responseId/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  purgeResponse(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Param('responseId') responseId: string,
  ): Promise<void> {
    return this.trash.purgeResponse(scope, id, responseId);
  }

  /**
   * Takes one answer back out of the trash — **or refuses, and says why**.
   *
   * The two ways it can fail are the price of two earlier promises: a deleted
   * answer frees its Veranstaltungsplätze at once and stops
   * counting against the Antwortlimit, and either room can be taken
   * while it is away. 409 with a machine-readable `reason`; the answer stays in
   * the trash.
   *
   * The form id in the path is not decoration: it is what the fourth link of
   * the guard chain reads (`@FormIdInParam('id')` at the class), so a
   * restriction on the form covers its answers without this route knowing about
   * restrictions at all.
   */
  @Post(':id/responses/:responseId/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAllPermissions('canViewResponses', 'canBuild')
  restoreResponse(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Param('responseId') responseId: string,
  ): Promise<void> {
    return this.trash.restoreResponse(scope, id, responseId);
  }

  /** Answers to one form — `canViewResponses`, not `canBuild`. */
  @Get(':id/responses')
  @RequirePermission('canViewResponses')
  responses(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<ResponseDetail[]> {
    return this.forms.responses(scope, id);
  }

  /**
   * The columns of the responses table and the snapshots its cells render
   * against.
   *
   * A route of its own rather than a field on `GET /forms/:id`, because it
   * answers a different question about a different document: that route returns
   * the **draft** the builder edits, and building columns from it is a defect
   * that was corrected — an unsaved experiment must not change what the responses
   * view shows. `canViewResponses`, like the answers themselves: it describes
   * what was asked, and it is useless without the rows.
   */
  @Get(':id/responses/columns')
  @RequirePermission('canViewResponses')
  responseColumnSet(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<ResponseColumnSet> {
    return this.forms.responseColumnSet(scope, id);
  }

  /**
   * What publishing again would change.
   *
   * `GET`, because it changes nothing — and `canBuild`, because it is read by
   * the person about to publish and it names the questions of the draft. It
   * carries a **count** of the answers, never an answer, so it grants a viewer
   * nothing the dashboard does not already show.
   */
  @Get(':id/publish-preview')
  @RequirePermission('canBuild')
  publishPreview(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
  ): Promise<PublishPreview> {
    return this.forms.publishPreview(scope, id);
  }

  /**
   * The export — the third permission pair, which
   * had to stay open until a route existed to show it on.
   *
   * The **view** is passed in as query parameters: `columns` says which
   * columns are visible and `q` the search term. The rule is that the
   * export follows the filtered view rather than the whole table, and the
   * surest way to honour that is to let the client state the view and to build
   * the file from nothing else.
   *
   * **The format is the file extension** . `export.csv` is what it
   * always was, byte for byte and character for character in the URL, and
   * `export.xlsx`/`export.html` join it by appearing in
   * `exportFormatSchema` — not by a second route. A query parameter would have
   * done the same job on the wire and a worse one everywhere else: a download
   * is saved under the last segment of its URL by more than one browser and
   * every command-line client, and `export.csv?format=xlsx` lands on disk as a
   * workbook named `export.csv`.
   *
   * The extension is **parsed, not trusted**: an unknown one is a 400 naming
   * the formats that exist, rather than a 500 or — worse — a silent fallback to
   * CSV under someone else's file name.
   *
   * **Both** permissions, not `canExport` alone, and they belong to the route
   * rather than to the format: `can_export` is an *addition* to being allowed to
   * see the answers, never a way around it. A group configured with export but
   * without `can_view_responses` — which is freely configurable — would
   * otherwise download every answer of the organisation while being unable to open a
   * single one on screen. A bulk file of personal data is the stronger right, so
   * it carries the stronger requirement, in every format.
   */
  @Get(':id/export.:format')
  @RequireAllPermissions('canViewResponses', 'canExport')
  async exportResponses(
    @CurrentTenantScope() scope: TenantScope,
    @Param('id') id: string,
    @Param('format') format: string,
    @Query('columns') columns: string | undefined,
    @Query('q') search: string | undefined,
    @Res({ passthrough: true }) response: DownloadResponse,
  ): Promise<string | StreamableFile> {
    const parsed = exportFormatSchema.safeParse(format);
    if (!parsed.success) {
      throw new BadRequestException(UNKNOWN_EXPORT_FORMAT_MESSAGE);
    }

    const file = await this.forms.exportResponses(scope, id, {
      format: parsed.data,
      // A comma-separated list of question ids; absent means "the default
      // columns", which is what a client that never opened the field menu has
      // on screen.
      columns: columns === undefined ? undefined : columns.split(','),
      search: search ?? '',
    });

    // Set here rather than by `@Header`, because it is a property of the format
    // and the format is a parameter now.
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    // A text format is returned as it is; a binary one (the Excel workbook)
    // as a `StreamableFile`, which is the **only** return shape Nest
    // writes to the socket untouched.
    //
    // ⚠️ **Measured, after the comment that stood here was wrong** .
    // It said a `Buffer` was enough, „because Express serialises a bare
    // `Uint8Array` as JSON" — and a `Buffer` is serialised as JSON too, just
    // more convincingly: `isObject(body)` is true for it, so Nest calls
    // `response.json()`, and `Buffer.toJSON()` hands over
    // `{"type":"Buffer","data":[80,75,3,4,…]}`. Every header was right, the
    // status was 200, the file was 34 KB — and it opened in no spreadsheet.
    // The first two bytes of the download are asserted in `forms.spec.ts` for
    // exactly this reason: `PK` is the one thing that separates a workbook
    // from a JSON array of its bytes.
    return typeof file.body === 'string'
      ? file.body
      : new StreamableFile(Buffer.from(file.body));
  }
}

/**
 * What an unknown extension is answered with.
 *
 * It names the formats that exist rather than only refusing: the sender is a
 * person who typed or edited a URL, and „csv" — today „csv, xlsx, html" —
 * is the whole of what they need. The list is read off
 * {@link exportFormatSchema} rather than spelled out, so a format added later
 * cannot be missing from the sentence.
 *
 * The **rejected value is not echoed**: it comes straight out of the URL, and a
 * message that repeats it makes this route a reflector for whatever somebody
 * puts there. Nothing internal is in it either (`CONTRIBUTING.md`) — the format
 * list is public wire contract.
 */
const UNKNOWN_EXPORT_FORMAT_MESSAGE = `Unbekanntes Exportformat. Verfügbar: ${exportFormatSchema.options.join(', ')}.`;

/**
 * The response members this controller touches — structural, like the auth
 * module's shapes, so Express does not leak into the type surface.
 */
interface DownloadResponse {
  setHeader: (name: string, value: string) => unknown;
}
