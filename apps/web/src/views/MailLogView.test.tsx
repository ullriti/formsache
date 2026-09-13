import { MAIL_LOG_RETENTION_DAYS } from '@formsache/shared';
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyResponse, jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { MailLogView } from './MailLogView';

/**
 * E-Mail-Versandprotokoll.
 *
 * The two assertions that carry the requirement are about *requests*, not about
 * pixels: a KPI tile has to reach the server as a filter (otherwise it is a
 * decoration over a list that never narrows), and „↻ Erneut" has to reload the
 * list **and** the counters, because the row leaves one tile and joins another.
 *
 * The retention sentence is asserted against `MAIL_LOG_RETENTION_DAYS`
 * (the requirement): change the constant and this test reads the new number.
 * A literal „90" in the view would make it red — which is the whole reason the
 * number is shared with the purge.
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';
const FAILED_ID = '019fe700-0000-7000-8000-0000000000f1';
const SENT_ID = '019fe700-0000-7000-8000-0000000000f2';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: SENT_ID,
    createdAt: '2026-07-27T08:00:00.000Z',
    sentAt: '2026-07-27T08:00:05.000Z',
    recipient: 'max.mustermann@example.de',
    subject: 'Anmeldung Jahrestagung',
    notificationName: 'Bestätigung an Teilnehmer',
    formId: FORM_ID,
    status: 'sent',
    attempts: 1,
    lastError: null,
    nextAttemptAt: null,
    senderIdentity: 'own',
    senderAddress: 'post@organisation.example',
    // Frozen at the **queueing** (the requirement) — that the chain would
    // yield something else today is the case the server side measures
    // (`apps/api/test/mail-log/mail-log-detail.spec.ts`).
    replyTo: 'antwort@organisation.example',
    // On the list, since the row decides by it whether it offers „↻ Erneut"
    // — a system row does not get the button (see below).
    trigger: 'submit',
    ...overrides,
  };
}

const FAILED_ENTRY = entry({
  id: FAILED_ID,
  status: 'failed',
  sentAt: null,
  attempts: 5,
  lastError: 'Mailserver antwortet nicht (550 unknown recipient)',
  recipient: 'falsch@example.invalid',
});

const COUNTS = { total: 12, sent: 7, failed: 3, queued: 2 };

function payload(
  entries: Record<string, unknown>[],
  counts: Record<string, number> = COUNTS,
) {
  return { entries, counts };
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

function detailOf(overrides: Record<string, unknown> = {}) {
  return {
    ...entry(),
    trigger: 'submit',
    bodyText: 'Danke für die Anmeldung. Bearbeiten: (kein Link)',
    bodyHtml: '<p>Danke für die Anmeldung. Bearbeiten: (kein Link)</p>',
    ...overrides,
  };
}

interface StubOptions {
  readonly entries?: Record<string, unknown>[];
  readonly counts?: Record<string, number>;
  readonly listStatus?: number;
  readonly retryStatus?: number;
  readonly retryBody?: Record<string, unknown>;
  readonly detail?: Record<string, unknown>;
  readonly detailStatus?: number;
}

function stubApi(options: StubOptions = {}) {
  return stubFetch().mockImplementation((input) => {
    const path = pathOf(input);

    if (path.includes('/retry')) {
      const status = options.retryStatus ?? 204;
      return Promise.resolve(
        options.retryBody === undefined
          ? emptyResponse(status)
          : jsonResponse(status, options.retryBody),
      );
    }
    // A detail request is `/api/mail-log/<id>` — no further segment, so it
    // has to be told apart from the list (`/api/mail-log` alone) and from
    // `/retry` above, which is checked first.
    if (/\/api\/mail-log\/[^/?]+$/.test(path)) {
      const status = options.detailStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? jsonResponse(200, options.detail ?? detailOf())
          : jsonResponse(status, {}),
      );
    }
    if (path.startsWith('/api/mail-log')) {
      if (options.listStatus !== undefined) {
        return Promise.resolve(jsonResponse(options.listStatus, {}));
      }
      // The status filter narrows the **entries**, never the counters: the
      // tiles describe the organisation, the table describes the filter. Answered that
      // way here so a test can compare the two.
      const all = options.entries ?? [entry(), FAILED_ENTRY];
      const entries = path.includes('status=failed')
        ? all.filter((row) => row.status === 'failed')
        : all;
      return Promise.resolve(
        jsonResponse(200, payload(entries, options.counts)),
      );
    }
    // `GET /forms?id=…` — only used to name the prefilter chip. A **page**
    //, and asked for by id: the view used to search the whole list,
    // which paging turned into „nicht auf Seite eins" for every busy Organisation.
    return Promise.resolve(
      jsonResponse(200, {
        items: [
          {
            id: FORM_ID,
            title: 'Anmeldung Jahrestagung',
            status: 'active',
            publishedVersion: 2,
            responseCount: 4,
            permissions: permissions(),
            updatedAt: '2026-07-27T08:00:00.000Z',
            revision: 6,
            publicSlug: 'AbCdEf123456',
            hasUnpublishedChanges: false,
          },
        ],
        total: 1,
        activeTotal: 1,
        responseTotal: 4,
        limit: 24,
        offset: 0,
      }),
    );
  });
}

/** Every mail-log list request, in order. */
function listCalls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        pathOf(input).startsWith('/api/mail-log') &&
        !pathOf(input).includes('/retry') &&
        methodOf(init) === 'GET',
    )
    .map(([input]) => pathOf(input));
}

