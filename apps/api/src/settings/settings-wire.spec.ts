import { describe, expect, it } from 'vitest';
import { EMPTY_LEGAL_DOCUMENT } from '@formsache/shared';

import { updateFormSettingsRequestSchema } from './settings-wire';

/**
 * **Der Datenschutzhinweis eines Formulars geht durch die *schreibende*
 * Fassung des Dokumentschemas** (Review-Runde 5, Nachtrag).
 *
 * Die Karte in den Formulareinstellungen zeigt denselben `LegalPageEditor` wie
 * die Rechtstexte der Organisation — also auch dessen dritten Weg *Verweis auf
 * eine Seite*. Käme hier die nachsichtige Fassung zum Zug, landete eine
 * `javascript:`-Adresse in der Datenbank, und der Renderer machte daraus
 * stillschweigend eine leere Seite: ein Hinweis nach Art. 13 DSGVO, der nichts
 * sagt, ohne dass jemand einen Fehler gesehen hätte.
 *
 * Gegenprobe beim Schreiben: `legalDocumentWriteSchema` wieder gegen
 * `legalDocumentSchema` getauscht → der erste Fall wird grün, also misst er
 * genau diese Unterscheidung.
 */
describe('der Datenschutzhinweis im Schreibschema der Formulareinstellungen', () => {
  const base = {
    overridden: {
      access: false,
      confirm: false,
      display: false,
      budget: false,
    },
    values: {},
    revision: 1,
    tenantRevision: 1,
  };

  it('weist eine Adresse ab, die keine http- oder https-Adresse ist', () => {
    const result = updateFormSettingsRequestSchema.safeParse({
      ...base,
      privacyNotice: {
        ...EMPTY_LEGAL_DOCUMENT,
        mode: 'link',
        link: 'javascript:alert(1)',
      },
    });

    expect(result.success).toBe(false);
    // Nur der Verweis wird beanstandet — der Rest der Anfrage ist gültig.
    expect(result.error?.issues).toHaveLength(1);
    // Am Feld und nicht am Dokument — die Oberfläche hängt die Meldung an das
    // Adressfeld (`api-messages.ts` streift `privacyNotice.` ab).
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'privacyNotice.link',
    );
  });

  it('nimmt eine http-Adresse an', () => {
    expect(
      updateFormSettingsRequestSchema.safeParse({
        ...base,
        privacyNotice: {
          ...EMPTY_LEGAL_DOCUMENT,
          mode: 'link',
          link: 'https://example.org/datenschutz',
        },
      }).success,
    ).toBe(true);
  });

  it('lässt eine gespeicherte Adresse in einem anderen Modus unangetastet', () => {
    // Der Verweis wird beim Umschalten behalten (ADR-0028): eine unbrauchbare
    // Adresse, die gerade nicht gilt, darf das Speichern des eigenen Textes
    // nicht blockieren.
    expect(
      updateFormSettingsRequestSchema.safeParse({
        ...base,
        privacyNotice: {
          ...EMPTY_LEGAL_DOCUMENT,
          mode: 'custom',
          custom: 'Verantwortlich ist die Beispiel GmbH.',
          link: 'kein-schema',
        },
      }).success,
    ).toBe(true);
  });
});
