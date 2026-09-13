import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, requestUrl, stubFetch } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { LicencesView } from './LicencesView';

/**
 * **The licence page closes an open gap** (`docs/legal/README.md`
 * 7.10): the ParaType Free Font License demands that its notice travels with
 * the font files („it must be easily viewed by users"). The two
 * `.woff2` go to every browser of every participating person; the licence file
 * lay in the repository and was not carried into `dist/` by `vite build`,
 * because no module imported it.
 *
 * ## Why this test reads the files off the disk
 *
 * Because the promise is exactly that: **the page shows the file, not a
 * transcript.** The licence text itself says „You have no right to modify the
 * text of Licensing Agreement", and a constant in the source would be the
 * permission to do it anyway. The import goes via `?raw`; this test records
 * that what comes out is really the file and not some text that resembles it —
 * the same pattern with which `ProductLockup.test.tsx` holds the two versions
 * of the drawing together.
 */

const REPO_ROOT = resolve(process.cwd(), '..', '..');

function fileText(...segments: string[]): string {
  return readFileSync(resolve(REPO_ROOT, ...segments), 'utf8').trim();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('die Lizenzseite', () => {
  it('liefert die MIT-Lizenz und die Schriftlizenz im Wortlaut der Dateien', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: null,
      }),
    );

    const { container } = renderWithQuery(<LicencesView />);
    const text = container.textContent;

    expect(text).toContain(fileText('LICENSE'));
    expect(text).toContain(
      fileText('apps', 'web', 'src', 'assets', 'fonts', 'LICENSE.txt'),
    );
  });

  /**
   * **Die Drittkomponenten stehen jetzt da — mit ihren Wortlauten**
   * (Review-Runde 3 Nr. 14).
   *
   * Bis hierher prüfte dieser Test das Gegenteil: dass die Seite *keine*
   * Liste behauptet, weil keine ausgeliefert wurde. Der Absatz, der das
   * eingestand, war öffentlich lesbar — „Das kann man doch so nicht
   * öffentlich reinschreiben." Er ist weg, weil die Liste da ist.
   *
   * Gemessen wird das, was die Lizenzen verlangen: der Name des Pakets, seine
   * Fassung und der **fremde Copyright-Vermerk**. Die Kennung „MIT" allein
   * genügt der MIT-Lizenz nicht.
   */
  it('nennt jede Drittkomponente mit Fassung und Wortlaut', async () => {
    stubFetch().mockImplementation((input) =>
      Promise.resolve(
        requestUrl(input).includes('drittanbieter-lizenzen')
          ? jsonResponse(200, {
              source: 'pnpm-lock.yaml',
              texts: {
                abc123: 'MIT License\n\nCopyright (c) 2011 Beispielperson',
              },
              packages: [
                {
                  name: 'beispiel-paket',
                  version: '1.2.3',
                  spdx: 'MIT',
                  author: 'Beispielperson',
                  homepage: 'https://example.org/beispiel',
                  text: 'abc123',
                },
              ],
            })
          : jsonResponse(200, {
              installationName: null,
            }),
      ),
    );

    renderWithQuery(<LicencesView />);

    expect(
      screen.getByRole('heading', { name: 'Verwendete Drittkomponenten' }),
    ).toBeDefined();
    expect(await screen.findByText('beispiel-paket')).toBeDefined();
    expect(screen.getByText('1.2.3')).toBeDefined();

    // Der Wortlaut steht zugeklappt da — 215 vollständige Lizenztexte offen
    // wären rund 200 Seiten. Aufgeklappt steht der fremde Vermerk im Klartext.
    const details = screen.getByText('Wortlaut der Lizenz');
    details.click();
    expect(
      (await screen.findByText(/Copyright \(c\) 2011 Beispielperson/u))
        .textContent,
    ).toContain('MIT License');
  });

  /**
   * Der Abruf kann scheitern — eine veraltete Zwischenspeicherung, ein
   * Reverse-Proxy, der die Datei nicht kennt. Dann steht hier ein Satz mit
   * dem Weg zur Datei und **nicht** wieder eine Selbstanzeige.
   */
  it('nennt bei einem gescheiterten Abruf den Weg zur Datei', async () => {
    stubFetch().mockImplementation((input) =>
      requestUrl(input).includes('drittanbieter-lizenzen')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(
            jsonResponse(200, {
              installationName: null,
            }),
          ),
    );

    renderWithQuery(<LicencesView />);

    const hint = await screen.findByRole('alert');
    expect(hint.textContent).toContain('/drittanbieter-lizenzen.json');
    expect(hint.textContent).not.toContain('offener Punkt');
  });

  it('trägt die Fußzeile wie jede andere öffentliche Seite', () => {
    stubFetch().mockResolvedValue(
      jsonResponse(200, {
        installationName: null,
      }),
    );

    renderWithQuery(<LicencesView />);

    expect(
      screen.getByRole('navigation', { name: 'Rechtliche Angaben' }),
    ).toBeDefined();
  });
});
