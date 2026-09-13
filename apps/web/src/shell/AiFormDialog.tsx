import type { ReactElement } from 'react';
import { useId, useRef, useState } from 'react';
import type { FormDefinition } from '@formsache/shared';
import {
  AI_PROMPT_MAX,
  AI_PROMPT_RETENTION_DAYS,
  aiQuotaRemaining,
  formTitleSchema,
} from '@formsache/shared';

import { useAdoptAiForm, useAiQuota, useGenerateAiForm } from '../api/ai-forms';
import { ApiError } from '../api/http';
import { QUESTION_TYPE_LABELS } from '../builder/question-defaults';
import { builderPath } from '../router/routes';
import { navigate } from '../router/use-route';
import { actionErrorMessage } from '../views/api-messages';
import { aiFailureMessage } from './ai-failure-message';
import { useFocusTrap } from './use-focus-trap';

import './ai-form-dialog.css';

/**
 * „✦ KI-Formular" — the dialogue of the handoff, **with one step the prototype
 * does not have** .
 *
 * The prototype runs free text → working phase → *finished form in the
 * builder*. We stop one step earlier and show a **Vorschau** with *Übernehmen*
 * and *Verwerfen*, because the prototype's last step writes over whatever
 * draft was open, and an overwritten draft is data loss **without a
 * trash** (ADR-0015 no. 11). Everything else — the free text, the
 * three examples, the working phase, the dark head with the ✦ — follows the
 * prototype.
 *
 * ## What each phase may do
 *
 * | Phase | Requests it can make | What closing it costs |
 * |---|---|---|
 * | `idle` | none | the typed text |
 * | `busy` | the generate call, cancellable | the call (already counted) |
 * | `preview` | none until *Übernehmen* | the suggestion — **nothing stored** |
 * | `failed` | none | nothing |
 *
 * The third row is the requirement: *Verwerfen* is not an undo, it is a **return
 * without a write**. Nothing has been created at any point before *Übernehmen*
 * — not by the route (ADR-0015 no. 11), not by this component, which has no
 * form id to write into and cannot acquire one (`useAdoptAiForm`).
 *
 * ## Two labels that already exist elsewhere
 *
 * „Übernehmen" is also the name of the builder's **Massenimport** button
 * (`QuestionProperties.tsx`), and „Verwerfen" is a substring of the public
 * „Entwurf verwerfen" (`ResponseDraftView.tsx`). Neither collides at runtime —
 * the surfaces are never on screen together — but a locator that is not scoped
 * to this dialogue will find the wrong one sooner or later, and Playwright
 * matches names as a *substring* („Logo übernehmen" answers to
 * „übernehmen"). Whoever writes a test for this dialogue scopes it to the
 * `role="dialog"` below; the names themselves stay, because they are the words
 * the two decisions with.
 *
 * ## Nothing from the model is markup
 *
 * Titles, page names, question captions and the refusal detail all arrive as
 * React text children. There is no
 * `dangerouslySetInnerHTML` in this file and there must not be one: a question
 * caption reading `<script>…` is a caption, and it has to look like one.
 */

/**
 * The three examples offered under „Beispiele" — **in nobody's particular
 * vocabulary**.
 *
 * A self-hosted platform installs for every kind of organisation, so the
 * first thing a new editor reads here must not read like three forms
 * from somebody else's Verein. What the three still have to do is show the
 * **range** — Teilnahmelimits, eine Auswahl, mehrere Seiten, eine Bewertung —
 * because that is what tells a reader what may be asked for at all.
 */
const EXAMPLES: readonly string[] = [
  'Anmeldung zu einer Veranstaltung mit mehreren Programmpunkten, jeweils mit Teilnahmelimit, und einer Frage nach der Verpflegung.',
  'Anmeldung zu einer Fortbildung: Auswahl eines von mehreren Seminaren, dazu Kontaktdaten und die Rechnungsanschrift auf einer zweiten Seite.',
  'Rückmeldebogen nach einer Veranstaltung: Bewertung von Organisation und Programm, dazu ein Feld für Anmerkungen.',
];

