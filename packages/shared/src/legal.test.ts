import { describe, expect, it } from 'vitest';

import {
  EMPTY_LEGAL_DOCUMENT,
  legalDocumentSchema,
  legalDocumentWriteSchema,
  legalPageStatus,
  openTenantLegalPages,
  parseStoredFormPrivacyNotice,
  parseStoredSystemLegalPages,
  parseStoredTenantLegalPages,
  renderFormPrivacyNotice,
  renderLegalPage,
  systemLegalPath,
  TENANT_LEGAL_PAGES,
  templateDefects,
  groupedSlots,
  tenantLegalPath,
  tenantLegalStatus,
  type LegalDocument,
  type LegalRenderContext,
  type LegalTemplate,
} from './legal.ts';
import {
  FORM_PRIVACY_TEMPLATE,
  LEGAL_LINK_LEAD,
  SYSTEM_LEGAL_TEMPLATES,
  TENANT_LEGAL_TEMPLATES,
} from './legal-templates.ts';
import type { LegalBlock, LegalInline } from './legal-text.ts';

const CONTEXT: LegalRenderContext = {
  organisationName: 'Musterverein e. V.',
  organisationShortName: 'MUST',
  operatorName: 'Beispiel-Betrieb',
  aiActive: false,
  redirectTarget: null,
};

function flatten(blocks: readonly LegalBlock[]): readonly LegalInline[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        return [...block.runs];
      case 'list':
        return block.items.flat();
      case 'table':
        return [...block.head.flat(), ...block.rows.flat().flat()];
    }
  });
}

function textOf(blocks: readonly LegalBlock[]): string {
  return flatten(blocks)
    .map((run) =>
      run.kind === 'gap'
        ? `⟨${run.label}⟩`
        : run.kind === 'link'
          ? run.label
          : run.text,
    )
    .join(' ');
}

/** Die geprüften Ziele der Links eines gerenderten Textes. */
function hrefsOf(blocks: readonly LegalBlock[]): readonly string[] {
  return flatten(blocks).flatMap((run) =>
    run.kind === 'link' ? [run.href] : [],
  );
}

function withFills(fills: Record<string, string>): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, fills };
}

describe('die ausgelieferten Vorlagen', () => {
  const all: readonly [string, LegalTemplate][] = [
    ...Object.entries(SYSTEM_LEGAL_TEMPLATES),
    ...Object.entries(TENANT_LEGAL_TEMPLATES),
    // The form-specific notice stands in the **same** check as the five pages
    // and not in one of its own: it is the same construction, and a second
    // check list would be the one that overlooks the next placeholder.
    ['form:privacy', FORM_PRIVACY_TEMPLATE],
  ];

  /**
   * **The guard without which a field would be unreachable.**
   *
   * A `[[PLATZHALTER]]` in the template text that no field list knows is a
   * field nobody can fill in — the page would permanently show a gap, and no
   * interface could close it. The other direction is just as expensive: a field
   * without a placeholder is an input field whose value appears nowhere.
   */
  it.each(all)(
    '%s beschreibt genau ihre Felder und Bedingungen',
    (_key, template) => {
      expect(templateDefects(template)).toEqual([]);
    },
  );

  /**
   * **Jedes Feld sagt, was ungefähr hineingehört** (Review-Runde 4 Nr. 5:
   * „Am besten mal überall Standardtexte oder Platzhalter rein damit man weiß
   * was da grob rein soll.").
   *
   * Ein Pflichtwert und keine Empfehlung — sonst trägt das nächste neue Feld
   * wieder nur eine Rechtsfrage als Beschriftung und keine Antwortform.
   * `suggestion` zählt mit: ein übernehmbarer Standardtext sagt dasselbe und
   * mehr.
   */
  it.each(all)('%s zeigt an jedem Feld ein Beispiel', (_key, template) => {
    expect(
      template.slots
        .filter(
          (slot) => slot.example === undefined && slot.suggestion === undefined,
        )
        .map((slot) => slot.key),
    ).toEqual([]);
  });

  /**
   * **Die Felder stehen fachlich beieinander** (Review-Runde 4 Nr. 7:
   * „Mailserver und Backup Felder haben falsche Reihenfolge und werden
   * vermischt.").
   *
   * *Reproduktion:* `MAILSERVER_ODER_DIENSTLEISTER` wieder ohne `group`
   * lassen, oder es in den Abschnitt *Datensicherung* schreiben → dieser Fall
   * wird rot. Gemessen wird der Befund selbst und keine Formalie: die drei
   * Mailfelder in **einem** Abschnitt, die beiden Sicherungsfelder in einem
   * **anderen**, und keiner der beiden Abschnitte in dem des anderen.
   */
  it('hält Mailversand und Datensicherung auseinander', () => {
    const groups = groupedSlots(SYSTEM_LEGAL_TEMPLATES.privacy.slots);
    const keysOf = (title: string): readonly string[] =>
      groups.find((group) => group.title === title)?.slots.map((s) => s.key) ??
      [];

    expect(keysOf('E-Mail-Versand')).toEqual([
      'MAILSERVER_ODER_DIENSTLEISTER',
      'NAME_DES_MAILDIENSTLEISTERS',
      'ORT_DES_MAILDIENSTLEISTERS',
    ]);
    expect(keysOf('Datensicherung')).toEqual([
      'AUFBEWAHRUNG_SICHERUNGEN',
      'ORT_DER_SICHERUNGEN',
    ]);
  });

  /**
   * Die Abschnitte stehen in der Reihenfolge ihres **ersten** Feldes, und die
   * namenlose Gruppe steht vorn. Gemessen an einer erfundenen Liste und nicht
   * an einer Vorlage: die Regel gilt für jede kommende Vorlage mit.
   */
  it('sammelt die Abschnitte in der Reihenfolge ihres ersten Feldes ein', () => {
    expect(
      groupedSlots([
        { key: 'B1', label: 'b1', group: 'B' },
        { key: 'A1', label: 'a1' },
        { key: 'C1', label: 'c1', group: 'C' },
        { key: 'B2', label: 'b2', group: 'B' },
      ]).map((group) => [group.title, group.slots.map((slot) => slot.key)]),
    ).toEqual([
      [null, ['A1']],
      ['B', ['B1', 'B2']],
      ['C', ['C1']],
    ]);
  });

  it.each(all)(
    '%s trägt keinen Platzhalter in den veröffentlichten Text',
    (_key, template) => {
      const rendered = renderLegalPage(
        template,
        withFills(
          Object.fromEntries(
            template.slots.map((slot) => [slot.key, `Wert für ${slot.key}`]),
          ),
        ),
        CONTEXT,
        'public',
      );

      expect(textOf(rendered.blocks)).not.toMatch(/\[\[|\]\]|⟪|⟫/u);
    },
  );
});

