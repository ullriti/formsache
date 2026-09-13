import { describe, expect, it } from 'vitest';

import {
  parseInline,
  parseLegalText,
  safeLegalHref,
  stripControlChars,
  tableHeadLines,
  withoutOpenSlots,
  type LegalBlock,
  type LegalInline,
} from './legal-text.ts';

/**
 * **The allow-list, measured against the attack** (`docs/legal/README.md`
 * 5.6/7.8).
 *
 * The finding this module stands against is named literally: „Rechtstexte
 * brauchen Formatierung" → allow HTML → `dangerouslySetInnerHTML` → a stored
 * cross-site-scripting hole on exactly the page strangers call up. A test that
 * only checks the permitted case, by contrast, proves nothing
 * (`AGENTS.md`) — so the cases that **have to fail** stand here first.
 */

/** Every text that sits in a block — for the „nichts überlebt" probes. */
function textOf(blocks: readonly LegalBlock[]): string {
  const runs = (list: readonly LegalInline[]): string =>
    list
      .map((run) =>
        run.kind === 'link'
          ? `${run.label}→${run.href}`
          : run.kind === 'gap'
            ? `⟨${run.label}⟩`
            : run.text,
      )
      .join('');
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return runs(block.runs);
        case 'list':
          return block.items.map(runs).join('\n');
        case 'table':
          return [block.head, ...block.rows]
            .map((row) => row.map(runs).join(' | '))
            .join('\n');
      }
    })
    .join('\n');
}

/** The same text, but a link counts with its **label**. */
function plainOf(blocks: readonly LegalBlock[]): string {
  return textOf(blocks).replace(/→[^\s"]*/gu, '');
}

describe('ein Rechtstext kann kein Markup werden', () => {
  it.each([
    ['ein Skript', '<script>alert(1)</script>'],
    ['ein Ereignis-Attribut', '<img src=x onerror="alert(1)">'],
    ['ein unfertiges Tag', '<script'],
    ['ein SVG mit onload', '<svg onload=alert(1)>'],
    ['ein iframe', '<iframe src="https://boese.example"></iframe>'],
    ['ein Stil', '<style>body{display:none}</style>'],
  ])('lässt %s als Text stehen und nie als Struktur', (_name, attack) => {
    const blocks = parseLegalText(`Ein Satz. ${attack} Noch ein Satz.`);

    // Exactly one paragraph, and it carries the attack as **characters**: no
    // heading, no list, no link — nothing a renderer could read as
    // markup.
    // Exactly one paragraph, and every character of the attack stands **in the
    // text**: the angle brackets have stayed characters, nothing has become
    // markup.
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.kind).toBe('paragraph');
    expect(plainOf(blocks)).toBe(`Ein Satz. ${attack} Noch ein Satz.`);
    // Only text and — where a real address happens to sit in the attack —
    // a link to it. In particular no heading, no list, no
    // table and no emphasis that the attacker would have produced.
    expect(
      block?.kind === 'paragraph' &&
        block.runs.every((run) => run.kind === 'text' || run.kind === 'link'),
    ).toBe(true);
  });

  it('macht aus einem javascript:-Ziel keinen Link', () => {
    const runs = parseInline(
      '[Hier klicken](javascript:alert(document.cookie))',
    );

    expect(runs.some((run) => run.kind === 'link')).toBe(false);
    expect(runs.map((run) => run.kind)).toEqual(['text']);
  });

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['//boese.example/imprint'],
    ['javascript:alert(1)'],
  ])('weist %s als Linkziel ab', (href) => {
    expect(safeLegalHref(href)).toBeNull();
  });

  it.each([
    ['https://example.org/imprint'],
    ['http://example.org'],
    ['mailto:datenschutz@example.org'],
    ['/imprint'],
    ['/o/TEST/privacy'],
  ])('lässt %s zu', (href) => {
    expect(safeLegalHref(href)).not.toBeNull();
  });

  /**
   * **The own path that is none** (review finding of 2026-08-18).
   *
   * A string check stood here — `startsWith('//')` —, and it caught exactly
   * the one spelling its comment named. For the
   * URL grammar, however, a `\` after the first slash is the same as
   * a second one:
   *
   * ```
   * '/\\boese.example'.startsWith('//')                      → false
   * new URL('/\\boese.example', 'https://formsache.example/') → https://boese.example/
   * ```
   *
   * A legal text could thereby write `[Datenschutz](/\boese.example)`,
   * and on the public fill-in page there stood a link that looks like an own
   * path and leads to a foreign origin — at the place where personal data are
   * about to be typed.
   *
   * The check now happens after the parse at the origin, not at prefixes.
   * That is why **several** spellings stand here: a list of prefixes
   * would again be an enumeration that overlooks the next variant.
   *
   * *Reproduction:* revert to `startsWith('//') ? null : trimmed` →
   * every line except the first turns red.
   */
  it.each([
    ['//boese.example'],
    ['/\\boese.example'],
    ['/\\\\boese.example'],
    ['/\\/boese.example'],
    ['//\\boese.example'],
  ])(
    'weist %s ab — das ist eine fremde Herkunft, kein eigener Pfad',
    (href) => {
      expect(
        safeLegalHref(href),
        `${href} löst zu ${new URL(href, 'https://formsache.example/').origin} ` +
          'auf und ist damit kein eigener Pfad.',
      ).toBeNull();
    },
  );

  /**
   * And the opposite direction: what **is** an own path comes back unchanged.
   * A check that discards the legitimate targets too would be no bolt but a
   * breakdown.
   */
  it.each([
    ['/imprint', '/imprint'],
    ['/o/TEST/privacy', '/o/TEST/privacy'],
    ['/imprint#verantwortlich', '/imprint#verantwortlich'],
    ['/licences?stand=2026', '/licences?stand=2026'],
  ])('lässt %s als eigenen Pfad durch', (href, expected) => {
    expect(safeLegalHref(href)).toBe(expected);
  });

  it('entfernt unsichtbare Steuer- und Formatzeichen', () => {
    // U+202E is the bidi mark „right-to-left override" („Trojan Source"),
    // U+200B a zero-width space, U+0000 a null byte. In a
    // legal text that is no curiosity but a display that is read differently
    // from the way it is stored.
    expect(stripControlChars('Wir\u202Ehaften\u0000 nicht\u200B')).toBe(
      'Wirhaften nicht',
    );
  });

  it('lässt einen Zeilenumbruch stehen — eine Anschrift braucht ihn', () => {
    expect(stripControlChars('Musterweg 1\n12345 Musterstadt')).toBe(
      'Musterweg 1\n12345 Musterstadt',
    );
  });
});

