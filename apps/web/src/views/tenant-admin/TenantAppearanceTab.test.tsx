import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred } from '../../test/deferred';
import { jsonResponse, stubFetch, type FetchMock } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantAppearanceTab } from './TenantAppearanceTab';

/**
 * Erscheinungsbild & Login (handoff).
 *
 * Two documents share this tab and this test file follows the split: the
 * colour half always loads (it needs only `canManageSettings`), the OIDC half
 * is **absent** rather than disabled the moment its own request answers 403
 *  — that is the one behaviour this file exists to pin, next
 * to the race every settings surface of this application has to survive.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';

function brandingDocument(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Ortsgruppe Musterstadt',
    shortName: 'Musterstadt',
    logoRef: { kind: 'asset', ref: 'assets/beispiel-emblem.svg' },
    logoWide: false,
    stripeColors: ['#e30000', '#cad0d3', '#131313'],
    accent: '#cea967',
    headerBg: '#212226',
    canvasBg: '#e9e6df',
    logoChoices: ['assets/beispiel-signet.svg', 'assets/beispiel-emblem.svg'],
    revision: 4,
    ...overrides,
  };
}

function oidcDocument(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: true,
    issuer: 'https://sso.musterstadt-stuttgart.de/',
    clientId: 'formular-musterstadt',
    scopes: ['openid', 'profile', 'email'],
    emailClaim: 'email',
    emailVerifiedClaim: 'email_verified',
    buttonLabel: 'Mit Musterstadt-Konto anmelden',
    clientSecretSet: true,
    redirectUri:
      'https://formular.example.de/api/auth/oidc/callback/musterstadt',
    ...overrides,
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

function routeFetch(options: {
  readonly branding?: unknown;
  readonly oidcStatus?: number;
  readonly oidc?: unknown;
  readonly onBrandingPut?: (body: unknown) => Response;
  readonly onLogoPost?: (init: RequestInit | undefined) => Response;
  readonly onOidcPut?: (body: unknown) => Response;
}) {
  const branding = options.branding ?? brandingDocument();
  const oidcStatus = options.oidcStatus ?? 200;
  const oidc = options.oidc ?? oidcDocument();

  return stubFetch().mockImplementation((input, init) => {
    const url = pathOf(input);
    if (url.endsWith('/tenant/branding/logo')) {
      return Promise.resolve(
        options.onLogoPost === undefined
          ? jsonResponse(
              201,
              brandingDocument({
                logoRef: { kind: 'upload', ref: 'iM4a5oW1hLcVKQr3jd0lZQ' },
                revision: 5,
              }),
            )
          : options.onLogoPost(init),
      );
    }
    if (url.endsWith('/tenant/branding') && init?.method === 'PUT') {
      if (options.onBrandingPut !== undefined) {
        return Promise.resolve(options.onBrandingPut(bodyOf(init)));
      }
      return Promise.resolve(jsonResponse(200, branding));
    }
    if (url.endsWith('/tenant/branding')) {
      return Promise.resolve(jsonResponse(200, branding));
    }
    if (url.endsWith('/tenant/oidc') && init?.method === 'PUT') {
      return Promise.resolve(
        options.onOidcPut === undefined
          ? jsonResponse(200, oidc)
          : options.onOidcPut(bodyOf(init)),
      );
    }
    if (url.endsWith('/tenant/oidc')) {
      return Promise.resolve(
        jsonResponse(
          oidcStatus,
          oidcStatus === 200 ? oidc : { message: 'nope' },
        ),
      );
    }
    if (url.endsWith('/auth/session') || url.includes('/auth/me')) {
      return Promise.resolve(jsonResponse(401, { message: 'no session' }));
    }
    return Promise.resolve(jsonResponse(404, { message: 'not found' }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The colour half's own „Speichern" — the first of two once the OIDC block is
 * present, which is why every case that has both mounted picks it out rather
 * than asking for „the" button of that name.
 */
function brandingSaveButton(): HTMLButtonElement {
  const [button] = screen.getAllByRole<HTMLButtonElement>('button', {
    name: 'Speichern',
  });
  if (button === undefined) {
    throw new Error('No „Speichern" button was found.');
  }
  return button;
}

