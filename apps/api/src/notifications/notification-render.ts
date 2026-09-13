import {
  DEFERRED_EDIT_LINK,
  answerValueSchema,
  answerableQuestions,
  canonicalAnswerValue,
  canonicalJson,
  formatAnswerCell,
  formatDeadline,
  isBlankAnswer,
  renderMailTemplate,
  type AnswerValue,
  type FormDefinition,
  type MailAnswerRow,
  type MailChangeRow,
  type MailFormat,
  type MailTemplateContext,
  type Question,
} from '@formsache/shared';

/**
 * One answer turned into what a notification may say about it — the half
 * that **both** ends of the queue need.
 *
 * Nest-free and free of Prisma, like `notification-questions.ts` next to it,
 * and for the same reason: it is called from two places that have nothing else
 * in common.
 *
 * **One caller, and since 2026-07-28 that is the point.** It is
 * `public/submission-mail.ts`, at the *enqueue*: recipients, subject **and**
 * body are all settled there, in the transaction that stores the answer, and
 * written to `mail_log`. Nothing about a queued mail is decided again later —
 * the send step only fills the `{{bearbeiten}}` slot (`insertEditLink`).
 *
 * Until that decision the body was rendered a second time at send time, from
 * the notification and the answer as they stood *then*. That asymmetry — frozen
 * recipient, frozen subject, live body — was never decided, and in the window
 * between queueing and sending (days, with a dead mail server or after
 * „↻ Erneut") it meant an edited notification or a corrected answer rewrote a
 * confirmation that had already been promised, while a deleted answer made the
 * delivery fail for good.
 *
 * **The definition is always the one of the answer's own version**
 * (`response.form_version_id`), never the draft. Rendering against the draft
 * would put columns into `{{antworten}}` that did not exist when the
 * participant pressed the button.
 */

/** What a template may be filled from — one submission, already resolved. */
export interface MailContextSource {
  /** Display name of the organisation, for `{{formularorganisation}}`. */
  readonly tenantName: string;
  /** Title of the form, for `{{formular}}`. */
  readonly formTitle: string;
  /** When the answer arrived, for `{{datum}}`. */
  readonly submittedAt: Date;
  /** The snapshot the answer was written against. */
  readonly definition: FormDefinition;
  /**
   * The answers, as validated on the way in **or** as they come back out of
   * JSONB — the type is the widest of the two on purpose.
   *
   * Every value is parsed against `answerValueSchema` below rather than cast:
   * the send path reads a JSONB column, and „die Datenbank prüft es" is never
   * true for one (`CONTRIBUTING.md`).
   */
  readonly answers: Readonly<Record<string, unknown>>;
  /**
   * The answers **as they stood before this edit**, or `null` when this is not
   * an edit at all — what `{{aenderungen}}` is built from.
   *
   * **Required, and it has to be read before the `UPDATE`.** There is no
   * history of answers in this system: the previous values live in the row that
   * the edit is about to overwrite, and after the write there is nothing left
   * to compare against. That is the whole reason the change block is assembled
   * at the enqueue instead of at send time, and the reason this parameter
   * exists rather than a second query somewhere downstream.
   *
   * `null` is the submission's answer and renders the placeholder to nothing
   * (`renderChangeTable`, `@formsache/shared`). It is deliberately not the same as
   * `{}`: an empty object would mean „vorher war alles leer" and would report
   * every answered question as newly filled in.
   */
  readonly previousAnswers: Readonly<Record<string, unknown>> | null;
}

