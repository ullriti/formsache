import type {
  PublicFormResponse,
  ResponseDraft,
  ResponseEdit,
  SavedDraft,
  SubmitResponseResponse,
  UploadedFile,
} from '@formsache/shared';
import {
  parseAccessGrant,
  parsePublicFormResponse,
  parseResponseDraft,
  parseResponseEdit,
  parseSavedDraft,
  parseSubmitResponse,
  parseUploadedFile,
} from '@formsache/shared';
import { useRef, useState } from 'react';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, requestJson, requestUpload, requestVoid } from './http';

/**
 * The public fill-in calls.
 *
 * No cache invalidation and no query keys beyond the form itself: there is no
 * session here and nothing else on the page to keep in step. A participant
 * loads one form, fills it in and leaves.
 */

/**
 * Header the access proof travels in — the server's `ACCESS_PROOF_HEADER`
 * (`apps/api/src/public/public-forms.controller.ts`).
 *
 * Spelled a second time rather than imported, like the CSRF names in `http.ts`
 * and for the same reason: `@formsache/shared` describes *messages*, and a header name
 * is transport. If the two ever disagree, every protected form answers `locked`
 * again immediately — a failure one finds on the first click, unlike a silent
 * one.
 */
const ACCESS_PROOF_HEADER = 'X-Form-Access';

function accessHeaders(proof: string | undefined): Record<string, string> {
  return proof === undefined ? {} : { [ACCESS_PROOF_HEADER]: proof };
}

/**
 * What the browser hands in — the answers, plus the decoy of the requirement.
 *
 * An object rather than the bare `answers` map the two mutations used to take,
 * and the shape is what makes the decoy impossible to forget: a caller that
 * knows only about answers no longer compiles. It is **beside** the answers,
 * never inside them, exactly as it is on the wire — a key inside `answers` is a
 * key the server stores as a value to a question nobody asked
 * (`packages/shared/src/public-form.ts`).
 *
 * `honeypot` is required here and optional on the wire, and the asymmetry is
 * deliberate in the same way `startToken`'s is: *this* client always sends the
 * field, because a request whose shape depends on what the participant did is a
 * request a bot can be told apart from — while a client that sends nothing must
 * still be served, or an old tab would lose its registration over a decoy.
 */
export interface PublicSubmission {
  readonly answers: Record<string, unknown>;
  /** Empty for every ordinary participant — see `fill/HoneypotField.tsx`. */
  readonly honeypot: string;
}

/**
 * Uploads one attachment and answers with what the **server** kept.
 *
 * Three doors, one function, because the caller — a field inside `FillIn` — is
 * the same component on all three paths and must not have to know which view it
 * is inside. Which door it is is decided here by what the caller has:
 *
 * - a **slug** (plus the access proof, if the form was locked) on the public
 *   fill-in view;
 * - an **edit token** on the correction view, whose route runs the *edit*
 *   refusal chain instead of the submission's — no password gate, because the
 *   confirmation mail that carries the link carries no access word
 *   (`PublicEditFilesController`);
 * - a **draft token** on the resumed *Zwischenspeichern* (`ResponseDraftView`),
 *   whose route runs the *draft* chain — the one 404 and `saving_disabled`.
 *   Added after an acceptance run measured what its absence cost: a resumed
 *   draft offered a live „Entfernen" beside a dead picker, so the one thing a
 *   participant could do to their attachment was lose it.
 *
 * Not a `useMutation`: an upload is started per file from an `onChange`, its
 * result belongs into one question's answer, and a shared mutation state across
 * several questions would report the wrong field as busy. `FileField` keeps its
 * own per-question state.
 */
export type UploadTarget =
  | { readonly kind: 'form'; readonly slug: string; readonly proof?: string }
  | { readonly kind: 'edit'; readonly token: string }
  | { readonly kind: 'draft'; readonly token: string };

export async function uploadAttachment(
  target: UploadTarget,
  file: File,
): Promise<UploadedFile> {
  return parseUploadedFile(
    await requestUpload(
      uploadPath(target),
      file,
      // Only the fill-in's door has a gate to prove anything to; the other two
      // carry a capability in the address, which is the proof.
      target.kind === 'form' ? accessHeaders(target.proof) : {},
    ),
  );
}

