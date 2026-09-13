import type { ReactElement } from 'react';

import type { ContrastNote } from './color-contrast';

/**
 * **The message at the colour picker** .
 *
 * It sits *next to* the colour field and is attached to that field's input via
 * `aria-describedby` — the caller wires it up, because the caller is what knows
 * the input's `id`. A screen reader then reads the sentence on entering the
 * field instead of leaving it a loose paragraph somewhere on the page.
 *
 * ## Three things this message deliberately does **not** do
 *
 * 1. **It locks nothing.** No `disabled` switch, no return value, no call
 *    upwards — „reported, not refused" is the decision, and a save button
 *    greyed out by this file would be its opposite.
 *    `TenantAppearanceTab.test.tsx` and `TenantMembersTab.test.tsx` catch
 *    exactly that.
 * 2. **It does not carry its state in the colour.** Every sentence starts with
 *    a visible lead word („Fläche" / „Schrift") which at the same time says
 *    *which* of the two cases applies. A yellow box on its own would be mute
 *    for somebody without colour perception — and the axe gate has 46
 *    green cases for that reason.
 * 3. **It is neither `role="alert"` nor a live region.** A colour picker fires
 *    `change` while it is being dragged; a live region would interrupt dozens
 *    of times. The sentence belongs to the *description* of the field, not into
 *    the announcement.
 *
 * ## Two lines, and the order is the statement (finding 13)
 *
 * At the top stands what is to be done — in which direction the colour would
 * have to go and from which hex value it is enough. Below it, more quietly,
 * the measured ratio and the sentence that it is saved nonetheless.
 * Previously the figure stood in the first sentence and the action, if at all,
 * in the last; whoever does not read contrast values thereby heard a number
 * first and stopped reading second. Both remain **one** description of the
 * field: `aria-describedby` points at the box, so a screen reader still reads
 * both lines.
 */
export function ColorContrastNotes({
  id,
  notes,
}: {
  /** Target of `aria-describedby` on the matching input. */
  readonly id: string;
  readonly notes: readonly ContrastNote[];
}): ReactElement | null {
  if (notes.length === 0) {
    return null;
  }

  return (
    <div className="tenant-admin__contrast" id={id}>
      {/* `note.kind` as the key: a list holds each of the two cases at most
          once, so it is an identity rather than a position. */}
      {notes.map((note) => (
        <p className="tenant-admin__contrast-note" key={note.kind}>
          <span className="tenant-admin__contrast-label">{note.label}:</span>{' '}
          {note.text}{' '}
          <span className="tenant-admin__contrast-detail">{note.detail}</span>
        </p>
      ))}
    </div>
  );
}
