import type { OpsStatus } from '@formsache/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cascade } from '../test/css-cascade';
import { jsonResponse, stubFetch } from '../test/fetch-mock';
import { renderWithQuery } from '../test/render-with-query';
import { OpsView } from './OpsView';

/**
 * The *Überwachung* tab of the system administration (ADR-0016; finding 16) — until
 * then a page of its own called „Betrieb".
 *
 * What only a browser can decide — reachability via the navigation and the
 * mobile width — is in `e2e/`. What stands here is what a rendered tree
 * already answers: that the traffic light hangs on **the same** threshold as
 * the alert in the server, that it stands **in the text** and not only in the
 * colour, and that a 403 appears as a sentence rather than as an empty page.
 */

const OBSERVED_AT = '2026-08-11T12:00:00.000Z';

function status(overrides: Partial<OpsStatus> = {}): OpsStatus {
  return {
    version: '1.2.3',
    observedAt: OBSERVED_AT,
    mailQueue: {
      queued: 0,
      failed: 0,
      failedRecently: 0,
      oldestQueuedAt: null,
    },
    jobs: [
      {
        job: 'retention_purge',
        lastSuccessAt: '2026-08-11T02:00:00.000Z',
        lastRunAt: '2026-08-11T02:00:00.000Z',
        lastOutcome: 'ok',
        lastItemCount: 3,
        lastErrorClass: null,
      },
    ],
    storage: { usedBytes: 2048, files: 2, usedFraction: 0.5 },
    ai: { calls: 0, failed: 0, failureRate: null, byModel: [] },
    ...overrides,
  };
}

