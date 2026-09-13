import type { ReactElement } from 'react';

/**
 * The star and the word, **separately**, because the markup needs them apart.
 *
 * Kept as the one source of both: the constant and the JSX used to spell the
 * same sentence twice, and the component did not even read its own constant —
 * so a reworded hint would have left the test that asserts the wording green
 * against text nobody sees.
 */
const REQUIRED_HINT_MARK = '*';
const REQUIRED_HINT_LABEL = 'Pflichtfeld';

/** The wording the handoff pins down — see below for the placement. */
export const REQUIRED_HINT_TEXT = `${REQUIRED_HINT_MARK} ${REQUIRED_HINT_LABEL}`;

/**
 * The global hint that starred fields have to be filled in.
 *
 * Wording and placement are the handoff's, not invented here: the *Darstellung*
 * section describes `showRequiredHint` as „Zeigt ‚* Pflichtfeld' oben im
 * Formular" (`Formular-Builder.dc.html`, settings row). This surface did not
 * always exist — the only thing a participant ever saw about required
 * fields was the red `*` next to each label and, after a failed attempt, the
 * per-field message „Pflichtfeld."
 *
 * It sits directly above the questions rather than at the very top of the card,
 * because that is what it explains: the stars in the labels below it. The star
 * is **not** `aria-hidden` here, unlike the one in `FieldInput` — there it is
 * decoration next to a label a screen reader already reads, here it is the
 * subject of the sentence, and hiding it would leave „Pflichtfeld" standing
 * alone with nothing to refer to.
 */
export function RequiredHint(): ReactElement {
  return (
    // `role="note"`: ancillary to the form rather than part of it, and it
    // gives the hint a handle in the accessible tree — the star has to stay a
    // separate element to carry its own colour, which puts the sentence out of
    // reach of a plain text query.
    <p className="public__required-hint" role="note">
      <span className="public__required-mark">{REQUIRED_HINT_MARK}</span>{' '}
      {REQUIRED_HINT_LABEL}
    </p>
  );
}