/** One `switch`, exhaustive — a fourth door has to name its route here. */
function uploadPath(target: UploadTarget): string {
  switch (target.kind) {
    case 'form':
      return `/public/forms/${encodeURIComponent(target.slug)}/files`;
    case 'edit':
      return `/public/responses/${encodeURIComponent(target.token)}/files`;
    case 'draft':
      return `/public/drafts/${encodeURIComponent(target.token)}/files`;
  }
}

export function publicFormQueryKey(
  slug: string,
  proof: string | undefined,
): readonly string[] {
  /*
   * The proof is part of the key, and that is what makes the gate work without
   * a manual refetch: passing it turns „locked" into „unlocked" by asking a
   * different question rather than by invalidating an answer.
   *
   * Its *presence* rather than its value would have been enough here, but the
   * value costs nothing and is honest — two different proofs really are two
   * different requests, and a cache that pretended otherwise would serve one
   * form's answer for another's key if this hook is ever used twice on a page.
   */
  return ['public-form', slug, proof ?? ''];
}

/**
 * A refusal because a Veranstaltung has no room left.
 *
 * The one refusal that makes the **read** stale: the seat states this page is
 * rendering (`eventSeats`) were true when the form was loaded and are provably
 * not any more — the server has just judged the registration against a newer
 * count. Every other refusal is about the form as a whole and leaves the payload
 * as valid as it was.
 */
function refusedForEventFull(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.refusal?.reason === 'event_full'
  );
}

export function usePublicForm(
  slug: string,
  proof?: string,
): UseQueryResult<PublicFormResponse> {
  return useQuery({
    queryKey: publicFormQueryKey(slug, proof),
    queryFn: async () =>
      parsePublicFormResponse(
        await requestJson(`/public/forms/${encodeURIComponent(slug)}`, {
          method: 'GET',
          headers: accessHeaders(proof),
        }),
      ),
    // No `retry` override: the client default (`query-client.ts`) already
    // retries only a lost connection, which is the case that matters for a
    // participant on a phone. A 404 is the normal answer for a link that has
    // expired or never opened — repeating it would only delay the message.
  });
}

/**
 * Offers the access word and, if it was the right one, receives the proof.
 *
 * **The word goes into the body of a `POST` and nowhere else.** Never into the
 * query string, never into the path — a URL is written to the server's access
 * log, handed to the next site in `Referer` and kept in the browser's history.
 *
 * `retry: false`: a retried guess spends another of the ten attempts a minute
 * the server allows for this form and address, and the participant is standing
 * in front of the field anyway.
 */
export function useUnlockForm(
  slug: string,
): UseMutationResult<string, Error, string> {
  return useMutation({
    retry: false,
    mutationFn: async (password: string) =>
      parseAccessGrant(
        await requestJson(`/public/forms/${encodeURIComponent(slug)}/access`, {
          method: 'POST',
          body: { password },
        }),
      ).accessToken,
  });
}

/**
 * Submits the answers.
 *
 * `retry: false`, deliberately: a retried submission is a **second** row in
 * the organisation's registration list, and a participant who sees no confirmation
 * would rather press the button again themselves than have the client do it
 * for them silently.
 */
