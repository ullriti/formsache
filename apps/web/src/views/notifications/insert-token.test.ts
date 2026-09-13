import { describe, expect, it } from 'vitest';

import { insertToken } from './insert-token';

/**
 * The arithmetic of „Platzhalter an der Cursorposition einfügen" — **on strings, without a DOM** .
 *
 * Every case below is one a browser can produce and jsdom cannot be trusted
 * about: a caret in the middle of a word, a selection being replaced, a field
 * that was never focused. Testing them here is what makes the jsdom test next
 * door able to be honest about the one thing it *can* show — that the click
 * reaches this function with the right arguments.
 */

const TOKEN = '{{frage:019f}}';

describe('insertToken', () => {
  it('inserts at a collapsed caret and puts the cursor behind the token', () => {
    const result = insertToken('Hallo Welt', { start: 6, end: 6 }, TOKEN);

    expect(result.text).toBe(`Hallo ${TOKEN}Welt`);
    // Behind the token, not in front of it and not selecting it: the next
    // keystroke has to continue the sentence.
    expect(result.cursor).toBe(6 + TOKEN.length);
    expect(result.text.slice(result.cursor)).toBe('Welt');
  });

  it('appends at the end of the text', () => {
    const result = insertToken('Hallo', { start: 5, end: 5 }, TOKEN);

    expect(result.text).toBe(`Hallo${TOKEN}`);
    expect(result.cursor).toBe(result.text.length);
  });

  it('inserts at the very start', () => {
    const result = insertToken('Hallo', { start: 0, end: 0 }, TOKEN);

    expect(result.text).toBe(`${TOKEN}Hallo`);
    expect(result.cursor).toBe(TOKEN.length);
  });

  it('writes into an empty field', () => {
    expect(insertToken('', { start: 0, end: 0 }, TOKEN)).toEqual({
      text: TOKEN,
      cursor: TOKEN.length,
    });
  });

  /**
   * The case that makes the chips usable for a *correction*: select the wrong
   * placeholder, click the right chip. Appending instead would leave both in
   * the text, and the leftover is the one nobody notices until the mail is out.
   */
  it('replaces a selection instead of appending to it', () => {
    const text = 'Hallo {{frage:alt}}, willkommen';
    const result = insertToken(text, { start: 6, end: 19 }, TOKEN);

    expect(result.text).toBe(`Hallo ${TOKEN}, willkommen`);
    expect(result.text).not.toContain('{{frage:alt}}');
    expect(result.cursor).toBe(6 + TOKEN.length);
  });

  it('puts a reversed selection back in order', () => {
    const forwards = insertToken('Hallo Welt', { start: 0, end: 5 }, TOKEN);
    const backwards = insertToken('Hallo Welt', { start: 5, end: 0 }, TOKEN);

    expect(backwards).toEqual(forwards);
  });

  /**
   * A field that was never focused hands out no usable selection, and the two
   * numbers are read off an element that may have re-rendered since the click.
   * „Irgendwas mit NaN" must not become a text field that silently loses its
   * content — every one of these keeps the original text intact.
   */
  it.each([
    ['past the end', { start: 99, end: 99 }],
    ['negative', { start: -4, end: -1 }],
    ['not a number', { start: Number.NaN, end: Number.NaN }],
  ])('survives an out-of-range selection (%s)', (_name, selection) => {
    const result = insertToken('Hallo', selection, TOKEN);

    expect(result.text).toContain('Hallo');
    expect(result.text).toContain(TOKEN);
    expect(result.text).toHaveLength('Hallo'.length + TOKEN.length);
    expect(result.cursor).toBeGreaterThanOrEqual(0);
    expect(result.cursor).toBeLessThanOrEqual(result.text.length);
  });

  it('leaves the text unchanged apart from the token', () => {
    const text = 'Guten Tag {{formularorganisation}}, Ihre Anmeldung ist da.';
    const result = insertToken(text, { start: 10, end: 10 }, TOKEN);

    // What was there before is still there — the insertion adds, it does not
    // rewrite. A sanity check that would catch a slice with a swapped bound.
    expect(result.text.replace(TOKEN, '')).toBe(text);
  });
});
