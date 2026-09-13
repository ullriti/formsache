import {
  REDACTED_PASSWORD,
  SYSTEM_FORM_SETTINGS,
  TENANT_SETTINGS_FLOOR,
} from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  safeRedactedFormOverride,
  safeRedactedTenantDefaults,
} from './settings-document';
import {
  UnreadableSettingsError,
  enforcedSettings,
} from './settings-enforcement';

/**
 * The **two readings**, side by side.
 *
 * The point of this file is the contrast, so the tolerant functions are called
 * here too rather than being left to their own suite: every case below states
 * what the *display* path answers and what the *enforcement* path answers, on
 * the very same document. A change that quietly aligned the two would be
 * invisible in either file alone — and aligning them the wrong way round is
 * exactly the mistake enforcement is warned about.
 */

const TENANT = '019ff400-0000-7000-8000-000000000001';
const FORM = '019ff400-0000-7000-8000-0000000000a1';

function source(
  settingsOverride: unknown,
  formDefaults: unknown = {},
): {
  id: string;
  settingsOverride: unknown;
  tenant: { id: string; formDefaults: unknown };
} {
  return {
    id: FORM,
    settingsOverride,
    tenant: { id: TENANT, formDefaults },
  };
}

/** What a *newer* deployment writes and this one cannot read. */
const FROM_THE_FUTURE = { einstellungAusM9: true };

