import { describe, expect, it } from 'vitest';
import {
  EMPTY_SYSTEM_LEGAL_PAGES,
  SYSTEM_LEGAL_PAGES,
  SYSTEM_LEGAL_TEMPLATES,
  type SystemLegalPages,
  type SystemMailSettings,
} from '@formsache/shared';

import { SYSTEM_SUPERADMINS_PATH } from '../../router/routes';
import { openItems } from './open-items';

/**
 * **The list of open items is derived from the state** (ADR-0022,
 * continuation 2026-08-18) — the promise this file holds.
 *
 * It is deliberately no test of the wordings but of the selection: *which*
 * items arise from *which* state. What an item says is text; **that
 * it disappears as soon as somebody enters the setting somewhere**, is the
 * property this function exists for at all.
 *
 * ## Negative test, measured while writing
 *
 * The derivation replaced by a „Schritt übersprungen" marker: the case
 * „nichts offen, wenn alles hinterlegt ist" goes red as soon as one feeds it a
 * set marker — and exactly that is the situation that arises after the first
 * entering in the tab.
 */

const NOTHING_SET: SystemMailSettings = {
  smtp: null,
  publicBaseUrl: null,
  replyTo: null,
  opsAlertEmail: null,
};

const ALL_SET: SystemMailSettings = {
  smtp: {
    host: 'mail.example.org',
    port: 587,
    secure: false,
    authUser: 'versand',
    from: 'versand@example.org',
  },
  publicBaseUrl: 'https://formulare.example.org',
  replyTo: null,
  opsAlertEmail: 'betrieb@example.org',
};

/**
 * Legal texts in which every field of a currently active block is filled —
 * the state „vollständig", so that the cases below talk about the mail values
 * and not accidentally about the legal texts.
 */
const LEGAL_DONE: SystemLegalPages = Object.fromEntries(
  SYSTEM_LEGAL_PAGES.map((page) => [
    page,
    {
      mode: 'template' as const,
      fills: Object.fromEntries(
        SYSTEM_LEGAL_TEMPLATES[page].slots.map((slot) => [slot.key, 'x']),
      ),
      conditions: {},
      custom: '',
      link: '',
    },
  ]),
) as SystemLegalPages;

/**
 * **Two superadministrators** — the unremarkable state (ADR-0029), so that the
 * cases below talk about the mail values and the legal texts and not
 * accidentally about the system administration.
 */
const TWO_SUPERADMINS = 2;

/**
 * Die Rechtstexte, wie die Liste sie liest — Seiten **und** KI-Zustand
 * (Review-Runde 5 Nr. 2).
 *
 * `aiActive` steht auf `false`, solange ein Fall nichts anderes sagt: das ist
 * der Zustand einer Installation ohne eingerichtete KI, und die Fälle unten
 * reden von den Mailwerten und den Rechtstexten, nicht von der KI. Der Fall,
 * der von ihr redet, setzt sie ausdrücklich.
 */
function legalState(
  pages: SystemLegalPages,
  aiActive = false,
): { readonly pages: SystemLegalPages; readonly aiActive: boolean } {
  return { pages, aiActive };
}