describe('der Zustand einer Seite', () => {
  const template = SYSTEM_LEGAL_TEMPLATES.imprint;

  it('sagt „leer", solange nichts hinterlegt ist', () => {
    expect(legalPageStatus(template, EMPTY_LEGAL_DOCUMENT, CONTEXT)).toBe(
      'empty',
    );
  });

  it('sagt „unfertig", solange ein Platzhalter offen ist', () => {
    const document = withFills({ NAME_DES_BETREIBERS: 'Beispiel-Betrieb' });

    expect(legalPageStatus(template, document, CONTEXT)).toBe('incomplete');
  });

  it('zählt Platzhalter aus abgewählten Blöcken nicht mit', () => {
    // The register fields belong to `registereintrag`. As long as the block is
    // off, they are no open entry — otherwise a natural person could never
    // finish their imprint.
    const complete = withFills(
      Object.fromEntries(
        template.slots
          .filter(
            (slot) =>
              ![
                'RECHTSFORM',
                'VERTRETUNGSBERECHTIGTE',
                'REGISTERGERICHT',
                'REGISTERART',
                'REGISTERNUMMER',
                'UST_IDNR',
                'AUFSICHTSBEHOERDE',
                'BERUFSBEZEICHNUNG',
                'VERLEIHUNGSSTAAT',
                'BERUFSREGELUNGEN',
                'ADRESSE_DER_BERUFSREGELUNGEN',
                'RECHTSAUFSICHT',
                'MSTV_VERANTWORTLICH',
                'ADRESSE_DER_OS_PLATTFORM',
                'BEREITSCHAFT_ZUR_SCHLICHTUNG',
              ].includes(slot.key),
          )
          .map((slot) => [slot.key, 'x']),
      ),
    );

    expect(legalPageStatus(template, complete, CONTEXT)).toBe('ready');
  });

  it('sagt „unfertig" für einen eigenen Text mit verbliebenem Platzhalter', () => {
    const document: LegalDocument = {
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'custom',
      custom: 'Impressum\n\n[[NAME_DES_BETREIBERS]]\nMusterweg 1',
    };

    expect(legalPageStatus(template, document, CONTEXT)).toBe('incomplete');
    /*
      **Der Zustand hängt am ganzen Text, nicht am öffentlich Übrigen**
      (Review-Runde 5 Nr. 1): die Zeile mit dem Platzhalter entfällt draußen,
      und trotzdem bleibt die Seite unfertig. Andernfalls hätte sich ein Text
      durch das Weglassen selbst fertiggemacht.
    */
    for (const audience of ['editor', 'public'] as const) {
      expect(
        renderLegalPage(template, document, CONTEXT, audience).status,
      ).toBe('incomplete');
    }
  });

  it('sagt „fertig" für einen eigenen Text ohne Platzhalter', () => {
    const document: LegalDocument = {
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'custom',
      custom: 'Anbieter: Beispiel-Betrieb, Musterweg 1, 12345 Musterstadt.',
    };

    expect(legalPageStatus(template, document, CONTEXT)).toBe('ready');
  });
});

/**
 * **The fold over an organisation's two pages** (ADR-0028, open item 3) —
 * one place, two answers.
 *
 * Until 2026-08-19 it stood three times side by side: in the server, in the
 * list of open items of an organisation and in the notice before publishing.
 * What is measured here is the property the three could fall out over — which
 * state wins.
 */
describe('die Rechtstexte einer Organisation als ein Urteil', () => {
  /** A page `legalPageStatus` calls „fertig": an own text. */
  const READY: LegalDocument = {
    ...EMPTY_LEGAL_DOCUMENT,
    mode: 'custom',
    custom: 'Anbieter: Musterverein e. V., Musterweg 1, 12345 Musterstadt.',
  };
  /** A page somebody started: an own text with a placeholder left in it. */
  const INCOMPLETE: LegalDocument = {
    ...EMPTY_LEGAL_DOCUMENT,
    mode: 'custom',
    custom: 'Anbieter: [[RECHTSFORM]] Musterverein',
  };

  it('sagt „fertig" nur, wenn beide Seiten fertig sind', () => {
    expect(tenantLegalStatus({ imprint: READY, privacy: READY })).toBe('ready');
    expect(
      openTenantLegalPages({ imprint: READY, privacy: READY }),
    ).toStrictEqual([]);
  });

  it('lässt den schlechteren Zustand gewinnen', () => {
    // „leer" beats „unfertig" beats „fertig" — and it does so regardless of
    // which of the two pages carries the worse one. That symmetry is what
    // keeps the single traffic light from betraying which page is meant.
    expect(tenantLegalStatus({ imprint: READY, privacy: INCOMPLETE })).toBe(
      'incomplete',
    );
    expect(tenantLegalStatus({ imprint: INCOMPLETE, privacy: READY })).toBe(
      'incomplete',
    );
    expect(
      tenantLegalStatus({ imprint: EMPTY_LEGAL_DOCUMENT, privacy: INCOMPLETE }),
    ).toBe('empty');
    expect(
      tenantLegalStatus({ imprint: INCOMPLETE, privacy: EMPTY_LEGAL_DOCUMENT }),
    ).toBe('empty');
  });

  /**
   * The second answer — the one that may name things. Deliberately not the
   * same function: whoever may only learn *that* something is missing must
   * not have a list of pages within reach at their own call site.
   */
  it('nennt die unfertigen Seiten in der Reihenfolge der Seitenliste', () => {
    expect(
      openTenantLegalPages({ imprint: READY, privacy: EMPTY_LEGAL_DOCUMENT }),
    ).toStrictEqual(['privacy']);
    expect(
      openTenantLegalPages({
        imprint: EMPTY_LEGAL_DOCUMENT,
        privacy: INCOMPLETE,
      }),
    ).toStrictEqual([...TENANT_LEGAL_PAGES]);
  });

  /**
   * ⚠️ The fold carries its own render context, and that is a statement about
   * the two templates: `TENANT_IMPRINT` has no derived block at all, and the
   * `⟪WENN:ki⟫` of `TENANT_PRIVACY` stands in its `fixed` part, which
   * `legalPageStatus` does not read. Were that to stop being true one day,
   * `aiActive: false` would become a silent false assumption — this test sees
   * it.
   */
  it('liest den KI-Block nicht aus dem Vorlagentext der beiden Seiten', () => {
    for (const page of TENANT_LEGAL_PAGES) {
      expect(TENANT_LEGAL_TEMPLATES[page].body).not.toContain('⟪WENN:ki');
    }
  });
});

