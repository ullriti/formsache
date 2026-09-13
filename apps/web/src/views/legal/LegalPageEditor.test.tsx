import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_LEGAL_DOCUMENT,
  LEGAL_FILL_MAX,
  LEGAL_TEXT_MAX,
  SYSTEM_LEGAL_TEMPLATES,
  type LegalDocument,
  type LegalRenderContext,
} from '@formsache/shared';

import { LegalPageEditor } from './LegalPageEditor';

/**
 * **The two ways, and that switching loses nothing** (ADR-0028 no. 3).
 *
 * What is measured is the **behaviour** and not the build: that the placeholders
 * appear as fields instead of as running text with double square brackets, that
 * a deselected block takes its fields with it, and that a change of mode leaves
 * the typed work standing — in both directions.
 */

const CONTEXT: LegalRenderContext = {
  organisationName: null,
  organisationShortName: null,
  operatorName: null,
  aiActive: false,
  redirectTarget: null,
};

/** The editor with a state as a settings page holds it. */
function Harness({
  initial = EMPTY_LEGAL_DOCUMENT,
  issues,
}: {
  readonly initial?: LegalDocument;
  readonly issues?: Readonly<Record<string, string>>;
}) {
  const [document, setDocument] = useState<LegalDocument>(initial);
  return (
    <LegalPageEditor
      template={SYSTEM_LEGAL_TEMPLATES.imprint}
      document={document}
      onChange={setDocument}
      context={CONTEXT}
      publicPath="/imprint"
      {...(issues === undefined ? {} : { issues })}
    />
  );
}

