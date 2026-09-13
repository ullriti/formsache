import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  HONEYPOT_INPUT_NAME,
  HONEYPOT_TEST_ID,
  HoneypotField,
} from './HoneypotField';

/**
 * The requirement — the half of „stört keine Bedienhilfe" that jsdom can see.
 *
 * **What is deliberately not asserted here is anything about looks.** jsdom
 * loads no stylesheet, computes no layout and knows no tab order, so
 * „unsichtbar" and „die Tab-Reihenfolge überspringt es" cannot be measured in
 * this file — asserting them here would produce two green tests that stay green
 * when the rule is removed. That is the mistake the dead zone in the middle of
 * every settings switch cost this project: six green cases, and not one
 * of them had ever clicked the control. Both live in
 * `e2e/public-form-honeypot.spec.ts`, in a real browser.
 *
 * What *is* measurable here is the accessibility tree, and that is the point of
 * the file: the field must not exist for a screen reader at all.
 */
describe('HoneypotField ', () => {
  function field(): HTMLElement {
    return screen.getByTestId(HONEYPOT_TEST_ID);
  }

  function renderField(): void {
    render(<HoneypotField value="" onChange={vi.fn()} />);
  }

  /**
   * The load-bearing one. `getByRole` skips what `aria-hidden` removed from the
   * accessibility tree, so this line goes red the moment the attribute does —
   * which is the reversal the requirement names.
   */
  it('does not exist as a text box for assistive technology', () => {
    renderField();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(field().getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * `aria-hidden` on something reachable by keyboard is the ARIA error „hidden
   * but focusable" — a field a screen-reader user can tab into and be told
   * nothing about. The two attributes are only correct together, so they are
   * asserted together.
   */
  it('is out of the tab order, which is what makes hiding it legitimate', () => {
    renderField();
    expect(field().getAttribute('tabindex')).toBe('-1');
  });

  /** No label, no `aria-label`, no `placeholder`, no `title`: nothing to read out. */
  it('carries no accessible name of any kind', () => {
    renderField();
    for (const attribute of [
      'aria-label',
      'aria-labelledby',
      'placeholder',
      'title',
    ]) {
      expect(field().getAttribute(attribute)).toBeNull();
    }
    expect(screen.queryByText(HONEYPOT_INPUT_NAME)).toBeNull();
  });

  /**
   * The bait is not the contract. `website` is what an automated filler reads;
   * `honeypot` is what the request calls the value
   * (`packages/shared/src/public-form.ts`). Naming the input after the trap
   * would tell a scraper exactly which field to leave alone.
   */
  it('is named for the bait, not for the wire', () => {
    renderField();
    expect(field().getAttribute('name')).toBe(HONEYPOT_INPUT_NAME);
    expect(HONEYPOT_INPUT_NAME).not.toBe('honeypot');
  });

  /**
   * Not `display: none`, which is the one form of hiding an automated filler is
   * likely to look for — the hiding is a zero-size box in
   * `public-form-view.css`, and the class is the only thing this file can see of
   * it. What that class actually does is measured in the browser.
   */
  it('leaves the hiding to the stylesheet rather than to an inline style', () => {
    renderField();
    expect(field().className).toBe('public__honeypot');
    expect(field().getAttribute('style')).toBeNull();
    expect(field().hasAttribute('hidden')).toBe(false);
  });

  it('reports what was written into it', () => {
    const onChange = vi.fn();
    render(<HoneypotField value="" onChange={onChange} />);
    fireEvent.change(field(), {
      target: { value: 'https://spam.example' },
    });
    expect(onChange).toHaveBeenCalledWith('https://spam.example');
  });

  it('offers no autofill target to a password manager', () => {
    renderField();
    expect(field().getAttribute('autocomplete')).toBe('off');
  });
});
