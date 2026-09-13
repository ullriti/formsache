import { describe, expect, it } from 'vitest';

import {
  MAIL_LOG_RETENTION_DAYS,
  MAIL_MAX_ATTEMPTS,
  MAIL_RECIPIENT_LIMIT,
  QUESTION_PLACEHOLDER_PREFIX,
  SYSTEM_PLACEHOLDERS,
  classifyPlaceholder,
  mailLogDetailSchema,
  mailLogEntrySchema,
  mailLogFilterSchema,
  mailLogListResponseSchema,
  notificationCreateSchema,
  notificationQuestionIds,
  notificationRecipientSchema,
  notificationSchema,
  notificationUpdateSchema,
  placeholderPattern,
  questionPlaceholderIds,
  questionPlaceholderToken,
  recipientQuestionIds,
  rewriteQuestionPlaceholders,
  rewriteRecipientQuestionIds,
  scanPlaceholders,
  systemPlaceholderToken,
} from './mail.ts';

const QUESTION_ID = '019ff500-0000-7000-8000-0000000000c1';
const OTHER_QUESTION_ID = '019ff500-0000-7000-8000-0000000000c2';
const EMAIL_QUESTION_ID = '019ff500-0000-7000-8000-0000000000c3';

describe('placeholder grammar', () => {
  it('knows exactly six system placeholders', () => {
    expect([...SYSTEM_PLACEHOLDERS]).toEqual([
      'formularorganisation',
      'formular',
      'datum',
      'antworten',
      // The sixth: what an edit changed. Its content is
      // built at the enqueue, because the previous values stop existing the
      // moment the answer is written (`notification-render.ts`).
      'aenderungen',
      'bearbeiten',
    ]);
  });

  it('has no {{vorname}}, {{nachname}} or {{email}} — those point at questions', () => {
    // The specification replaced them: a placeholder refers to a *question* id, not to
    // a caption somebody guessed. If this fails because the list grew, the
    // question to answer first is which form's „Vorname" was meant.
    for (const name of ['vorname', 'nachname', 'email']) {
      expect(SYSTEM_PLACEHOLDERS as readonly string[]).not.toContain(name);
    }
  });

  /**
   * The rule this guards is the *absence* of three names:
   * everything personal is a question placeholder, never a guessed caption.
   * Adding `vorname` to the list makes this red — which is the point, because
   * the wording of the requirement still invites exactly that.
   */
  it.each(['vorname', 'nachname', 'email'])(
    'treats the guessed label {{%s}} as unknown, not as a system placeholder',
    (name) => {
      expect(classifyPlaceholder(name)).toEqual({ kind: 'unknown', name });
    },
  );

  it('reads a question placeholder as its question id', () => {
    expect(
      classifyPlaceholder(`${QUESTION_PLACEHOLDER_PREFIX}${QUESTION_ID}`),
    ).toEqual({ kind: 'question', questionId: QUESTION_ID });
  });

  it('treats a question placeholder without an id as unknown', () => {
    expect(classifyPlaceholder(QUESTION_PLACEHOLDER_PREFIX)).toEqual({
      kind: 'unknown',
      name: QUESTION_PLACEHOLDER_PREFIX,
    });
  });

  it('tolerates whitespace inside the braces', () => {
    const [match] = scanPlaceholders('Hallo {{ formularorganisation }}!');
    expect(match?.placeholder).toEqual({
      kind: 'system',
      name: 'formularorganisation',
    });
    expect(match?.raw).toBe('{{ formularorganisation }}');
  });

  it('reports where each token sits, in order', () => {
    const text = `A {{formularorganisation}} B ${questionPlaceholderToken(QUESTION_ID)}`;
    const matches = scanPlaceholders(text);
    expect(matches).toHaveLength(2);
    expect(text.slice(matches[0]?.start, matches[0]?.end)).toBe(
      '{{formularorganisation}}',
    );
    expect(text.slice(matches[1]?.start, matches[1]?.end)).toBe(
      questionPlaceholderToken(QUESTION_ID),
    );
  });

  /**
   * A plain regression guard, and **not** the reproduction for the `lastIndex`
   * trap — measured, not assumed. Turning {@link placeholderPattern} into a
   * module-scope constant leaves this one green, because `String.matchAll`
   * copies the regular expression before it iterates. Two equally wrong scans
   * also compare equal, which is the second reason the shape below is the one
   * that bites.
   */
  it('scans the same text twice with the same result', () => {
    const text = '{{formularorganisation}} {{formular}} {{datum}}';
    expect(scanPlaceholders(text)).toEqual(scanPlaceholders(text));
    expect(scanPlaceholders(text)).toHaveLength(3);
  });

  /**
   * **This** is the reproduction. A module-scope `RegExp` with `g` carries its
   * `lastIndex` between callers, so one consumer's `exec()` decides where the
   * next one starts. Turning {@link placeholderPattern} into an exported
   * constant makes this red — and takes two further tests in this file with it,
   * because the polluted index then reaches `matchAll` through the copy it
   * makes.
   */
  it('hands out a fresh regular expression on every call', () => {
    const first = placeholderPattern();
    first.exec('{{formularorganisation}} {{datum}}');
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(placeholderPattern().lastIndex).toBe(0);
  });

  it('collects question ids without duplicates and ignores system ones', () => {
    const text = [
      questionPlaceholderToken(QUESTION_ID),
      '{{formularorganisation}}',
      questionPlaceholderToken(QUESTION_ID),
      questionPlaceholderToken(OTHER_QUESTION_ID),
    ].join(' ');
    expect(questionPlaceholderIds(text)).toEqual([
      QUESTION_ID,
      OTHER_QUESTION_ID,
    ]);
  });

  /** A duplicated form's mail template. */
  describe('rewriteQuestionPlaceholders', () => {
    it('rewrites every question placeholder named in the map', () => {
      const text = `Hallo ${questionPlaceholderToken(QUESTION_ID)}, ${questionPlaceholderToken(OTHER_QUESTION_ID)}!`;
      const idMap = new Map([
        [QUESTION_ID, 'new-1'],
        [OTHER_QUESTION_ID, 'new-2'],
      ]);

      expect(rewriteQuestionPlaceholders(text, idMap)).toBe(
        `Hallo ${questionPlaceholderToken('new-1')}, ${questionPlaceholderToken('new-2')}!`,
      );
    });

    it('leaves a placeholder whose id is not in the map exactly as written', () => {
      const text = questionPlaceholderToken(QUESTION_ID);
      expect(rewriteQuestionPlaceholders(text, new Map())).toBe(text);
    });

    it('leaves system and unknown placeholders untouched', () => {
      const text = '{{formularorganisation}} {{vorname}}';
      const idMap = new Map([[QUESTION_ID, 'new-1']]);
      expect(rewriteQuestionPlaceholders(text, idMap)).toBe(text);
    });

    it('rewrites several occurrences of the same placeholder without corrupting positions', () => {
      const token = questionPlaceholderToken(QUESTION_ID);
      const text = `${token} in der Mitte ${token} und am Ende ${token}`;
      const idMap = new Map([[QUESTION_ID, 'new-1']]);
      const rewritten = questionPlaceholderToken('new-1');

      expect(rewriteQuestionPlaceholders(text, idMap)).toBe(
        `${rewritten} in der Mitte ${rewritten} und am Ende ${rewritten}`,
      );
    });
  });

  it('spells the system token the scanner understands', () => {
    expect(systemPlaceholderToken('antworten')).toBe('{{antworten}}');
    expect(scanPlaceholders(systemPlaceholderToken('antworten'))).toHaveLength(
      1,
    );
  });

  it('builds a question placeholder from an id, not from a caption', () => {
    expect(questionPlaceholderToken(QUESTION_ID)).toBe(
      `{{${QUESTION_PLACEHOLDER_PREFIX}${QUESTION_ID}}}`,
    );
  });

  it('classifies system, question and unknown placeholders with their position', () => {
    const text = `Hallo {{formularorganisation}} — ${questionPlaceholderToken(QUESTION_ID)} / {{vorname}}`;
    const matches = scanPlaceholders(text);

    expect(matches.map((match) => match.placeholder.kind)).toEqual([
      'system',
      'question',
      'unknown',
    ]);
    expect(matches[1]?.placeholder).toEqual({
      kind: 'question',
      questionId: QUESTION_ID,
    });
    expect(matches[2]?.raw).toBe('{{vorname}}');

    const second = matches[1];
    if (second === undefined) {
      throw new Error('expected a second placeholder');
    }
    // The preview marks by position; an off-by-one here would highlight the
    // wrong span.
    expect(text.slice(second.start, second.end)).toBe(
      questionPlaceholderToken(QUESTION_ID),
    );
  });
});

