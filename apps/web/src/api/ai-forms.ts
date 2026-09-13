import type {
  AiFormDraftResponse,
  AiQuota,
  FormDefinition,
} from '@formsache/shared';
import {
  aiFormPromptRequestSchema,
  parseAiFormDraftResponse,
  parseAiQuota,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useCreateForm, useSaveForm } from './forms';
import type { FormDetail } from '@formsache/shared';
import { requestJson } from './http';

/**
 * The browser's half of the KI-Formularerstellung.
 *
 * Two requests and a **third that is not one**, and the third is the point of
 * the whole module: generating asks the server for a suggestion, adopting
 * creates a form — and **nothing in between writes anywhere**. ADR-0015 no. 11
 * puts it on the server side („die Route speichert kein Formular"); this file
 * is the client side of the same sentence, which is why *Verwerfen* has no
 * function here at all. There is nothing to undo, because nothing was done.
 *
 * Every response is parsed through the shared contract (`CONTRIBUTING.md`). The
 * generated definition is **foreign data twice over** — a model wrote it and
 * an HTTP body carried it — so it reaches the interface only through
 * `formDefinitionSchema`, never as a cast.
 */

/** `POST` — one free text in, one suggestion out. Nothing is stored. */
export const AI_FORMS_PATH = '/ai/forms';

/** `GET` — the organisation's own consumption. Read-only, by design. */
export const AI_QUOTA_PATH = '/ai/quota';

/** Cache key of the quota query. One key, so invalidation is unambiguous. */
export const AI_QUOTA_QUERY_KEY = ['ai', 'quota'] as const;

/**
 * Consumption and remainder of the organisation in the current month.
 *
 * **Auskunft, kein Stellrad** : the organisation sees what it used, the
 * Kontingent itself is the Superadmin's. There is deliberately no mutation
 * beside this query — a settable number here would be a second authority over
 * a budget the server owns.
 *
 * `enabled` because the only reader is the dialogue: asking on every page load
 * would spend a request on a number nobody is looking at, and in an
 * installation without the feature the route answers 404.
 */
export function useAiQuota(enabled: boolean): UseQueryResult<AiQuota> {
  return useQuery({
    queryKey: AI_QUOTA_QUERY_KEY,
    enabled,
    queryFn: async () =>
      parseAiQuota(await requestJson(AI_QUOTA_PATH, { method: 'GET' })),
  });
}

export interface GenerateAiFormVariables {
  /** The editor's own words — the **only** thing that leaves (ADR-0015 no. 4). */
  readonly prompt: string;
  /**
   * Cancels the run.
   *
   * Required rather than optional: a caller that cannot cancel is a dialogue
   * whose *Abbrechen* is a lie, and the one caller there is always has a
   * controller anyway. `language` is deliberately **not** a variable — there
   * is one member of `formLanguageSchema`, and a parameter for it would be a
   * knob that says nothing.
   */
  readonly signal: AbortSignal;
}

/**
 * Asks the model for a suggestion — **and creates nothing**.
 *
 * The body goes through `aiFormPromptRequestSchema` on the way *out* as well
 * as on the way in. That is not belt-and-braces: it is the same bound the
 * textarea shows and the server enforces, read from one place, so „zu lang"
 * cannot mean three different lengths (`CONTRIBUTING.md`). The server validates
 * again regardless — client validation is UX, never truth.
 *
 * **A refused model answer is a 200 with `ok: false`**, not an HTTP error: the
 * request itself succeeded, the call was counted, and the six named failures
 * carry more than a status code can (see `aiFormDraftResponseSchema`). Only
 * the guard chain, the missing feature (404) and the exhausted Kontingent
 * (429) arrive as `ApiError`.
 */
export function useGenerateAiForm(): UseMutationResult<
  AiFormDraftResponse,
  Error,
  GenerateAiFormVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    // A repeat is a second call the organisation pays for (ADR-0015 no. 7). Retrying
    // silently would spend somebody's Kontingent on a decision they did not
    // take.
    retry: false,
    mutationFn: async ({ prompt, signal }: GenerateAiFormVariables) =>
      parseAiFormDraftResponse(
        await requestJson(AI_FORMS_PATH, {
          method: 'POST',
          body: aiFormPromptRequestSchema.parse({ prompt }),
          signal,
        }),
      ),
    onSuccess: (response) => {
      // The answer carries the fresh count in **both** arms — a failed call is
      // a call that was paid for — so the displayed number moves without a
      // second round trip.
      queryClient.setQueryData(AI_QUOTA_QUERY_KEY, response.quota);
    },
    onError: () => {
      // A refused request may still have moved the count — a 429 for an
      // exhausted Kontingent carries the numbers in its body, and this client
      // does not read bodies off errors. Asking again is one request and keeps
      // the figure on screen from being the one that made somebody try a
      // seventh time against a limit of five.
      void queryClient.invalidateQueries({ queryKey: AI_QUOTA_QUERY_KEY });
    },
  });
}

export interface AdoptAiFormVariables {
  /** The title the editor confirmed — theirs, never silently the model's. */
  readonly title: string;
  readonly definition: FormDefinition;
}

/**
 * *Übernehmen* — **a new form, never the open draft** (* ADR-0015 no. 11).
 *
 * The prototype loads the result straight into the builder. We deviate on
 * purpose, and this function is where the deviation is made of code rather
 * than of intention: it knows no form id to write into. There is no parameter
 * for one, so „übernimm in das offene Formular" is not a mistake this can make
 * — it is a sentence that cannot be written down here at all.
 *
 * **It goes through the existing creation path**, `useCreateForm` and
 * `useSaveForm`, rather than a route of its own: a form comes into existence in
 * exactly one place (`createFormRequestSchema`'s own comment), and a second
 * one would be the „zweiter Schreibpfad ohne den Filter des ersten" that cost
 * this project two leaked secrets. Cache invalidation therefore stays
 * where it already lives.
 *
 * ⚠️ **Two requests, and the gap between them is named rather than hidden.**
 * `POST /forms` creates the empty form, `PUT /forms/:id` fills it. If the
 * second fails, an **empty** form of that name exists — visible in the list,
 * deletable, and with nothing lost, because the suggestion is still on screen
 * in the dialogue. The alternative (a create route that takes a definition)
 * would be a second creation path for one saved round trip; the alternative
 * that would actually be worse is the one this exists to prevent, namely
 * writing into a draft somebody else's work is in.
 */
export function useAdoptAiForm(): UseMutationResult<
  FormDetail,
  Error,
  AdoptAiFormVariables
> {
  const createForm = useCreateForm();
  const saveForm = useSaveForm();

  return useMutation({
    retry: false,
    mutationFn: async ({ title, definition }: AdoptAiFormVariables) => {
      const created = await createForm.mutateAsync({ title });
      return saveForm.mutateAsync({
        formId: created.id,
        // `created.revision` is the revision this editor started from — the
        // form was made one call ago and nobody else has seen it, so the
        // check can only pass, and passing it anyway keeps the one save path
        // honest instead of growing a second, check-free variant.
        request: { title, definition, revision: created.revision },
      });
    },
  });
}