function lastPut(fetchMock: FetchMock): FetchMock['mock']['calls'][number] {
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  if (write === undefined) {
    throw new Error('No PUT request was sent.');
  }
  return write;
}

describe('Erscheinungsbild & Login', () => {
  it('shows the loaded colours and name', async () => {
    routeFetch({});
    renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Voller Name').value).toBe(
        'Ortsgruppe Musterstadt',
      );
    });
    expect(screen.getByText('Musterstadt')).toBeDefined(); // Kurzname, read-only
    // The three effective axes show their value in plain text next to the
    // colour picker.
    expect(screen.getByText('#cea967')).toBeDefined(); // Akzent
    expect(screen.getByText('#212226')).toBeDefined(); // Kopfzeile
    // The organisation colours are the stripe itself, and each of them is a
    // named control of its own.
    expect(
      screen.getByLabelText<HTMLInputElement>('Streifenfarbe 1 von 3').value,
    ).toBe('#e30000');
  });

  /**
   * Every colour has exactly one place at which it is maintained — never a
   * second list out of which a button would first have to copy it into the
   * stripe.
   */
  it('never offers a second colour list that a button would copy into the stripe', async () => {
    routeFetch({});
    renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Voller Name')).toBeDefined();
    });

    expect(screen.queryByLabelText(/Couleur-Farbe/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /aus Couleur übernehmen/ }),
    ).toBeNull();
    // …and instead what stands there is how the stripe is maintained.
    expect(
      screen.getByText(/Die Farben und ihre Reihenfolge bestimmst du hier/),
    ).toBeDefined();
  });

  it('sends the whole document, including the revision, on save', async () => {
    const fetchMock = routeFetch({});
    renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Voller Name')).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText('Voller Name'), {
      target: { value: 'Neuer Name' },
    });
    fireEvent.click(brandingSaveButton());

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
    const [, init] = lastPut(fetchMock);
    const body = bodyOf(init) as Record<string, unknown>;
    expect(body.name).toBe('Neuer Name');
    expect(body.revision).toBe(4);
    expect(body.stripeColors).toEqual(['#e30000', '#cad0d3', '#131313']);
    // The `strictObject` of the write contract no longer knows a
    // `brandColors`; a field it does not know would let the save button run
    // into the void.
    expect(body).not.toHaveProperty('brandColors');
  });

  it('selecting another Logo tile changes the draft', async () => {
    routeFetch({});
    renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Voller Name')).toBeDefined();
    });

    const saveButton = brandingSaveButton();
    expect(saveButton.disabled).toBe(true);

    // The radio input is the whole tile, not a decoration next to it — the
    // same „Mitte ist klickbar" rule the switch already has to follow.
    fireEvent.click(screen.getByRole('radio', { name: 'Kein Logo' }));

    expect(saveButton.disabled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Accessible names in the stripe editor
  // -------------------------------------------------------------------------

  /**
   * The three stripe swatches used to be the one `label` finding of the axe
   * gate — `input type="color"` without any associated text at all, so a
   * screen reader announced three nameless controls and nothing said which of
   * the organisation's colours was about to change.
   *
   * Measured through `getByLabelText`, i.e. through the accessible name, not
   * through the class the fix happens to be attached to: a later switch from
   * `aria-label` to a visible `<label htmlFor>` should keep this green.
   */
  it('names every stripe swatch and its buttons by position', async () => {
    routeFetch({});
    renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Voller Name')).toBeDefined();
    });

    // Three loaded colours (`brandingDocument`), so three named swatches.
    for (const position of [1, 2, 3]) {
      const swatch = screen.getByLabelText<HTMLInputElement>(
        `Streifenfarbe ${String(position)} von 3`,
      );
      expect(swatch.type).toBe('color');
    }

    // The buttons beside them carried one wording for all three, which is the
    // same defect one level up: „Nach links verschieben", three times.
    expect(
      screen.getByRole('button', {
        name: 'Streifenfarbe 2 nach links verschieben',
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Streifenfarbe 3 entfernen' }),
    ).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // The own Logo
  // -------------------------------------------------------------------------

  describe('the Logo upload', () => {
    /** A PNG the browser hands over — the content is the server's business. */
    function pngFile(): File {
      return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
        type: 'image/png',
      });
    }

    async function renderTab(fetchMock: FetchMock): Promise<FetchMock> {
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Voller Name')).toBeDefined();
      });
      return fetchMock;
    }

    /**
     * jsdom draws nothing, so the crop step's canvas is stubbed here — its own
     * behaviour is measured in `LogoCropDialog.test.tsx`. What these cases are
     * about is unchanged: what the *upload* sends and what the draft does with
     * the answer.
     */
    function stubCanvas(): void {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
        (callback: BlobCallback) => {
          callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]));
        },
      );
    }

    /**
     * Picks a file and walks through „Ausschnitt wählen" .
     *
     * **Every upload comes through the dialog** — there is no raw path past it,
     * because the step that crops is the step that scales a phone photo below
     * the 2 MiB limit. Taking the whole picture is the one click this helper
     * makes.
     */
    async function pickAndConfirm(file: File = pngFile()): Promise<void> {
      stubCanvas();
      fireEvent.change(screen.getByLabelText('Eigenes Logo hochladen'), {
        target: { files: [file] },
      });

      const image = document.querySelector('img.logo-crop__image');
      if (image === null) {
        throw new Error('Picking a file did not open the crop dialog.');
      }
      Object.defineProperty(image, 'naturalWidth', { value: 240 });
      Object.defineProperty(image, 'naturalHeight', { value: 240 });
      fireEvent.load(image);

      fireEvent.click(screen.getByRole('button', { name: 'Logo übernehmen' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }

    /**
     * **„Die Auswahl aus den mitgelieferten Assets bleibt"**  —
     * an organisation without its own Logo must not fall into a hole, so the shipped
     * tiles and the upload field stand next to each other rather than one
     * replacing the other.
     */
    it('offers the shipped tiles and the upload field side by side', async () => {
      await renderTab(routeFetch({}));

      expect(
        screen.getByRole('radio', { name: 'assets/beispiel-signet.svg' }),
      ).toBeDefined();
      expect(
        screen.getByRole('radio', { name: 'assets/beispiel-emblem.svg' }),
      ).toBeDefined();
      expect(screen.getByRole('radio', { name: 'Kein Logo' })).toBeDefined();
      expect(screen.getByLabelText('Eigenes Logo hochladen')).toBeDefined();
    });

    it('sends the file as a raw octet-stream with the CSRF header', async () => {
      // The token lives in a readable cookie and the header is derived from it
      // (`api/http.ts`); without one there is nothing to assert about.
      document.cookie = 'formsache_csrf=test-csrf-token';
      const fetchMock = await renderTab(routeFetch({}));

      await pickAndConfirm();

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([input]) =>
            pathOf(input).endsWith('/tenant/branding/logo'),
          ),
        ).toBe(true);
      });

      const call = fetchMock.mock.calls.find(([input]) =>
        pathOf(input).endsWith('/tenant/branding/logo'),
      );
      const headers = call?.[1]?.headers as Record<string, string>;
      expect(call?.[1]?.method).toBe('POST');
      // ADR-0014 no. 14: the one type this route accepts, set explicitly rather
      // than left to `fetch`, which would otherwise send the file's own.
      expect(headers['Content-Type']).toBe('application/octet-stream');
      expect(headers['X-File-Name']).toBe('logo.png');
      // Not `@CsrfExempt()`, unlike the public upload — this one rides a
      // session.
      expect(headers['X-CSRF-Token']).toBeDefined();
    });

    /**
     * **The trap this test exists for.** `useServerDraft` keeps what was typed,
     * and the draft's `logoRef` still names the *previous* Logo after an
     * upload. Without adopting the answer, the next „Speichern" writes the old
     * reference back — which on the server is the act that deletes the file
     * just uploaded (`files/logo-sweep.ts`).
     *
     * *Reproduction:* remove the `setDraft` in the upload's `onSuccess` → the
     * tile below stays on the asset and the PUT carries the old reference.
     */
    it('adopts the answer, so the next save keeps the new Logo', async () => {
      const fetchMock = await renderTab(routeFetch({}));

      await pickAndConfirm();

      await waitFor(() => {
        expect(
          screen.getByRole<HTMLInputElement>('radio', {
            name: 'Eigenes Logo',
          }).checked,
        ).toBe(true);
      });

      // Typing makes the document dirty — the upload alone does not, because
      // the draft has adopted the answer and there is nothing left to save.
      // The save then has to carry the *new* Logo and the *new* revision.
      // Anything but the loaded name — an unchanged field leaves the document
      // clean, and then this test would measure nothing.
      fireEvent.change(screen.getByLabelText('Voller Name'), {
        target: { value: 'Ortsgruppe Musterdorf' },
      });
      fireEvent.click(brandingSaveButton());

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
        ).toBe(true);
      });
      const body = bodyOf(lastPut(fetchMock)[1]) as {
        logoRef: unknown;
        revision: number;
      };
      expect(body.logoRef).toEqual({
        kind: 'upload',
        ref: 'iM4a5oW1hLcVKQr3jd0lZQ',
      });
      expect(body.revision).toBe(5);
    });

    /**
     * The way back, in the view: picking a shipped tile while the upload is
     * shown is a normal draft change, and the save carries the asset arm — the
     * server's sweep does the rest.
     */
    it('lets an organisation switch back from its own Logo to a shipped one', async () => {
      const fetchMock = await renderTab(
        routeFetch({
          branding: brandingDocument({
            logoRef: { kind: 'upload', ref: 'iM4a5oW1hLcVKQr3jd0lZQ' },
          }),
        }),
      );

      fireEvent.click(
        screen.getByRole('radio', { name: 'assets/beispiel-signet.svg' }),
      );
      fireEvent.click(brandingSaveButton());

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
        ).toBe(true);
      });
      expect(
        (bodyOf(lastPut(fetchMock)[1]) as { logoRef: unknown }).logoRef,
      ).toEqual({ kind: 'asset', ref: 'assets/beispiel-signet.svg' });
    });

    /**
     * The server's own sentence, not a second one invented here: „SVG und PDF
     * sind ausgeschlossen…" is written where the rule is, and a wording in the
     * browser would drift away from it.
     */
    it('shows the server’s refusal rather than a sentence of its own', async () => {
      await renderTab(
        routeFetch({
          onLogoPost: () =>
            jsonResponse(415, {
              message: 'Als Logo werden nur PNG und JPG angenommen.',
            }),
        }),
      );

      await pickAndConfirm();

      expect(
        await screen.findByText('Als Logo werden nur PNG und JPG angenommen.'),
      ).toBeDefined();
    });
  });

  describe('the OIDC block', () => {
    it('is absent, not disabled, when the caller may not manage users', async () => {
      routeFetch({ oidcStatus: 403 });
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Voller Name')).toBeDefined();
      });

      expect(screen.queryByText('Anmeldung (OIDC / SSO)')).toBeNull();
      expect(screen.queryByLabelText('Issuer / Discovery-URL')).toBeNull();
    });

    /**
     * **Only a 403 is absence.** Every other failure used to disappear the same
     * way, so a 500 or a lost connection looked exactly like „diese Rolle darf
     * das nicht" — an administrator would have gone looking for a permission
     * that was never taken away. A temporary failure says it is one.
     */
    it('names a failure that is not a refusal, instead of vanishing', async () => {
      routeFetch({ oidcStatus: 500 });
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Voller Name')).toBeDefined();
      });

      await waitFor(() => {
        expect(
          screen.getByText(
            /Anmeldung dieser Organisation konnte nicht geladen/,
          ),
        ).toBeDefined();
      });
      // Still no editable configuration — an error is not a half-loaded form.
      expect(screen.queryByLabelText('Issuer / Discovery-URL')).toBeNull();
    });

    it('shows the configuration and a „gesetzt" secret state when allowed', async () => {
      routeFetch({});
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Anmeldung (OIDC / SSO)' }),
        ).toBeDefined();
      });
      expect(
        screen.getByLabelText<HTMLInputElement>('Issuer / Discovery-URL').value,
      ).toBe('https://sso.musterstadt-stuttgart.de/');
      expect(screen.getByText('Client-Secret ist gesetzt.')).toBeDefined();
      expect(
        screen.getByLabelText<HTMLInputElement>(
          'Redirect-URI (im IdP eintragen)',
        ).readOnly,
      ).toBe(true);
    });

    it('marks the secret for removal without touching the replace field', async () => {
      routeFetch({});
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('Client-Secret ist gesetzt.')).toBeDefined();
      });

      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Client-Secret entfernen' }),
      );

      expect(screen.getByText('Wird beim Speichern entfernt.')).toBeDefined();
      expect(
        screen.getByLabelText<HTMLInputElement>('Client-Secret ersetzen')
          .disabled,
      ).toBe(true);
    });

    /**
     * **Konzept no. 70 — the price stands at the field, not only in the
     * concept.**
     *
     * What is checked is the rendered element and `aria-describedby`, not a
     * `title`: a `title` reaches the mouse and nobody else, and this sentence
     * says which promise is being given up.
     */
    it('warns at the verification-claim field once it is emptied', async () => {
      routeFetch({});
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      const field = await screen.findByLabelText<HTMLInputElement>(
        'Claim für „Adresse geprüft“',
      );
      expect(field.value).toBe('email_verified');
      // As long as it is checked, the hint says what the check does …
      expect(
        screen.getByText(/Nur wenn dieser Claim .true. meldet/),
      ).toBeDefined();

      fireEvent.change(field, { target: { value: '' } });

      const warning = screen.getByText(
        /die Adresse zählt ungeprüft.*Einladung dieser Organisation auf eine fremde Adresse/s,
      );
      // … and afterwards the warning stands **at the field**: the paragraph
      // that the input field itself names as its description.
      expect(field.getAttribute('aria-describedby')).toBe(warning.id);
      expect(warning.id).not.toBe('');
      expect(field.getAttribute('title')).toBeNull();
    });

    /**
     * The emptied verification claim goes to the server **empty** — the trap
     * would be to reset it like an empty display field to the default and
     * thereby silently take the decision back. The address claim is the
     * opposite case and therefore lies in the same test.
     */
    it('sends the emptied verification claim, and defaults only the address claim', async () => {
      const bodies: unknown[] = [];
      routeFetch({
        onOidcPut: (body) => {
          bodies.push(body);
          return jsonResponse(
            200,
            oidcDocument({ emailClaim: 'upn', emailVerifiedClaim: '' }),
          );
        },
      });
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);

      const verified = await screen.findByLabelText<HTMLInputElement>(
        'Claim für „Adresse geprüft“',
      );
      fireEvent.change(verified, { target: { value: '  ' } });
      fireEvent.change(screen.getByLabelText('Claim mit der E-Mail-Adresse'), {
        target: { value: '' },
      });

      // The **second** „Speichern" button belongs to the OIDC block; the first
      // is the one of the colours (see `brandingSaveButton` above).
      const saves = screen.getAllByRole('button', { name: 'Speichern' });
      const oidcSave = saves.at(-1);
      if (oidcSave === undefined) {
        throw new Error('kein „Speichern" im OIDC-Block gefunden');
      }
      fireEvent.click(oidcSave);

      await waitFor(() => {
        expect(bodies).toHaveLength(1);
      });
      expect(bodies[0]).toMatchObject({
        emailClaim: 'email',
        emailVerifiedClaim: '',
      });
    });
  });

  /**
   * The requirement — the same shared shape (`use-server-draft.ts`) every
   * settings surface of this application has to survive, proven here for the
   * colour half of *Erscheinungsbild*.
   */
  describe('an entry made while the save is in flight', () => {
    async function renderWithStalledSave() {
      const pending = deferred<Response>();
      stubFetch().mockImplementation((input, init) => {
        const url = pathOf(input);
        if (url.endsWith('/tenant/branding') && init?.method === 'PUT') {
          return pending.promise;
        }
        if (url.endsWith('/tenant/branding')) {
          return Promise.resolve(jsonResponse(200, brandingDocument()));
        }
        if (url.endsWith('/tenant/oidc')) {
          return Promise.resolve(jsonResponse(403, { message: 'nope' }));
        }
        return Promise.resolve(jsonResponse(404, { message: 'not found' }));
      });
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Voller Name')).toBeDefined();
      });
      return pending;
    }

    function nameField(): HTMLInputElement {
      return screen.getByLabelText<HTMLInputElement>('Voller Name');
    }

    it('survives the answer, and the comparison state follows it', async () => {
      const pending = await renderWithStalledSave();

      fireEvent.change(nameField(), { target: { value: 'Erster Versuch' } });
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => {
        expect(screen.getByText('Wird gespeichert…')).toBeDefined();
      });

      fireEvent.change(nameField(), {
        target: { value: 'Während des Speicherns getippt' },
      });
      pending.resolve(
        jsonResponse(
          200,
          brandingDocument({ name: 'Erster Versuch', revision: 5 }),
        ),
      );

      await waitFor(() => {
        expect(screen.queryByText('Wird gespeichert…')).toBeNull();
      });
      expect(nameField().value).toBe('Während des Speicherns getippt');
      expect(screen.getByText('Nicht gespeichert')).toBeDefined();
    });
  });
  /**
   * **A colour that breaks the contrast is reported — not refused**.
   *
   * Three assurances, and the third is the one that made it in here, because it
   * *can* go wrong: a message that prevents the saving out of care would have
   * turned the decision into its opposite, and neither of the other two would
   * have seen that.
   */
  describe('die Meldung an der Farbwahl ', () => {
    /** The accent, whose field carries the message. */
    function accentField(): HTMLInputElement {
      return screen.getByLabelText<HTMLInputElement>(
        'Akzent (Buttons, Fortschritt)',
      );
    }

    async function renderAppearance(accent: string) {
      const fetchMock = routeFetch({
        branding: brandingDocument({ accent }),
      });
      renderWithQuery(<TenantAppearanceTab tenantId={TENANT_ID} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Voller Name')).toBeDefined();
      });
      return fetchMock;
    }

    it('erscheint für einen Mittelton, den keine der beiden Tinten trägt', async () => {
      await renderAppearance('#7f7f7f');

      // „Fläche" — the key word that says *which* of the two cases is
      // present; a yellow box alone says it to nobody.
      expect(screen.getByText('Fläche:')).toBeDefined();
      // The sentence that somebody without a WCAG table understands as well
      // (finding 13): what is going on, and from which value it is enough. The
      // metric stands next to it, not in front of it.
      expect(
        screen.getByText(/für weiße Schrift zu hell, für dunkle zu dunkel/u),
      ).toBeDefined();
      // Both messages — Fläche and Schrift — carry the side note, hence
      // `getAllByText`: a message without it would be a claim without evidence.
      expect(screen.getAllByText(/nötig sind 4,5:1/u)).toHaveLength(2);

      // And it hangs off the input, not next to it.
      const describedBy = accentField().getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(
        document.getElementById(String(describedBy))?.textContent,
      ).toContain('Fläche');
    });

    it('erscheint nicht für eine Farbe, die hält', async () => {
      // The admin red: 11,10:1 as a surface as much as as text. Without this
      // counter-check the assertion above only measures that an element is there.
      await renderAppearance('#7c0800');

      expect(screen.queryByText('Fläche:')).toBeNull();
      expect(screen.queryByText('Schrift:')).toBeNull();
      expect(accentField().getAttribute('aria-describedby')).toBeNull();
    });

    it('hindert das Speichern nicht — die Farbe geht an den Server, wie sie ist', async () => {
      const fetchMock = await renderAppearance('#7f7f7f');

      // Change something, so that „Speichern" is armed at all…
      fireEvent.change(screen.getByLabelText('Voller Name'), {
        target: { value: 'Organisation mit Mittelton' },
      });

      // …and the message stands visibly on the page while doing so.
      expect(screen.getByText('Fläche:')).toBeDefined();

      const save = brandingSaveButton();
      expect(save.disabled).toBe(false);
      fireEvent.click(save);

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
        ).toBe(true);
      });
      const [, init] = lastPut(fetchMock);
      const body = bodyOf(init) as Record<string, unknown>;
      // Unchanged, not "corrected": it is the colour of the organisation.
      expect(body.accent).toBe('#7f7f7f');
    });
  });
});
