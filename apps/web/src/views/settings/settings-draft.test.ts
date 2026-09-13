import {
  EMPTY_LEGAL_DOCUMENT,
  REDACTED_PASSWORD,
  SYSTEM_FORM_SETTINGS,
  omitAvailabilityKeys,
  type FormSettings,
  type LegalDocument,
  type TenantFormSettings,
} from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import type { SectionedDocument, SettingsDraft } from './settings-draft';
import {
  draftOf as draftOfDocument,
  isDirty as isDirtyAgainst,
  isTenantDirty,
  isWithheldPassword,
  shownSettings,
  shownTenantValues,
  withPrivacyNotice,
  withSection,
  withTenantValue,
  withValue,
  writableValues,
} from './settings-draft';

/**
 * The rules of the settings draft.
 *
 * Two of them are worth more than the rest and are tested from both sides:
 * a locked section never reaches the wire, and every save carries **all four**
 * switches — the second because a partial switch document is a silent deletion
 * of whole sections, access word included.
 *
 * *Verfügbarkeit* has neither a switch nor a layer below it (ADR-0011,
 * continuation 2026-08-14): its keys are the form's own, which is asserted
 * here as „they are shown and they are always writable".
 */

/** The organisation's standard — no *Verfügbarkeit*, because it has none. */
const TENANT_DEFAULTS: TenantFormSettings = omitAvailabilityKeys({
  ...SYSTEM_FORM_SETTINGS,
  confirmTitle: 'Standardtitel der Organisation',
  redirectDelay: 42,
  showProgress: false,
});

/** What applies to the form before anything is typed. */
const EFFECTIVE: FormSettings = {
  ...SYSTEM_FORM_SETTINGS,
  ...TENANT_DEFAULTS,
  openEnabled: true,
  closeAt: '2026-08-15T21:59:00.000Z',
  maxResponsesEnabled: true,
  maxResponses: 300,
};

/**
 * A loaded document as `settings-draft.ts` sees it — `inherited` is the
 * organisation's standard for a form and the shipped defaults for an
 * organisation. These rules are the same at both levels, which is what the
 * helper's one type says.
 */
function document(
  overrides: Partial<SectionedDocument<FormSettings>> = {},
): SectionedDocument<FormSettings> {
  const base: SectionedDocument<FormSettings> = {
    overridden: {
      access: false,
      confirm: false,
      display: false,
      budget: false,
    },
    inherited: TENANT_DEFAULTS,
    effective: EFFECTIVE,
  };
  return { ...base, ...overrides };
}

/**
 * In the rules of this module the privacy notice is a passed-through
 * field without inheritance; it has its own cases below. These two
 * wrapper functions therefore keep it out of every other case, instead of
 * writing it into fifty calls that want to know nothing about it.
 */
function draftOf(
  document: SectionedDocument<FormSettings>,
  privacyNotice: LegalDocument = EMPTY_LEGAL_DOCUMENT,
): SettingsDraft {
  return draftOfDocument(document, privacyNotice);
}

function isDirty(
  document: SectionedDocument<FormSettings>,
  draft: SettingsDraft,
  stored: LegalDocument = EMPTY_LEGAL_DOCUMENT,
): boolean {
  return isDirtyAgainst(document, draft, stored);
}

