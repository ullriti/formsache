import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TENANT_LEGAL_PAGES } from '@formsache/shared';

import { jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantLegalTab } from './TenantLegalTab';

/**
 * *Rechtstexte* of an organisation — **a refused write marks the field that
 * caused it, and only that one** (ADR-0028 no. 9).
 *
 * The same measurement as on the installation's tab, and for the same reason:
 * both documents travel in one `PUT`, the server names its findings
 * `pages.<seite>.…`, and „Telefonnummer" exists on the Anbieterangaben and on
 * the Datenschutzhinweise alike. A test that only asked whether a message
 * appeared anywhere would stay green even if it appeared on both cards.
 */

const MESSAGE = 'Höchstens 2000 Zeichen.';
const CUSTOM_MESSAGE = 'Höchstens 20000 Zeichen.';

interface WireIssue {
  readonly path: string;
  readonly message: string;
}

/** The loaded tab, whose next `PUT` is refused with the given field findings. */
async function renderRefusing(issues: readonly WireIssue[]): Promise<void> {
  stubFetch().mockImplementation((_input, init) =>
    Promise.resolve(
      init?.method === 'PUT'
        ? jsonResponse(400, {
            message: 'Die Anfrage ist ungültig.',
            issues,
            issueCount: issues.length,
          })
        : jsonResponse(200, { pages: EMPTY_TENANT_LEGAL_PAGES, lock: 2 }),
    ),
  );
  renderWithQuery(
    <TenantLegalTab
      tenantId="t-1"
      tenantName="Beispielverein"
      tenantShortName="beispiel"
    />,
  );

  await waitFor(() => {
    expect(card('Anbieterangaben')).toBeDefined();
  });
}

/** One of the two cards — `<section>` with the title of its template. */
function card(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * ⚠️ **„Telefonnummer (optional)"** — die Beschriftung trägt seit Review-Runde 5
 * (Nachtrag) das Wort mit, weil das Feld freiwillig ist und die Seite nicht
 * unvollständig macht (`LegalSlot.optional`). Die Fälle unten fragen deshalb
 * nach der vollen Beschriftung; ein `getByLabelText(PHONE_LABEL)` fände sie
 * nicht mehr, und genau das ist die Absicht: die Beschriftung ist nutzersichtbar
 * und ihre Änderung soll auffallen.
 */
const PHONE_LABEL = 'Telefonnummer (optional)';

describe('TenantLegalTab', () => {
  it('zeigt den Befund an dem Feld der Seite, die der Server benannt hat', async () => {
    await renderRefusing([
      { path: 'pages.imprint.fills.TELEFONNUMMER', message: MESSAGE },
    ]);

    const imprint = card('Anbieterangaben');
    const privacy = card('Datenschutzhinweise');

    // Something has to be dirty before „Speichern" is offered at all.
    fireEvent.change(within(imprint).getByLabelText(PHONE_LABEL), {
      target: { value: '030 123456' },
    });
    save();

    await waitFor(() => {
      expect(within(imprint).getByText(MESSAGE)).toBeDefined();
    });
    const marked =
      within(imprint).getByLabelText<HTMLInputElement>(PHONE_LABEL);
    expect(marked.getAttribute('aria-invalid')).toBe('true');
    // On the field, not merely beside it: a screen reader reads the sentence on
    // entering the field.
    expect(marked.getAttribute('aria-describedby')).toContain(
      within(imprint).getByText(MESSAGE).id,
    );

    // The Datenschutzhinweise carry a „Telefonnummer" of their own. It stays
    // untouched — that is the whole point of the page name in the path.
    expect(within(privacy).queryByText(MESSAGE)).toBeNull();
    expect(
      within(privacy)
        .getByLabelText<HTMLInputElement>(PHONE_LABEL)
        .getAttribute('aria-invalid'),
    ).toBeNull();
  });

  it('markiert „Eigener Text" nur auf der benannten Seite', async () => {
    await renderRefusing([
      { path: 'pages.privacy.custom', message: CUSTOM_MESSAGE },
    ]);

    // Both cards into „Eigener Text", so that both really do have the field the
    // finding names — otherwise the negative expectation would hold for the
    // trivial reason that there is nothing there to mark.
    for (const title of ['Anbieterangaben', 'Datenschutzhinweise']) {
      fireEvent.click(
        within(card(title)).getByRole('radio', { name: 'Eigener Text' }),
      );
    }
    save();

    const privacy = card('Datenschutzhinweise');
    await waitFor(() => {
      expect(within(privacy).getByText(CUSTOM_MESSAGE)).toBeDefined();
    });
    expect(
      within(privacy)
        .getByLabelText<HTMLTextAreaElement>('Eigener Text', {
          selector: 'textarea',
        })
        .getAttribute('aria-invalid'),
    ).toBe('true');

    const imprint = card('Anbieterangaben');
    expect(within(imprint).queryByText(CUSTOM_MESSAGE)).toBeNull();
    expect(
      within(imprint)
        .getByLabelText<HTMLTextAreaElement>('Eigener Text', {
          selector: 'textarea',
        })
        .getAttribute('aria-invalid'),
    ).toBeNull();
  });
});

/**
 * **Die Gegenprobe zur Karte der Installation** (Review-Runde 5 Nr. 2): hier
 * *muss* der Vorbehalt stehen. Eine Organisation darf die KI-Einstellungen nicht
 * sehen, also **nimmt** diese Vorschau „KI aus" an — und sagt es, statt so zu
 * tun, als wüsste sie es (`aiStateKnown` bleibt hier aus).
 */
describe('der Satz unter der Vorschau', () => {
  it('nennt den Vorbehalt zum Absatz über die KI', async () => {
    await renderRefusing([]);

    expect(
      within(card('Anbieterangaben')).getAllByText(
        /Abschnitte, die von der Konfiguration der Installation abhängen/u,
      ).length,
    ).toBe(1);
  });
});