describe('enforcedSettings (the strict reading of an unreadable settings document)', () => {
  describe('a document from a newer deployment', () => {
    it('refuses when it is the form override, where display falls back', () => {
      const override = {
        overridden: {
          access: false,
          confirm: false,
          display: false,
        },
        values: FROM_THE_FUTURE,
      };

      // Display: „nichts entschieden", and it renders.
      expect(safeRedactedFormOverride(override)).toBeNull();
      // Enforcement: no.
      expect(() => enforcedSettings(source(override))).toThrow(
        UnreadableSettingsError,
      );
    });

    it('refuses when it is the tenant standard, where display falls back', () => {
      expect(safeRedactedTenantDefaults(FROM_THE_FUTURE)).toBeNull();
      expect(() => enforcedSettings(source({}, FROM_THE_FUTURE))).toThrow(
        UnreadableSettingsError,
      );
    });

    /**
     * The message names *which* of the two columns is broken, because the
     * consequences differ by an order of magnitude: one form of an organisation against
     * every form of that organisation. It goes into the log, never into an answer.
     */
    it('names the column it choked on', () => {
      expect(() => enforcedSettings(source({}, FROM_THE_FUTURE))).toThrow(
        new RegExp(`form_defaults of tenant ${TENANT}`),
      );
      expect(() =>
        enforcedSettings(source({ values: FROM_THE_FUTURE })),
      ).toThrow(new RegExp(`settings_override of form ${FORM}`));
    });
  });

  /**
   * **The counter-example, and the reason „fail closed" is not „refuse
   * everything".**
   *
   * An absent or empty column means „nichts entschieden" (no
   * backfill) — that is a document this version reads perfectly well. Treating
   * it as unreadable would shut every form built before this shipped.
   */
  describe('a document that is merely empty', () => {
    it.each([
      ['the column default', {}],
      ['an override without values', { overridden: { display: true } }],
    ])('reads %s as the system defaults', (_name, stored) => {
      expect(enforcedSettings(source(stored))).toStrictEqual(
        SYSTEM_FORM_SETTINGS,
      );
    });
  });

  /**
   * **JSON `null` is not „nichts entschieden" — not here.**
   *
   * The shared parsers answer `null` with the system defaults, and their reason
   * is an *absent* column (no backfill). There is none: both
   * `tenant.form_defaults` and `form.settings_override` are `JSONB NOT NULL
   * DEFAULT '{}'`, so the only way into that branch is a literal JSON `null`
   * stored inside the column — and enforcement reading it as „keine Frist, kein
   * Limit" would be the one fail-open this module exists to prevent. It was
   * also the one document shape that got through.
   *
   * The tolerant path is called on the same value, as everywhere in this file:
   * it still degrades, because display must not 500 a whole organisation.
   */
  describe('a stored JSON null', () => {
    it('refuses it as the tenant standard, where display falls back', () => {
      // The organisation's document has no *Verfügbarkeit* (ADR-0011,
      // continuation 2026-08-14), so what „nichts entschieden" means on that
      // layer is the shipped constant minus those seven keys.
      expect(safeRedactedTenantDefaults(null)).toStrictEqual(
        TENANT_SETTINGS_FLOOR,
      );
      expect(() => enforcedSettings(source({}, null))).toThrow(
        UnreadableSettingsError,
      );
      expect(() => enforcedSettings(source({}, null))).toThrow(
        new RegExp(`form_defaults of tenant ${TENANT}`),
      );
    });

    it('refuses it as the form override, where display falls back', () => {
      expect(safeRedactedFormOverride(null)).not.toBeNull();
      expect(() => enforcedSettings(source(null))).toThrow(
        UnreadableSettingsError,
      );
      expect(() => enforcedSettings(source(null))).toThrow(
        new RegExp(`settings_override of form ${FORM}`),
      );
    });

    /**
     * `undefined` is deliberately **not** refused: it is not a document but a
     * property missing from the object handed in, which only a partial `select`
     * can produce. A 503 there would hide a query bug behind a sentence about
     * settings.
     */
    it('still reads an absent property as the system defaults', () => {
      expect(enforcedSettings(source(undefined, undefined))).toStrictEqual(
        SYSTEM_FORM_SETTINGS,
      );
    });
  });

  /**
   * **Only a parse failure is „das Dokument parst nicht".**
   *
   * The two blocks in `enforcedSettings` caught bare, so anything thrown while
   * reading — a `TypeError` from a bug in this module or in the shared merge —
   * came back out as an unreadable document and was answered with a calm 503
   * saying the state resolves itself. It never would; the defect was invisible.
   * Fail closed is untouched either way (nothing is written), the diagnosis is
   * not.
   */
  it('lets a fault that is not a parse error through instead of calling it unreadable', () => {
    const boom = new TypeError('bug in the merge');
    // A throwing getter on the one key the read touches first (`mapPassword`
    // in `settings-document.ts`), so the fault is raised **inside** the very
    // `try` this test is about — a document that merely fails to parse would
    // prove nothing here, and one that throws before the `try` would prove it
    // even less.
    const exploding = source(
      {},
      {
        // The organisation's flat document (review finding 10): the word
        // stands right at the top, and that is exactly where `mapPassword`
        // reaches.
        get password(): string {
          throw boom;
        },
      },
    );

    expect(() => enforcedSettings(exploding)).toThrow(boom);
    expect(() => enforcedSettings(exploding)).not.toThrow(
      UnreadableSettingsError,
    );
  });

  describe('a document it can read', () => {
    it('applies the merge, section by section, exactly as the display path does', () => {
      const settings = enforcedSettings(
        source(
          {
            // *Verfügbarkeit* has no switch: the values below are the form's
            // own whatever the four switches say (ADR-0011, continuation
            // 2026-08-14).
            overridden: {
              access: false,
              confirm: false,
              display: false,
            },
            values: { openEnabled: true, closeAt: '2026-08-15T21:59:00.000Z' },
          },
          // The organisation decides its set flat — without switches, since
          // review finding 10.
          { showProgress: false },
        ),
      );

      // From the form's own *Verfügbarkeit*…
      expect(settings.closeAt).toBe('2026-08-15T21:59:00.000Z');
      // …and from the organisation, for a section the form has not taken over.
      expect(settings.showProgress).toBe(false);
    });

    /**
     * **The access word is replaced, not opened** — this module holds no
     * cipher, and the other checks have no use for the word. The access-word
     * check will need it and has to get it where the key lives.
     */
    it('hands out the redaction marker instead of the stored word', () => {
      const settings = enforcedSettings(
        source({
          overridden: {
            access: true,
            confirm: false,
            display: false,
          },
          values: { passwordEnabled: true, password: 'ein-versiegelter-wert' },
        }),
      );

      expect(settings.password).toBe(REDACTED_PASSWORD);
      expect(settings.password).not.toContain('ein-versiegelter-wert');
      // …and the switch survives the redaction, so the access-word check can still see that a
      // password is configured at all.
      expect(settings.passwordEnabled).toBe(true);
    });
  });

  /**
   * A stored `javascript:` redirect makes the whole document unreadable
   * (`externalUrlSchema`). Enforcement therefore refuses the
   * submission rather than handing out a confirmation with the standard texts,
   * which is what the display path does. Recorded here because it is the one
   * place where a check's observable behaviour changed since then.
   */
  it('refuses a document whose redirect target a browser must not follow', () => {
    const override = {
      overridden: {
        access: false,
        confirm: true,
        display: false,
      },
      values: { redirectEnabled: true, redirectUrl: 'javascript:alert(1)' },
    };

    expect(safeRedactedFormOverride(override)).toBeNull();
    expect(() => enforcedSettings(source(override))).toThrow(
      UnreadableSettingsError,
    );
  });
});
