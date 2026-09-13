import {
  answerableQuestions,
  isChoiceQuestion,
  type FormDefinition,
  type MailAnswerRow,
  type MailChangeRow,
  type MailTemplateContext,
  type Question,
  type TableColumn,
} from '@formsache/shared';

/**
 * The example answer the preview renders against (the requirement: „eine
 * Vorschau mit Beispieldaten").
 *
 * **Example data, and it says so on screen.** The alternative — rendering
 * against a real submission — would put a participant's address and answers
 * into a configuration surface whose permission (`can_manage_settings`) does
 * not cover answers; that is precisely the line the requirement draws for the
 * mail log, and it is not crossed here for the sake of a nicer preview.
 *
 * The rows are built from the **draft** definition, because that is what the
 * editor is looking at while writing the template. What actually gets sent is
 * rendered against the form version of the response (`mail-template.ts`), and
 * the gap between the two is exactly what the requirement locks: a placeholder
 * naming a question the next published version drops blocks publishing.
 */

/** A date that is obviously an example rather than „heute". */
const SAMPLE_DATE = '01.03.2026';

/** One plausible answer per question type — German, like everything on screen. */
function sampleValue(question: Question): string {
  if (isChoiceQuestion(question)) {
    const labels = question.options.map((option) => option.label);
    const first = labels[0];
    if (first === undefined) {
      return 'Beispielauswahl';
    }
    // A multiple-choice answer is several values, and `{{antworten}}` has to
    // show that it is: a preview that made every choice look single-valued
    // would hide the one formatting question an editor might have.
    return question.type === 'checkbox' ? labels.slice(0, 2).join(', ') : first;
  }

  // No `default`: „Beispieltext" is a plausible-looking answer for every type,
  // which is what makes it the wrong fallback — a preview that shows an
  // Adresse or eine Bewertung as „Beispieltext" teaches an editor the wrong
  // thing about the mail they are writing, and nothing on screen says so
  // . The choice types are gone before this point (`isChoiceQuestion`),
  // so the switch is exhaustive over what is left.
  switch (question.type) {
    case 'text':
      return 'Beispieltext';
    case 'textarea':
      return 'Beispieltext über\nmehrere Zeilen';
    case 'number':
      return '42';
    case 'date':
      return SAMPLE_DATE;
    case 'email':
      return 'max.mustermann@example.de';
    case 'phone':
      return '+49 30 1234567';
    // Four stars, capped at the question's own maximum — plausible for a
    // 2-star scale as well as a 10-star one, never a value the question
    // itself could not have received.
    case 'rating':
      return String(Math.min(4, question.max));
    // Never reached: `sampleContext` filters `info` questions out before
    // calling this function, the same way it filters nothing else — an
    // `info` has no answer to preview. Present only so the switch
    // stays exhaustive.
    case 'info':
      return '';
    // Folded the same way `formatAnswerCell` folds a real one — a
    // mail placeholder shows the one line an editor will actually see, not
    // the four columns only the export takes apart. The handoff's own
    // preview default agrees almost to the word (`renderPreview`'s address
    // branch: „Musterstraße 12, 70173 Stuttgart").
    case 'address':
      return 'Musterstraße 12, 70173 Stuttgart, Deutschland';
    // Folded exactly the way `formatAnswerCell` folds a real Matrix,
    // and built from **this** question's own rows and scale rather than from
    // invented captions: an editor writing a mail template has to see what
    // „{{frage:Bewertung}}" will actually look like for the question they
    // built, and „Organisation: Sehr gut" made up here would be a preview of a
    // different form. The first scale step per row, because a preview shows
    // the shape and not an opinion.
    case 'matrix': {
      const first = question.columns[0];
      return first === undefined
        ? ''
        : question.rows.map((row) => `${row.label}: ${first.label}`).join('; ');
    }
    // The same reasoning for a Tabelle, one row deep: the folded rendering
    // joins a row's cells with „, ", and one example row says everything about
    // the shape that three would.
    case 'table':
      return question.columns
        .map((column) => `${column.label}: ${sampleTableCell(column)}`)
        .join(', ');
    // A file answer folds to its **names** (`formatAnswerCell`), and a preview
    // of a notification shows exactly that — never a reference and never an
    // address, which is the same decision the export makes (ADR-0014 no. 17).
    // One name, because `maxFiles` is one in the overwhelming majority of forms
    // and a second would only repeat the shape.
    case 'file':
      return 'nachweis.pdf';
    // Folded exactly the way `formatAnswerCell` folds a real Veranstaltung
    // answer and built from **this** question's own entries, for the
    // reason the Matrix branch above gives: an editor writing a mail template
    // has to see what „{{frage:Veranstaltungen}}" will look like for the form
    // they built, not for an invented one. Two people per entry, because the
    // whole point of the type is that a registration carries a Personenzahl —
    // „Sommerfest: 1" would read like a tick.
    case 'event':
      return question.events.map((entry) => `${entry.label}: 2`).join('; ');
  }

  // Unreachable while the switch is exhaustive; a new question type narrows to
  // itself instead of `never` here and the assignment names it.
  const unhandled: never = question;
  return unhandled;
}