describe('the settings draft', () => {
  describe('what the page shows', () => {
    it('shows the organisation’s standard for a section that follows it', () => {
      const shown = shownSettings(document(), draftOf(document()));

      expect(shown.redirectDelay).toBe(42);
      expect(shown.confirmTitle).toBe('Standardtitel der Organisation');
    });

    it('shows the form’s own values for a section it has taken over', () => {
      const taken = document({
        overridden: {
          access: false,
          confirm: true,
          display: false,
          budget: false,
        },
        effective: { ...EFFECTIVE, confirmTitle: 'Eigener Titel' },
      });

      expect(shownSettings(taken, draftOf(taken)).confirmTitle).toBe(
        'Eigener Titel',
      );
    });

    /**
     * *Verfügbarkeit* has no switch and no layer below: the form's own values
     * are shown whatever the four switches say.
     */
    it('shows the form’s own Verfügbarkeit without any section being taken over', () => {
      const loaded = document();

      expect(shownSettings(loaded, draftOf(loaded)).maxResponses).toBe(300);
      expect(
        shownSettings(loaded, withValue(draftOf(loaded), { maxResponses: 12 }))
          .maxResponses,
      ).toBe(12);
    });

    /**
     * The case the whole „don't recompute the merge" rule rests on: a section
     * switched on but not yet saved shows what *applies*, because that is
     * exactly what `setSectionOverride` will copy into it on the server. A
     * client that filled the gap with system defaults instead would show 250
     * here and store 300 — and nobody would see the difference until later.
     */
    it('shows the applying values for a section switched on but not saved', () => {
      const loaded = document();
      const draft = withSection(loaded, draftOf(loaded), 'confirm', true);

      expect(shownSettings(loaded, draft).confirmTitle).toBe(
        'Standardtitel der Organisation',
      );
      expect(writableValues(draft)).toEqual({});
    });

    it('shows the organisation’s standard again once a section is switched off', () => {
      const taken = document({
        overridden: {
          access: false,
          confirm: true,
          display: false,
          budget: false,
        },
        effective: { ...EFFECTIVE, confirmTitle: 'Eigener Titel' },
      });
      const draft = withSection(taken, draftOf(taken), 'confirm', false);

      expect(shownSettings(taken, draft).confirmTitle).toBe(
        'Standardtitel der Organisation',
      );
    });

    /**
     * The regression a review found, and the reason the overlay goes through
     * `mergeSettings` rather than `??`.
     *
     * For `openAt`, `closeAt` and `redirectUrl`, `null` **is** a value —
     * „keine Frist", „kein Ziel". With `??` it read as „nichts eingegeben", so
     * the old date came straight back into the field while the save quietly
     * sent `closeAt: null`: the screen and the stored document said the
     * opposite of each other.
     */
    describe('a value cleared to null', () => {
      const withDeadline = document();

      it('keeps an emptied closeAt empty', () => {
        const draft = withValue(draftOf(withDeadline), { closeAt: null });

        expect(shownSettings(withDeadline, draft).closeAt).toBeNull();
      });

      it('keeps an emptied redirectUrl empty', () => {
        const withRedirect = document({
          overridden: {
            access: false,
            confirm: true,
            display: false,
            budget: false,
          },
          effective: {
            ...EFFECTIVE,
            redirectUrl: 'https://example.org/',
          },
        });
        const draft = withValue(draftOf(withRedirect), { redirectUrl: null });

        expect(shownSettings(withRedirect, draft).redirectUrl).toBeNull();
      });

      it('still sends the null rather than dropping it from the patch', () => {
        const draft = withValue(draftOf(withDeadline), { closeAt: null });

        expect(writableValues(draft)).toEqual({ closeAt: null });
        // …and the page knows it has something to save, so the button is not
        // dead while the screen shows a cleared field.
        expect(isDirty(withDeadline, draft)).toBe(true);
      });
    });

    it('shows an edit that has not been saved yet', () => {
      const loaded = document();
      const draft = withValue(
        withSection(loaded, draftOf(loaded), 'confirm', true),
        {
          confirmTitle: 'Gerade getippt',
        },
      );

      expect(shownSettings(loaded, draft).confirmTitle).toBe('Gerade getippt');
    });
  });

  describe('what a save carries', () => {
    /**
     * The lock, proven on the wire rather than on the screen: a value typed
     * into a section that is *not* taken over must leave no trace in the
     * document. The disabled fieldset already stops it in the
     * browser; this is the second of the three layers.
     */
    it('drops the values of a locked section', () => {
      const draft = withValue(draftOf(document()), {
        confirmTitle: 'Nicht erlaubt',
      });

      expect(writableValues(draft)).toEqual({});
    });

    /**
     * …and never the form's *Verfügbarkeit*, which belongs to no section that
     * could be locked. Dropping it here would delete a form's deadline on the
     * next save.
     */
    it('always carries the Verfügbarkeit values', () => {
      const draft = withValue(draftOf(document()), { maxResponses: 7 });

      expect(writableValues(draft)).toEqual({ maxResponses: 7 });
    });

    it('keeps the values of a section that is taken over', () => {
      const draft = withValue(
        withSection(document(), draftOf(document()), 'confirm', true),
        { confirmTitle: 'Nur für dieses Formular' },
      );

      expect(writableValues(draft)).toEqual({
        confirmTitle: 'Nur für dieses Formular',
      });
    });

    /**
     * **All five switches, always.** A review reproduced the data loss a
     * partial switch document causes against the live route: a second write
     * mentioning only `display` wiped the deadline *and* physically removed the
     * sealed access word, answered with 200.
     */
    it('carries all four switches even when one changed', () => {
      const draft = withSection(
        document(),
        draftOf(document()),
        'display',
        true,
      );

      expect(draft.overridden).toEqual({
        access: false,
        confirm: false,
        display: true,
        budget: false,
      });
      expect(Object.keys(draft.overridden).sort()).toEqual([
        'access',
        'budget',
        'confirm',
        'display',
      ]);
    });

    it('keeps the other switches when a second section is taken over', () => {
      const loaded = document({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: true,
        },
      });
      const draft = withSection(loaded, draftOf(loaded), 'display', true);

      expect(draft.overridden).toEqual({
        access: true,
        confirm: false,
        display: true,
        budget: true,
      });
    });

    /**
     * Switching a section off discards its edits. Keeping them would let a
     * second switch-on resurrect numbers the editor watched disappear — the
     * same rule `setSectionOverride` follows on the server.
     */
    it('forgets the edits of a section that was switched off again', () => {
      const draft = withSection(
        document(),
        withValue(
          withSection(document(), draftOf(document()), 'confirm', true),
          { confirmTitle: 'Wieder weg' },
        ),
        'confirm',
        false,
      );

      expect(draft.values).toEqual({});
    });
  });

  /**
   * **The withheld Zugangswort** (ADR-0021, a security finding).
   *
   * Whoever does not hold `can_manage_settings` gets the organisation's
   * standard delivered with {@link REDACTED_PASSWORD} instead of the word —
   * and the server does **not** copy it along when the section is taken over
   * (`copyableTenantDefaults`). Without the two values `withSection` sets
   * here, after the click a switch „Passwortschutz: an" would stand above a
   * field that turns empty and off on saving.
   */
  describe('ein Zugangswort, das der Server zurückhält', () => {
    /** The answer as an `editor` gets it: protection on, word redacted. */
    const WITHHELD = document({
      effective: {
        ...EFFECTIVE,
        passwordEnabled: true,
        password: REDACTED_PASSWORD,
      },
      inherited: {
        ...TENANT_DEFAULTS,
        passwordEnabled: true,
        password: REDACTED_PASSWORD,
      },
    });

    it('erkennt den Platzhalter und hält ein echtes Wort davon getrennt', () => {
      expect(isWithheldPassword(REDACTED_PASSWORD)).toBe(true);
      expect(isWithheldPassword('Jahrestagung2026')).toBe(false);
      // And **not** the empty field: „no word set" is a different
      // state from „set, but not for you".
      expect(isWithheldPassword('')).toBe(false);
    });

    it('übernimmt den Abschnitt ohne das Wort und ohne den Schutz', () => {
      const draft = withSection(WITHHELD, draftOf(WITHHELD), 'access', true);

      expect(draft.values).toEqual({ password: '', passwordEnabled: false });
      // And the screen says the same as the column is about to say —
      // no placeholder in the field, no switch claiming protection.
      const shown = shownSettings(WITHHELD, draft);
      expect(shown.password).toBe('');
      expect(shown.passwordEnabled).toBe(false);
    });

    it('lässt ein eingetipptes eigenes Wort den Startwert ersetzen', () => {
      const draft = withValue(
        withSection(WITHHELD, draftOf(WITHHELD), 'access', true),
        { password: 'Jahrestagung2026!', passwordEnabled: true },
      );

      expect(writableValues(draft)).toEqual({
        password: 'Jahrestagung2026!',
        passwordEnabled: true,
      });

      // …and a second call on the same, already taken-over section does not
      // take it away again. Not reachable through the interface (an already
      // chosen radio button raises no `change`), but the difference
      // between „works today" and „is correct".
      expect(
        writableValues(withSection(WITHHELD, draft, 'access', true)),
      ).toEqual({ password: 'Jahrestagung2026!', passwordEnabled: true });
    });

    it('verwirft den Startwert wieder, wenn der Abschnitt zurückgeht', () => {
      const draft = withSection(
        WITHHELD,
        withSection(WITHHELD, draftOf(WITHHELD), 'access', true),
        'access',
        false,
      );

      expect(draft.values).toEqual({});
    });

    /**
     * **The counter-check.** If the caller sees the word (they hold
     * `can_manage_settings`, or the organisation has set none at all),
     * it remains the case that the server alone copies — otherwise this
     * special case would take the protection off every form at the first
     * „Angepasst".
     */
    it('rührt einen sichtbaren Zugangsabschnitt nicht an', () => {
      const visible = document({
        effective: {
          ...EFFECTIVE,
          passwordEnabled: true,
          password: 'Jahrestagung2026',
        },
      });
      const draft = withSection(visible, draftOf(visible), 'access', true);

      expect(draft.values).toEqual({});
      expect(shownSettings(visible, draft).password).toBe('Jahrestagung2026');
    });

    it('rührt die anderen drei Abschnitte nicht an', () => {
      const draft = withSection(WITHHELD, draftOf(WITHHELD), 'confirm', true);

      expect(draft.values).toEqual({});
    });
  });

  describe('whether saving would change anything', () => {
    it('is clean right after loading', () => {
      const loaded = document();

      expect(isDirty(loaded, draftOf(loaded))).toBe(false);
    });

    it('is dirty once a section is switched', () => {
      const loaded = document();

      expect(
        isDirty(loaded, withSection(loaded, draftOf(loaded), 'display', true)),
      ).toBe(true);
    });

    it('is dirty once a field of an unlocked section changed', () => {
      const taken = document({
        overridden: {
          access: false,
          confirm: true,
          display: false,
          budget: false,
        },
        effective: { ...EFFECTIVE, confirmTitle: 'Eigener Titel' },
      });
      const draft = withValue(draftOf(taken), { confirmTitle: 'Neu' });

      expect(isDirty(taken, draft)).toBe(true);
    });

    it('stays clean when a locked section is typed into', () => {
      // The field is disabled, so this cannot happen through the interface —
      // but a save button that lit up for a change that will not be stored
      // would promise one.
      const loaded = document();
      const draft = withValue(draftOf(loaded), { confirmTitle: 'Ignoriert' });

      expect(isDirty(loaded, draft)).toBe(false);
    });
  });
});

