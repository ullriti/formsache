import { describe, expect, it } from 'vitest';

import { asAddress } from './address-answer';

/**
 * The arithmetic behind the Adresse control, asserted as arithmetic — the
 * counterpart of `choice-answer.test.ts` for a structured value.
 */

describe('asAddress', () => {
  it('starts with Land pre-filled, überschreibbar, while nothing else was touched', () => {
    expect(asAddress(undefined)).toEqual({
      street: '',
      zip: '',
      city: '',
      country: 'Deutschland',
    });
    expect(asAddress(null)).toEqual({
      street: '',
      zip: '',
      city: '',
      country: 'Deutschland',
    });
  });

  it('trusts a stored address as it stands, including an explicitly empty Land', () => {
    const stored = {
      street: 'Musterstraße 12',
      zip: '',
      city: '',
      country: '',
    };
    expect(asAddress(stored)).toBe(stored);
  });

  /**
   * The one shape `asAddress` has to tell apart from its own: a choice
   * answer is also a plain object. Reaching it here would be foreign data —
   * `FieldInput`'s address branch never produces one — but the fallback is
   * the same defensive one `asChoice` gives a shape it does not recognise.
   */
  it('falls back to the untouched default for a foreign object shape', () => {
    expect(asAddress({ values: ['a'], other: null })).toEqual({
      street: '',
      zip: '',
      city: '',
      country: 'Deutschland',
    });
  });
});