/** One plausible cell per Zelltyp — the same four the column editor offers. */
function sampleTableCell(column: TableColumn): string {
  switch (column.type) {
    case 'text':
      return 'Beispieltext';
    case 'number':
      return '2';
    // The first real entry, never an invented one: a Liste column whose
    // options an editor just typed is the one place a made-up value would be
    // noticed immediately — and rightly so.
    case 'select':
      return column.options[0]?.label ?? '';
    // What `formatTableCell` writes for a ticked box (`answer-columns.ts`).
    case 'checkbox':
      return 'Ja';
  }
}

export interface SampleContextInput {
  readonly definition: FormDefinition;
  /** Display name of the organisation — `{{formularorganisation}}`. */
  readonly formularorganisation: string;
  /** Title of the form — `{{formular}}`. */
  readonly formular: string;
}

/** Everything `{{…}}` may refer to, filled with example values. */
export function sampleContext(input: SampleContextInput): MailTemplateContext {
  // `info` questions are excluded, not merely given an empty example: an
  // `info` is a callout with no answer, so it offers no `{{frage:…}}`
  // placeholder either — the same exclusion `questionColumns` makes for the
  // export, applied to the mail preview.
  //
  // **`answerableQuestions` and not a `filter` of its own** (a review finding):
  // this filter *was* the second one, and the first — the
  // mail that gets sent (`notification-render.ts`) — did not have it. The
  // preview showed the editor a table without the info text, the participant
  // got one with it. One rule, one function.
  const answers: MailAnswerRow[] = answerableQuestions(input.definition).map(
    (question) => ({
      questionId: question.id,
      label: question.label,
      value: sampleValue(question),
    }),
  );

  return {
    formularorganisation: input.formularorganisation,
    formular: input.formular,
    datum: SAMPLE_DATE,
    answers,
    changes: sampleChanges(answers),
  };
}

/**
 * An example change block — **always filled here**, unlike in a real mail.
 *
 * `{{aenderungen}}` is empty in every mail that is not a correction, and the
 * preview would then show an editor who wrote the placeholder nothing at all:
 * „ist der Platzhalter falsch geschrieben, oder hat er hier einfach nichts zu
 * sagen?" is not a question a preview may leave open. So the example shows what
 * the block *looks* like, and `NotificationPreview` says in words when it stays
 * empty — the same split the edit link already uses (`sampleEditLink`).
 *
 * The first answer alone, and its value „changed": one row is enough to show
 * the shape, and a preview that reported every question as changed would teach
 * exactly the wrong thing about a block whose point is that it is short.
 */
function sampleChanges(answers: readonly MailAnswerRow[]): MailChangeRow[] {
  const first = answers[0];
  if (first === undefined) {
    return [];
  }
  return [
    {
      questionId: first.questionId,
      label: first.label,
      previous: 'Bisheriger Wert',
      current: first.value,
    },
  ];
}
