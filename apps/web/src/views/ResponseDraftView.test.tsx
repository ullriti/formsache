import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../api/public-form';
import { createQueryClient } from '../api/query-client';
import { jsonResponse, requestUrl, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { ResponseDraftView } from './ResponseDraftView';

/**
 * *Zwischenspeichern* resumed, the participant's half — the evidence.
 *
 * What is worth checking here, mirroring `ResponseEditView.test.tsx`:
 *
 * - the answers arrive **pre-filled** („zeigt die getippten Werte
 *   wieder");
 * - *Zwischenspeichern* here is a `PUT` to the draft's own address, not the
 *   `POST` that mints one;
 * - *Entwurf verwerfen* asks first, and is the *destructive* confirmation
 *   (Konzept no. 63's worklog measured this distinction in rendered colour);
 * - a refusal shows the server's own sentence, never one composed here.
 */

const TOKEN = 'AbCd_1234-xyzAbCd_123';
const SLUG = 'AbCdEf123456';
const NAME_ID = '019fe800-0000-7000-8000-000000000001';
const PAGE_ID = '019fe800-0000-7000-8000-0000000000a1';
const FILE_ID = '019fe800-0000-7000-8000-0000000000c1';

const TENANT = {
  name: 'Dachorganisation',
  shortName: 'DACH',
  logoRef: null,
  branding: {
    accent: '#cea967',
    headerBg: '#212226',
    canvasBg: '#e9e6df',
    stripe: ['#212226', '#7c0800', '#cea967'],
    wideLogo: true,
  },
};

const SAVED_AT = '2026-08-05T09:00:00.000Z';
const EXPIRES_AT = '2026-09-04T21:59:00.000Z';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    form: {
      locked: false,
      title: 'Jahrestagung 2026',
      version: 1,
      tenant: TENANT,
      display: {
        showProgress: true,
        showPageNumbers: true,
        showRequiredHint: true,
      },
      availability: { state: 'open', opensAt: null, closesAt: null },
      eventSeats: [],
      // `true` by construction — the read that answers `byDraftToken` has
      // already refused a switched-off form before reaching this payload
      // (`PublicFormsService.byDraftToken`'s own comment).
      canSaveDraft: true,
      // Finding 32 — this draft carries on without a time limit.
      timeLimitMin: null,
      // No form-specific privacy notice (ADR-0028 no. 4).
      privacyNotice: null,
      startToken: 's1.mfa1b2c3.RGllc0lzdEVpbmVTaWduYXR1cg',
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Person',
            questions: [
              {
                id: NAME_ID,
                label: 'Name',
                hint: null,
                required: true,
                width: 'full',
                type: 'text',
                minLength: null,
                maxLength: null,
                pattern: null,
              },
            ],
          },
        ],
      },
    },
    answers: { [NAME_ID]: 'Anton' },
    // No attachment, so nothing to resolve — the default for every case that is
    // not about files (`responseDraftSchema.attachments`).
    attachments: [],
    savedAt: SAVED_AT,
    expiresAt: EXPIRES_AT,
    formSlug: SLUG,
    ...overrides,
  };
}

/**
 * The same payload with a file upload beside the name.
 */
function withFileQuestion() {
  const form = payload().form;
  return {
    ...form,
    definition: {
      pages: form.definition.pages.map((page) => ({
        ...page,
        questions: [
          ...page.questions,
          {
            id: FILE_ID,
            label: 'Nachweis',
            hint: null,
            required: false,
            width: 'full',
            type: 'file',
            maxFiles: 2,
          },
        ],
      })),
    },
  };
}

const CONFIRMATION = {
  confirmationTitle: 'Vielen Dank!',
  confirmationMessage: 'Die Anmeldung ist eingegangen.',
  redirect: null,
  editUrl: null,
};

const SAVED_DRAFT = {
  draftUrl: null,
  expiresAt: EXPIRES_AT,
  // A `PUT` echoes the token it was addressed with — one draft, one address
  // (`savedDraftSchema.token`).
  token: TOKEN,
};

/**
 * Answers the `GET` with the payload, `PUT …/drafts/:token` with `onSave`,
 * `DELETE …/drafts/:token` with `onDelete`, and every other write (the
 * ordinary submission) with the confirmation — told apart by path, since a
 * draft resume can reach all four kinds of request.
 */
