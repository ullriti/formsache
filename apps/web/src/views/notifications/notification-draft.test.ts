import {
  MAIL_BODY_MAX,
  MAIL_RECIPIENT_LIMIT,
  MAIL_SUBJECT_MAX,
  questionPlaceholderToken,
  type Notification,
  type NotificationTemplate,
  type Question,
} from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  applyTemplate,
  draftOf,
  draftProblems,
  draftRecipients,
  emptyDraft,
  isDirty,
  reachesSubmitter,
  toWriteRequest,
} from './notification-draft';

/**
 * The editor's draft as pure data — no DOM, no server.
 *
 * The interesting cases are the ones where a wrong answer would produce a mail:
 * an address that is not one, an entry that must not become two recipients, and
 * the „an die ausfüllende Person" marker without a question behind it.
 */

const QUESTION_ID = '019fe700-0000-7000-8000-0000000000aa';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: '019fe700-0000-7000-8000-000000000001',
    formId: '019fe700-0000-7000-8000-000000000002',
    name: 'Bestätigung',
    triggers: ['submit'],
    format: 'html',
    toSubmitter: true,
    recipients: [
      { kind: 'question', questionId: QUESTION_ID },
      { kind: 'literal', address: 'buero@example.de' },
    ],
    subject: 'Anmeldung {{formular}}',
    body: 'Danke, {{frage:019fe700-0000-7000-8000-0000000000aa}}',
    replyTo: null,
    effectiveReplyTo: { address: null, origin: null },
    active: true,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('draftOf / toWriteRequest', () => {
  it('splits the stored recipients into the two inputs and back', () => {
    const draft = draftOf(notification());

    expect(draft.questionRecipients).toEqual([QUESTION_ID]);
    expect(draft.literalRecipients).toBe('buero@example.de');
    // Round trip: what goes back out is what came in.
    expect(toWriteRequest(draft).recipients).toEqual(notification().recipients);
  });

  it('defaults a new draft to „submit" — „save" is absent, not disabled', () => {
    expect(toWriteRequest(emptyDraft()).triggers).toEqual(['submit']);
  });

  it('round-trips both triggers of a stored notification', () => {
    const draft = draftOf(notification({ triggers: ['submit', 'edit'] }));

    expect(draft.triggers).toEqual(['submit', 'edit']);
    expect(toWriteRequest(draft).triggers).toEqual(['submit', 'edit']);
  });

  /**
   * `notificationSchema` reads the wide enum and can hand back a row with
   * `'save'` in it — one written straight into the database, the very
   * fixture that non-goal is proven with. The editor has no box for it, so
   * it drops out of the draft rather than being silently kept and re-sent.
   */
  it('drops a trigger the editor has no box for, opening a row that carries „save"', () => {
    const draft = draftOf(notification({ triggers: ['save'] }));

    expect(draft.triggers).toEqual([]);
  });

  /**
   * The requirement: a question recipient **is** participant delivery — the
   * server's own derivation (`addressesSubmitter`) reads exactly this off
   * `recipients`, so the client has to agree about which draft counts as one.
   */
  it('marks a draft with a question recipient as participant delivery', () => {
    const draft = { ...emptyDraft(), questionRecipients: [QUESTION_ID] };

    expect(reachesSubmitter(draft)).toBe(true);
  });

  it('leaves a draft that only has fixed addresses alone', () => {
    const draft = { ...emptyDraft(), literalRecipients: 'buero@example.de' };

    expect(reachesSubmitter(draft)).toBe(false);
  });

  /**
   * There is no separate flag any more to set independently of
   * the chips — `toSubmitter` is not even a key `NotificationDraft` has. This
   * is the *reproduction* the work item asks for in code: picking a question
   * chip is the only way to reach `reachesSubmitter === true`, and nothing
   * else needs to be set alongside it.
   */
  it('has no separate flag — a chosen question is the whole statement', () => {
    expect('toSubmitter' in emptyDraft()).toBe(false);
    expect(
      reachesSubmitter({ ...emptyDraft(), questionRecipients: [QUESTION_ID] }),
    ).toBe(true);
  });

  /**
   * `toWriteRequest`'s output never carries `toSubmitter` — `NotificationCreate`
   * no longer has the field to carry it in, so a request built from a draft
   * with a chosen question still cannot set it, whatever the draft says.
   */
  it('never sends toSubmitter — the server derives it from recipients', () => {
    const draft = { ...emptyDraft(), questionRecipients: [QUESTION_ID] };

    expect('toSubmitter' in toWriteRequest(draft)).toBe(false);
  });
});