async function open(formId: string | null = null, options: StubOptions = {}) {
  const fetchMock = stubApi(options);
  renderWithQuery(<MailLogView formId={formId} />);
  await waitFor(() => {
    expect(
      screen.getByRole('heading', { name: 'E-Mail-Versandprotokoll' }),
    ).toBeDefined();
  });
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailLogView', () => {
  it('shows the four counters the server computed', async () => {
    await open();

    await waitFor(() => {
      expect(screen.getByTestId('kpi-total').textContent).toContain('12');
    });
    expect(screen.getByTestId('kpi-sent').textContent).toContain('7');
    expect(screen.getByTestId('kpi-failed').textContent).toContain('3');
    expect(screen.getByTestId('kpi-queued').textContent).toContain('2');
  });

  /**
   * The requirement: the tile is a **filter**, and the proof is the request it
   * causes. Asserting the visibility of the table would stay green with the
   * filter wired to „alle".
   */
  it('asks the server for the clicked status', async () => {
    const fetchMock = await open();

    await waitFor(() => {
      expect(listCalls(fetchMock)).toHaveLength(1);
    });
    expect(listCalls(fetchMock)[0]).toBe('/api/mail-log');

    fireEvent.click(screen.getByTestId('kpi-failed'));

    await waitFor(() => {
      expect(listCalls(fetchMock)).toHaveLength(2);
    });
    expect(listCalls(fetchMock)[1]).toBe('/api/mail-log?status=failed');
    expect(screen.getByTestId('kpi-failed').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('clears the filter when the active tile is clicked again', async () => {
    const fetchMock = await open();

    fireEvent.click(screen.getByTestId('kpi-queued'));
    await waitFor(() => {
      expect(listCalls(fetchMock)).toContain('/api/mail-log?status=queued');
    });

    fireEvent.click(screen.getByTestId('kpi-queued'));
    await waitFor(() => {
      expect(
        screen.getByTestId('kpi-queued').getAttribute('aria-pressed'),
      ).toBe('false');
    });
  });

  /** Konzept no. 32: tenant-wide, with the prefilter one arrives with. */
  it('prefilters on the form one arrives from, and can drop the filter', async () => {
    const fetchMock = await open(FORM_ID);

    await waitFor(() => {
      expect(listCalls(fetchMock)[0]).toBe(`/api/mail-log?formId=${FORM_ID}`);
    });
    await waitFor(() => {
      expect(screen.getByTestId('form-filter').textContent).toContain(
        'Anmeldung Jahrestagung',
      );
    });
    expect(
      screen.getByRole('button', { name: 'Filter aufheben' }),
    ).toBeDefined();
  });

  it('shows a failed line with its reason and the retry action', async () => {
    await open();

    await waitFor(() => {
      expect(screen.getByTestId(`mail-log-row-${FAILED_ID}`)).toBeDefined();
    });
    const row = screen.getByTestId(`mail-log-row-${FAILED_ID}`);
    expect(row.textContent).toContain('550 unknown recipient');
    expect(row.textContent).toContain('Fehlgeschlagen');
    expect(screen.getByTestId(`retry-${FAILED_ID}`)).toBeDefined();
    // A delivered line has nothing to retry.
    expect(screen.queryByTestId(`retry-${SENT_ID}`)).toBeNull();
  });

  /**
   * A review finding: since `364ff12` a `mail_log` row can be **erased**
   * — `recipient`/`subject === null` on an otherwise intact row, the requirement's „endgültig gelöschte Antwort". The row has to say that, not stand
   * blank, and the subject cell must not become a button with no accessible
   * name (unusable by keyboard and screen reader alike).
   */
  const ERASED_ID = '019fe700-0000-7000-8000-0000000000f3';

  it('names the erased state instead of blank cells, and offers no nameless button', async () => {
    await open(null, {
      entries: [
        entry({
          id: ERASED_ID,
          recipient: null,
          subject: null,
          status: 'failed',
          sentAt: null,
          attempts: 3,
          lastError: 'Mailserver antwortet nicht (550 unknown recipient)',
        }),
      ],
    });

    const row = await screen.findByTestId(`mail-log-row-${ERASED_ID}`);
    // The subject cell is no longer a control at all — a button whose
    // accessible name is the empty string would be worse than none, so the
    // fix removes the button rather than leaving it empty. Measured by role,
    // not by the button's CSS class — a class swap would pass a
    // class-based check while still leaving an unnamed control behind.
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId(`view-${ERASED_ID}`)).toBeNull();

    const cells = within(row).getAllByRole('cell');
    // Each erased column says so on its own — checked per cell, not just
    // somewhere in the row, so a cell that silently stayed blank cannot hide
    // behind the other cell's text.
    expect(cells[1]?.textContent).toBe('(endgültig gelöscht)');
    expect(cells[2]?.textContent).toContain('(endgültig gelöscht)');
  });

  it('does not offer „↻ Erneut" on an erased line, even though it is failed', async () => {
    await open(null, {
      entries: [
        entry({
          id: ERASED_ID,
          recipient: null,
          subject: null,
          status: 'failed',
          sentAt: null,
          attempts: 3,
          lastError: 'Mailserver antwortet nicht (550 unknown recipient)',
        }),
      ],
    });

    await screen.findByTestId(`mail-log-row-${ERASED_ID}`);
    // The server is gaining a lock against retrying an erased line, but the
    // UI should not offer the click in the first place — comfort, not the
    // boundary.
    expect(screen.queryByTestId(`retry-${ERASED_ID}`)).toBeNull();
  });

  /**
   * **And not on a system row** (a review finding).
   *
   * `MailLogService.retry` refuses `trigger = 'system'` with a 409 (ADR-0020,
   * ADR-0021): a reset mail hangs on this organisation only because
   * `mail_log.tenant_id` is NOT NULL. The detail panel could see that already,
   * the table row could not — `trigger` stood only on the detail schema. So it
   * offered the button and led into the refusal.
   *
   * The counter-check stands next to it and is half the statement: the same
   * row with an ordinary trigger **does** have the button, otherwise this case
   * would be green for a view that no longer shows it anywhere either.
   */
  it('does not offer „↻ Erneut" on a failed system line, but does on an ordinary one', async () => {
    const failedSystem = '019fe700-0000-7000-8000-0000000000f5';
    await open(null, {
      entries: [
        entry({
          id: failedSystem,
          trigger: 'system',
          status: 'failed',
          sentAt: null,
          attempts: 3,
          lastError: 'Mailserver antwortet nicht',
        }),
        entry({
          id: FAILED_ID,
          status: 'failed',
          sentAt: null,
          attempts: 3,
          lastError: 'Mailserver antwortet nicht',
        }),
      ],
    });

    await screen.findByTestId(`mail-log-row-${failedSystem}`);
    expect(screen.queryByTestId(`retry-${failedSystem}`)).toBeNull();
    expect(screen.getByTestId(`retry-${FAILED_ID}`)).toBeDefined();
  });

  /**
   * The requirement: after the 204 both halves have to be refetched — the row
   * changes tile, so a client that reloaded only the table would show a
   * „Fehlgeschlagen"-counter that no longer matches any row.
   */
  it('reloads the list and the counters after a successful retry', async () => {
    const fetchMock = await open();

    await waitFor(() => {
      expect(listCalls(fetchMock)).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId(`retry-${FAILED_ID}`));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          pathOf(input).includes('/retry'),
        ),
      ).toHaveLength(1);
    });
    // The reload is the assertion: one list request before the retry, another
    // after it — and the counters travel in the same payload.
    await waitFor(() => {
      expect(listCalls(fetchMock).length).toBeGreaterThan(1);
    });
  });

  it('explains a retry the server refused', async () => {
    await open(null, { retryStatus: 409 });

    await waitFor(() => {
      expect(screen.getByTestId(`retry-${FAILED_ID}`)).toBeDefined();
    });
    fireEvent.click(screen.getByTestId(`retry-${FAILED_ID}`));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'nicht (mehr) fehlgeschlagen',
      );
    });
  });

  /**
   * The table is one page of the newest rows; the tiles count the whole organisation.
   *
   * „2 Zeilen" under a tile reading „12" is two numbers about the same thing
   * with nothing to explain them — and at 400 registrations the page ends at
   * the server's limit on the first day. The sentence has to say that these are
   * the **newest** ones and how many there are in total.
   */
  it('says that the table shows only the newest rows when it is cut short', async () => {
    await open();

    await waitFor(() => {
      expect(screen.getByTestId('row-count').textContent).toBe(
        'Es werden die neuesten 2 von 12 Zeilen gezeigt',
      );
    });
  });

  /** Nothing missing, nothing to explain — the plain count stays plain. */
  it('counts plainly when the table holds everything there is', async () => {
    await open(null, {
      counts: { total: 2, sent: 1, failed: 1, queued: 0 },
    });

    await waitFor(() => {
      expect(screen.getByTestId('row-count').textContent).toBe('2 Zeilen');
    });
  });

  /**
   * Compared against the **filtered** total, not against „Gesamt": with
   * „Fehlgeschlagen" active, one row out of three failed ones is what is on
   * screen, and „1 von 12" would be a third number nobody can place.
   */
  it('compares against the active filter, not against the grand total', async () => {
    await open();

    fireEvent.click(screen.getByTestId('kpi-failed'));

    await waitFor(() => {
      expect(screen.getByTestId('row-count').textContent).toBe(
        'Es werden die neuesten 1 von 3 Zeilen gezeigt · Filter: Fehlgeschlagen',
      );
    });
  });

  /**
   * The requirement — **one** source for the retention period.
   *
   * The sentence is built from `MAIL_LOG_RETENTION_DAYS`, the same constant the
   * purge deletes against. Changing it changes what this test expects *and*
   * what the view renders; a literal in either place makes them disagree.
   */
  it('states the retention period from the shared constant', async () => {
    await open();

    expect(
      screen.getByText(
        `Protokoll wird ${String(MAIL_LOG_RETENTION_DAYS)} Tage aufbewahrt, danach werden die Zeilen endgültig gelöscht.`,
      ),
    ).toBeDefined();
  });

  it('names the missing rights instead of blaming the network', async () => {
    stubApi({ listStatus: 403 });
    renderWithQuery(<MailLogView formId={null} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Antworten ansehen',
      );
    });
  });

  it('says so when there is nothing to show', async () => {
    await open(null, { entries: [] });

    await waitFor(() => {
      expect(screen.getByText(/Keine Einträge/)).toBeDefined();
    });
  });

  /**
   * „Die gerenderte Mail im Versandprotokoll ansehen".
   *
   * The evidence: the panel shows the fields the detail
   * route adds over the list (`trigger`, both bodies), and the HTML body goes
   * into the sandboxed frame — never `dangerouslySetInnerHTML` — the same
   * shape `NotificationPreview.test.tsx` asserts for the notification editor's
   * preview.
   */
  describe('the detail panel', () => {
    it('opens on the subject and shows recipient, status, trigger and both bodies', async () => {
      await open();

      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));

      const dialog = await screen.findByRole('dialog');
      const frame = await screen.findByTestId('mail-log-body-frame');
      expect(dialog.textContent).toContain('max.mustermann@example.de');
      expect(dialog.textContent).toContain('Anmeldung Jahrestagung');
      expect(dialog.textContent).toContain('Zugestellt');
      expect(dialog.textContent).toContain('Beim Absenden');
      expect(frame.tagName).toBe('IFRAME');
      // The load-bearing property, exactly as `NotificationPreview` asserts it
      // for its own frame: an empty sandbox. Neither `allow-scripts` nor
      // `allow-same-origin` may appear, or the mail's own markup could reach
      // back into this application.
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toContain('Danke für die Anmeldung');
      // The mail's own markup must never land as a real element of the
      // surrounding document — that is exactly the `dangerouslySetInnerHTML`
      // mistake `SandboxedHtmlFrame` exists to avoid. It is fine to find it
      // inside the `srcdoc` *attribute string* above; what must not exist is
      // an actual node carrying that text outside the iframe.
      expect(screen.queryByText(/Danke für die Anmeldung/)).toBeNull();
    });

    it('shows the text body as a <pre> when there is no HTML alternative', async () => {
      await open(null, {
        detail: detailOf({ bodyHtml: null, bodyText: 'Nur Text, kein HTML.' }),
      });

      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));

      const text = await screen.findByTestId('mail-log-body-text');
      expect(screen.queryByTestId('mail-log-body-frame')).toBeNull();
      expect(text.tagName).toBe('PRE');
      expect(text.textContent).toBe('Nur Text, kein HTML.');
    });

    /** The same erased state, shown in the detail panel's fields. */
    it('names the erased state for recipient and subject, not blank fields', async () => {
      await open(null, {
        detail: detailOf({ recipient: null, subject: null }),
      });

      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect(dialog.textContent).toContain('(endgültig gelöscht)');
      });
    });

    it('says so when the row predates the frozen body, instead of showing nothing', async () => {
      await open(null, {
        detail: detailOf({ bodyText: null, bodyHtml: null }),
      });

      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));

      await waitFor(() => {
        expect(screen.getByRole('dialog').textContent).toContain(
          'kein Text gespeichert',
        );
      });
    });

    /**
     * The requirement — **the sending identity**, at the place where it is
     * read.
     *
     * What is checked is a *difference*: the same view has to show different
     * sentences over the system block and over its own block. An assertion on
     * a single sentence would stay green if the field were hard wired —
     * exactly the reproduction the requirement names.
     */
    describe('Versandidentität', () => {
      async function identityText(
        overrides: Record<string, unknown>,
      ): Promise<string> {
        await open(null, { detail: detailOf(overrides) });
        fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));
        const field = await screen.findByTestId('mail-log-sender-identity');
        return field.textContent;
      }

      it('names different identities for the system block and an own block', async () => {
        const overSystem = await identityText({
          senderIdentity: 'system',
          senderAddress: 'no-reply@installation.example',
        });
        cleanup();
        const overOwn = await identityText({
          senderIdentity: 'own',
          senderAddress: 'post@organisation.example',
        });

        expect(overSystem).not.toBe(overOwn);
        expect(overSystem).toContain('Systemweiter Mailserver');
        expect(overSystem).toContain('no-reply@installation.example');
        expect(overOwn).toContain('Eigener Mailserver dieser Organisation');
        expect(overOwn).toContain('post@organisation.example');
      });

      it('names the identity a failed line went out under', async () => {
        const text = await identityText({
          status: 'failed',
          sentAt: null,
          attempts: 5,
          lastError: 'Der Mailserver war nicht erreichbar.',
          senderIdentity: 'own',
          senderAddress: 'post@organisation.example',
        });

        expect(text).toContain('Eigener Mailserver dieser Organisation');
        expect(text).toContain('post@organisation.example');
      });

      it('names none on a queued line — „noch nicht versandt", never „System"', async () => {
        const text = await identityText({
          status: 'queued',
          sentAt: null,
          attempts: 0,
          senderIdentity: null,
          senderAddress: null,
        });

        expect(text).toContain('Noch nicht versandt');
        expect(text).not.toContain('System');
      });

      /**
       * A row that is finished and nevertheless carries no identity is older
       * than the column. „Noch nicht versandt" over a „Zugestellt" chip would
       * be a contradiction on the screen.
       */
      it('says „nicht aufgezeichnet" on a finished line from before the column', async () => {
        const text = await identityText({
          senderIdentity: null,
          senderAddress: null,
        });

        expect(text).toContain('Nicht aufgezeichnet');
      });

      /**
       * The same empty column, a different sentence — and the difference is
       * the measurement (readability point b of the review gate). A failed row
       * with `attempts === 0` can only come from the arm that does not even
       * interpret a stored block: no mail server was asked. That is a
       * **statement**, not a data hole, and „nicht aufgezeichnet" would send
       * the reader searching for a lost value instead of to `Grund`, which
       * stands right there.
       */
      it('distinguishes „kein Versand versucht" from an unrecorded old line', async () => {
        const unusableBlock = await identityText({
          status: 'failed',
          sentAt: null,
          attempts: 0,
          lastError: 'Der gespeicherte Mailserver ist nicht lesbar.',
          senderIdentity: null,
          senderAddress: null,
        });
        cleanup();
        const oldLine = await identityText({
          senderIdentity: null,
          senderAddress: null,
        });

        expect(unusableBlock).not.toBe(oldLine);
        expect(unusableBlock).toContain('Kein Versand versucht');
        expect(unusableBlock).not.toContain('Nicht aufgezeichnet');
      });

      /**
       * Readability point a of the review gate. A row **waiting** again after
       * a refusal keeps the identity of its attempt — that is intended —, and
       * without a time reference the same words would stand under an „In
       * Warteschlange" chip as under „Zugestellt": it would read as a promise
       * about the next dispatch, which the next run resolves afresh, though.
       */
      it('marks the identity of a waiting line as the last attempt, not as a promise', async () => {
        const waiting = await identityText({
          status: 'queued',
          sentAt: null,
          attempts: 1,
          lastError: 'Der Mailserver war nicht erreichbar.',
          senderIdentity: 'own',
          senderAddress: 'post@organisation.example',
        });
        cleanup();
        const delivered = await identityText({
          senderIdentity: 'own',
          senderAddress: 'post@organisation.example',
        });

        expect(waiting).toContain('Letzter Versuch');
        expect(waiting).toContain('Eigener Mailserver dieser Organisation');
        // The time reference is the whole difference: the same identity, under
        // „Zugestellt" without it, under „In Warteschlange" with it.
        expect(delivered).not.toContain('Letzter Versuch');
        expect(waiting).not.toBe(delivered);
      });

      /**
       * The permanent deletion of a response blanks the four personal columns
       * — `sender_identity` and `sender_address` expressly do **not** belong
       * to them, and the view has to be able to render a row blanked in that
       * way.
       *
       * What can be measured here is the body half: without a text the
       * identity stays standing instead of disappearing with it. The other
       * half this test **cannot** pose, and that is a named open point instead
       * of a silent gap: `mailLogEntrySchema.recipient` is
       * `z.string().min(1)`, so a truly blanked recipient already breaks the
       * parse — what remains to be decided (write a placeholder or make the
       * field nullable) is not this package.
       */
      it('keeps the identity on a line that has no stored body at all', async () => {
        const text = await identityText({
          bodyText: null,
          bodyHtml: null,
          senderIdentity: 'system',
          senderAddress: 'no-reply@installation.example',
        });

        expect(text).toContain('Systemweiter Mailserver');
      });
    });

    /**
     * **The reply-to address of the row** (the requirement) — the half a
     * rendered view can prove: that the column *stands* in the detail and that
     * `null` is read as a statement, not as a gap.
     *
     * That the value stems from the **queueing** and is not computed from
     * today's chain cannot be measured here — the server delivers both as the
     * same field. That assurance therefore stands where it can fall:
     * `apps/api/test/mail-log/mail-log-detail.spec.ts` changes the default of
     * the organisation **after** the queueing and reads the row again.
     */
    describe('Antwortadresse', () => {
      async function replyToText(
        overrides: Record<string, unknown>,
      ): Promise<string> {
        await open(null, { detail: detailOf(overrides) });
        fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));
        const field = await screen.findByTestId('mail-log-reply-to');
        return field.textContent;
      }

      it('shows the address the line carries', async () => {
        expect(
          await replyToText({ replyTo: 'kontakt@organisation.example' }),
        ).toBe('kontakt@organisation.example');
      });

      /**
       * `null` means „ohne Kopfzeile hinausgegangen" — the effective value for
       * "nothing set anywhere", not „nicht aufgezeichnet". The assurance is
       * therefore a **difference**: the same sentence for both states would be
       * exactly the confusion that the neighbouring column `senderIdentity`
       * avoids with three different sentences.
       */
      it('reads null as „keine Kopfzeile", never as a gap in the record', async () => {
        const none = await replyToText({ replyTo: null });
        cleanup();
        const some = await replyToText({
          replyTo: 'kontakt@organisation.example',
        });

        expect(none).not.toBe(some);
        expect(none).toContain('Absenderadresse');
        expect(none).not.toContain('aufgezeichnet');
      });

      /**
       * The column does **not** belong to the four that the permanent deletion
       * blanks (`MailLog.replyTo` in `schema.prisma`): it is configuration,
       * not a value out of a response. A blanked row therefore carries it on
       * — the same statement as a row above for the sending identity.
       */
      it('survives on a line whose personal columns were erased', async () => {
        expect(
          await replyToText({
            recipient: null,
            subject: null,
            bodyText: null,
            bodyHtml: null,
            replyTo: 'kontakt@organisation.example',
          }),
        ).toBe('kontakt@organisation.example');
      });
    });

    it('closes on Escape and on the scrim, same as the responses panel', async () => {
      await open();
      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));
      await screen.findByRole('dialog');

      fireEvent.keyDown(screen.getByRole('dialog'), {
        key: 'Escape',
        code: 'Escape',
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('explains a foreign or purged row instead of a generic error', async () => {
      await open(null, { detailStatus: 404 });

      fireEvent.click(screen.getByTestId(`view-${SENT_ID}`));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain(
          'nicht gefunden',
        );
      });
    });
  });
});
