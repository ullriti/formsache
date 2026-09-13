import { z } from 'zod';

import {
  formDefinitionSchema,
  pageSchema,
  questionSchema,
} from './form-schema.ts';
import { formSettingsOverrideShape } from './form-settings.ts';

/**
 * Wire contract of *Vorlagen & Blöcke* (design handoff).
 *
 * **The mechanism, without shipped content** — Konzept
 * (2026-08-03, revised no. 60). Nothing in this file describes a form,
 * a Fragenblock or a Seite that the installation ships: a template exists only
 * where somebody pressed „☆ als Vorlage speichern", and it belongs to the organisation
 * they pressed it in. That is why there is no `origin: 'system' | 'tenant'`
 * discriminator here — there is only one origin, and a field that always
 * carries the same value is the first place a shipped catalogue would grow
 * back.
 *
 * **A template is a copy, not a reference** . The content below is a snapshot taken at save time; it names no
 * form and holds no form id, so there is nothing for a later edit of the source
 * form to reach through — and nothing for an edit of the template to reach back
 * along.
 */

/** How long a template's name may be — the same 200 a form title has. */
export const FORM_TEMPLATE_NAME_MAX = 200;

const templateNameSchema = z.string().trim().min(1).max(FORM_TEMPLATE_NAME_MAX);

/**
 * The three things that can be saved (design handoff: „☆ Als Vorlage speichern" on
 * the question card, „☆ Seite als Vorlage speichern" in the page list, and the
 * whole form).
 */
export const formTemplateKindSchema = z.enum(['form', 'page', 'question']);
export type FormTemplateKind = z.infer<typeof formTemplateKindSchema>;

/**
 * What the drawer lists — never the content itself.
 *
 * `questionCount` is computed from the stored content on the server rather
 * than stored beside it: a second column would be a second answer to „wie viele
 * Fragen sind das", and the two drift the moment anything ever edits a stored
 * template. It is on the wire because the drawer's subtitle („3 Fragen · als
 * Seite") is the one thing that tells two saved pages apart at a glance.
 */
export const formTemplateSummarySchema = z.object({
  id: z.uuid(),
  kind: formTemplateKindSchema,
  name: z.string(),
  questionCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type FormTemplateSummary = z.infer<typeof formTemplateSummarySchema>;

export const formTemplateListSchema = z.object({
  templates: z.array(formTemplateSummarySchema),
});
export type FormTemplateList = z.infer<typeof formTemplateListSchema>;

/**
 * „Speichere *das hier* als Vorlage" — and the *das hier* is named, not sent.
 *
 * The body carries a name and a **pointer into the form the route addresses**
 * (`POST /forms/:formId/templates`), never a definition of its own. Two reasons,
 * and the second is the load-bearing one:
 *
 * 1. The server is the truth about what a form contains (`CONTRIBUTING.md`), so a
 *    template is a copy of a *stored* document rather than of whatever a client
 *    claims to be holding.
 * 2. **A form template carries settings, and the settings a client holds are
 *    redacted.** The access word never leaves the server in clear — the
 *    settings read replaces it with `REDACTED_PASSWORD` — so
 *    a template built from a client-sent document would store that marker as if
 *    it were a value. Reading `form.settings_override` on the server and taking
 *    the word out there (`stripOverridePassword`, `apps/api`) is the only shape
 *    in which „ohne Zugangswort" is a fact rather than a hope.
 */
export const saveFormTemplateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('form'),
    name: templateNameSchema,
  }),
  z.strictObject({
    kind: z.literal('page'),
    name: templateNameSchema,
    /** The page of the addressed form's **saved draft**. */
    pageId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('question'),
    name: templateNameSchema,
    questionId: z.uuid(),
  }),
]);
export type SaveFormTemplateRequest = z.infer<
  typeof saveFormTemplateRequestSchema
>;

