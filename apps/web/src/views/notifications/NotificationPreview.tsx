import type { ReactElement, ReactNode } from 'react';
import {
  renderMailSubject,
  renderMailTemplate,
  resolveRecipients,
  responseEditPath,
  unknownPlaceholders,
  type EditLinkSlot,
  type MailFormat,
  type MailTemplateContext,
  type NotificationRecipient,
} from '@formsache/shared';

import { SandboxedHtmlFrame } from '../SandboxedHtmlFrame';

/**
 * The preview with example data.
 *
 * ## Why the HTML body is shown *rendered*, and never via `dangerouslySetInnerHTML`
 *
 * The body mixes an administrator's template with values a stranger typed into
 * a public form; `renderMailTemplate` escapes those values, and
 * an editor reading raw `<table…>` markup instead of a mail cannot tell whether
 * that escaping held — the very thing a preview exists to show. So the HTML
 * format is rendered as a mail client would render it, through
 * `SandboxedHtmlFrame` (`../SandboxedHtmlFrame.tsx`) — an
 * `<iframe srcdoc sandbox="">`. `dangerouslySetInnerHTML` is not an option
 * regardless of formatting: it would put the mail's markup into the
 * *application's* document, the one place this project has ruled out for user
 * content (`CONTRIBUTING.md`) — the iframe is a document of its own,
 * with its own opaque origin, and that boundary is the whole point.
 *
 * `sandbox=""` — not `sandbox="allow-scripts"`, not `allow-same-origin` — is
 * deliberate and load-bearing; `SandboxedHtmlFrame` says why and does not take
 * it as a prop, so nothing here can widen it. The text format stays a `<pre>`:
 * there is no markup to render, an escaped answer is exactly what a
 * plain-text mail client would show.
 *
 * The mail log's detail view (`../MailLogView.tsx`) shows a real,
 * already-frozen mail body the same way — through the same component, not a
 * second `<iframe>`.
 */

/**
 * What `{{bearbeiten}}` shows here — an **example** address.
 *
 * Assembled from `window.location.origin`, which is exactly right in a browser
 * that is standing on the address and exactly wrong in a mail; the server
 * builds the real one from `PUBLIC_BASE_URL` (`PublicUrlService`).
 * The token is spelled out as an example, like every other value in this
 * preview, so nobody copies it out of the screen expecting it to open anything.
 *
 * Shown as a link even for a form with „Bearbeiten nach dem Absenden" switched
 * off: the preview renders a *template*, and whether a link exists is decided
 * per answer when the mail goes out. The note below the preview says so.
 */
function sampleEditLink(): EditLinkSlot {
  return {
    kind: 'resolved',
    url: `${window.location.origin}${responseEditPath('BEISPIEL-TOKEN')}`,
  };
}

/**
 * The default note: **example data**, because the editor shows a
 * *template* and the values in it are invented (`sample-context.ts`).
 *
 * As a value of its own and not fixed in the body, since the Testmodus uses the same
 * preview: there the values of the trial run stand
 * in it, not invented ones, and the same sentence would then simply be wrong. What
 * is shared is what really makes up this component — the
 * escaping and the `sandbox=""` frame underneath —, not the caption.
 */
const SAMPLE_DATA_NOTE = (
  <>
    Mit Beispieldaten – nicht mit echten Antworten. Der Bearbeiten-Link bleibt
    leer, wenn das Formular kein Bearbeiten nach dem Absenden erlaubt.{' '}
    {/*
      The same promise the link gets, for the same reason: the preview
      renders a *template*, and whether `{{aenderungen}}` has anything to
      say is decided per mail, by the trigger that set it off. Shown filled
      in above (`sampleContext`) so the shape is visible; said here so
      „bei Absendung ist es leer" is not something an editor has to find
      out from a sent mail. Named as the trigger's own caption („Bei
      Absendung"), because that is the checkbox this sentence is about.
    */}
    Die Änderungen bleiben leer, wenn die E-Mail durch „Bei Absendung" ausgelöst
    wird – sie zeigen nur, was eine Bearbeitung geändert hat.
  </>
);

export interface NotificationPreviewProps {
  readonly subject: string;
  readonly body: string;
  readonly format: MailFormat;
  readonly recipients: readonly NotificationRecipient[];
  readonly context: MailTemplateContext;
  /** Whether the participant copy would go out at all — see `SettingsView`. */
  readonly toSubmitter: boolean;
  /** The heading of the preview; „Vorschau" when nothing is said. */
  readonly heading?: string;
  /** The sentence under the heading — see {@link SAMPLE_DATA_NOTE}. */
  readonly note?: ReactNode;
}

export function NotificationPreview({
  subject,
  body,
  format,
  recipients,
  context,
  toSubmitter,
  heading = 'Vorschau',
  note = SAMPLE_DATA_NOTE,
}: NotificationPreviewProps): ReactElement {
  const knownIds = context.answers.map((answer) => answer.questionId);
  const unknown = [
    ...new Set([
      ...unknownPlaceholders(subject, knownIds),
      ...unknownPlaceholders(body, knownIds),
    ]),
  ];

  const resolved = resolveRecipients(recipients, context);
  const renderedSubject = renderMailSubject({ template: subject, context });
  const renderedBody = renderMailTemplate({
    template: body,
    format,
    context,
    editLink: sampleEditLink(),
  });

  return (
    <section className="notifications__preview" aria-label={heading}>
      <div className="notifications__preview-head">
        <h3 className="notifications__preview-title">{heading}</h3>
        <p className="notifications__preview-note">{note}</p>
      </div>

      {unknown.length > 0 ? (
        /*
          The requirement no. 4: an unknown placeholder stays in the mail exactly
          as written, so this is the only place it can be noticed before it is
          sent. Named individually — „irgendwo steht ein unbekannter
          Platzhalter" is not something anyone can act on.
        */
        <p className="notifications__preview-warning" role="status">
          Unbekannte Platzhalter bleiben unverändert in der E-Mail stehen:{' '}
          {unknown.join(', ')}
        </p>
      ) : null}

      <dl className="notifications__preview-fields">
        <dt>Empfänger</dt>
        <dd data-testid="preview-recipients">
          {resolved.addresses.length === 0
            ? 'keine – so geht keine E-Mail heraus'
            : resolved.addresses.join(', ')}
          {toSubmitter ? ' (Kopie an die ausfüllende Person)' : ''}
        </dd>
        <dt>Betreff</dt>
        <dd data-testid="preview-subject">{renderedSubject}</dd>
      </dl>

      {format === 'html' ? (
        // `SandboxedHtmlFrame` is the shared, load-bearing part — `srcdoc`,
        // an empty `sandbox`, no `dangerouslySetInnerHTML` (its own comment
        // says why). No auto-sizing here either, for the reason repeated
        // there: a fixed height from `--notifications-preview-iframe-height`
        // below, content scrolls.
        <SandboxedHtmlFrame
          className="notifications__preview-body notifications__preview-body-frame"
          testId="preview-body-frame"
          title="Vorschau der E-Mail (HTML, gerendert)"
          html={renderedBody}
        />
      ) : (
        // `<pre>` and text content: the rendered mail shown verbatim, which
        // for the text format is exactly what the recipient's mail client
        // receives, escaping included.
        <pre className="notifications__preview-body" data-testid="preview-body">
          {renderedBody}
        </pre>
      )}
    </section>
  );
}
