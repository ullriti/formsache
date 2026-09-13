import type { ReactElement } from 'react';
import type { FormDefinition, Notification } from '@formsache/shared';

import { NotificationPreview } from '../notifications/NotificationPreview';
import { runContext } from './run-context';

/**
 * **The test run** : it sends nothing, it
 * shows *what* would be sent.
 *
 * ## Where the boundary to the test mail runs
 *
 * Concept no. 35 describes **two** things, and whoever reads them as one
 * paragraph builds too much or too little:
 *
 * - The **test mail** really sends — *one* named mail, to the
 *   address of the triggering person, via queue, SMTP and `mail_log`. It is
 * built and stands where the dispatch path is configured:
 *   tenant administration → Mailversand (`MailIdentityCard`). Here it does
 *   **not** stand a second time — a second button that really sends would be a
 *   second way to turn a trial run into a dispatch, and
 *   irrevocability tolerates no two ways.
 * - The **test run** is this area: a list of what would go out on a
 *   real submission, each with a preview of the mail — recipients,
 *   subject and text, **with the values of the trial run** instead of with
 *   example placeholders (`run-context.ts`).
 *
 * The sentence below says both: what has not happened here, and where the one
 * button stands that really puts a mail into a mailbox.
 *
 * ## Why no call to the server
 *
 * Nothing in this area asks a route. That is not convenience,
 * but the proof: a route that "carries out a trial run" would be a
 * route that knows a write path and does *not* take it — and the day on
 * which somebody flips the condition is the day on which a trial run creates a
 * registration. What the test mode can do, it can do without a write path: the
 * template stands in the form, the value stands on the screen, and rendering
 * is done with the same function with which the server renders
 * (`renderMailTemplate`).
 */
export interface TestRunPanelProps {
  readonly definition: FormDefinition;
  readonly formTitle: string;
  readonly tenantName: string;
  /** The answers with which the trial run ran. */
  readonly answers: Readonly<Record<string, unknown>>;
  /**
   * The form's notifications, or `undefined` as long as they could not be
   * read — the list needs `canManageFormSettings`
   * (ADR-0021), the test mode itself only `canBuild`.
   */
  readonly notifications: readonly Notification[] | undefined;
  /** Why the list is missing, when it is missing — in German, for the screen. */
  readonly notificationsNote: string | null;
}

/**
 * The date that `{{datum}}` inserts in the trial run.
 *
 * **Fixed, not "today"**: "same form, same values" (* third boundary) holds for everything the trial run shows, and a date from
 * `Date.now()` would make two screenshots of the same form incomparable.
 * It is recognizably an example and is named as such.
 */
const RUN_DATE = '01.03.2026';

export function TestRunPanel({
  definition,
  formTitle,
  tenantName,
  answers,
  notifications,
  notificationsNote,
}: TestRunPanelProps): ReactElement {
  const context = runContext({
    definition,
    tenantName,
    formTitle,
    answers,
    datum: RUN_DATE,
  });

  /*
   * What would go out on a **submission** — `submit`, not `edit` and not
   * `save`. A trial run is a submission; `edit` only fires when somebody
   * changes an already submitted response via the edit link, and
   * `save` does not fire at all (`notificationTriggerSchema`).
   * `active` is the switch with which an organization lets a notification rest
   * without deleting it — showing a resting one here would mean announcing a
   * dispatch that does not exist.
   */
  const firing = (notifications ?? []).filter(
    (notification) =>
      notification.active && notification.triggers.includes('submit'),
  );

  return (
    <section className="preview__run" aria-label="Testlauf">
      {/*
        „Testlauf: was verschickt würde" stood here until finding 23 — a
        colon, behind which a subordinate clause began without a main clause, and a
        subjunctive that, while reading, first had to be assigned to a verb that
        stands nowhere. The sentence now is a whole one: the em dash
        separates the heading from its explanation instead of hanging them
        together grammatically.
      */}
      <h2 className="preview__run-title">
        Testlauf — diese E-Mails würden verschickt
      </h2>

      {/*
        `role="status"` and not `role="alert"`: nothing has gone wrong,
        this is the state after a successful action. The sentence is the
        assurance in words — that is checked against the number of
        rows, not against the assertion itself.
      */}
      <p className="preview__run-note" role="status" data-testid="run-nothing">
        Es wurde nichts gespeichert und nichts versendet: keine Antwort, keine
        E-Mail, keine belegten Plätze. Unten steht, was bei einer echten
        Absendung hinausginge – mit den Werten dieses Probelaufs.
      </p>

      {notificationsNote === null ? null : (
        <p className="preview__run-note" role="status">
          {notificationsNote}
        </p>
      )}

      {notifications !== undefined && firing.length === 0 ? (
        <p className="preview__run-empty">
          Bei einer echten Absendung ginge keine E-Mail hinaus – dieses Formular
          hat keine aktive Benachrichtigung mit dem Auslöser „Bei Absendung".
        </p>
      ) : null}

      {firing.map((notification) => (
        <article className="preview__run-mail" key={notification.id}>
          <h3 className="preview__run-mail-name">{notification.name}</h3>
          <NotificationPreview
            subject={notification.subject}
            body={notification.body}
            format={notification.format}
            recipients={notification.recipients}
            context={context}
            toSubmitter={notification.toSubmitter}
            heading="E-Mail-Vorschau"
            note={
              <>
                Mit den Werten dieses Probelaufs – nichts davon wurde versendet.
                Der Bearbeiten-Link ist ein Beispiel; die echte Adresse entsteht
                erst, wenn eine Antwort wirklich gespeichert wird.
              </>
            }
          />
        </article>
      ))}

      {/*
        The one button that really sends — named, but not fetched
        over here. A preview does not answer whether a mail *arrives*
        (spam filter, HTML in a foreign mailbox, sender), and for that the test mail exists at exactly one place.
      */}
      <p className="preview__run-footnote">
        Ob eine E-Mail auch wirklich ankommt, beantwortet keine Vorschau. Dafür
        gibt es „Testmail senden" in der Organisations-Verwaltung unter
        „Mailversand": sie geht den echten Weg und an die eigene Adresse.
      </p>
    </section>
  );
}
