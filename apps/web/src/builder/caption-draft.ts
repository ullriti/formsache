import { useId, useState } from 'react';

/**
 * A caption field that may be empty **while it is being edited**.
 *
 * The fields of the properties panel are controlled out of the store, and the
 * store only accepts what `questionSchema` lets through. With every mandatory
 * text (`label: z.string().min(1)`, `questionOptionSchema`,
 * `eventEntrySchema`, `tableColumnSchema`) that fails at exactly the **last**
 * character: the store stays as it is, React draws the old value back, and the
 * field jumps back before the editor's eyes. Whoever wanted to rewrite a
 * question text could not delete it — reported as review finding 22.
 *
 * The way out is the distinction the panel was missing until now: **empty is a
 * valid intermediate state of the editing, but not a valid state of the
 * form.** The draft here holds the empty text, the document keeps the last
 * caption that came through the schema for as long as that lasts, and the
 * field says visibly (and via `aria-invalid`) that nothing is being saved at
 * the moment. What is saved and published is still only what the schema
 * accepts — an empty question text cannot even come into being that way.
 *
 * The same construction that `RatingMaxField` and `ConditionFields` in
 * `QuestionProperties.tsx` already use for numbers and half-finished
 * conditions: a local draft in front of the document, and the document stays
 * the last thing that parsed.
 *
 * **Not** responsible for optional texts (`hint`, appointment, `otherLabel`):
 * there „empty" is a real value and is written as `null`. That is not an
 * intermediate state but a statement, and therefore needs no draft.
 */
export interface CaptionDraft {
  /** What the field shows — the draft, for as long as one is held. */
  readonly value: string;
  /** Empty and therefore not written; the document still carries the old text. */
  readonly invalid: boolean;
  /** Id of the error message, for `aria-describedby`. */
  readonly errorId: string;
  readonly onChange: (next: string) => void;
}

export function useCaptionDraft(
  stored: string,
  commit: (value: string) => void,
): CaptionDraft {
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);

  /*
   * The draft ends as soon as the document itself carries a different text —
   * through its own write from below, through a different selected question or
   * through a template. Adjusting during the render is React's own answer to
   * „a property has changed, derived state has to follow"; the same
   * construction stands in `QuestionProperties` above the live region.
   */
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setDraft(null);
  }

  const value = draft ?? stored;

  return {
    value,
    invalid: value === '',
    errorId,
    onChange: (next) => {
      setDraft(next);
      // Only the empty text is held back. Everything else goes through
      // `questionSchema` as before — a caption that is too long, for instance,
      // is refused there and named in the panel's `props__issue`, while the
      // draft here stays standing instead of taking away what was typed.
      if (next !== '') {
        commit(next);
      }
    },
  };
}
