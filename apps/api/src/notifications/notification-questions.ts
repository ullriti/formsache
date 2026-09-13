import {
  allQuestions,
  isAddressQuestion,
  MAIL_RECIPIENT_LIMIT,
  notificationQuestionIds,
  notificationRecipientSchema,
  ORPHANED_PLACEHOLDER_LEAD,
  PLACEHOLDER_PLACE_LABELS,
  questionPlaceholderIds,
  questionPlaceholderToken,
  recipientQuestionIds,
  type FormDefinition,
  type NotificationRecipient,
  type PlaceholderPlace,
  type Question,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

/**
 * What a notification may point at, and what happens when it points at nothing
 * (the requirements).
 *
 * Pure functions, no Nest and no database: they are used from two very
 * different places — the notification CRUD, which refuses a recipient that
 * names no question, and `FormsService.publish()`, which refuses a whole
 * publish while a placeholder would be left pointing into thin air. One
 * description of „zeigt das ins Leere?" rather than two, because two would be
 * two chances to answer it differently, and the half that says „no" is the half
 * that sends a mail with a hole in it.
 */

/**
 * Every question of a form that can supply an address, in document order.
 *
 * The rule itself — `ADDRESS_QUESTION_TYPES`, `isAddressQuestion` — lives in
 * `@formsache/shared`. It used to stand here *and* in the editor, the
 * enforcing copy and the offering one, and the day an address type is added
 * beyond `email` both would have had to move together. What is left here is the
 * walk over the definition, which is the only part that is about a form.
 */
export function addressQuestions(definition: FormDefinition): Question[] {
  return allQuestions(definition).filter(isAddressQuestion);
}

/**
 * The notification fields both callers of this module reason about.
 *
 * `recipients` arrives as raw JSONB, exactly as the column hands it out. The
 * parse happens **here** rather than at each call site, so the publish lock
 * cannot end up trusting a shape the CRUD refuses.
 */
export interface StoredNotification {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly recipients: Prisma.JsonValue;
}

/**
 * Reads a stored recipient list back, or `null` when the column holds
 * something this application did not write.
 *
 * Parsed, not cast (`CONTRIBUTING.md`): JSONB accepts any JSON, so „die Datenbank
 * prüft es" is never true for this column. What the three callers do with a
 * `null` differs on purpose, and each says why at its own call site.
 *
 * **The length bound belongs here, not only on the way in.**
 * `notificationCreateSchema` carries `MAIL_RECIPIENT_LIMIT` for a request, but
 * this function is what the *send* path reads a row back through — and a row
 * with two hundred recipients can be written straight into the database, where
 * no request schema ever sees it. Twenty is the decided fan-out of one
 * notification; a list longer than that is a row this
 * application did not write, and it is refused as such rather than silently
 * shortened, because shortening would hide which addresses were dropped.
 */
export function parseStoredRecipients(
  stored: Prisma.JsonValue,
): NotificationRecipient[] | null {
  const parsed = notificationRecipientSchema
    .array()
    .max(MAIL_RECIPIENT_LIMIT)
    .safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** One reference that would point at nothing after publishing. */
export interface OrphanedPlaceholder {
  readonly notificationId: string;
  readonly notificationName: string;
  readonly questionId: string;
  /** The token as it is written, so the editor can search for it. */
  readonly token: string;
  /** Caption of the disappearing question, when the old version still knows it. */
  readonly label: string | null;
  /** Subject, body, recipient list — or several of them. */
  readonly places: readonly PlaceholderPlace[];
}

/**
 * Every reference the **new** version would leave dangling.
 *
 * Membership in the draft is the test — deliberately **not** „appears in
 * `publishDiff().removed`", although that list is right next to it. A retyped
 * question mints a new id and the diff pairs the two into one line, so the predecessor is not reported as removed at all — while a
 * placeholder naming it would still find no question in the published document
 * and render a hole. The diff answers „what does the editor need to be warned
 * about", this answers „does this id still exist", and the second question is
 * the one a mail asks.
 *
 * That is also why this is not a second copy of the diff: it compares nothing.
 * It asks the draft whether an id is in it.
 *
 * **Renaming is free.** The binding is the id, so a question whose caption
 * changed is still the same question and nothing here fires — which is the
 * whole reason this system stores ids rather than captions.
 *
 * All three places are read through `notificationQuestionIds`, one call: the
 * recipient list is the one an implementation forgets, and a body with a gap is
 * embarrassing where a notification without a recipient is a mail with no
 * destination.
 */
export function findOrphanedPlaceholders(input: {
  readonly draft: FormDefinition;
  /** The version in force — used only to name the question that disappears. */
  readonly published: FormDefinition | null;
  readonly notifications: readonly StoredNotification[];
}): OrphanedPlaceholder[] {
  const draftIds = new Set(
    allQuestions(input.draft).map((question) => question.id),
  );
  const labels = new Map(
    (input.published === null ? [] : allQuestions(input.published)).map(
      (question) => [question.id, question.label],
    ),
  );

  return input.notifications.flatMap((notification) => {
    // An unreadable recipient column must not wedge publishing for good: the
    // notification editor already refuses to show such a row (see
    // `NotificationsService`), so the repair happens there. Subject and body
    // are still checked — they are plain text and always readable.
    const recipients = parseStoredRecipients(notification.recipients) ?? [];
    const referenced = notificationQuestionIds({
      subject: notification.subject,
      body: notification.body,
      recipients,
    });

    return referenced
      .filter((questionId) => !draftIds.has(questionId))
      .map((questionId) => ({
        notificationId: notification.id,
        notificationName: notification.name,
        questionId,
        token: questionPlaceholderToken(questionId),
        label: labels.get(questionId) ?? null,
        places: placesOf(notification, recipients, questionId),
      }));
  });
}

/** Which of the three parts of a notification name one question id. */
function placesOf(
  notification: StoredNotification,
  recipients: readonly NotificationRecipient[],
  questionId: string,
): PlaceholderPlace[] {
  const places: PlaceholderPlace[] = [];
  if (questionPlaceholderIds(notification.subject).includes(questionId)) {
    places.push('subject');
  }
  if (questionPlaceholderIds(notification.body).includes(questionId)) {
    places.push('body');
  }
  if (recipientQuestionIds(recipients).includes(questionId)) {
    places.push('recipients');
  }
  return places;
}

/**
 * The refusal an editor reads when publishing is blocked.
 *
 * It **names the notification and the placeholder**, because the alternative is
 * „irgendwo in Ihren Benachrichtigungen" and then the editor searches n texts
 * by hand. The question's old caption comes along when the version in force
 * still knows it — an id is precise and unreadable, a caption is readable and
 * ambiguous, and the two together are what somebody can act on.
 *
 * The lead sentence comes from `ORPHANED_PLACEHOLDER_LEAD` in `@formsache/shared`,
 * like the item wording comes from `PLACEHOLDER_PLACE_LABELS`: the
 * publish dialog states this block *before* the button, and a second copy there
 * had already drifted by the time this was reviewed.
 */
export function orphanedPlaceholderMessage(
  findings: readonly OrphanedPlaceholder[],
): string {
  const items = findings.map((finding) => {
    const question =
      finding.label === null
        ? finding.token
        : `„${finding.label}" (${finding.token})`;
    const places = finding.places
      .map((place) => PLACEHOLDER_PLACE_LABELS[place])
      .join(', ');
    const where = places === '' ? '' : ` in ${places}`;
    return `Benachrichtigung „${finding.notificationName}"${where}: ${question}`;
  });

  return (
    `Veröffentlichen nicht möglich: ${ORPHANED_PLACEHOLDER_LEAD} ` +
    items.join(' · ')
  );
}
