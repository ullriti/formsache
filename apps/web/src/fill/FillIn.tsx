import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerValue,
  PublicEventSeats,
  PublicForm,
  Question,
  RedirectTarget,
  SavedDraft,
  SubmissionRefusalPosition,
  SubmitResponseResponse,
} from '@formsache/shared';
import {
  ADDRESS_PARTS,
  buildAnswersSchema,
  formatDeadline,
  isBlankAnswer,
  rowsOf,
  visibleQuestionIds,
} from '@formsache/shared';
import type { z } from 'zod';

import { ApiError } from '../api/http';
import type { PublicSubmission, UploadTarget } from '../api/public-form';
import { CopyableAddress } from './CopyableAddress';
import { EditLink } from './EditLink';
import { HoneypotField } from './HoneypotField';
import { FieldInput } from './FieldInput';
import { FormDeadline } from './FormDeadline';
import { PageProgressBar } from './PageProgressBar';
import { RedirectCountdown } from './RedirectCountdown';
import { RequiredHint } from './RequiredHint';
import { TenantHeader } from './TenantHeader';
import { pageLabel } from './page-label';

/**
 * Filling a form in — the pages, the fields, the validation and the receipt.
 *
 * **Extracted from `PublicFormView` with the requirement**, and the extraction
 * is the point rather than tidiness: „die Bearbeiten-Ansicht ist die
 * Ausfüllansicht mit vorbelegten Antworten". A second component would have been
 * a second answer to every question this one already answers — how a page
 * validates, where a server-named field lives, what the confirmation looks like
 * — and the two would have drifted at the first change.
 *
 * What the two callers differ in is passed in and nothing else: the answers it
 * starts from, and what „absenden" does.
 *
 * The client validation stays **UX only**. It runs the same schema the server
 * runs, derived from the same definition, so the two cannot disagree about what
 * is valid — but the server's run is the one that decides (`CONTRIBUTING.md`).
 */

/**
 * What this component needs of a mutation, and no more.
 *
 * A narrow interface rather than TanStack's `UseMutationResult`: the two callers
 * hand over different hooks (`useSubmitResponse`, `useUpdateResponse`), and the
 * only thing this file cares about is that something can be started and
 * reports how it went.
 */
export interface SubmitController {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  /**
   * Takes the whole submission — answers **and** the decoy of the requirement —
   * rather than the answers alone. That is what stops the field from being
   * rendered and then dropped on the way out: a caller that hands over a bare
   * answer map no longer compiles.
   */
  mutate(
    submission: PublicSubmission,
    options: {
      onSuccess: (result: SubmitResponseResponse) => void;
      onError: (error: unknown) => void;
    },
  ): void;
}

/**
 * What *Zwischenspeichern* needs of a mutation.
 *
 * A narrow interface, exactly like {@link SubmitController} and for the same
 * reason: the two callers that will ever pass this hand over different hooks
 * (`useDraftSaving` on the first fill-in, `useUpdateDraft` while resuming), and
 * all this file cares about is that a save can be started and reports how it
 * went.
 *
 * **Which HTTP method a press turns into is deliberately not visible here.**
 * „Der erste Druck legt an, jeder weitere ersetzt" is a rule about one
 * participant's one draft, and it belongs to whoever owns that draft's token —
 * `useDraftSaving`. This component has no token, shows no address of its own
 * making, and would only be a second place for the rule to be half-implemented.
 */
export interface DraftController {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  /**
   * `mutate`, not `save` — the same name {@link SubmitController} uses, and
   * for the same reason: `useDraftSaving`/`useUpdateDraft` already return
   * something with this shape (`UseMutationResult`), so a caller can hand the
   * hook's result over directly instead of building a wrapper object on every
   * render.
   */
  mutate(
    answers: Record<string, unknown>,
    options: {
      onSuccess: (result: SavedDraft) => void;
      onError: (error: unknown) => void;
    },
  ): void;
}

/**
 * What this component reads of a form — **four fields, not the whole public
 * payload** .
 *
 * It used to take a `PublicForm`, and `PublicForm` satisfies this interface
 * structurally, so both public callers are unchanged. The narrowing exists for
 * the third caller: the **Testmodus** (`PreviewView`) renders the editor's
 * *draft* and has no `startToken` and no `version` — those are minted by the
 * server for a real attempt, and a preview that invented one
 * would be inventing a signed capability to make a type check pass. Asking for
 * exactly what is read is the honest way to say „diese Ansicht schickt nichts
 * ab": there is nothing here to submit *with*.
 */
