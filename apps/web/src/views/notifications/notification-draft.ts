import {
  MAIL_BODY_MAX,
  MAIL_RECIPIENT_LIMIT,
  MAIL_SUBJECT_MAX,
  parseRecipientList,
  QUESTION_PLACEHOLDER_PREFIX,
  replyToAddressSchema,
  unresolvedQuestionCaptions,
  type MailFormat,
  type Notification,
  type NotificationCreate,
  type NotificationRecipient,
  type NotificationTemplate,
  type NotificationTrigger,
  type NotificationTriggerInput,
  type Question,
} from '@formsache/shared';

import { trimmedOrNull } from '../trimmed-or-null';

/**
 * The notification being edited — everything the editor on the right holds.
 *
 * A plain value with pure functions over it, in the shape `settings-draft.ts`
 * established. **It is not server state and it is not in a Zustand
 * store either:** the draft belongs to one open editor, dies with it, and is
 * never read by anything else on the page. Putting it in the global builder
 * store would make it outlive the view it belongs to (the store is a singleton
 * and would carry one form's half-written mail into the next), and putting it
 * in the query cache would make „ungespeichert" indistinguishable from „was der
 * Server bestätigt hat" — which is the mixing `CONTRIBUTING.md` forbids.
 */

export interface NotificationDraft {
  readonly name: string;
  /**
   * What sends this notification — a non-empty subset of what the API
   * accepts (`notificationTriggerInputSchema`, `@formsache/shared`).
   *
   * **`'save'` never appears here.** „Bei Zwischenspeichern" is absent,
   * not offered and disabled — a checkbox that cannot be checked would
   * promise a function this application does not have. See `draftOf` for
   * what happens to a row written straight into the database with `'save'`
   * already in it.
   */
  readonly triggers: readonly NotificationTriggerInput[];
  readonly format: MailFormat;
  readonly active: boolean;
  /**
   * The **storage form** — `{{frage:<id>}}`, never the caption.
   *
   * `NotificationEditor` is the only place that shows the readable form; it
   * converts on the way in and back on the way out (`toDisplayForm` /
   * `toStorageForm`, `@formsache/shared`), so this field never has to change meaning
   * and a save always writes what it always wrote.
   */
  readonly subject: string;
  /** Storage form, same as {@link NotificationDraft.subject}. */
  readonly body: string;
  /**
   * The reply-to address of this notification, **as typed** — empty means
   * „es gilt, was die Organisation bzw. das System vorgibt" .
   *
   * No placeholder field: a fixed address stands here, no `{{frage:…}}`.
   * That is the reason the value never becomes personal — it cannot stem
   * from a response at all — and why the copy in `mail_log` is exempt from
   * the deletion promise.
   */
  readonly replyTo: string;
  /**
   * Fixed addresses **as typed**, comma separated — the raw box, not a parsed
   * list.
   *
   * Kept verbatim so a rejected entry stays on screen where its author can fix
   * it. Dropping the invalid ones on every keystroke would delete text while
   * somebody is in the middle of typing it.
   */
  readonly literalRecipients: string;
  /** Question ids chosen as recipients — the **id** is stored. */
  readonly questionRecipients: readonly string[];
}

/** Whether the wide (read-side) trigger is one the editor can offer a box for. */
function isTriggerInput(
  trigger: NotificationTrigger,
): trigger is NotificationTriggerInput {
  return trigger === 'submit' || trigger === 'edit';
}

/** A new, unsaved notification — the defaults of `notificationCreateSchema`. */
export function emptyDraft(): NotificationDraft {
  return {
    name: 'Neue Benachrichtigung',
    triggers: ['submit'],
    format: 'html',
    active: true,
    subject: '',
    body: '',
    replyTo: '',
    literalRecipients: '',
    questionRecipients: [],
  };
}

