import { MAIL_SUBJECT_MAX } from '@formsache/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { NotificationsView } from './NotificationsView';

/**
 * Benachrichtigungen.
 *
 * What is asserted here is what only a rendered view can show: that the second
 * trigger is **absent**, that a chip shows the question's *caption* and the
 * field shows it too (the id is only what is stored, `notification-draft.test.ts`/`mail-placeholder-display.test.ts` prove that
 * half), that participant delivery **is** picking a chip and nothing else
 * (there is no longer a second box to tick), and that the
 * relationship to `copyToSubmitter` is stated rather than merely obeyed.
 *
 * **The cursor arithmetic is not tested here** . jsdom
 * has no caret worth trusting; `insert-token.test.ts` proves the computation on
 * strings, and what this file adds is the one honest jsdom question — does the
 * click reach it with the right token, and does the result land in the field.
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';
const EMAIL_QUESTION_ID = '019fe700-0000-7000-8000-0000000000aa';
const TEXT_QUESTION_ID = '019fe700-0000-7000-8000-0000000000bb';
const NOTIFICATION_ID = '019fe700-0000-7000-8000-0000000000cc';

const EMAIL_QUESTION = {
  id: EMAIL_QUESTION_ID,
  type: 'email',
  label: 'E-Mail-Adresse',
  hint: null,
  required: true,
  width: 'full',
};

const TEXT_QUESTION = {
  id: TEXT_QUESTION_ID,
  type: 'text',
  label: 'Vorname',
  hint: null,
  required: false,
  width: 'full',
  minLength: null,
  maxLength: null,
  pattern: null,
};

function formDetail(questions: unknown[] = [EMAIL_QUESTION, TEXT_QUESTION]) {
  return {
    id: FORM_ID,
    title: 'Anmeldung Jahrestagung',
    status: 'draft',
    publishedVersion: null,
    responseCount: 0,
    permissions: permissions(),
    updatedAt: '2026-07-27T10:00:00.000Z',
    revision: 2,
    publicSlug: 'AbCdEf123456',
    definition: {
      pages: [
        {
          id: '019fe700-0000-7000-8000-0000000000ff',
          title: 'Seite 1',
          questions,
        },
      ],
    },
    hasUnpublishedChanges: true,
  };
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIFICATION_ID,
    formId: FORM_ID,
    name: 'Bestätigung an Teilnehmer',
    triggers: ['submit'],
    format: 'html',
    toSubmitter: true,
    recipients: [{ kind: 'question', questionId: EMAIL_QUESTION_ID }],
    subject: 'Anmeldung {{formular}}',
    body: 'Danke!',
    replyTo: null,
    effectiveReplyTo: {
      address: 'Organisation-antwort@example.de',
      origin: 'tenant',
    },
    active: true,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * What the server delivers as templates.
 *
 * **Invented text, deliberately not the shipped one.** The templates are an
 * installation-wide setting, so what this view has to render is what
 * the *response* carried — a fixture repeating `NOTIFICATION_TEMPLATES_FLOOR`
 * would stay green for a view that still read a built-in constant, which is the
 * one thing the move away from that constant has to prove. The three ids and
 * their trigger sets mirror the shipped ones because the cases below are about
 * those shapes (a change mail on „Bei Bearbeitung", a confirmation that reaches
 * the participant).
 */