describe('draftRecipients', () => {
  /**
   * The requirement no. 3: one entry is one recipient or none — never two. The
   * form is public, so „Max <evil@example.com>" is a thing that gets typed.
   */
  it('rejects an entry that is not an address instead of splitting it', () => {
    const draft = {
      ...emptyDraft(),
      literalRecipients: 'Max <evil@example.com>, ok@example.de',
    };
    const { recipients, invalid } = draftRecipients(draft);

    expect(invalid).toEqual(['Max <evil@example.com>']);
    // The count is the assertion that matters: exactly one address survived.
    expect(recipients).toEqual([{ kind: 'literal', address: 'ok@example.de' }]);
  });

  it('de-duplicates the same address written twice', () => {
    const draft = {
      ...emptyDraft(),
      literalRecipients: 'a@example.de, A@example.de',
    };

    expect(draftRecipients(draft).recipients).toHaveLength(1);
  });
});

/** A text question with a short, convertible caption — for the length/caption tests below. */
function textQuestion(id: string, label: string): Question {
  return {
    id,
    type: 'text',
    label,
    hint: null,
    required: false,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

const VORNAME_ID = '019fe700-0000-7000-8000-0000000000ee';

describe('draftProblems', () => {
  const form = { hasAddressQuestion: true, questions: [] as Question[] };

  it('accepts a complete draft', () => {
    expect(draftProblems(draftOf(notification()), form)).toEqual([]);
  });

  it('names a missing subject and a missing name', () => {
    const problems = draftProblems(
      { ...draftOf(notification()), name: '  ', subject: '' },
      form,
    );

    expect(problems.some((text) => text.includes('Namen'))).toBe(true);
    expect(problems.some((text) => text.includes('Betreff'))).toBe(true);
  });

  /**
   * The API's own `.min(1)` on `triggers`, said before the request.
   * *Reproduction*: delete
   * this check from `draftProblems` and the case goes red — nothing else in
   * this file would catch an empty `triggers` array.
   */
  it('refuses a notification with no trigger checked at all', () => {
    const problems = draftProblems(
      { ...draftOf(notification()), triggers: [] },
      form,
    );

    expect(problems.some((text) => text.includes('Auslöser'))).toBe(true);
  });

  it('accepts a draft with only „Bei Bearbeitung" checked', () => {
    const problems = draftProblems(
      { ...draftOf(notification()), triggers: ['edit'] },
      form,
    );

    expect(problems.some((text) => text.includes('Auslöser'))).toBe(false);
  });

  it('refuses a notification without any recipient', () => {
    const problems = draftProblems(
      {
        ...emptyDraft(),
        name: 'Test',
        subject: 'Test',
      },
      form,
    );

    expect(problems.some((text) => text.includes('Ohne Empfänger'))).toBe(true);
  });

  it('shows the rejected address back instead of dropping it', () => {
    const problems = draftProblems(
      {
        ...draftOf(notification()),
        literalRecipients: 'kein-komma-adresse',
      },
      form,
    );

    expect(problems.join(' ')).toContain('kein-komma-adresse');
  });

  it('holds the recipient limit of the shared contract', () => {
    const addresses = Array.from(
      { length: MAIL_RECIPIENT_LIMIT + 1 },
      (_value, index) => `person${String(index)}@example.de`,
    ).join(', ');

    const problems = draftProblems(
      { ...draftOf(notification()), literalRecipients: addresses },
      form,
    );

    expect(
      problems.some((text) => text.includes(String(MAIL_RECIPIENT_LIMIT))),
    ).toBe(true);
  });

  /**
   * The server's refusal, said before the request — reachable here only
   * through a **stale** draft: a notification saved while an e-mail question
   * existed still carries its id after the question was retyped or removed
   * (`questionRecipients` is read straight off the stored row, `draftOf`).
   *
   * There used to be a second, sibling refusal here — „bitte die E-Mail-Frage
   * wählen", for a ticked `toSubmitter` box with no chip chosen. That gap
   * closed with the box itself: `reachesSubmitter` **is**
   * „a chip is chosen", so a draft can no longer say „an die ausfüllende
   * Person" without a question behind it, and there is nothing left for that
   * message to describe.
   */
  it('says a form without an e-mail question cannot deliver to the participant', () => {
    const problems = draftProblems(draftOf(notification()), {
      hasAddressQuestion: false,
      questions: [],
    });

    expect(problems.join(' ')).toContain('keine E-Mail-Frage');
  });

  /**
   * a review finding: a caption `toStorageForm` had nothing to turn into an id
   * (typed by hand, or naming a question that never existed) sits verbatim
   * in what the rest of the application treats as storage form —
   * `unknownPlaceholders` cannot see it either (module comment,
   * `mail-placeholder-display.ts`). Blocking the save, naming the caption,
   * is the only place left that can catch it before a mail goes out with
   * the raw `{{frage:…}}` text in it.
   */
  it('blocks a draft carrying a caption that names no question', () => {
    const problems = draftProblems(
      {
        ...draftOf(notification()),
        subject: 'Anmeldung {{frage:Name des Mitglieds}}',
      },
      form,
    );

    expect(
      problems.some((text) => text.includes('{{frage:Name des Mitglieds}}')),
    ).toBe(true);
  });

  it('does not block a caption that resolves to a real question', () => {
    const problems = draftProblems(
      {
        ...draftOf(notification()),
        subject: 'Anmeldung {{frage:Vorname}}',
      },
      {
        hasAddressQuestion: true,
        questions: [textQuestion(VORNAME_ID, 'Vorname')],
      },
    );

    expect(
      problems.some((text) => text.includes('zeigt auf keine Frage')),
    ).toBe(false);
  });

  /**
   * a review finding: `maxLength` on the editor's field bounds the *displayed*
   * caption, the server bounds the *stored* form — and a placeholder's
   * stored form is longer. A subject that stays well under
   * `MAIL_SUBJECT_MAX` as a caption can already be over it once stored.
   */
  it('blocks a subject that is short as a caption but too long once stored', () => {
    const displayToken = '{{frage:Vorname}}'; // 17 characters
    const storedToken = questionPlaceholderToken(VORNAME_ID); // 46 characters
    const repeats = 12;
    const displaySubject = displayToken.repeat(repeats);
    const storedSubject = storedToken.repeat(repeats);
    expect(displaySubject.length).toBeLessThan(MAIL_SUBJECT_MAX);
    expect(storedSubject.length).toBeGreaterThan(MAIL_SUBJECT_MAX);

    const problems = draftProblems(
      { ...draftOf(notification()), subject: storedSubject },
      {
        hasAddressQuestion: true,
        questions: [textQuestion(VORNAME_ID, 'Vorname')],
      },
    );

    expect(
      problems.some((text) => text.includes(String(MAIL_SUBJECT_MAX))),
    ).toBe(true);
  });

  it('accepts a stored subject at or under the limit', () => {
    const problems = draftProblems(
      { ...draftOf(notification()), subject: 'x'.repeat(MAIL_SUBJECT_MAX) },
      form,
    );

    expect(
      problems.some((text) => text.includes(String(MAIL_SUBJECT_MAX))),
    ).toBe(false);
  });

  it('blocks a stored body over the limit', () => {
    const problems = draftProblems(
      { ...draftOf(notification()), body: 'x'.repeat(MAIL_BODY_MAX + 1) },
      form,
    );

    expect(problems.some((text) => text.includes(String(MAIL_BODY_MAX)))).toBe(
      true,
    );
  });
});

/**
 * The reply address per notification — the
 * topmost level of the chain.
 *
 * What becomes of it in the sent header is measured by
 * `apps/api/test/mail/reply-to.spec.ts` against a real SMTP server; here
 * stands the one rule the draft itself carries: **empty is `null`, not
 * the empty string.**
 */
describe('die Antwortadresse im Entwurf ', () => {
  it('starts empty on a new notification — that is the inheritance', () => {
    expect(emptyDraft().replyTo).toBe('');
    expect(toWriteRequest(emptyDraft()).replyTo).toBeNull();
  });

  it('sends null for a cleared field, never the empty string', () => {
    // `replyToAddressSchema` demands an address; `''` would be a 400 for
    // a save that meant „the default is to apply".
    expect(
      toWriteRequest({ ...emptyDraft(), replyTo: '   ' }).replyTo,
    ).toBeNull();
  });

  it('trims what was typed and carries it through', () => {
    expect(
      toWriteRequest({ ...emptyDraft(), replyTo: ' bt@example.org ' }).replyTo,
    ).toBe('bt@example.org');
  });

  it('opens a stored value for editing, and a stored null as empty', () => {
    expect(draftOf(notification({ replyTo: 'bt@example.org' })).replyTo).toBe(
      'bt@example.org',
    );
    expect(draftOf(notification({ replyTo: null })).replyTo).toBe('');
  });

  /**
   * **Checked before sending, not afterwards** (a review finding of the
   * Reply-To review) — the rule this module already states for the recipient
   * line: „a 400 the person saving cannot read is not a
   * state this form should let through."
   *
   * Without this check the server answers `Max <max@example.org>`
   * correctly with a 400 and `{ path: 'replyTo' }`, but the view shows only
   * `error.detail` — „Die Anfrage ist ungültig." without any reference to a field.
   *
   * *Reproduction, measured (2026-08-04):* remove the check from `draftProblems`
   * — this case turns red, nothing else.
   */
  it('blocks the save on a value the server would refuse, naming the field', () => {
    const form = { hasAddressQuestion: true, questions: [] as Question[] };

    for (const bad of [
      'Max <max@example.org>',
      'a@example.org, b@example.org',
      'kein-at-zeichen',
    ]) {
      const problems = draftProblems(
        { ...draftOf(notification()), replyTo: bad },
        form,
      );

      expect(
        problems.some((text) => text.includes('Antwortadresse')),
        bad,
      ).toBe(true);
    }
  });

  it('lets a blank field and a usable address through — both are savable', () => {
    const form = { hasAddressQuestion: true, questions: [] as Question[] };

    expect(
      draftProblems({ ...draftOf(notification()), replyTo: '  ' }, form),
    ).toEqual([]);
    expect(
      draftProblems(
        { ...draftOf(notification()), replyTo: ' bt@example.org ' },
        form,
      ),
    ).toEqual([]);
  });
});

describe('isDirty', () => {
  it('is false for an untouched draft', () => {
    expect(isDirty(notification(), draftOf(notification()))).toBe(false);
  });

  it('ignores whitespace that changes nothing about the mail', () => {
    const draft = draftOf(notification());

    expect(
      isDirty(notification(), {
        ...draft,
        literalRecipients: ' buero@example.de , ',
      }),
    ).toBe(false);
  });

  it('sees a changed subject', () => {
    const draft = draftOf(notification());

    expect(isDirty(notification(), { ...draft, subject: 'Anders' })).toBe(true);
  });

  it('treats an unsaved notification as dirty', () => {
    expect(isDirty(null, emptyDraft())).toBe(true);
  });
});

describe('applyTemplate', () => {
  /**
   * An invented template, not a shipped one.
   *
   * What is under test is the merge rule — which fields a click may overwrite —
   * and that rule holds for whatever the installation happens to offer.
   * The templates are a system setting the superadmin edits, so a test
   * reading the shipped floor would be checking this function against text that
   * is not what the editor will see anyway.
   */
  const template: NotificationTemplate = {
    id: 'fixture',
    name: 'Vorlagenname',
    description: 'Wofür diese Vorlage gedacht ist.',
    triggers: ['submit', 'edit'],
    format: 'text',
    subject: 'Vorlagenbetreff',
    body: 'Vorlagentext',
    toSubmitter: false,
  };

  it('fills a fresh draft entirely, as before', () => {
    const applied = applyTemplate(emptyDraft(), template);

    expect(applied.name).toBe(template.name);
    expect(applied.subject).toBe(template.subject);
    expect(applied.body).toBe(template.body);
    expect(applied.triggers).toEqual(template.triggers);
    expect(applied.format).toBe(template.format);
  });

  /**
   * a review finding of the 2026-07-28 review: name and subject are routinely typed
   * *before* the template row ever appears (module note 4,
   * `NotificationEditor`), because its visibility only gates the body. A
   * click there must not be able to destroy them.
   *
   * *Reproduction:* the per-field `emptyDraft()` checks in `applyTemplate`
   * reverted to the old unconditional assignment → this case turns red.
   */
  it('keeps a name and a subject that were already typed', () => {
    const draft = {
      ...emptyDraft(),
      name: 'Eigener Name',
      subject: 'Eigener Betreff',
    };

    const applied = applyTemplate(draft, template);

    expect(applied.name).toBe('Eigener Name');
    expect(applied.subject).toBe('Eigener Betreff');
    // The body was still empty — that field is filled exactly as before.
    expect(applied.body).toBe(template.body);
  });

  it('keeps triggers and format that were already changed', () => {
    const draft = {
      ...emptyDraft(),
      triggers: ['edit'] as const,
      format: 'text' as const,
    };
    // The template must want *something else* in both fields, or the assertion
    // below would be green for a function that overwrites them.
    const other: NotificationTemplate = {
      ...template,
      triggers: ['submit'],
      format: 'html',
    };

    const applied = applyTemplate(draft, other);

    expect(applied.triggers).toEqual(['edit']);
    expect(applied.format).toBe('text');
  });
});