export interface FillInForm {
  readonly title: string;
  readonly definition: PublicForm['definition'];
  readonly display: PublicForm['display'];
  readonly eventSeats: PublicForm['eventSeats'];
  /**
   * The server's verdict — **because of the deadline** (finding 32).
   *
   * `closesAt` expressly travels along, „so a participant sees the deadline they
   * are working against" (`form-availability.ts`), and was redeemed nowhere in
   * the fill-in path: its only consumer was `unavailableNotice`, which
   * returns `null` for an *open* form. Here it becomes the line above
   * the fields ({@link FormDeadline}).
   *
   * **Optional, and that is the third caller**: the Testmodus (`PreviewView`)
   * renders the editor's *draft*, which the server has never judged —
   * there is no verdict there, and inventing one would mean showing the editor a
   * deadline that does not apply to their preview. They see the state of
   * their form as a badge on the settings page anyway
   * (`availabilityBadge`).
   *
   * `PublicForm.availability` is required, so the three
   * public payloads still satisfy this interface unchanged.
   */
  readonly availability?: PublicForm['availability'];
  /**
   * The time limit of this fill-in, in minutes — the second half of finding
   * 32 („Frist **und** Zeitlimit sieht der Teilnehmer nicht").
   *
   * `null` means „kein Zeitlimit"; the server never sends the stored
   * number of minutes of a switched-off limit
   * (`publicFormSchema.timeLimitMin`).
   *
   * **Optional for the same reason as `availability`**: the Testmodus
   * (`PreviewView`) renders the editor's draft, which the server has never
   * judged — there is no fill-in there whose minutes could be
   * running. The three public payloads carry the key as required
   * and still satisfy this interface unchanged.
   */
  readonly timeLimitMin?: PublicForm['timeLimitMin'];
}

export interface FillInProps {
  readonly form: FillInForm;
  readonly submit: SubmitController;
  /**
   * The *Zwischenspeichern* mutation, or absent.
   *
   * **Absent means no control at all**: „es gibt kein
   * Bedienelement" is not a `disabled` button, it is no button rendered at
   * all — the same rule `carriesAccessWord` states for the editor's own
   * password fields. The caller decides by handing this
   * over or not; nothing here reads `form.canSaveDraft` a second time.
   *
   * `ResponseEditView` never passes it — an answer that is already filed has
   * nothing to zwischenspeichern, which `publicFormSchema.canSaveDraft`'s own
   * doc comment states for exactly that payload.
   */
  readonly draft?: DraftController;
  /**
   * The answers the form opens with — empty for a first fill-in, the stored
   * ones for an edit.
   */
  readonly initialAnswers?: Record<string, AnswerValue>;
  /** Label of the primary button on the last page. */
  readonly submitLabel?: string;
  readonly pendingLabel?: string;
  /** Rendered inside the card above the questions — the edit view's note. */
  readonly intro?: ReactElement | null;
  /**
   * Where a Datei-Upload of this form uploads to.
   *
   * The third thing the two callers differ in, beside the answers they start
   * from and what „absenden" does — and for the same reason: the public view
   * uploads against the **slug** (with the access proof, if there was a gate),
   * the correction view against its **edit token**, whose route runs the edit
   * refusal chain instead of the submission's.
   *
   * Optional, because a form without a Datei-Upload question needs no door and
   * `FileField` shows a disabled picker rather than a broken one if it is asked
   * for anyway.
   */
  readonly uploadTarget?: UploadTarget;
  /**
   * Which of the already attached files **no longer exist** (a review finding of
   * the security review).
   *
   * The fourth point in which the callers differ — and the only one
   * that just one of them fills: on the first fill-in and on a correction
   * an attachment comes into being in the same session in which it is sent. A
   * resumed draft is the case in which days can lie in between,
   * while an unclaimed upload is collected after 24 hours
   * (ADR-0014 no. 15). Where the set comes from stands at `FileField.unavailable`.
   */
  readonly unavailableRefs?: ReadonlySet<string>;
}

/** `ADDRESS_PARTS` keyed by its own `key`, for a lookup instead of a `.find`. */
const ADDRESS_PART_LABELS = new Map(
  ADDRESS_PARTS.map((part) => [part.key as string, part.label]),
);

/**
 * The message shown under one field, built from **every** issue the schema
 * raised for that question — not only the first.
 *
 * For a plain question the two are the same thing: `answerSchemaFor` raises
 * at most one issue per question today, and this returns its message
 * unchanged. An Adresse is different — `addressAnswerSchema` raises one
 * issue **per empty Pflicht-Teilfeld** (`path: [questionId, 'street']` and so
 * on), and picking only the first of them, as this used to, showed a single
 * bare „Pflichtfeld." under all four boxes without naming which one is
 * missing. Naming the subfield is what this does: each issue whose path
 * reaches into the answer is prefixed with the label the box itself carries
 * (`ADDRESS_PARTS`, the same list `FieldInput.tsx`'s address branch renders
 * from), so „Straße & Hausnummer: Pflichtfeld." and „Ort: Pflichtfeld." can
 * both be read at once instead of guessed at.
 *
 * A question without such issues (an ordinary `minLength`, a Matrix's
 * question-level „Pflichtfeld.") still gets exactly one message, so nothing
 * about the single-issue case changes — this only adds detail where the
 * schema already had it to give.
 */
function fieldErrorMessage(
  question: Question,
  issues: readonly z.core.$ZodIssue[],
): string | undefined {
  const relevant = issues.filter((issue) => issue.path[0] === question.id);
  if (relevant.length === 0) {
    return undefined;
  }

  const namedParts = relevant.filter(
    (issue) => typeof issue.path[1] === 'string',
  );
  if (namedParts.length === 0) {
    return relevant[0]?.message;
  }

  return namedParts
    .map((issue) => {
      const key = issue.path[1] as string;
      return `${ADDRESS_PART_LABELS.get(key) ?? key}: ${issue.message}`;
    })
    .join(' ');
}