export function useSubmitResponse(
  slug: string,
  /**
   * The signed start token that came with the form.
   *
   * A parameter of the hook rather than of `mutate`, so the view keeps handing
   * over answers and nothing else: the token belongs to the loaded form, not to
   * the press of the button. It is sent for every form — a form without a time
   * limit ignores it, and leaving it out for those would make the request shape
   * depend on a setting the browser is not supposed to know.
   */
  startToken: string,
  /**
   * The access proof, for a form that has a password gate.
   *
   * Sent as a header, exactly as on the read — see {@link ACCESS_PROOF_HEADER}.
   * `undefined` for a form that was never locked, and the server ignores it
   * there; a form that *is* locked refuses a submission without it, which is the
   * half of the requirement the browser cannot be trusted with.
   */
  proof?: string,
  /**
   * The draft this submission comes out of, if the fill-in view was resumed
   * from one.
   *
   * A parameter of the hook, exactly like `startToken`: it belongs to the
   * page that was loaded, not to the press of the button, and every
   * submission from this page carries the same one. Absent for an ordinary
   * first fill-in, which is every caller except the draft resume view.
   */
  draftToken?: string,
): UseMutationResult<SubmitResponseResponse, Error, PublicSubmission> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ answers, honeypot }: PublicSubmission) =>
      parseSubmitResponse(
        await requestJson(
          `/public/forms/${encodeURIComponent(slug)}/responses`,
          {
            method: 'POST',
            // The decoy travels beside the answers and is
            // sent every time, empty or not — see {@link PublicSubmission}.
            // `draftToken` rides beside them for the same reason it does on
            // the wire (`submitResponseRequestSchema`): a key inside
            // `answers` would be a key the server stores as a value to a
            // question nobody asked.
            body: {
              answers,
              startToken,
              honeypot,
              ...(draftToken === undefined ? {} : { draftToken }),
            },
            headers: accessHeaders(proof),
          },
        ),
      ),
    /*
     * The one place this file invalidates anything.
     *
     * „Diese Veranstaltung ist voll" and a green „2 frei" on the same screen is
     * the state a bare refusal leaves behind: the badge keeps showing the figure
     * the page was loaded with, and it stays wrong until somebody reloads —
     * which is exactly what this refusal must not require, because a reload
     * costs every answer typed so far. Re-reading the form replaces the figures
     * with the ones the server just judged against, and `FillIn` keeps the
     * answers across it (its state is seeded once).
     *
     * Here rather than in the view, because the query key is this module's
     * knowledge — and the *matching* key differs per write path, which is why
     * `useUpdateResponse` carries its own copy of this rather than a shared one.
     */
    onError: (error) => {
      if (refusedForEventFull(error)) {
        void queryClient.invalidateQueries({
          queryKey: publicFormQueryKey(slug, proof),
        });
      }
    },
  });
}

/**
 * The answer behind an edit token, with the form it was given against.
 *
 * The token is the whole capability, so there is nothing else to pass: no slug,
 * no form id, no access proof. The **access proof is deliberately not sent** —
 * the server does not ask for it on this route, and the reasoning is in
 * `PublicFormsService.byEditToken`: the token is only ever issued to somebody
 * who already passed the gate, and the link travels in a mail that carries no
 * access word.
 */
/** The cache key of one answer's edit page — see {@link useResponseEdit}. */
export function responseEditQueryKey(token: string): readonly string[] {
  return ['response-edit', token];
}

export function useResponseEdit(token: string): UseQueryResult<ResponseEdit> {
  return useQuery({
    queryKey: responseEditQueryKey(token),
    queryFn: async () =>
      parseResponseEdit(
        await requestJson(`/public/responses/${encodeURIComponent(token)}`, {
          method: 'GET',
        }),
      ),
  });
}

/**
 * Replaces the answers behind an edit token.
 *
 * `PUT`, matching the route: this replaces one existing answer, it does not
 * create a second one — which is the promise of the requirement, not a matter of
 * REST manners.
 *
 * `retry: false` for the same reason the first submission has it: a retried
 * write is one the participant did not ask for, and they are standing in front
 * of the button.
 */
export function useUpdateResponse(
  token: string,
  /**
   * The start token the edit page was loaded with. The time
   * limit applies to an edit as it applies to a first fill-in — „Zeitlimit pro
   * Ausfüllung", and an edit is one — and reloading starts a fresh attempt.
   */
  startToken: string,
): UseMutationResult<SubmitResponseResponse, Error, PublicSubmission> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ answers, honeypot }: PublicSubmission) =>
      parseSubmitResponse(
        await requestJson(`/public/responses/${encodeURIComponent(token)}`, {
          method: 'PUT',
          // The edit route takes the same shape as the first submission, and
          // that is not tidiness: the edit view *is* the fill-in view
          // , so it renders the same decoy, and a route that
          // silently ignored it would be the one place where the field is
          // present in the page and meaningless on the wire.
          body: { answers, startToken, honeypot },
        }),
      ),
    // The correction path's half of the same rule — and **its own** query: the
    // edit page reads the form (and with it the seat states) through
    // `GET /public/responses/:token`, so invalidating the public form's key here
    // would refresh a cache entry this page does not have and leave the badge in
    // front of the participant untouched.
    onError: (error) => {
      if (refusedForEventFull(error)) {
        void queryClient.invalidateQueries({
          queryKey: responseEditQueryKey(token),
        });
      }
    },
  });
}