describe('die Struktur, die erlaubt ist', () => {
  it('liest Überschriften zweiter und dritter Ordnung', () => {
    const blocks = parseLegalText('## Impressum\n\n### Kontakt');

    expect(blocks).toEqual([
      {
        kind: 'heading',
        level: 2,
        runs: [{ kind: 'text', text: 'Impressum' }],
      },
      { kind: 'heading', level: 3, runs: [{ kind: 'text', text: 'Kontakt' }] },
    ]);
  });

  it('fasst aufeinanderfolgende Aufzählungszeilen zu einer Liste', () => {
    const blocks = parseLegalText('- eins\n- zwei\n\nDanach.');

    expect(blocks[0]).toEqual({
      kind: 'list',
      items: [
        [{ kind: 'text', text: 'eins' }],
        [{ kind: 'text', text: 'zwei' }],
      ],
    });
    expect(blocks[1]?.kind).toBe('paragraph');
  });

  it('liest eine Tabelle mit Kopfzeile', () => {
    const blocks = parseLegalText(
      '| Was | Wie lange |\n|---|---|\n| Antworten | 30 Tage |',
    );

    expect(blocks).toHaveLength(1);
    expect(textOf(blocks)).toBe('Was | Wie lange\nAntworten | 30 Tage');
  });

  it('behält die Zeilen einer Anschrift im selben Absatz', () => {
    const blocks = parseLegalText(
      'Musterverein e. V.\nMusterweg 1\n12345 Musterstadt',
    );

    expect(blocks).toHaveLength(1);
    expect(textOf(blocks)).toBe(
      'Musterverein e. V.\nMusterweg 1\n12345 Musterstadt',
    );
  });

  it('verlinkt eine nackte Adresse ohne den Satzpunkt zu schlucken', () => {
    const runs = parseInline('Mehr unter https://example.org/x.');

    expect(runs).toEqual([
      { kind: 'text', text: 'Mehr unter ' },
      {
        kind: 'link',
        href: 'https://example.org/x',
        label: 'https://example.org/x',
      },
      { kind: 'text', text: '.' },
    ]);
  });

  it('liest Betonung, aber keine einfachen Sternchen', () => {
    expect(parseInline('**fett** und *nicht kursiv*')).toEqual([
      { kind: 'strong', text: 'fett' },
      { kind: 'text', text: ' und *nicht kursiv*' },
    ]);
  });
});