function templates(): Record<string, unknown>[] {
  return [
    {
      id: 'confirmation',
      name: 'Vorlage A',
      description: 'Geht an die ausfüllende Person.',
      triggers: ['submit'],
      format: 'html',
      subject: 'Betreff A',
      body: 'Text A',
      toSubmitter: true,
    },
    {
      id: 'office',
      name: 'Vorlage B',
      description: 'Geht an eine feste Adresse.',
      triggers: ['submit'],
      format: 'html',
      subject: 'Betreff B',
      body: 'Text B',
      toSubmitter: false,
    },
    {
      id: 'change',
      name: 'Vorlage C',
      description: 'Geht bei einer Änderung heraus.',
      triggers: ['edit'],
      format: 'html',
      subject: 'Betreff C',
      body: 'Das ist neu: {{aenderungen}}',
      toSubmitter: false,
    },
  ];
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function methodOf(init: RequestInit | undefined): string {
  return init?.method ?? 'GET';
}

interface StubOptions {
  readonly questions?: unknown[];
  readonly notifications?: Record<string, unknown>[];
  /** What the installation offers — see {@link templates}. */
  readonly templates?: Record<string, unknown>[];
  readonly writeStatus?: number;
  readonly writeBody?: Record<string, unknown>;
  /**
   * The two inherited levels of the reply address (the requirement) —
   * organisation, then system, raw and in the order in which they apply.
   */
  readonly inheritedReplyTo?: { origin: string; value: string | null }[];
}

/** The organisation has one, the system too — the default of most cases here. */
function inheritedLevels(): { origin: string; value: string | null }[] {
  return [
    { origin: 'tenant', value: 'Organisation-antwort@example.de' },
    { origin: 'system', value: 'system-antwort@example.de' },
  ];
}

/** Answers by path, not by call order — the view starts three queries at once. */
function stubApi(options: StubOptions = {}) {
  return stubFetch().mockImplementation((input, init) => {
    const path = pathOf(input);

    if (path.includes('/notifications')) {
      if (methodOf(init) === 'GET') {
        return Promise.resolve(
          jsonResponse(200, {
            notifications: options.notifications ?? [notification()],
            templates: options.templates ?? templates(),
            inheritedReplyTo: options.inheritedReplyTo ?? inheritedLevels(),
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          options.writeStatus ?? 200,
          options.writeBody ?? notification(),
        ),
      );
    }
    return Promise.resolve(jsonResponse(200, formDetail(options.questions)));
  });
}

async function open(options: StubOptions = {}) {
  const fetchMock = stubApi(options);
  renderWithQuery(
    <NotificationsView formId={FORM_ID} tenantName="Verein Beispiel" />,
  );
  await waitFor(() => {
    expect(screen.getByLabelText('Name')).toBeDefined();
  });
  return fetchMock;
}

/** The bodies of every write the view sent. */
function writes(fetchMock: ReturnType<typeof stubFetch>): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        pathOf(input).includes('/notifications') && methodOf(init) !== 'GET',
    )
    .map(([, init]) =>
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : null,
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationsView', () => {
  it('offers exactly „Bei Absendung" and „Bei Bearbeitung" — „Bei Zwischenspeichern" is absent', async () => {
    await open();

    // The fixture notification carries `triggers: ['submit']`.
    expect(screen.getByTestId('trigger-submit')).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', false);
    // Absent, not disabled: a control that offers something nothing can fire
    // promises a function this application does not have.
    expect(screen.queryByText(/Zwischenspeichern/)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  /** the evidence of the work item: a brand-new draft fires only on submit. */
  it('defaults a brand-new notification to „Bei Absendung" only', async () => {
    const fetchMock = await open();

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );

    expect(screen.getByTestId('trigger-submit')).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', false);

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Willkommen' },
    });
    fireEvent.change(screen.getByLabelText(/Weitere Adressen/), {
      target: { value: 'buero@example.de' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    expect((writes(fetchMock)[0] as { triggers: string[] }).triggers).toEqual([
      'submit',
    ]);
  });

  /** the evidence: both boxes checked send both triggers. */
  it('sends both triggers once „Bei Bearbeitung" is also checked', async () => {
    const fetchMock = await open();

    fireEvent.click(screen.getByTestId('trigger-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    expect((writes(fetchMock)[0] as { triggers: string[] }).triggers).toEqual([
      'submit',
      'edit',
    ]);
  });

  /**
   * the evidence: unchecking the last trigger blocks the save with a readable
   * reason instead of letting the request out to fail with a 400.
   * *reproduction*: delete the check from `draftProblems` and this goes red.
   */
  it('blocks saving once both triggers are unchecked, and says why', async () => {
    const fetchMock = await open();

    fireEvent.click(screen.getByTestId('trigger-submit'));

    expect(screen.getByText(/mindestens einen Auslöser/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(writes(fetchMock)).toHaveLength(0);
  });

  /**
   * the evidence: choosing a question recipient defaults „Bei Bearbeitung" on
   * — the edit link is an owner capability, and this is the only way a
   * participant learns it has leaked.
   */
  it('checks „Bei Bearbeitung" once a question recipient is chosen', async () => {
    await open({
      notifications: [
        notification({
          toSubmitter: false,
          recipients: [],
          triggers: ['submit'],
        }),
      ],
    });

    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', false);

    fireEvent.click(
      screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`),
    );

    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);
  });

  /**
   * the evidence, the more important half: the default unchecks like any other
   * box, and *stays* unchecked — through a re-render triggered by something
   * else, and through a save. *reproduction* named by the work item: writing
   * the default as state derived from `questionRecipients` on every render,
   * instead of as a reaction to the click that adds one, makes this red —
   * the box would snap back on at the next render.
   */
  it('lets „Bei Bearbeitung" be unchecked again and keeps it unchecked through a re-render and a save', async () => {
    const fetchMock = await open({
      notifications: [
        notification({
          toSubmitter: false,
          recipients: [],
          triggers: ['submit'],
        }),
      ],
    });

    fireEvent.click(
      screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`),
    );
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);

    fireEvent.click(screen.getByTestId('trigger-edit'));
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', false);

    // A re-render not caused by the trigger box itself — typing in an
    // unrelated field already goes through `onChange`/`setState` and is
    // enough to prove nothing re-derives the default from `questionRecipients`.
    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Geänderter Betreff' },
    });
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', false);

    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    expect((writes(fetchMock)[0] as { triggers: string[] }).triggers).toEqual([
      'submit',
    ]);
  });

  /**
   * The requirement: the interface has to name the **question**, by its
   * caption. Asserting that some hint box exists would survive an interface
   * that names nothing.
   */
  it('names the chosen question by its caption, and stores its id', async () => {
    const fetchMock = await open();

    const chip = screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`);
    expect(chip.textContent).toBe('E-Mail-Adresse');
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Neuer Betreff' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    expect(writes(fetchMock)[0]).toMatchObject({
      recipients: [{ kind: 'question', questionId: EMAIL_QUESTION_ID }],
    });
  });

  /**
   * The jsdom half of the placeholder chips: the click reaches `insertToken`
   * with a token for *this* question, and the result lands in the field. The
   * caret position is not asserted — see the file comment.
   *
   * Konzept no. 30, the half that used to be missing: the field shows
   * the **caption**, `{{frage:Vorname}}`, not the id — an editor reading their
   * own template back should not need to remember a uuid. What is actually
   * saved is proven separately, in the next test.
   */
  it('inserts the question placeholder as a readable caption, from a chip showing the same caption', async () => {
    await open();

    const chip = screen.getByTestId(
      `placeholder-chip-question-${TEXT_QUESTION_ID}`,
    );
    expect(chip.textContent).toBe('Vorname');

    const subject = screen.getByLabelText('Betreff');
    fireEvent.focus(subject);
    fireEvent.click(chip);

    expect((subject as HTMLInputElement).value).toContain('{{frage:Vorname}}');
    // The id never touches the screen — that half is `mail-placeholder-display`'s.
    expect((subject as HTMLInputElement).value).not.toContain(TEXT_QUESTION_ID);
  });

  /**
   * The other half of Konzept no. 30: whatever the field shows, the id is what
   * gets saved — `toDisplayForm`/`toStorageForm` convert exactly at this
   * seam (`NotificationEditor`, point 3 of its module comment), not on every
   * keystroke.
   */
  it('saves the id behind a caption typed via the chip, not the caption itself', async () => {
    const fetchMock = await open();

    const chip = screen.getByTestId(
      `placeholder-chip-question-${TEXT_QUESTION_ID}`,
    );
    const subject = screen.getByLabelText('Betreff');
    fireEvent.focus(subject);
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    const sent = writes(fetchMock)[0] as { subject: string };
    expect(sent.subject).toContain(`{{frage:${TEXT_QUESTION_ID}}}`);
    expect(sent.subject).not.toContain('Vorname');
  });

  /**
   * Loading the other direction: a notification saved with an id-form
   * placeholder shows the caption once it is opened — the „beim Laden"
   * half of point 3.
   */
  it('shows the caption for a stored id-form placeholder, once opened', async () => {
    await open({
      notifications: [
        notification({
          subject: `Hallo {{frage:${TEXT_QUESTION_ID}}}`,
        }),
      ],
    });

    expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
      'Hallo {{frage:Vorname}}',
    );
  });

  /**
   * A trap in `mail-placeholder-display.ts`, wired end to end: two questions
   * with the same caption cannot be told apart by a caption alone, so neither
   * gets the short form — in the field as much as in storage.
   */
  it('leaves an ambiguous caption in id form rather than guessing', async () => {
    const duplicateLabelQuestion = {
      ...TEXT_QUESTION,
      id: '019fe700-0000-7000-8000-0000000000dd',
      label: 'E-Mail-Adresse',
    };
    await open({
      questions: [EMAIL_QUESTION, duplicateLabelQuestion],
      notifications: [
        notification({
          subject: `Hallo {{frage:${EMAIL_QUESTION_ID}}}`,
        }),
      ],
    });

    expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
      `Hallo {{frage:${EMAIL_QUESTION_ID}}}`,
    );
  });

  it('inserts a system placeholder into the field that was last focused', async () => {
    await open();

    const body = screen.getByLabelText('Text');
    fireEvent.focus(body);
    fireEvent.click(
      screen.getByTestId('placeholder-chip-formularorganisation'),
    );

    expect((body as HTMLTextAreaElement).value).toContain(
      '{{formularorganisation}}',
    );
    // The subject is untouched — the chips write into the field that has the
    // caret, not into both.
    expect(screen.getByLabelText('Betreff')).toHaveProperty(
      'value',
      'Anmeldung {{formular}}',
    );
  });

  /**
   * The requirement: „Hat das Formular keine Frage, die eine Adresse liefern kann,
   * ist die Teilnehmer-Zustellung nicht aktivierbar und die Oberfläche nennt
   * den Grund." There is no box to disable any more — the
   * chip row itself is simply absent, and the hint is the whole explanation.
   */
  it('offers no recipient chip without an e-mail question, and says why', async () => {
    await open({
      questions: [TEXT_QUESTION],
      notifications: [notification({ toSubmitter: false, recipients: [] })],
    });

    expect(
      screen.queryByTestId(`recipient-question-${TEXT_QUESTION_ID}`),
    ).toBeNull();
    expect(screen.getByTestId('no-address-question').textContent).toContain(
      'keine E-Mail-Frage',
    );
  });

  /**
   * **There is no second gate any more** (review finding 24, 2026-08-14).
   *
   * Three cases about the switch *Bestätigung an Teilnehmer senden* stood here:
   * that this page explains it, that the warning also appears with a question
   * address, and that it stays silent when the switch is on. The switch is gone
   * — whoever sets up a notification to the filling-in person has decided that
   * it gets sent.
   *
   * What remains is the absence, checked at the place where the warning stood:
   * no explanation any more, and this page does not even query the settings of
   * the form any more.
   */
  it('explains no second switch, and does not even read the form settings', async () => {
    const fetchMock = await open({
      notifications: [
        notification({
          toSubmitter: false,
          recipients: [{ kind: 'question', questionId: EMAIL_QUESTION_ID }],
        }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('trigger')).toBeDefined();
    });
    expect(screen.queryByTestId('copy-to-submitter-off')).toBeNull();
    expect(screen.queryByText(/Bestätigung an Teilnehmer senden/)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        pathOf(input).endsWith('/settings'),
      ),
    ).toBe(false);
  });

  /**
   * Choosing the chip **is** choosing participant delivery — the stored row
   * has no separate flag to say so any more; the server derives the same
   * thing from `recipients` (`addressesSubmitter`). *reproduction* for the
   * work item lives here too: picking the chip never sets `toSubmitter`
   * anywhere, because there is nowhere left in the request to set it —
   * `'toSubmitter' in sent` is the proof.
   */
  it('records participant delivery as a chosen question, nothing else', async () => {
    const fetchMock = await open({
      notifications: [notification({ toSubmitter: false, recipients: [] })],
    });

    const chip = screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`);
    expect(chip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    const sent = writes(fetchMock)[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      recipients: [{ kind: 'question', questionId: EMAIL_QUESTION_ID }],
    });
    expect('toSubmitter' in sent).toBe(false);
  });

  /**
   * Clicking a chosen chip again is the only way to drop a question recipient
   * (there is no bulk-off box any more).
   */
  it('clicking a chosen chip again drops that recipient', async () => {
    await open();

    const chip = screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`);
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(chip);

    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders the preview against example data, not against real answers', async () => {
    await open();

    expect(screen.getByTestId('preview-subject').textContent).toBe(
      'Anmeldung Anmeldung Jahrestagung',
    );
    expect(screen.getByTestId('preview-recipients').textContent).toContain(
      'max.mustermann@example.de',
    );
  });

  /**
   * The requirement no. 1 as the editor sees it: an answer placeholder resolves
   * to the sample value before it ever reaches the preview — the wiring this
   * view is responsible for. **Escaping and the sandbox itself are
   * `NotificationPreview.test.tsx`'s job**, asserted there against the
   * `srcdoc` attribute directly (jsdom does not parse an iframe's `srcdoc`
   * into a real document); this only has to show the view feeds it a real
   * question answer rather than the raw `{{frage:<id>}}` token.
   */
  it('resolves an answer placeholder in the rendered preview', async () => {
    await open({
      notifications: [
        notification({
          body: 'Danke, {{frage:019fe700-0000-7000-8000-0000000000bb}}',
        }),
      ],
    });

    const frame = screen.getByTestId('preview-body-frame');
    const srcDoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('Beispieltext');
    expect(srcDoc).not.toContain('{{frage:');
  });

  it('marks an unknown placeholder instead of letting it disappear', async () => {
    await open({
      notifications: [notification({ subject: 'Hallo {{vorname}}' })],
    });

    expect(screen.getByText(/Unbekannte Platzhalter/).textContent).toContain(
      '{{vorname}}',
    );
  });

  /**
   * **The effective reply address stands there in plain text** (the
   * requirement).
   *
   * What is assured is **the address itself**, not the presence of a hint:
   * „Leer: Vorgabe der Organisation bzw. des Systems" already stood there before
   * and was exactly the problem — it does not name it. A test on the word
   * „Vorgabe" would therefore have been green over the old view as well.
   *
   * The origin belongs with it: it answers "why this one?", and that is the
   * question the point arose from.
   *
   * *reproduction (driven):* render only the hint text instead of the address —
   * the three cases below turn red.
   *
   * ⚠️ The third one was **not** that until the review of package 0-A: it
   * asserted `toContain('Absenderadresse')` and `not.toContain('@')`, and the
   * hint paragraph contains the word itself („… und eine Antwort geht an die
   * Absenderadresse") and no `@`. It would have stayed green over the broken
   * view. It therefore now asserts on the **whole sentence** that only
   * `effectiveReplyToText` produces.
   */
  it('names the inherited reply address itself, not just that a default applies', async () => {
    await open();

    const effective = await screen.findByTestId('effective-reply-to');
    expect(effective.textContent).toContain('Organisation-antwort@example.de');
    expect(effective.textContent).toContain('Vorgabe der Organisation');
    // The field itself stays empty — the inheritance is no pre-filling,
    // otherwise the next save click would fix the inherited address as an own one.
    expect(screen.getByLabelText('Antwortadresse')).toHaveProperty('value', '');
  });

  it('names the system default and its origin when the organisation has none', async () => {
    await open({
      inheritedReplyTo: [
        { origin: 'tenant', value: null },
        { origin: 'system', value: 'system-antwort@example.de' },
      ],
    });

    const effective = await screen.findByTestId('effective-reply-to');
    expect(effective.textContent).toContain('system-antwort@example.de');
    expect(effective.textContent).toContain('Vorgabe des Systems');
  });

  /**
   * The fourth state is a statement, not a gap: the mail goes out **without** a
   * header line, and an answer lands at the sender address. Whoever shows it as
   * „unbekannt" or not at all keeps quiet about exactly the case an editor has
   * to know about.
   */
  it('says plainly when no level has one at all', async () => {
    await open({
      inheritedReplyTo: [
        { origin: 'tenant', value: null },
        { origin: 'system', value: null },
      ],
    });

    const effective = await screen.findByTestId('effective-reply-to');
    // The whole sentence, not its most striking word — see the block head.
    expect(effective.textContent).toContain(
      'Wirksam: keine – eine Antwort geht an die Absenderadresse.',
    );
    expect(effective.textContent).not.toContain('@');
  });

  /**
   * **„Wirksam" means the present.**
   *
   * Before, what stood under the field was the result the server had computed
   * for the **stored** row. Whoever typed a different address kept reading
   * „Wirksam: Organisation-antwort@example.de (Vorgabe der Organisation)"
   * underneath — the line claimed the present and showed the past, and that is
   * the actual divergence spot of the requirement.
   *
   * *reproduction:* show `selected.effectiveReplyTo` in the editor again (that
   * is, *not* taking the topmost level out of the draft) — this case turns red,
   * because the inherited address stays standing.
   */
  it('follows what is being typed, not what was last saved', async () => {
    await open();

    const effective = await screen.findByTestId('effective-reply-to');
    expect(effective.textContent).toContain('Organisation-antwort@example.de');

    fireEvent.change(screen.getByLabelText('Antwortadresse'), {
      target: { value: 'kontakt@example.de' },
    });

    expect(effective.textContent).toContain('kontakt@example.de');
    expect(effective.textContent).toContain('in dieser Benachrichtigung');
    expect(effective.textContent).not.toContain(
      'Organisation-antwort@example.de',
    );
  });

  /**
   * **For a notification that does not exist yet, as well.**
   *
   * The *first* notification of a form has no read document, so no
   * `effectiveReplyTo` either — precisely there the effective address remained
   * to be learnt only through a test mail, so precisely the state the
   * requirement ends. The inherited levels stand fixed, however, no matter
   * whether the row already exists.
   *
   * *reproduction:* hang the paragraph on the read document again (`null` ⇒
   * render nothing) — this case turns red, because the element does not exist.
   */
  it('names the effective address for a notification that does not exist yet', async () => {
    await open();

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );

    const effective = screen.getByTestId('effective-reply-to');
    expect(effective.textContent).toContain('Organisation-antwort@example.de');
    expect(effective.textContent).toContain('Vorgabe der Organisation');
  });

  it('refuses to save a draft whose address is not one, and shows it back', async () => {
    const fetchMock = await open();

    fireEvent.change(screen.getByLabelText(/Weitere Adressen/), {
      target: { value: 'nicht-ganz@' },
    });

    expect(screen.getByText(/nicht-ganz@/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(writes(fetchMock)).toHaveLength(0);
  });

  /**
   * a review finding: a caption `toStorageForm` cannot resolve — typed by hand, or
   * naming a question that never existed — is neither converted nor caught
   * by the „Unbekannte Platzhalter"-warning (its pattern does not match a
   * caption with a space). Left unblocked, this is a mail that goes out
   * with raw `{{frage:…}}` text nobody can undo — so the save itself is
   * refused, naming the caption.
   *
   * *reproduction*: remove the caption check from `draftProblems` and this
   * goes red — the button stays enabled and the write goes out.
   */
  it('blocks saving a subject whose caption names no question', async () => {
    const fetchMock = await open();

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Hallo {{frage:Name des Mitglieds}}' },
    });

    expect(
      screen.getByText(
        /\{\{frage:Name des Mitglieds\}\} zeigt auf keine Frage/,
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(writes(fetchMock)).toHaveLength(0);
  });

  /**
   * a review finding: `maxLength` used to bound the *displayed* caption, not the
   * *stored* placeholder — and the stored form is longer
   * (`{{frage:<uuid>}}` vs. `{{frage:Vorname}}`). A subject that stays well
   * under `MAIL_SUBJECT_MAX` on screen can already be over it once stored;
   * the save has to catch that, because nothing about the field does any
   * more.
   */
  it('blocks saving a subject that is short on screen but too long once stored', async () => {
    const fetchMock = await open();

    const displaySubject = '{{frage:Vorname}}'.repeat(12);
    expect(displaySubject.length).toBeLessThan(MAIL_SUBJECT_MAX);

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: displaySubject },
    });

    expect(
      screen.getByText(new RegExp(String(MAIL_SUBJECT_MAX))),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(writes(fetchMock)).toHaveLength(0);
  });

  /**
   * a review finding: the field used to tell a genuine reload apart from the echo
   * of its own edit with a `useRef` mutated during render. Switching the
   * selected notification is the one path that exercises that comparison
   * end to end — unsaved text in A's field must not survive into B's.
   */
  it('shows the newly selected notification’s own text, not a stale one from before the switch', async () => {
    const SECOND_ID = '019fe700-0000-7000-8000-0000000000ee';
    await open({
      notifications: [
        notification({
          id: NOTIFICATION_ID,
          name: 'Bestätigung A',
          subject: 'Betreff A',
        }),
        notification({
          id: SECOND_ID,
          name: 'Bestätigung B',
          subject: 'Betreff B',
        }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
        'Betreff A',
      );
    });

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Getippt, aber nicht gespeichert' },
    });

    fireEvent.click(screen.getByText('Bestätigung B'));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
        'Betreff B',
      );
    });
  });

  /**
   * The delivered templates — an installation-wide setting
   * , no longer a constant this bundle carries.
   *
   * What only a rendered view can show is that applying one really fills the
   * fields **from what the server delivered**, that the result is ordinary
   * editable text afterwards, and — the rule with a cost behind it — that the
   * row is **not** offered over text somebody has written. The shape of the
   * shipped floor is proven in `@formsache/shared`
   * (`notification-templates.test.ts`), and that it exists in exactly one place
   * in `single-source.test.ts`.
   */
  it('fills name, subject, body and trigger from the change template', async () => {
    const fetchMock = await open();

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );
    fireEvent.click(screen.getByTestId('template-change'));

    // The values the **response** carried, not any text this bundle knows.
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Vorlage C',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
      'Betreff C',
    );
    // The placeholder the template exists for — as a caption, since the editor
    // shows the display form (`toDisplayForm` leaves a system placeholder be).
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toContain(
      '{{aenderungen}}',
    );
    // …and the trigger it belongs to: a change mail on „Bei Absendung" would
    // carry an empty change block.
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);
    expect(screen.getByTestId('trigger-submit')).toHaveProperty(
      'checked',
      false,
    );

    // Ordinary text from here on: it can be edited…
    fireEvent.change(screen.getByLabelText('Text'), {
      target: { value: 'Selbst geschrieben.' },
    });
    // …and with the field no longer empty the row is gone, so nothing can
    // overwrite what was just typed.
    expect(screen.queryByTestId('templates')).toBeNull();

    fireEvent.change(screen.getByLabelText(/Weitere Adressen/), {
      target: { value: 'buero@example.de' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    const written = writes(fetchMock)[0] as Record<string, unknown>;
    expect(written.body).toBe('Selbst geschrieben.');
    expect(written.triggers).toEqual(['edit']);
    // **No link back.** Nothing about the template is written down — a stored
    // reference would be a second truth beside the text, and every later change
    // to the template would rewrite mails somebody had already adjusted.
    expect(Object.keys(written)).not.toContain('template');
    expect(Object.keys(written)).not.toContain('templateId');
  });

  /**
   * a review finding of the 2026-07-28 review: the picker's visibility only gates the
   * body (`acceptsTemplate`), so somebody filling the editor top to bottom —
   * Name → Auslöser → Format → Empfänger → Betreff → Text — has typed a name
   * and a subject *before* the row for the still-empty text ever appears. A
   * click there must not delete what is already on screen.
   *
   * *reproduction:* `applyTemplate`'s per-field `emptyDraft()` guards
   * reverted to the old unconditional assignment → this case turns red.
   */
  it('a template click cannot destroy a name and a subject already typed', async () => {
    await open();

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Meine eigene Benachrichtigung' },
    });
    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Mein eigener Betreff' },
    });

    // The text field is still empty, so the row is offered — and clicking it
    // must leave the two fields above alone.
    fireEvent.click(screen.getByTestId('template-office'));

    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Meine eigene Benachrichtigung',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Betreff').value).toBe(
      'Mein eigener Betreff',
    );
    // The empty field is still filled, exactly as before.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).not.toBe(
      '',
    );
  });

  /**
   * *reproduction:* the `acceptsTemplate(draft.body)` condition in
   * `NotificationEditor` removed (the row always rendered) → this case turns
   * red and the control below stays green.
   */
  it('offers no template over a notification that already has text', async () => {
    await open();

    // The stored fixture carries `body: 'Danke!'`.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toBe(
      'Danke!',
    );
    expect(screen.queryByTestId('templates')).toBeNull();
  });

  /** The control: an existing notification whose text is empty may still start over. */
  it('offers templates for an existing notification whose text is empty', async () => {
    await open({ notifications: [notification({ body: '' })] });

    expect(screen.getByTestId('templates')).toBeDefined();
    expect(screen.getByTestId('template-confirmation')).toBeDefined();
  });

  /**
   * The requirement, the half a rendered view can prove: what a **newly
   * created** notification carries is the text the superadmin wrote, and it
   * travels all the way into the request.
   *
   * *reproduction:* `NotificationEditor` reading a built-in constant again
   * instead of its `templates` prop → red, because no constant contains this
   * text.
   */
  it('saves the text the installation currently offers, not a built-in one', async () => {
    const changed = [
      {
        id: 'confirmation',
        name: 'Vom Superadmin benannt',
        description: 'Vom Superadmin beschrieben.',
        triggers: ['submit'],
        format: 'html',
        subject: 'Vom Superadmin geschrieben',
        body: 'Vom Superadmin verfasster Text.',
        toSubmitter: false,
      },
    ];
    const fetchMock = await open({ templates: changed });

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );
    fireEvent.click(screen.getByTestId('template-confirmation'));
    fireEvent.change(screen.getByLabelText(/Weitere Adressen/), {
      target: { value: 'buero@example.de' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    const written = writes(fetchMock)[0] as Record<string, unknown>;
    expect(written.subject).toBe('Vom Superadmin geschrieben');
    expect(written.body).toBe('Vom Superadmin verfasster Text.');
    expect(written.name).toBe('Vom Superadmin benannt');
    // Still a copy and nothing else — no reference travels back to the server.
    expect(Object.keys(written)).not.toContain('template');
    expect(Object.keys(written)).not.toContain('templateId');
  });

  /**
   * An installation that offers nothing shows no picker — `[]` is a decision
   * („diese Installation bietet keine Vorlagen an"), not a loading state, and
   * an empty labelled group would be a row of nothing to press.
   */
  it('shows no template row when the installation offers none', async () => {
    await open({ notifications: [notification({ body: '' })], templates: [] });

    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toBe('');
    expect(screen.queryByTestId('templates')).toBeNull();
  });

  /**
   * a review finding of the 2026-07-28 review: the confirmation template is the one
   * that always reaches a participant (`toSubmitter: true`) — it
   * suggests the form's one address question as a recipient, exactly the
   * moment module note 1a says „Bei Bearbeitung" must default on. The
   * template's own `triggers: ['submit']` used to overwrite that default away.
   *
   * *reproduction:* the `edit`-adding line in `applyTemplateToDraft` removed
   * → this case turns red.
   */
  it('defaults „Bei Bearbeitung" on when the confirmation template suggests a recipient', async () => {
    await open();

    fireEvent.click(
      screen.getByRole('button', { name: '+ Neue Benachrichtigung' }),
    );
    fireEvent.click(screen.getByTestId('template-confirmation'));

    expect(
      screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`),
    ).toHaveProperty('ariaPressed', 'true');
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);
  });

  /**
   * Second half of a review finding: a template applied *after* a question recipient
   * was chosen must not silently drop the „Bei Bearbeitung" default that
   * click already set — `applyTemplate` overwrites `triggers` from the
   * template's own set (`['submit']` for the office template), which used to
   * erase it even though the recipient — and with it the risk — is unchanged.
   *
   * *reproduction:* same line removed → this case turns red.
   */
  it('keeps „Bei Bearbeitung" when a later template would otherwise reset it', async () => {
    await open({
      notifications: [
        notification({ toSubmitter: false, recipients: [], body: '' }),
      ],
    });

    fireEvent.click(
      screen.getByTestId(`recipient-question-${EMAIL_QUESTION_ID}`),
    );
    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);

    fireEvent.click(screen.getByTestId('template-office'));

    expect(screen.getByTestId('trigger-edit')).toHaveProperty('checked', true);
  });

  it('reports the server’s own refusal after a failed save', async () => {
    const fetchMock = await open({
      writeStatus: 422,
      writeBody: {
        message: 'Der Empfänger verweist auf eine Frage, die es nicht gibt.',
      },
    });

    fireEvent.change(screen.getByLabelText('Betreff'), {
      target: { value: 'Anderer Betreff' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(writes(fetchMock)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'verweist auf eine Frage',
      );
    });
  });
});