describe('eine leere Seite sagt die Wahrheit', () => {
  it('nennt beim Impressum der Installation den Mangel und den Weg weiter', () => {
    const rendered = renderLegalPage(
      SYSTEM_LEGAL_TEMPLATES.imprint,
      EMPTY_LEGAL_DOCUMENT,
      CONTEXT,
      'public',
    );

    expect(rendered.status).toBe('empty');
    expect(textOf(rendered.blocks)).toContain(
      'keine Anbieterangaben hinterlegt',
    );
    // No substitute text that invents an entry — the name of the operator
    // explicitly does **not** stand here, because nobody has stored it.
    expect(textOf(rendered.blocks)).not.toContain('Beispiel-Betrieb');
  });

  it('zeigt bei den Datenschutzhinweisen einer Organisation den festen Teil trotzdem', () => {
    const rendered = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.privacy,
      EMPTY_LEGAL_DOCUMENT,
      CONTEXT,
      'public',
    );

    expect(rendered.status).toBe('empty');
    expect(textOf(rendered.blocks)).toContain(
      'noch keine eigenen Datenschutzhinweise hinterlegt',
    );
    // Part B is true regardless of whether somebody has entered something —
    // so it stands there (`docs/legal/README.md` 5.4).
    expect(textOf(rendered.blocks)).toContain(
      'Es werden keine Cookies gesetzt',
    );
    expect(textOf(rendered.blocks)).toContain('30 Tage');
  });
});

describe('die bedingten Blöcke', () => {
  it('folgt der KI-Konfiguration und nicht dem Häkchen', () => {
    const document: LegalDocument = {
      ...withFills({ NAME_DES_BETREIBERS: 'Beispiel-Betrieb', STAND: 'heute' }),
      // Somebody ticked the KI paragraph half a year ago and has switched the
      // KI off since. The paragraph must not stay standing.
      conditions: { ki: true, 'ki-aus': false },
    };

    /*
      `'editor'` und nicht `'public'`: gemessen wird, welche **Abschnitte**
      stehen, und die Felder des KI-Abschnitts sind hier absichtlich leer.
      Öffentlich entfielen deren Zeilen (Review-Runde 5 Nr. 1) und der Test
      würde die Bedingung nicht mehr sehen, um die es ihm geht.
    */
    const off = renderLegalPage(
      SYSTEM_LEGAL_TEMPLATES.privacy,
      document,
      { ...CONTEXT, aiActive: false },
      'editor',
    );
    expect(textOf(off.blocks)).toContain('Sie ist abgeschaltet');
    expect(textOf(off.blocks)).not.toContain('Verarbeitungsregion');

    const on = renderLegalPage(
      SYSTEM_LEGAL_TEMPLATES.privacy,
      document,
      { ...CONTEXT, aiActive: true },
      'editor',
    );
    expect(textOf(on.blocks)).toContain('Verarbeitungsregion');
  });
});

describe('das gespeicherte Dokument', () => {
  it('behält beide Hälften, damit ein Moduswechsel nichts verliert', () => {
    const parsed = legalDocumentSchema.parse({
      mode: 'custom',
      fills: { NAME_DES_BETREIBERS: 'Beispiel-Betrieb' },
      conditions: { 'juristische-person': true },
      custom: 'Eigener Text.',
    });

    expect(parsed.fills.NAME_DES_BETREIBERS).toBe('Beispiel-Betrieb');
    expect(parsed.custom).toBe('Eigener Text.');
  });

  it('nimmt einem Fremdwert die unsichtbaren Zeichen schon an der Spalte', () => {
    const parsed = legalDocumentSchema.parse({
      ...EMPTY_LEGAL_DOCUMENT,
      fills: { NAME_DES_BETREIBERS: '  Beispiel‮-Betrieb  ' },
    });

    expect(parsed.fills.NAME_DES_BETREIBERS).toBe('Beispiel-Betrieb');
  });

  it('liest eine unlesbare Zeile als „nichts hinterlegt" statt zu scheitern', () => {
    // An imprint that delivers a 500 because of a broken JSONB is the most
    // expensive failure imaginable: § 18 MStV demands „ständig verfügbar".
    expect(parseStoredSystemLegalPages({ imprint: 'kaputt' })).toEqual({
      imprint: EMPTY_LEGAL_DOCUMENT,
      privacy: EMPTY_LEGAL_DOCUMENT,
    });
  });
});

describe('die Adressen', () => {
  it('stehen an einer Stelle', () => {
    expect(systemLegalPath('imprint')).toBe('/imprint');
    expect(systemLegalPath('privacy')).toBe('/privacy');
    expect(tenantLegalPath('MUST', 'imprint')).toBe('/o/MUST/imprint');
  });

  it('kodiert einen Kurznamen, der kodiert werden muss', () => {
    expect(tenantLegalPath('a/b', 'privacy')).toBe('/o/a%2Fb/privacy');
  });
});

/**
 * **The privacy notice of a form** (ADR-0028 no. 4).
 *
 * What is checked is the one decision that distinguishes
 * {@link renderFormPrivacyNotice} from {@link renderLegalPage}: "nothing
 * stored" travels as `null` and not as a substitute text — and "incomplete"
 * travels nevertheless, with its named gaps.
 */
describe('renderFormPrivacyNotice', () => {
  it('liefert null, solange nichts hinterlegt ist', () => {
    expect(
      renderFormPrivacyNotice(
        FORM_PRIVACY_TEMPLATE,
        EMPTY_LEGAL_DOCUMENT,
        CONTEXT,
      ),
    ).toBeNull();
  });

  it('liefert null für einen leeren eigenen Text', () => {
    expect(
      renderFormPrivacyNotice(
        FORM_PRIVACY_TEMPLATE,
        { ...EMPTY_LEGAL_DOCUMENT, mode: 'custom', custom: '   ' },
        CONTEXT,
      ),
    ).toBeNull();
  });

  /**
   * **Review-Runde 5 Nr. 1:** die angefangene Fassung reist weiter mit — ohne
   * ihre Lücken. Was dasteht, ist wahr; was fehlt, ist eine Auskunft an die
   * Organisation und nicht an die ausfüllende Person (die Ampel dafür liest
   * `legalPageStatus`, und die sagt weiterhin „unvollständig").
   */
  it('trägt eine angefangene Fassung hinaus, ohne ihre Lücken zu zeigen', () => {
    const started = withFills({ ZWECK: 'Anmeldung zur Jahrestagung 2026' });
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      started,
      CONTEXT,
    );
    const text = textOf(notice?.blocks ?? []);

    expect(text).toContain('Anmeldung zur Jahrestagung 2026');
    expect(text).not.toContain('⟨');
    expect(text).not.toContain('Rechtsgrundlage');
    expect(legalPageStatus(FORM_PRIVACY_TEMPLATE, started, CONTEXT)).toBe(
      'incomplete',
    );
  });

  it('liefert Blöcke und niemals Markup', () => {
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      {
        ...EMPTY_LEGAL_DOCUMENT,
        mode: 'custom',
        custom: '<script>alert(1)</script>',
      },
      CONTEXT,
    );

    expect(notice?.blocks).toEqual([
      {
        kind: 'paragraph',
        runs: [{ kind: 'text', text: '<script>alert(1)</script>' }],
      },
    ]);
  });
});