/**
 * **Die offenen Angaben** (Review-Runde 5 Nr. 1) — der Baustein, den die
 * öffentliche Ansicht **vor** die Ersetzung schaltet.
 *
 * Die Regel hat drei Fälle, und der dritte ist der, an dem die erste Fassung
 * gescheitert ist: sie strich jede Zeile mit einer Lücke und nahm damit die
 * ausgefüllte Angabe daneben mit.
 */
describe('withoutOpenSlots', () => {
  it('nimmt die Zeile, auf der nichts ausgefüllt ist', () => {
    expect(
      withoutOpenSlots(
        'Musterweg 1\nTelefon: [[TELEFONNUMMER]]\n12345 Ort',
        {},
      ),
    ).toBe('Musterweg 1\n12345 Ort');
  });

  /**
   * **Der Befund des Reviews, nachgestellt.** Die Anschrift der Vorlagen steht
   * als *eine* Zeile `[[PLZ]] [[ORT]]`; wer nur den Ort hinterlegt hat, verlor
   * mit der ersten Fassung öffentlich auch den Ort — eine Angabe, die dasteht
   * und wahr ist (§ 18 Abs. 1 MStV verlangt genau die).
   */
  it('behält die Zeile, wenn daneben etwas ausgefüllt ist', () => {
    // Die **offene** Stelle ist weg, die ausgefüllte bleibt ein Platzhalter:
    // ersetzt wird sie danach, von `substituteSlots`.
    expect(withoutOpenSlots('[[PLZ]] [[ORT]]', { ORT: 'Musterstadt' })).toBe(
      '[[ORT]]',
    );
    expect(withoutOpenSlots('[[PLZ]] [[ORT]]', { PLZ: '12345' })).toBe(
      '[[PLZ]]',
    );
  });

  it('lässt eine vollständig ausgefüllte Zeile unangetastet', () => {
    expect(
      withoutOpenSlots('[[PLZ]] [[ORT]]', { PLZ: '12345', ORT: 'Musterstadt' }),
    ).toBe('[[PLZ]] [[ORT]]');
  });

  it('lässt einen Text ohne Platzhalter unverändert', () => {
    expect(withoutOpenSlots('Eine Zeile\n\nEine zweite', {})).toBe(
      'Eine Zeile\n\nEine zweite',
    );
  });

  it('schließt die Fuge, die eine weggenommene Stelle hinterlässt', () => {
    // Kein doppelter Abstand, kein führender — beides wäre die sichtbare Spur
    // dessen, was hier gerade nicht gezeigt werden soll.
    expect(
      withoutOpenSlots('Sitz: [[STRASSE]] in [[ORT]] gelegen', {
        ORT: 'Musterstadt',
      }),
    ).toBe('Sitz: in [[ORT]] gelegen');
  });

  it('prüft jede Zeile — auch die zweite von zwei Lücken', () => {
    expect(withoutOpenSlots('[[A]]\n[[B]]\nbleibt', {})).toBe('bleibt');
  });

  it('zählt einen Wert aus Leerraum als nicht ausgefüllt', () => {
    // Dieselbe Prüfung wie `substituteSlots` — sonst gälte eine Angabe an der
    // einen Stelle als vorhanden und an der anderen als fehlend.
    expect(
      withoutOpenSlots('Telefon: [[TELEFONNUMMER]]', {
        TELEFONNUMMER: '   ',
      }),
    ).toBe('');
  });

  /**
   * Ein eigener Text ruft dieselbe Funktion mit `{}`: dort hat niemand einen
   * Platzhalter ersetzt, also ist jeder offen und die Regel fällt auf „die
   * Zeile geht" zusammen.
   */
  it('nimmt aus einem eigenen Text die Zeile mit dem Platzhalter', () => {
    expect(
      withoutOpenSlots('Anbieter: X\n[[NAME]] ist nicht gesetzt', {}),
    ).toBe('Anbieter: X');
  });
});

describe('tableHeadLines', () => {
  it('findet die Kopfzeile einer Tabelle und nicht ihre Datenzeilen', () => {
    expect(
      tableHeadLines('Vorher\n\n| Frage | Antwort |\n|---|---|\n| a | b |'),
    ).toEqual(['| Frage | Antwort |']);
  });

  it('nennt eine Zeile ohne Trennzeile darunter nicht', () => {
    expect(tableHeadLines('| kein | Kopf |\n| noch | einer |')).toEqual([]);
  });
});