/** The stored notification, opened for editing. */
export function draftOf(notification: Notification): NotificationDraft {
  return {
    name: notification.name,
    // `notification.triggers` is the wide enum (a row can carry `'save'`
    // straight from the database, `notificationSchema`'s own comment says
    // so) — filtered down to what this editor's two boxes can show. A row
    // with only `'save'` therefore opens with an empty set here, which
    // `draftProblems` then blocks the save on until the editor picks one of
    // the two this application actually has; that is honest about what
    // happened, unlike silently keeping `'save'` around for a box that was
    // never offered to turn it off.
    triggers: notification.triggers.filter(isTriggerInput),
    format: notification.format,
    active: notification.active,
    subject: notification.subject,
    body: notification.body,
    replyTo: notification.replyTo ?? '',
    literalRecipients: notification.recipients
      .filter((recipient) => recipient.kind === 'literal')
      .map((recipient) => recipient.address)
      .join(', '),
    questionRecipients: notification.recipients
      .filter((recipient) => recipient.kind === 'question')
      .map((recipient) => recipient.questionId),
  };
}

/** `draft.triggers` still exactly the un-edited default (`emptyDraft`). */
function hasDefaultTriggers(
  triggers: readonly NotificationTriggerInput[],
): boolean {
  return triggers.length === 1 && triggers[0] === 'submit';
}

/**
 * A delivered template, poured into the draft — **once, and without a link
 * back** .
 *
 * **Only fields still at their {@link emptyDraft} value are overwritten**
 * (a review finding of the 2026-07-28 review). The field order of `NotificationEditor`
 * is Name → Auslöser → Format → Empfänger → Betreff → Text, so somebody
 * filling it in top to bottom has typed a name and a subject *before* the
 * template row ever shows — it only appears once the text field is reached,
 * and stays offered until that one has something in it
 * ({@link acceptsTemplate}). A click there used to overwrite the four fields
 * above it too, silently: the very definition of a data-loss button the
 * module comment on the picker already names, just one field short. Each
 * field is therefore checked on its own against the value `emptyDraft()`
 * gives it, not against „is the whole draft new": name, triggers and format
 * follow the same rule as subject/body, they are just less likely to have
 * been touched first.
 *
 * A notification that stayed *bound* to a template would be a second truth
 * beside its own text — and every later change to the template would rewrite
 * mails somebody had already adjusted — so what a field *does* take from the
 * template is copied in once and forgotten, same as before.
 *
 * **Recipients are kept, not replaced.** A template cannot name them: they point
 * at a question of *this* form or at an address somebody typed, and
 * both are things the person applying the template may already have chosen. The
 * one hint a template does carry is `toSubmitter`, and it is the caller's
 * business what to do with it — see `NotificationEditor`, which uses it to
 * suggest the form's address question when there is exactly one obvious choice.
 *
 * Guarded by {@link acceptsTemplate} at the call site rather than in here: this
 * function is „setze diese Vorlage ein", and a function that silently declined
 * to do what it says would be the harder thing to reason about. The per-field
 * checks above are not that decline — they only ever *keep* what somebody
 * already typed, they never refuse the click as a whole.
 */
export function applyTemplate(
  draft: NotificationDraft,
  template: NotificationTemplate,
): NotificationDraft {
  const fresh = emptyDraft();
  return {
    ...draft,
    name: draft.name === fresh.name ? template.name : draft.name,
    triggers: hasDefaultTriggers(draft.triggers)
      ? [...template.triggers]
      : draft.triggers,
    format: draft.format === fresh.format ? template.format : draft.format,
    subject: draft.subject.trim() === '' ? template.subject : draft.subject,
    body: draft.body.trim() === '' ? template.body : draft.body,
  };
}

/**
 * Whether this notification would reach the person filling the form in.
 *
 * **A question recipient *is* participant delivery** — full stop.
 * The chips address the answer to an e-mail question, and the
 * answer to an e-mail question is the participant's own address, so there is
 * nothing left to ask beyond „is a question chosen". There used to be a second,
 * independent `toSubmitter` marker a checkbox could set without a chip behind
 * it; that box is gone (it never created a recipient, only suppressed one —
 * see the removal note at `notificationWriteShape`, `@formsache/shared`), and with it
 * the case that produced the original finding: an unticked box with a chosen
 * chip, which sent participant mail the warning below never mentioned.
 *
 * Still one function rather than the condition written out at each of its uses
 * (the warning, the chip row, the request) — one definition is what keeps them
 * from drifting apart again.
 */
export function reachesSubmitter(draft: NotificationDraft): boolean {
  return draft.questionRecipients.length > 0;
}

