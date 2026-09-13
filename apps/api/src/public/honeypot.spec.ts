import { describe, expect, it } from 'vitest';

import { isHoneypotFilled } from './honeypot';

/**
 * The requirement — the rule, and only the rule.
 *
 * The *effect* of the rule (no `queued` row, a `failed` row with a readable
 * reason, the `response` row written in full) belongs to the call site in
 * the submission flow and is proved there against a database. What is provable here is
 * the one thing jsdom and Playwright cannot see and a database test would only
 * incidentally cover: which of the four ways of being empty count as
 * „ausgefüllt".
 *
 * The reversal these cases have to survive is „die reine Funktion ‚gefüllt‘ mit
 * ‚leer‘ verwechseln lassen" — flip the comparison, drop the `\S` for a length
 * check, or read `undefined` as filled, and a line below goes red.
 */
describe('isHoneypotFilled ', () => {
  /**
   * The four empties. Every one of them is an ordinary submission from an
   * ordinary participant, and reading any of them as „ausgefüllt" would cost
   * that participant their confirmation mail.
   */
  it.each([
    ['the field was not sent at all', undefined],
    ['the value was unparsable and the wire normalised it', null],
    ['the shipped client sent it empty, as it does every time', ''],
    ['a single space', ' '],
    ['several spaces', '   '],
    ['a tab and a newline', '\t\n'],
    ['a non-breaking space', '\u00a0'],
    ['a zero-width no-break space', '\ufeff'],
  ])('is not filled when %s', (_name, offered) => {
    expect(isHoneypotFilled(offered)).toBe(false);
  });

  /**
   * And the fills. `' x '` is the one that separates „enthält ein Zeichen" from
   * „ist nicht der leere String": a length check would call `'   '` filled too,
   * and a `=== ''` check would call `'   '` filled as well.
   */
  it.each([
    ['a plausible autofill value', 'https://example.com'],
    ['a single character', 'x'],
    ['a value padded with spaces', ' x '],
    ['a zero, which is a character like any other', '0'],
    ['a long dump', 'x'.repeat(10_000)],
  ])('is filled when %s', (_name, offered) => {
    expect(isHoneypotFilled(offered)).toBe(true);
  });

  it('answers a boolean and nothing else — the caller decides what it costs', () => {
    // Stated because the call site turns this into „keine Mail". A function
    // that threw, or that returned a reason string, would put the decision
    // about the *submission* in here — and the submission is never refused.
    expect(isHoneypotFilled('x')).toBe(true);
    expect(isHoneypotFilled('')).toBe(false);
  });
});