/**
 * **The page below the form — the standards of an organisation**
 * (review finding 10).
 *
 * Three small rules instead of the three above, and what is checked is
 * exactly the difference: there is no section that could be locked, so
 * every typed change is one that gets saved.
 *
 * *Counter-checks, measured while writing:* `withTenantValue` switched to
 * `mergeSettings` → „nimmt eine erste Änderung an einem Feld auf"
 * red, because a patch does not yet carry the key; `shownTenantValues`
 * switched to `??` → „lässt ein bewusstes null durch" red.
 */
describe('die Standards einer Organisation', () => {
  const STORED: TenantFormSettings = omitAvailabilityKeys({
    ...SYSTEM_FORM_SETTINGS,
    confirmTitle: 'Standard der Organisation',
    mailBudgetLimit: 300,
  });

  it('zeigt das Gespeicherte mit dem Getippten darüber', () => {
    const draft = withTenantValue({}, { confirmTitle: 'Gerade getippt' });

    expect(shownTenantValues(STORED, draft).confirmTitle).toBe(
      'Gerade getippt',
    );
    // …and everything else stays what the server has.
    expect(shownTenantValues(STORED, draft).mailBudgetLimit).toBe(300);
  });

  it('nimmt eine erste Änderung an einem Feld auf', () => {
    // The draft is a patch: it does not carry the key at all yet, and
    // a merge that only moves existing keys would drop the
    // change.
    expect(withTenantValue({}, { showProgress: false })).toStrictEqual({
      showProgress: false,
    });
  });

  it('lässt ein bewusstes null durch', () => {
    const draft = withTenantValue(
      { redirectEnabled: false },
      { redirectUrl: null },
    );

    expect(shownTenantValues(STORED, draft).redirectUrl).toBeNull();
  });

  it('ist sauber, solange nichts getippt wurde', () => {
    expect(isTenantDirty(STORED, {})).toBe(false);
    // A value typed back to the stored one is no
    // change — otherwise the button would promise a save that does nothing.
    expect(isTenantDirty(STORED, { mailBudgetLimit: 300 })).toBe(false);
  });

  it('ist schmutzig, sobald ein Feld abweicht', () => {
    expect(isTenantDirty(STORED, { mailBudgetLimit: 150 })).toBe(true);
  });
});

