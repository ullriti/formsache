import {
  JSDOM,
  VirtualConsole,
  requestInterceptor,
  type DomCssRule,
  type DomDocument,
  type DomElement,
  type DomWindow,
} from 'jsdom';
import { describe, expect, it } from 'vitest';

import type { CellGuard } from './answer-columns.ts';
import { writeHtml } from './export-html.ts';
import {
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  buildExportSheet,
  chooseColumns,
  type CsvRow,
  type ExportCell,
  type ExportSheet,
} from './export-sheet.ts';
import { csvColumns, responseColumnGroups } from './form-history.ts';
import { parseFormDefinition, type FormDefinition } from './form-schema.ts';
import { escapeHtml, neutraliseHtml } from './html-text.ts';

/**
 * **the requirement — the HTML export is *one* file that reloads nothing.**
 *
 * Every assurance here is measured **on the produced file**, not on the
 * source text of the writer: the file is loaded as in a browser, and
 * in one that would expressly be *ready* to execute everything
 * (`runScripts: 'dangerously'`) and to reload everything. Exactly that is the point —
 * a measurement that switches off the executing from the outset tests the
 * switching-off and not the file.
 *
 * ## How "nothing is executed" is measured
 *
 * Via a **canary**: `beforeParse` creates `window.__xssCanaryExecuted = 0`, and
 * every attack value in {@link ATTACKS} tries to set it to `1`. If it stays
 * `0`, none of them ran. After the loading *every*
 * element additionally gets an `error`, `load`, `click` and `mouseover` event: an
 * `onerror` attribute that the writer had let through would long since have been
 * translated into a handler by jsdom and would run off here. (jsdom does not load
 * images at all without the `canvas` package, so it fires no `error`
 * by itself — which is why it is fired.)
 *
 * That this measuring instrument deflects at all is not claimed but
 * proven: `the measurement itself` below builds the same table **without**
 * neutralisation and sees the canary go to `1`. A proof without a
 * reproduction is none.
 *
 * ## How "nothing is reloaded" is measured
 *
 * Via an interceptor at every request of the file
 * ({@link requestInterceptor}), which writes down every requested address and
 * answers with an error. `requested` has to stay empty. The document location
 * is deliberately an **https** location ({@link EXPORT_URL}) and no `file://`: jsdom
 * reads `file://` addresses from the disk past the interceptor, so the
 * measurement would be blind exactly where the reproduction sits (measured when
 * this test came into being).
 */

/** The name of the canary — written once, used by the attacks. */
const CANARY = '__xssCanaryExecuted';

/**
 * The location at which the file appears to lie.
 *
 * `invalid` is the reserved ending for "this name does not exist" (RFC
 * 2606): even if the interceptor ever failed, nothing would go out.
 */
const EXPORT_URL = 'https://formulare.invalid/export.html';

/**
 * What a participant types into a public form when they mean the file
 * that arises from it — the three from the requirement (`<img src=x
 * onerror=…>`, `<script>`, `javascript:` link) and the neighbours that would need the same
 * hole.
 *
 * They stand in the **values** as well as in the **question titles**: the
 * column plan knows no dangerous title, because no plan knows that, and
 * a header row that inserts its word unprotected would be one unprotected
 * row per file.
 */
const ATTACKS: readonly string[] = [
  '<script>alert(1)</script>',
  `<script>window.${CANARY} = 1;</script>`,
  `<img src=x onerror="window.${CANARY} = 1">`,
  '<img src="https://spion.example/zaehlpixel.gif">',
  '<iframe src="https://spion.example/"></iframe>',
  `"><svg onload="window.${CANARY} = 1">`,
  `<a href="javascript:window.${CANARY} = 1">Bitte hier klicken</a>`,
  'javascript:alert(1)',
  '<link rel="stylesheet" href="https://spion.example/stil.css">',
  '<style>body { background-image: url(https://spion.example/x.png); }</style>',
  `<body onload="window.${CANARY} = 1">`,
];

