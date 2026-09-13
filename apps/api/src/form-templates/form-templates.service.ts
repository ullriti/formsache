import { randomUUID } from 'node:crypto';

import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  detachFormDefinition,
  detachQuestions,
  duplicateQuestions,
  formSettingsOverrideShape,
  formTemplateContentSchema,
  type FormTemplateContent,
  type FormTemplateInstance,
  type FormTemplateList,
  type FormTemplateSummary,
  type Question,
  type SaveFormTemplateRequest,
  type UpdateFormTemplateContentRequest,
} from '@formsache/shared';

import { parseStoredDefinition, requireFullForm } from '../forms/forms.service';
import { stripOverridePassword } from '../settings/settings-document';
import type { FormWithCounts, TenantScope } from '../tenancy/tenant-scope';
import {
  FORM_TEMPLATE_NOT_FOUND_MESSAGE,
  parseStoredTemplateContent,
  requireTemplate,
  templateSummaryOf,
} from './form-template-content';

/**
 * Refusal when somebody asks the builder to append a **form** template.
 *
 * 422 and not 400: the request is well formed, names a template that exists and
 * comes from somebody allowed to build — it simply asks for something this
 * resource cannot be. The distinction is the one `NOTHING_TO_PUBLISH_MESSAGE`
 * draws in `forms.service.ts`, and the message says where to go instead,
 * because „geht nicht" without a next step is the kind of advice that sends a
 * reader back into the code.
 */
export const FORM_TEMPLATE_NOT_INSERTABLE_MESSAGE =
  'Eine Formular-Vorlage wird nicht eingefügt, sondern legt ein neues Formular an.';

/**
 * Refusal when „Aus diesem Formular aktualisieren" would change **what kind of
 * thing** a template is.
 *
 * 422 and not 400, the distinction this file already draws twice: the body is
 * well formed and names a template of this organisation — it asks for something this
 * resource cannot become. A page template that turned into a form template
 * would leave the drawer's „Meine Vorlagen" for „Komplette Formular-Vorlagen",
 * and its button would stop inserting a page and start creating a form; „der
 * Inhalt wird ersetzt" promises neither.
 */
export const FORM_TEMPLATE_KIND_MISMATCH_MESSAGE =
  'Diese Vorlage lässt sich nur aus derselben Art Inhalt aktualisieren.';

/** Answer when the named page or question is not in the addressed form. */
const PART_NOT_FOUND_MESSAGE =
  'Diese Seite oder Frage gibt es in diesem Formular nicht.';

/**
 * *Vorlagen & Blöcke* (the design specification) — **the mechanism, without
 * shipped content** .
 *
 * ## What does not stand here
 *
 * There is no catalogue in this file, no constant holding a BT-Anmeldung, no
 * seed. Every template this service can return is one somebody saved, and it is
 * saved with the `tenant_id` of the organisation they were working in. The
 * shipped content was taken back on 2026-08-03; a later „nur ein
 * Beispiel" here would be that decision reversed in code.
 *
 * ## Copy, not reference
 *
 * Saving reads the form's **stored draft** and writes a snapshot; inserting
 * reads that snapshot and writes new ids. Neither direction keeps a handle on
 * the other, which is the point („eine Änderung am Formular
 * lässt die Vorlage unberührt, und umgekehrt") expressed as an absence: there
 * is no `form_id` on `form_template` for anything to travel along.
 *
 * The constructor is empty for the reason `FormsService`'s is: no
 * `PrismaService` in reach, so no method here can touch a row except through
 * the `TenantScope` a caller hands in.
 */
@Injectable()
export class FormTemplatesService {
  /**
   * „☆ Als Vorlage speichern" — on a form, a page or a question of **one**
   * form (the design handoff).
   *
   * The route addresses the form and the body names the part; the content
   * comes out of `form.draft_schema` and `form.settings_override`, never out of
   * the request. The wire contract's own comment says why the second half of
   * that matters: the access word a client holds is the redaction marker, not
   * the word, so a template built from a client document would store the marker
   * as if it were a value.
   *
   * **The stored draft, not the screen.** What the builder has
   * not saved is not in the template — the surface saves first and then presses
   * this route, so „was ich sehe" and „was gespeichert ist" are the same
   * document at the moment it is copied.
   *
   * The copying itself is {@link contentOf}, shared with
   * {@link updateContent} — see there for what a template does and does not
   * carry, and why both routes have to go through one function to keep it that
   * way.
   */
  async save(
    scope: TenantScope,
    formId: string,
    request: SaveFormTemplateRequest,
  ): Promise<FormTemplateSummary> {
    const row = await scope.formTemplates.create({
      kind: request.kind,
      name: request.name,
      content: contentOf(await requireFullForm(scope, formId), request),
    });

    return templateSummaryOf(row);
  }

