import type { MailTemplateContext } from '@formsache/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NotificationPreview } from './NotificationPreview';

/**
 * The HTML preview switched from showing `renderMailTemplate`'s output as
 * *source* (a `<pre>`) to showing it *rendered* (an `<iframe srcdoc>`), so an
 * editor can see what the recipient's mail client would show rather than the
 * `<table…>` markup that produces it.
 *
 * **What jsdom can and cannot tell us.** jsdom does not execute the content of
 * an `srcdoc` iframe — there is no nested document to inspect, so these tests
 * assert the `srcDoc`/`sandbox` *attributes* the component hands to the real
 * browser, not what ends up on screen. Whether a browser actually renders that
 * markup (and scrolls it inside a fixed-height frame) is for `e2e-tester` to
 * cover with Playwright, not something a component test can promise.
 */

const CONTEXT: MailTemplateContext = {
  formularorganisation: 'Alte Breslauer Verein',
  formular: 'Bestandsmeldung',
  datum: '01.03.2026',
  answers: [
    {
      questionId: '019fe600-0000-7000-8000-0000000000c1',
      label: 'Anmerkung',
      value: '<img src=x onerror=alert(1)>',
    },
  ],
  // Nothing changed — these cases are about the sandbox, not about
  // `{{aenderungen}}` (its own rendering is proven in `@formsache/shared`).
  changes: [],
};

function renderPreview(format: 'html' | 'text') {
  render(
    <NotificationPreview
      subject="Bestätigung {{formular}}"
      body="Hallo, {{antworten}}"
      format={format}
      recipients={[]}
      context={CONTEXT}
      toSubmitter={false}
    />,
  );
}

describe('NotificationPreview', () => {
  it('renders the HTML body as a sandboxed iframe, not as markup on the page', () => {
    renderPreview('html');

    const frame = screen.getByTestId('preview-body-frame');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('title')).toBeTruthy();
    // The load-bearing property of this component: an empty sandbox. Both
    // `allow-scripts` and `allow-same-origin` would let the previewed mail
    // reach back into the application; see the component's comment for why.
    expect(frame.getAttribute('sandbox')).toBe('');

    // The mail's markup must never land in the application's own DOM as an
    // *element* outside the iframe boundary — that would be exactly the
    // `dangerouslySetInnerHTML` mistake this component exists to avoid. It is
    // fine to find `<table` inside the `srcdoc` *attribute string* below (that
    // is the point of `srcdoc`); what must not exist is an actual `<table>`
    // node in the surrounding document.
    expect(document.querySelector('table')).toBeNull();
  });

  it('keeps the text format as a plain <pre>, unchanged', () => {
    renderPreview('text');

    expect(screen.queryByTestId('preview-body-frame')).toBeNull();
    const pre = screen.getByTestId('preview-body');
    expect(pre.tagName).toBe('PRE');
  });

  it('hands the iframe an escaped answer, not the raw markup a stranger typed', () => {
    renderPreview('html');

    const frame = screen.getByTestId('preview-body-frame');
    const srcDoc = frame.getAttribute('srcdoc') ?? '';

    // `renderMailTemplate` escapes answer values for the HTML format
    // ; this asserts that escaping still reaches the iframe
    // unchanged rather than being bypassed on the way into `srcDoc`.
    expect(srcDoc).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(srcDoc).not.toContain('<img src=x onerror=alert(1)>');
  });
});