describe('recipients', () => {
  it('accepts a literal address', () => {
    expect(
      notificationRecipientSchema.parse({
        kind: 'literal',
        address: 'buero@example.org',
      }),
    ).toEqual({ kind: 'literal', address: 'buero@example.org' });
  });

  /**
   * At the schema level: one entry can never become two
   * recipients, and a display name carrying angle brackets is refused rather
   * than silently dropped.
   */
  it.each([
    'Max <evil@example.com>',
    'buero@example.org, evil@example.com',
    'buero@example.org\nBcc: evil@example.com',
    'buero@example.org\r\nBcc: evil@example.com',
    'not-an-address',
  ])('refuses %j as a literal address', (address) => {
    expect(
      notificationRecipientSchema.safeParse({ kind: 'literal', address })
        .success,
    ).toBe(false);
  });

  it('refuses a question recipient that names no question', () => {
    expect(
      notificationRecipientSchema.safeParse({
        kind: 'question',
        questionId: '',
      }).success,
    ).toBe(false);
  });

  it('collects the question ids of a recipient list', () => {
    expect(
      recipientQuestionIds([
        { kind: 'question', questionId: QUESTION_ID },
        { kind: 'literal', address: 'buero@example.org' },
        { kind: 'question', questionId: QUESTION_ID },
      ]),
    ).toEqual([QUESTION_ID]);
  });

  /** The recipients' half of a duplicated form. */
  describe('rewriteRecipientQuestionIds', () => {
    it('rewrites a question recipient named in the map', () => {
      const idMap = new Map([[QUESTION_ID, 'new-1']]);
      expect(
        rewriteRecipientQuestionIds(
          [{ kind: 'question', questionId: QUESTION_ID }],
          idMap,
        ),
      ).toEqual([{ kind: 'question', questionId: 'new-1' }]);
    });

    it('leaves a literal recipient untouched', () => {
      const literal = {
        kind: 'literal',
        address: 'buero@example.org',
      } as const;
      expect(rewriteRecipientQuestionIds([literal], new Map())).toEqual([
        literal,
      ]);
    });

    it('leaves a question recipient whose id is not in the map untouched', () => {
      const recipient = { kind: 'question', questionId: QUESTION_ID } as const;
      expect(rewriteRecipientQuestionIds([recipient], new Map())).toEqual([
        recipient,
      ]);
    });
  });
});