/** Elements that an output of this kind may never contain. */
const FORBIDDEN_ELEMENTS =
  'script, iframe, object, embed, applet, frame, frameset, ' +
  'img, svg, picture, source, video, audio, link, base, form, input, button';

interface LoadedFile {
  /** Every address the file requested on opening. */
  readonly requested: readonly string[];
  readonly window: DomWindow;
  readonly document: DomDocument;
  /** `0` as long as nothing has run. */
  readonly executed: number;
}

/**
 * Loads a file the way it would be opened on the computer of a member —
 * only with the network disconnected and with a record of what it
 * would have requested.
 */
async function openWithoutNetwork(html: string): Promise<LoadedFile> {
  const requested: string[] = [];
  const virtualConsole = new VirtualConsole();
  // Without listeners of its own jsdom pushes its messages onto the Node console;
  // both events are deliberately swallowed here, so that a deliberately
  // broken document (the reproductions below) does not litter the test run.
  virtualConsole.on('jsdomError', () => undefined);
  virtualConsole.on('error', () => undefined);

  const dom = new JSDOM(html, {
    url: EXPORT_URL,
    runScripts: 'dangerously',
    virtualConsole,
    resources: {
      interceptors: [
        requestInterceptor((request) => {
          requested.push(request.url);
          return new Response('', { status: 502 });
        }),
      ],
    },
    beforeParse: (window) => {
      window[CANARY] = 0;
    },
  });

  // Time for everything a document does by itself on loading.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const { window } = dom;
  for (const element of Array.from(window.document.querySelectorAll('*'))) {
    for (const type of ['error', 'load', 'click', 'mouseover']) {
      element.dispatchEvent(new window.Event(type));
    }
  }

  return {
    requested,
    window,
    document: window.document,
    executed: Number(window[CANARY]),
  };
}

function cell(value: string, guard: CellGuard = 'auto'): ExportCell {
  return { value, guard };
}

/** A sheet as `buildExportSheet` delivers it: a rectangle of cells. */
function sheetOf(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): ExportSheet {
  return {
    header: header.map((label, index) => ({
      key: `frage-${String(index)}`,
      value: label,
      guard: 'auto',
    })),
    rows: rows.map((row) => row.map((value) => cell(value))),
  };
}

const ATTACK_SHEET: ExportSheet = sheetOf(
  ['Name', ...ATTACKS],
  ATTACKS.map((attack) => ['Max Mustermann', ...ATTACKS.map(() => attack)]),
);

function elements(document: DomDocument, selector: string): DomElement[] {
  return Array.from(document.querySelectorAll(selector));
}

/** Every attribute of every element, with the element it hangs on. */
function attributesOf(
  document: DomDocument,
): { readonly on: string; readonly name: string; readonly value: string }[] {
  return elements(document, '*').flatMap((element) =>
    Array.from(element.attributes).map((attribute) => ({
      on: element.tagName.toLowerCase(),
      name: attribute.name,
      value: attribute.value,
    })),
  );
}

function computed(
  file: LoadedFile,
  selector: string,
  property: string,
): string {
  const element = file.document.querySelector(selector);
  if (element === null) {
    throw new Error(`Kein Element für „${selector}" in der Datei.`);
  }
  return file.window.getComputedStyle(element).getPropertyValue(property);
}

/** The rules **inside** `@media print`. */
function printRules(document: DomDocument): DomCssRule[] {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .filter((rule) => rule.media?.mediaText === 'print')
    .flatMap((rule) => Array.from(rule.cssRules ?? []));
}

function declarationOf(
  rules: readonly DomCssRule[],
  selector: string,
  property: string,
): string {
  const rule = rules.find((candidate) => candidate.selectorText === selector);
  return rule?.style?.getPropertyValue(property) ?? '';
}

