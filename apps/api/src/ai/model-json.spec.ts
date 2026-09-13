import { describe, expect, it } from 'vitest';

import { parseModelJson } from './model-json';

/**
 * The one place a model's text becomes `unknown` — shared by both adapters,
 * which is what makes the `invalid_output` row of the contract table mean the
 * same thing in both columns.
 */
describe('parseModelJson', () => {
  it('parses a bare JSON document', () => {
    expect(parseModelJson('{"title":"Rückmeldung"}')).toEqual({
      ok: true,
      value: { title: 'Rückmeldung' },
    });
  });

  it.each([
    ['```json\n{"a":1}\n```', 'a fenced block with a language tag'],
    ['```\n{"a":1}\n```', 'a fenced block without one'],
    ['  \n```json\n{"a":1}\n```  \n', 'a fenced block with stray whitespace'],
  ])('peels %s (%s)', (text) => {
    expect(parseModelJson(text)).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each([
    ['', 'nothing at all'],
    ['Gern! Hier ist dein Formular:', 'prose'],
    ['{"title":"Rückmel', 'an answer cut off mid-token'],
    ['```', 'a lone fence'],
    ['```json\n{"a":1}', 'a fence that never closes'],
  ])('rejects %s (%s)', (text) => {
    expect(parseModelJson(text)).toEqual({ ok: false });
  });

  /**
   * A scalar is valid JSON and therefore parses. It is **not** rejected here
   * on purpose: whether a draft is a form is decided by `formSchema` in
   * `adoptAiFormDraft`, against the full schema including every refinement. Two
   * places that judge a draft is exactly the doubling this project has paid
   * for at four other spots.
   */
  it('accepts any valid JSON — judging the draft belongs to formSchema', () => {
    expect(parseModelJson('42')).toEqual({ ok: true, value: 42 });
    expect(parseModelJson('null')).toEqual({ ok: true, value: null });
  });

  /**
   * The one shape the peeling must not touch: text that merely *starts* with
   * a fence-looking line. Reassembling text is how a partial answer turns
   * into a document that parses — and a document that parses is a form the
   * editor is asked to accept.
   */
  it('leaves a fence-looking opener with content on it alone', () => {
    expect(parseModelJson('```json and then prose\n{"a":1}\n```')).toEqual({
      ok: false,
    });
  });
});
