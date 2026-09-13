import type { ReactElement } from 'react';
import { useRef, useState } from 'react';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_HINT,
  MAX_ATTACHMENT_BYTES,
  attachmentsOf,
  type AnswerValue,
  type FileAttachment,
  type Question,
} from '@formsache/shared';

import { ApiError, NetworkError } from '../api/http';
import { uploadAttachment, type UploadTarget } from '../api/public-form';

/** One frozen instance, so the default prop is not a fresh object per render. */
const EMPTY_REFS: ReadonlySet<string> = new Set<string>();

/**
 * The Datei-Upload field — **the whole round trip**: choosing,
 * uploading, seeing what was uploaded, removing it again.
 *
 * ## Why it is a component of its own and not a branch of `Control`
 *
 * Every other question type in `FieldInput.tsx` is a pure function of its
 * answer: it renders controls, `onChange` fires, done. This one talks to the
 * server *while being filled in* — the bytes go up before the form is submitted
 * (ADR-0014 no. 4) — so it needs state of its own (what is in flight, what
 * failed). A branch inside `Control` would have meant hooks inside a `switch`,
 * which is the one thing React's hook order cannot survive.
 *
 * ## What is in the answer, and what is not
 *
 * The answer carries `{ ref, name }` per file and never the bytes
 * (`FileAnswer`). The reference is what the submission **claims** — the step
 * that makes the uploaded bytes belong to this answer at all (no. 13) — and the
 * name is a copy of what the server stored, which the claim checks again on the
 * way in. Nothing here invents either of them: both come out of the upload's own
 * answer.
 *
 * ## A refusal is shown where it happened
 *
 * A 415 (not on the allow list), a 413 (too large, or this address's waiting
 * room is full) and a 409 (the form closed while the page was open) are answers
 * a participant can act on, and each carries the server's own sentence. It goes
 * under **this** field rather than into a page-level banner: the file that was
 * refused is the one just picked, and a message at the foot of a three-page form
 * would be about a picker they can no longer see.
 */
