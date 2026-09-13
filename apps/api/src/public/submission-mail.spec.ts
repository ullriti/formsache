import {
  MAIL_RECIPIENT_LIMIT,
  type MailTemplateContext,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { parseStoredRecipients } from '../notifications/notification-questions';
import {
  NO_RECIPIENT_PLACEHOLDER,
  UNREADABLE_RECIPIENTS_REASON,
  UNRESOLVED_RECIPIENT_REASON,
  noRecipientReason,
  submissionMails,
  type SubmissionNotification,
} from './submission-mail';

/**
 * The notification policy, exercised where it is written.
 *
 * The behaviour that *matters to an organisation* — switch off, named question, `save`,
 * paused — is proven end to end in `test/public/submission-mail.spec.ts`,
 * because those claims are about what the server does with a real submission.
 * What is left here are the cases an HTTP test cannot produce without writing
 * rows by hand: a recipient list longer than the schema allows, a column this
 * application did not write, and an address that cannot be read out of the
 * answer. Each of them is a row somebody could put in the database — the same
 * reason the `save` trigger has a case at all.
 */

const NAME = '019ffa00-0000-7000-8000-000000000001';
const EMAIL = '019ffa00-0000-7000-8000-000000000002';

function context(email = 'anton@example.org'): MailTemplateContext {
  return {
    formularorganisation: 'Organisation Alpha',
    formular: 'Anmeldung',
    datum: '28.07.2026, 10:00 Uhr MESZ',
    answers: [
      { questionId: NAME, label: 'Name', value: 'Anton Aktiv' },
      { questionId: EMAIL, label: 'E-Mail', value: email },
    ],
    // Nothing changed: this file is about *which* rows a submission produces,
    // and the change block belongs to the edit path (`edit-mail.spec.ts`).
    changes: [],
  };
}

function notification(
  overrides: Partial<SubmissionNotification> = {},
): SubmissionNotification {
  return {
    id: 'n1',
    triggers: ['submit'],
    format: 'html',
    toSubmitter: false,
    recipients: [{ kind: 'literal', address: 'buero@example.org' }],
    subject: 'Anmeldung eingegangen',
    body: 'Danke.',
    // Not set means „what the Organisation or the system prescribes applies"
    //  — `replyToDefaults` hands the default in here.
    replyTo: null,
    active: true,
    ...overrides,
  };
}

/** `count` literal addresses, in the shape the JSONB column stores them. */
function literals(count: number): Prisma.JsonArray {
  return Array.from({ length: count }, (_entry, index) => ({
    kind: 'literal',
    address: `bbr-${String(index)}@example.org`,
  }));
}

describe('submissionMails', () => {
  it('writes one row per recipient, in the order of the list', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [
        notification({
          recipients: [
            { kind: 'literal', address: 'buero@example.org' },
            { kind: 'question', questionId: EMAIL },
          ],
        }),
      ],
      context: context(),
    });

    expect(mails.map((mail) => mail.recipient)).toEqual([
      'buero@example.org',
      'anton@example.org',
    ]);
    expect(mails.every((mail) => mail.status === 'queued')).toBe(true);
  });

  /**
   * **There is no second gate any more** (review finding 24, 2026-08-14).
   *
   * Until then a switch in the form settings stood in front of the
   * participant mail: a configured, active notification to the
   * person filling in still did not go out, and two tests here held
   * exactly that fast. Both are replaced by this one — whoever sets up such a
   * notification has decided that it gets sent; whoever
   * does not want that switches it off (`active`) or deletes it.
   *
   * The migration path („where the switch was off, the notification is
   * off now") had a test of its own until 2026-09-13; it went with the
   * consolidation of the migrations before the first release
   * (`docs/kb/02-data-model.md`), together with the migration it executed.
   */
  it('queues a participant delivery with nothing else to ask', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [
        notification({
          toSubmitter: false,
          recipients: [
            { kind: 'literal', address: 'buero@example.org' },
            { kind: 'question', questionId: EMAIL },
          ],
        }),
      ],
      context: context(),
    });

    expect(mails.map((mail) => mail.recipient)).toEqual([
      'buero@example.org',
      'anton@example.org',
    ]);
  });

  /**
   * An address that cannot be read out of the answer is **reported**, not
   * dropped.
   *
   * The expensive failure of this package is „die Bestätigung wurde nie erzeugt
   * und niemand merkt es". A `failed` row with a reason puts it in the
   * mail log, where somebody looks.
   */
  it('records a failed row for a recipient it cannot resolve', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      // The question is answered with something that is not an address —
      // reachable when a notification points at a question of a *newer*
      // version than the one this answer was written against.
      notifications: [
        notification({ recipients: [{ kind: 'question', questionId: NAME }] }),
      ],
      context: context(),
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      recipient: 'Anton Aktiv',
      status: 'failed',
      lastError: UNRESOLVED_RECIPIENT_REASON,
    });
  });

  /**
   * **A blank optional address leaves a line too** — that is the change this
   * case records.
   *
   * It used to produce nothing at all, and „nothing at all" is the ordinary
   * outcome of the ordinary form: an optional e-mail question the participant
   * skipped. Nothing is wrong with the notification, nothing is wrong with the
   * answer, and the confirmation everybody expects simply does not exist. The
   * reason names the **caption**, because „die Frage 019ffa00-…" is a sentence
   * nobody can act on.
   */
  it('records a failed row for an address question left blank', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [
        notification({ recipients: [{ kind: 'question', questionId: EMAIL }] }),
      ],
      context: context(''),
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      recipient: NO_RECIPIENT_PLACEHOLDER,
      status: 'failed',
      lastError: noRecipientReason(['E-Mail']),
    });
    expect(mails[0]?.lastError).toContain('E-Mail');
  });

  /** A notification with an empty recipient list says so, in its own words. */
  it('records a failed row for a notification with no recipients at all', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [notification({ recipients: [] })],
      context: context(),
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]?.lastError).toBe(noRecipientReason([]));
  });

  /**
   * A recipients column this application did not write sends **nothing** — and
   * leaves a line saying so.
   *
   * Guessing a list would mean delivering to addresses the notification editor
   * refuses to display, so the repair would have no place to happen. Silence
   * about the *event* was the other half of the problem: an unreadable column
   * was the one state in which „es ging keine Mail raus" had no trace at all.
   */
  it('records a failed row when the stored recipients do not parse', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [
        notification({ recipients: { to: 'buero@example.org' } }),
      ],
      context: context(),
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      recipient: NO_RECIPIENT_PLACEHOLDER,
      status: 'failed',
      lastError: UNREADABLE_RECIPIENTS_REASON,
    });
  });

  it('renders the subject against the answer', () => {
    const mails = submissionMails({
      trigger: 'submit',
      replyToDefaults: [],
      notifications: [
        notification({ subject: `Anmeldung von {{frage:${NAME}}}` }),
      ],
      context: context(),
    });

    expect(mails[0]?.subject).toBe('Anmeldung von Anton Aktiv');
  });

  /**
   * **How many `mail_log` lines one notification of one public submission may
   * write** .
   *
   * The number used to be twenty *per list*: valid entries and rejected ones
   * were capped separately, so the documented twenty was forty rows in
   * practice — and forty is the number that matters, because it is how many
   * lines one submission writes and how many deliveries an organisation pays for.
   */
  describe('the recipient budget', () => {
    /**
     * The bound sits on the way **in**, where it can still be explained.
     *
     * `notificationCreateSchema` bounds a *request*; this is what the send path
     * reads a row back through, and a row with two hundred recipients can be
     * put into the database without any request schema seeing it. Refused
     * rather than silently shortened — shortening would hide *which* addresses
     * were dropped, and the notification editor would go on showing all of them.
     */
    it('refuses to read a stored list longer than the limit', () => {
      expect(
        parseStoredRecipients(literals(MAIL_RECIPIENT_LIMIT)),
      ).toHaveLength(MAIL_RECIPIENT_LIMIT);
      expect(parseStoredRecipients(literals(MAIL_RECIPIENT_LIMIT + 1))).toBe(
        null,
      );
    });

    /** …so an over-long list leaves one readable line, not twenty-one. */
    it('leaves a single failed line for an over-long stored list', () => {
      const mails = submissionMails({
        trigger: 'submit',
        replyToDefaults: [],
        notifications: [
          notification({ recipients: literals(MAIL_RECIPIENT_LIMIT + 5) }),
        ],
        context: context(),
      });

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({
        recipient: NO_RECIPIENT_PLACEHOLDER,
        status: 'failed',
        lastError: UNREADABLE_RECIPIENTS_REASON,
      });
    });

    /**
     * A full list of mixed quality stays at the limit **in total**.
     *
     * Twenty entries, two of which resolve to something that is not an address:
     * eighteen `queued` lines and two `failed` ones — twenty rows, not
     * twenty-two and not forty. With the two `slice`s the old code applied, a
     * list of twenty valid and twenty rejected entries produced forty; that
     * exact list can no longer be stored (see above), so the property is
     * asserted here at the largest list that can.
     *
     * The rejected two are **question** recipients, and they have to be: a
     * literal address is validated by `notificationRecipientSchema` itself, so
     * an unusable literal never gets past the parse. What lands in `invalid` is
     * always a value that came out of an answer.
     */
    it('spends one budget across valid and rejected entries together', () => {
      const stored = [
        ...literals(MAIL_RECIPIENT_LIMIT - 2),
        // Answered „Anton Aktiv" — one entry, one rejection, never two
        // recipients (`resolveRecipients`).
        { kind: 'question', questionId: NAME },
        { kind: 'question', questionId: NAME },
      ];

      const mails = submissionMails({
        trigger: 'submit',
        replyToDefaults: [],
        notifications: [notification({ recipients: stored })],
        context: context(),
      });

      expect(mails).toHaveLength(MAIL_RECIPIENT_LIMIT);
      expect(mails.filter((mail) => mail.status === 'queued')).toHaveLength(
        MAIL_RECIPIENT_LIMIT - 2,
      );
      expect(mails.filter((mail) => mail.status === 'failed')).toHaveLength(2);
    });
  });
});
