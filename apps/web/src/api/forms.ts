import type {
  CreateFormRequest,
  FormDetail,
  FormListPage,
  Permissions,
  PublishPreview,
  UpdateFormRequest,
} from '@formsache/shared';
import {
  FORM_PAGE_SIZE_DEFAULT,
  parseFormDetail,
  parseFormListPage,
  parsePublishPreview,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, requestJson } from './http';

/**
 * Server state of the forms — TanStack Query only (`CONTRIBUTING.md`).
 *
 * The builder's *editing* state lives in a Zustand store next door
 * (`builder/builder-store.ts`) and the two never write into each other. The
 * split is not a style preference: the draft in the builder is a document
 * being changed keystroke by keystroke, while this cache holds what the server
 * last confirmed. Mixing them would make "unsaved" and "saved" the same value,
 * and the save button could not tell the difference either.
 *
 * Every response is parsed through the shared contract. A payload missing
 * `revision` would otherwise render a builder that cannot save — and it would
 * fail at the moment of saving rather than at the moment of loading.
 */

export const FORMS_QUERY_KEY = ['forms'] as const;

export function formQueryKey(formId: string): readonly string[] {
  return ['forms', formId];
}

/** What a caller may ask of {@link useFormPage}. */
export interface FormPageParams {
  /** Zero-based row offset — `page * limit`, never a page number. */
  readonly offset?: number;
  readonly limit?: number;
  /**
   * The dashboard's search term. It travels to the server; filtering the loaded page here would report „keine Treffer"
   * for a form on page three.
   */
  readonly search?: string;
}

/**
 * Builds the query string of one page — one place, so the query **key** and the
 * request cannot disagree.
 *
 * They would be free to: TanStack caches by key, and a key that omitted the
 * search term would serve the results of the last term under the new one. The
 * key below is derived from exactly this object for that reason.
 */
function pageQuery(params: FormPageParams): {
  key: Required<FormPageParams>;
  search: string;
} {
  const key = {
    offset: params.offset ?? 0,
    limit: params.limit ?? FORM_PAGE_SIZE_DEFAULT,
    search: params.search?.trim() ?? '',
  };
  const query = new URLSearchParams({
    limit: String(key.limit),
    offset: String(key.offset),
  });
  if (key.search !== '') {
    query.set('q', key.search);
  }
  return { key, search: query.toString() };
}

/**
 * **One page** of the active organisation's forms.
 *
 * The successor of `useForms()`, which fetched every form of the organisation —
 * Konzept no. 75 measured what that costs (2748 forms, 2.8 s of blocked main
 * thread) and this is the repair. What changes for callers is that the answer
 * is an object: `items` is the page, `total` is the whole list, and the two are
 * not interchangeable — the dashboard's „n Formulare" is `total`.
 *
 * `enabled` rather than an unconditional fetch: without a tenant scope the
 * route answers 403, and asking anyway would turn a state the app can explain
 * ("bitte einen Tenant wählen") into an error it cannot.
 *
 * **`placeholderData` keeps the previous page on screen while the next one
 * loads.** Without it every „Weiter" unmounts the grid, the page height jumps
 * to the loading line and the button the reader just pressed moves out from
 * under their pointer. The state stays visible in `isFetching` for anything
 * that wants to say „lädt".
 */
export function useFormPage(
  params: FormPageParams = {},
  enabled = true,
): UseQueryResult<FormListPage> {
  const { key, search } = pageQuery(params);
  return useQuery({
    queryKey: [...FORMS_QUERY_KEY, 'page', key],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async () =>
      parseFormListPage(
        await requestJson(`/forms?${search}`, { method: 'GET' }),
      ),
  });
}

/**
 * **One form's summary, by id** — the same list statement, narrowed to one row.
 *
 * It exists because the list is paged now. „Erfolgreich geladen und nicht
 * darin" used to be a verdict (see {@link useFormPermissions}); with a page it
 * would be a guess, and the guess would be wrong for every form past the first
 * twenty-four. Asking for the one row keeps the verdict exact without asking
 * the client to know which page a form is on.
 *
 * Deliberately **not** `GET /forms/:id`: that route is behind the fourth link
 * of the guard chain and answers 403 to a caller capped out of it — the very
 * person whose answer is needed. The list route names no form, so the
 * restriction narrows the result instead of refusing the request.
 */
export function useFormSummary(
  formId: string | null,
): UseQueryResult<FormListPage> {
  return useQuery({
    queryKey: [...FORMS_QUERY_KEY, 'by-id', formId],
    enabled: formId !== null,
    queryFn: async () =>
      parseFormListPage(
        await requestJson(`/forms?id=${encodeURIComponent(formId ?? '')}`, {
          method: 'GET',
        }),
      ),
  });
}