/** What the addresses box currently amounts to. */
export interface DraftRecipients {
  readonly recipients: NotificationRecipient[];
  /** Entries that are not addresses, verbatim. */
  readonly invalid: string[];
}

/**
 * Reads the draft's two recipient inputs into the stored shape.
 *
 * The typed box goes through `parseRecipientList` from `@formsache/shared` — the same
 * splitting and per-entry validation the server reasons about. Nothing here
 * splits a string by itself: an entry containing a comma has to stay **one**
 * rejected entry, or one chosen recipient quietly becomes two.
 *
 * Question recipients come first in the produced list, because that is the
 * order the editor reads them in: the chip row sits above the address box.
 */
export function draftRecipients(draft: NotificationDraft): DraftRecipients {
  const typed = parseRecipientList(draft.literalRecipients);

  return {
    recipients: [
      ...draft.questionRecipients.map((questionId) => ({
        kind: 'question' as const,
        questionId,
      })),
      ...typed.addresses.map((address) => ({
        kind: 'literal' as const,
        address,
      })),
    ],
    invalid: typed.invalid,
  };
}

/** Everything that keeps this draft from being saved, in German, for the editor. */
export function draftProblems(
  draft: NotificationDraft,
  form: {
    readonly hasAddressQuestion: boolean;
    /** Every question of the form — what an unresolved caption is checked against. */
    readonly questions: readonly Question[];
  },
): string[] {
  const problems: string[] = [];
  const { recipients, invalid } = draftRecipients(draft);

  if (draft.name.trim() === '') {
    problems.push('Bitte einen Namen für die Benachrichtigung angeben.');
  }
  if (draft.subject.trim() === '') {
    problems.push('Bitte einen Betreff angeben.');
  }
  // The API's own `.min(1)` on `triggers`, said before the request: a
  // notification that fires on nothing is a 400 the person saving it could
  // not read, not a state this form should let through to find out
  // (`notificationTriggersInputSchema`, `@formsache/shared`). Deliberately a
  // blocking problem rather than pinning the last box — a control that
  // will not uncheck does not explain *why*; this message does.
  if (draft.triggers.length === 0) {
    problems.push(
      'Bitte mindestens einen Auslöser wählen: „Bei Absendung" oder „Bei Bearbeitung".',
    );
  }

  // `draft.subject`/`draft.body` are the storage form (module comment on
  // `NotificationDraft`) — except exactly where `toStorageForm` had nothing
  // to convert a caption to (trap 3, `mail-placeholder-display.ts`), and
  // then what is sitting in „storage form" is really still the caption the
  // user typed, unflagged by anything else in the system. Blocking rather
  // than warning: the alternative is a sent mail with the raw
  // `{{frage:…}}` text in it, and that cannot be taken back the way a
  // draft can be fixed.
  for (const caption of new Set([
    ...unresolvedQuestionCaptions(draft.subject, form.questions),
    ...unresolvedQuestionCaptions(draft.body, form.questions),
  ])) {
    problems.push(
      `{{${QUESTION_PLACEHOLDER_PREFIX}${caption}}} zeigt auf keine Frage dieses Formulars.`,
    );
  }

  // The server bounds the **stored** subject/body, and a placeholder's
  // stored form (`{{frage:<uuid>}}`) is almost always longer than its
  // displayed caption — `draft.subject`/`draft.body` already are storage
  // form, so this is the true length, not the one the editor's field
  // happens to show (`notificationWriteShape` in `mail.ts`).
  if (draft.subject.trim().length > MAIL_SUBJECT_MAX) {
    problems.push(
      `Der Betreff ist mit Platzhaltern ${String(draft.subject.trim().length)} Zeichen lang – erlaubt sind höchstens ${String(MAIL_SUBJECT_MAX)}.`,
    );
  }
  if (draft.body.length > MAIL_BODY_MAX) {
    problems.push(
      `Der Text ist mit Platzhaltern ${String(draft.body.length)} Zeichen lang – erlaubt sind höchstens ${String(MAIL_BODY_MAX)}.`,
    );
  }

  if (invalid.length > 0) {
    problems.push(
      `Keine gültige E-Mail-Adresse: ${invalid.join(', ')}. Bitte korrigieren oder entfernen.`,
    );
  }
  // The same check the server applies (`replyToAddressSchema` is literally
  // the `from` of the SMTP block), put before the submission instead of
  // after it — the rule this module already formulates for the recipient
  // line. Without it the server does answer a `Max <max@example.org>`
  // correctly with 400 and `{ path: 'replyTo' }`, but the view shows only
  // `error.detail` („Die Anfrage ist ungültig."), that is, a refusal without a
  // field.
  //
  // Empty is no problem but the inheritance: `toWriteRequest` turns it into
  // `null`, and only a *typed* value is checked.
  const replyTo = trimmedOrNull(draft.replyTo);
  if (replyTo !== null && !replyToAddressSchema.safeParse(replyTo).success) {
    problems.push(
      `Keine gültige Antwortadresse: ${replyTo}. Bitte korrigieren oder das Feld leeren.`,
    );
  }
  if (recipients.length > MAIL_RECIPIENT_LIMIT) {
    problems.push(
      `Höchstens ${String(MAIL_RECIPIENT_LIMIT)} Empfänger je Benachrichtigung.`,
    );
  }
  if (recipients.length === 0) {
    problems.push(
      'Ohne Empfänger geht keine E-Mail heraus: bitte eine Frage wählen oder eine Adresse eintragen.',
    );
  }
  // The server's refusal (`NO_ADDRESS_QUESTION_MESSAGE`), said before the
  // request rather than after it — this is UX, never the boundary
  // (`CONTRIBUTING.md`). Reachable from the client only through a **stale**
  // draft: the chip row itself is not offered without an address question
  // (`hasAddressQuestion` gates it in `NotificationEditor`), but a notification
  // saved while one existed still carries the question id after it was
  // retyped or removed, and `questionRecipients` is read straight off the
  // stored row (`draftOf`) whatever the form looks like now.
  //
  // The second refusal the server used to state alongside this one
  // („E-Mail-Frage wählen") named the gap between a ticked `toSubmitter` box
  // and no chosen chip — a gap that closed with the box itself:
  // `reachesSubmitter` **is** „a chip is chosen", so there is nothing left
  // between the two states to warn about.
  if (reachesSubmitter(draft) && !form.hasAddressQuestion) {
    problems.push(
      'Das Formular hat keine E-Mail-Frage, aus der eine Adresse gelesen werden könnte.',
    );
  }

  return problems;
}

