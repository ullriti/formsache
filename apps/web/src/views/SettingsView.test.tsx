import {
  REDACTED_PASSWORD,
  SYSTEM_FORM_SETTINGS,
  omitAvailabilityKeys,
} from '@formsache/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred } from '../test/deferred';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { permissions } from '../test/fixtures';
import { renderWithQuery } from '../test/render-with-query';
import { SettingsView } from './SettingsView';

/**
 * Form settings.
 *
 * The point of these tests is the sentence the requirement insists on: a locked
 * section is **gesperrt, nicht nur blass**. That is asserted twice — once
 * through the browser's own `disabled` state, and once on the wire, where a
 * value belonging to a locked section must not appear in the saved document.
 * Colour and opacity are deliberately not asserted; they are the part a
 * screenshot can show.
 */

const FORM_ID = '019fe700-0000-7000-8000-000000000001';

/**
 * What the organisation prescribes — **without *Verfügbarkeit***, because it does
 * not have that one (ADR-0011, continuation 2026-08-14).
 */
const TENANT_DEFAULTS = omitAvailabilityKeys({
  ...SYSTEM_FORM_SETTINGS,
  confirmTitle: 'Vielen Dank für Ihre Anmeldung!',
  confirmMsg: 'Ihre Angaben wurden gespeichert.',
});

/** What applies to this form: the defaults plus its own deadline. */
const EFFECTIVE = {
  ...SYSTEM_FORM_SETTINGS,
  ...TENANT_DEFAULTS,
  openEnabled: true,
  openAt: '2026-05-31T22:00:00.000Z',
  closeAt: '2026-08-15T21:59:00.000Z',
  maxResponsesEnabled: true,
  maxResponses: 300,
};

function settingsDocument(overrides: Record<string, unknown> = {}) {
  return {
    overridden: {
      access: false,
      confirm: false,
      display: false,
      budget: false,
    },
    values: {
      openEnabled: true,
      openAt: '2026-05-31T22:00:00.000Z',
      closeAt: '2026-08-15T21:59:00.000Z',
      maxResponsesEnabled: true,
      maxResponses: 300,
    },
    tenantDefaults: TENANT_DEFAULTS,
    effective: EFFECTIVE,
    revision: 4,
    tenantRevision: 9,
    ...overrides,
  };
}

function formDetail() {
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
    definition: { pages: [{ id: FORM_ID, title: 'Seite 1', questions: [] }] },
    hasUnpublishedChanges: true,
  };
}

/** The URL of a `fetch` argument, whichever of its three shapes it is. */
function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * Answers the two GETs by path, not by call order: the view starts both
 * queries at once and their order is TanStack Query's business.
 *
 * **The `PUT` answers with a *different* document than the `GET`** — the
 * server's answer to a write is the new baseline, and it is not the document
 * that was loaded: it carries the values `setSectionOverride` copied and the
 * bumped revisions. A stub that returned the same object for both could never
 * catch a view that ignores the answer, and it was written that way once.
 */
function stubSettings(loaded = settingsDocument(), written = savedDocument()) {
  return stubFetch().mockImplementation((input, init) =>
    Promise.resolve(
      requestPath(input).endsWith('/settings')
        ? jsonResponse(200, init?.method === 'PUT' ? written : loaded)
        : jsonResponse(200, formDetail()),
    ),
  );
}

/** What the server answers a write with: section taken over, revisions moved. */
function savedDocument() {
  return settingsDocument({
    overridden: { access: true, confirm: false, display: false, budget: false },
    values: { ...TENANT_DEFAULTS },
    revision: 5,
    tenantRevision: 9,
  });
}

async function renderLoaded(document = settingsDocument()) {
  const fetchMock = stubSettings(document);
  renderWithQuery(<SettingsView formId={FORM_ID} />);
  await waitFor(() => {
    expect(
      screen.getByRole('heading', { name: 'Formular-Einstellungen' }),
    ).toBeDefined();
  });
  return fetchMock;
}

