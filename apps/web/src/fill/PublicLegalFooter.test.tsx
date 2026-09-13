import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseMitCopyright } from '@formsache/shared';

import softwareLicence from '../../../../LICENSE?raw';
import { renderWithQuery } from '../test/render-with-query';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { PublicLegalFooter } from './PublicLegalFooter';

/**
 * **The footer is the actual achievement of this undertaking**
 * (ADR-0028, `docs/legal/README.md` 5.3) — and what it achieves is the
 * **label**, not the link.
 *
 * Two imprints without an assignment are worse than one: the participating
 * person then cannot tell whom they have to turn to with a
 * request for information, and Art. 13 Abs. 1 lit. a demands exactly
 * that recognisability. This file therefore does not measure *that* links are there
 * but **under which heading** they stand.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('die Fußzeile unter einer öffentlichen Ansicht', () => {
  it('ordnet jeden Link seiner Herkunft zu', async () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: 'Beispiel-Betrieb e. V.',
      }),
    );

    renderWithQuery(
      <PublicLegalFooter
        organisation={{ shortName: 'MUST', name: 'Musterverein e. V.' }}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Rechtliche Angaben' });

    // The organisation first: it is the controller for the data that is about
    // to be collected.
    const lists = within(nav).getAllByRole('list');
    expect(lists).toHaveLength(2);
    const [organisation, installation] = lists as [HTMLElement, HTMLElement];

    expect(
      within(organisation)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Anbieterangaben', '/o/MUST/imprint'],
      ['Datenschutzhinweise', '/o/MUST/privacy'],
    ]);

    /*
      Die Reihenfolge ist die Aussage, deshalb ein Vergleich der ganzen Liste
      und keine Teilmenge. Alle drei stehen unbedingt da — der eine bedingte
      Verweis, die Erklärung zur Barrierefreiheit, ist mit ihrer Seite fort
      (Review-Runde 4 Nr. 4).
    */
    expect(
      within(installation)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Impressum', '/imprint'],
      ['Datenschutz', '/privacy'],
      ['Lizenzen', '/licences'],
    ]);

    /*
      And the label names both sides of the responsibility — **with the name
      on a line of its own** (review round 3 no. 8). The accessible name is
      therefore the two blocks joined by a space, not by a colon: that is
      exactly what the change is, and a test that still expected the colon
      would be the one that keeps the old shape alive.
    */
    expect(
      within(nav).getByRole('heading', {
        name: 'Verantwortlich für dieses Formular Musterverein e. V.',
      }),
    ).toBeDefined();
    expect(
      await within(nav).findByRole('heading', {
        name: 'Betrieb dieser Plattform Beispiel-Betrieb e. V.',
      }),
    ).toBeDefined();
  });

  /**
   * **The link stands always** (`docs/legal/README.md` 5.4).
   *
   * A missing link would make the deficiency invisible. A missing imprint
   * is a violation with or without a link — only with a link is it remediable.
   */
  it('zeigt alle Links auch, wenn der Name des Betriebs nicht zu holen ist', async () => {
    stubFetch().mockRejectedValue(new Error('offline'));

    renderWithQuery(<PublicLegalFooter organisation={{ shortName: 'MUST' }} />);

    const nav = await screen.findByRole('navigation', {
      name: 'Rechtliche Angaben',
    });
    // Drei der Installation und zwei der Organisation — alle unbedingt, auch
    // ohne Antwort des Servers.
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    // Without a name the label stands on its own — which is true. Guessing the
    // name would not be.
    expect(
      within(nav).getByRole('heading', { name: 'Betrieb dieser Plattform' }),
    ).toBeDefined();
  });

  it('lässt den Organisationsblock weg, wo es keine Organisation gibt', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: null,
      }),
    );

    renderWithQuery(<PublicLegalFooter />);

    const nav = screen.getByRole('navigation', { name: 'Rechtliche Angaben' });
    expect(
      within(nav).queryByRole('heading', {
        name: /Verantwortlich für dieses Formular/u,
      }),
    ).toBeNull();
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
  });

  /**
   * **No blanket reservation of copyright** (`docs/legal/README.md` 3.7).
   *
   * „© [Betreiber] — Alle Rechte vorbehalten" would be a false statement about
   * somebody else's rights: the software is under MIT, the typeface under the
   * ParaType Free Font License, the form contents belong to the organisation
   * and the answers to the participating person.
   */
  /**
   * **The privacy notice for this form** (ADR-0028 no. 4).
   *
   * What is measured is the order, because it is the decision: the
   * form-specific notice stands **above** the route to the organisation's
   * general notices — from the particular to the general, because purpose
   * and legal basis are to be stated per processing under Art. 13 Abs. 1 lit. c
   * and this processing is the form.
   */
  it('stellt den Hinweis zu diesem Formular über den Weg zur Organisation', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: 'Beispiel-Betrieb e. V.',
      }),
    );

    renderWithQuery(
      <PublicLegalFooter
        organisation={{ shortName: 'MUST', name: 'Musterverein e. V.' }}
        privacyNotice={{
          title: 'Datenschutzhinweise zu diesem Formular',
          blocks: [
            {
              kind: 'paragraph',
              runs: [{ kind: 'text', text: 'Anmeldung zur Jahrestagung 2026' }],
            },
          ],
        }}
      />,
    );

    const notice = screen.getByRole('region', {
      name: 'Datenschutzhinweise zu diesem Formular',
    });
    expect(notice.textContent).toContain('Anmeldung zur Jahrestagung 2026');

    // The order in the document: first the notice, then the navigation.
    const nav = screen.getByRole('navigation', { name: 'Rechtliche Angaben' });
    expect(
      notice.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // And the route to the general notices stays where it was.
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toContain('/o/MUST/privacy');
  });

  /**
   * If the notice is missing, **nothing** stands here — no substitute text and no
   * error message. The organisation's general statement may suffice for this
   * form; „hier fehlt etwas" would be a message to exactly the
   * organisation at which nothing is missing.
   */
  it('zeigt ohne hinterlegten Hinweis keinen Ersatztext', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: 'Beispiel-Betrieb e. V.',
      }),
    );

    const { container } = renderWithQuery(
      <PublicLegalFooter
        organisation={{ shortName: 'MUST', name: 'Musterverein e. V.' }}
        privacyNotice={null}
      />,
    );

    expect(screen.queryByRole('region')).toBeNull();
    expect(container.textContent).not.toContain(
      'Datenschutzhinweise zu diesem',
    );
  });

  /**
   * **Review-Runde 5 Nr. 1 — kein Wort über das, was fehlt.**
   *
   * Hier stand der Gegentest: eine angefangene Fassung trug den Hinweis „Diese
   * Angaben sind unvollständig. Es fehlt: …" und im Text die Marke „Angabe
   * fehlt: Rechtsgrundlage". Beides ist weg, und der Grund ist der Befund:
   * *„unvollständige Angaben sollten nicht in der öffentlichen Ansicht
   * angezeigt werden."*
   *
   * Was geprüft wird, ist deshalb die **Gegenrichtung**, und zwar mit einer
   * Nutzlast, die es so nicht mehr gibt: selbst wenn der Server einen Zustand
   * und eine Lücke mitschickte, zeigt diese Ansicht keinen Hinweis darüber.
   * Sie hat keine Bedingung mehr, die einen zeigen könnte.
   */
  it('zeigt über einer angefangenen Fassung keinen Hinweis auf das Fehlende', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: 'Beispiel-Betrieb e. V.',
      }),
    );

    renderWithQuery(
      <PublicLegalFooter
        organisation={{ shortName: 'MUST', name: 'Musterverein e. V.' }}
        privacyNotice={{
          title: 'Datenschutzhinweise zu diesem Formular',
          blocks: [
            {
              kind: 'paragraph',
              runs: [{ kind: 'text', text: 'Zweck: Anmeldung zur Tagung' }],
            },
          ],
        }}
      />,
    );

    const notice = screen.getByRole('region', {
      name: 'Datenschutzhinweise zu diesem Formular',
    });
    expect(notice.textContent).toContain('Zweck: Anmeldung zur Tagung');
    expect(notice.textContent).not.toContain('unvollständig');
    expect(notice.textContent).not.toContain('Es fehlt');
  });

  it('nennt die Lizenz der Software und behauptet keine eigenen Rechte', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: 'Beispiel-Betrieb e. V.',
      }),
    );

    const { container } = renderWithQuery(<PublicLegalFooter />);

    expect(container.textContent).toContain('MIT-Lizenz');
    expect(container.textContent).not.toContain('Alle Rechte vorbehalten');
    /*
      **Und sie nennt die Urheberin oder den Urheber** (Review-Runde 3 Nr. 10).
      Bis hierher stand der Name ausschließlich im eingebetteten Lizenztext auf
      `/licences`. Geprüft wird gegen `LICENSE` selbst, nicht gegen einen
      getippten Namen — sonst wäre dieser Test die zweite Wahrheit, gegen die
      `parseMitCopyright` gebaut ist.
    */
    expect(container.textContent).toContain(
      parseMitCopyright(softwareLicence).holder,
    );
    expect(container.textContent).toMatch(/©\s*\d{4}/u);
  });
});