export function FillIn({
  form,
  submit,
  draft,
  initialAnswers,
  submitLabel = 'Absenden',
  pendingLabel = 'Wird gesendet…',
  intro = null,
  uploadTarget,
  unavailableRefs,
}: FillInProps): ReactElement {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(
    // The initial value of `useState` is read once, which is exactly right
    // here: the stored answers are the *starting point* of the edit, and a
    // refetch mid-typing must not throw away what the participant is writing.
    () => ({ ...initialAnswers }),
  );
  /**
   * The decoy of the requirement — component state like any other field, and
   * empty for every participant who does not have a machine filling the page
   * in for them.
   *
   * Controlled rather than read off the DOM at submit time: an uncontrolled
   * input would need a ref, and a ref that is `null` on the render the button
   * is pressed in reads as „nicht ausgefüllt" — the failure mode that silently
   * turns this measure off. It is deliberately **not** reset between pages: a
   * value written on page one has to survive to the submission on page three.
   */
  const [honeypot, setHoneypot] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /**
   * The Veranstaltung the server last refused as full.
   *
   * Kept beside `errors` rather than inside it because it is a different kind
   * of statement: `errors` is „diese Frage ist nicht in Ordnung" and is shown
   * under the field, this is „diese *eine* Kachel ist es" and is shown on the
   * tile. A question with six Veranstaltungen would otherwise get one message
   * under all six of them and no way to tell which is meant.
   *
   * **Both write paths can produce it** — the submission and the correction
   * alike — and this component is the correction view too, so handling it
   * here is what makes the mark appear on both without a second
   * implementation.
   */
  const [refusedEvent, setRefusedEvent] =
    useState<SubmissionRefusalPosition | null>(null);
  const [confirmed, setConfirmed] = useState<{
    title: string;
    message: string;
    redirect: RedirectTarget | null;
    editUrl: string | null;
  } | null>(null);
  /**
   * The address of the last successful *Zwischenspeichern*  — `null` before the first save.
   *
   * Kept beside `confirmed` rather than folded into it: a saved draft is not a
   * receipt that ends the page the way a submission is. The card stays open,
   * the fields stay editable, and pressing the button again (or a settings
   * change landing mid-typing) has to be able to update or replace this
   * without touching anything else on screen.
   */
  const [savedDraft, setSavedDraft] = useState<SavedDraft | null>(null);

  const schema = useMemo(
    () => buildAnswersSchema(form.definition),
    [form.definition],
  );

  const pages = form.definition.pages;
  const page = pages[pageIndex];
  const isLastPage = pageIndex === pages.length - 1;

  /**
   * Which questions are **on screen** for the answers typed so far
   * (the fill-in half of the conditional-visibility review).
   *
   * `visibleQuestionIds` is the one evaluation — see its doc comment in
   * `packages/shared/src/condition.ts` — and both places in this component
   * that used to look at every question of a page (the render below,
   * `validatePage`) go through this set instead. Recomputed on every
   * keystroke because a *Bedingte Anzeige* reads live: hiding the question
   * that just made a field required is exactly the case that review exists
   * for.
   */
  const visibleIds = useMemo(
    () => visibleQuestionIds(form.definition, answers),
    [form.definition, answers],
  );

  /**
   * The current page grouped into rows — the participant's half of the requirement.
   *
   * `rowsOf` comes from `packages/shared`, out of the same module the
   * builder's invariant is written in, and that is the point: a question the
   * editor put next to its neighbour has to arrive next to that neighbour
   * here. While this view ignored `width`, the two views showed different
   * forms.
   *
   * It only groups; it does not repair. A half-width question that ended up
   * alone — one the builder's invariant never saw, because the API accepts any
   * width combination — gets a row to itself, and a row of one is full width
   * by layout (`public-form-view.css`). There is nothing left for a
   * normalisation to fix.
   *
   * Hidden questions are filtered out **before** grouping:
   * a half-width question whose row partner is currently hidden gets a row
   * to itself, exactly like a half-width question the builder never paired —
   * `rowsOf` does not know the difference, and does not need to.
   */
  const rows = useMemo(
    () =>
      rowsOf(
        (page?.questions ?? []).filter((question) =>
          visibleIds.has(question.id),
        ),
      ),
    [page, visibleIds],
  );

  /**
   * The payload's seat states, regrouped as „per question, per Veranstaltung".
   *
   * The wire sends a flat list because it is a wire — a list of `{ questionId,
   * eventKey, … }` records survives being read by anything. What a field needs
   * is a lookup, and building it once here beats a `.find` per tile per render
   * on a form whose Veranstaltungsfrage may carry fifty entries.
   */
  const seatsByQuestion = useMemo(() => {
    const grouped = new Map<string, Map<string, PublicEventSeats>>();
    for (const state of form.eventSeats) {
      const existing = grouped.get(state.questionId);
      if (existing === undefined) {
        grouped.set(state.questionId, new Map([[state.eventKey, state]]));
      } else {
        existing.set(state.eventKey, state);
      }
    }
    return grouped;
  }, [form.eventSeats]);

  const label = pageLabel(pageIndex + 1, pages.length, page?.title);

  /**
   * The page change is announced, **and the focus goes with it** (* remainder of the requirement).
   *
   * `role="progressbar"` reports `aria-valuenow` and `aria-valuetext` correctly —
   * but is **no live region**: the bar says its state only when one
   * moves onto it. Whoever pressed „Weiter" therefore heard nothing, and the focus stayed
   * on the button of the old page: the screen reader stood at the end of a
   * document whose content above had just been exchanged completely.
   *
   * **Both halves together are the decision.** A message without a
   * focus change tells the person operating that something happened and forces them to
   * tab there themselves; a focus change without a message takes away their
   * bearings on where in the stretch they have landed.
   *
   * **The announced text is {@link pageLabel}** — „Seite 2 von 3 ·
   * Verpflegung" —, and the number in it is not ornament: a live region
   * speaks the same text only once, and two pages titled alike
   * one after another would be mute the second time. It is the same sentence the
   * bar carries as `aria-valuetext`, deliberately: two wordings for
   * the same state would be two statements that can drift apart.
   *
   * The announcement happens **independently of `showPageNumbers`**. The setting
   * decides whether the line *stands* on the screen; whoever sees notices
   * the change from the new heading and the new fields anyway. This
   * announcement is the counterpart to exactly that perception, not a second
   * publication of the setting.
   *
   * The comparison against `announcedPage` is what exempts the **first** render
   * pass: on opening the page nothing has changed, and a focus that
   * jumps unbidden onto a heading would displace the entry into the form.
   * It also takes hold for the jump a refused submission
   * triggers (`onSubmit`'s `onError` sets `pageIndex` to the page with the
   * objected field) — there the change is the same and the announcement just as
   * necessary.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [pageAnnouncement, setPageAnnouncement] = useState('');
  const announcedPage = useRef(pageIndex);

  useEffect(() => {
    if (announcedPage.current === pageIndex) {
      return;
    }
    announcedPage.current = pageIndex;
    setPageAnnouncement(label);
    headingRef.current?.focus();
  }, [pageIndex, label]);

  /**
   * Checks the questions of the **current page** before moving on.
   *
   * Per page, not per form: telling someone on page one about a missing answer
   * on page three is an error message they cannot act on without losing their
   * place.
   *
   * **Hidden questions are skipped outright**  — a
   * Pflichtfrage a *Bedingte Anzeige* has taken off screen must block nothing
   * here, exactly as it blocks nothing on the server. Checking `required`
   * without that would make a „Weiter"/„Absenden" the server would happily
   * accept unreachable in this view — the client-only bug the
   * conditional-visibility review's own reproduction warns about, one layer up
   * from the server it is written against.
   */
  function validatePage(): boolean {
    if (page === undefined) {
      return true;
    }
    const found: Record<string, string> = {};

    for (const question of page.questions) {
      if (!visibleIds.has(question.id)) {
        continue;
      }
      const value = answers[question.id];
      if (question.required && isBlankAnswer(value)) {
        // Same wording the server's coarse „ganz leer" check uses
        // (`buildAnswersSchema`'s `isBlankAnswer` branch) — a client message
        // that only *looked* like the
        // server's, „Dieses Feld wird benötigt." beside „Pflichtfeld." for
        // the identical state, used to read as two different rules to
        // someone who saw both in the same session (typed once, submitted,
        // got told again in different words).
        found[question.id] = 'Pflichtfeld.';
        continue;
      }
      if (isBlankAnswer(value)) {
        continue;
      }
      // One question at a time, so the message belongs to the field it is
      // shown under.
      const single = schema.safeParse({ ...answers, [question.id]: value });
      if (!single.success) {
        const message = fieldErrorMessage(question, single.error.issues);
        if (message !== undefined) {
          found[question.id] = message;
        }
      }
    }

    setErrors(found);
    return Object.keys(found).length === 0;
  }

  function onAnswer(question: Question, value: AnswerValue): void {
    setAnswers((current) => ({ ...current, [question.id]: value }));
    // The tile mark goes with the first keystroke in the question it sits in —
    // same rule as the message below, and for the same reason: a mark that
    // stays while somebody is correcting the very number it complains about
    // reads as „immer noch voll", which is a claim this view cannot make.
    setRefusedEvent((current) =>
      current?.questionId === question.id ? null : current,
    );
    // The message goes as soon as the field is touched; leaving it under a
    // field someone is actively fixing reads as "still wrong".
    setErrors((current) =>
      question.id in current
        ? Object.fromEntries(
            Object.entries(current).filter(([key]) => key !== question.id),
          )
        : current,
    );
  }

  /**
   * The first page carrying one of the given questions.
   *
   * Needed because the server checks the **whole** submission while the
   * participant is standing on the last page. A field reference to a question
   * three pages back would otherwise mark an input nobody can see — the
   * message would exist and be useless, which is worse than no message.
   */
  function pageOf(questionIds: readonly string[]): number | undefined {
    const wanted = new Set(questionIds);
    const index = pages.findIndex((candidate) =>
      candidate.questions.some((question) => wanted.has(question.id)),
    );
    return index === -1 ? undefined : index;
  }

  /**
   * The sentence for a refused Veranstaltung — **with its Bezeichnung**.
   *
   * The server deliberately sends one constant message per reason and no name
   * (`SUBMISSION_REFUSAL_MESSAGES`): the caption belongs to the form the
   * participant is looking at, and an editor may rename it between the read and
   * the submission. So the name is resolved here, against the definition this
   * view is already rendering — and the sentence falls back to the plain one if
   * the key names nothing, which is what happens when the organisation removed the
   * Veranstaltung in the same minute.
   *
   * **„Nicht mehr genügend Plätze frei", never „ausgebucht".** The server
   * refuses as soon as `belegt + gewünscht > Grenze`
   * (`PublicFormsService`), so the ordinary case is a hall with two seats left
   * and an organisation asking for five — the tile beside this sentence then says „2
   * frei" in green while the sentence claims the opposite. It also has to name
   * the one thing the participant can do, which „ausgebucht" does not: lower the
   * number.
   */
  function eventFullMessage(position: SubmissionRefusalPosition): string {
    const question = pages
      .flatMap((candidate) => candidate.questions)
      .find((candidate) => candidate.id === position.questionId);
    const label =
      question?.type === 'event'
        ? question.events.find((entry) => entry.key === position.eventKey)
            ?.label
        : undefined;

    return label === undefined
      ? 'Für diese Veranstaltung sind nicht mehr genügend Plätze frei. Bitte die Anzahl verringern; die übrigen Eingaben bleiben erhalten.'
      : `„${label}“: nicht mehr genügend Plätze frei. Bitte die Anzahl verringern; die übrigen Eingaben bleiben erhalten.`;
  }

  function onSubmit(): void {
    if (!validatePage()) {
      return;
    }
    submit.mutate(
      { answers, honeypot },
      {
        onSuccess: (result) => {
          setConfirmed({
            title: result.confirmationTitle,
            message: result.confirmationMessage,
            redirect: result.redirect,
            editUrl: result.editUrl,
          });
        },
        onError: (error) => {
          /*
           * **The one refusal that is about a position rather than the form**
           * : a Veranstaltung filled up between
           * the page load and the button. The rest of the registration is
           * still acceptable, so the participant is taken to the field and the
           * tile is marked — never a page-level „bitte später wiederkommen",
           * which is advice they cannot act on and which is also wrong here.
           */
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            error.refusal?.reason === 'event_full' &&
            error.refusal.position !== undefined
          ) {
            const position = error.refusal.position;
            setRefusedEvent(position);
            setErrors({ [position.questionId]: eventFullMessage(position) });
            const target = pageOf([position.questionId]);
            if (target !== undefined) {
              setPageIndex(target);
            }
            return;
          }

          // The server's field references win over anything the client guessed.
          if (!(error instanceof ApiError) || error.status !== 400) {
            return;
          }
          const issues = error.fieldIssues ?? {};
          setErrors(issues);

          // …and the participant is taken to where those fields are.
          const target = pageOf(Object.keys(issues));
          if (target !== undefined) {
            setPageIndex(target);
          }
        },
      },
    );
  }

  /**
   * *Zwischenspeichern* .
   *
   * **No `validatePage()` call, on purpose.** The whole point of a draft is
   * that it may be half filled — the server drops the Pflicht rule for this
   * route (`safeParseDraftAnswers`) and refuses a half-typed value only if its
   * *type* is wrong, never because it is missing. Blocking the button on the
   * same check the submission uses would refuse the one action that exists to
   * rescue an unfinished page.
   *
   * Nothing here clears `answers` on failure — the second half of that
   * requirement ("ohne den getippten Stand zu verlieren"): the setting can
   * flip to off while somebody is typing (a rule restated for this switch), and
   * the 409 that follows must leave every field exactly as it was.
   */
  function onSaveDraft(): void {
    if (draft === undefined) {
      return;
    }
    draft.mutate(answers, {
      onSuccess: (result) => {
        setSavedDraft(result);
      },
      onError: (error) => {
        /*
         * A save that answers **404 takes the address off the screen** (a
         * review finding).
         *
         * This is not a statement about `POST` or `PUT` — this component knows
         * nothing about either — but about the panel it is showing: 404 on a
         * save means the thing the address leads to is not there any more (a
         * second device discarded it, an access word revoked it, the deadline ran
         * out), and an address that leads nowhere is worse than none, because
         * the participant would keep it as their way back.
         *
         * The typed answers stay exactly where they are, like every other
         * failure of this button, and the message below says what happened. On
         * the first fill-in the next press then mints a new draft
         * (`useDraftSaving`); on a resumed one there is nothing left to write
         * on, and the note says so rather than promising otherwise.
         */
        if (error instanceof ApiError && error.status === 404) {
          setSavedDraft(null);
        }
      },
    });
  }

  /**
   * Whether the failure was already told field by field.
   *
   * The banner below hangs on *this* rather than on the error's type, and the
   * difference is not cosmetic: a 500, a 413 or a 400 whose body named no
   * field used to render **nothing at all**. The button snapped back to
   * „Absenden", the page looked unchanged, and everything the participant had
   * typed was one closed tab away from gone.
   */
  const fieldsWereMarked =
    submit.error instanceof ApiError &&
    submit.error.status === 400 &&
    Object.keys(submit.error.fieldIssues ?? {}).length > 0;

  const wasRateLimited =
    submit.error instanceof ApiError && submit.error.status === 429;

  /**
   * The server refused on its own state.
   *
   * Told apart from the generic failure because the advice is the opposite one:
   * „bitte erneut versuchen" is wrong for a form whose deadline has passed or
   * whose places are gone — pressing the button again cannot help. Reloading
   * can: it shows the notice above, and for a time limit it starts a new
   * attempt.
   *
   * Which of the reasons it was travels in the body
   * (`submissionRefusalSchema`) and is deliberately **not** spelled out for the
   * six that are about the *form*: one sentence that is true for all of them
   * beats six that each need their own paragraph on a page somebody is about to
   * leave. The edit view, where the refusal is the *whole* page rather than a
   * banner under a form, does use the server's own sentence.
   */
  const wasRefused =
    submit.error instanceof ApiError && submit.error.status === 409;

  /**
   * …**and except the one that is about a Veranstaltung** .
   *
   * „Bitte die Seite neu laden" is wrong here in both halves: reloading throws
   * away everything typed so far, and the page it reloads to says nothing about
   * the form being closed — it is not. What the participant can do is change
   * one number, and they are standing on the field that holds it, marked.
   */
  const eventWasFull =
    submit.error instanceof ApiError &&
    submit.error.status === 409 &&
    submit.error.refusal?.reason === 'event_full';

  /**
   * …**except the two that are about the attachments** (ADR-0014
   * no. 13), which are the ones where the shared sentence is actively wrong.
   *
   * „Bitte die Seite neu laden; dort steht, woran es liegt" is the right advice
   * for a closed form and the worst possible one here: the page says nothing
   * about it, and a reload throws away every answer typed so far **and** the
   * attachments that were fine. What a participant can actually do is pick the
   * file again (`attachment_unavailable` — it expired, or somebody else's
   * submission claimed it) or remove one (`attachment_limit` — ten files or
   * 25 MiB per answer), and both keep them on the page they are standing on.
   *
   * Read off the parsed refusal rather than off the status, so a reason added
   * later falls back to the general sentence instead of being announced as one
   * of these two.
   */
  const attachmentRefusal =
    submit.error instanceof ApiError &&
    submit.error.status === 409 &&
    (submit.error.refusal?.reason === 'attachment_unavailable' ||
      submit.error.refusal?.reason === 'attachment_limit')
      ? submit.error.refusal.reason
      : null;

  /**
   * Why the last *Zwischenspeichern* failed — **the server's own sentence**,
   * not one composed here (the requirement covers both: `saving_disabled`
   * while typing, review's `draft_limit` on the first save; the task hands
   * both the same shape the edit view already reads its refusal from, see
   * `ResponseEditView.NotEditable`).
   *
   * A generic fallback for anything that is not a parsed refusal — a network
   * failure, a 429, a 500 — because those carry no sentence written for this
   * screen and inventing one here would be a second, drifting copy of the
   * ones the submission's own banner already keeps.
   */
  const draftRefusalMessage =
    draft?.isError !== true
      ? null
      : draft.error instanceof ApiError &&
          draft.error.status === 409 &&
          draft.error.refusal !== undefined
        ? draft.error.refusal.message
        : draft.error instanceof ApiError && draft.error.status === 404
          ? /*
             * The draft this page was writing on is gone — see `onSaveDraft`
             * for the three ways that happens and for why the address panel
             * disappears with it.
             *
             * A sentence of its own rather than the generic one below, because
             * „bitte erneut versuchen" would be describing the wrong thing:
             * nothing failed to reach the server. It deliberately promises
             * **nothing** about what a further press does — the same component
             * renders the first fill-in, where a further press starts a new
             * draft, and the resumed one, where it cannot.
             */
            'Dieser zwischengespeicherte Stand ist nicht mehr vorhanden — er wurde verworfen, zurückgezogen oder ist abgelaufen. Die Eingaben auf dieser Seite bleiben erhalten.'
          : 'Der Entwurf konnte nicht gespeichert werden. Bitte erneut versuchen — die Eingaben bleiben dabei erhalten.';

  if (confirmed !== null) {
    return (
      <section className="public__card public__card--done">
        <p className="public__check" aria-hidden="true">
          ✓
        </p>
        <h1 className="public__title">{confirmed.title}</h1>
        <p className="public__message">{confirmed.message}</p>
        {/*
          The requirement — the address the participant can come back to. It is
          **the server's**, absolute and built from `PUBLIC_BASE_URL`: the same
          string goes into the confirmation mail, and a link assembled here
          from `window.location.origin` would be a second answer to where this
          installation lives.
        */}
        {confirmed.editUrl === null ? null : (
          <EditLink url={confirmed.editUrl} />
        )}
        {/*
          The requirement. The texts above and the countdown below all come from
          the answer to the submission, never from the form document: the
          settings are read with the server's clock at the moment the answer
          was stored, and nothing about them is guessed in the browser.
        */}
        {confirmed.redirect === null ? null : (
          <RedirectCountdown redirect={confirmed.redirect} />
        )}
      </section>
    );
  }

  return (
    <section className="public__card">
      <h1 className="public__title">{form.title}</h1>

      {/*
        **The deadline and the time limit that are being worked against here**
        (finding 32).

        Directly under the title and above everything else: further down it would stand
        behind thirty fields and would be exactly what the finding describes —
        present and unread. It is nevertheless *one* quiet line and no
        box with a countdown: the purpose of this page is the filling in, and what
        hurries somebody along does not help with that.

        Before `intro`, because `intro` is the respective caller's piece of information
        („dies ist eine bereits abgesendete Antwort", „dies ist ein
        zwischengespeicherter Entwurf") — the deadline applies to all three alike
        and therefore belongs above the distinction, not below it.

        Nothing as long as neither a time window nor a time limit is set — the
        great majority of forms (`FormDeadline` then renders `null`).
      */}
      <FormDeadline
        closesAt={form.availability?.closesAt ?? null}
        timeLimitMin={form.timeLimitMin ?? null}
      />

      {intro}

      {/*
        The requirement — and the two flags are asked **separately**.

        A single-page form still has no "progress" to report: page 1 of 1 is
        always full and „Seite 1 von 1" tells nobody anything, so the block
        stays hidden there regardless of what the settings say. That guard is
        about the *form*; the flags are about the editor's choice, and the two
        are independent reasons to hide the same thing.

        The wrapper stays even when only one half shows: it carries the tight
        `--space-1` gap between the count and the bar, which the card's own
        `--space-4` would not give them.
      */}
      {pages.length > 1 &&
      (form.display.showPageNumbers || form.display.showProgress) ? (
        <div className="public__page-progress">
          {form.display.showPageNumbers ? (
            // Inline rather than a component of its own: a 17-line wrapper
            // around one `<p>`, used here and nowhere else, with the
            // case distinction it was supposed to own already standing
            // above it. `PageProgressBar` next door stays a component —
            // it owns `role="progressbar"` and its `aria-valuetext`.
            <p className="public__page-info">{label}</p>
          ) : null}
          {form.display.showProgress ? (
            <PageProgressBar
              currentPage={pageIndex + 1}
              totalPages={pages.length}
              label={label}
            />
          ) : null}
        </div>
      ) : null}

      {/*
        The requirement — the page's own heading, shown **independently** of
        `showPageNumbers`. Before this, `page.title` only ever reached the
        screen inside `label` above, which is entirely conditional on that
        setting: a form with page numbers switched off named none of its pages
        anywhere. The handoff's own participant view agrees — its `<h2>` above
        the fields is unconditional, next to a progress row that is not
        (`participantView()`).

        `page` can be `undefined` only while `pages` is empty, which
        `formDefinitionSchema` (`min(1)`) never allows for a form this view
        was given — guarded anyway because `page?.title` a few lines up
        already treats it as possible.
      */}
      {page === undefined ? null : (
        <>
          {/*
            `tabIndex={-1}`, so that the focus can come here on a page change
             — the same means with which `useFocusTrap`'s
            `fallbackRef` heads for a heading when a closed
            overlay can put the focus nowhere else
            (`ResponsesView`'s `<h1>`).

            **`-1`, not `0`**: the heading gets the focus only
            programmatically. It does not belong in the tab order — there it would
            be a station nobody has headed for, on every page of every
            form.
          */}
          <h2 className="public__page-title" ref={headingRef} tabIndex={-1}>
            {page.title}
          </h2>
          {/* `??` catches both spellings of "none": `null` (an explicitly
              cleared description) and `undefined` (a page saved before this
              field existed, which never had the key at all — `pageSchema.description` is
              `.optional()` for exactly that reason). */}
          {(page.description ?? '') === '' ? null : (
            <p className="public__page-description">{page.description}</p>
          )}
        </>
      )}

      {form.display.showRequiredHint ? <RequiredHint /> : null}

      {rows.map((row, index) => (
        /*
          One element per **row**, not per question: two
          half-width questions share a row, everything else has one to
          itself. `rowsOf` groups without reordering, so the fields stay in
          document order and the tab order follows what the eye reads —
          nothing here moves a field visually past another.
        */
        <div
          className="public__row"
          data-testid="public-row"
          key={row[0]?.id ?? String(index)}
        >
          {row.map((question) => {
            const seats = seatsByQuestion.get(question.id);
            const refusedKey =
              refusedEvent?.questionId === question.id
                ? refusedEvent.eventKey
                : undefined;

            return (
              <FieldInput
                key={question.id}
                question={question}
                value={answers[question.id]}
                error={errors[question.id]}
                {...(uploadTarget === undefined ? {} : { uploadTarget })}
                {...(unavailableRefs === undefined ? {} : { unavailableRefs })}
                {...(seats === undefined ? {} : { eventSeats: seats })}
                {...(refusedKey === undefined
                  ? {}
                  : { refusedEventKey: refusedKey })}
                onChange={(value) => {
                  onAnswer(question, value);
                }}
              />
            );
          })}
        </div>
      ))}

      {/*
        The requirement — the decoy, in among the questions rather than at the
        top or the bottom of the document, because a filler that gives up after
        the first field or stops at the last one is exactly the filler this is
        aimed at. It is invisible, unfocusable and unannounced; what it costs
        when it comes back filled is a **mail**, and never the registration
        (`apps/api/src/public/honeypot.ts`).

        It sits outside the paged section on purpose: the participant's value
        must survive stepping from page one to page three, and a field that only
        exists while its page is shown would be an empty string by the time the
        button is pressed.
      */}
      <HoneypotField value={honeypot} onChange={setHoneypot} />

      {wasRateLimited ? (
        <p className="public__error" role="alert">
          Zu viele Übermittlungen von dieser Verbindung. Bitte in einer Minute
          erneut versuchen.
        </p>
      ) : attachmentRefusal === 'attachment_unavailable' ? (
        <p className="public__error" role="alert">
          Ein Anhang steht nicht mehr zur Verfügung — hochgeladene Dateien
          verfallen nach einem Tag. Bitte die Datei entfernen und erneut
          hochladen; die übrigen Eingaben bleiben erhalten.
        </p>
      ) : attachmentRefusal === 'attachment_limit' ? (
        <p className="public__error" role="alert">
          Diese Antwort trägt zu viele oder zu große Anhänge. Bitte eine Datei
          entfernen und es erneut versuchen; die übrigen Eingaben bleiben
          erhalten.
        </p>
      ) : eventWasFull ? (
        <p className="public__error" role="alert">
          {/*
            **„Antwort", not „Anmeldung"** (finding 32, second part) — and
            here that was the closest of the five decisions: it really is
            about event places, so „Anmeldung" would be defensible in the domain.
            Two things tip the balance all the same. The subject of the sentence is
            the **submission**, not the form, and an event question
            sits just as well in a needs enquiry or a survey as in
            a registration. And the twin sentence a line further down says
            „Diese Antwort wurde nicht angenommen" for the same 409 — two
            words for the same thing on the same screen.
          */}
          Diese Antwort wurde nicht angenommen — für eine Veranstaltung sind
          nicht mehr genügend Plätze frei. Die betroffene Angabe ist oben
          markiert; bitte die Anzahl verringern. Die übrigen Eingaben bleiben
          erhalten.
        </p>
      ) : wasRefused ? (
        <p className="public__error" role="alert">
          Diese Antwort wurde nicht angenommen — das Formular nimmt derzeit
          keine Antworten entgegen. Bitte die Seite neu laden; dort steht, woran
          es liegt.
        </p>
      ) : submit.isError && !fieldsWereMarked ? (
        <p className="public__error" role="alert">
          Die Antwort konnte nicht übermittelt werden. Bitte erneut versuchen —
          die Eingaben bleiben dabei erhalten.
        </p>
      ) : null}

      {/*
        The requirement — a banner of its own rather than folded into the chain
        above: it reports the *draft* mutation, not `submit`, and the two can
        fail independently of each other on the same page.
      */}
      {draftRefusalMessage === null ? null : (
        <p className="public__error" role="alert">
          {draftRefusalMessage}
        </p>
      )}

      {/*
        The address of the last successful *Zwischenspeichern* .
        `draftUrl === null` is the misconfigured-installation state
        `savedDraftSchema`'s own doc comment names — the draft is stored all
        the same, so the save did not fail, but there is no address to hand
        over. Named rather than silently dropped, unlike `editUrl === null` on
        the confirmation below, which is an ordinary "off" state.
      */}
      {savedDraft === null ? null : savedDraft.draftUrl === null ? (
        <p className="public__error" role="alert">
          Der Entwurf wurde gespeichert, aber es ließ sich keine Adresse zum
          Fortsetzen erstellen. Bitte die Formularverantwortlichen ansprechen.
        </p>
      ) : (
        <CopyableAddress
          url={savedDraft.draftUrl}
          testId="public-draft-link"
          hint="Dieser Entwurf lässt sich über die folgende Adresse fortsetzen — auch auf einem anderen Gerät. Bitte aufbewahren; sie ist der einzige Weg zurück zu diesem Stand."
        >
          {/*
            Konzept no. 58 / no. 63 — the two things a draft's own note names that
            a submitted answer's does not: **when** it dies, and that it has no
            second factor at all. `formatDeadline` names the zone for the same
            reason `unavailableNotice` does — a time nobody can place is
            contentious between two Organisationen.
          */}
          <p className="public__edit-note">
            Gültig bis {formatDeadline(savedDraft.expiresAt)}. Jede Person, die
            diese Adresse kennt, kann den Entwurf öffnen und weiter ausfüllen —
            ein Konto oder ein weiterer Nachweis ist dafür nicht nötig.
          </p>
        </CopyableAddress>
      )}

      <div className="public__actions">
        {draft === undefined ? null : (
          <button
            type="button"
            className="public__secondary"
            disabled={draft.isPending}
            onClick={onSaveDraft}
          >
            {draft.isPending ? 'Wird gespeichert…' : 'Zwischenspeichern'}
          </button>
        )}

        {pageIndex > 0 ? (
          <button
            type="button"
            className="public__secondary"
            onClick={() => {
              // No validation on the way back: someone returning to correct
              // an earlier answer must not be stopped by the page they are
              // leaving.
              setPageIndex((index) => index - 1);
            }}
          >
            Zurück
          </button>
        ) : null}

        {isLastPage ? (
          <button
            type="button"
            className="public__primary"
            disabled={submit.isPending}
            onClick={onSubmit}
          >
            {submit.isPending ? pendingLabel : submitLabel}
          </button>
        ) : (
          <button
            type="button"
            className="public__primary"
            onClick={() => {
              if (validatePage()) {
                setPageIndex((index) => index + 1);
              }
            }}
          >
            Weiter
          </button>
        )}
      </div>

      {/*
        The live region of the page change — **rendered unconditionally
        and empty until there is something to say**.

        The same rule as for the builder's publication state and for
        the table row (`fill/TableField.tsx`), and for the same reason: a
        `role="status"` region that comes into being only together with its text is
        new in the accessibility tree when the text arrives — and is then often not
        announced at all.

        **As the last element of the card**, like this application's three other
        live regions (`QuestionCard`, `TableField`, `QuestionProperties`) —
        and here additionally, because the announced sentence is **verbatim** the visible
        page line (`pageLabel`, deliberately the same wording). Rendered directly
        beside it, the same sentence would stand twice in a row in the
        reading flow; where the announcement stands is immaterial for the speaking
        anyway.
      */}
      <span className="visually-hidden" role="status">
        {pageAnnouncement}
      </span>
    </section>
  );
}

/** Re-exported so the two public views need one import for the frame. */
export { TenantHeader };