/** The all-false answer for a form the list has ruled out — see below. */
const NO_PERMISSIONS: Permissions = {
  canBuild: false,
  canViewResponses: false,
  canExport: false,
  canManageSettings: false,
  canManageFormSettings: false,
  canManageUsers: false,
};

/**
 * What the signed-in person may do **on one form** — the server's answer, not
 * the organisation-wide flags of the membership (the requirement no. 3).
 *
 * Two states collapse into `undefined`, and callers may treat them alike
 * (`AppShell` falls back to the membership's flags, its upper bound) but must
 * not treat them the same as the third:
 *
 * - **`undefined` — not known yet.** The list is still in flight or the
 *   request failed. The membership fallback is sound here precisely because
 *   it is a fallback for missing information, not a verdict.
 * - **`NO_PERMISSIONS` — known, and it is none.** The server answered about
 *   **this** form and returned no row: the form is locked out (`accessRevoked`,
 *   permanently absent by `formFilter()`) or belongs to another tenant. Falling
 *   back to the membership here would be the bug this hook exists to avoid:
 *   offering „Bearbeiten / Antworten / Nutzerrechte" for a form whose first
 *   request answers 404.
 *
 * ⚠️ **The second reading used to come out of the whole list, and paging the
 * route made that unsound.** The old comment argued it in as many words — „`GET /forms`
 * carries no `take`/pagination, so a *successfully loaded* list without this
 * form is never ‚not fetched far enough'". Paging the route falsified exactly
 * that sentence: a form on page two is absent from a perfectly successful
 * response, and reading `NO_PERMISSIONS` off that absence would strip the
 * navigation of every form past the twenty-fourth. So the question is now asked
 * **about the one form** ({@link useFormSummary}) instead of inferred from a
 * list that no longer claims to be complete.
 *
 * **Still the list route rather than `GET /forms/:id`**, and that half is
 * unchanged: a cap answers 403 on the routes it takes away, so somebody capped
 * to a role without `can_build` **and** without `can_view_responses` gets 403
 * from the detail route — the very person whose navigation has to shrink would
 * be the one it could not answer for. `GET /forms?id=…` names no form *to the
 * guard*, so the fourth link narrows the result instead of refusing the
 * request: a capped form is in the answer (a cap answers 403, it does not
 * hide), a revoked one is not.
 */
export function useFormPermissions(
  formId: string | null,
): Permissions | undefined {
  const forms = useFormSummary(formId);
  if (formId === null) {
    return undefined;
  }
  const found = forms.data?.items.find(
    (form) => form.id === formId,
  )?.permissions;
  if (found !== undefined) {
    return found;
  }
  return forms.isSuccess || isRuledOut(forms.error)
    ? NO_PERMISSIONS
    : undefined;
}

/**
 * „Der Server hat geantwortet, und die Antwort ist: dieses Formular gibt es für
 * dich nicht" — told apart from „noch nicht bekannt" (review finding).
 *
 * The one refusal that means it is **400**, and only since the question is
 * asked by id: `formListQuerySchema` parses `id` as a uuid, so a form id out of
 * a stale bookmark or a hand-edited address (`/forms/kaputt`) does not
 * parse and the route answers 400. Before the list was paged that request
 * simply succeeded and the form's absence was the verdict; without this the
 * failed request would fall through to „noch nicht bekannt", `AppShell` would
 * use the membership's flags, and the navigation would offer „Bearbeiten /
 * Antworten / Nutzerrechte" for a form that does not exist.
 *
 * **Deliberately only 400.** A 403 means the caller may not read the list at
 * all in this organisation and a 5xx means the server is broken — neither is a
 * statement about *this* form, and answering „keine Rechte" to a server fault
 * would make an outage look like a permission change.
 */
function isRuledOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

/**
 * One form with its definition.
 *
 * No `retry` override: the client default (`query-client.ts`) retries only a
 * lost connection, which is exactly what is wanted here. A form id out of a
 * stale bookmark answers 404 — a normal answer to this question — and a 500 is
 * an answer too; repeating either would only delay the message.
 *
 * `enabled` for the reason `useForms` has it: a view that already knows it will
 * not show the form should not ask for it first (`PreviewView` without
 * `canBuild`). The default is `true`, so no existing caller changes behaviour.
 */
