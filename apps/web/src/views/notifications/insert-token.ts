/**
 * Inserting a placeholder at the cursor — **the arithmetic,
 * not the DOM**.
 *
 * Split out as a pure function on purpose: jsdom is
 * not a browser, and `selectionStart` / `setSelectionRange` are exactly the
 * kind of thing that half works there — a jsdom test can be green while the
 * caret lands in the wrong place in Firefox, and red while the browser is
 * perfectly fine. So the *computation* („dieser Text, diese Auswahl, dieses
 * Token → neuer Text, neue Cursorposition") is tested here, on strings, with no
 * DOM in sight; jsdom is left with the one question it can answer honestly —
 * whether the click calls this with the right arguments.
 */

/** Where the caret is, or what it has selected. */
export interface TextSelection {
  readonly start: number;
  readonly end: number;
}

/** The text after the insertion, and where the caret goes. */
export interface TokenInsertion {
  readonly text: string;
  /**
   * **Behind** the inserted token, never at its start and never selecting it.
   *
   * An editor who inserts `{{frage:…}}` is mid-sentence; leaving the caret in
   * front of what was just inserted means the next keystroke lands before it,
   * and leaving the token selected means the next keystroke *replaces* it.
   */
  readonly cursor: number;
}

/** Keeps an index inside the text, whatever a caller passed in. */
function clamp(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return length;
  }
  return Math.min(Math.max(Math.trunc(index), 0), length);
}

/**
 * Replaces the selected range with `token` and reports the new caret position.
 *
 * A **selection is replaced**, not appended to: that is what makes the chips
 * usable for correcting a placeholder — select the wrong `{{frage:…}}`, click
 * the right chip. Appending would leave both in the text, and the second one
 * would be the one nobody notices until the mail is out.
 *
 * The bounds are clamped and a reversed pair is put back in order rather than
 * trusted. The DOM never hands out `start > end`, but the caller reads two
 * nullable numbers off an element that may have been re-rendered since the
 * click, and „irgendwas mit NaN" must not become a text field that silently
 * loses its content — `undefined` is normalised to „at the end", which is where
 * a field that was never focused would put it anyway.
 */
export function insertToken(
  text: string,
  selection: TextSelection,
  token: string,
): TokenInsertion {
  const first = clamp(selection.start, text.length);
  const second = clamp(selection.end, text.length);
  const start = Math.min(first, second);
  const end = Math.max(first, second);

  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    cursor: start + token.length,
  };
}