/**
 * „Umbenennen" — the name alone.
 *
 * The content is not in this body and cannot be: renaming touches the one
 * field a template carries *about* itself, never the snapshot it carries. That
 * is what makes it the **umkehrbare** of the two actions no. 74 adds, and it is
 * why the surface asks nothing before sending it — while
 * {@link updateFormTemplateContentRequestSchema} is confirmed in the
 * `destructive` tone.
 *
 * **The right is nevertheless the same pair** (`can_view_responses` **and**
 * `can_build`, follow-up to no. 74): the name is the only thing a template is
 * recognised by, so replacing what stands under an established one is the
 * effect the pair guards on the other route — reachable here without it, and
 * measured. „Umkehrbar" describes the *act*, not who may undo it: nobody but
 * the renamer ever learns the old name.
 *
 * Same `templateNameSchema` as saving: one rule for what a template may be
 * called, so a name that could never be saved cannot be reached by renaming
 * either.
 */
export const renameFormTemplateRequestSchema = z.strictObject({
  name: templateNameSchema,
});
export type RenameFormTemplateRequest = z.infer<
  typeof renameFormTemplateRequestSchema
>;

/**
 * „Aus diesem Formular aktualisieren" — the content, from the form of the route.
 *
 * **The same pointer shape as when saving, without the name.** The body names a
 * part of the form the route addresses (`PUT /forms/:formId/templates/:id`) and
 * never a document of its own, for both reasons
 * {@link saveFormTemplateRequestSchema} writes down — and the second one is the
 * load-bearing one here too: a client-sent document would carry the redaction
 * marker where the access word stands, so the content of a template is read from
 * the stored form on the server or not at all. The two routes therefore share
 * one implementation of „was ist der Inhalt", not two.
 *
 * **The name stays.** Umbenennen is its own route above; a body that could do
 * both would make „ich wollte nur den Namen ändern" one forgotten field away
 * from an irreversible overwrite.
 *
 * **`kind` repeats the kind of the template, it does not change it.** The server
 * refuses a body whose kind differs from the stored one — a page template that
 * quietly became a form template would move to the other group of the
 * drawer and its row would stop inserting and start creating forms, which is
 * not what „aktualisieren" promises.
 *
 * **A command, not a subscription** : after this call the template
 * holds a *copy* of what the form contained at that moment. It does not follow
 * the form afterwards, and copies already inserted elsewhere do not follow the
 * template.
 */
export const updateFormTemplateContentRequestSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('form') }),
    z.strictObject({ kind: z.literal('page'), pageId: z.uuid() }),
    z.strictObject({ kind: z.literal('question'), questionId: z.uuid() }),
  ],
);
export type UpdateFormTemplateContentRequest = z.infer<
  typeof updateFormTemplateContentRequestSchema
>;

/**
 * The stored content of a template — the shape of `form_template.content`.
 *
 * A discriminated union rather than three nullable columns, so „eine
 * Seiten-Vorlage ohne Seite" has no spelling. It is parsed on the way out of
 * the database as well as on the way in: JSONB accepts any JSON, so „die
 * Datenbank prüft das" is never true (the same sentence `schema.prisma` writes
 * over `draft_schema`).
 *
 * **What a form template carries, field by field, decided against
 * `schema.prisma` and `form-settings.ts`** (a trap named by an earlier review):
 *
 * | carried | not carried, and why |
 * |---|---|
 * | `title` | `publicSlug` — an address belongs to one form, never to a template |
 * | `definition` (pages, questions, conditions) | `status`, `publishedVersionId`, `FormVersion` — a template has no versions |
 * | `settingsOverride` **minus the access word** | the access word itself (Konzept no. 14: it is stored decryptable, and it is sealed under the *source form's* id) |
 * | | `Response`, `EventRegistration`, `ResponseDraft`, `File`, `MailLog` — nothing was ever submitted to a template |
 * | | `Notification` — see the note on {@link formTemplateFormContentSchema} |
 * | | `FormPermission`, `revision`, `settingsRevision`, `deletedAt` — row bookkeeping of one form |
 */
