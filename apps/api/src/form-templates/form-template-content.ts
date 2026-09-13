import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  formTemplateContentSchema,
  templateQuestionCount,
  type FormTemplateContent,
  type FormTemplateSummary,
} from '@formsache/shared';
import type { FormTemplate, Prisma } from '@prisma/client';

import { isUuid } from '../common/uuid';
import type { TenantScope } from '../tenancy/tenant-scope';

/**
 * The one answer for a template the caller may not see.
 *
 * **„Gibt es nicht" und „gehört einer anderen Organisation" sind dieselbe Antwort**,
 * byte for byte — the rule `FORM_NOT_FOUND_MESSAGE` states for forms, applied
 * to the second thing this milestone makes tenant-bound. A distinguishable
 * refusal would turn the id space into a directory of what other organisations have
 * saved: 404 versus 403 on a guessed id is „gibt es" versus „gibt es nicht",
 * and that is a leak even when nothing is ever handed out.
 *
 * A module-level constant rather than a literal at each `throw`, for the same
 * reason: two spellings drift, and the drift *is* the leak.
 */
export const FORM_TEMPLATE_NOT_FOUND_MESSAGE = 'Vorlage nicht gefunden.';

/**
 * Refusal when a page or question template is handed to „neues Formular aus
 * Vorlage" (`POST /forms` with `templateId`).
 *
 * 422 and not 400: the request is well formed and names a template that exists
 * — it asks for something this template cannot be. Same distinction as
 * `NOTHING_TO_PUBLISH_MESSAGE` in `forms.service.ts`, and the message says
 * where the page and the question *do* go.
 *
 * It lives in this file rather than beside the service that raises the mirror
 * refusal, and the reason is mechanical: `FormsService` needs it, and
 * `FormTemplatesService` already imports `FormsService`. Putting it there
 * would close the import graph into a cycle.
 */
export const FORM_TEMPLATE_NOT_A_FORM_MESSAGE =
  'Diese Vorlage ist kein Formular. Seiten und Fragen werden im Baukasten eingefügt.';

/**
 * Refusal when a form template's stored settings do not hold together against
 * the system layer that applies **now** (a later addition).
 *
 * 422 for the reason the two refusals above are: the request is well formed,
 * names a template of this organisation and comes from somebody allowed to build — the
 * *resource* is what cannot become a form. It is the answer to a row the write
 * path never produced (a hand-written UPDATE, an import, a restore) and to the
 * one legitimate case the old `z.unknown()` comment feared: a system default
 * moved, and a document saved under the old one no longer applies. Both end in
 * the same next step — save the template again from a form whose settings are
 * current — so they get the same sentence.
 *
 * **The alternative was measured and is worse**: writing the document through
 * unchecked stored a form nobody can open again (`GET /forms/:id/settings`
 * answers 500 for good, and the settings page is the only place that could
 * repair it).
 */
export const FORM_TEMPLATE_SETTINGS_INVALID_MESSAGE =
  'Die Einstellungen dieser Vorlage lassen sich nicht auf ein neues Formular anwenden. Bitte die Vorlage neu speichern.';

/**
 * Resolves a template of the scope, or raises the one 404.
 *
 * A module-level function and not a method, because two services need it: the
 * template routes themselves and `FormsService.create`, which turns a form
 * template into a form. Re-implementing the lookup at the second call site is
 * how a 403 or a 500 appears where a 404 was promised — the note on
 * `requireForm` in `forms.service.ts` says the same thing about the same shape.
 */
export async function requireTemplate(
  scope: TenantScope,
  id: string,
): Promise<FormTemplate> {
  // Checked before PostgreSQL sees it: an unparseable uuid literal makes the
  // server raise, and a 500 tells the sender their string got that far.
  if (!isUuid(id)) {
    throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
  }
  const template = await scope.formTemplates.findById(id);
  if (template === null) {
    throw new NotFoundException(FORM_TEMPLATE_NOT_FOUND_MESSAGE);
  }
  return template;
}

/**
 * Reads a template's content back out of JSONB — parsed, not cast.
 *
 * The same sentence `parseStoredDefinition` writes over `draft_schema`: the
 * column takes any JSON, so „die Datenbank prüft das" is never true. Every
 * write below goes through the same schema, which makes this a floor rather
 * than a duplicate check — a row that fails here was not written by this
 * application.
 */
export function parseStoredTemplateContent(
  stored: Prisma.JsonValue,
): FormTemplateContent {
  const parsed = formTemplateContentSchema.safeParse(stored);
  if (!parsed.success) {
    throw new BadRequestException('Die gespeicherte Vorlage ist ungültig.');
  }
  return parsed.data;
}

/** A stored row as the drawer lists it — the count computed, never stored. */
export function templateSummaryOf(row: FormTemplate): FormTemplateSummary {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    questionCount: templateQuestionCount(
      parseStoredTemplateContent(row.content),
    ),
    createdAt: row.createdAt.toISOString(),
  };
}