  /**
   * „Umbenennen" — the name, and nothing else.
   *
   * ## The same pair of rights as deleting and updating
   *
   * The route asks for `canViewResponses` **and** `canBuild`, and the argument
   * this comment used to make for `canBuild` alone — „umkehrbar, und wer bauen
   * darf, muss seine **eigenen** Karteileichen loswerden" — was measured and
   * does not hold. Both halves of it failed:
   *
   * - **This route knows no „own".** A `canBuild` member renamed the
   *   admin's template (200) and then saved their own under the freed name
   *   (201): *measured on 2026-08-06.* That is the content under an established
   *   name substituted — the very effect the pair controls on
   *   {@link updateContent}, reached without it. The same member got 403 on
   *   `PUT` and `DELETE` of that same row.
   * - **„Reversible" holds only for whoever renames.** There is no owner, no
   *   `form_template_version`, no trash and no audit log anywhere in this
   *   project; after the write the old name exists nowhere. `updated_at` is on
   *   the row but {@link templateSummaryOf} never hands it out, so nobody else
   *   can even see that it happened.
   *
   * What stays is the underlying decision itself: renaming exists, and it
   * is the reversible one of the two — no confirmation on the surface, and no
   * content in the body. Only *who* may press it is sharpened.
   *
   * *(Rejected, for the second time: a `created_by` on `form_template` that
   * would make „own" utterable in the first place. The specification deletes
   * `user` rows **physically** as soon as somebody loses their last
   * organisation — the column would regularly stand at `NULL` and the rule
   * would fall back on its second half. The same trade-off as before, with the
   * same result.)*
   *
   * The content is untouched, and that is a property of the statement rather
   * than of this comment: {@link ScopedFormTemplateDelegate.update} is handed a
   * `name` and no `content`.
   */
  async rename(
    scope: TenantScope,
    id: string,
    name: string,
  ): Promise<FormTemplateSummary> {
    const template = await requireTemplate(scope, id);
    // The answer built **before** the write, out of the row that has already
    // been read. It used to come about here twice from a second `findById`, and
    // `templateSummaryOf` parses the stored content in doing so: a row that
    // did not come over the write path (a hand-written UPDATE, an import,
    // a restore) made the renaming end with **400** — and the name
    // was changed afterwards all the same (*measured on 2026-08-06*). A
    // refusal that has already taken effect is the worse half of both.
    const summary = templateSummaryOf({ ...template, name });
    if (!(await scope.formTemplates.update(id, { name }))) {
      // Somebody deleted it between the two statements — the same answer the
      // unknown id gets, for the reason {@link remove} states.
      throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    return summary;
  }

  /**
   * „Aus diesem Formular aktualisieren" — the content is overwritten.
   *
   * ## It is not a second save
   *
   * …and therefore it has **no second write path**. The content comes out
   * of {@link contentOf}, the same function {@link save} uses, which is where
   * `stripOverridePassword` sits and where a page's cross-page
   * condition and every `replaces` are dropped. A second builder next to it
   * would be exactly the shape that has twice been one edit away from carrying
   * an access word into a template in this project — and this route is the one
   * where nobody would notice, because the row already existed.
   *
   * ## A command, not a subscription
   *
   * The name says „aktualisieren", which reads like a link being followed. It
   * is not: this writes a **snapshot** and the template does not follow the form
   * afterwards. There is no `form_id` on
   * `form_template` for anything to travel along, and copies already inserted
   * into other forms are untouched — they were copies at insertion time.
   *
   * ## Irreversible
   *
   * The previous content is **gone**: no trash for a template
   * (`schema.prisma`), no `form_template_version`. That is why the route asks
   * for `canViewResponses` **and** `canBuild` — the signature this application
   * gives every irreversible write — and why the
   * surface asks first, in the `destructive` tone.
   *
   * **The kind stays**: a body naming another kind is refused rather than
   * silently turning a page template into a form template, which would move
   * the row into the drawer's other group and change what its button does.
   *
   * ## Resolve first, judge afterwards
   *
   * Both `requireTemplate` and `requireFullForm` run **before** the kind check,
   * and the order is the whole of it: the 422 is a statement about a template
   * *and* a form this caller may see, so it must not be reachable for a form
   * they may not. It was — *measured on 2026-08-06:* an ALPHA session naming a
   * **BETA** form id with a mismatching kind got 422 while the same request
   * with the matching kind got 404. Nothing crossed the boundary, but the two
   * answers to „gibt es dieses Formular?" differed by a field of the body, and
   * a refusal that differs is the shape this project spends
   * `FORM_TEMPLATE_NOT_FOUND_MESSAGE` on avoiding.
   */
  async updateContent(
    scope: TenantScope,
    formId: string,
    id: string,
    request: UpdateFormTemplateContentRequest,
  ): Promise<FormTemplateSummary> {
    const template = await requireTemplate(scope, id);
    const form = await requireFullForm(scope, formId);
    if (template.kind !== request.kind) {
      throw new UnprocessableEntityException(
        FORM_TEMPLATE_KIND_MISMATCH_MESSAGE,
      );
    }

    const content = contentOf(form, request);
    if (!(await scope.formTemplates.update(id, { content }))) {
      throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    return templateSummaryOf(await requireTemplate(scope, id));
  }

  /** The drawer's list — this organisation's templates, newest first. */
  async list(scope: TenantScope): Promise<FormTemplateList> {
    const rows = await scope.formTemplates.findMany();
    return { templates: rows.map((row) => templateSummaryOf(row)) };
  }

  /**
   * „Einfügen" — the stored block **with fresh ids** .
   *
   * The ids are minted here rather than in the builder, and that is exactly
   * the failure being avoided: keeping them would leave the copy's
   * conditions and every placeholder pointing at the questions of the form the
   * template came from, and inserting one template twice would put two questions
   * with one id into a document `formDefinitionSchema` refuses outright.
   *
   * `duplicateQuestions` from `@formsache/shared` does it — the same function the
   * builder's „⧉ Duplizieren" and the whole-form duplicate use. Its doc comment
   * names this call site as its third caller; a second implementation of „gib
   * mir diese Fragen mit neuen IDs" is exactly what `CONTRIBUTING.md` keeps out.
   */
  async instance(
    scope: TenantScope,
    id: string,
  ): Promise<FormTemplateInstance> {
    const content = parseStoredTemplateContent(
      (await requireTemplate(scope, id)).content,
    );

    switch (content.kind) {
      case 'form':
        throw new UnprocessableEntityException(
          FORM_TEMPLATE_NOT_INSERTABLE_MESSAGE,
        );
      case 'page': {
        const { questions } = duplicateQuestions(content.page.questions, () =>
          randomUUID(),
        );
        return {
          kind: 'page',
          // The page id is refreshed too — the same reasoning
          // `duplicateFormDefinition` writes down: a copy sharing *any* id with
          // its source is one accidental join away from not being independent.
          page: { ...content.page, id: randomUUID(), questions },
        };
      }
      case 'question': {
        const [question] = duplicateQuestions([content.question], () =>
          randomUUID(),
        ).questions;
        return { kind: 'question', question: requireOne(question) };
      }
    }
  }

  /**
   * Removes a template of this organisation, physically and at once.
   *
   * No trash: `schema.prisma` says why at the model — which is exactly why
   * the route asks for `can_view_responses` **and** `canBuild`,
   * the pair every other irreversible deletion in this application asks for
   * . The check is in the guard and not here, as `CONTRIBUTING.md`
   * requires; this comment only says which one, so a second caller of this
   * method cannot be written without meeting it.
   *
   * The delete carries
   * the tenant in its own predicate, so a template of another organisation matches
   * nothing and leaves through the same 404 as an unknown id — the refusal is
   * the statement's outcome, not a check before it.
   */
  async remove(scope: TenantScope, id: string): Promise<void> {
    await requireTemplate(scope, id);
    const removed = await scope.formTemplates.delete(id);
    if (!removed) {
      // Somebody else deleted it between the two statements. The same answer,
      // because the caller's question — „gibt es die noch?" — has the same
      // answer either way.
      throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
    }
  }
}

/**
 * **The one way on which content gets into a template** — for „☆ Als Vorlage
 * speichern" *and* for „Aus diesem Formular aktualisieren".
 *
 * One function and not two, and that is the load-bearing part of it:
 * updating is **not** a second save, it is the same save writing to a row that
 * already exists. Three things happen here that a second implementation would
 * have to get right again, and each of them has cost this project a finding
 * once:
 *
 * 1. **No Zugangswort** : `stripOverridePassword` decides on
 *    `values`, never on `overridden` — a form whose access section is not
 *    overridden at all can still carry a word in `values`, and the older shape
 *    that asked `overridden` first handed it on.
 * 2. **No dangling conditions and no `replaces`**: `detachQuestions`
 *    drops a condition whose source stays behind on another page, and every
 *    `replaces` — an id of the *source form*, which a template must not learn
 *    (a review finding). **All three kinds go through it**, the form through
 *    `detachFormDefinition`: the branch used to hand `definition` on untouched,
 *    so the one kind that carries a whole document was the one kind that kept
 *    the foreign id (a review finding of the rework, *measured on 2026-08-06*).
 * 3. **The stored draft, not the screen**: the content is read
 *    from `form.draft_schema` and `form.settings_override`, never from the
 *    request. The surface saves the draft first and then presses the route.
 *
 * The ids are **not** minted here, for either caller: a template stores the ids
 * it was copied with, and fresh ones are minted on the way *out* —
 * `instance()` for a block, `duplicateFormDefinition` in `FormsService.create`
 * for a whole form. That is one rule for both routes, because both write
 * through this function.
 *
 * **The form is resolved before it arrives here.** The caller hands in
 * the row rather than an id, so „gibt es dieses Formular für dich?" is answered
 * before anything this function or its callers can refuse for another reason —
 * see {@link FormTemplatesService.updateContent}, where that order is the whole
 * point.
 */
function contentOf(
  form: FormWithCounts,
  request: SaveFormTemplateRequest | UpdateFormTemplateContentRequest,
): FormTemplateContent {
  const definition = parseStoredDefinition(form.draftSchema);

  const content = ((): FormTemplateContent => {
    switch (request.kind) {
      case 'form':
        return {
          kind: 'form',
          title: form.title,
          // `detachFormDefinition` and not `definition`: the same filter the
          // two branches below apply, applied to a whole document. It takes
          // `replaces` out and leaves every condition standing — in a whole
          // form no source stays behind, so there is nothing to drop.
          definition: detachFormDefinition(definition),
          // The same call `FormsService.duplicate` makes, for the same
          // reason and with the same consequence: password protection is
          // switched **off** along with the word, because „an" without a
          // word is a state `checkSettingsConsistency` refuses to store.
          //
          // Parsed into the shape the wire contract now describes (a later
          // addition) rather than handed on as `unknown`. Without the
          // system layer, and deliberately: the cross-field rules are judged
          // when the template lands on a form. A source form whose own column
          // does not even hold that shape raises here — the same answer every
          // other read of that row already gives (`FormSettingsService`), and
          // one this route has no better answer for than the settings page.
          settingsOverride: formSettingsOverrideShape.parse(
            stripOverridePassword(form.settingsOverride),
          ),
        };
      case 'page': {
        const page = definition.pages.find(
          (candidate) => candidate.id === request.pageId,
        );
        if (page === undefined) {
          throw new NotFoundException(PART_NOT_FOUND_MESSAGE);
        }
        return {
          kind: 'page',
          // `detachQuestions`: a condition whose source is on **another**
          // page does not travel with this block and would be a dangling id
          // in whatever form the template is inserted into (see the function's
          // own comment). The page keeps its own conditions.
          page: { ...page, questions: detachQuestions(page.questions) },
        };
      }
      case 'question': {
        const question = definition.pages
          .flatMap((page) => page.questions)
          .find((candidate) => candidate.id === request.questionId);
        if (question === undefined) {
          throw new NotFoundException(PART_NOT_FOUND_MESSAGE);
        }
        // A set of one has no source in it but itself, so a single question
        // never keeps a condition — stated by the same function rather than
        // by a second `delete question.visibleIf` here.
        const [detached] = detachQuestions([question]);
        if (detached === undefined) {
          throw new NotFoundException(PART_NOT_FOUND_MESSAGE);
        }
        return { kind: 'question', question: detached };
      }
    }
  })();

  // Parsed on the way **in** as well, so what the column holds is what the wire
  // contract describes rather than what this function happened to build.
  //
  // The cast this line used to carry is gone with a review finding: now that the
  // contract describes `settingsOverride` instead of leaving it `unknown`, the
  // parsed content is JSON-compatible by its own type.
  return formTemplateContentSchema.parse(content);
}

/**
 * `duplicateQuestions` hands back one copy per question given, so this cannot
 * be empty — asserted rather than asserted away with `!`, which `CONTRIBUTING.md`
 * only allows with a reason written next to it.
 */
function requireOne(question: Question | undefined): Question {
  if (question === undefined) {
    throw new Error('duplicateQuestions returned no copy for one question');
  }
  return question;
}