/**
 * The draft as the API takes it.
 *
 * `triggers` is sent verbatim — a non-empty subset of `'submit'`/`'edit'`,
 * `draftProblems` above is what keeps it non-empty before this is ever
 * called. `'save'` never appears in a draft (`draftOf`'s filter), so there is
 * nothing here that could send it even for a row that had it before.
 */
export function toWriteRequest(draft: NotificationDraft): NotificationCreate {
  return {
    name: draft.name.trim(),
    triggers: [...draft.triggers],
    format: draft.format,
    // No `toSubmitter` here — `notificationCreateSchema` no longer has the
    // field. The server derives the same thing from
    // `recipients` (`addressesSubmitter`), which is what `reachesSubmitter`
    // above already computes for the UI; sending it a second time would be a
    // second place for the two to disagree, which is the finding this removal
    // closes.
    recipients: draftRecipients(draft).recipients,
    subject: draft.subject.trim(),
    body: draft.body,
    // Empty means `null` — the inheritance, not the empty string, which
    // `replyToAddressSchema` would refuse with a 400. The same version of
    // "empty means no statement" that three cards of the wire use.
    replyTo: trimmedOrNull(draft.replyTo),
    active: draft.active,
  };
}

/**
 * Whether the draft says anything the stored notification does not.
 *
 * Compared over the **request** the draft would produce, not field by field:
 * „max@example.de,  max@example.de " and „max@example.de" are the same
 * notification, and a save button that lit up for a stray space would teach
 * editors to ignore it. `notification === null` is a brand-new row, which is
 * always worth saving.
 */
export function isDirty(
  notification: Notification | null,
  draft: NotificationDraft,
): boolean {
  if (notification === null) {
    return true;
  }
  return (
    JSON.stringify(toWriteRequest(draft)) !==
    JSON.stringify(toWriteRequest(draftOf(notification)))
  );
}