/**
 * Shortened caption of a chip — the full text goes into the textarea.
 *
 * **A shortening of the sentence above it and nothing else**, entry for entry
 * with {@link EXAMPLES}. A caption that names something its own example does
 * not is the kind of text nobody re-reads.
 */
const EXAMPLE_LABELS: readonly string[] = [
  'Veranstaltung mit Teilnahmelimits',
  'Seminaranmeldung mit Kurswahl',
  'Rückmeldebogen mit Bewertung',
];

/**
 * What the dialogue is doing right now.
 *
 * A phase union rather than three booleans: „busy und preview gleichzeitig" is
 * a state this application has no rendering for, and a union is the cheapest
 * way of not being able to reach it.
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'preview';
      /** The model's suggestion, or `null` when it named none. */
      readonly suggestedTitle: string | null;
      readonly definition: FormDefinition;
    }
  | {
      readonly kind: 'failed';
      readonly message: string;
      /** Our own sentence about our own schema, or `null`. Never provider prose. */
      readonly detail: string | null;
    };

/** „3 Seiten", „1 Seite" — the German plural, spelled once. */
function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function questionCount(definition: FormDefinition): number {
  return definition.pages.reduce((sum, page) => sum + page.questions.length, 0);
}

/**
 * The title the *Übernehmen* starts from.
 *
 * The model's suggestion when it made one, the first page's title otherwise —
 * and **editable either way**, the same rule „aus einer Vorlage anlegen"
 * follows: the person creating the form is the one naming it
 * (`createFormRequestSchema`). A form silently called whatever a model wrote is
 * the small sibling of the overwrite this whole dialogue exists to prevent.
 */
function initialTitle(
  suggested: string | null,
  definition: FormDefinition,
): string {
  return suggested ?? definition.pages[0]?.title ?? 'Neues Formular';
}

export interface AiFormDialogProps {
  readonly onClose: () => void;
}