function stubDraft(
  body: unknown,
  handlers?: {
    onSave?: () => Response;
    onDelete?: () => Response;
    onSubmit?: () => Response;
  },
) {
  return stubFetch().mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return Promise.resolve(jsonResponse(200, body));
    }
    const path = requestUrl(input);
    if (method === 'DELETE') {
      return Promise.resolve(handlers?.onDelete?.() ?? emptyOk());
    }
    if (path.includes('/drafts/')) {
      return Promise.resolve(
        handlers?.onSave?.() ?? jsonResponse(200, SAVED_DRAFT),
      );
    }
    return Promise.resolve(
      handlers?.onSubmit?.() ?? jsonResponse(200, CONFIRMATION),
    );
  });
}

function emptyOk(): Response {
  return {
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error()),
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResponseDraftView', () => {
  it('opens the draft with the stored values already in the fields', async () => {
    stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    const name = await screen.findByLabelText(/Name/);
    expect((name as HTMLInputElement).value).toBe('Anton');
  });

  /**
   * The counterpart of `ResponseEditView`'s note, for the three things Konzept
   * no. 58/63 ask this exact screen to say: when it was saved, until when it
   * lives, and that no account stands behind the address that opened it.
   */
  it('says this is a resumed draft, and names when it was saved and until when it lives', async () => {
    stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    const note = await screen.findByTestId('response-draft-note');
    expect(note.textContent).toContain('zwischengespeicherter Entwurf');
    expect(note.textContent).toContain('05.08.2026');
    expect(note.textContent).toContain('04.09.2026');
    expect(note.textContent).toMatch(/Konto/);
  });

  /**
   * *Zwischenspeichern* pressed again while resuming — `PUT` to the draft's
   * own address, never the `POST` that mints one.
   */
  it('saves progress with PUT to the draft address', async () => {
    const fetchMock = stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    const name = await screen.findByLabelText(/Name/);
    fireEvent.change(name, { target: { value: 'Anton der Ältere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zwischenspeichern' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/public/drafts/${encodeURIComponent(TOKEN)}`,
        expect.objectContaining({ method: 'PUT' }),
      );
    });
    const sent = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    const raw = sent?.[1]?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as {
      answers: Record<string, unknown>;
    };
    expect(body.answers[NAME_ID]).toBe('Anton der Ältere');
  });

  /**
   * the evidence's frontend half, wired through `formSlug` — see that field's
   * own doc comment in `packages/shared/src/public-form.ts`. The draft token
   * travels with the submission so the server can delete it in the same
   * transaction that writes the answer.
   */
  it('submits with POST to the ordinary route, carrying the draftToken', async () => {
    const fetchMock = stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    await screen.findByLabelText(/Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/public/forms/${encodeURIComponent(SLUG)}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const sent = fetchMock.mock.calls.find(
      ([input, init]) =>
        init?.method === 'POST' && requestUrl(input).endsWith('/responses'),
    );
    const raw = sent?.[1]?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as { draftToken?: string };
    expect(body.draftToken).toBe(TOKEN);

    expect(await screen.findByText('Vielen Dank!')).toBeDefined();
  });

  /**
   * **Without `formSlug` the response is broken, not restricted.**
   *
   * The first version of this view left the field out and hid *Absenden* for
   * it — a view that can do everything except the one thing that
   * *Zwischenspeichern* exists for. The field is mandatory now, and this case
   * records what that means: a response without the key is refused at parse
   * time and shown as an error instead of building half a page.
   */
  it('lehnt eine Entwurfs-Antwort ohne formSlug ab, statt „Absenden" zu verstecken', async () => {
    stubDraft(payload({ formSlug: undefined }));
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    expect(
      await screen.findByTestId('response-draft-unavailable'),
    ).toBeDefined();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  /**
   * *Entwurf verwerfen* — the way out for somebody with no account and no
   * trash of their own (DSGVO Art. 17). Asks first, in the
   * **destructive** tone: unlike a trash entry, this does not come back.
   */
  it('discards the draft only after confirming, with the destructive tone', async () => {
    const fetchMock = stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    await screen.findByLabelText(/Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));

    const prompt = await screen.findByRole('alert');
    expect(prompt.textContent).toContain('nicht rückgängig machen');
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);

    fireEvent.click(
      within(prompt).getByRole('button', { name: 'Entwurf verwerfen' }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/public/drafts/${encodeURIComponent(TOKEN)}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByTestId('response-draft-discarded')).toBeDefined();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  it('lets the confirmation be cancelled without deleting anything', async () => {
    const fetchMock = stubDraft(payload());
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    await screen.findByLabelText(/Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));
    const prompt = await screen.findByRole('alert');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Abbrechen' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(/Name/)).toBeDefined();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
  });

  /**
   * A 404 stays vague — unknown token, expired draft and one
   * already submitted or discarded are one answer on the server.
   */
  it('stays vague about a token that leads nowhere', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(404, { message: 'Dieses Formular gibt es nicht.' }),
    );
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    const notice = await screen.findByTestId('response-draft-unavailable');
    expect(notice.textContent).toContain('führt zu keinem Entwurf');
  });

  /**
   * The switch is read on **every** access — a
   * draft address opened after *Zwischenspeichern* was switched off meets the
   * server's own sentence, never one composed here.
   */
  it('shows the server’s own sentence when saving has since been switched off', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(409, {
        reason: 'saving_disabled',
        message: 'Zwischenspeichern ist für dieses Formular nicht möglich.',
      }),
    );
    renderWithQuery(<ResponseDraftView token={TOKEN} />);

    expect(
      await screen.findByText(
        'Zwischenspeichern ist für dieses Formular nicht möglich.',
      ),
    ).toBeDefined();
    expect(screen.queryByLabelText(/Name/)).toBeNull();
  });

  /**
   * **A found bug — the draft's upload door.**
   *
   * Until then this view deliberately handed over no `uploadTarget`, and
   * `FileField` thereupon drew a locked picker next to a living „Entfernen"
   * button: the participant on the second device could only **lose** their
   * attachment. *Measured on 2026-08-05:* picker `disabled = true`,
   * „Entfernen" `disabled = false`.
   *
   * What is repaired is not the button but the missing door — locking the
   * button along with it would have made the screen uniform and worse.
   *
   * *Reproduction:* remove `uploadTarget` from `ResponseDraftView` → both cases
   * here go red.
   */
  describe('der Anhang eines fortgesetzten Entwurfs', () => {
    it('bietet einen bedienbaren Auswähler statt eines gesperrten', async () => {
      stubDraft(payload({ form: withFileQuestion() }));
      renderWithQuery(<ResponseDraftView token={TOKEN} />);

      const input = await screen.findByLabelText(/Nachweis/);
      expect((input as HTMLInputElement).disabled).toBe(false);
      expect(
        screen.queryByText('Datei-Upload steht hier nicht zur Verfügung'),
      ).toBeNull();
    });

    it('lädt über die Adresse des Entwurfs hoch, nicht über die des Formulars', async () => {
      const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
        ref: 'AbCdEfGhIjKlMnOpQrStUv',
        fileName: 'Nachweis.pdf',
        contentType: 'application/pdf',
        byteSize: 9,
      });
      stubDraft(payload({ form: withFileQuestion() }));
      renderWithQuery(<ResponseDraftView token={TOKEN} />);

      const input = await screen.findByLabelText(/Nachweis/);
      fireEvent.change(input, {
        target: {
          files: [
            new File(['%PDF-1.7\n'], 'Nachweis.pdf', {
              type: 'application/pdf',
            }),
          ],
        },
      });

      await waitFor(() => {
        expect(upload).toHaveBeenCalledWith(
          { kind: 'draft', token: TOKEN },
          expect.any(File),
        );
      });
      // And the uploaded name stands in the list afterwards, removable as
      // everywhere else — but now with a picker next to it that can replace
      // it.
      expect(await screen.findByText('Nachweis.pdf')).toBeDefined();
      expect(
        screen.getByRole('button', { name: 'Entfernen: Nachweis.pdf' }),
      ).toBeDefined();
    });

    /**
     * **a review finding of the security review on the door commit — the dead
     * end on the resume screen.**
     *
     * The door alone is not enough: its reasoning presupposes „entfernen → neu
     * anhängen → **absenden**", and nothing enforces the third step. A draft
     * whose attachment survived the 24 hours of ADR-0014 no. 15 went on showing
     * it as attached for thirty days — until the submission answered with
     * `409 attachment_unavailable`.
     *
     * The server now resolves the references (`responseDraftSchema
     * .attachments`), and this view marks the dead attachment as such.
     *
     * *Reproduction:* remove `unavailableRefs` from `ResponseDraftView` → this
     * case goes red, and the screen claims „angehängt" again.
     */
    it('macht eine Anlage kenntlich, die es nicht mehr gibt', async () => {
      stubDraft(
        payload({
          form: withFileQuestion(),
          answers: {
            [NAME_ID]: 'Anton',
            [FILE_ID]: {
              files: [{ ref: 'AbCdEfGhIjKlMnOpQrStUv', name: 'alt.pdf' }],
            },
          },
          attachments: [{ ref: 'AbCdEfGhIjKlMnOpQrStUv', expiresAt: null }],
        }),
      );
      renderWithQuery(<ResponseDraftView token={TOKEN} />);

      expect(await screen.findByText('alt.pdf')).toBeDefined();
      expect(
        screen.getByText(
          'Nicht mehr verfügbar — bitte entfernen und neu hochladen.',
        ),
      ).toBeDefined();
      // And the frame says at the top what this is about — including the
      // second, shorter deadline that this view named nowhere until then.
      expect(
        screen.getByTestId('response-draft-attachments').textContent,
      ).toContain('Eine angehängte Datei ist nicht mehr verfügbar');
      expect(
        screen.getByTestId('response-draft-attachments').textContent,
      ).toContain('bleiben so lange erhalten wie dieser Entwurf');
    });

    /**
     * The living attachment stays a living attachment — the counter-case,
     * without which the one above would only evidence that some sentence
     * appears.
     */
    it('nennt bei einer lebenden Anlage die Frist und markiert nichts', async () => {
      stubDraft(
        payload({
          form: withFileQuestion(),
          answers: {
            [NAME_ID]: 'Anton',
            [FILE_ID]: {
              files: [{ ref: 'AbCdEfGhIjKlMnOpQrStUv', name: 'neu.pdf' }],
            },
          },
          attachments: [
            {
              ref: 'AbCdEfGhIjKlMnOpQrStUv',
              expiresAt: '2026-08-06T09:00:00.000Z',
            },
          ],
        }),
      );
      renderWithQuery(<ResponseDraftView token={TOKEN} />);

      expect(await screen.findByText('neu.pdf')).toBeDefined();
      expect(
        screen.queryByText(
          'Nicht mehr verfügbar — bitte entfernen und neu hochladen.',
        ),
      ).toBeNull();
      const note = screen.getByTestId('response-draft-attachments').textContent;
      // ⚠️ Until 2026-08-12 the sentence said „24 Stunden nach dem Hochladen",
      // and that was/0.3 wrong: an attachment **with** a `draft_id` is not
      // touched by `file-purge.service.ts`. The hint thereby underestimated the
      // retention — the more unpleasant direction of a wrong deadline sentence.
      expect(note).toContain('bleiben so lange erhalten wie dieser Entwurf');
      expect(note).not.toContain('nicht mehr verfügbar');
    });

    /** No attachment, no hint — otherwise it dilutes the sentence above it. */
    it('schweigt über Anhänge, wenn der Entwurf keine nennt', async () => {
      stubDraft(payload({ form: withFileQuestion() }));
      renderWithQuery(<ResponseDraftView token={TOKEN} />);

      await screen.findByLabelText(/Nachweis/);
      expect(screen.queryByTestId('response-draft-attachments')).toBeNull();
    });
  });

  /** Same data-loss guard `ResponseEditView` carries, for the same reason. */
  it('keeps the typed answer when a background refetch fails', async () => {
    const fetchMock = stubDraft(payload());
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ResponseDraftView token={TOKEN} />
      </QueryClientProvider>,
    );

    const name = await screen.findByLabelText(/Name/);
    fireEvent.change(name, { target: { value: 'Anton der Ältere' } });

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await queryClient.refetchQueries({ queryKey: ['response-draft', TOKEN] });

    await waitFor(() => {
      expect(
        queryClient.getQueryState(['response-draft', TOKEN])?.error,
      ).toBeTruthy();
    });
    expect(screen.queryByTestId('response-draft-unavailable')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/Name/).value).toBe(
      'Anton der Ältere',
    );
  });
});
