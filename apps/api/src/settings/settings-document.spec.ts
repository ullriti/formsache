import { describe, expect, it } from 'vitest';

import { stripOverridePassword } from './settings-document';

/**
 * What a duplicated form's settings_override must not carry over: the access
 * word, sealed under the **original** form's
 * context, is unreadable — and would be a secret nobody set — under the new
 * form's. `stripOverridePassword` runs on the raw, still-sealed JSON, exactly
 * as it comes out of `form.settings_override`, and never opens it.
 */
describe('stripOverridePassword ', () => {
  it('blanks the word and switches protection off when the access section is overridden', () => {
    const stored = {
      overridden: { access: true, avail: false },
      values: {
        passwordEnabled: true,
        password: 'sealed:opaque-ciphertext',
        allowEdit: true,
      },
    };

    expect(stripOverridePassword(stored)).toStrictEqual({
      overridden: { access: true, avail: false },
      values: {
        passwordEnabled: false,
        password: '',
        allowEdit: true,
      },
    });
  });

  it('leaves the document untouched when the access section is not overridden and no word is written down', () => {
    const stored = {
      overridden: { access: false, avail: true },
      values: { openEnabled: true },
    };

    expect(stripOverridePassword(stored)).toStrictEqual(stored);
  });

  /**
   * **The reproduction of a review finding** (2026-08-05): the strip
   * decided on the neighbouring field `overridden.access` instead of on the
   * field it removes. Both documents here carry a word and would have
   * travelled **unchanged** into the copy with the old version.
   *
   * Both shapes are reachable, although `pruneToOverridden` prevents exactly
   * them on the application's *write* path: `settings_override` is
   * JSONB and takes any JSON — written by hand, out of an import, out of
   * a restore or from an older version of this code. It is exactly
   * the assumption „the database checks that already" that the head of
   * `settings-document.ts` expressly rejects.
   */
  it('takes the word out even when the access section says it is not overridden', () => {
    const stored = {
      overridden: { access: false, avail: true },
      values: {
        passwordEnabled: true,
        password: 'sealed:opaque-ciphertext',
        openEnabled: true,
      },
    };

    expect(stripOverridePassword(stored)).toStrictEqual({
      overridden: { access: false, avail: true },
      values: {
        passwordEnabled: false,
        password: '',
        openEnabled: true,
      },
    });
  });

  it('takes the word out of a document that carries no `overridden` key at all', () => {
    const stored = {
      values: { passwordEnabled: true, password: 'sealed:opaque-ciphertext' },
    };

    expect(stripOverridePassword(stored)).toStrictEqual({
      values: { passwordEnabled: false, password: '' },
    });
  });

  /**
   * The half shape: only the word, without the switch. It too has to set both
   * halves — a word without a switch is a secret that travels for no reason,
   * and a switch without a word is the state
   * `checkSettingsConsistency` does not let be saved in the first place.
   */
  it('sets both halves when only one of them is written down', () => {
    expect(
      stripOverridePassword({ values: { password: 'sealed:opaque' } }),
    ).toStrictEqual({ values: { password: '', passwordEnabled: false } });

    expect(
      stripOverridePassword({ values: { passwordEnabled: true } }),
    ).toStrictEqual({ values: { password: '', passwordEnabled: false } });
  });

  it('leaves a form that never touched its settings untouched', () => {
    const stored = { overridden: {}, values: {} };
    expect(stripOverridePassword(stored)).toStrictEqual(stored);
  });

  it('does nothing for a document that is not a JSON object', () => {
    expect(stripOverridePassword(null)).toBeNull();
    expect(stripOverridePassword('broken')).toBe('broken');
    expect(stripOverridePassword(undefined)).toBeUndefined();
  });

  it('leaves the document untouched when overridden.access is true but values carries no object at all', () => {
    const stored = { overridden: { access: true }, values: 'not-an-object' };
    expect(stripOverridePassword(stored)).toStrictEqual(stored);
  });
});
