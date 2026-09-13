import type {
  FormTemplateInstance,
  FormTemplateSummary,
  RenameFormTemplateRequest,
  SaveFormTemplateRequest,
  UpdateFormTemplateContentRequest,
} from '@formsache/shared';
import {
  parseFormTemplateInstance,
  parseFormTemplateList,
  parseFormTemplateSummary,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';

/**
 * Server state of *Vorlagen & Blöcke*.
 *
 * The list is a **query**; saving, inserting and deleting are mutations. That
 * inserting is a mutation and not a read is not bookkeeping: the answer is
 * different on every call — the server mints fresh ids each time — so a cache
 * on it would hand the same ids to two insertions and produce a document
 * `formDefinitionSchema` refuses outright.
 */

export const FORM_TEMPLATES_QUERY_KEY = ['form-templates'] as const;

/**
 * The templates of the active Organisation.
 *
 * `enabled` for the reason `useForms` states it: without a tenant scope the
 * route answers 403, and asking anyway turns a state the app can explain into
 * an error it cannot.
 */
export function useFormTemplates(
  enabled = true,
): UseQueryResult<FormTemplateSummary[]> {
  return useQuery({
    queryKey: FORM_TEMPLATES_QUERY_KEY,
    enabled,
    queryFn: async () =>
      parseFormTemplateList(
        await requestJson('/form-templates', { method: 'GET' }),
      ).templates,
  });
}

export interface SaveTemplateVariables {
  readonly formId: string;
  readonly request: SaveFormTemplateRequest;
}

/**
 * „☆ Als Vorlage speichern" — on the form, a page or a question.
 *
 * The request names the **part**, never the document: the server copies what
 * it has stored. Which means the surface has to save the draft first, and
 * `BuilderView` does exactly that before calling this.
 */
export function useSaveFormTemplate(): UseMutationResult<
  FormTemplateSummary,
  Error,
  SaveTemplateVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, request }: SaveTemplateVariables) =>
      parseFormTemplateSummary(
        await requestJson(`/forms/${encodeURIComponent(formId)}/templates`, {
          method: 'POST',
          body: request,
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: FORM_TEMPLATES_QUERY_KEY,
      });
    },
  });
}

export interface RenameTemplateVariables {
  readonly templateId: string;
  readonly name: string;
}

/**
 * „Umbenennen" — the name of the template, and nothing else.
 *
 * Its own mutation next to {@link useUpdateFormTemplateContent} and not a
 * variant of it, because the two are unequal in exactly the way that matters:
 * this one is reversible and asks for `can_build`, the other throws content
 * away for good and asks for the pair. One hook with an optional field would
 * put both behind one call site.
 */
export function useRenameFormTemplate(): UseMutationResult<
  FormTemplateSummary,
  Error,
  RenameTemplateVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ templateId, name }: RenameTemplateVariables) =>
      parseFormTemplateSummary(
        await requestJson(`/form-templates/${encodeURIComponent(templateId)}`, {
          method: 'PATCH',
          body: { name } satisfies RenameFormTemplateRequest,
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: FORM_TEMPLATES_QUERY_KEY,
      });
    },
  });
}

export interface UpdateTemplateVariables {
  readonly formId: string;
  readonly templateId: string;
  readonly request: UpdateFormTemplateContentRequest;
}

/**
 * „Aus diesem Formular aktualisieren" — the content is overwritten.
 *
 * The request names the **part**, never the document, for the reason
 * {@link useSaveFormTemplate} states: the server copies what it has stored, so
 * the surface saves the draft first — `BuilderView` does that here too.
 *
 * **Irreversible**, and the surface says so before it calls: there is no
 * trash for a template and no earlier content to read back.
 */
export function useUpdateFormTemplateContent(): UseMutationResult<
  FormTemplateSummary,
  Error,
  UpdateTemplateVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({
      formId,
      templateId,
      request,
    }: UpdateTemplateVariables) =>
      parseFormTemplateSummary(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/templates/${encodeURIComponent(templateId)}`,
          {
            method: 'PUT',
            body: request,
          },
        ),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: FORM_TEMPLATES_QUERY_KEY,
      });
    },
  });
}

/** „Einfügen" — the stored block with fresh ids, for the builder to append. */
export function useInsertFormTemplate(): UseMutationResult<
  FormTemplateInstance,
  Error,
  string
> {
  return useMutation({
    retry: false,
    mutationFn: async (templateId: string) =>
      parseFormTemplateInstance(
        await requestJson(
          `/form-templates/${encodeURIComponent(templateId)}/instance`,
          {
            method: 'POST',
          },
        ),
      ),
  });
}

/** Removes a template — physically, and it takes no form with it. */
export function useDeleteFormTemplate(): UseMutationResult<
  void,
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (templateId: string) =>
      requestVoid(`/form-templates/${encodeURIComponent(templateId)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: FORM_TEMPLATES_QUERY_KEY,
      });
    },
  });
}
