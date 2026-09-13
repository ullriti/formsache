import { describe, expect, it } from 'vitest';

import {
  ADDRESS_QUESTION_TYPES,
  addressQuestionsOf,
  isAddressQuestion,
} from './address-questions.ts';
import { questionSchema, type Question } from './form-schema.ts';

/**
 * The one address rule of the requirement, now that both sides read it here.
 *
 * These are behavioural tests and they are worth exactly what the requirement
 * says they are worth: they hold the *rule*, not its singleness. That one list
 * exists rather than two is proved structurally in `single-source.test.ts` —
 * with a list of one entry, no behaviour can tell a copy from the original.
 */

function question(overrides: Record<string, unknown>): Question {
  return questionSchema.parse({
    id: '019ff600-0000-7000-8000-000000000001',
    label: 'Feld',
    hint: null,
    required: false,
    width: 'full',
    ...overrides,
  });
}

const emailQuestion = question({
  id: '019ff600-0000-7000-8000-000000000002',
  type: 'email',
});
const textQuestion = question({
  type: 'text',
  minLength: null,
  maxLength: null,
  pattern: null,
});

describe('which questions can supply an address', () => {
  it('accepts an e-mail question', () => {
    expect(isAddressQuestion(emailQuestion)).toBe(true);
  });

  it('refuses a free-text question, however plausible its caption', () => {
    // The narrow half of the rule and the only one worth a test: a `text`
    // question can hold an address, a phone number or a joke, and „whatever
    // somebody typed" is a mail aimed at nobody.
    expect(isAddressQuestion(textQuestion)).toBe(false);
    expect(
      isAddressQuestion(
        question({ type: 'date', minDate: null, maxDate: null }),
      ),
    ).toBe(false);
  });

  it('keeps document order and drops everything else', () => {
    expect(addressQuestionsOf([textQuestion, emailQuestion])).toEqual([
      emailQuestion,
    ]);
  });

  it('is exactly the e-mail type today', () => {
    // Pinned so that adding a type is a deliberate edit with this test in the
    // diff — the moment a second address type arrives, both the 422 and
    // the editor's chips change together, which is the whole reason the list
    // moved here.
    expect([...ADDRESS_QUESTION_TYPES]).toEqual(['email']);
  });
});