/**
 * Every question of the version that **can** be answered, in document order,
 * with its answer already formatted.
 *
 * **Every** such question, including the unanswered ones: `{{antworten}}` is
 * „die Tabelle mit allen Feldwerten" , and a table that silently
 * left out the blanks would read as though the participant had never been
 * asked.
 *
 * **An Infotext is not one of them** (`answerableQuestions`),
 * and until 2026-07-31 it was: the *sent* confirmation mail carried a row
 * `<tr><th>Bitte pünktlich erscheinen.</th><td></td></tr>` for a callout, while
 * the preview in the builder — which filtered `info` in a second place of its
 * own — showed the editor a table without it. Two filters for one rule, and the
 * one that drifted was the one a participant reads.
 *
 * The formatting itself is `formatAnswerCell` from `csv.ts` — the same function
 * the responses table and the export use. A second spelling here would be the
 * drift `pickDefaultColumns` was shared against: an organisation's confirmation
 * mail saying `4.5` where its export says `4,5`.
 */
function answerRows(source: MailContextSource): MailAnswerRow[] {
  return answerableQuestions(source.definition).map((question) => {
    const parsed = answerValueSchema.safeParse(source.answers[question.id]);
    return {
      questionId: question.id,
      label: question.label,
      // A value this application did not write renders as blank, which is what
      // `formatAnswerCell` answers for everything else it cannot render. It
      // must not throw: the alternative is one damaged row taking a whole
      // delivery down, and at send time that means a mail nobody ever gets.
      value: formatAnswerCell(question, parsed.success ? parsed.data : null),
    };
  });
}

/**
 * One answer value out of a stored document — parsed, never cast.
 *
 * A value this application did not write reads as `null`, the same answer
 * {@link answerRows} gives it: a damaged entry must not throw, because at the
 * enqueue that would take the whole submission down with it.
 */
function answerValue(
  answers: Readonly<Record<string, unknown>>,
  question: Question,
): AnswerValue {
  const parsed = answerValueSchema.safeParse(answers[question.id]);
  return parsed.success ? parsed.data : null;
}

/**
 * What this edit changed — one row per question that really moved, in document
 * order.
 *
 * **The decision runs on the raw stored value, never on `formatAnswerCell`'s
 * output** (finding A of the 2026-07-29 review). Deciding on the formatted
 * string had two independent ways to fall silent about a real change: a value
 * this application could not parse rendered as `''`, indistinguishable from a
 * genuinely blank answer; and two different option values with the same
 * `label`, or two `other` texts that happen to contain the same `, `-joined
 * substring, rendered as the same string. Both are „nicht wissbar" or
 * „fachlich verschieden", and both have to fail towards showing a row, not
 * towards silence — the mail this block feeds is also how a participant learns
 * their Bearbeiten-Link was just used.
 *
 * Two normalisations run before the structural comparison, and only these two:
 * `isBlankAnswer` (`@formsache/shared`) on both sides (any spelling of "nothing here"
 * is the same statement, including `undefined` against `null` against
 * whitespace) and `canonicalAnswerValue` (`@formsache/shared`). `canonicalJson`
 * (`@formsache/shared`) then compares the normalised values key-order-independently,
 * so a document read back out of JSONB in a different key order is not a false
 * change either.
 *
 * **`canonicalAnswerValue` is the shared rule, not a normalisation of this
 * file's own** — the requirement. Until then this file carried its own
 * `normalizeForChangeComparison` for the `other: ''`/`other: null` double
 * spelling, which was the second place „das ist dasselbe" was written down.
 * Since then the *writer* states it: every answer goes into the column
 * canonically, so on two rows written after that this step now changes nothing.
 * It is still applied, and dropping it would be a regression rather than a
 * simplification — the **previous** side of an edit is whatever the column has
 * held. A row stored as `{values: ['fleisch'], other: ''}` and saved
 * again unchanged comes back as `{values: ['fleisch'], other: null}`, neither
 * side blank, and without this it would announce „Fleisch → Fleisch" as a
 * change to the participant whose link was just used.
 *
 * **The blank check is `isBlankAnswer` itself, not a second spelling of it**,
 * since a review. This file used to carry its own
 * `isBlankRawAnswer` because the shared one demanded a parsed `AnswerValue`,
 * and it only ever learned the *four* shapes it originally had: an edit that brought a
 * Matrix, a Tabelle or eine Adresse to its canonically empty form (`{rows: {}}`,
 * `{cells: []}`, four empty subfields) read as „vorher nichts, jetzt etwas" and
 * produced a change row with two empty values. The shared function knows all
 * seven shapes and has survived a raw document (`blankText`,
 * `objectValues`); its parameter is `unknown` now, so the copy has nothing left
 * to be for. Its one load-bearing property is unchanged and still what a finding
 * of 2026-07-29 asked for: a value that cannot be read is **not** blank.
 *
 * **Both sides are read against the version of *this* answer** for the
 * *displayed* row — the caller hands in `response.form_version`'s definition,
 * never the draft — and formatted with `formatAnswerCell`, the function the
 * export and the responses table use, so a change mail reads next to an
 * export without a second, drifting spelling of the same answer type.
 */
