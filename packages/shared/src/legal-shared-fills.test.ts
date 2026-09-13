import { describe, expect, it } from 'vitest';

import { EMPTY_LEGAL_DOCUMENT, type LegalDocument } from './legal.ts';
import {
  SYSTEM_LEGAL_TEMPLATES,
  TENANT_LEGAL_TEMPLATES,
} from './legal-templates.ts';
import { applySharedFills, sharedSlotKeys } from './legal-shared-fills.ts';

/**
 * **Was in zwei Rechtstexten steht, tippt man einmal** (Review-Runde 3
 * Nr. 3): *„Ich muss mehrfach das gleiche eingeben (Betreiber, …)."*
 *
 * Gemessen wird gegen die **echten** Vorlagen und nicht gegen erfundene: die
 * Aussage ist eine über `docs/legal/vorlagen/`, und eine Attrappe bewiese
 * nur, dass die Funktion tut, was sie tut. Verschwände
 * `NAME_DES_BETREIBERS` aus der Datenschutzerklärung, müsste dieser Test das
 * merken.
 */

function filled(fills: Record<string, string>): LegalDocument {
  return { ...EMPTY_LEGAL_DOCUMENT, fills };
}

describe('sharedSlotKeys', () => {
  it('findet die Felder, die in mehreren Vorlagen stehen', () => {
    const shared = sharedSlotKeys(Object.values(SYSTEM_LEGAL_TEMPLATES));

    expect(shared.has('NAME_DES_BETREIBERS')).toBe(true);
    expect(shared.has('STRASSE_UND_HAUSNUMMER')).toBe(true);
    expect(shared.has('TELEFONNUMMER')).toBe(true);
  });

  it('hält ein Feld, das nur in einer Vorlage steht, nicht für geteilt', () => {
    const shared = sharedSlotKeys(Object.values(SYSTEM_LEGAL_TEMPLATES));

    // Nur im Impressum: die Umsatzsteuer-Identifikationsnummer.
    expect(shared.has('UST_IDNR')).toBe(false);
  });

  it('zählt einen Schlüssel nicht doppelt, der zweimal in derselben Liste stünde', () => {
    const [imprint] = Object.values(SYSTEM_LEGAL_TEMPLATES);
    expect(imprint).toBeDefined();
    if (imprint === undefined) {
      return;
    }
    expect(sharedSlotKeys([imprint]).size).toBe(0);
  });
});

describe('applySharedFills', () => {
  it('führt den Namen des Betreibers in die Nachbarseite mit', () => {
    const next = applySharedFills(
      { imprint: EMPTY_LEGAL_DOCUMENT, privacy: EMPTY_LEGAL_DOCUMENT },
      SYSTEM_LEGAL_TEMPLATES,
      'imprint',
      filled({ NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.' }),
    );

    expect(next.privacy.fills.NAME_DES_BETREIBERS).toBe(
      'Beispiel-Betrieb e. V.',
    );
  });

  /**
   * ⚠️ **Die Bedingung, die den ganzen Ansatz tragbar macht.** Eine
   * abweichende Anschrift für Datenschutzanfragen ist ein normaler Fall; wer
   * sie einträgt, behält sie. Ab da läuft dieses **eine** Feld nicht mehr
   * mit — die anderen schon.
   */
  it('lässt einen bewusst abweichenden Wert stehen', () => {
    const pages = {
      imprint: filled({
        NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.',
        TELEFONNUMMER: '030 1234',
      }),
      privacy: filled({
        NAME_DES_BETREIBERS: 'Beispiel-Betrieb e. V.',
        TELEFONNUMMER: '030 9999',
      }),
    };

    const next = applySharedFills(pages, SYSTEM_LEGAL_TEMPLATES, 'imprint', {
      ...pages.imprint,
      fills: {
        NAME_DES_BETREIBERS: 'Neuer Name e. V.',
        TELEFONNUMMER: '030 5678',
      },
    });

    // Das mitlaufende Feld wandert mit …
    expect(next.privacy.fills.NAME_DES_BETREIBERS).toBe('Neuer Name e. V.');
    // … das bewusst abweichende bleibt.
    expect(next.privacy.fills.TELEFONNUMMER).toBe('030 9999');
  });

  it('schreibt in eine Seite nichts, deren Vorlage das Feld gar nicht kennt', () => {
    const next = applySharedFills(
      { imprint: EMPTY_LEGAL_DOCUMENT, privacy: EMPTY_LEGAL_DOCUMENT },
      SYSTEM_LEGAL_TEMPLATES,
      'imprint',
      filled({ UST_IDNR: 'DE123456789' }),
    );

    expect(next.privacy.fills.UST_IDNR).toBeUndefined();
  });

  it('lässt die geänderte Seite selbst unangetastet durch', () => {
    const next = applySharedFills(
      { imprint: EMPTY_LEGAL_DOCUMENT, privacy: EMPTY_LEGAL_DOCUMENT },
      TENANT_LEGAL_TEMPLATES,
      'privacy',
      filled({ ORT: 'Musterstadt' }),
    );

    expect(next.privacy.fills.ORT).toBe('Musterstadt');
    expect(next.imprint.fills.ORT).toBe('Musterstadt');
  });

  /**
   * Ein Wert, den man wieder löscht, verschwindet ebenso mit — sonst bliebe
   * in der Nachbarseite eine Angabe stehen, die niemand mehr eingetragen hat.
   */
  it('führt auch das Leeren mit', () => {
    const pages = {
      imprint: filled({ ORT: 'Musterstadt' }),
      privacy: filled({ ORT: 'Musterstadt' }),
    };

    const next = applySharedFills(pages, TENANT_LEGAL_TEMPLATES, 'imprint', {
      ...pages.imprint,
      fills: { ORT: '' },
    });

    expect(next.privacy.fills.ORT).toBe('');
  });

  it('lässt alles stehen, wenn sich kein geteiltes Feld geändert hat', () => {
    const pages = {
      imprint: filled({ ORT: 'Musterstadt' }),
      privacy: filled({ ORT: 'Musterstadt' }),
    };

    const next = applySharedFills(pages, TENANT_LEGAL_TEMPLATES, 'imprint', {
      ...pages.imprint,
      fills: { ORT: 'Musterstadt', UST_IDNR: 'DE1' },
    });

    expect(next.privacy).toBe(pages.privacy);
  });
});
