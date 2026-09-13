import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Cascade } from '../../test/css-cascade';
import { SettingsSaveBar } from './SettingsSaveBar';

/**
 * **In a card the bar stands on the same alignment line as the fields
 * above it** (review finding).
 *
 * It brings no gutter of its own — the surroundings give that. In the
 * `.settings` column that is the column's gutter; if it stands *in* a
 * card, by contrast, it is a sibling of `.settings-card__body` and not its child,
 * and only the body has padding. „Speichern" therefore stuck to the card edge in
 * four cards.
 *
 * What is measured is the **edge**, not the class name: the left edge of the bar
 * against the left edge of the card body. Whoever writes the rule differently in
 * future — on the card, on the bar, with other tokens — stays green
 * as long as field and button line up. Whoever removes it does not.
 *
 * For that, `Cascade` evaluates `settings-view.css` on the rendered tree;
 * jsdom itself knows neither the file nor `var(--space-7)`.
 */
const styles = Cascade.fromFile('src/views/settings-view.css');

function saveBar(): HTMLElement {
  const button = screen.getByRole('button', { name: 'Speichern' });
  const bar = button.parentElement;
  if (bar === null) {
    throw new Error('Die Leiste hat kein Elternelement.');
  }
  return bar;
}

describe('SettingsSaveBar', () => {
  it('sitzt in einer Karte auf der Fluchtlinie des Kartenkörpers', () => {
    render(
      <section className="settings-card">
        <div className="settings-card__body" data-testid="body" />
        <SettingsSaveBar isSaving={false} dirty onSave={() => undefined} />
        <p className="settings__alert" data-testid="alert" role="alert">
          Das Speichern ist fehlgeschlagen.
        </p>
      </section>,
    );

    const body = screen.getByTestId('body');
    const gutter = styles.pixels(body, 'padding-left');
    // A floor under the measurement: without a gutter on the body the test would compare two
    // zeroes and would be green even if both stuck to the edge.
    expect(gutter).toBeGreaterThan(0);

    const bar = saveBar();
    expect(styles.pixels(bar, 'padding-left')).toBe(gutter);
    expect(styles.pixels(bar, 'padding-right')).toBe(gutter);
    // And at the bottom it does not sit on the card edge.
    expect(styles.pixels(bar, 'padding-bottom')).toBeGreaterThan(0);

    // The error message directly below it is the same case — as a box it has
    // padding of its own, so its distance to the card edge is a
    // margin.
    const alert = screen.getByTestId('alert');
    expect(styles.pixels(alert, 'margin-left')).toBe(gutter);
    expect(styles.pixels(alert, 'margin-right')).toBe(gutter);
  });

  it('bringt außerhalb einer Karte keinen eigenen Rand mit', () => {
    // The counter-check: in the column the column carries the gutter. Padding
    // on the bar itself would indent the button there a second time — exactly
    // the reason why the rule hangs on the card and not on the bar.
    render(
      <div className="settings">
        <SettingsSaveBar isSaving={false} dirty onSave={() => undefined} />
      </div>,
    );

    expect(styles.pixels(saveBar(), 'padding-left')).toBeUndefined();
  });
});
