import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

/**
 * **The two properties of the frame that no guard sees any more.**
 *
 * `sandbox=""` already had an assertion (`MailLogView.test.tsx`), `title`
 * had none — it hung on the axe run. Since `scan.ts` excludes
 * `iframe[sandbox]`, it hangs on nothing at all any more: the exclusion takes
 * the frame **itself** out with it, not only its content.
 *
 * That is measured and not conjectured. On 2026-08-12, on the real path:
 * `title` removed from this component, `pnpm e2e --grep "Benachrichtigungen|E-Mail
 * ansehen"` → **all green**, although `frame-title` is a *serious* rule and
 * both views show such a frame. Before, axe would have reported them.
 *
 * This file is the replacement for that — and it stands at the **component**
 * instead of at its two callers, because there the third caller is checked
 * along with them, the one that does not exist yet.
 *
 * *Counter-check:* remove `title={title}` from `SandboxedHtmlFrame.tsx` → the
 * first case turns red.
 */
describe('SandboxedHtmlFrame', () => {
  function frameOf(html: string, title: string): HTMLElement {
    const { container } = render(
      <SandboxedHtmlFrame html={html} title={title} className="probe" />,
    );
    const frame = container.querySelector('iframe');
    if (frame === null) {
      throw new Error('Kein <iframe> gerendert.');
    }
    return frame;
  }

  it('trägt den zugänglichen Namen, den der Aufrufer nennt (WCAG 4.1.2)', () => {
    const frame = frameOf('<p>Rumpf</p>', 'Vorschau der E-Mail');
    // A frame without a name is, for a screen reader, a region without
    // information about what stands in it — axe therefore classifies
    // `frame-title` as *serious*.
    expect(frame.getAttribute('title')).toBe('Vorschau der E-Mail');
  });

  it('bleibt ein leerer `sandbox` — kein `allow-scripts`, kein `allow-same-origin`', () => {
    const frame = frameOf('<script>alert(1)</script>', 'Vorschau');
    expect(frame.getAttribute('sandbox')).toBe('');
  });

  it('reicht die Markup-Zeichenkette über `srcdoc` hinein, nie ins umgebende Dokument', () => {
    const html = '<p>Hallo <b>Welt</b></p>';
    const frame = frameOf(html, 'Vorschau');
    expect(frame.getAttribute('srcdoc')).toBe(html);
    /*
      And not beside it: a `dangerouslySetInnerHTML` at this place would be
      exactly the way by which foreign markup gets into *this* document.

      What is checked is the **element**, not the string. The first attempt
      compared `document.body.innerHTML` against `'<b>Welt</b>'` and was red,
      although nothing was wrong: the markup stands there as the value of the
      `srcdoc` attribute, and a text search cannot tell an attribute value and
      a parsed element apart. `querySelector` can.
    */
    expect(document.querySelector('b')).toBeNull();
  });
});
