import {
  attachmentsOf,
  isFileRef,
  type FileAttachment,
  type FormDefinition,
  type Question,
} from '@formsache/shared';

/**
 * Which files a submission names (ADR-0014 no. 13).
 *
 * The references are read **from the answers**, against the published
 * definition, and never from a list beside them: a second carrier on the wire
 * would be a second truth about what this answer's attachments are, and the one
 * that drifts is never the one the claim uses.
 *
 * ## The lock held (the attachment review, 2026-07-31)
 *
 * Until the `file` question type existed this returned an empty list for every
 * submission, and {@link carriesAttachments} was written exhaustively over
 * `Question['type']` so that adding `'file'` to `questionTypeSchema` would turn
 * *this file* into a compile error rather than into a field whose answers
 * nothing claims. It did (TS2366, „lacks ending return statement"), and the
 * branch below is the answer — **not** a `default:`, which is what removing the
 * error rather than answering it would have looked like.
 */
export function attachmentsIn(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): FileAttachment[] {
  const files: FileAttachment[] = [];
  for (const page of definition.pages) {
    for (const question of page.questions) {
      if (carriesAttachments(question)) {
        files.push(...filesIn(answers[question.id]));
      }
    }
  }
  return files;
}

/** The references alone — what the quota and the release are keyed by. */
export function refsOf(files: readonly FileAttachment[]): string[] {
  return files.map((file) => file.ref);
}

function carriesAttachments(question: Question): boolean {
  switch (question.type) {
    // Not one of these carries a file — the Veranstaltung included, it
    // carries numbers. Written out rather than left to a `default:`, because a
    // `default:` is how a new type silently inherits the behaviour of an old one
    // (a lesson learned before). The lock held a second time: adding `'event'` to
    // `questionTypeSchema` turned this file red (TS2366) before anything else in
    // the API did.
    case 'text':
    case 'textarea':
    case 'number':
    case 'date':
    case 'email':
    case 'phone':
    case 'select':
    case 'radio':
    case 'checkbox':
    case 'rating':
    case 'info':
    case 'address':
    case 'matrix':
    case 'table':
    case 'event':
      return false;
    // The one type that does. Its answer names the files by reference,
    // and those references are what the claim of ADR-0014 no. 13 turns into
    // ownership.
    case 'file':
      return true;
  }
}

/**
 * The attachments inside one answer — **tolerantly**, and that is deliberate.
 *
 * Anything that is not a well-formed reference is dropped here rather than
 * refused, because the answer has already been validated against the published
 * definition by the time this runs (`safeParseAnswers`): a value that got this
 * far and still is not a reference is our own inconsistency, not the
 * participant's, and turning it into „Anhang abgelaufen" would blame them for
 * it. What the claim then does with the references it *did* get is the strict
 * half — five conditions, one refusal.
 *
 * `attachmentsOf` is the shared reader of a `FileAnswer` (`@formsache/shared`), so
 * „was steht in so einer Antwort" is answered in one place for the claim, the
 * export and the responses view alike. `isFileRef` is applied **again** here
 * even though `fileAnswerSchema` already required it: this function also runs
 * on the **raw** answers of a required question, which reach the write path as
 * the request body rather than as a parsed value.
 */
function filesIn(answer: unknown): FileAttachment[] {
  return attachmentsOf(answer).filter((file) => isFileRef(file.ref));
}