function answerChanges(
  definition: FormDefinition,
  previous: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): MailChangeRow[] {
  const changes: MailChangeRow[] = [];

  for (const question of answerableQuestions(definition)) {
    const before = previous[question.id];
    const after = current[question.id];

    if (isBlankAnswer(before) && isBlankAnswer(after)) {
      continue;
    }

    if (
      canonicalJson(canonicalAnswerValue(before)) ===
      canonicalJson(canonicalAnswerValue(after))
    ) {
      continue;
    }

    changes.push({
      questionId: question.id,
      label: question.label,
      previous: formatAnswerCell(question, answerValue(previous, question)),
      current: formatAnswerCell(question, answerValue(current, question)),
    });
  }

  return changes;
}

/** The context a notification of this submission is rendered against. */
export function mailContextOf(source: MailContextSource): MailTemplateContext {
  return {
    formularorganisation: source.tenantName,
    formular: source.formTitle,
    // The one Berlin formatter of the project (`berlin-time.ts`), so a mail
    // reads its date the way the settings page writes one. Fixed zone, fixed
    // format — never `toLocaleString`, whose output depends on the host.
    datum: formatDeadline(source.submittedAt.toISOString()),
    answers: answerRows(source),
    changes:
      source.previousAnswers === null
        ? []
        : answerChanges(
            source.definition,
            source.previousAnswers,
            source.answers,
          ),
  };
}

/** The body of one notification, as it goes into `mail_log`. */
export interface RenderedNotificationBody {
  readonly text: string;
  /** Only for `format: 'html'`; null for a plain-text notification. */
  readonly html: string | null;
}

/**
 * The body of one notification, **frozen**.
 *
 * **An HTML notification carries a plain-text alternative**, which is what
 * `OutgoingMail.text` promises — and it is produced by rendering the *same*
 * template in `'text'` format rather than by stripping the finished HTML. The
 * difference matters: `renderMailTemplate` neutralises each segment on its own,
 * so a value ending in `<a` cannot swallow the template text behind it
 * (`mail-template.ts`).
 *
 * **`{{bearbeiten}}` is the one thing left open** (`DEFERRED_EDIT_LINK`). Both
 * halves keep a mark that the send step replaces with the link — or with
 * nothing, when the form does not allow editing, the token has been revoked
 * with the access word or the answer is gone. Freezing the link
 * with the rest would put an address in a stranger's inbox that is dead by the
 * time it is read, and a mail cannot be recalled.
 */
export function renderNotificationBody(
  notification: { readonly format: MailFormat; readonly body: string },
  context: MailTemplateContext,
): RenderedNotificationBody {
  const text = renderMailTemplate({
    template: notification.body,
    format: 'text',
    context,
    editLink: DEFERRED_EDIT_LINK,
  });

  if (notification.format === 'text') {
    return { text, html: null };
  }

  return {
    text,
    html: renderMailTemplate({
      template: notification.body,
      format: 'html',
      context,
      editLink: DEFERRED_EDIT_LINK,
    }),
  };
}