/** The body of the last `PUT` the view sent. */
function lastWrite(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const writes = fetchMock.mock.calls.filter(
    ([, init]) => init?.method === 'PUT',
  );
  const last = writes[writes.length - 1];
  if (last === undefined) {
    throw new Error('No PUT was sent.');
  }
  const body = last[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('The PUT carried no JSON body.');
  }
  return JSON.parse(body);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the settings page', () => {
  it('shows the four sections of the handoff', async () => {
    await renderLoaded();

    for (const heading of [
      'Verfügbarkeit',
      'Zugriff & Sicherheit',
      'Nach dem Absenden',
      'Darstellung',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeDefined();
    }
  });

  /**
   * The takeover notice belongs on **every** card. Switching a section to
   * „Angepasst" copies the organisation's current values into this form and cuts the
   * section off from the organisation's later changes — that is one mechanic and it
   * applies to all four sections alike. The notice sat on *Zugriff &
   * Sicherheit* alone at first, which read as if the other three kept
   * following the organisation.
   *
   * Counted, not found once: four inherited cards, four notices —
   * *Verfügbarkeit* is the fifth card and has none, because there is nothing
   * to take over. Narrowing it back to one section leaves one and turns this
   * red.
   */
  it('says on every inherited card that taking a section over copies the organisation’s values', async () => {
    await renderLoaded();

    expect(
      screen.getAllByText(
        /spätere Änderungen der Organisation gelten für dieses Formular dann nicht mehr/,
      ),
    ).toHaveLength(4);
  });

  /**
   * Same mechanic, one heavier consequence: the access word
   * is copied along, so an organisation that changes its own — because it leaked —
   * revokes nothing here. That sentence stays on the one card it is true of;
   * putting it on all four would say the other three carry a password.
   */
  it('names the access word only in the notice on „Zugriff & Sicherheit"', async () => {
    await renderLoaded();

    const sharper = screen.getAllByText(
      /lässt dieses Formular weiter mit dem alten Wort herein/,
    );

    expect(sharper).toHaveLength(1);
    expect(
      sharper[0]?.closest('section')?.querySelector('h2')?.textContent,
    ).toBe('Zugriff & Sicherheit');
  });

  /**
   * The one setting of the handoff this application deliberately does not
   * build („Ein Setting des Handoffs fehlt hier"). Absent,
   * not disabled — a control that does nothing promises a function all the
   * same.
   *
   * „Zwischenspeichern erlauben" used to be dropped for the same reason and is
   * now live — the switch is asserted below, at the field it
   * actually controls.
   */
  it('shows no „Nur eine Antwort pro Person"', async () => {
    await renderLoaded();

    expect(screen.queryByText(/Nur eine Antwort pro Person/)).toBeNull();
  });

  /**
   * The requirement, Konzept no. 58 — the switch that makes `allowSaveDraft`
   * scharf, in the section its neighbour `allowEdit` lives in, with the same
   * inheritance the other three sections carry.
   *
   * Two things a review of this requirement would look for and neither is
   * decoration: the note names **both** halves of the cost — the link is shown
   * rather than mailed, and holding it is enough to open the half-filled form
   * — and it is attached to the switch (`aria-describedby`) rather than
   * sitting loose on the page.
   */
  it('offers „Zwischenspeichern erlauben", with the cost named at the switch', async () => {
    await renderLoaded();

    const toggle = screen.getByLabelText('Zwischenspeichern erlauben');
    // On, because the application's default has been so since review finding 16 —
    // this form inherits it (`SYSTEM_FORM_SETTINGS.allowSaveDraft`).
    expect((toggle as HTMLInputElement).checked).toBe(true);

    const described = (toggle.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    expect(described).toMatch(/nicht per E-Mail verschickt/);
    expect(described).toMatch(/Konto oder Passwort ist dafür nicht nötig/);
  });

  /**
   * The write path: taking „Zugriff & Sicherheit" over and flipping the switch
   * reaches the saved document — the same shape `carries all four switches and
   * both revisions` below asserts, narrowed to this one field.
   */
  it('writes allowSaveDraft when the section is taken over and the switch flipped', async () => {
    // The default is „an" (review finding 16), the click below turns it into
    // „aus" — the direction is immaterial for this case, what is checked is
    // that the switch of the taken-over section reaches the wire.
    const fetchMock = await renderLoaded();

    // access, confirm, display, budget — the same order `SECTION_DEFINITIONS`
    // and the other tests in this file use. *Verfügbarkeit* is a card without a
    // switch, so it contributes none.
    const [accessSwitch] = screen.getAllByRole('radio', {
      name: 'Angepasst',
    });
    if (accessSwitch === undefined) {
      throw new Error('No inheritance switch for „Zugriff & Sicherheit".');
    }
    fireEvent.click(accessSwitch);

    await waitFor(() => {
      expect(
        screen.getByLabelText('Zwischenspeichern erlauben').closest('fieldset')
          ?.disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByLabelText('Zwischenspeichern erlauben'));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(lastWrite(fetchMock)).toBeDefined();
    });
    const body = lastWrite(fetchMock) as { values: Record<string, unknown> };
    expect(body.values.allowSaveDraft).toBe(false);
  });

  /**
   * The requirement — „diese Grenze steht auch in der Oberfläche, dort wo der
   * Bearbeiter den Schalter setzt, und nicht nur in diesem Dokument."
   *
   * The time limit is enforced with a signed start token, and reloading the
   * page mints a new one. An editor who reads only
   * „nach Ablauf wird nicht mehr angenommen" would take it for a barrier.
   *
   * Two things are checked and neither is decoration: the note names the
   * reload, and it is **attached to the time-limit switch** rather than sitting
   * somewhere on the page — and it is there while the switch is still off,
   * because that is when the decision is made.
   */
  it('names the reload gap of the time limit, at the switch and before it is on', async () => {
    await renderLoaded();

    const toggle = screen.getByLabelText('Zeitlimit pro Ausfüllung');
    expect((toggle as HTMLInputElement).checked).toBe(false);

    const described = (toggle.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    expect(described).toMatch(/neu lädt/);
    expect(described).toMatch(/verhindert kein absichtliches Umgehen/);
  });

  /**
   * **The consequence of setting the access word is
   * named before the save, not after it.**
   *
   * Switching the password protection on, or changing the word, clears the edit
   * links this form has already handed out (that is what keeps the requirement
   * true for editing after submission, too). That is a user-visible loss on a
   * screen belonging to somebody else: participants who submitted can no
   * longer correct their registration. The same shape as the note at the time
   * limit — attached to the switch through `aria-describedby`, and present
   * **while the switch is still off**, because that is when the decision
   * gets made.
   */
  it('warns at the password switch that saving revokes the edit links', async () => {
    await renderLoaded();

    const toggle = screen.getByLabelText('Passwortschutz');
    expect((toggle as HTMLInputElement).checked).toBe(false);

    const described = (toggle.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    expect(described).toMatch(/Bearbeiten-Link/);
    expect(described).toMatch(/geändert/);
    // …and that switching the protection *off* is not the same thing.
    expect(described).toMatch(/Ausschalten/);
  });

  /**
   * **The withheld access word** (ADR-0021, a security finding).
   *
   * An `editor` gets the organisation's default with
   * {@link REDACTED_PASSWORD} instead of the word. Up to here the
   * placeholder landed raw in the field — a character sequence with a NUL byte that looks like a
   * defect — and taking the section over would have copied the word,
   * so the redaction would have been one click away from ineffective.
   */
  describe('ein Zugangswort, das der Server zurückhält', () => {
    /** The answer as an `editor` gets it: protection on, word redacted. */
    function withheldDocument() {
      return settingsDocument({
        tenantDefaults: {
          ...TENANT_DEFAULTS,
          passwordEnabled: true,
          password: REDACTED_PASSWORD,
        },
        effective: {
          ...EFFECTIVE,
          passwordEnabled: true,
          password: REDACTED_PASSWORD,
        },
      });
    }

    /** The input field and the sentence that belongs to it per `aria-describedby`. */
    function passwordField(): {
      readonly input: HTMLInputElement;
      readonly described: string;
    } {
      const input: HTMLInputElement = screen.getByLabelText('Zugangspasswort');
      const described = (input.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      return { input, described };
    }

    it('zeigt eine lesbare Aussage statt des Platzhalters', async () => {
      await renderLoaded(withheldDocument());

      const { input, described } = passwordField();
      // **The placeholder stands nowhere** — neither in the field nor anywhere else on the
      // page. That is the actual assertion; the rest is the question of
      // what stands there instead.
      expect(input.value).toBe('');
      expect(document.body.textContent).not.toContain(REDACTED_PASSWORD);

      // Eye and screen reader get the same sentence: it stands as a paragraph
      // under the field **and** in `aria-describedby`, not as a `title` and
      // not as grey type alone.
      expect(described).toMatch(/Von der Organisation gesetzt/);
      expect(described).toMatch(/nicht sichtbar/);
      // …and it says why the field cannot be edited.
      expect(described).toMatch(/„Angepasst"/);
    });

    /**
     * The counter-check: a visible word still stands in the field. Without it
     * the case above would also be green for a page that always empties the field.
     */
    it('zeigt ein sichtbares Wort unverändert', async () => {
      await renderLoaded(
        settingsDocument({
          tenantDefaults: {
            ...TENANT_DEFAULTS,
            passwordEnabled: true,
            password: 'Jahrestagung2026',
          },
          effective: {
            ...EFFECTIVE,
            passwordEnabled: true,
            password: 'Jahrestagung2026',
          },
        }),
      );

      expect(passwordField().input.value).toBe('Jahrestagung2026');
    });

    /**
     * **Before the click, not after it.** The card's ⓘ notice stands
     * regardless of which side of the switch the section is currently
     * on — that is what an editor needs *before* they take over.
     */
    it('sagt auf der Karte, dass das Wort nicht mit übernommen wird', async () => {
      await renderLoaded(withheldDocument());

      expect(
        screen.getByText(
          /nicht sichtbar und wird beim Übernehmen nicht mitkopiert/,
        ),
      ).toBeDefined();
      expect(
        screen.getByText(/ohne Passwortschutz, bis hier ein eigenes/),
      ).toBeDefined();
      // And the sentence for the *visible* case — „das alte Wort lässt weiter
      // herein" — is then precisely **not** there: it would simply be wrong.
      expect(
        screen.queryByText(/lässt dieses Formular weiter mit dem alten Wort/),
      ).toBeNull();
    });

    /**
     * And what the click does: protection off, field empty — the same state the
     * server will write (`copyableTenantDefaults`). A screen that
     * went on showing „Passwortschutz: an" here would be saying something other than the
     * column, and on the next load the switch would have flipped by
     * itself.
     */
    it('nimmt Schutz und Wort zurück, sobald der Abschnitt übernommen wird', async () => {
      const fetchMock = await renderLoaded(withheldDocument());

      // The first one is that of *Zugriff & Sicherheit* — the order of the
      // cards stands in `SECTION_DEFINITIONS`.
      const [accessSwitch] = screen.getAllByRole('radio', {
        name: 'Angepasst',
      });
      if (accessSwitch === undefined) {
        throw new Error('No inheritance switch on the page.');
      }
      fireEvent.click(accessSwitch);

      const toggle: HTMLInputElement = screen.getByLabelText('Passwortschutz');
      expect(toggle.checked).toBe(false);
      // The field lies in the switch's additional entries and is gone with it —
      // a password field beside a switched-off protection would invite the reading
      // that it still counts (see `ToggleSetting`).
      expect(screen.queryByLabelText('Zugangspasswort')).toBeNull();

      // Whoever wants to keep the protection switches it on again — and gets an
      // **empty** field, not the organisation's word.
      fireEvent.click(toggle);
      expect(passwordField().input.value).toBe('');

      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => {
        expect(lastWrite(fetchMock)).toMatchObject({
          overridden: {
            access: true,
            confirm: false,
            display: false,
            budget: false,
          },
          values: { password: '', passwordEnabled: false },
        });
      });
    });
  });

  describe('an inherited section', () => {
    it('says where its values come from', async () => {
      await renderLoaded();

      // All four inheritable sections stand on „Tenant-Standard", so
      // four of them say so. *Verfügbarkeit* does not: it inherits from nobody.
      expect(screen.getAllByText(/Standardwert vom Tenant/)).toHaveLength(4);
    });

    /**
     * The lock in the browser: `disabled` on the surrounding `<fieldset>`
     * reaches every control inside it, takes them out of the tab order and out
     * of reach of a click and of form submission. An opacity would have looked
     * identical and stopped nothing.
     *
     * Asserted on the fieldset rather than on `input.disabled`, because that
     * IDL property only ever reflects the control's *own* attribute — the
     * fieldset's reach is a separate concept in the DOM, and reading the
     * property would have made the test pass for a page with no lock at all.
     * That the reach is real in a browser is what the E2E case adds.
     */
    it('locks its fields rather than only dimming them', async () => {
      await renderLoaded();

      // Both halves of a locked card: a switch and a text field.
      const toggle = screen.getByLabelText('Passwortschutz');
      const title = screen.getByLabelText('Titel der Bestätigungsseite');

      expect(toggle.closest('fieldset')?.disabled).toBe(true);
      expect(title.closest('fieldset')?.disabled).toBe(true);
    });

    /**
     * …and *Verfügbarkeit* is never locked: it belongs to this form, with no
     * switch in front of it (ADR-0011, continuation 2026-08-14).
     */
    it('leaves the Verfügbarkeit fields open', async () => {
      await renderLoaded();

      expect(
        screen
          .getByRole('switch', { name: 'Antwortlimit gesamt' })
          .closest('fieldset')?.disabled,
      ).toBe(false);
    });

    it('unlocks the section once it is set to „Angepasst"', async () => {
      await renderLoaded();

      const [accessSwitch] = screen.getAllByRole('radio', {
        name: 'Angepasst',
      });
      if (accessSwitch === undefined) {
        throw new Error('No inheritance switch on the page.');
      }
      fireEvent.click(accessSwitch);

      await waitFor(() => {
        expect(
          screen.getByLabelText('Passwortschutz').closest('fieldset')?.disabled,
        ).toBe(false);
      });
      // One hint fewer than before: the other three sections still inherit.
      expect(screen.getAllByText(/Standardwert vom Tenant/)).toHaveLength(3);
    });

    /**
     * The lock on the wire — the half of the requirement that is checked „nicht nur
     * optisch". The change is forced past the disabled control the way
     * a script would force it; the saved document must not carry it.
     */
    it('does not save a value that was forced into a locked field', async () => {
      const fetchMock = await renderLoaded();

      const budget = screen.getByLabelText('Mails je Fenster');
      // Past the `disabled` attribute on purpose: this is the attempt the
      // requirement asks to see fail — a click alone would be swallowed by the
      // browser, and the requirement is about what happens when it is not.
      budget.removeAttribute('disabled');
      fireEvent.change(budget, { target: { value: '5' } });

      // Something has to be dirty for a save to be possible at all, so a
      // *different* section is taken over — the forced value must simply not
      // travel with it.
      const [confirmSwitch] = screen
        .getAllByRole('radio', { name: 'Angepasst' })
        .slice(1, 2);
      if (confirmSwitch === undefined) {
        throw new Error('No inheritance switch for „Nach dem Absenden".');
      }
      fireEvent.click(confirmSwitch);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Speichern' })).toBeDefined();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

      await waitFor(() => {
        expect(lastWrite(fetchMock)).toBeDefined();
      });
      const body = lastWrite(fetchMock) as { values: Record<string, unknown> };
      expect(body.values.maxResponses).toBeUndefined();
    });
  });

  describe('the write', () => {
    it('carries all four switches and both revisions', async () => {
      const fetchMock = await renderLoaded();

      const [firstSwitch] = screen.getAllByRole('radio', { name: 'Angepasst' });
      if (firstSwitch === undefined) {
        throw new Error('No inheritance switch on the page.');
      }
      fireEvent.click(firstSwitch);
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

      await waitFor(() => {
        expect(lastWrite(fetchMock)).toBeDefined();
      });

      expect(lastWrite(fetchMock)).toMatchObject({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: false,
        },
        revision: 4,
        tenantRevision: 9,
      });
    });
  });

  /**
   * The server's answer to a write becomes the new baseline. Without that, a
   * second save would echo back the revision of the *first* load and be
   * refused with a 409 the editor did nothing to deserve.
   */
  it('takes the revisions of the PUT answer as the new baseline', async () => {
    const fetchMock = await renderLoaded();

    const [firstSwitch] = screen.getAllByRole('radio', { name: 'Angepasst' });
    if (firstSwitch === undefined) {
      throw new Error('No inheritance switch on the page.');
    }
    fireEvent.click(firstSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(lastWrite(fetchMock)).toMatchObject({ revision: 4 });
    });

    // The page is now built on the answer, so a second write carries **its**
    // revision — 5, not the 4 the page was loaded with.
    fireEvent.change(
      screen.getByLabelText('Titel der Bestätigungsseite', {
        selector: 'input',
      }),
      { target: { value: 'Egal' } },
    );
    const [, , confirmSwitch] = screen.getAllByRole('radio', {
      name: 'Angepasst',
    });
    if (confirmSwitch === undefined) {
      throw new Error('No inheritance switch for „Nach dem Absenden".');
    }
    fireEvent.click(confirmSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(lastWrite(fetchMock)).toMatchObject({ revision: 5 });
    });
  });

  /**
   * The requirement — the race this view is the original report of: `onSuccess`
   * reset the draft unconditionally, so whoever kept typing during the round
   * trip watched the answer swallow the entry. The fix is shared with the other
   * two settings surfaces (`use-server-draft.ts`).
   *
   * Three different numbers on purpose: 300 was inherited, 150 was saved, 777
   * was typed in between. A test that only asked whether the field still holds
   * *something* would pass against the bug whenever the answer happened to
   * carry the same value.
   */
  describe('an entry made while the save is in flight', () => {
    /**
     * *Verfügbarkeit* needs no taking over any more — the fields are the form's
     * own and never locked.
     */
    const takenOver = settingsDocument();

    async function renderWithStalledSave() {
      const pending = deferred<Response>();
      stubFetch().mockImplementation((input, init) =>
        !requestPath(input).endsWith('/settings')
          ? Promise.resolve(jsonResponse(200, formDetail()))
          : init?.method === 'PUT'
            ? pending.promise
            : Promise.resolve(jsonResponse(200, takenOver)),
      );
      renderWithQuery(<SettingsView formId={FORM_ID} />);
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Formular-Einstellungen' }),
        ).toBeDefined();
      });
      return pending;
    }

    /** What the server answers with — a document, not an echo of the request. */
    function answeredWith(maxResponses: number) {
      return jsonResponse(
        200,
        settingsDocument({
          values: { maxResponsesEnabled: true, maxResponses },
          effective: { ...EFFECTIVE, maxResponses },
          revision: 5,
        }),
      );
    }

    function limitField(): HTMLInputElement {
      return screen.getByLabelText<HTMLInputElement>('Antwortlimit');
    }

    it('survives the answer, and the comparison state follows it', async () => {
      const pending = await renderWithStalledSave();

      fireEvent.change(limitField(), { target: { value: '150' } });
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => {
        expect(screen.getByText('Wird gespeichert…')).toBeDefined();
      });

      fireEvent.change(limitField(), { target: { value: '777' } });
      pending.resolve(answeredWith(150));

      await waitFor(() => {
        expect(screen.queryByText('Wird gespeichert…')).toBeNull();
      });
      expect(limitField().value).toBe('777');
      expect(screen.getByText('Nicht gespeichert')).toBeDefined();
    });

    /**
     * The control, and the reason `onSuccess` exists at all: the answer carries
     * what `setSectionOverride` copied, which this client deliberately does not
     * compute. With nothing typed in between it becomes the new baseline — the
     * stub answers with a value nobody entered, so „adopted" and „kept" are
     * distinguishable.
     */
    it('is not in the way when nothing was typed', async () => {
      const pending = await renderWithStalledSave();

      fireEvent.change(limitField(), { target: { value: '150' } });
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => {
        expect(screen.getByText('Wird gespeichert…')).toBeDefined();
      });

      pending.resolve(answeredWith(999));

      await waitFor(() => {
        expect(screen.getByText('Gespeichert')).toBeDefined();
      });
      expect(limitField().value).toBe('999');
    });
  });

  /**
   * The `null` regression, at the level an editor actually meets it: the field
   * must stay empty and the badge must stop announcing the deadline.
   */
  it('keeps an emptied deadline empty and drops it from the badge', async () => {
    await renderLoaded();

    const closeField = screen.getByLabelText<HTMLInputElement>('Schließt am');
    expect(closeField.value).not.toBe('');

    fireEvent.change(closeField, { target: { value: '' } });

    expect(screen.getByLabelText<HTMLInputElement>('Schließt am').value).toBe(
      '',
    );
    // The badge read „Geöffnet · bis 15.08.2026 …" a moment ago; it must not
    // keep announcing a deadline the field no longer holds.
    expect(screen.queryByText(/15\.08\.2026/)).toBeNull();
  });

  describe('the live status badge', () => {
    it('reads „Immer geöffnet" without a deadline', async () => {
      await renderLoaded(
        settingsDocument({ values: {}, effective: SYSTEM_FORM_SETTINGS }),
      );

      expect(screen.getByText('Immer geöffnet')).toBeDefined();
    });

    it('reads „Geschlossen" after the closing instant', async () => {
      const past = {
        ...SYSTEM_FORM_SETTINGS,
        openEnabled: true,
        closeAt: '2020-01-01T00:00:00.000Z',
      };
      await renderLoaded(
        settingsDocument({
          values: { openEnabled: true, closeAt: past.closeAt },
          effective: past,
        }),
      );

      expect(screen.getByText(/Geschlossen seit 01\.01\.2020/)).toBeDefined();
    });
  });

  it('previews the confirmation page live', async () => {
    await renderLoaded();

    expect(screen.getByText('Vorschau Bestätigungsseite')).toBeDefined();
    expect(
      screen.getAllByText('Vielen Dank für Ihre Anmeldung!').length,
    ).toBeGreaterThan(0);
  });

  /*
   * The proof for „Bestätigung an Teilnehmer senden" used to stand here — the
   * switch that could swallow a configured notification. It
   * is gone without replacement (review finding 24, 2026-08-14): whoever sets up a
   * notification to the person filling in has decided
   * that it gets sent. What takes its place is not a second
   * explanation but its absence.
   */
  it('shows no „Bestätigung an Teilnehmer senden"', async () => {
    await renderLoaded();

    expect(screen.queryByLabelText('Bestätigung an Teilnehmer senden')).toBe(
      null,
    );
  });

  it('offers the jump to the organisation’s standards', async () => {
    await renderLoaded();

    expect(
      screen.getByRole('button', { name: 'Tenant-Standards öffnen' }),
    ).toBeDefined();
  });

  it('reports a concurrent change instead of overwriting it', async () => {
    stubFetch().mockImplementation((input, init) =>
      Promise.resolve(
        !requestPath(input).endsWith('/settings')
          ? jsonResponse(200, formDetail())
          : init?.method === 'PUT'
            ? jsonResponse(409, { message: 'stale' })
            : jsonResponse(200, settingsDocument()),
      ),
    );
    renderWithQuery(<SettingsView formId={FORM_ID} />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Formular-Einstellungen' }),
      ).toBeDefined();
    });

    const [firstSwitch] = screen.getAllByRole('radio', { name: 'Angepasst' });
    if (firstSwitch === undefined) {
      throw new Error('No inheritance switch on the page.');
    }
    fireEvent.click(firstSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'zwischenzeitlich von jemand anderem geändert',
      );
    });
  });

  it('marks the field a 400 named', async () => {
    stubFetch().mockImplementation((input, init) =>
      Promise.resolve(
        !requestPath(input).endsWith('/settings')
          ? jsonResponse(200, formDetail())
          : init?.method === 'PUT'
            ? jsonResponse(400, {
                message: 'Ungültig',
                issues: [
                  {
                    path: 'values.closeAt',
                    message: '„Schließt am" muss nach „Öffnet am" liegen.',
                  },
                ],
              })
            : jsonResponse(200, settingsDocument()),
      ),
    );
    renderWithQuery(<SettingsView formId={FORM_ID} />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Formular-Einstellungen' }),
      ).toBeDefined();
    });

    const [firstSwitch] = screen.getAllByRole('radio', { name: 'Angepasst' });
    if (firstSwitch === undefined) {
      throw new Error('No inheritance switch on the page.');
    }
    fireEvent.click(firstSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      expect(
        screen.getByText('„Schließt am" muss nach „Öffnet am" liegen.'),
      ).toBeDefined();
    });
  });

  /**
   * **The privacy notice for this form** (ADR-0028 no. 4).
   *
   * The card stands on **this** page and not in the builder, because it hangs on the
   * `can_manage_form_settings` permission and not on `can_build` — ADR-0021
   * deliberately separated the two. What is measured here is the seam at
   * which the editing could go wrong: what is typed has to mark the page as
   * unsaved **and** land on the wire in full.
   */
  describe('der Datenschutzhinweis zu diesem Formular', () => {
    it('bietet die Felder der Vorlage an und schickt das ganze Dokument', async () => {
      const fetchMock = await renderLoaded();

      expect(
        screen.getByRole('heading', {
          name: 'Datenschutzhinweise zu diesem Formular',
        }),
      ).toBeDefined();

      const zweck = screen.getByLabelText('Zweck dieses Formulars');
      fireEvent.change(zweck, {
        target: { value: 'Anmeldung zur Jahrestagung 2026' },
      });

      const save = screen.getByRole('button', { name: 'Speichern' });
      // What is typed makes the page unsaved — otherwise a dead
      // button would stand above a changed field.
      expect(save.hasAttribute('disabled')).toBe(false);
      fireEvent.click(save);

      await waitFor(() => {
        expect(lastWrite(fetchMock)).toMatchObject({
          privacyNotice: {
            mode: 'template',
            fills: { ZWECK: 'Anmeldung zur Jahrestagung 2026' },
          },
        });
      });
    });

    /**
     * The notice is not a section value: it must not be thrown away along with
     * the switching of a section — the draft deliberately discards values
     * there.
     */
    it('überlebt das Übernehmen eines Abschnitts', async () => {
      const fetchMock = await renderLoaded();

      fireEvent.change(screen.getByLabelText('Zweck dieses Formulars'), {
        target: { value: 'Anmeldung' },
      });
      const [firstSwitch] = screen.getAllByRole('radio', { name: 'Angepasst' });
      if (firstSwitch === undefined) {
        throw new Error('No inheritance switch on the page.');
      }
      fireEvent.click(firstSwitch);
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

      await waitFor(() => {
        expect(lastWrite(fetchMock)).toMatchObject({
          privacyNotice: { fills: { ZWECK: 'Anmeldung' } },
        });
      });
    });
  });

  it('says so when the role may not see the settings', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        requestPath(input).endsWith('/settings')
          ? jsonResponse(403, { message: 'nope' })
          : jsonResponse(200, formDetail()),
      ),
    );
    renderWithQuery(<SettingsView formId={FORM_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'darf die Einstellungen dieses Formulars nicht sehen',
      );
    });
  });
});
