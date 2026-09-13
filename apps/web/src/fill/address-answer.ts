import {
  DEFAULT_ADDRESS_COUNTRY,
  isAddressAnswer,
  type AddressAnswer,
  type AnswerValue,
} from '@formsache/shared';

/**
 * The arithmetic between an Adresse question's four inputs and the answer
 * shape — the counterpart of `choice-answer.ts` for a
 * structured value instead of a choice one, split out for the same reason:
 * „welcher Wert kommt heraus" is a calculation, asserted as a function rather
 * than through four rendered `<input>`s (`CONTRIBUTING.md`).
 */

/**
 * Any stored value read as the Adresse answer it is supposed to be — with
 * **Land pre-filled**, überschreibbar, exactly while nothing has been typed
 * into *any* subfield yet (decided 2026-07-31).
 *
 * `country: DEFAULT_ADDRESS_COUNTRY` only in the untouched fallback, never
 * layered on top of a value that already exists: once any subfield has been
 * edited once (`FieldInput.tsx`'s address branch always merges onto this
 * function's own result), the stored `country` is trusted as it stands —
 * including an empty string a participant cleared on purpose. Re-applying the
 * default there would fight a deliberate „nein, keins" the same way a select
 * box that keeps resetting itself would.
 */
export function asAddress(value: AnswerValue | undefined): AddressAnswer {
  if (isAddressAnswer(value)) {
    return value;
  }
  return {
    street: '',
    zip: '',
    city: '',
    country: DEFAULT_ADDRESS_COUNTRY,
  };
}