export function FileField({
  question,
  value,
  onChange,
  target,
  unavailable = EMPTY_REFS,
  controlId,
  describedBy,
  invalid,
}: {
  readonly question: Question & { type: 'file' };
  readonly value: AnswerValue | undefined;
  readonly onChange: (value: AnswerValue) => void;
  /**
   * Which door the upload goes through, or `undefined` when there is none.
   *
   * A real state rather than a defensive default: a caller that renders this
   * field without a form to upload against — a preview, a story, a test — gets
   * a picker that is visibly disabled and says so, instead of one whose failure
   * would be a network error nobody can explain.
   */
  readonly target: UploadTarget | undefined;
  /**
   * Which of the attached files **no longer exist** (a review finding of the
   * security review).
   *
   * Only the resumed draft passes something in here: there — and only
   * there — can more than one session lie between the uploading and the submitting,
   * and an unclaimed upload is fetched after 24 hours
   * (ADR-0014 no. 15), while the draft lives up to thirty days. The server
   * resolves the references against `file` and sends the result along
   * (`responseDraftSchema.attachments`); this set is the reading of it.
   *
   * Empty for the other two ways, and that is no carelessness: on the
   * first filling in and on the correcting, the attachment comes into being in the same
   * session in which it is submitted, and the correction owns its files
   * already anyway (condition 1 of the claim).
   */
  readonly unavailable?: ReadonlySet<string>;
  readonly controlId: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}): ReactElement {
  const files = attachmentsOf(value);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The picker is cleared after every pick.
   *
   * Without it, choosing the same file twice in a row fires no `change` event
   * at all — the input's value has not changed — so a participant who removed a
   * scan and picked the very same one again would meet a control that does
   * nothing. That is how a file input works, not a defect of ours, and clearing
   * it is the one way round it.
   */
  const picker = useRef<HTMLInputElement>(null);

  const remaining = question.maxFiles - files.length;

  /*
   * **The dropzone's text is a description, never part of the name.**
   *
   * The picker sits *inside* the `<label>` that draws the dashed zone and also
   * carries the id the question's own `<label htmlFor>` points at. Two labels,
   * and the accessible-name algorithm joins them: measured in the browser on
   * 2026-08-01, the name read „Nachweis Datei auswählen Erlaubt: PDF, PNG, JPG
   * · max. 10 MB" — the question, the call to action and the rule, in one
   * breath, every time the field is announced. The same family as the remove
   * button's „Entfernen : Nachweis.pdf", and Testing Library did not see either
   * of them; `question-types.spec.ts` measures this one with
   * `toHaveAccessibleName`.
   *
   * Hiding the two spans from the accessibility tree alone would fix the name
   * and lose the rule, which is the half a participant most needs — so they are
   * hidden *and* referenced as descriptions. A node referenced by
   * `aria-describedby` is used even when it is `aria-hidden`, which is exactly
   * the case the spec carves out.
   */
  const stateId = `${controlId}-state`;
  const hintId = `${controlId}-hint`;
  const describedByIds = [describedBy, stateId, hintId]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  /** Always the object, never `null` — `{files: []}` is the blank shape the
   * shared validator knows for this type (`blankSchemaFor`), and a second
   * spelling of „nichts angehängt" is what that branch exists against. */
  const publish = (next: readonly FileAttachment[]): void => {
    onChange({ files: [...next] });
  };

  /**
   * Uploads the picked files **one after another**, stopping at the first
   * refusal.
   *
   * Sequentially rather than in parallel: the per-address quota of no. 7 is
   * decided per request, and three uploads racing each other can each be told
   * „es ist noch Platz" before any of them has taken it. Serial requests meet
   * the counters in the order the participant sees them, and the message then
   * names the file that actually did not fit.
   */
  const addAll = async (picked: readonly File[]): Promise<void> => {
    if (target === undefined || picked.length === 0) {
      return;
    }
    setFailure(null);
    setBusy(true);
    // Named rather than dropped: picking five scans for a question that takes
    // two used to upload two and let the other three disappear without a word,
    // which reads as „the browser lost them". A later refusal overwrites this —
    // that one is the more urgent thing to say.
    if (picked.length > remaining) {
      setFailure(
        remaining === 1
          ? 'Es ist noch Platz für eine Datei. Die übrigen wurden nicht hochgeladen.'
          : `Es ist noch Platz für ${String(remaining)} Dateien. Die übrigen wurden nicht hochgeladen.`,
      );
    }
    let carried: FileAttachment[] = [...files];
    try {
      for (const file of picked.slice(0, remaining)) {
        // The size check **before** the request, and only as UX: the server
        // enforces the same number while the bytes arrive (no. 6), and this
        // saves a participant on a mobile connection from sending ten megabytes
        // to be told no. It is deliberately the only client-side check — the
        // *type* is decided from the content on the server, which a browser
        // cannot do.
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setFailure(`„${file.name}" ist zu groß. ${ATTACHMENT_HINT}.`);
          break;
        }
        const stored = await uploadAttachment(target, file);
        carried = [...carried, { ref: stored.ref, name: stored.fileName }];
        // Published per file rather than once at the end: an upload that fails
        // halfway must not lose the ones that already went through.
        publish(carried);
      }
    } catch (error) {
      setFailure(uploadFailureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field__files">
      {files.length === 0 ? null : (
        <ul className="field__file-list">
          {files.map((file) => (
            <li
              className={
                unavailable.has(file.ref)
                  ? 'field__file field__file--gone'
                  : 'field__file'
              }
              key={file.ref}
            >
              <span className="field__file-name">{file.name}</span>
              {/*
                **A dead attachment is made recognisable, not concealed**
                . To take it silently out of the list here
                would be the shorter change and the worse one: the participant
                attached this file, it stood there until a moment ago, and „ist
                einfach weg" is the explanation they would have to give themselves.
                The sentence says instead what happened and what is to be done.

                Visible text and no `title`/`aria-label`: it belongs to the
                entry, is taken along when the list is read out and is
                as readable on the telephone as with the mouse.
              */}
              {unavailable.has(file.ref) ? (
                <span className="field__file-gone">
                  Nicht mehr verfügbar — bitte entfernen und neu hochladen.
                </span>
              ) : null}
              {/* Named per file, not a bare „Entfernen": with several
                  attachments a screen reader would otherwise announce a row of
                  identical buttons with no way to tell which removes which.

                  As `aria-label` rather than a hidden span, because two text
                  nodes are joined by the accessible-name algorithm with a
                  space — „Entfernen : Nachweis.pdf" is what got announced —
                  and because the file name would otherwise stand twice in the
                  tree, where nothing can tell the two apart. The visible word
                  is contained in the name, so voice control still reaches the
                  button by „Entfernen" (WCAG 2.5.3). */}
              <button
                type="button"
                className="field__file-remove"
                aria-label={`Entfernen: ${file.name}`}
                // Locked while an upload runs, because `addAll` carries the
                // list it started with and publishes it after each file: a
                // removal landing in that window would be written back by the
                // next upload, and the participant would submit an attachment
                // they had taken away. Locking is the honest answer — the list
                // is being written, so it cannot be edited at the same time.
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  publish(files.filter((entry) => entry.ref !== file.ref));
                }}
              >
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        **Removing an attachment here deletes nothing yet**, and that is
        deliberate: the bytes are let go when the answer is *submitted* — the
        stored answer no longer names the file, so the claim releases it and the
        purge takes it (`attachment-claim.ts`). Deleting on this click would
        take a file away from an answer that is never handed in, which is the
        one direction of this bookkeeping that cannot be undone.

        The `<label>` **is** the drop area, and the input inside it is visually
        hidden: a native file input cannot be styled into the handoff's dashed
        zone, and a `<button>` driving a hidden input by `.click()` would be a
        control with no accessible relationship to the field at all. This way
        the id the question's `<label>` points at is a real focusable control.
      */}
      {/*
        **The picker is always rendered, disabled rather than removed.** The
        question's own `<label htmlFor>` points at this input (`FieldInput`
        counts a Datei-Upload as a single control), and taking it out of the
        document once `maxFiles` is reached would leave that `htmlFor` pointing
        at an id no element carries — the question text is then simply never
        announced. That is the missing-accessible-name defect, and it is the one `rendersAsGroup`
        exists to keep from coming back.
      */}
      <label
        className={
          invalid
            ? 'field__dropzone field__dropzone--invalid'
            : 'field__dropzone'
        }
      >
        <input
          id={controlId}
          ref={picker}
          type="file"
          className="visually-hidden"
          accept={ATTACHMENT_ACCEPT}
          multiple={remaining > 1}
          disabled={target === undefined || busy || remaining <= 0}
          aria-invalid={invalid}
          aria-describedby={describedByIds}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            if (picker.current !== null) {
              picker.current.value = '';
            }
            void addAll(picked);
          }}
        />
        <span className="field__dropzone-glyph" aria-hidden="true">
          ↥
        </span>
        <span className="field__dropzone-label" id={stateId} aria-hidden="true">
          {busy
            ? 'Wird hochgeladen…'
            : target === undefined
              ? 'Datei-Upload steht hier nicht zur Verfügung'
              : remaining <= 0
                ? 'Alle Dateien angehängt'
                : remaining === 1
                  ? 'Datei auswählen'
                  : `Datei auswählen (noch ${String(remaining)} möglich)`}
        </span>
        <span className="field__dropzone-hint" id={hintId} aria-hidden="true">
          {ATTACHMENT_HINT}
        </span>
      </label>

      {failure === null ? null : (
        <span className="field__error" role="alert">
          {failure}
        </span>
      )}
    </div>
  );
}

/**
 * What went wrong, in a sentence a participant can act on.
 *
 * **The server's own sentence when there is one** (`ApiError.detail`, read from
 * a 4xx body): „Diese Datei wird nicht angenommen. Erlaubt sind PDF, PNG und
 * JPEG — geprüft wird der Inhalt der Datei, nicht ihre Endung." is written for
 * exactly this screen, and a second wording invented here would drift away from
 * the rule it describes. Everything else falls back to one honest sentence
 * rather than to a status code.
 */
export function uploadFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Zu viele Uploads von dieser Verbindung. Bitte einen Moment warten und es erneut versuchen.';
    }
    if (error.detail !== undefined) {
      return error.detail;
    }
  }
  if (error instanceof NetworkError) {
    return error.message;
  }
  return 'Die Datei konnte nicht hochgeladen werden. Bitte erneut versuchen.';
}