/**
 * **Die Weiterleitung nach dem Absenden** (ADR-0028 Nr. 5).
 *
 * Der eine Abschnitt dieses Hinweises, den niemand beantwortet: er steht genau
 * dann, wenn für dieses Formular eine Weiterleitung eingerichtet ist, und
 * nennt die Adresse, die in den Einstellungen steht. Geprüft wird deshalb
 * beides — dass er steht **und** dass er ausbleibt —, denn ein abgeleiteter
 * Satz, der immer steht, wäre eine Behauptung über eine Übermittlung, die gar
 * nicht stattfindet.
 */
describe('der abgeleitete Abschnitt zur Weiterleitung', () => {
  const TARGET = 'https://beispielverein.de/danke';

  /** Ein Hinweis, dem nichts fehlt — die Grundlage für die Ampel-Proben. */
  const COMPLETE = withFills({
    ZWECK: 'Anmeldung zur Jahrestagung 2026',
    RECHTSGRUNDLAGE: 'Art. 6 Abs. 1 lit. b DSGVO',
    AUFBEWAHRUNG: 'Bis zum Ende des auf die Tagung folgenden Jahres',
  });

  const withTarget = (redirectTarget: string | null): LegalRenderContext => ({
    ...CONTEXT,
    redirectTarget,
  });

  it('steht im Hinweis und nennt die Zieladresse', () => {
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      COMPLETE,
      withTarget(TARGET),
    );

    expect(textOf(notice?.blocks ?? [])).toContain(
      'Weiterleitung nach dem Absenden',
    );
    // Die Adresse steht als geprüfter Link da und nicht als roher Text: sie
    // ist durch dieselbe Positivliste gegangen wie jeder andere Wert.
    expect(hrefsOf(notice?.blocks ?? [])).toContain(TARGET);
  });

  it('steht nicht, solange keine Weiterleitung eingerichtet ist', () => {
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      COMPLETE,
      withTarget(null),
    );

    expect(textOf(notice?.blocks ?? [])).not.toContain(
      'Weiterleitung nach dem Absenden',
    );
    expect(textOf(notice?.blocks ?? [])).not.toContain('weitergeleitet');
  });

  /**
   * ⚠️ **Ein abgeleiteter Wert ist kein offener Platzhalter.** Die Ampel darf
   * sich durch diesen Abschnitt in keine Richtung bewegen: ein Formular ohne
   * Weiterleitung wird nicht „unvollständig", weil ihm eine Adresse fehlt,
   * nach der es niemand gefragt hat — und eines mit Weiterleitung auch nicht,
   * weil die Anwendung die Adresse selbst einsetzt.
   */
  it.each([
    ['ohne Weiterleitung', null],
    ['mit Weiterleitung', TARGET],
  ])('lässt die Ampel %s auf „ready"', (_case, target) => {
    expect(
      legalPageStatus(FORM_PRIVACY_TEMPLATE, COMPLETE, withTarget(target)),
    ).toBe('ready');
  });

  it('trägt die Zieladresse nie in die Liste der offenen Angaben', () => {
    const started = withFills({ ZWECK: 'Anmeldung zur Jahrestagung 2026' });

    // Die Gegenprobe zur Zusage: der Hinweis ist aus **eigenem** Grund
    // unfertig, und die abgeleitete Adresse ist keiner davon. Gemessen an der
    // Vorschau des Editors, denn nur die zeigt die Lücken überhaupt noch
    // (Review-Runde 5 Nr. 1).
    const preview = renderLegalPage(
      FORM_PRIVACY_TEMPLATE,
      started,
      withTarget(TARGET),
      'editor',
    );

    expect(preview.status).toBe('incomplete');
    expect(preview.missing).toContain('Rechtsgrundlage');
    expect(preview.missing).not.toContain('Zieladresse der Weiterleitung');
  });

  /**
   * **Die dritte Schranke.**
   *
   * `externalUrlSchema` weist ein `javascript:`-Ziel schon beim Speichern und
   * beim Lesen der Spalte ab, `effectiveRedirect` beim Herausgeben — beides
   * ist in `form-settings.test.ts` belegt. Hier steht die Schranke dahinter:
   * `LegalRenderContext` ist ein einfacher TypeScript-Typ, den jeder Aufrufer
   * von Hand bauen kann, und selbst dann darf ein solches Ziel im Rechtstext
   * kein Link werden.
   */
  it('macht aus einem javascript:-Ziel Text und niemals einen Link', () => {
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      COMPLETE,
      withTarget('javascript:alert(1)'),
    );

    expect(hrefsOf(notice?.blocks ?? [])).not.toContain('javascript:alert(1)');
    // Verschluckt wird es aber auch nicht: es steht sichtbar als toter Text
    // da, so wie jedes andere unzulässige Ziel (`parseInline`).
    expect(textOf(notice?.blocks ?? [])).toContain('javascript:alert(1)');
  });

  /**
   * Die Gegenprobe eine Ebene höher: die Hinweise der **Organisation** nennen
   * keine Zieladresse mehr und fragen nach keiner. Dort hat die Frage keine
   * eindeutige Antwort — mehrere Formulare haben mehrere Ziele —, und ein
   * Feld dafür wäre eines, das niemand richtig ausfüllen kann.
   */
  it('nennt in den Hinweisen der Organisation keine Adresse und keine Lücke', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.privacy,
      { ...EMPTY_LEGAL_DOCUMENT, conditions: { weiterleitung: true } },
      CONTEXT,
      'public',
    );

    expect(textOf(page.blocks)).toContain('Weiterleitung nach dem Absenden');
    expect(textOf(page.blocks)).not.toContain('⟨Zieladresse');
    expect(
      TENANT_LEGAL_TEMPLATES.privacy.slots.map((slot) => slot.key),
    ).not.toContain('ZIELADRESSE_DER_WEITERLEITUNG');
  });

  /**
   * ⚠️ **Der feste Teil weckt keinen leeren Hinweis auf.** Ein Formular ohne
   * eigenen Datenschutzhinweis liefert weiterhin `null` — auch dann, wenn es
   * weiterleitet. Das ist die benannte Grenze dieser Entscheidung und keine
   * Nachlässigkeit: „leer heißt öffentlich nichts" (ADR-0028 Nr. 4), und ein
   * einzelner Abschnitt ohne den Hinweis darum herum wäre ein Rechtstext, den
   * niemand geschrieben hat. Für diesen Fall steht der allgemeine Abschnitt in
   * den Hinweisen der Organisation.
   */
  it('weckt einen leeren Hinweis auch mit Weiterleitung nicht auf', () => {
    expect(
      renderFormPrivacyNotice(
        FORM_PRIVACY_TEMPLATE,
        EMPTY_LEGAL_DOCUMENT,
        withTarget(TARGET),
      ),
    ).toBeNull();
  });

  /**
   * Neben einem **eigenen** Text steht er dagegen sehr wohl — das ist der
   * Grund, aus dem der Satz im `fixed`-Teil steht und nicht im Vorlagentext:
   * er beschreibt, was das Formular tut, und nicht, was jemand über es
   * schreibt.
   */
  it('steht auch neben einem eigenen Text', () => {
    const notice = renderFormPrivacyNotice(
      FORM_PRIVACY_TEMPLATE,
      {
        ...EMPTY_LEGAL_DOCUMENT,
        mode: 'custom',
        custom: 'Wir erheben diese Angaben für die Jahrestagung.',
      },
      withTarget(TARGET),
    );

    expect(textOf(notice?.blocks ?? [])).toContain(
      'Weiterleitung nach dem Absenden',
    );
    expect(hrefsOf(notice?.blocks ?? [])).toContain(TARGET);
  });
});

