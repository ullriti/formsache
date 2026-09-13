import {
  answerValueSchema,
  answerableQuestions,
  formatAnswerCell,
  type FormDefinition,
  type MailAnswerRow,
  type MailTemplateContext,
} from '@formsache/shared';

/**
 * The placeholder context **of one trial run** — with that run's own values,
 * not with sample placeholders.
 *
 * That is the one difference to the preview in the notification editor
 * (`../notifications/sample-context.ts`): that one shows, while the template
 * is being written, *what* a value looks like, and invents it for that
 * purpose. This one shows, after a test run, *what* would go out — with
 * exactly the values that stood in the form a moment ago. „Der Bearbeiter
 * sieht damit auch das, was die Platzhalter-Ersetzung escapen muss, an echten
 * Werten" only works with the real ones.
 *
 * **Formatting happens with `formatAnswerCell`**, that is, with the same
 * function the responses table, the export and the sent mail get their cells
 * from. What had a spelling of its own here would be exactly the state
 * `csv.ts` prevents: a mail that says `4.5` where the export writes `4,5`.
 *
 * **An info text gets no row** — `answerableQuestions`, the same one rule the
 * sent mail (`notification-render.ts`) and the editor preview build their
 * table from. There were once two filters here for one rule, and the one that
 * deviated was the one a participant read; a third one is not being added.
 */
export interface RunContextInput {
  readonly definition: FormDefinition;
  /** Display name of the organisation — `{{formularorganisation}}`. */
  readonly tenantName: string;
  /** Title of the form — `{{formular}}`. */
  readonly formTitle: string;
  /** The answers of the trial run, just as they stood in the form. */
  readonly answers: Readonly<Record<string, unknown>>;
  /**
   * The date `{{datum}}` inserts — **already formatted**, because a trial run
   * has no timestamp that anything would find again later.
   */
  readonly datum: string;
}

export function runContext(input: RunContextInput): MailTemplateContext {
  const answers: MailAnswerRow[] = answerableQuestions(input.definition).map(
    (question) => {
      // Parsed instead of asserted: the values come out of the state of an
      // input mask in which a half-typed number stands as a string. A value
      // the schema does not read is displayed as empty — the same answer
      // `formatAnswerCell` gives to everything it does not know.
      const parsed = answerValueSchema.safeParse(input.answers[question.id]);
      return {
        questionId: question.id,
        label: question.label,
        value: formatAnswerCell(question, parsed.success ? parsed.data : null),
      };
    },
  );

  return {
    formularorganisation: input.tenantName,
    formular: input.formTitle,
    datum: input.datum,
    answers,
    /*
     * **Empty, and that is the statement.** `{{aenderungen}}` only fills up on
     * an *edit* of an answer that has already been submitted — a trial run is
     * none, so the block has nothing to say. The editor preview fills it with
     * a sample row, because it shows a *template* and an empty block there
     * would leave „falsch geschrieben oder einfach leer?" open. Here the
     * question is answered: what the trial run triggers is a submission.
     */
    changes: [],
  };
}
