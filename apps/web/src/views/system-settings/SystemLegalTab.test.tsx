import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SYSTEM_LEGAL_PAGES } from '@formsache/shared';

import { jsonResponse, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { SystemLegalTab } from './SystemLegalTab';

/**
 * *Rechtstexte* of the installation — **a refused write marks the field that
 * caused it, and only that one** (ADR-0028 no. 9).
 *
 * Three documents stand on this screen in one payload, so the server names its
 * findings `pages.<seite>.…`. What is measured here is therefore not „somewhere
 * a message appears" — it is that the message stands **in the card the server
 * named** and **not** in the card next to it, which carries a field of the very
 * same name.
 *
 * *Reproduction:* let `ISSUE_PREFIXES` (`views/api-messages.ts`) learn a
 * pattern `pages.*.` instead of the cards shortening their own prefix with
 * `issuesUnder` — the positive expectations stay green and every negative one
 * turns red, because „Name des Betreibers" exists in the Impressum and in the
 * Datenschutzerklärung alike.
 */

const MESSAGE = 'Höchstens 2000 Zeichen.';
const CUSTOM_MESSAGE = 'Höchstens 20000 Zeichen.';

interface WireIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The loaded tab, whose next `PUT` is refused with the given field findings.
 *
 * `aiActive` gehört seit Review-Runde 5 Nr. 2 zur Antwort — ohne ihn scheitert
 * schon das Lesen (`systemLegalResponseSchema`). Hier steht `false`, weil diese
 * Fälle von Feldbefunden reden; der Fall, der von der KI redet, setzt ihn
 * ausdrücklich.
 */
async function renderRefusing(
  issues: readonly WireIssue[],
  aiActive = false,
): Promise<void> {
  stubFetch().mockImplementation((_input, init) =>
    Promise.resolve(
      init?.method === 'PUT'
        ? jsonResponse(400, {
            message: 'Die Anfrage ist ungültig.',
            issues,
            issueCount: issues.length,
          })
        : jsonResponse(200, {
            pages: EMPTY_SYSTEM_LEGAL_PAGES,
            lock: 4,
            aiActive,
          }),
    ),
  );
  renderWithQuery(<SystemLegalTab />);

  await waitFor(() => {
    expect(card('Impressum')).toBeDefined();
  });
}

/** One of the three cards — `<section>` with the title of its template. */
function card(title: string): HTMLElement {
  return screen.getByRole('region', { name: title });
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemLegalTab', () => {
  it('zeigt den Befund an dem Feld der Seite, die der Server benannt hat', async () => {
    await renderRefusing([
      { path: 'pages.privacy.fills.NAME_DES_BETREIBERS', message: MESSAGE },
    ]);

    const privacy = card('Datenschutzerklärung');
    const imprint = card('Impressum');

    // Something has to be dirty before „Speichern" is offered at all.
    fireEvent.change(
      within(privacy).getByLabelText('Name des Betreibers', {
        selector: 'input',
      }),
      { target: { value: 'Beispielstadt' } },
    );
    save();

    await waitFor(() => {
      expect(within(privacy).getByText(MESSAGE)).toBeDefined();
    });
    const marked = within(privacy).getByLabelText<HTMLInputElement>(
      'Name des Betreibers',
      { selector: 'input' },
    );
    expect(marked.getAttribute('aria-invalid')).toBe('true');
    // On the field, not merely beside it: a screen reader reads the sentence on
    // entering the field.
    expect(marked.getAttribute('aria-describedby')).toContain(
      within(privacy).getByText(MESSAGE).id,
    );

    // And the card next to it carries a field with the **same** label. It stays
    // untouched — that is the whole point of the page name in the path.
    expect(within(imprint).queryByText(MESSAGE)).toBeNull();
    expect(
      within(imprint)
        .getByLabelText<HTMLInputElement>('Name des Betreibers', {
          selector: 'input',
        })
        .getAttribute('aria-invalid'),
    ).toBeNull();
  });

  /**
   * **Der Name des Betreibers wird einmal getippt** (Review-Runde 3 Nr. 3):
   * *„Einrichtung: Ich muss mehrfach das gleiche eingeben (Betreiber, …)."*
   *
   * Er steht in allen drei Vorlagen der Installation, die Anschrift in zweien.
   * Gemessen wird hier das **Zusammenspiel** — dass die Karte den
   * Nachbarkarten wirklich schreibt; die Regel selbst, samt der Bedingung, die
   * einen bewusst abweichenden Wert schützt, ist in
   * `packages/shared/src/legal-shared-fills.test.ts` geprüft.
   */
  it('führt den Namen des Betreibers in die anderen Seiten mit', async () => {
    await renderRefusing([]);

    fireEvent.change(
      within(card('Impressum')).getByLabelText('Name des Betreibers', {
        selector: 'input',
      }),
      { target: { value: 'Beispiel-Betrieb e. V.' } },
    );

    expect(
      within(card('Datenschutzerklärung')).getByLabelText<HTMLInputElement>(
        'Name des Betreibers',
        { selector: 'input' },
      ).value,
      'Die Datenschutzerklärung hat den Namen nicht mitbekommen',
    ).toBe('Beispiel-Betrieb e. V.');

    // Und der Satz am Feld sagt, dass es so ist — ein Wert, der sich woanders
    // mitändert, ohne dass es dort steht, wäre die unangenehmste Art von
    // Hilfsbereitschaft.
    expect(
      within(card('Impressum')).getAllByText(/wird dort mitgeführt/u).length,
    ).toBeGreaterThan(0);
  });

  it('markiert „Eigener Text" nur auf der benannten Seite', async () => {
    await renderRefusing([
      { path: 'pages.imprint.custom', message: CUSTOM_MESSAGE },
    ]);

    // Both cards into „Eigener Text", so that both really do have the field the
    // finding names — otherwise the negative expectation would hold for the
    // trivial reason that there is nothing there to mark.
    for (const title of ['Impressum', 'Datenschutzerklärung']) {
      fireEvent.click(
        within(card(title)).getByRole('radio', { name: 'Eigener Text' }),
      );
    }
    save();

    const imprint = card('Impressum');
    await waitFor(() => {
      expect(within(imprint).getByText(CUSTOM_MESSAGE)).toBeDefined();
    });
    expect(
      within(imprint)
        .getByLabelText<HTMLTextAreaElement>('Eigener Text', {
          selector: 'textarea',
        })
        .getAttribute('aria-invalid'),
    ).toBe('true');

    const privacy = card('Datenschutzerklärung');
    expect(within(privacy).queryByText(CUSTOM_MESSAGE)).toBeNull();
    expect(
      within(privacy)
        .getByLabelText<HTMLTextAreaElement>('Eigener Text', {
          selector: 'textarea',
        })
        .getAttribute('aria-invalid'),
    ).toBeNull();
  });
});