/**
 * An unreadable column does not take **the form** down — the same direction
 * `parseStoredTenantLegalPages` takes for the legal-text pages, and for a
 * sharper reason: here the public fill-in path would hang off it.
 */
describe('parseStoredFormPrivacyNotice', () => {
  it('liest null als „nichts hinterlegt"', () => {
    expect(parseStoredFormPrivacyNotice(null)).toEqual(EMPTY_LEGAL_DOCUMENT);
  });

  it('liest Unsinn als „nichts hinterlegt"', () => {
    expect(parseStoredFormPrivacyNotice({ mode: 'was auch immer' })).toEqual(
      EMPTY_LEGAL_DOCUMENT,
    );
  });

  /**
   * ⚠️ **Ein Dokument aus der Zeit vor `mode: 'link'` bleibt lesbar** und
   * bekommt den leeren Verweis dazu (Review-Runde 5, Nachtrag). Das ist der
   * Fall, den jede gespeicherte Zeile dieser Installation heute hat — ohne die
   * Vorgabe am Feld wäre sie am `strictObject` gescheitert, und aus einem
   * Impressum wäre „nichts hinterlegt" geworden.
   */
  it('liest ein gültiges Dokument unverändert', () => {
    expect(
      parseStoredFormPrivacyNotice({
        mode: 'template',
        fills: { ZWECK: 'Anmeldung' },
        conditions: { pflichtangaben: true },
        custom: '',
      }),
    ).toEqual({
      mode: 'template',
      fills: { ZWECK: 'Anmeldung' },
      conditions: { pflichtangaben: true },
      custom: '',
      link: '',
    });
  });
});

/**
 * **Review-Runde 5 Nr. 1 — die Zielgruppe der Ausgabe.**
 *
 * Der Befund war eine Beobachtung über das Aussehen: *„unvollständige Angaben
 * sollten nicht in der öffentlichen Ansicht angezeigt werden. Das sieht nicht
 * gut aus."* Was daraus wurde, ist eine Aussage über die Wahrheit einer Seite,
 * und sie hat zwei Hälften, die **beide** gemessen werden müssen:
 *
 * 1. Draußen fehlt die offene Angabe **samt ihrer Zeile** — keine Marke, keine
 *    Beschriftung ohne Wert, kein `[[…]]`.
 * 2. Was wahr ist, bleibt stehen. Eine Seite, die beim ersten fehlenden Feld
 *    verstummt, wäre die schlechtere Antwort auf denselben Befund — § 18 Abs. 1
 *    MStV verlangt, was da ist.
 */
