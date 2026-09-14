import type { ChoiceQuestion } from '@formsache/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuestionPreview } from './QuestionPreview';

/**
 * Where „Sonstiges" sits in the **builder's own preview** of a select or
 * radio/checkbox question — the second of the two renderers this switch has
 * to agree with (`FieldInput.tsx` is the first, and `FieldInput.test.tsx`
 * covers it). A preview that kept appending „Sonstiges" last regardless of
 * the switch would show an editor a card that does not match what a
 * participant is about to see (Issue #37).
 */

const QUESTION_ID = '019ff900-0000-7000-8000-0000000000e1';

function selectQuestion(
  type: 'select' | 'checkbox',
  overrides: Partial<{
    allowOther: boolean;
    otherLabel: string | null;
    otherPosition: 'first' | 'last';
  }> = {},
): ChoiceQuestion {
  const base = {
    id: QUESTION_ID,
    label: 'Organisation',
    hint: null,
    required: false,
    width: 'full',
    options: [
      { value: 'nord', label: 'Nord' },
      { value: 'sued', label: 'Süd' },
    ],
    allowOther: true,
    otherLabel: 'Sonstiges',
    ...overrides,
  } satisfies Omit<Extract<ChoiceQuestion, { type: 'select' }>, 'type'>;

  return type === 'select'
    ? { ...base, type: 'select' }
    : { ...base, type: 'checkbox', minSelected: null, maxSelected: null };
}

/** Every `<option>` label of the rendered `<select>`, in DOM order. */
function selectLabels(): (string | null)[] {
  return screen
    .getAllByRole<HTMLOptionElement>('option', { hidden: true })
    .map((option) => option.textContent);
}

/** Every choice's caption in the rendered radio/checkbox list, in DOM order. */
function choiceLabels(): (string | null)[] {
  return screen
    .getAllByText(/^(Nord|Süd|Sonstiges)$/, { selector: 'span' })
    .map((el) => el.textContent);
}

describe('QuestionPreview – Position von „Sonstiges"', () => {
  it('zeigt „Sonstiges" im Dropdown zuerst, ohne eigene Einstellung', () => {
    render(<QuestionPreview question={selectQuestion('select')} />);

    expect(selectLabels()).toStrictEqual(['Sonstiges', 'Nord', 'Süd']);
  });

  it('zeigt „Sonstiges" im Dropdown zuletzt, wenn otherPosition „last" ist', () => {
    render(
      <QuestionPreview
        question={selectQuestion('select', { otherPosition: 'last' })}
      />,
    );

    expect(selectLabels()).toStrictEqual(['Nord', 'Süd', 'Sonstiges']);
  });

  it('zeigt „Sonstiges" in der Radio-/Checkbox-Liste an derselben Stelle wie im Dropdown', () => {
    const { rerender } = render(
      <QuestionPreview question={selectQuestion('checkbox')} />,
    );
    expect(choiceLabels()).toStrictEqual(['Sonstiges', 'Nord', 'Süd']);

    rerender(
      <QuestionPreview
        question={selectQuestion('checkbox', { otherPosition: 'last' })}
      />,
    );
    expect(choiceLabels()).toStrictEqual(['Nord', 'Süd', 'Sonstiges']);
  });

  it('lässt „Sonstiges" ganz weg, solange die Frage es nicht anbietet', () => {
    render(
      <QuestionPreview
        question={selectQuestion('select', {
          allowOther: false,
          otherLabel: null,
        })}
      />,
    );

    expect(selectLabels()).toStrictEqual(['Nord', 'Süd']);
  });
});