/**
 * **The privacy notice in the draft** (ADR-0028 no. 4).
 *
 * Three properties, and all three are cases of loss: it counts towards
 * „unsaved", it survives every change to the sections, and it
 * survives in particular the deselection of a section — there the draft
 * deliberately throws values away, and the notice must not be one of them.
 */
describe('der Datenschutzhinweis dieses Formulars', () => {
  const NOTICE: LegalDocument = {
    ...EMPTY_LEGAL_DOCUMENT,
    fills: { ZWECK: 'Anmeldung zur Jahrestagung' },
  };

  it('zählt als ungespeicherte Änderung', () => {
    const loaded = document();
    const draft = withPrivacyNotice(draftOf(loaded), NOTICE);

    expect(isDirty(loaded, draft)).toBe(true);
    expect(isDirty(loaded, draft, NOTICE)).toBe(false);
  });

  it('überlebt das Übernehmen und das Abwählen eines Abschnitts', () => {
    const loaded = document();
    const draft = withPrivacyNotice(draftOf(loaded), NOTICE);

    const takenOver = withSection(loaded, draft, 'confirm', true);
    expect(takenOver.privacyNotice).toEqual(NOTICE);

    const dropped = withSection(loaded, takenOver, 'confirm', false);
    expect(dropped.privacyNotice).toEqual(NOTICE);
  });

  it('überlebt eine gewöhnliche Wertänderung', () => {
    const loaded = document();
    const draft = withValue(withPrivacyNotice(draftOf(loaded), NOTICE), {
      maxResponses: 12,
    });

    expect(draft.privacyNotice).toEqual(NOTICE);
  });

  it('reist nicht durch writableValues — er ist kein Abschnittswert', () => {
    const loaded = document();
    const draft = withPrivacyNotice(draftOf(loaded), NOTICE);

    expect(writableValues(draft)).toEqual({});
  });
});