/**
 * **Review-Runde 5 Nr. 2 — „Datenschutzerklärung: KI Teil fehlt im Formular."**
 *
 * Der Befund traf zu, und er war kein Anzeigefehler: `visibleSlots` lässt die
 * Felder eines abgewählten Blocks weg, und diese Karte **nahm** „KI aus" an,
 * weil sie den Zustand nicht wusste. Damit waren die sieben Felder des
 * KI-Abschnitts nicht schwer zu finden, sondern nicht vorhanden — während die
 * veröffentlichte Seite den Abschnitt zeigte, weil der Server dort die Wahrheit
 * liest. Die Karte bekommt den Wert jetzt mit der Antwort.
 *
 * Gemessen werden **beide** Richtungen: ohne eingerichtete KI dürfen die Felder
 * auch nicht auftauchen — sonst fragte die Seite nach dem Sitz eines Anbieters,
 * den es nicht gibt.
 */
describe('der KI-Abschnitt der Datenschutzerklärung', () => {
  it('bietet die KI-Felder an, sobald die KI-Funktion eingerichtet ist', async () => {
    await renderRefusing([], true);

    const privacy = card('Datenschutzerklärung');
    expect(
      within(privacy).getByLabelText('Name des KI-Anbieters', {
        selector: 'input',
      }),
    ).toBeDefined();
    expect(
      within(privacy).getByLabelText('KI-Verarbeitungsregion', {
        selector: 'input',
      }),
    ).toBeDefined();
  });

  it('bietet sie nicht an, solange sie nicht eingerichtet ist', async () => {
    await renderRefusing([], false);

    const privacy = card('Datenschutzerklärung');
    expect(
      within(privacy).queryByLabelText('Name des KI-Anbieters', {
        selector: 'input',
      }),
    ).toBeNull();
  });
});

/**
 * **Der Satz unter der Vorschau** (Review-Runde 5 Nr. 1 und 2) — zwei
 * nutzersichtbare Aussagen, die beide von dieser Änderung kommen und deshalb
 * beide gemessen werden.
 *
 * 1. Vorschau und veröffentlichte Seite unterscheiden sich seitdem: hier stehen
 *    die fehlenden Angaben benannt, draußen entfällt ihre Zeile. Ohne den Satz
 *    wäre der Unterschied die Sorte Überraschung, die man für einen Fehler hält.
 * 2. Der Vorbehalt „der Absatz zur KI zeigt erst die veröffentlichte Seite"
 *    gehört **nicht** hierher: diese Karte kennt den Zustand
 *    (`aiStateKnown`). Ein Vorbehalt, wo keiner nötig ist, ist die Auskunft, die
 *    man beim dritten Mal überliest.
 */
describe('der Satz unter der Vorschau', () => {
  it('sagt, dass die offenen Angaben öffentlich entfallen', async () => {
    await renderRefusing([]);

    const notes = within(card('Impressum')).getAllByText(
      /Öffentlich entfällt jede Zeile, in der eine Angabe fehlt/u,
    );
    expect(notes.length).toBe(1);
  });

  it('trägt den KI-Vorbehalt nicht, weil diese Karte den Zustand kennt', async () => {
    await renderRefusing([]);

    expect(
      within(card('Datenschutzerklärung')).queryByText(
        /Abschnitte, die von der Konfiguration der Installation abhängen/u,
      ),
    ).toBeNull();
  });
});
