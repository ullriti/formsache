import type { FormPage, Question } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import { earlierConditionSources } from './condition-sources';

/**
 * Which questions a *Bedingte Anzeige* may point at — the
 * picklist's rule, asked without a DOM.
 *
 * The case that made this file necessary is the last one: an id the document
 * does not contain used to fall out of the loop and return **every** eligible
 * question, including the ones standing behind the question being edited —
 * exactly the state the publish lock refuses. The panel then offered it as
 * a choice.
 */

const PAGE_A = '019fe900-0000-7000-8000-0000000000a1';
const PAGE_B = '019fe900-0000-7000-8000-0000000000a2';
const FIRST = '019fe900-0000-7000-8000-0000000000b1';
const INFO = '019fe900-0000-7000-8000-0000000000b2';
const MIDDLE = '019fe900-0000-7000-8000-0000000000b3';
const LAST = '019fe900-0000-7000-8000-0000000000b4';
const UNKNOWN = '019fe900-0000-7000-8000-0000000000ff';

function text(id: string, label: string): Question {
  return {
    id,
    label,
    hint: null,
    required: false,
    width: 'full',
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function pages(): FormPage[] {
  return [
    {
      id: PAGE_A,
      title: 'Seite 1',
      description: null,
      questions: [
        text(FIRST, 'Vorname'),
        {
          id: INFO,
          label: 'Hinweis',
          hint: null,
          required: false,
          width: 'full',
          type: 'info',
        },
        text(MIDDLE, 'Anreise'),
      ],
    },
    {
      id: PAGE_B,
      title: 'Seite 2',
      description: null,
      questions: [text(LAST, 'Kennzeichen')],
    },
  ];
}

function labelsFor(questionId: string): string[] {
  return earlierConditionSources(pages(), questionId).map(
    (question) => question.label,
  );
}

describe('earlierConditionSources', () => {
  it('offers every eligible question before it, across pages', () => {
    expect(labelsFor(LAST)).toStrictEqual(['Vorname', 'Anreise']);
  });

  it('offers nothing to the first question, and never the Infotext', () => {
    expect(labelsFor(FIRST)).toStrictEqual([]);
    expect(labelsFor(MIDDLE)).toStrictEqual(['Vorname']);
  });

  it('offers nothing for a question the document does not contain', () => {
    // The fallback used to be „alle" — which handed out the questions *behind*
    // the one being edited, the one state the picklist exists to prevent.
    expect(labelsFor(UNKNOWN)).toStrictEqual([]);
  });
});
