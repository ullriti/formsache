import type { ReactElement, ReactNode } from 'react';

import { navigate } from '../../router/use-route';

import './open-items.css';

/**
 * **Open items of a setup — the shared construction** (ADR-0022,
 * continuation 2026-08-18; ADR-0025).
 *
 * There are two wizards, hence two lists: the one of the installation
 * (`views/system-settings/open-items.ts`, shown in the system administration)
 * and the one of an organisation (`views/tenant-setup/open-items.ts`, shown on
 * its dashboard). What distinguishes them are the questions they put to the
 * state — and exactly those stand in the two derivation modules. What they
 * have in common stands here: the item itself and what it looks like.
 *
 * ## The one rule this type enforces
 *
 * `consequence` is a **mandatory field**, like `consequence` on the step of
 * the wizard (`wizard/WizardFrame.tsx`) — for the same reason. An open
 * item without the sentence saying what does not work without it is a line one
 * reads past; and a list carrying such lines is a list one
 * reads past entirely — and then the mail server stands on it too.
 *
 * ## What does **not** belong here
 *
 * The derivation. This file knows no setting, no document and no
 * route; it is given finished items. A shared core that also knew
 * *when* an item is open would be the one list with a parameter
 * for the other.
 */

export interface OpenItem {
  readonly key: string;
  readonly title: string;
  /** What does not work without this item — one sentence. */
  readonly consequence: string;
  /** Where the jump link leads. */
  readonly path: string;
  /** What the jump link is called. */
  readonly action: string;
}

export interface OpenItemsListProps {
  /** The heading of the box — both lists name their subject. */
  readonly heading: string;
  /** The id of the heading, for `aria-labelledby`. */
  readonly headingId: string;
  /** One sentence below it: how this list knows what it shows. */
  readonly intro: ReactNode;
  readonly items: readonly OpenItem[];
  /**
   * Was **unter** der Liste steht — oder nichts (Review-Runde 3 Nr. 7).
   *
   * Es gibt genau einen Anlass: die Einladung in den Einrichtungsassistenten
   * auf dem Dashboard einer neuen Organisation. Sie stand bis dahin in einer
   * **zweiten, abgeschriebenen** Liste, und in der fehlte je Punkt der
   * Sprungknopf — man kam nur „von vorn" in den Assistenten, obwohl in der
   * Zeile stand, welche Einstellung fehlt. Genau das war der Befund.
   */
  readonly footer?: ReactNode;
}

/**
 * The box, or **nothing**.
 *
 * If nothing is open, the list is gone and not „✓ alles erledigt": a
 * permanent line that always says the same thing is a line one no longer
 * reads — and then the one saying something else does not stand out either.
 * The decision already stood at `SystemOpenItems` and applies to both lists.
 */
export function OpenItemsList({
  heading,
  headingId,
  intro,
  items,
  footer,
}: OpenItemsListProps): ReactElement | null {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="open-items" aria-labelledby={headingId}>
      <h2 className="open-items__heading" id={headingId}>
        {heading}
      </h2>
      <p className="open-items__intro">{intro}</p>
      <ul className="open-items__list">
        {items.map((item) => (
          <li className="open-items__item" key={item.key}>
            <div className="open-items__text">
              <p className="open-items__title">{item.title}</p>
              <p className="open-items__consequence">{item.consequence}</p>
            </div>
            <button
              type="button"
              className="settings__secondary"
              onClick={() => {
                navigate(item.path);
              }}
            >
              {item.action}
            </button>
          </li>
        ))}
      </ul>
      {footer}
    </section>
  );
}
