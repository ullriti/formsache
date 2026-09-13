/**
 * The question types the check form of the axe run carries.
 *
 * A file of its own and not an export from `a11y.spec.ts`: two files read the
 * list (the run itself and the completeness guard in
 * `a11y-view-list.spec.ts`), and importing from a spec file would mean loading
 * it along when the test cases are collected. The same tidying-up as with the
 * image sample in `e2e/sample-image.ts`.
 */

/** The first question — the only one that is also filled in and submitted. */
export const FIRST_QUESTION_TYPE = 'Text';

/**
 * ⚠️ **And the other fifteen** (a review finding).
 *
 * A check form with only **one** text question would let the axe run see the
 * same `<input type="text">` all the way across builder, test mode, fill-in
 * mask, editing and draft. Fifteen of sixteen question types
 * would thereby stay unscanned, and it is precisely the composite ones where
 * accessibility is hard: matrix and table are grids of
 * controls, „Adresse" and „Veranstaltung" are groups of several
 * fields, the file upload is a rebuilt `<input type="file">`.
 *
 * The labels stay the defaults from `QUESTION_TYPE_LABELS` — they
 * are different per type, hence unambiguous, and a list of its own here would
 * be a second truth about the names of the question types.
 *
 * **It is not complete because it stands here**, but because
 * `a11y-view-list.spec.ts` counts it against `QUESTION_TYPE_LABELS`
 * (`a11y/question-type-labels.ts`) — the same construction as with the
 * addresses and the dialogs. Without that count it would be exactly the
 * hand-maintained list this finding was raised against: a seventeenth question
 * type would be added and would never be scanned.
 *
 * *Counter-check:* set this list to `[]` → the check form has one
 * question again, and every violation one of the fifteen types brings with it
 * is invisible again. That is exactly how it was for four milestones.
 */

export const FURTHER_QUESTION_TYPES = [
  'Mehrzeilig',
  'Zahl',
  'Datum',
  'E-Mail',
  'Telefon',
  'Dropdown',
  'Einfachauswahl',
  'Mehrfachauswahl',
  'Bewertung',
  'Infotext',
  'Adresse',
  'Matrix',
  'Tabelle',
  'Datei-Upload',
  'Veranstaltung',
] as const;
