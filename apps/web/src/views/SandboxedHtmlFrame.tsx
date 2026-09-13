import type { ReactElement } from 'react';

/**
 * The one way this application shows a rendered HTML mail on screen — pulled
 * out of `notifications/NotificationPreview.tsx` when the mail log's
 * detail view („Die gerenderte Mail ansehen") needed the exact same
 * thing a second time.
 *
 * **Why a shared component and not a second `<iframe>`.** This project has
 * paid for that duplication four times over (`CONTRIBUTING.md`); the property
 * that makes this element safe — `sandbox=""`, never `dangerouslySetInnerHTML`
 * — is exactly the kind of thing a second, independently written copy drifts
 * on first. Centralising it means there is one place to get `sandbox` right,
 * not two to keep in step.
 *
 * `sandbox` is **not** a prop, on purpose. Both current callers show mail
 * markup an administrator wrote and a stranger's answers filled in — content
 * this application does not execute or read back from, ever — and a prop
 * would let a future caller widen it "just this once". If a caller ever needs
 * `allow-scripts` or `allow-same-origin`, that caller needs a different
 * component, not this one with a wider sandbox.
 *
 * No auto-sizing for the same reason `NotificationPreview` never had one: an
 * empty sandbox gives the iframe's document an opaque origin, so
 * `contentDocument` cannot be read from here to measure it. The caller sizes
 * the frame with `className` (a fixed height, content scrolls inside).
 */
export function SandboxedHtmlFrame({
  html,
  title,
  className,
  testId,
}: {
  /** Goes into `srcdoc` — never into the surrounding document. */
  readonly html: string;
  readonly title: string;
  readonly className: string;
  readonly testId?: string;
}): ReactElement {
  return (
    <iframe
      className={className}
      data-testid={testId}
      title={title}
      srcDoc={html}
      sandbox=""
    />
  );
}