describe('nichts wird ausgeführt, nichts wird nachgeladen', () => {
  it('führt nichts aus, obwohl der Browser bereit wäre', async () => {
    const file = await openWithoutNetwork(writeHtml(ATTACK_SHEET));

    expect(
      file.executed,
      'Ein Wert aus einem öffentlichen Formular hat Code in der Datei ' +
        'ausgeführt, die ein Mitglied öffnet.',
    ).toBe(0);
  });

  it('lädt nichts nach — auch nicht den Zählpixel eines Antwortwerts', async () => {
    const file = await openWithoutNetwork(writeHtml(ATTACK_SHEET));

    expect(file.requested).toEqual([]);
  });

  it('enthält kein <script>, kein <iframe> und kein Element, das nachladen könnte', async () => {
    const html = writeHtml(ATTACK_SHEET);
    const file = await openWithoutNetwork(html);

    expect(elements(file.document, FORBIDDEN_ELEMENTS)).toEqual([]);
    // Not as text either: a `<script` that did not become an element might be
    // one in another reader.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
  });

  it('trägt kein on…-Attribut und keinen javascript:-Verweis', async () => {
    const file = await openWithoutNetwork(writeHtml(ATTACK_SHEET));

    for (const attribute of attributesOf(file.document)) {
      expect(
        attribute.name.toLowerCase().startsWith('on'),
        `<${attribute.on} ${attribute.name}=…> ist ein Ereignis-Attribut.`,
      ).toBe(false);
      expect(attribute.value).not.toMatch(/^\s*javascript:/i);
    }
  });

  it('verweist auf keinen fremden Host', async () => {
    const html = writeHtml(ATTACK_SHEET);
    const file = await openWithoutNetwork(html);

    for (const attribute of attributesOf(file.document)) {
      expect(
        attribute.value,
        `<${attribute.on} ${attribute.name}> zeigt aus der Datei hinaus.`,
      ).not.toMatch(/(^|[^:])\/\//);
    }

    // And in the styles: `url(…)` is the one CSS form that fetches something,
    // `@import` the other. Measured on the **read-in** style sheet, not on the
    // source text, so that a value happening to contain „url(" reports nothing.
    const css = Array.from(file.document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join('\n');
    expect(css).not.toMatch(/url\(/i);
    expect(css).not.toMatch(/@import/i);
  });

  it('behält den Wert dabei lesbar, statt ihn zu verschlucken', async () => {
    const file = await openWithoutNetwork(writeHtml(ATTACK_SHEET));
    const text = file.document.body.textContent ?? '';

    // The difference between "escaped" and "deleted": an answer is a
    // statement of a human being and stays in the file — only as
    // text. An output that silently removes would be silent data loss.
    for (const attack of ATTACKS) {
      expect(text).toContain(attack);
    }
  });
});

describe('die Datei ist ohne Netz benutzbar', () => {
  const sheet = sheetOf(
    ['Name', SUBMITTED_AT_LABEL],
    [['Max Mustermann', '20.07.2026 09:30']],
  );

  it('bringt ihre Stile mit — die berechneten Farben stimmen ohne jede Anfrage', async () => {
    const file = await openWithoutNetwork(writeHtml(sheet));

    expect(file.requested).toEqual([]);
    // #ffffff / #1c1b18 / #f2efe8 — the tokens of the product, in the file
    // itself. Measured on the **computed** value, not on the presence of a
    // <style>: an empty style block would also be one.
    expect(computed(file, 'body', 'background-color')).toBe(
      'rgb(255, 255, 255)',
    );
    expect(computed(file, 'body', 'color')).toBe('rgb(28, 27, 24)');
    expect(computed(file, 'thead th', 'background-color')).toBe(
      'rgb(242, 239, 232)',
    );
    expect(computed(file, 'table', 'border-collapse')).toBe('collapse');
  });

  it('nennt keine Schrift, die erst geholt werden müsste', () => {
    const html = writeHtml(sheet);

    expect(html).not.toMatch(/@font-face/i);
    expect(html).not.toMatch(/https?:/i);
  });
});

describe('die Datei ist druckbar', () => {
  const sheet = sheetOf(['Name'], [['Max Mustermann'], ['Erika Musterfrau']]);
  const meta = {
    formTitle: 'Anmeldung zum Jahrestagung 2026',
    tenantName: 'Dachorganisation',
    exportedAt: '2026-07-20T09:30:00.000Z',
  };

  it('trägt einen Kopf mit Formulartitel, Organisation und Zeitpunkt', async () => {
    const file = await openWithoutNetwork(writeHtml(sheet, meta));
    const head = file.document.querySelector('.export-head');

    expect(head?.querySelector('h1')?.textContent).toBe(meta.formTitle);
    expect(head?.querySelector('.tenant')?.textContent).toBe(meta.tenantName);
    // The moment in the export's notation and **with** its zone —
    // a file that is read elsewhere must not leave open which
    // moment is meant (the same reasoning as SUBMITTED_AT_LABEL).
    expect(head?.querySelector('.stamp')?.textContent).toBe(
      'Stand: 20.07.2026 09:30 UTC · 2 Antworten',
    );
  });

  it('wiederholt die Kopfzeile auf jeder gedruckten Seite', async () => {
    const file = await openWithoutNetwork(writeHtml(sheet, meta));
    const rules = printRules(file.document);

    expect(rules.length).toBeGreaterThan(0);
    expect(declarationOf(rules, 'thead', 'display')).toBe('table-header-group');
    expect(declarationOf(rules, 'tr', 'page-break-inside')).toBe('avoid');
  });

  it('zählt die Antworten, die in der Datei stehen', async () => {
    const one = await openWithoutNetwork(
      writeHtml(sheetOf(['Name'], [['Max']]), meta),
    );
    const none = await openWithoutNetwork(
      writeHtml(sheetOf(['Name'], []), meta),
    );

    expect(one.document.querySelector('.stamp')?.textContent).toContain(
      '1 Antwort',
    );
    expect(none.document.querySelector('.stamp')?.textContent).toContain(
      '0 Antworten',
    );
    // An empty selection stays a table with its header row — which
    // columns were asked for is the file's information then too.
    expect(none.document.querySelector('thead th')?.textContent).toBe('Name');
    expect(none.document.querySelector('tbody .empty')?.textContent).toBe(
      'Keine Antworten',
    );
  });

  it('sagt ohne Angaben weniger, statt etwas zu erfinden', async () => {
    const file = await openWithoutNetwork(writeHtml(sheet));

    expect(file.document.querySelector('h1')?.textContent).toBe('Antworten');
    expect(file.document.querySelector('.tenant')).toBe(null);
    // Above all **no** date: an invented moment reads like an
    // assured one.
    expect(file.document.querySelector('.stamp')?.textContent).toBe(
      '2 Antworten',
    );
  });

  it('hält den Kopf beim gefährlichen Formulartitel genauso', async () => {
    const file = await openWithoutNetwork(
      writeHtml(sheet, {
        formTitle: '<script>alert(1)</script>',
        tenantName: `<img src=x onerror="window.${CANARY} = 1">`,
        exportedAt: '2026-07-20T09:30:00.000Z',
      }),
    );

    expect(file.executed).toBe(0);
    expect(file.document.querySelector('h1')?.textContent).toBe(
      '<script>alert(1)</script>',
    );
  });
});

describe('the evidence: Umbrüche bleiben Umbrüche', () => {
  const VALUE = 'Erste Zeile\nZweite Zeile\n\nVierte Zeile';

  it('behält die Umbrüche eines Antwortwerts', async () => {
    const file = await openWithoutNetwork(
      writeHtml(sheetOf(['Anmerkung'], [[VALUE]])),
    );
    const td = file.document.querySelector('tbody td');

    // Three `\n` in the value, three `<br>` in the cell — measured on the loaded
    // document, not on the source text.
    expect(Array.from(td?.querySelectorAll('br') ?? []).length).toBe(3);
    // The text itself stays complete; it is separated by the line breaks,
    // not by an inserted character.
    expect(td?.textContent).toBe('Erste ZeileZweite ZeileVierte Zeile');
  });

  it('benutzt dafür dieselbe Funktion wie die Benachrichtigung', () => {
    // No end in itself: an inserted answer value lost its
    // line breaks while the literal template text already broke — because escaping
    // and breaking stood in two places. `neutraliseHtml` is the one
    // place, and this line is the promise that the export uses it.
    expect(writeHtml(sheetOf(['A'], [[VALUE]]))).toContain(
      neutraliseHtml(VALUE),
    );
  });
});

describe('der Schutz der Zelle ist in HTML nichts', () => {
  it('schreibt den eingegebenen String, ohne den CSV-Schutz zu wiederholen', async () => {
    const sheet: ExportSheet = {
      header: [
        { key: 'plz', value: 'Postleitzahl', guard: 'text' },
        { key: 'frei', value: 'Anmerkung', guard: 'auto' },
      ],
      rows: [[cell('01067', 'text'), cell('=SUM(A1)')]],
    };
    const file = await openWithoutNetwork(writeHtml(sheet));
    const cells = elements(file.document, 'tbody td');

    // „Doppelt geschützt ist beschädigt" : a
    // browser interprets no cell, so the HTML output has to answer the
    // decision of the question type with **nothing**.
    expect(cells[0]?.textContent).toBe('01067');
    expect(cells[1]?.textContent).toBe('=SUM(A1)');
    expect(writeHtml(sheet)).not.toContain("'01067");
  });

  it('markiert allein die Zeitstempel-Spalte, damit sie nicht umbricht', () => {
    const html = writeHtml({
      header: [
        { key: SUBMITTED_AT_COLUMN, value: SUBMITTED_AT_LABEL, guard: 'auto' },
        { key: 'frage-1', value: 'Name', guard: 'auto' },
      ],
      rows: [[cell('20.07.2026 09:30'), cell('Max')]],
    });

    expect(html.match(/class="stamp-cell"/g)?.length).toBe(2);
  });
});

describe('die Messung selbst', () => {
  /** The reproduction: the same cells, inserted raw. */
  function naive(
    sheet: ExportSheet,
    insert: (value: string) => string,
  ): string {
    const rows = sheet.rows
      .map(
        (row) =>
          `<tr>${row.map((c) => `<td>${insert(c.value)}</td>`).join('')}</tr>`,
      )
      .join('');
    return (
      '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
      `<title>x</title></head><body><table><tbody>${rows}</tbody></table></body></html>`
    );
  }

  it('sähe es, wenn die Werte ohne Neutralisierung eingesetzt würden', async () => {
    const file = await openWithoutNetwork(
      naive(ATTACK_SHEET, (value) => value),
    );

    // Without neutralisation: the canary goes up, a style sheet is
    // requested, and the forbidden elements stand in the document. If this stayed
    // green here, the four assurances above would test nothing.
    expect(file.executed).toBe(1);
    expect(file.requested).toContain('https://spion.example/stil.css');
    expect(elements(file.document, FORBIDDEN_ELEMENTS).length).toBeGreaterThan(
      0,
    );
    expect(
      attributesOf(file.document).filter((attribute) =>
        attribute.name.startsWith('on'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('sähe es, wenn nur escapeHtml ohne Umbruchbehandlung liefe', async () => {
    const sheet = sheetOf(['Anmerkung'], [['Erste Zeile\nZweite Zeile']]);
    const escaped = await openWithoutNetwork(naive(sheet, escapeHtml));
    const written = await openWithoutNetwork(writeHtml(sheet));

    expect(
      Array.from(escaped.document.querySelectorAll('br')).length,
      'the evidence wäre grün, ohne etwas zu belegen.',
    ).toBe(0);
    expect(Array.from(written.document.querySelectorAll('br')).length).toBe(1);
  });

  it('sähe es, wenn die Stile als <link> ausgeliefert würden', async () => {
    const html = writeHtml(sheetOf(['Name'], [['Max']])).replace(
      /<style>[\s\S]*?<\/style>/,
      '<link rel="stylesheet" href="export.css">',
    );
    const file = await openWithoutNetwork(html);

    expect(file.requested).toEqual(['https://formulare.invalid/export.css']);
    expect(computed(file, 'body', 'background-color')).not.toBe(
      'rgb(255, 255, 255)',
    );
  });
});

describe('an einem Blatt, das die Naht wirklich gebaut hat', () => {
  const P = '019ff100-0000-7000-8000-0000000000f0';
  const ids = {
    note: '019ff100-0000-7000-8000-000000000011',
    address: '019ff100-0000-7000-8000-000000000012',
  };
  const base = { hint: null, required: false, width: 'full' } as const;

  const definition: FormDefinition = parseFormDefinition({
    pages: [
      {
        id: P,
        title: 'Seite 1',
        questions: [
          {
            ...base,
            id: ids.note,
            type: 'textarea',
            label: 'Anmerkung',
            minLength: null,
            maxLength: null,
          },
          { ...base, id: ids.address, type: 'address', label: 'Anschrift' },
        ],
      },
    ],
  });

  const rows: readonly CsvRow[] = [
    {
      submittedAt: '2026-07-27T09:05:00.000Z',
      answers: {
        [ids.note]: 'Erste Zeile\nZweite Zeile',
        [ids.address]: {
          street: 'Hauptstraße 1',
          zip: '01067',
          city: 'Dresden',
          country: 'Deutschland',
        },
      },
      definition,
    },
  ];

  /**
   * The whole way the application takes — columns from the form history,
   * rows through `buildExportSheet`, and only then the format. The tests above
   * build their sheet by hand, which tests the writer precisely and leaves the
   * *assumption* open that a real sheet looks like that; this one line closes
   * it. In particular the key of the timestamp column comes here from the
   * seam and not from the test.
   */
  it('schreibt die Datei aus den Zellen der Naht', async () => {
    const columns = csvColumns(
      chooseColumns(
        responseColumnGroups(
          [{ version: 1, definition }],
          rows.map((row) => row.answers),
        ),
        undefined,
        'export',
      ),
    );
    const file = await openWithoutNetwork(
      writeHtml(buildExportSheet(columns, rows)),
    );
    const headers = elements(file.document, 'thead th').map(
      (th) => th.textContent,
    );
    const cells = elements(file.document, 'tbody td').map(
      (td) => td.textContent,
    );

    // The address stands four-columned, the timestamp as a column of its
    // own, and the postcode keeps its zero **without** the CSV's apostrophe.
    expect(headers).toContain('Anschrift — PLZ');
    expect(headers).toContain(SUBMITTED_AT_LABEL);
    expect(cells).toContain('01067');
    expect(
      elements(file.document, '.stamp-cell').map((td) => td.textContent),
    ).toContain('27.07.2026 09:05');
    // And the multi-line free text stays multi-line.
    expect(
      Array.from(
        file.document.querySelector('tbody td')?.querySelectorAll('br') ?? [],
      ).length,
    ).toBe(1);
  });
});

describe('die Größenordnung, mit der die Logo-Entscheidung rechnet', () => {
  it('schreibt eine übliche Ausfuhr in der genannten Größe', () => {
    const columns = Array.from(
      { length: 8 },
      (_, index) => `Frage ${String(index + 1)}`,
    );
    const rows = Array.from({ length: 500 }, (_, index) =>
      columns.map(() => `Antwort ${String(index)} mit etwas Text`),
    );
    const bytes = Buffer.byteLength(
      writeHtml(sheetOf(columns, rows), {
        formTitle: 'Anmeldung zum Jahrestagung 2026',
        tenantName: 'Dachorganisation',
        exportedAt: '2026-07-20T09:30:00.000Z',
      }),
      'utf8',
    );

    // The number in the module head of `export-html.ts` — 500 answers over 8
    // columns = 146 449 bytes — carries the decision against an embedded
    // logo (2 MiB upper limit ≈ 2.8 MB base64, that is 19 times the file).
    // It stands here as a measurement, so that it does not go stale silently, with room to
    // both sides: it is about the order of magnitude, not about one byte.
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(200_000);
  });
});