describe('notification wire schemas', () => {
  const write = {
    name: 'Bestätigung',
    format: 'html',
    recipients: [{ kind: 'literal', address: 'buero@example.org' }],
    subject: 'Anmeldung {{formular}}',
    body: 'Danke, {{antworten}}',
    replyTo: null,
    active: true,
  };

  it('fills the defaults a create may leave out', () => {
    const parsed = notificationCreateSchema.parse({
      name: 'Intern',
      subject: 'Neue Anmeldung',
      body: '{{antworten}}',
      // **Not** among the defaults — see the case below.
      replyTo: null,
    });
    expect(parsed).toEqual({
      name: 'Intern',
      triggers: ['submit'],
      format: 'html',
      recipients: [],
      subject: 'Neue Anmeldung',
      body: '{{antworten}}',
      replyTo: null,
      active: true,
    });
  });

  /**
   * **`replyTo` is required and nullable — without a default value**, unlike
   * the four fields around it (a finding of the reply-to review).
   *
   * `null` means „was die Organisation bzw. das System vorgibt", and that is an
   * *entry*. An omitted key is not: the route replaces the whole
   * document (`PUT`), so a default value would mean that a writer who does not know
   * the field **deletes** a configured reply-to address — silently, and
   * without ever learning of it. The two sister routes of the same field give the
   * same answer (`updateSystemMailSettingsRequestSchema`,
   * `tenantReplyToWriteSchema`); one field, three places, one rule.
   *
   * *Reproduction, measured (2026-08-04):* hang `.default(null)` back on —
   * this case goes red.
   */
  it('refuses a write that omits replyTo — an omission is not „keine"', () => {
    for (const schema of [notificationCreateSchema, notificationUpdateSchema]) {
      const parsed = schema.safeParse({
        name: 'Intern',
        subject: 'Neue Anmeldung',
        body: '{{antworten}}',
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
        ['replyTo'],
      );
    }
  });

  /**
   * `toSubmitter` is no longer part of what a client may write.
   * It never created a recipient — only marked a notification as participant
   * delivery, independently of `recipients` — and that second, disagreeing
   * flag is exactly the finding removing it closes (`addressesSubmitter`,
   * `apps/api/src/notifications/notifications.service.ts`). The read schema
   * still has the field; only the way in is narrower now.
   */
  it('refuses toSubmitter on the way in — it is derived, not sent', () => {
    expect(
      notificationCreateSchema.safeParse({ ...write, toSubmitter: true })
        .success,
    ).toBe(false);
    expect(
      notificationUpdateSchema.safeParse({ ...write, toSubmitter: true })
        .success,
    ).toBe(false);
  });

  /**
   * „Abwesend, nicht deaktiviert" — enforced on the way in
   * rather than in the editor. Widening `notificationTriggerInputSchema` to the
   * full enum makes both of these red.
   */
  it('refuses trigger "save" on create and on update', () => {
    expect(
      notificationCreateSchema.safeParse({ ...write, triggers: ['save'] })
        .success,
    ).toBe(false);
    expect(
      notificationUpdateSchema.safeParse({ ...write, triggers: ['save'] })
        .success,
    ).toBe(false);
    // …including when it travels next to a trigger that *is* allowed: a set is
    // accepted or refused as a whole, never partly stored.
    expect(
      notificationCreateSchema.safeParse({
        ...write,
        triggers: ['submit', 'save'],
      }).success,
    ).toBe(false);
  });

  /**
   * **The trigger set — non-empty, without duplicates, both
   * members allowed**.
   *
   * The empty array has its own line because it is the shape a client produces
   * by unticking both boxes, and „feuert auf nichts" is what `active` is for:
   * a notification with no trigger is a text whose silence has no readable
   * reason.
   */
  it('accepts the trigger set of an edit notification and refuses a broken one', () => {
    expect(
      notificationCreateSchema.parse({ ...write, triggers: ['submit', 'edit'] })
        .triggers,
    ).toEqual(['submit', 'edit']);
    expect(
      notificationCreateSchema.parse({ ...write, triggers: ['edit'] }).triggers,
    ).toEqual(['edit']);
    expect(
      notificationCreateSchema.safeParse({ ...write, triggers: [] }).success,
    ).toBe(false);
    expect(
      notificationCreateSchema.safeParse({
        ...write,
        triggers: ['submit', 'submit'],
      }).success,
    ).toBe(false);
  });

  it('accepts trigger "save" when reading a row somebody wrote directly', () => {
    // `notificationSchema` is the **read** shape — unlike `write`, it still
    // carries `toSubmitter`, because a row written straight into the database
    // (the very fixture this test is) is exactly the case that column stays
    // for.
    const parsed = notificationSchema.parse({
      id: '019ff500-0000-7000-8000-0000000000d1',
      formId: '019ff500-0000-7000-8000-0000000000b1',
      ...write,
      toSubmitter: true,
      triggers: ['save'],
      effectiveReplyTo: { address: null, origin: null },
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    expect(parsed.triggers).toEqual(['save']);

    // …and so does the **empty** set, which the write schema refuses. It fires
    // on nothing, which is the right behaviour for a row nobody can explain;
    // refusing to display it would hide the thing an editor has to repair.
    expect(
      notificationSchema.safeParse({
        id: '019ff500-0000-7000-8000-0000000000d2',
        formId: '019ff500-0000-7000-8000-0000000000b1',
        ...write,
        toSubmitter: false,
        triggers: [],
        effectiveReplyTo: { address: null, origin: null },
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('refuses more recipients than the limit allows', () => {
    const recipients = Array.from(
      { length: MAIL_RECIPIENT_LIMIT + 1 },
      (_, i) => ({
        kind: 'literal' as const,
        address: `person${String(i)}@example.org`,
      }),
    );
    expect(
      notificationCreateSchema.safeParse({ ...write, recipients }).success,
    ).toBe(false);
    expect(
      notificationCreateSchema.safeParse({
        ...write,
        recipients: recipients.slice(0, MAIL_RECIPIENT_LIMIT),
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown key rather than dropping it', () => {
    // This case once stood on `replyTo` — until that became a
    // real field. A key that never becomes one keeps the test
    // stable.
    expect(
      notificationCreateSchema.safeParse({
        ...write,
        senderName: 'Dachorganisation',
      }).success,
    ).toBe(false);
  });

  /**
   * The reply-to address goes through **the same** check as the
   * sender address (trap 4): there would be no second version
   * to check, because there is none.
   */
  it('validates replyTo with the sender address predicate', () => {
    expect(
      notificationCreateSchema.parse({ ...write, replyTo: 'bt@example.org' })
        .replyTo,
    ).toBe('bt@example.org');
    for (const bad of [
      'Dachorganisation <bt@example.org>',
      'a@b.de, c@d.de',
      '',
    ]) {
      expect(
        notificationCreateSchema.safeParse({ ...write, replyTo: bad }).success,
        bad,
      ).toBe(false);
    }
  });

  it('collects question ids from subject, body and recipients at once', () => {
    expect(
      notificationQuestionIds({
        subject: `Hallo ${questionPlaceholderToken(QUESTION_ID)}`,
        body: `{{formularorganisation}} ${questionPlaceholderToken(OTHER_QUESTION_ID)}`,
        recipients: [{ kind: 'question', questionId: QUESTION_ID }],
      }),
    ).toEqual([QUESTION_ID, OTHER_QUESTION_ID]);
  });
});

/**
 * The publish lock.
 *
 * Moved here from `mail-template.test.ts` when the two placeholder modules were
 * merged: the recipient list is no longer a template string but a list of
 * entries, so „which questions does this notification point at" is answered by
 * {@link notificationQuestionIds} alone.
 */
describe('referenced question ids (publish lock)', () => {
  it('collects from subject, body and recipients without duplicates', () => {
    expect(
      notificationQuestionIds({
        subject: `Anmeldung ${questionPlaceholderToken(QUESTION_ID)}`,
        body: `${questionPlaceholderToken(QUESTION_ID)} ${questionPlaceholderToken(OTHER_QUESTION_ID)}`,
        recipients: [
          { kind: 'question', questionId: EMAIL_QUESTION_ID },
          { kind: 'literal', address: 'buero@example.de' },
        ],
      }),
    ).toEqual([QUESTION_ID, OTHER_QUESTION_ID, EMAIL_QUESTION_ID]);
  });

  it('sees the recipient list — the field that is easy to forget', () => {
    // A body with a gap is embarrassing; a notification whose only recipient
    // reference is gone is a mail with nowhere to go.
    expect(
      notificationQuestionIds({
        subject: 'Anmeldung',
        body: 'Danke.',
        recipients: [{ kind: 'question', questionId: EMAIL_QUESTION_ID }],
      }),
    ).toEqual([EMAIL_QUESTION_ID]);
  });

  it('ignores system and unknown placeholders', () => {
    expect(
      notificationQuestionIds({
        subject: '{{formularorganisation}} {{vorname}}',
        body: '{{antworten}} {{frage:}}',
        recipients: [{ kind: 'literal', address: 'buero@example.de' }],
      }),
    ).toEqual([]);
  });
});

describe('mail log wire schemas', () => {
  const entry = {
    id: '019ff500-0000-7000-8000-0000000000e1',
    createdAt: '2026-07-28T10:00:00.000Z',
    sentAt: null,
    recipient: 'buero@example.org',
    subject: 'Anmeldung Jahrestagung',
    notificationName: 'Bestätigung',
    formId: '019ff500-0000-7000-8000-0000000000b1',
    status: 'queued',
    attempts: 0,
    lastError: null,
    nextAttemptAt: '2026-07-28T10:00:15.000Z',
    senderIdentity: null,
    senderAddress: null,
    replyTo: 'Organisation-antwort@example.org',
    trigger: 'submit',
  };

  it('accepts one log line', () => {
    expect(mailLogEntrySchema.parse(entry).status).toBe('queued');
  });

  /**
   * **The trigger travels with the list** (a review finding).
   *
   * It stood on the detail schema alone, and the consequence was a table row
   * that offered „↻ Erneut" for a system mail and ran into the 409 that
   * `MailLogService.retry` has thrown since ADR-0021. The boundary stays with the server;
   * this field is what the row needs in order to hold the offer back.
   *
   * The **wide** enumeration, because `system` is nothing a
   * notification could carry — and is nevertheless the value this is
   * about.
   */
  it('carries what triggered the line, system included', () => {
    expect(mailLogEntrySchema.parse(entry).trigger).toBe('submit');
    expect(
      mailLogEntrySchema.parse({ ...entry, trigger: 'system' }).trigger,
    ).toBe('system');
    expect(() =>
      mailLogEntrySchema.parse({ ...entry, trigger: 'ausgedacht' }),
    ).toThrow();
    // And **no** optional field: a server that omits it would otherwise look
    // like one reporting „Beim Absenden" — and the row would offer the button
    // again. Rebuilt rather than gutted with `delete`, like the
    // omission cases in `public-form.test.ts`.
    const withoutTrigger = Object.fromEntries(
      Object.entries(entry).filter(([name]) => name !== 'trigger'),
    );
    expect(() => mailLogEntrySchema.parse(withoutTrigger)).toThrow();
  });

  /**
   * The sending identity on the wire — the half a unit test can hold.
   *
   * The three shapes are the three states of the column, and the middle one is
   * the point: `null` is „noch kein Versuch" and has to survive the parse as
   * `null`. A schema that made the field optional, or gave it a default, would
   * let a server that never sends the field look like one that sends „System".
   */
  describe('sending identity', () => {
    it('carries both blocks and the address each sent from', () => {
      expect(
        mailLogEntrySchema.parse({
          ...entry,
          status: 'sent',
          senderIdentity: 'system',
          senderAddress: 'no-reply@installation.example',
        }).senderAddress,
      ).toBe('no-reply@installation.example');
      expect(
        mailLogEntrySchema.parse({
          ...entry,
          status: 'sent',
          senderIdentity: 'own',
          senderAddress: 'post@organisation.example',
        }).senderIdentity,
      ).toBe('own');
    });

    it('keeps null null — „noch nicht versandt" is not „System"', () => {
      expect(mailLogEntrySchema.parse(entry).senderIdentity).toBe(null);
      expect(mailLogEntrySchema.parse(entry).senderAddress).toBe(null);
    });

    it('refuses a third kind of identity', () => {
      expect(
        mailLogEntrySchema.safeParse({ ...entry, senderIdentity: 'tenant' })
          .success,
      ).toBe(false);
    });

    /**
     * The `strictObject` trap the work item names: a payload without the new
     * fields does not „read as null", it fails. That is what keeps the server
     * and this contract from drifting apart silently.
     */
    it('refuses a payload that omits them', () => {
      const without: Record<string, unknown> = { ...entry };
      delete without.senderIdentity;
      delete without.senderAddress;
      expect(mailLogEntrySchema.safeParse(without).success).toBe(false);
    });
  });

  /**
   * **The frozen reply-to address on the wire.**
   *
   * What can be measured here is the shape: that `null` arrives as `null`
   * — „diese Mail trägt keine Kopfzeile" — and that an omission
   * breaks the parse instead of quietly reading as „keine". That the column carries the
   * value from the *enqueuing* and not today's is a statement about
   * the application and stands in `apps/api/test/mail-log/mail-log-detail.spec.ts`.
   */
  describe('the frozen reply address', () => {
    it('carries the address the line was enqueued with', () => {
      expect(mailLogEntrySchema.parse(entry).replyTo).toBe(
        'Organisation-antwort@example.org',
      );
    });

    /**
     * `null` means „ohne Kopfzeile hinausgegangen", not „nicht
     * aufgezeichnet" — the effective value `effectiveReplyTo` returns for „nirgends
     * etwas gesetzt".
     */
    it('keeps null null', () => {
      expect(
        mailLogEntrySchema.parse({ ...entry, replyTo: null }).replyTo,
      ).toBe(null);
    });

    /** The same `strictObject` trap as with the pair above. */
    it('refuses a payload that omits it', () => {
      const without: Record<string, unknown> = { ...entry };
      delete without.replyTo;
      expect(mailLogEntrySchema.safeParse(without).success).toBe(false);
    });
  });

  /**
   * **Die geleerte Zeile**  — the open point recorded
   * against this schema, decided.
   *
   * Endgültiges Löschen empties `recipient`, `subject`, `body_text` and
   * `body_html` and leaves the row. `recipient` was `z.string().min(1)`, so the
   * decision was „Platzhalter schreiben oder das Feld nullable machen" — and it
   * went to `null`, for the reasons written out at the schema. What these cases
   * hold is that the two halves of that decision are both real: an erased line
   * parses, and an *empty* one still does not.
   */
  describe('an erased line', () => {
    const erased = {
      ...entry,
      status: 'sent',
      sentAt: '2026-07-28T10:00:20.000Z',
      senderIdentity: 'own',
      senderAddress: 'post@organisation.example',
      recipient: null,
      subject: null,
    };

    it('parses with recipient and subject emptied', () => {
      const parsed = mailLogEntrySchema.parse(erased);
      expect(parsed.recipient).toBe(null);
      expect(parsed.subject).toBe(null);
      // What the row keeps is what makes it worth keeping.
      expect(parsed.status).toBe('sent');
      expect(parsed.senderIdentity).toBe('own');
      expect(parsed.senderAddress).toBe('post@organisation.example');
      // The reply-to address expressly does **not** belong to the emptied
      // columns (`MailLog.replyTo` in `schema.prisma`): it
      // is configuration an editor typed, not a value out of an
      // answer — and it is part of the same dispatch record as `status`.
      expect(parsed.replyTo).toBe('Organisation-antwort@example.org');
    });

    /**
     * **`null` is the erased state; `''` is still a defect.** Relaxing the
     * field to `z.string()` instead would have made the two indistinguishable —
     * and „der Empfänger war leer" is a bug this schema should keep catching.
     */
    it('still refuses an empty recipient', () => {
      expect(
        mailLogEntrySchema.safeParse({ ...entry, recipient: '' }).success,
      ).toBe(false);
    });

    /** The detail extends the entry, so it inherits the state rather than restating it. */
    it('carries through to the detail payload', () => {
      const parsed = mailLogDetailSchema.parse({
        ...erased,
        trigger: 'submit',
        bodyText: null,
        bodyHtml: null,
      });
      expect(parsed.recipient).toBe(null);
      expect(parsed.bodyText).toBe(null);
    });
  });

  /**
   * `mail_log` carries no rendered body on purpose. A strict
   * object is what keeps that a property of the wire and not just of today's
   * query — a service that started selecting one would fail here.
   */
  it('refuses a log line that carries a body', () => {
    expect(
      mailLogEntrySchema.safeParse({ ...entry, body: '<p>Danke</p>' }).success,
    ).toBe(false);
  });

  it('carries the four KPI counters', () => {
    const parsed = mailLogListResponseSchema.parse({
      entries: [entry],
      counts: { total: 3, sent: 1, failed: 1, queued: 1 },
    });
    expect(parsed.counts).toEqual({ total: 3, sent: 1, failed: 1, queued: 1 });
  });

  it('treats an absent filter key as "no restriction"', () => {
    expect(mailLogFilterSchema.parse({})).toEqual({});
    expect(mailLogFilterSchema.parse({ status: 'failed' })).toEqual({
      status: 'failed',
    });
  });

  it('refuses a tenant in the filter — the tenant is never a parameter', () => {
    expect(
      mailLogFilterSchema.safeParse({
        tenantId: '019ff500-0000-7000-8000-0000000000a1',
      }).success,
    ).toBe(false);
  });

  describe('detail — the entry plus the rendered body (2026-07-28)', () => {
    const detail = {
      ...entry,
      trigger: 'submit',
      bodyText: 'Danke für die Anmeldung.',
      bodyHtml: '<p>Danke für die Anmeldung.</p>',
    };

    it('accepts the entry fields plus trigger and both bodies', () => {
      const parsed = mailLogDetailSchema.parse(detail);
      expect(parsed.trigger).toBe('submit');
      expect(parsed.bodyText).toBe('Danke für die Anmeldung.');
      expect(parsed.bodyHtml).toBe('<p>Danke für die Anmeldung.</p>');
    });

    it('accepts null bodies — a plain-text notification, or a row predating the freeze', () => {
      expect(
        mailLogDetailSchema.parse({
          ...detail,
          bodyHtml: null,
        }).bodyHtml,
      ).toBe(null);
      expect(
        mailLogDetailSchema.parse({
          ...detail,
          bodyText: null,
          bodyHtml: null,
        }).bodyText,
      ).toBe(null);
    });

    // The wide enum: a row written straight into the database has to stay
    // readable, like `notificationSchema.triggers` (part of the non-goal
    // „Bei Zwischenspeichern").
    it('accepts the trigger "save" when reading a row somebody wrote directly', () => {
      expect(
        mailLogDetailSchema.parse({ ...detail, trigger: 'save' }).trigger,
      ).toBe('save');
    });

    it('still refuses an unrecognised key — extend() stays strict', () => {
      expect(
        mailLogDetailSchema.safeParse({ ...detail, tenantId: 'x' }).success,
      ).toBe(false);
    });

    it('refuses a detail payload missing the body fields the list omits', () => {
      expect(mailLogDetailSchema.safeParse(entry).success).toBe(false);
    });
  });
});

describe('constants', () => {
  it('keeps the retention period the view also names', () => {
    expect(MAIL_LOG_RETENTION_DAYS).toBe(90);
  });

  it('stops retrying after a fixed number of attempts', () => {
    expect(MAIL_MAX_ATTEMPTS).toBe(5);
  });

  it('caps the fan-out of one notification', () => {
    expect(MAIL_RECIPIENT_LIMIT).toBe(20);
  });
});