describe('die Zielgruppe entscheidet über die offenen Angaben', () => {
  /** Angefangen: Straße getippt, alles andere offen. */
  const started = withFills({ STRASSE_UND_HAUSNUMMER: 'Vereinsweg 2' });

  it('lässt öffentlich die Zeile mit der offenen Angabe weg und behält die wahre', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      started,
      CONTEXT,
      'public',
    );
    const text = textOf(page.blocks);

    expect(text).toContain('Vereinsweg 2');
    // Keine benannte Lücke — `textOf` schreibt sie als ⟨…⟩.
    expect(text).not.toContain('⟨');
    /*
      **Die Beschriftung geht mit ihrem Wert.** Genau hier liegt der
      Unterschied zwischen zeilenweise und absatzweise: „Telefon: " ohne Nummer
      wäre der Rest, den ein Ersetzen durch nichts stehen lässt — und die
      Anschrift zwei Zeilen darüber wäre weg, wenn der ganze Absatz entfiele.
    */
    expect(text).not.toContain('Telefon:');
  });

  /**
   * **Der Befund des Reviews, und der Grund für die Regel in ihrer heutigen
   * Form.** Die Anschrift der Vorlagen steht als *eine* Zeile
   * `[[PLZ]] [[ORT]]`. Die erste Fassung strich jede Zeile mit einer Lücke —
   * und nahm damit den ausgefüllten Ort mit, eine Angabe, die dasteht und wahr
   * ist. § 18 Abs. 1 MStV verlangt genau die.
   */
  it('behält eine ausgefüllte Angabe, die neben einer fehlenden steht', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      withFills({ ORT: 'Musterstadt' }),
      CONTEXT,
      'public',
    );
    expect(textOf(page.blocks)).not.toContain('⟨');
    /*
      **Am Absatz gemessen und nicht am zusammengeschriebenen Text**: geprüft
      wird auch, dass die Fuge geschlossen ist. „ Musterstadt" mit führendem
      Abstand wäre die sichtbare Spur der weggenommenen Postleitzahl.
    */
    const address = page.blocks.find(
      (block) =>
        block.kind === 'paragraph' &&
        block.runs.some(
          (run) => run.kind === 'text' && run.text.includes('Musterstadt'),
        ),
    );
    expect(address).toBeDefined();
    expect(textOf(address === undefined ? [] : [address])).toBe(
      'Musterverein e. V.\nMusterstadt',
    );
  });

  /**
   * **Eine Überschrift ohne Abschnitt ist derselbe Befund an einer neuen
   * Stelle** („das sieht nicht gut aus"). Steht unter *Kontakt* nach dem
   * Weglassen nichts mehr, geht die Überschrift mit.
   */
  it('nimmt eine Überschrift mit, unter der nichts übrig bleibt', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      withFills({ ORT: 'Musterstadt' }),
      CONTEXT,
      'public',
    );

    // Im Editor steht sie mitsamt ihren Lücken …
    expect(
      textOf(
        renderLegalPage(
          TENANT_LEGAL_TEMPLATES.imprint,
          withFills({ ORT: 'Musterstadt' }),
          CONTEXT,
          'editor',
        ).blocks,
      ),
    ).toContain('Kontakt');
    // … öffentlich ist von ihr nichts geblieben, weil ihr Inhalt entfiel.
    expect(textOf(page.blocks)).not.toContain('Kontakt');
    // Die Überschrift des Abschnitts, der Inhalt hat, bleibt selbstverständlich.
    expect(textOf(page.blocks)).toContain('Verantwortliche Stelle');
  });

  it('zeigt dieselbe Seite im Editor mit benannten Lücken', () => {
    const preview = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      started,
      CONTEXT,
      'editor',
    );

    expect(textOf(preview.blocks)).toContain('⟨Telefonnummer⟩');
    /*
      **Gemessen an einer Pflichtangabe.** Die Telefonnummer steht in der
      Vorschau als benannte Lücke — in `missing` steht sie seit Review-Runde 5
      (Nachtrag) nicht mehr, weil sie freiwillig ist und die Seite nicht
      unfertig macht (`LegalSlot.optional`).
    */
    expect(preview.missing).toContain('Postleitzahl');
    expect(preview.missing).not.toContain('Telefonnummer');
  });

  it('sagt für beide Zielgruppen denselben Zustand', () => {
    for (const audience of ['editor', 'public'] as const) {
      expect(
        renderLegalPage(
          TENANT_LEGAL_TEMPLATES.imprint,
          started,
          CONTEXT,
          audience,
        ).status,
      ).toBe('incomplete');
    }
  });

  /**
   * Der eigene Text hat die **zweite** Schreibweise einer offenen Angabe: dort
   * ersetzt niemand etwas, das `[[…]]` steht wörtlich da. Eine Fassung, die nur
   * die Sentinel kennt, hätte genau hier ein `[[NAME]]` veröffentlicht.
   */
  it('nimmt aus einem eigenen Text die Zeile mit dem stehengebliebenen Platzhalter', () => {
    const own: LegalDocument = {
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'custom',
      custom: 'Anbieter: Musterverein e. V.\nTelefon: [[TELEFONNUMMER]]',
    };

    const text = textOf(
      renderLegalPage(TENANT_LEGAL_TEMPLATES.imprint, own, CONTEXT, 'public')
        .blocks,
    );

    expect(text).toContain('Musterverein');
    expect(text).not.toContain('[[');
    expect(text).not.toContain('Telefon:');
  });

  /**
   * Bleibt von einem eigenen Text öffentlich **nichts** übrig, ist „nichts
   * hinterlegt" die wahre Aussage — und für den Hinweis eines Formulars heißt
   * das: er reist gar nicht mit. Eine leere Überschrift wäre die dritte,
   * schlechteste Möglichkeit.
   */
  it('wird zu „nichts hinterlegt", wenn öffentlich keine Zeile übrig bleibt', () => {
    const own: LegalDocument = {
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'custom',
      custom: '[[ZWECK]]\n[[RECHTSGRUNDLAGE]]',
    };

    expect(
      renderLegalPage(FORM_PRIVACY_TEMPLATE, own, CONTEXT, 'public').status,
    ).toBe('empty');
    expect(renderFormPrivacyNotice(FORM_PRIVACY_TEMPLATE, own, CONTEXT)).toBe(
      null,
    );
    // Im Editor bleibt er, was er ist: unfertig, mit dem Platzhalter sichtbar.
    expect(
      renderLegalPage(FORM_PRIVACY_TEMPLATE, own, CONTEXT, 'editor').status,
    ).toBe('incomplete');
  });

  /**
   * Der **feste** Teil überlebt das Weglassen. Er beschreibt, was die Software
   * tut, hängt an keinem Feld — und stünde er nicht da, hätte das Weglassen
   * eine Aussage mitgenommen, die niemand hätte ausfüllen können.
   */
  it('behält den festen Teil der Datenschutzhinweise', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.privacy,
      withFills({ ZWECKE_UND_RECHTSGRUNDLAGEN: 'Anmeldung zur Tagung' }),
      CONTEXT,
      'public',
    );

    expect(page.status).toBe('incomplete');
    expect(textOf(page.blocks)).toContain('Anmeldung zur Tagung');
    expect(textOf(page.blocks)).toContain('Es werden keine Cookies gesetzt');
  });

  /**
   * **Auch der Ersatztext der leeren Seite geht durch die Regel** (Befund des
   * Reviews zu dieser Änderung).
   *
   * Er trägt nur `APP_`-Werte, und die stehen fast immer — aber „fast immer" ist
   * keine Zusicherung. Ohne Kurznamen ist `APP_ADRESSE_ORG_IMPRESSUM` leer, und
   * ohne diese Stufe stünde auf einer öffentlichen Seite „⟨Adresse der
   * Anbieterangaben⟩". Damit gilt „in einer öffentlichen Nutzlast entsteht keine
   * Lücke" für die Bauart und nicht nur für den Normalfall.
   */
  it('nimmt eine offene Angabe auch aus dem Ersatztext der leeren Seite', () => {
    const withoutShortName: LegalRenderContext = {
      ...CONTEXT,
      organisationShortName: null,
    };

    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.privacy,
      EMPTY_LEGAL_DOCUMENT,
      withoutShortName,
      'public',
    );

    expect(page.status).toBe('empty');
    expect(textOf(page.blocks)).not.toContain('⟨');
    // Im Editor bleibt sie sichtbar — dort ist sie die Auskunft.
    expect(
      textOf(
        renderLegalPage(
          TENANT_LEGAL_TEMPLATES.privacy,
          EMPTY_LEGAL_DOCUMENT,
          withoutShortName,
          'editor',
        ).blocks,
      ),
    ).toContain('⟨');
  });

  /**
   * **Die Vorlagen dürfen keinen Platzhalter in eine Tabellenkopfzeile
   * schreiben**, seit eine Zeile entfallen kann: fiele der Kopf weg, bliebe die
   * Trennzeile `|---|---|` als Absatz stehen. Heute tut das keine — und dass es
   * so bleibt, prüft `templateDefects` und nicht die Gewohnheit.
   */
  it('nennt einen Platzhalter in einer Tabellenkopfzeile als Vorlagenfehler', () => {
    const broken: LegalTemplate = {
      key: 'test:kopfzeile',
      title: 'Test',
      purpose: 'Test',
      body: '| [[SPALTE]] | Antwort |\n|---|---|\n| a | b |',
      fixed: null,
      emptyBody: 'Nichts.',
      slots: [{ key: 'SPALTE', label: 'Spalte' }],
      conditions: [],
    };

    expect(templateDefects(broken)).toContain(
      'test:kopfzeile: Platzhalter [[SPALTE]] steht in einer Tabellenkopfzeile.',
    );
  });
});

/**
 * **Der dritte Weg: der Text steht schon woanders** (Review-Runde 5, Nachtrag).
 *
 * *„füge noch als Alternative bei den Rechtstexten die Angabe eines Links zur
 * Weiterleitung zu dem jeweiligen Rechtstext an."* Wer sein Impressum auf der
 * eigenen Website hat, soll es nicht ein zweites Mal pflegen müssen — zwei
 * Fassungen desselben Textes sind eine, die stimmt, und eine, die niemand
 * nachzieht.
 *
 * **Verweis und nicht Weiterleitung**, und das ist die Entscheidung des
 * Betreibers vom 2026-09-07: drei der fünf Vorlagen tragen einen festen Teil,
 * den nur diese Anwendung sagen kann (Auftragsverarbeitung, keine Cookies,
 * Speicherorte, Löschfristen). Eine echte Weiterleitung würde ihn wegwerfen.
 */