/** The first save — `POST` under the form, which is what mints the address. */
async function createDraft(
  slug: string,
  answers: Record<string, unknown>,
  proof: string | undefined,
): Promise<SavedDraft> {
  return parseSavedDraft(
    await requestJson(`/public/forms/${encodeURIComponent(slug)}/drafts`, {
      method: 'POST',
      body: { answers },
      headers: accessHeaders(proof),
    }),
  );
}

/** Every save after it — `PUT` on the draft's own address. */
async function replaceDraft(
  token: string,
  answers: Record<string, unknown>,
): Promise<SavedDraft> {
  return parseSavedDraft(
    await requestJson(`/public/drafts/${encodeURIComponent(token)}`, {
      method: 'PUT',
      body: { answers },
    }),
  );
}

/**
 * *Zwischenspeichern* on the **first** fill-in: the first press creates the
 * draft, every press after it replaces the same one (the evidence; a review finding).
 *
 * ## Why this is one hook and not the bare `POST`
 *
 * The first version handed `useSaveDraft` to the view and never switched.
 * *Measured on 2026-08-05:* pressed *Zwischenspeichern* twice → **two**
 * `POST …/drafts`, two addresses, two rows in `response_draft`. The display
 * replaced the first address with the second without a word, and the first
 * lived on for thirty days — an unreachable address on an **older** state of
 * personal data, plus one consumed unit of `MAX_DRAFTS_PER_FORM` per click.
 * „Ein Teilnehmer, ein Entwurf, eine Adresse" is the promise of the
 * requirement; it cannot depend on how often somebody presses a button.
 *
 * ## Why the token is both a ref **and** state — and why it leaves this hook
 *
 * It used to be a ref and nothing else, with the argument that „nothing renders
 * the token". That argument was wrong about *one* reader, and the omission was
 * a blocking finding of a security review:
 * {@link useSubmitResponse} needs it. Since Konzept no. 82 a save hands this
 * participant's attachments to the draft (`claimForDraft`), so a submission that
 * arrives **without** the draft token names files the claim can no longer take —
 * its `WHERE` asks for „already this draft's, or free and young", and neither
 * holds. *Measured on 2026-08-06 over the real routes:* upload `201` → save
 * the draft `200` → submit **`409 attachment_unavailable`**, „Ein Anhang ist
 * abgelaufen oder nicht mehr verfügbar", for a file that is two seconds old and
 * standing on the screen. The same hole left the draft
 * **unconsumed**: without the token the submission deletes nothing, and a
 * half-filled set of personal answers stayed in `response_draft` for up to
 * thirty days after it had been handed in.
 *
 * So the token goes out — as {@link DraftSaving.token}, in `useState`, because a
 * value a sibling hook reads has to survive into the next render. The **ref
 * stays** and remains what decides „create or replace": that switch must not
 * depend on a render having happened between two clicks, which is exactly what
 * state alone would make it depend on. Two writes of one value at one place, not
 * two truths.
 *
 * ## What happens when the draft vanishes between two presses
 *
 * It can: another device discarded it, the organisation set an access word (Konzept no. 36
 * revokes the drafts of that form), or the retention period ran out. The `PUT` then meets
 * the one 404 of the public routes, and the decision here is deliberate:
 *
 * - **the failure is reported** — this is one mutation, so its error state is
 *   the one the banner already renders, and it stays up until the next attempt;
 * - **the token is dropped, so the *next* press creates a new draft.** The
 *   alternative — keeping it — would leave the button dead for the rest of the
 *   sitting: every further press would `PUT` at the same gone address, and the
 *   answers in front of the participant would be one closed tab away from lost,
 *   which is the exact failure *Zwischenspeichern* exists to prevent.
 * - **nothing is retried automatically.** One press stays one request; the new
 *   draft is created because somebody pressed again, not because this hook
 *   decided to. That is also what keeps a deliberately discarded draft from
 *   being silently recreated behind the participant's back.
 *
 * `retry: false` for the reason the first submission has it, with one addition:
 * a retried `POST` here counts a second time against `draft-quota.ts`.
 *
 * **What still has to hold on the outside:** two saves *in flight at once* would
 * both read an empty token and both create a draft. The button that calls this
 * is `disabled` while the mutation is pending (`FillIn`), which is what makes
 * „ein Druck, eine Anfrage" true — this hook sequences nothing of its own.
 */