describe('die offenen Punkte einer Installation', () => {
  it('nennt Basis-Adresse, Mailserver, Betreiberadresse und die fehlende Organisation', () => {
    const items = openItems({
      mail: NOTHING_SET,
      tenantCount: 0,
      legal: legalState(LEGAL_DONE),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items.map((item) => item.key)).toStrictEqual([
      'base-url',
      'smtp',
      'ops-alert',
      'tenant',
    ]);
    // Every item says in one sentence what is not right without it — otherwise
    // it is a task without a reason.
    for (const item of items) {
      expect(item.consequence.length).toBeGreaterThan(20);
      expect(item.path.startsWith('/admin/system')).toBe(true);
    }
  });

  it('ist leer, sobald alles hinterlegt ist — egal, wo es hinterlegt wurde', () => {
    expect(
      openItems({
        mail: ALL_SET,
        tenantCount: 2,
        legal: legalState(LEGAL_DONE),
        superadminCount: TWO_SUPERADMINS,
      }),
    ).toStrictEqual([]);
  });

  it('nimmt einen Punkt einzeln zurück', () => {
    const items = openItems({
      mail: { ...NOTHING_SET, publicBaseUrl: 'https://example.org' },
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items.map((item) => item.key)).toStrictEqual(['smtp', 'ops-alert']);
  });

  /**
   * **Nothing is claimed during the loading.** A list that shows four open
   * items and takes them away a tenth of a second later is a fright
   * without cause — and the second time one no longer believes it.
   */
  it('behauptet nichts, solange die Dokumente nicht geladen sind', () => {
    expect(
      openItems({
        mail: undefined,
        tenantCount: undefined,
        legal: legalState(LEGAL_DONE),
        superadminCount: TWO_SUPERADMINS,
      }),
    ).toStrictEqual([]);
  });

  /**
   * The **reply address** expressly does **not** stand on it: without it
   * an answer goes to the sender address, and that is a valid end state.
   * A list with items that are none is a list one looks past —
   * and then the mail server stands on it too.
   */
  it('führt keine Punkte, die ein gültiger Endzustand sind', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(ALL_SET.replyTo).toBeNull();
    expect(items).toStrictEqual([]);
  });
});

/**
 * **The legal texts** (ADR-0028) — and the case that carries the core of the
 * task: a text with a placeholder left in it does **not** count as
 * finished.
 */
describe('die Rechtstexte auf der Liste', () => {
  it('nennt sie, solange gar nichts hinterlegt ist', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(EMPTY_SYSTEM_LEGAL_PAGES),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items.map((item) => item.key)).toStrictEqual(['legal']);
    expect(items[0]?.title).toBe(
      'Keine Rechtstexte der Installation hinterlegt',
    );
  });

  it('nennt sie auch, wenn ein Platzhalter offen geblieben ist', () => {
    const halfFilled: SystemLegalPages = {
      ...LEGAL_DONE,
      imprint: {
        mode: 'template',
        // Only the name — the rest of the mandatory details is missing.
        fills: { NAME_DES_BETREIBERS: 'Beispiel-Betrieb' },
        conditions: {},
        custom: '',
        link: '',
      },
    };

    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(halfFilled),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items.map((item) => item.key)).toStrictEqual(['legal']);
    expect(items[0]?.title).toContain('unvollständig');
  });

  /**
   * **Review-Runde 5 Nr. 2 — die KI zählt mit.**
   *
   * Ist die KI-Funktion eingerichtet, hat die Datenschutzerklärung sieben
   * Felder mehr (Anbieter, Sitz, Modell, Region, Übermittlungsgrundlage,
   * Kontakt für Garantien, Aufbewahrung beim Anbieter). Diese Liste nahm
   * `aiActive: false` an und meldete die Seite deshalb als fertig, während im
   * Formular sieben leere Felder standen — die Ampel widersprach der Karte
   * darunter.
   */
  it('nennt die Datenschutzerklärung, sobald die KI die KI-Felder verlangt', () => {
    const withoutAiFields: SystemLegalPages = {
      ...LEGAL_DONE,
      privacy: {
        mode: 'template',
        /*
          **Über die Gruppe und nicht über die Schreibweise des Schlüssels.**
          Eine Auswahl nach `KI_`-Präfix verfehlte zwei der sieben Felder
          (`UEBERMITTLUNGSGRUNDLAGE`, `KONTAKT_FUER_GARANTIEN`) und wäre nur
          zufällig aussagekräftig geblieben. `group` ist genau die gemeinte
          Menge — sie steht in der Vorlage (`legal-templates.ts`).
        */
        fills: Object.fromEntries(
          SYSTEM_LEGAL_TEMPLATES.privacy.slots
            .filter((slot) => slot.group !== 'KI-Funktion')
            .map((slot) => [slot.key, 'x']),
        ),
        conditions: {},
        custom: '',
        link: '',
      },
    };

    const input = {
      mail: ALL_SET,
      tenantCount: 1,
      superadminCount: TWO_SUPERADMINS,
    };

    // Ohne KI ist dieselbe Seite fertig — die Felder gehören zu einem
    // Abschnitt, den es dann nicht gibt.
    expect(
      openItems({ ...input, legal: legalState(withoutAiFields, false) }),
    ).toStrictEqual([]);

    const items = openItems({
      ...input,
      legal: legalState(withoutAiFields, true),
    });
    expect(items.map((item) => item.key)).toStrictEqual(['legal']);
    expect(items[0]?.title).toContain('Datenschutzerklärung');
  });

  it('verschwindet, sobald beide Seiten vollständig sind', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items).toStrictEqual([]);
  });

  it('behauptet nichts, solange das Dokument nicht geladen ist', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: undefined,
      superadminCount: TWO_SUPERADMINS,
    });

    expect(items).toStrictEqual([]);
  });
});

/**
 * **„Nur eine Person verwaltet das System"** (ADR-0029) — the item the second
 * question of the head comment exists for: with one superadministrator
 * everything works, until this account is gone, and then no way of this
 * application leads back.
 */
describe('der einzige Superadministrator auf der Liste', () => {
  it('nennt ihn, solange es nur eine Ernennung gibt', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: 1,
    });

    expect(items.map((item) => item.key)).toStrictEqual(['single-superadmin']);
    expect(items[0]?.path).toBe(SYSTEM_SUPERADMINS_PATH);
  });

  it('nennt ihn nicht, sobald es zwei gibt', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: 2,
    });

    expect(items).toStrictEqual([]);
  });

  /** The loading case — the same rule as for the remaining inputs. */
  it('behauptet nichts, solange die Liste nicht geladen ist', () => {
    const items = openItems({
      mail: ALL_SET,
      tenantCount: 1,
      legal: legalState(LEGAL_DONE),
      superadminCount: undefined,
    });

    expect(items).toStrictEqual([]);
  });

  /**
   * **It stands first.** The list follows the order of the setup assistant, and
   * this item hangs off its first step — the only one that cannot be skipped.
   * Read from the top it is the honest order as well: every other item can
   * still be settled tomorrow, this one alone at some point cannot.
   */
  it('steht vor allen anderen Punkten', () => {
    const items = openItems({
      mail: NOTHING_SET,
      tenantCount: 0,
      legal: legalState(EMPTY_SYSTEM_LEGAL_PAGES),
      superadminCount: 1,
    });

    expect(items.map((item) => item.key)).toStrictEqual([
      'single-superadmin',
      'base-url',
      'smtp',
      'ops-alert',
      'legal',
      'tenant',
    ]);
  });
});
