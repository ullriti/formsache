import type { ChoiceQuestion } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  otherFieldLabel,
  otherSentinelOf,
  singleValue,
  toChoice,
} from './choice-answer';

/**
 * The arithmetic behind a choice control, asserted as arithmetic.
 *
 * jsdom is not a browser (`CONTRIBUTING.md`): what a `<select>` *does* with a
 * chosen entry is checked here as a function, and `FieldInput.test.tsx` only
 * asserts that the control calls it. The two halves together are what the
 * investigation found missing — the dropdown offered „Nicht Mitglied der Dachorganisation – Name des
 * Organisation" and stored `{ values: [], other: '' }` whatever anybody typed.
 */

const OTHER_TEXT = 'Schachverein Nord';

type SelectQuestion = Extract<ChoiceQuestion, { type: 'select' }>;

function selectQuestion(
  overrides: Partial<SelectQuestion> = {},
): SelectQuestion {
  return {
    id: '019fe600-0000-7000-8000-0000000000c1',
    label: 'Organisation',
    hint: null,
    required: true,
    width: 'full',
    type: 'select',
    options: [
      { value: 'nord', label: 'Nord' },
      { value: 'sued', label: 'Süd' },
    ],
    allowOther: true,
    otherLabel: 'Nicht Mitglied der Dachorganisation – Name der Organisation',
    ...overrides,
  };
}

describe('toChoice', () => {
  it('turns the „Sonstiges" entry into a chosen-but-empty free text', () => {
    const question = selectQuestion();

    expect(toChoice(otherSentinelOf(question), question)).toEqual({
      values: [],
      other: '',
    });
  });

  it('turns a real option into that option', () => {
    expect(toChoice('sued', selectQuestion())).toEqual({
      values: ['sued'],
      other: null,
    });
  });

  it('turns the empty entry into "not answered"', () => {
    expect(toChoice('', selectQuestion())).toEqual({ values: [], other: null });
  });

  /**
   * Point 2 of the fix: the typed text is **dropped** when a real option is
   * picked afterwards. The radio branch has always done this (it emits
   * `other: null`), and an answer carrying both a chosen option and a leftover
   * free text is a shape no reader can resolve.
   */
  it('drops the free text when a real option is picked afterwards', () => {
    const question = selectQuestion();
    const typed = { values: [], other: OTHER_TEXT };

    expect(singleValue(typed, question)).toBe(otherSentinelOf(question));
    expect(toChoice('nord', question)).toEqual({
      values: ['nord'],
      other: null,
    });
  });
});

/**
 * Option values are editable („wert = Beschriftung" in the bulk import), so an
 * option may genuinely be called `__other__`. With a fixed sentinel the two
 * entries shared one value: the real option won the lookup and the „Sonstiges"
 * entry could not be chosen at all — the same broken promise the investigation
 * found, one configuration further out.
 */
describe('otherSentinelOf — collision with a real option', () => {
  const collidingQuestion = selectQuestion({
    options: [
      { value: '__other__', label: 'Eine echte Option' },
      { value: '__other___', label: 'Und noch eine' },
    ],
  });

  it('never equals an option value, however many collide', () => {
    const sentinel = otherSentinelOf(collidingQuestion);

    expect(sentinel).toBe('__other____');
    expect(
      collidingQuestion.options.some((option) => option.value === sentinel),
    ).toBe(false);
  });

  it('keeps both entries selectable — the real option and „Sonstiges"', () => {
    expect(toChoice('__other__', collidingQuestion)).toEqual({
      values: ['__other__'],
      other: null,
    });
    expect(
      toChoice(otherSentinelOf(collidingQuestion), collidingQuestion),
    ).toEqual({ values: [], other: '' });
  });

  it('shows the „Sonstiges" entry, not the like-named option, for a free text', () => {
    expect(
      singleValue({ values: [], other: OTHER_TEXT }, collidingQuestion),
    ).toBe(otherSentinelOf(collidingQuestion));
    expect(
      singleValue({ values: ['__other__'], other: null }, collidingQuestion),
    ).toBe('__other__');
  });
});

describe('singleValue', () => {
  const question = selectQuestion();

  it('shows the „Sonstiges" entry while a free text is in play', () => {
    expect(singleValue({ values: [], other: '' }, question)).toBe(
      otherSentinelOf(question),
    );
    expect(singleValue({ values: [], other: OTHER_TEXT }, question)).toBe(
      otherSentinelOf(question),
    );
  });

  it('shows the chosen option, and nothing for an unanswered question', () => {
    expect(singleValue({ values: ['sued'], other: null }, question)).toBe(
      'sued',
    );
    expect(singleValue(undefined, question)).toBe('');
    expect(singleValue(null, question)).toBe('');
  });
});

describe('otherFieldLabel', () => {
  it("names the free-text box after the editor's own wording", () => {
    expect(otherFieldLabel(selectQuestion())).toBe(
      'Nicht Mitglied der Dachorganisation – Name der Organisation: Freitext',
    );
  });

  it('falls back to the handoff default when no wording was set', () => {
    expect(otherFieldLabel(selectQuestion({ otherLabel: null }))).toBe(
      'Sonstiges: Freitext',
    );
  });
});