describe('der Rechtstext-Editor', () => {
  it('bietet die Platzhalter als Felder an, nicht als Text zum Suchen', () => {
    render(<Harness />);

    expect(
      screen.getByLabelText<HTMLInputElement>('Name des Betreibers'),
    ).toBeDefined();
    expect(screen.getByLabelText('Straße und Hausnummer')).toBeDefined();
    expect(screen.getByLabelText('Postleitzahl')).toBeDefined();
  });

  /**
   * **A deselected block takes its fields with it.** A natural person is not
   * supposed to be asked for their register court — and the promise hangs on
   * display and completeness verdict asking the same question (`visibleSlots`
   * and `legalPageStatus`).
   */
  it('zeigt die Felder eines Blocks erst, wenn der Block gilt', () => {
    render(<Harness />);

    expect(screen.queryByLabelText('Registergericht')).toBeNull();

    fireEvent.click(
      screen.getByLabelText('Der Betreiber ist in ein Register eingetragen'),
    );

    expect(screen.getByLabelText('Registergericht')).toBeDefined();
  });

  it('verliert beim Umschalten nichts — in beide Richtungen', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Name des Betreibers'), {
      target: { value: 'Beispiel-Betrieb e. V.' },
    });

    fireEvent.click(screen.getByLabelText('Eigener Text'));
    fireEvent.change(
      screen.getByLabelText('Eigener Text', { selector: 'textarea' }),
      {
        target: { value: 'Meine eigene Fassung.' },
      },
    );

    // Back to the template: the name is still there.
    fireEvent.click(screen.getByLabelText('Vorlage ausfüllen'));
    expect(
      screen.getByLabelText<HTMLInputElement>('Name des Betreibers').value,
    ).toBe('Beispiel-Betrieb e. V.');

    // And back again: the own text as well.
    fireEvent.click(screen.getByLabelText('Eigener Text'));
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Eigener Text', {
        selector: 'textarea',
      }).value,
    ).toBe('Meine eigene Fassung.');
  });

  /**
   * **The state stands there as a word, not only as a colour.** Whoever does not
   * see the colour reads „Unvollständig" — and the badge is the place at which
   * an editor learns that their half-filled imprint is not finished.
   */
  it('sagt den Zustand als Wort', () => {
    render(<Harness />);
    const card = screen.getByRole('region', { name: 'Impressum' });

    expect(within(card).getByText('Nichts hinterlegt')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Name des Betreibers'), {
      target: { value: 'Beispiel-Betrieb e. V.' },
    });

    expect(within(card).getByText('Unvollständig')).toBeDefined();
  });

  /**
   * **The preview goes the same way as the public page** — and therefore carries
   * no placeholder, but named gaps.
   */
  it('zeigt in der Vorschau die Lücken statt der doppelten eckigen Klammern', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Name des Betreibers'), {
      target: { value: 'Beispiel-Betrieb e. V.' },
    });
    fireEvent.click(screen.getByText('Vorschau der ungespeicherten Fassung'));

    const card = screen.getByRole('region', { name: 'Impressum' });
    expect(card.textContent).toContain('Beispiel-Betrieb e. V.');
    expect(card.textContent).toContain('Angabe fehlt: Postleitzahl');
    expect(card.textContent).not.toContain('[[');
  });
  /**
   * **The boundary stands where the typing happens** (review finding of
   * 2026-08-19).
   *
   * The server rejects `custom` above {@link LEGAL_TEXT_MAX} and every
   * placeholder value above {@link LEGAL_FILL_MAX} with 400. In the browser
   * there was no boundary for it: whoever pasted eight and a half pages into
   * *Eigener Text* and pressed *Speichern* got „Bitte die markierten Felder
   * prüfen." — and lost deadline, participant limit and confirmation page along
   * with it in the same `PUT`, because the write operation is **one**.
   *
   * `maxLength` is no second check in this — the server stays the truth —, but
   * the same one at the only place at which it can still prevent the loss.
   *
   * *Reproduction:* remove `maxLength={LEGAL_FILL_MAX}` or
   * `maxLength={LEGAL_TEXT_MAX}` respectively in `LegalPageEditor.tsx` — both
   * expectations then read `-1`, the value the DOM reports for „no boundary".
   */
  it('gibt seinen Feldern die Grenze mit, die der Server durchsetzt', () => {
    render(<Harness />);

    expect(
      screen.getByLabelText<HTMLInputElement>('Name des Betreibers').maxLength,
    ).toBe(LEGAL_FILL_MAX);

    fireEvent.click(screen.getByLabelText('Eigener Text'));
    expect(
      screen.getByLabelText<HTMLTextAreaElement>('Eigener Text', {
        selector: 'textarea',
      }).maxLength,
    ).toBe(LEGAL_TEXT_MAX);
  });

  /**
   * **And what does pass the boundary is marked** — the second stage of the same
   * finding.
   *
   * `maxLength` catches the *one* rule that exists today. Every further one that
   * `legalDocumentSchema` draws in future comes back as a 400 with a path, and
   * without this way it would stay invisible: the message „Bitte die markierten
   * Felder prüfen." would stand there, and nothing would be marked.
   *
   * The keys are the paths of the **document** and not those of the request:
   * the same editor stands at three places of three different payloads, so the
   * prefix is stripped off before it gets here — `privacyNotice.` by
   * `fieldIssues`, the page-dependent `pages.<seite>.` by the card itself via
   * `issuesUnder` (both `api-messages.ts`, ADR-0028 no. 9).
   *
   * *Reproduction:* leave out `issue={issues[…]}` on one of the two
   * `TextSetting` in `LegalPageEditor.tsx` — the corresponding expectation turns
   * red, because the message stands nowhere in the tree.
   */
  it('markiert das Feld, das der Server benannt hat', () => {
    render(
      <Harness
        issues={{
          'fills.NAME_DES_BETREIBERS': 'Höchstens 2000 Zeichen.',
          custom: 'Höchstens 20000 Zeichen.',
        }}
      />,
    );

    const name = screen.getByLabelText<HTMLInputElement>('Name des Betreibers');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Höchstens 2000 Zeichen.')).toBeDefined();
    // And the message hangs on the field, not next to it: a screen reader reads
    // it on entering the field and not as a sentence somewhere on the page.
    expect(name.getAttribute('aria-describedby')).toContain(
      screen.getByText('Höchstens 2000 Zeichen.').id,
    );

    fireEvent.click(screen.getByLabelText('Eigener Text'));
    const custom = screen.getByLabelText<HTMLTextAreaElement>('Eigener Text', {
      selector: 'textarea',
    });
    expect(custom.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Höchstens 20000 Zeichen.')).toBeDefined();
  });

  /**
   * **Was ungefähr hineingehört, steht im leeren Feld** (Review-Runde 4
   * Nr. 5).
   *
   * Gemessen am Impressum, weil es die Vorlage dieser Datei ist. Dass **jedes**
   * Feld **jeder** Vorlage ein Beispiel trägt, misst
   * `packages/shared/src/legal.test.ts` an der Quelle — hier steht nur, dass
   * die Anzeige es auch hinschreibt.
   */
  it('zeigt an jedem Feld ein Beispiel', () => {
    render(<Harness />);

    expect(
      screen
        .getByLabelText<HTMLInputElement>('Name des Betreibers')
        .getAttribute('placeholder'),
    ).toBe('Musterverein e. V.');
    expect(
      screen
        .getByLabelText<HTMLInputElement>('Ort')
        .getAttribute('placeholder'),
    ).toBe('Musterstadt');
  });

  /**
   * **Der Standardtext wird übernommen, nicht vorbelegt** (Review-Runde 4
   * Nr. 5).
   *
   * Der Unterschied ist genau eine bewusste Handlung, und deshalb misst dieser
   * Fall beide Zustände: vorher leer, nachher der Satz — **und** der Knopf
   * danach fort. Ein Knopf neben einem geschriebenen Satz wäre ein Angebot,
   * ihn zu überschreiben.
   */
  it('schreibt einen Standardtext erst auf Klick ins Feld', () => {
    render(
      <Harness
        initial={{
          ...EMPTY_LEGAL_DOCUMENT,
          conditions: { verbraucherstreitbeilegung: true },
        }}
      />,
    );

    const field = screen.getByLabelText<HTMLInputElement>(
      'Adresse der EU-Plattform zur Online-Streitbeilegung',
    );
    expect(field.value).toBe('');

    /*
      **Der Knopf trägt den Namen seines Feldes** — nur für Bildschirmleser,
      und genau deshalb ist er hier adressierbar. Zwei Felder dieses
      Abschnitts bieten einen Vorschlag an; ohne den Namen wären beide Knöpfe
      „Vorschlag übernehmen" und weder ein Mensch noch dieser Fall wüsste,
      welcher gemeint ist.
    */
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Vorschlag übernehmen — Adresse der EU-Plattform zur Online-Streitbeilegung',
      }),
    );

    expect(
      screen.getByLabelText<HTMLInputElement>(
        'Adresse der EU-Plattform zur Online-Streitbeilegung',
      ).value,
    ).toBe('https://ec.europa.eu/consumers/odr/');
    // Und der Knopf ist fort: neben einem geschriebenen Satz wäre er ein
    // Angebot, ihn zu überschreiben.
    expect(
      screen.queryByRole('button', {
        name: 'Vorschlag übernehmen — Adresse der EU-Plattform zur Online-Streitbeilegung',
      }),
    ).toBeNull();
  });

  /**
   * **Die Felder stehen in fachlichen Abschnitten** (Review-Runde 4 Nr. 7:
   * „Mailserver und Backup Felder haben falsche Reihenfolge und werden
   * vermischt").
   *
   * Gemessen an der Datenschutzerklärung, wo der Befund entstand: die drei
   * Mailfelder unter *E-Mail-Versand*, die beiden Sicherungsfelder unter
   * *Datensicherung* — und keins davon im Abschnitt des anderen.
   */
  it('stellt Mailversand und Datensicherung in getrennte Abschnitte', () => {
    render(
      <LegalPageEditor
        template={SYSTEM_LEGAL_TEMPLATES.privacy}
        document={EMPTY_LEGAL_DOCUMENT}
        onChange={() => undefined}
        context={CONTEXT}
        publicPath="/privacy"
      />,
    );

    const mail = screen.getByRole('group', { name: 'E-Mail-Versand' });
    expect(
      within(mail).getByLabelText('Mailserver oder Maildienstleister'),
    ).toBeDefined();
    expect(
      within(mail).getByLabelText('Name des Maildienstleisters'),
    ).toBeDefined();
    expect(
      within(mail).queryByLabelText('Aufbewahrung der Sicherungen in Tagen'),
    ).toBeNull();

    const backup = screen.getByRole('group', { name: 'Datensicherung' });
    expect(
      within(backup).getByLabelText('Aufbewahrung der Sicherungen in Tagen'),
    ).toBeDefined();
    expect(
      within(backup).queryByLabelText('Mailserver oder Maildienstleister'),
    ).toBeNull();
  });

  /**
   * **Die Aufsichtsbehörde ist kein Pflichtfeld mehr** (Review-Runde 4 Nr. 6:
   * „warum ein pflichtfeld? Macht keinen Sinn").
   *
   * Art. 13 Abs. 2 lit. d DSGVO verlangt den Hinweis auf das Beschwerderecht,
   * nicht die Nennung einer bestimmten Behörde — und der Hinweis steht im
   * Text, ohne Bedingung. Das Feld erscheint erst, wenn jemand die Behörde
   * ausdrücklich nennen will, und eine Seite ohne es ist vollständig.
   */
  it('fragt die Aufsichtsbehörde erst, wenn sie genannt werden soll', () => {
    render(<Harness2 />);

    expect(
      screen.queryByLabelText(
        'Zuständige Datenschutz-Aufsichtsbehörde (Name und Anschrift)',
      ),
    ).toBeNull();

    fireEvent.click(
      screen.getByLabelText(
        'Die zuständige Datenschutz-Aufsichtsbehörde soll namentlich stehen',
      ),
    );

    expect(
      screen.getByLabelText(
        'Zuständige Datenschutz-Aufsichtsbehörde (Name und Anschrift)',
      ),
    ).toBeDefined();
  });

  /**
   * **Der dritte Weg: der Text steht schon woanders** (Review-Runde 5,
   * Nachtrag). Gemessen wird, was der Befund verlangt hat — eine Adresse
   * eintragen zu können — und dass dabei nichts von den beiden anderen
   * Fassungen verlorengeht.
   */
  it('nimmt eine Adresse entgegen, statt den Text ein zweites Mal zu verlangen', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('Name des Betreibers'), {
      target: { value: 'Beispiel-Betrieb e. V.' },
    });

    fireEvent.click(screen.getByLabelText('Verweis auf eine Seite'));
    fireEvent.change(screen.getByLabelText('Adresse der Seite'), {
      target: { value: 'https://beispiel.example/impressum' },
    });

    // Die Vorschau zeigt den Verweis, nicht die Vorlage.
    expect(
      screen
        .getByRole('link', { name: 'https://beispiel.example/impressum' })
        .getAttribute('href'),
    ).toBe('https://beispiel.example/impressum');

    // Und die ausgefüllte Vorlage steht nach dem Zurückschalten noch da.
    fireEvent.click(screen.getByLabelText('Vorlage ausfüllen'));
    expect(
      screen.getByLabelText<HTMLInputElement>('Name des Betreibers').value,
    ).toBe('Beispiel-Betrieb e. V.');
    fireEvent.click(screen.getByLabelText('Verweis auf eine Seite'));
    expect(
      screen.getByLabelText<HTMLInputElement>('Adresse der Seite').value,
    ).toBe('https://beispiel.example/impressum');
  });

  /**
   * **Ein abgewiesener Verweis wird an seinem Feld markiert** — die Zusage aus
   * ADR-0028 Nr. 9, hier für die dritte Fassung. Ohne sie stünde „Bitte die
   * markierten Felder prüfen" da, und markiert wäre nichts.
   */
  it('markiert eine abgewiesene Adresse an ihrem Feld', () => {
    render(
      <Harness
        issues={{ link: 'Nur http- oder https-Adressen sind erlaubt.' }}
      />,
    );

    fireEvent.click(screen.getByLabelText('Verweis auf eine Seite'));
    const address =
      screen.getByLabelText<HTMLInputElement>('Adresse der Seite');

    expect(address.getAttribute('aria-invalid')).toBe('true');
    expect(address.getAttribute('aria-describedby')).toContain(
      screen.getByText('Nur http- oder https-Adressen sind erlaubt.').id,
    );
  });

  /**
   * **Und eine unbrauchbare Adresse zeigt keine halbe Seite**: die Vorschau
   * sagt „nichts hinterlegt" statt einen toten Verweis zu zeichnen.
   */
  it('zeigt für eine unbrauchbare Adresse die leere Seite', () => {
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Verweis auf eine Seite'));
    fireEvent.change(screen.getByLabelText('Adresse der Seite'), {
      target: { value: 'musterverein.example/impressum' },
    });

    const card = screen.getByRole('region', { name: 'Impressum' });
    expect(within(card).getByText('Nichts hinterlegt')).toBeDefined();
    expect(screen.queryByRole('link', { name: /musterverein/u })).toBeNull();
  });

  /**
   * **Ein freiwilliges Feld ist keine Aufgabe** (Review-Runde 5, Nachtrag):
   * *„Die Telefonnummer ist ja optional dachte ich."* Sie ist es — und die
   * Karte sagt es an der Beschriftung und zählt sie nicht mit.
   */
  it('nennt ein freiwilliges Feld beim Namen und zählt es nicht mit', () => {
    render(<Harness />);
    const card = screen.getByRole('region', { name: 'Impressum' });

    expect(screen.getByLabelText('Telefonnummer (optional)')).toBeDefined();

    // Alles Pflichtige der ausgewählten Abschnitte ausfüllen — die
    // Telefonnummer bleibt leer.
    for (const label of [
      'Name des Betreibers',
      'Straße und Hausnummer',
      'Postleitzahl',
      'Ort',
      'Land',
      'E-Mail-Adresse',
    ]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: 'x' },
      });
    }

    expect(within(card).getByText('Vollständig')).toBeDefined();
    expect(within(card).queryByText(/noch \d+ Feld/u)).toBeNull();
  });
});

/** Dieselbe Halterung, aber mit der Datenschutzerklärung als Vorlage. */
function Harness2() {
  const [document, setDocument] = useState<LegalDocument>(EMPTY_LEGAL_DOCUMENT);
  return (
    <LegalPageEditor
      template={SYSTEM_LEGAL_TEMPLATES.privacy}
      document={document}
      onChange={setDocument}
      context={CONTEXT}
      publicPath="/privacy"
    />
  );
}