describe('ein Rechtstext als Verweis', () => {
  const TARGET = 'https://musterverein.example/impressum';

  function withLink(link: string): LegalDocument {
    return { ...EMPTY_LEGAL_DOCUMENT, mode: 'link', link };
  }

  it('zeigt den Verweis und gilt als vollständig', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      withLink(TARGET),
      CONTEXT,
      'public',
    );

    expect(page.status).toBe('ready');
    expect(
      legalPageStatus(
        TENANT_LEGAL_TEMPLATES.imprint,
        withLink(TARGET),
        CONTEXT,
      ),
    ).toBe('ready');
    expect(textOf(page.blocks)).toContain(LEGAL_LINK_LEAD);
    expect(hrefsOf(page.blocks)).toContain(TARGET);
  });

  /**
   * **Der feste Teil überlebt den Verweis** — und das ist der ganze Grund,
   * warum die Seite verweist statt weiterzuleiten. Was hier steht, sagt nur
   * diese Anwendung über sich, und keine fremde Seite trägt es.
   */
  it('behält den festen Teil unter dem Verweis', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.privacy,
      withLink(TARGET),
      CONTEXT,
      'public',
    );

    expect(textOf(page.blocks)).toContain(LEGAL_LINK_LEAD);
    expect(textOf(page.blocks)).toContain('Es werden keine Cookies gesetzt');
  });

  it('ist ohne Adresse nichts hinterlegt — und nicht eine leere Seite', () => {
    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      withLink(''),
      CONTEXT,
      'public',
    );

    expect(page.status).toBe('empty');
    expect(textOf(page.blocks)).toContain('keine Anbieterangaben hinterlegt');
  });

  /**
   * **Die zweite Schranke, gemessen.** Das Schema weist ein `javascript:`-Ziel
   * schon beim Speichern ab; hier steht der Fall dahinter — eine Spalte, in die
   * jemand von Hand geschrieben hat. Ein toter Verweis ist dann „nichts
   * hinterlegt" und keine Seite mit einem Ziel, dem ein Browser folgt.
   */
  it('weist ein Ziel ab, dem kein Browser folgen darf', () => {
    expect(
      legalDocumentWriteSchema.safeParse({
        ...EMPTY_LEGAL_DOCUMENT,
        mode: 'link',
        link: 'javascript:alert(1)',
      }).success,
    ).toBe(false);

    const page = renderLegalPage(
      TENANT_LEGAL_TEMPLATES.imprint,
      // Am Schema vorbei, wie eine von Hand geschriebene Zeile.
      { ...EMPTY_LEGAL_DOCUMENT, mode: 'link', link: 'javascript:alert(1)' },
      CONTEXT,
      'public',
    );

    expect(page.status).toBe('empty');
    expect(hrefsOf(page.blocks)).not.toContain('javascript:alert(1)');
  });

  /**
   * **Der Befund des Reviews: eine Adresse ist kein Text** — und wurde bis
   * hierher als Auszeichnung zusammengesetzt und wieder geparst.
   *
   * `https://a.example/a)b` ist eine gewöhnliche Adresse (SharePoint,
   * Wikipedia, viele Redaktionssysteme setzen Klammern), das Schema nimmt sie
   * an, die Karte sagt „Vollständig" — und die veröffentlichte Seite verwies
   * auf `https://a.example/a`, weil die Klammer den Markdown-Link beendete. Ein
   * `](` im Pfad konnte das Ziel sogar austauschen. Gemessen wird deshalb die
   * **Gleichheit** von Ziel und Beschriftung mit dem, was hinterlegt ist.
   */
  it('verweist auf genau die Adresse, die hinterlegt ist', () => {
    for (const link of [
      'https://a.example/a)b',
      'https://a.example/a]b',
      'https://a.example/x](https://evil.example/y',
      'https://a.example/pfad?q=1&r=2#teil',
    ]) {
      const page = renderLegalPage(
        TENANT_LEGAL_TEMPLATES.imprint,
        withLink(link),
        CONTEXT,
        'public',
      );

      expect(page.status, link).toBe('ready');
      // Der erste Link der Seite ist der Verweis; die weiteren gehören dem
      // festen Teil (Impressum und Datenschutzerklärung des Betreibers).
      expect(hrefsOf(page.blocks)[0], link).toBe(link);
      // Die Beschriftung ist die Adresse: wer klickt, sieht vorher, wohin.
      expect(textOf(page.blocks), link).toContain(link);
    }
  });

  it('behält Vorlage und eigenen Text beim Umschalten', () => {
    const document: LegalDocument = {
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'link',
      fills: { ORT: 'Musterstadt' },
      custom: 'Eigener Text.',
      link: TARGET,
    };

    expect(legalDocumentSchema.parse(document)).toEqual(document);
  });
});

/**
 * **Ein freiwilliges Feld macht keine Seite unvollständig** (Review-Runde 5,
 * Nachtrag).
 *
 * *„Rechtstexte offen Hinweis sollte nur bei den wichtigen Punkten angezeigt
 * werden. Die Telefonnummer ist ja optional dachte ich."* Sie ist es — § 5
 * Abs. 1 Nr. 2 DDG verlangt die E-Mail-Adresse, nicht das Telefon (EuGH
 * C-298/07), und der Hinweis an dem Feld sagte das längst.
 */