export const formTemplateFormContentSchema = z.strictObject({
  kind: z.literal('form'),
  title: z.string().min(1).max(FORM_TEMPLATE_NAME_MAX),
  definition: formDefinitionSchema,
  /**
   * The source form's `settings_override` **with the access word taken out**.
   *
   * **`formSettingsOverrideShape` and not `z.unknown()`** (a later fix). It used to be `z.unknown()` with the argument that the full
   * override schema needs the *system layer* to judge its cross-field rules,
   * and that layer may legitimately have moved between the day a template was
   * saved and the day it is used — a template must not stop parsing because
   * somebody changed a system default. That argument holds for the *rules* and
   * not for the *shape*: which keys exist and what type they carry is a
   * property of the document alone. Leaving both unstated made the one field
   * that can hold a secret the only field this file did not describe, and a
   * hand-written row („a hand written UPDATE, an import, a restore" — the same
   * threat model `stripOverridePassword` was written for) travelled from here
   * into `form.settings_override` byte for byte: *measured on 2026-08-05* a
   * plaintext access word **and** a foreign key, then a permanent 500 on
   * `GET /forms/:id/settings`, no longer repairable through the interface.
   *
   * The cross-field half is where it always belonged and where the system
   * layer is actually in hand: `FormsService.create` parses this document
   * against the layer that applies **at insertion time** and answers 422 if it
   * does not hold together. The two checks are deliberately not the same one
   * twice — this one is a floor that applies to every read of the row
   * (`parseStoredTemplateContent`), that one is the judgement of the moment.
   */
  settingsOverride: formSettingsOverrideShape,
});

export const formTemplatePageContentSchema = z.strictObject({
  kind: z.literal('page'),
  page: pageSchema,
});

export const formTemplateQuestionContentSchema = z.strictObject({
  kind: z.literal('question'),
  question: questionSchema,
});

export const formTemplateContentSchema = z.discriminatedUnion('kind', [
  formTemplateFormContentSchema,
  formTemplatePageContentSchema,
  formTemplateQuestionContentSchema,
]);
export type FormTemplateContent = z.infer<typeof formTemplateContentSchema>;

/**
 * What `POST /form-templates/:id/instance` hands the builder back: the stored
 * block **with fresh ids**, ready to be appended to the document the builder
 * is holding.
 *
 * **The ids are minted on the server, not in the builder.** They have to be
 * new on *every* insertion — one template inserted twice into one form must not
 * produce two pages with the same question ids, which `formDefinitionSchema`
 * rejects outright and which would make one answer key stand for two questions.
 * Putting that in the client would be the second implementation of
 * `duplicateQuestions` this project keeps removing, and it would be the one
 * nobody can measure from `apps/api`.
 *
 * **No `form` member**, and that is a decision rather than an omission: a form
 * template does not become a document the builder appends, it becomes a **row**
 * — `POST /forms` with `templateId`, so the settings travel server-side and
 * never through a client that cannot see the access word. The route answers
 * 422 for that kind and says so.
 */
export const formTemplateInstanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), page: pageSchema }),
  z.strictObject({ kind: z.literal('question'), question: questionSchema }),
]);
export type FormTemplateInstance = z.infer<typeof formTemplateInstanceSchema>;

/** A page instance, narrowed — what the builder appends as a new Seite. */
export type FormTemplatePageInstance = Extract<
  FormTemplateInstance,
  { kind: 'page' }
>;
/** A question instance, narrowed — what the builder appends to the open page. */
export type FormTemplateQuestionInstance = Extract<
  FormTemplateInstance,
  { kind: 'question' }
>;

export function parseFormTemplateList(source: unknown): FormTemplateList {
  return formTemplateListSchema.parse(source);
}

export function parseFormTemplateSummary(source: unknown): FormTemplateSummary {
  return formTemplateSummarySchema.parse(source);
}

export function parseFormTemplateInstance(
  source: unknown,
): FormTemplateInstance {
  return formTemplateInstanceSchema.parse(source);
}

/**
 * How many questions a stored template holds — the number the drawer shows.
 *
 * Here rather than in the API service so the client could compute the same
 * number from the same content if it ever holds one, and so the „Einzelfrage"
 * case is stated once: a question template is one question, always.
 */
export function templateQuestionCount(content: FormTemplateContent): number {
  switch (content.kind) {
    case 'form':
      return content.definition.pages.reduce(
        (total, page) => total + page.questions.length,
        0,
      );
    case 'page':
      return content.page.questions.length;
    case 'question':
      return 1;
  }
}