export function AiFormDialog({ onClose }: AiFormDialogProps): ReactElement {
  const titleId = useId();
  const promptId = useId();
  const formTitleId = useId();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [prompt, setPrompt] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [adoptError, setAdoptError] = useState<string | null>(null);

  /**
   * The controller of the run in flight.
   *
   * A ref rather than state: it is written and read by handlers, never
   * rendered, and a re-render in between would be a chance for the abort to
   * reach a controller that is no longer the one being awaited.
   */
  const run = useRef<AbortController | null>(null);

  const quota = useAiQuota(true);
  const generate = useGenerateAiForm();
  const adopt = useAdoptAiForm();

  const trimmed = prompt.trim();
  const canSend = trimmed !== '' && trimmed.length <= AI_PROMPT_MAX;
  /**
   * Whether the name would survive `POST /forms`.
   *
   * Asked of the **shared rule** rather than of a length written down here: the
   * bound belongs to `formTitleSchema` and is the same one the route applies.
   * A second `max(200)` in this file would be the drift the schema was named
   * against — and it would show up as a 400 after the model call was already
   * paid for.
   */
  const canAdopt = formTitleSchema.safeParse(formTitle).success;

  const cancelRun = (): void => {
    run.current?.abort();
    run.current = null;
  };

  /**
   * What Escape means — different per phase, and never „silently throw the
   * suggestion away without saying so".
   *
   * In `preview` it does what *Verwerfen* does, deliberately: Escape is the
   * one gesture every user expects to close a dialogue, and what it discards
   * here is a suggestion, not stored work. The **scrim** is a different matter
   * — see below.
   */
  const onEscape = (): void => {
    if (phase.kind === 'busy') {
      cancelRun();
    }
    onClose();
  };

  const { panelRef, onKeyDown } = useFocusTrap({ onClose: onEscape });

  const onGenerate = (): void => {
    if (!canSend) {
      return;
    }
    const controller = new AbortController();
    run.current = controller;
    setPhase({ kind: 'busy' });
    setAdoptError(null);

    generate.mutate(
      { prompt: trimmed, signal: controller.signal },
      {
        onSuccess: (response) => {
          // The run that was cancelled is not the run that may paint. Without
          // this the aborted call's late answer would open a preview over a
          // dialogue the editor already left — the „nichts Halbes" of
          // the evidence seen from the screen rather than from the database.
          if (controller.signal.aborted) {
            return;
          }
          run.current = null;
          if (!response.ok) {
            setPhase({
              kind: 'failed',
              message: aiFailureMessage(response.failure),
              detail: response.detail,
            });
            return;
          }
          setFormTitle(initialTitle(response.title, response.definition));
          setPhase({
            kind: 'preview',
            suggestedTitle: response.title,
            definition: response.definition,
          });
        },
        onError: (error) => {
          if (controller.signal.aborted) {
            return;
          }
          run.current = null;
          setPhase({
            kind: 'failed',
            message: requestErrorMessage(error),
            detail: null,
          });
        },
      },
    );
  };

  const onAdopt = (): void => {
    if (phase.kind !== 'preview') {
      return;
    }
    const parsedTitle = formTitleSchema.safeParse(formTitle);
    if (!parsedTitle.success) {
      return;
    }
    const title = parsedTitle.data;
    setAdoptError(null);
    adopt.mutate(
      { title, definition: phase.definition },
      {
        onSuccess: (form) => {
          onClose();
          navigate(builderPath(form.id));
        },
        onError: (error) => {
          setAdoptError(
            actionErrorMessage(error, {
              forbidden: 'Diese Rolle darf keine Formulare anlegen.',
              failed:
                'Das Formular konnte nicht angelegt werden. Der Vorschlag steht noch — bitte erneut versuchen.',
            }),
          );
        },
      },
    );
  };

  return (
    <div className="ai-dialog">
      {/*
        The scrim closes the dialogue **only while nothing is at stake**. In
        `preview` a stray click outside would throw away a suggestion the organisation
        paid a counted call for, and in `busy` it would abandon a call already
        running; both then look like „das Fenster ist einfach weg". Escape and
        the two named buttons stay available in every phase, so nobody is
        trapped — what is removed is the *accidental* way out, not the way out.
      */}
      <div
        className="ai-dialog__scrim"
        aria-hidden="true"
        onClick={phase.kind === 'idle' ? onClose : undefined}
      />
      <div
        className="ai-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="ai-dialog__head">
          <span className="ai-dialog__mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <h2 className="ai-dialog__title" id={titleId}>
              Formular mit KI erstellen
            </h2>
            <p className="ai-dialog__subtitle">
              {phase.kind === 'preview'
                ? 'Vorschau – noch ist nichts angelegt'
                : 'Beschreibe dein Formular in eigenen Worten'}
            </p>
          </div>
        </div>

        <div className="ai-dialog__body">
          {phase.kind === 'idle' ? (
            <>
              <label className="ai-dialog__label" htmlFor={promptId}>
                Beschreibung des Formulars
              </label>
              <textarea
                id={promptId}
                className="ai-dialog__prompt"
                value={prompt}
                maxLength={AI_PROMPT_MAX}
                rows={4}
                onChange={(event) => {
                  setPrompt(event.target.value);
                }}
              />
              <p className="ai-dialog__counter">
                {`${String(trimmed.length)} von ${String(AI_PROMPT_MAX)} Zeichen`}
              </p>

              <p className="ai-dialog__examples-label">Beispiele:</p>
              <div className="ai-dialog__examples">
                {EXAMPLES.map((example, index) => (
                  <button
                    key={example}
                    type="button"
                    className="ai-dialog__example"
                    onClick={() => {
                      setPrompt(example);
                    }}
                  >
                    {EXAMPLE_LABELS[index] ?? example}
                  </button>
                ))}
              </div>

              {/*
                Said before the text is sent, not after — this is the one place
                an editor can put personal data into a foreign service by
                accident (ADR-0015 no. 8). The retention comes from the shared
                constant, so the sentence cannot outlive the rule.
              */}
              <p className="ai-dialog__note">
                {`Der eingegebene Text wird an den KI-Dienst übermittelt und ${String(
                  AI_PROMPT_RETENTION_DAYS,
                )} Tage gespeichert. Bitte keine personenbezogenen Daten eingeben.`}
              </p>
            </>
          ) : null}

          {phase.kind === 'busy' ? (
            <div className="ai-dialog__working" role="status">
              <span className="ai-dialog__spinner" aria-hidden="true" />
              <div>
                <p className="ai-dialog__working-title">
                  KI erstellt dein Formular…
                </p>
                <p className="ai-dialog__note">
                  Das dauert einige Sekunden. Abbrechen legt nichts an.
                </p>
              </div>
            </div>
          ) : null}

          {phase.kind === 'preview' ? (
            <>
              {/*
                **Der Wechsel „arbeitet" → „fertig"** .

                Until this line the dialogue announced its start and nothing
                else: the `busy` block above is a `role="status"`, so „KI
                erstellt dein Formular…" is spoken — and then the block is
                removed and a *silent* preview takes its place. What a
                screen-reader user hears is a beginning without an end, which is
                indistinguishable from a call that never came back. Measured in
                `e2e/announcements.spec.ts`, which drives the dialogue through
                a held response so both phases are on screen for real.

                `role="status"` on the sentence that already carried the size of
                the suggestion, rather than a second, hidden region: the words
                are the same for eye and ear, and „Vorschlag steht bereit" is
                the outcome, not decoration. It appears *with* its text — the
                pattern the dashboard's Trefferzähler uses — which is safe here
                precisely because the phase before it was itself a live region:
                the announcement is a **change** inside a dialogue the user is
                already listening to.
              */}
              <p className="ai-dialog__lead" role="status">
                {`Vorschlag steht bereit: ${count(
                  phase.definition.pages.length,
                  'Seite',
                  'Seiten',
                )} · ${count(
                  questionCount(phase.definition),
                  'Frage',
                  'Fragen',
                )}. Mit „Übernehmen" entsteht daraus ein neues Formular; ein offenes Formular bleibt unberührt.`}
              </p>

              <label className="ai-dialog__label" htmlFor={formTitleId}>
                Name des neuen Formulars
              </label>
              <input
                id={formTitleId}
                className="ai-dialog__title-field"
                value={formTitle}
                onChange={(event) => {
                  setFormTitle(event.target.value);
                }}
              />

              <ol className="ai-dialog__pages">
                {phase.definition.pages.map((page, index) => (
                  <li key={page.id} className="ai-dialog__page">
                    <p className="ai-dialog__page-title">
                      {`Seite ${String(index + 1)}: ${page.title}`}
                    </p>
                    {page.questions.length === 0 ? (
                      <p className="ai-dialog__note">Keine Fragen.</p>
                    ) : (
                      <ul className="ai-dialog__questions">
                        {page.questions.map((question) => (
                          <li key={question.id}>
                            {/*
                              Text children, both of them. `question.label`
                              comes from the model and is rendered exactly as
                              what it is — a caption.
                            */}
                            <span className="ai-dialog__question-label">
                              {question.label}
                            </span>
                            <span className="ai-dialog__question-type">
                              {QUESTION_TYPE_LABELS[question.type]}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>

              {adoptError === null ? null : (
                <p className="ai-dialog__problem" role="alert">
                  {adoptError}
                </p>
              )}
            </>
          ) : null}

          {phase.kind === 'failed' ? (
            <div className="ai-dialog__problem" role="alert">
              <p className="ai-dialog__failure">{phase.message}</p>
              {phase.detail === null ? null : (
                <p className="ai-dialog__failure-detail">{phase.detail}</p>
              )}
            </div>
          ) : null}

          {/*
            Verbrauch und Rest — **Auskunft, kein Stellrad** . It is
            shown in every phase because the number is what makes „Kontingent
            erschöpft" readable as a fact rather than as a guess, and it has no
            input beside it: the Kontingent is the Superadmin's.
          */}
          {quota.data === undefined ? null : (
            <p className="ai-dialog__quota">
              {`KI-Kontingent dieser Organisation: ${String(
                quota.data.used,
              )} von ${String(quota.data.limit)} Aufrufen verbraucht, ${String(
                aiQuotaRemaining(quota.data),
              )} übrig.`}
            </p>
          )}
        </div>

        <div className="ai-dialog__actions">
          {phase.kind === 'idle' ? (
            <>
              <button
                type="button"
                className="ai-dialog__cancel"
                onClick={onClose}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="ai-dialog__confirm"
                disabled={!canSend}
                onClick={onGenerate}
              >
                <span aria-hidden="true">✦ </span>Formular generieren
              </button>
            </>
          ) : null}

          {phase.kind === 'busy' ? (
            <button
              type="button"
              className="ai-dialog__cancel"
              onClick={() => {
                cancelRun();
                setPhase({ kind: 'idle' });
              }}
            >
              Abbrechen
            </button>
          ) : null}

          {phase.kind === 'preview' ? (
            <>
              {/*
                *Verwerfen* makes **no request**. It is the whole point of the
                requirement that there is nothing here to undo: the route stored
                nothing, and this component created nothing.
              */}
              <button
                type="button"
                className="ai-dialog__cancel"
                disabled={adopt.isPending}
                onClick={onClose}
              >
                Verwerfen
              </button>
              <button
                type="button"
                className="ai-dialog__confirm"
                disabled={adopt.isPending || !canAdopt}
                onClick={onAdopt}
              >
                {adopt.isPending ? 'Wird angelegt…' : 'Übernehmen'}
              </button>
            </>
          ) : null}

          {phase.kind === 'failed' ? (
            <>
              <button
                type="button"
                className="ai-dialog__cancel"
                onClick={onClose}
              >
                Schließen
              </button>
              {/*
                Back to the text, not straight into a second call: a repeat is
                a second counted call, and it is the editor who decides to
                spend it — with the same text or a changed one.
              */}
              <button
                type="button"
                className="ai-dialog__confirm"
                onClick={() => {
                  setPhase({ kind: 'idle' });
                }}
              >
                Erneut versuchen
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The sentence for a request that never became an answer.
 *
 * **429 gets its own**, because it is the one status this route can send for
 * two different reasons — the organisation's Kontingent (ADR-0015 no. 7) and the
 * route's own rate limit (no. 12) — and neither wording alone would be true.
 * The number beside it in the dialogue is what tells the two apart, which is
 * the second reason the quota is on screen at all.
 *
 * ⚠️ **The server's own sentence is deliberately *not* passed through here**,
 * against the rule this application otherwise follows on 409 and 422. The
 * exhausted Kontingent does send one (`AI_QUOTA_EXHAUSTED_MESSAGE` in
 * `ai-forms.controller.ts`) — but the rate limit sends one too, and it is
 * Nest's: „ThrottlerException: Too Many Requests". `ApiError.detail` cannot
 * tell them apart, so passing it through would put an English exception name
 * in front of an editor roughly one 429 in two. Comparing against the
 * server's constant would be the fix, and it needs that constant to move to
 * `packages/shared` first — writing it out a second time here is the drift
 * that rule exists against.
 *
 * **404 means „gibt es hier nicht"**, not „ist kaputt" (no. 9): an installation
 * without a key answers 404, and the menu entry is gone in the same breath —
 * so this sentence is what somebody sees who kept a tab open across the switch
 * being turned off.
 */
const QUOTA_OR_RATE_LIMIT =
  'Es sind gerade keine weiteren KI-Anfragen möglich: entweder ist das Kontingent dieser Organisation aufgebraucht, oder es kamen zu viele Anfragen kurz hintereinander.';

function requestErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return QUOTA_OR_RATE_LIMIT;
  }
  return actionErrorMessage(error, {
    forbidden: 'Diese Rolle darf keine Formulare mit KI erstellen.',
    missing:
      'Die KI-Formularerstellung ist in dieser Installation nicht eingerichtet.',
    failed: 'Die Anfrage an den KI-Dienst ist fehlgeschlagen.',
  });
}