export interface DraftSaving {
  /**
   * The mutation the *Zwischenspeichern* button drives — handed to `FillIn` as
   * its `DraftController`, whose shape this already has.
   */
  readonly save: UseMutationResult<SavedDraft, Error, Record<string, unknown>>;
  /**
   * The draft this page is writing on, or `undefined` before the first save
   * and after one that met the 404.
   *
   * **It belongs on the submission** (`useSubmitResponse`'s fourth argument):
   * it is what lets the claim take this draft's attachments and what consumes
   * the draft in the same transaction. See the header above for what its
   * absence measured.
   */
  readonly token: string | undefined;
}

export function useDraftSaving(slug: string, proof?: string): DraftSaving {
  const token = useRef<string | null>(null);
  const [current, setCurrent] = useState<string | undefined>(undefined);

  const save = useMutation({
    retry: false,
    mutationFn: async (answers: Record<string, unknown>) => {
      const existing = token.current;
      const saved =
        existing === null
          ? await createDraft(slug, answers, proof)
          : await replaceDraft(existing, answers);
      // From the answer, never from the request: a `PUT` echoes the token it
      // was addressed with, so this is the same value again — and reading it
      // back from the payload is what makes the field required on the wire
      // rather than an optimisation this file could skip.
      token.current = saved.token;
      setCurrent(saved.token);
      return saved;
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        // Both halves, and the second is not tidiness: a submission carrying
        // the token of a draft that is gone is refused as
        // `draft_already_submitted` — the participant would lose the answers in
        // front of them over a draft they no longer have.
        token.current = null;
        setCurrent(undefined);
      }
    },
  });

  return { save, token: current };
}

/**
 * The half-filled form behind a draft address —
 * what makes a draft resumable **in a different browser context**: this
 * answers a browser that has never seen the form.
 *
 * The token is the whole capability, exactly as it is for
 * {@link useResponseEdit}: no slug, no form id, no access proof.
 */
export function responseDraftQueryKey(token: string): readonly string[] {
  return ['response-draft', token];
}

export function useResponseDraft(token: string): UseQueryResult<ResponseDraft> {
  return useQuery({
    queryKey: responseDraftQueryKey(token),
    queryFn: async () =>
      parseResponseDraft(
        await requestJson(`/public/drafts/${encodeURIComponent(token)}`, {
          method: 'GET',
        }),
      ),
  });
}

/**
 * Replaces the answers of an existing draft — *Zwischenspeichern* pressed
 * again while resuming one.
 *
 * `PUT`, matching the route: a second `POST` under the form would mint a
 * second draft and a second address for one participant; this one replaces
 * the answers behind the address already on screen.
 */
export function useUpdateDraft(
  token: string,
): UseMutationResult<SavedDraft, Error, Record<string, unknown>> {
  return useMutation({
    retry: false,
    mutationFn: async (answers: Record<string, unknown>) =>
      replaceDraft(token, answers),
  });
}

/**
 * *Entwurf verwerfen* — the way out for somebody who has no account and
 * therefore no trash of their own (DSGVO Art. 17, a review finding).
 *
 * `204`, no body — see `PublicDraftsController.remove` for why nothing is
 * said, and for what a **second** delete meets: not another 204 but the one
 * 404 every token that names nothing gets, because the route resolves the
 * draft before it deletes it. `ResponseDraftView` codes against that 404 and
 * treats it as „verworfen", which is what it is from where the participant
 * stands.
 *
 * `retry: false` for the same reason every other write on this surface has it:
 * a retry the participant did not ask for is not this client's to make — and
 * here it would turn a delete that succeeded into a 404 the view would have to
 * explain away.
 */
export function useDeleteDraft(
  token: string,
): UseMutationResult<void, Error, void> {
  return useMutation({
    retry: false,
    mutationFn: async () =>
      requestVoid(`/public/drafts/${encodeURIComponent(token)}`, {
        method: 'DELETE',
      }),
  });
}
