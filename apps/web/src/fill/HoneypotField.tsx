import type { ReactElement } from 'react';

/**
 * The decoy field of the requirement — the bait, and nothing else.
 *
 * **It decides nothing.** What a filled decoy costs is decided on the server
 * (`apps/api/src/public/honeypot.ts`), and what it costs is a *mail*, never the
 * registration: „er unterdrückt die Mail, nicht die Anmeldung". This component
 * renders an input and hands its value up; a browser that never sends it is an
 * ordinary browser.
 *
 * **The name in the DOM is not the name on the wire.** `website` is what an
 * automated form filler sees and recognises as worth filling; `honeypot` is what
 * the request calls it, because a contract is read by people who need to know
 * what a field is for. The mapping happens in `FillIn` → `useSubmitResponse`,
 * costs nothing, and keeps the bait from having to be honest.
 *
 * **Three promises, all of them negative** — this is a measure that can never
 * prove it works, only that it does no harm:
 *
 * 1. *Not focusable.* `tabIndex={-1}`, so tabbing through the form steps from
 *    the last question straight to the button. Proved in `e2e/`, not here:
 *    jsdom has no tab order.
 * 2. *Not announced.* `aria-hidden`, no `<label>`, no `aria-label`, no
 *    `placeholder`, no `title` — there is no accessible name to read out,
 *    which is the only state in which a hidden field is not a trap for somebody
 *    using a screen reader. `aria-hidden` on a focusable element would be the
 *    ARIA error „hidden but reachable"; point 1 is what makes it correct here.
 * 3. *Not visible.* A zero-size, transparent box (`.public__honeypot`) —
 *    deliberately **not** `display: none`, which is the one form of hiding an
 *    automated filler is likely to check for. Proved in the browser, for the
 *    same reason as point 1: jsdom computes no layout.
 *
 * `autoComplete="off"` is the one concession to the false-alarm side. A
 * password manager filling a hidden field is a real case and the reason nothing
 * here discards an answer — but there is no reason to invite it.
 */

/** What the input calls itself in the DOM — the bait, see above. */
export const HONEYPOT_INPUT_NAME = 'website';

/** Stable handle for the tests that have to find a field with no name. */
export const HONEYPOT_TEST_ID = 'public-honeypot';

export function HoneypotField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <input
      className="public__honeypot"
      data-testid={HONEYPOT_TEST_ID}
      type="text"
      name={HONEYPOT_INPUT_NAME}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      tabIndex={-1}
      aria-hidden="true"
      autoComplete="off"
    />
  );
}