describe('freiwillige Felder', () => {
  /** Alles Pflichtige der Anbieterangaben, ohne Telefonnummer. */
  const withoutPhone = withFills(
    Object.fromEntries(
      TENANT_LEGAL_TEMPLATES.imprint.slots
        .filter((slot) => slot.optional !== true)
        .filter(
          (slot) =>
            ![
              'RECHTSFORM',
              'VERTRETUNGSBERECHTIGTE',
              'REGISTERGERICHT',
              'REGISTERNUMMER',
              'DATENSCHUTZBEAUFTRAGTER',
            ].includes(slot.key),
        )
        .map((slot) => [slot.key, 'x']),
    ),
  );

  it('zählt die fehlende Telefonnummer nicht gegen die Seite', () => {
    expect(
      legalPageStatus(TENANT_LEGAL_TEMPLATES.imprint, withoutPhone, CONTEXT),
    ).toBe('ready');
    expect(
      renderLegalPage(
        TENANT_LEGAL_TEMPLATES.imprint,
        withoutPhone,
        CONTEXT,
        'editor',
      ).missing,
    ).not.toContain('Telefonnummer');
  });

  /**
   * Die Gegenprobe, ohne die der Fall oben nichts belegte: **eine
   * Pflichtangabe zählt weiter mit.** Sonst wäre „optional" ein Schalter, der
   * die Ampel abschaltet.
   */
  it('zählt eine fehlende Pflichtangabe weiterhin mit', () => {
    const withoutEmail: LegalDocument = {
      ...withoutPhone,
      fills: { ...withoutPhone.fills, E_MAIL_ADRESSE: '' },
    };

    expect(
      legalPageStatus(TENANT_LEGAL_TEMPLATES.imprint, withoutEmail, CONTEXT),
    ).toBe('incomplete');
  });

  /**
   * **Sichtbar bleibt sie trotzdem** — in der Vorschau des Editors als benannte
   * Lücke. „Zählt nicht" heißt nicht „gibt es nicht": wer die Nummer nachtragen
   * will, soll sehen, wo sie hingehört.
   */
  it('zeigt die Lücke in der Vorschau des Editors weiterhin an', () => {
    expect(
      textOf(
        renderLegalPage(
          TENANT_LEGAL_TEMPLATES.imprint,
          withoutPhone,
          CONTEXT,
          'editor',
        ).blocks,
      ),
    ).toContain('⟨Telefonnummer⟩');
  });

  /**
   * ⚠️ **Sparsam vergeben.** Freiwillig ist heute genau ein Feld, und zwar in
   * jeder Vorlage, die es hat: die Telefonnummer. Kommt ein zweites hinzu, ist
   * das eine Aussage über die Rechtslage — dieser Fall zwingt dazu, sie
   * aufzuschreiben, statt sie nebenbei zu treffen.
   */
  it('kennt genau ein freiwilliges Feld je Vorlage', () => {
    const optional = [
      ...Object.entries(SYSTEM_LEGAL_TEMPLATES),
      ...Object.entries(TENANT_LEGAL_TEMPLATES),
      ['form:privacy', FORM_PRIVACY_TEMPLATE] as const,
    ].map(([key, template]) => [
      key,
      template.slots.filter((slot) => slot.optional === true).map((s) => s.key),
    ]);

    expect(optional).toEqual([
      ['imprint', ['TELEFONNUMMER']],
      ['privacy', ['TELEFONNUMMER']],
      ['imprint', ['TELEFONNUMMER']],
      ['privacy', ['TELEFONNUMMER']],
      ['form:privacy', []],
    ]);
  });
});

/**
 * **Die Adresse eines Verweises** (Review-Runde 5, Nachtrag).
 *
 * Zwei Schemata, zwei Richtungen: gelesen wird nachsichtig, geschrieben wird
 * geprüft. Der Unterschied ist nicht Bequemlichkeit — eine von Hand
 * geschriebene Zeile mit unbrauchbarem Verweis darf nicht das ganze Dokument
 * unlesbar machen und damit Impressum *und* Datenschutzerklärung auf „nichts
 * hinterlegt" setzen.
 */
describe('die Adresse eines Verweises', () => {
  it('wird gespeichert, wie sie getippt wurde — nur getrimmt', () => {
    /*
      **Nicht normalisiert**, und das hält die Spalte an ihrer Obergrenze:
      `new URL().href` prozentkodiert, und aus einem Gedankenstrich würden neun
      Zeichen. Wohin ein Browser geht, entscheidet `renderLegalPage` beim
      Ausliefern.
    */
    expect(
      legalDocumentSchema.parse({
        ...EMPTY_LEGAL_DOCUMENT,
        link: '  https://musterverein.example/impressum  ',
      }).link,
    ).toBe('https://musterverein.example/impressum');
  });

  it('lässt sie leer, solange keine hinterlegt ist', () => {
    expect(legalDocumentSchema.parse(EMPTY_LEGAL_DOCUMENT).link).toBe('');
  });

  /**
   * **Geprüft wird beim Schreiben, und nur im Verweis-Modus.**
   *
   * Der Befund des Reviews, den das verhindert: die drei Hälften eines
   * Dokuments reisen immer mit, und eine halb getippte Adresse blockierte
   * sonst das Speichern einer ausgefüllten **Vorlage** — mit einem 400 auf ein
   * Feld, das die Karte in diesem Modus gar nicht zeichnet.
   */
  it('weist ein unbrauchbares Ziel im Verweis-Modus ab und nennt das Feld', () => {
    const refused = legalDocumentWriteSchema.safeParse({
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'link',
      link: 'javascript:alert(1)',
    });

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['link']);
  });

  it('lässt dieselbe Adresse stehen, solange ein anderer Modus gilt', () => {
    // Sie gilt nicht, also blockiert sie nicht — gezeigt wird sie ohnehin nie
    // (`renderLegalPage` liest sie nur in `mode: 'link'`).
    expect(
      legalDocumentWriteSchema.safeParse({
        ...EMPTY_LEGAL_DOCUMENT,
        mode: 'template',
        link: 'kein-schema.example/impressum',
      }).success,
    ).toBe(true);
  });

  /**
   * **Die nachsichtige Richtung, und warum sie es sein muss.** Eine Zeile, die
   * am Schreibweg vorbei entstanden ist, macht die Seite `empty` — sie macht
   * nicht das Dokument unlesbar.
   */
  it('liest eine unbrauchbare Adresse, ohne das Dokument zu verlieren', () => {
    const parsed = legalDocumentSchema.safeParse({
      ...EMPTY_LEGAL_DOCUMENT,
      mode: 'link',
      link: 'javascript:alert(1)',
      fills: { ORT: 'Musterstadt' },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.fills.ORT).toBe('Musterstadt');
  });
});

/**
 * **Ein Dokument aus der Zeit vor dem Verweis bleibt lesbar** — für **alle
 * drei** Lesepfade (Befund des Reviews: geprüft war nur der dritte).
 *
 * Ein Fehler hier kostet nicht ein Feld, sondern die Seite: die beiden
 * Sammelparser antworten auf ein Dokument, das nicht parst, mit „nichts
 * hinterlegt" — und das ist dann jede Seite dieser Ebene auf einmal.
 */
describe('gespeicherte Dokumente ohne Verweis', () => {
  const beforeTheLink = {
    mode: 'template',
    fills: { NAME_DES_BETREIBERS: 'Beispiel-Betrieb' },
    conditions: {},
    custom: '',
  };

  it('liest die Seiten der Installation und ergänzt den leeren Verweis', () => {
    const pages = parseStoredSystemLegalPages({
      imprint: beforeTheLink,
      privacy: beforeTheLink,
    });

    expect(pages.imprint.fills.NAME_DES_BETREIBERS).toBe('Beispiel-Betrieb');
    expect(pages.imprint.link).toBe('');
    expect(pages.privacy.link).toBe('');
  });

  it('liest die Seiten einer Organisation genauso', () => {
    const pages = parseStoredTenantLegalPages({
      imprint: beforeTheLink,
      privacy: beforeTheLink,
    });

    expect(pages.imprint.fills.NAME_DES_BETREIBERS).toBe('Beispiel-Betrieb');
    expect(pages.imprint.link).toBe('');
  });
});