/** Every request of this view is answered with the same payload. */
function serve(response: Response): void {
  stubFetch().mockImplementation(() => Promise.resolve(response));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpsView', () => {
  it('zeigt die fünf Zahlengruppen und die Fassung', async () => {
    serve(jsonResponse(200, status()));
    renderWithQuery(<OpsView />);

    expect(
      await screen.findByRole('heading', { name: 'Warteschlange' }),
    ).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Ablage' })).toBeDefined();
    // Exactly „KI" — since Konzept no. 107 there is a second heading below it
    // („KI-Verbrauch je Modell"), and a prefix pattern would match both.
    expect(screen.getByRole('heading', { name: 'KI' })).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'Hintergrundläufe' }),
    ).toBeDefined();
    expect(screen.getByText('1.2.3')).toBeDefined();
  });

  /**
   * **The tab carries its own heading, and the panels stand below it**
   * (finding 16).
   *
   * The `<h1>` has belonged to the frame (`SystemAdminView`) since the
   * merging; were the panels still to stand at the same level as
   * „Überwachung", the page would read as four sections of equal rank, one of
   * which happens to name the others — and axe' `heading-order` would find
   * nothing to object to about it, because no level is skipped.
   */
  it('nennt sich Überwachung und ordnet die Panels darunter ein', async () => {
    serve(jsonResponse(200, status()));
    renderWithQuery(<OpsView />);

    // Waited for the loaded panels, not for the heading: that one is already
    // there before the answer, and the loop below would run into nothing.
    expect(
      await screen.findByRole('heading', { name: 'Warteschlange', level: 3 }),
    ).toBeDefined();
    expect(
      screen.getByRole('heading', { name: 'Überwachung', level: 2 }),
    ).toBeDefined();
    // No more „Betrieb" — the name was half of the finding.
    expect(screen.queryByRole('heading', { name: 'Betrieb' })).toBeNull();
    for (const panel of [
      'Warteschlange',
      'Ablage',
      'KI',
      'KI-Verbrauch je Modell',
      'Hintergrundläufe',
    ]) {
      expect(
        screen.getByRole('heading', { name: panel, level: 3 }),
        `„${panel}" steht unter „Überwachung", nicht daneben.`,
      ).toBeDefined();
    }
  });

  /**
   * **Id and version stand side by side** .
   *
   * The case runs both states in one table, because only that proves anything:
   * one row *with* a resolved version and one *without*. If the view showed
   * the id a second time on `null`, it would claim that it had been resolved —
   * and a test that only checks the resolved row would not see that.
   *
   * The two rows with **the same id** and different versions are the actual
   * purpose of the column: that is what it looks like when the provider moves
   * an alias on in the middle of the month.
   */
  it('zeigt je Modell Kennung, Fassung und Mengen', async () => {
    serve(
      jsonResponse(
        200,
        status({
          ai: {
            calls: 9,
            failed: 0,
            failureRate: 0,
            byModel: [
              {
                model: 'mistral-large-latest',
                resolved: 'mistral-large-2512',
                calls: 5,
                inputTokens: 12_345,
                outputTokens: 6_789,
              },
              {
                model: 'mistral-large-latest',
                resolved: 'mistral-large-2604',
                calls: 3,
                inputTokens: 1_000,
                outputTokens: 500,
              },
              {
                model: 'claude-opus-5',
                resolved: null,
                calls: 1,
                inputTokens: null,
                outputTokens: null,
              },
            ],
          },
        }),
      ),
    );
    renderWithQuery(<OpsView />);

    // Searched via the **accessibility tree**, not via `closest('section')`: a
    // named `<section>` is a `region`, and that is exactly how a screen reader
    // finds the area too. The detour via the DOM would check the nesting, this
    // way checks the markup.
    const table = within(
      await screen.findByRole('region', { name: 'KI-Verbrauch je Modell' }),
    );
    const rows = table.getAllByRole('row').slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ),
    ).toStrictEqual([
      ['mistral-large-2512', '5', '12.345', '6.789'],
      ['mistral-large-2604', '3', '1.000', '500'],
      // `—` and not the id a second time: this provider does not say it.
      ['—', '1', '—', '—'],
    ]);
    // The id stands as the row header, so that a screen reader announces every
    // number with it — the same construction as with the background runs.
    expect(
      table.getAllByRole('rowheader').map((cell) => cell.textContent),
    ).toStrictEqual([
      'mistral-large-latest',
      'mistral-large-latest',
      'claude-opus-5',
    ]);
  });

  /**
   * **Heading and number stand on the same edge** (a review finding).
   *
   * The right alignment hung on `td` — the header cells are `th`, though, and
   * kept `text-align: left`: „Aufrufe", „Input-Tokens" and „Output-Tokens"
   * stood left-aligned above right-aligned numbers. An alignment is a
   * statement about the **column**, and that is how it is measured here too:
   * the effective alignment of header *and* cell of the same column, evaluated
   * out of `ops-view.css` on the rendered tree (jsdom computes no cascade and
   * knows no `text-align` out of a file).
   *
   * The row id is the counter-check: it is likewise a `th` and has to stay on
   * the left — a rule that simply moved all `th` over would be red.
   */
  it('richtet Zahlenspalten in Kopf und Zelle gleich aus', async () => {
    const styles = Cascade.fromFile('src/views/ops-view.css');
    serve(
      jsonResponse(
        200,
        status({
          ai: {
            calls: 5,
            failed: 0,
            failureRate: 0,
            byModel: [
              {
                model: 'mistral-large-latest',
                resolved: 'mistral-large-2512',
                calls: 5,
                inputTokens: 12_345,
                outputTokens: 6_789,
              },
            ],
          },
        }),
      ),
    );
    renderWithQuery(<OpsView />);

    const table = within(
      await screen.findByRole('region', { name: 'KI-Verbrauch je Modell' }),
    );
    // The caption is the provider's — „Token ein"/„Token aus" was an
    // invention of this view, against which nobody reconciled their own bill.
    const columns = [
      { name: 'Aufrufe', value: '5' },
      { name: 'Input-Tokens', value: '12.345' },
      { name: 'Output-Tokens', value: '6.789' },
    ];

    for (const { name, value } of columns) {
      const header = table.getByRole('columnheader', { name });
      const cell = table.getByRole('cell', { name: value });
      expect(styles.inheritedValue(header, 'text-align')).toBe('right');
      expect(styles.inheritedValue(cell, 'text-align')).toBe('right');
    }

    // And the id — also a `th` — still stands on the left.
    expect(
      styles.inheritedValue(
        table.getByRole('rowheader', { name: 'mistral-large-latest' }),
        'text-align',
      ),
    ).toBe('left');
  });

  /** An empty table would read like a defect — the sentence says that it is right. */
  it('sagt „nicht aufgerufen" statt eine leere Tabelle zu zeigen', async () => {
    serve(jsonResponse(200, status()));
    renderWithQuery(<OpsView />);

    expect(
      await screen.findByText('In diesem Monat wurde die KI nicht aufgerufen.'),
    ).toBeDefined();
    expect(screen.queryByRole('columnheader', { name: 'Fassung' })).toBeNull();
  });

  it('meldet eine Warteschlange über der Schwelle — als **Wort**, nicht nur farbig', async () => {
    // 45 minutes: above the 30 that `OPS_THRESHOLDS.mailQueueAgeMs` allows.
    serve(
      jsonResponse(
        200,
        status({
          mailQueue: {
            queued: 7,
            failed: 0,
            failedRecently: 0,
            oldestQueuedAt: '2026-08-11T11:15:00.000Z',
          },
        }),
      ),
    );
    renderWithQuery(<OpsView />);

    // The announcement stands in the text. A traffic light that only changes
    // the border colour says nothing to a screen reader — the lesson.
    expect(await screen.findByText('über der Schwelle')).toBeDefined();
    expect(screen.getByText('45 min')).toBeDefined();
  });

  it('schweigt, solange die Schwelle nicht überschritten ist', async () => {
    // 20 minutes: **below** the 30. Without this case the test above would
    // only prove that a warning is always given.
    serve(
      jsonResponse(
        200,
        status({
          mailQueue: {
            queued: 3,
            failed: 0,
            failedRecently: 0,
            oldestQueuedAt: '2026-08-11T11:40:00.000Z',
          },
        }),
      ),
    );
    renderWithQuery(<OpsView />);

    expect(await screen.findByText('20 min')).toBeDefined();
    expect(screen.queryByText('über der Schwelle')).toBeNull();
  });

  it('meldet einen Lauf über der 26-Stunden-Frist — und nennt die Fehlerklasse', async () => {
    serve(
      jsonResponse(
        200,
        status({
          jobs: [
            {
              job: 'file_purge',
              // 30 hours before `observedAt`.
              lastSuccessAt: '2026-08-10T06:00:00.000Z',
              lastRunAt: '2026-08-11T02:00:00.000Z',
              lastOutcome: 'failed',
              lastItemCount: null,
              lastErrorClass: 'PrismaClientKnownRequestError',
            },
          ],
        }),
      ),
    );
    renderWithQuery(<OpsView />);

    expect(await screen.findByText('über der Frist')).toBeDefined();
    // Both points in time stand there for exactly this: the run **ran** last
    // night and last **succeeded** 30 hours ago.
    expect(screen.getByText('vor 30 h')).toBeDefined();
    expect(
      screen.getByText(/gescheitert \(PrismaClientKnownRequestError\)/),
    ).toBeDefined();
  });

  it('sagt bei 403, dass die Seite der Installation gehört', async () => {
    serve(jsonResponse(403, { message: 'Forbidden' }));
    renderWithQuery(<OpsView />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Superadmins vorbehalten',
      );
    });
  });
});