export function useForm(
  formId: string,
  enabled = true,
): UseQueryResult<FormDetail> {
  return useQuery({
    queryKey: formQueryKey(formId),
    queryFn: async () =>
      parseFormDetail(
        await requestJson(`/forms/${encodeURIComponent(formId)}`, {
          method: 'GET',
        }),
      ),
    enabled,
  });
}

export function useCreateForm(): UseMutationResult<
  FormDetail,
  Error,
  CreateFormRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: CreateFormRequest) =>
      parseFormDetail(
        await requestJson('/forms', { method: 'POST', body: request }),
      ),
    onSuccess: async (form) => {
      queryClient.setQueryData(formQueryKey(form.id), form);
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

/**
 * „⧉ Duplizieren" on the dashboard card.
 *
 * `POST /forms/:id/duplicate` takes no body — the server decides everything
 * about the copy (name, ids, what is left out) — so the mutation's variable
 * is just the id of the form to duplicate.
 */
export function useDuplicateForm(): UseMutationResult<
  FormDetail,
  Error,
  string
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (formId: string) =>
      parseFormDetail(
        await requestJson(`/forms/${encodeURIComponent(formId)}/duplicate`, {
          method: 'POST',
        }),
      ),
    onSuccess: async (form) => {
      queryClient.setQueryData(formQueryKey(form.id), form);
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

export interface SaveFormVariables {
  readonly formId: string;
  readonly request: UpdateFormRequest;
}

/**
 * Saves title and definition.
 *
 * A 409 means someone else saved since the revision this editor loaded
 * . It is deliberately **not** retried and **not** merged:
 * the server refused for a reason, and a client that quietly retried with the
 * fresh revision would perform exactly the silent overwrite the check exists
 * to prevent.
 */
export function useSaveForm(): UseMutationResult<
  FormDetail,
  Error,
  SaveFormVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, request }: SaveFormVariables) =>
      parseFormDetail(
        await requestJson(`/forms/${encodeURIComponent(formId)}`, {
          method: 'PUT',
          body: request,
        }),
      ),
    onSuccess: async (form) => {
      queryClient.setQueryData(formQueryKey(form.id), form);
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

function publishPreviewQueryKey(formId: string): readonly string[] {
  return ['forms', formId, 'publish-preview'];
}

/**
 * What publishing again would change (Konzept no. 23).
 *
 * **Never fetched on its own** — `enabled: false`, and the view asks for it
 * with `refetch()` at the moment the publish button is pressed. Two reasons,
 * and both are about the answer being a snapshot rather than a resource:
 *
 * 1. It describes *one* revision of the draft (`revision` in the payload). An
 *    answer fetched while the builder loaded would describe the state before
 *    everything typed and saved since, and the editor would confirm a list
 *    that no longer holds.
 * 2. It counts answers, which keep arriving. The count is worth stating at the
 *    moment of the decision, not as of whenever the view was opened.
 *
 * `staleTime: 0` for the same reason: every press asks the server again rather
 * than re-showing the previous press's verdict.
 */
export function usePublishPreview(
  formId: string,
): UseQueryResult<PublishPreview> {
  return useQuery({
    queryKey: publishPreviewQueryKey(formId),
    enabled: false,
    staleTime: 0,
    queryFn: async () =>
      parsePublishPreview(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/publish-preview`,
          {
            method: 'GET',
          },
        ),
      ),
  });
}

export interface PublishFormVariables {
  readonly formId: string;
  readonly revision: number;
}

export function usePublishForm(): UseMutationResult<
  FormDetail,
  Error,
  PublishFormVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, revision }: PublishFormVariables) =>
      parseFormDetail(
        await requestJson(`/forms/${encodeURIComponent(formId)}/publish`, {
          method: 'POST',
          body: { revision },
        }),
      ),
    onSuccess: async (form) => {
      queryClient.setQueryData(formQueryKey(form.id), form);
      await queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
    },
  });
}

/** True when an error is the concurrent-edit refusal of the requirement. */
export function isStaleRevision(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * True when the server refused a publish because the draft is already the
 * version in force (Konzept no. 29).
 *
 * Told apart from {@link isStaleRevision} by the status code, which is why the
 * server answers 422 rather than a second 409: the two refusals ask for
 * opposite reactions — „nichts zu tun" against „bitte neu laden" — and
 * `ApiError` carries nothing else to distinguish them by. Reading the message
 * text instead would tie the client to a German sentence on the server.
 *
 * The builder normally never provokes this: with nothing to publish the button
 * is locked. What is left is the race — a second tab published a moment ago —
 * and that is precisely the case where the wrong sentence would mislead.
 */
export function isNothingToPublish(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422;
}
