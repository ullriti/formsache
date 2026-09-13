import { describe, expect, it } from 'vitest';

import { DEFAULT_TENANT_BRANDING } from './branding.ts';
import { MAIL_SUBJECT_MAX, questionPlaceholderToken } from './mail.ts';
import {
  DEFERRED_EDIT_LINK,
  EDIT_LINK_MARK,
  PASSWORD_RESET_LINK_MARK,
  PASSWORD_RESET_LINK_REDACTED_LABEL,
  escapeHtml,
  insertEditLink,
  insertPasswordResetLink,
  parseRecipientList,
  renderAnswerTable,
  renderChangeTable,
  renderMailSubject,
  renderMailTemplate,
  resolveRecipients,
  sanitizeSubject,
  stripMarkup,
  truncateSubject,
  unknownPlaceholders,
  wrapMailBody,
  type MailAnswerRow,
  type MailShell,
  type MailTemplateContext,
} from './mail-template.ts';

/**
 * Placeholders are an injection surface.
 *
 * **The grammar itself is proven in `mail.test.ts`**, where it is defined:
 * which six system placeholders exist, how `{{frage:<id>}}` is read and that
 * every scan starts from a fresh regular expression. What is proven here is
 * what this module adds — rendering, escaping, subject sanitising and
 * recipient resolution.
 *
 * **The values below are what a stranger types into a public form.** Each block
 * names the rule it holds down (`N…` in the stage plan) and is written so that
 * removing that rule makes it fail:
 *
 * - not `not.toContain('<script>')`, which passes as soon as *any* character is
 *   replaced, but the escaped form **positively** and the dangerous attribute
 *   **negatively** — and both again inside `{{antworten}}`, which is a render
 *   path of its own;
 * - not a subject with `\n` alone, which survives an implementation that only
 *   removes `\r`, but one with both, plus the assertion that the rest is still
 *   there — otherwise `subject.slice(0, 0)` passes too;
 * - not „no additional recipient", but the count **and** the rejection;
 * - not `not.toContain` for an unknown placeholder, but equality with the
 *   original.
 */

const VORNAME = '019ff100-0000-7000-8000-000000000001';
const NACHNAME = '019ff100-0000-7000-8000-000000000002';
const EMAIL = '019ff100-0000-7000-8000-000000000003';
const ABSENT = '019ff100-0000-7000-8000-0000000000ff';

const XSS = '<img src=x onerror=alert(1)>';

function context(
  overrides: Partial<MailTemplateContext> = {},
): MailTemplateContext {
  return {
    formularorganisation: 'Verein Beispiel',
    formular: 'Anmeldung Jahrestagung',
    datum: '28.07.2026',
    answers: [
      { questionId: VORNAME, label: 'Vorname', value: 'Max' },
      { questionId: NACHNAME, label: 'Nachname', value: 'Mustermann' },
      { questionId: EMAIL, label: 'E-Mail', value: 'max@example.de' },
    ],
    // Nothing changed unless a case says so — the state of every mail that is
    // not a correction, and the one `{{aenderungen}}` renders to nothing in.
    changes: [],
    ...overrides,
  };
}

function withAnswer(
  questionId: string,
  value: string,
  label = 'Vorname',
): MailTemplateContext {
  const answers: MailAnswerRow[] = context().answers.map((row) =>
    row.questionId === questionId ? { questionId, label, value } : row,
  );

  return context({ answers });
}

describe('escaping in HTML format', () => {
  it('escapes a malicious answer into text, positively and negatively', () => {
    const rendered = renderMailTemplate({
      template: `Hallo ${questionPlaceholderToken(VORNAME)}!`,
      format: 'html',
      context: withAnswer(VORNAME, XSS),
    });

    // Positive: the value arrives as *text*. `not.toContain('<script>')` would
    // be green the moment any single character were replaced.
    expect(rendered).toContain('&lt;img');
    // Negative: no element, and no attribute inside one, that a mail client
    // could act on.
    //
    // Spelled as „`onerror` never inside a tag" rather than
    // `not.toContain('onerror=')`: escaping neutralises the *angle brackets*,
    // so the attribute name survives as harmless text — `&lt;img src=x
    // onerror=alert(1)&gt;` is exactly the correct output, and a test demanding
    // the literal string be absent could only be satisfied by silently
    // deleting part of the answer. What must be absent is the tag context.
    expect(rendered).not.toMatch(/<[^>]*onerror/i);
    expect(rendered).not.toContain('<img');
  });

  it('escapes the same value inside {{antworten}} — its own render path', () => {
    const rendered = renderMailTemplate({
      template: '{{antworten}}',
      format: 'html',
      context: withAnswer(VORNAME, XSS),
    });

    expect(rendered).toContain('&lt;img');
    expect(rendered).not.toMatch(/<[^>]*onerror/i);
    expect(rendered).not.toContain('<img');
    // The table itself is still a table — escaping everything including our own
    // markup would „pass" the two assertions above and send an unreadable mail.
    expect(rendered).toContain('<table');
  });

  it('escapes a malicious question caption in the answer table', () => {
    const rendered = renderMailTemplate({
      template: '{{antworten}}',
      format: 'html',
      context: withAnswer(VORNAME, 'Max', XSS),
    });

    expect(rendered).toContain('&lt;img');
    expect(rendered).not.toMatch(/<[^>]*onerror/i);
  });

  it('escapes the system placeholders too — an organisation name is admin input', () => {
    const rendered = renderMailTemplate({
      template: '{{formularorganisation}} · {{formular}} · {{datum}}',
      format: 'html',
      context: context({
        formularorganisation: XSS,
        formular: XSS,
        datum: XSS,
      }),
    });

    expect(rendered).not.toContain('<img');
    expect(rendered.match(/&lt;img/g)).toHaveLength(3);
  });

  it('escapes ampersands once, not twice', () => {
    expect(escapeHtml('Katz & Hund <b>')).toBe('Katz &amp; Hund &lt;b&gt;');
    expect(escapeHtml('a & b')).not.toContain('&amp;amp;');
  });

  it('escapes quotes, so a placeholder in an attribute cannot break out', () => {
    expect(escapeHtml(`" onmouseover='x'`)).toBe(
      '&quot; onmouseover=&#39;x&#39;',
    );
  });

  /**
   * A review finding: the template editor is a plain textarea, so the paragraphs
   * an administrator types are real `\n` — and HTML folds those away. What
   * arrived was „… geändert werden: ⟨Link⟩ Mit freundlichen Grüßen
   * Dachorganisation", all on one line, while the
   * `text/plain` alternative of the very same mail was correct.
   */
  describe('the line breaks an administrator typed', () => {
    const template =
      'Hallo {{formularorganisation}},\n\ndeine Anmeldung ist da.\n\nMit freundlichen Grüßen';

    it('become <br /> in HTML', () => {
      const rendered = renderMailTemplate({
        template,
        format: 'html',
        context: context(),
      });

      expect(rendered.match(/<br \/>/g)).toHaveLength(4);
      expect(rendered).toContain('da.<br />');
      expect(rendered).toContain('<br />\nMit freundlichen Grüßen');
    });

    it('stay real line breaks in plain text', () => {
      const rendered = renderMailTemplate({
        template,
        format: 'text',
        context: context(),
      });

      expect(rendered).not.toContain('<br');
      expect(rendered).toContain('da.\n\nMit freundlichen Grüßen');
    });

    it('do not reach into the markup of {{antworten}}', () => {
      const rendered = renderMailTemplate({
        template: 'Deine Angaben:\n{{antworten}}\nDanke.',
        format: 'html',
        context: context(),
      });

      // The table renders itself; a break between its rows or inside a cell
      // would mean the literal handling had been applied to its markup.
      //
      // Checked on `<tbody><tr>` and not on the whole `<table …>` line:
      // its attributes have been styled since `wrapMailHtml`, and an
      // assertion that goes red on every colour change checks the colour
      // instead of the property. The property is „kein `<br />` im Markup
      // dieser Tabelle", and those stand below.
      expect(rendered).toContain('<tbody><tr>');
      expect(rendered).toContain('</tbody></table>');
      expect(rendered).not.toMatch(/<br \/>\s*<\/tbody>/);
      expect(rendered).not.toMatch(/<\/tr><br \/>/);
      expect(rendered.match(/<br \/>/g)).toHaveLength(2);
    });

    it('leave the escaping of an answer value alone', () => {
      const rendered = renderMailTemplate({
        template: `Hallo ${questionPlaceholderToken(VORNAME)},\nwillkommen.`,
        format: 'html',
        context: withAnswer(VORNAME, 'Max <a href'),
      });

      // The value is still escaped, and the segment behind it — including the
      // break that was just introduced — is still there rather than swallowed
      // up to the next `>`.
      expect(rendered).toContain('Max &lt;a href');
      expect(rendered).toContain('<br />\nwillkommen.');
      expect(rendered).not.toMatch(/<a\b/);
    });
  });

  /**
   * The same finding one door further along: the *literal* segments had learnt
   * to break, a substituted **value** had not. A „Bemerkung" typed as three
   * lines into a textarea arrived through `{{frage:<id>}}` as one run-on line,
   * while the very same answer inside `{{antworten}}` broke correctly — one
   * mail rendering one value two ways.
   */
  describe('the line breaks a participant typed', () => {
    const MULTILINE = 'Zeile eins\nZeile zwei\nZeile drei';

    it('become <br /> in a substituted value, as they do in the table', () => {
      const outside = renderMailTemplate({
        template: questionPlaceholderToken(VORNAME),
        format: 'html',
        context: withAnswer(VORNAME, MULTILINE),
      });
      const inside = renderMailTemplate({
        template: '{{antworten}}',
        format: 'html',
        context: withAnswer(VORNAME, MULTILINE),
      });

      expect(outside).toBe('Zeile eins<br />Zeile zwei<br />Zeile drei');
      // The other render path, asserted separately on purpose: a fix applied to
      // one of the two has repeatedly not reached the other.
      expect(inside).toContain('Zeile eins<br />Zeile zwei<br />Zeile drei');
    });

    /**
     * **Escape first, break second.** The order is the whole safety argument:
     * reversed, a value carrying `<` would be broken into markup and only then
     * escaped — or worse, escaped around a tag this function itself inserted.
     */
    it('cannot be used to smuggle in markup', () => {
      const rendered = renderMailTemplate({
        template: questionPlaceholderToken(VORNAME),
        format: 'html',
        context: withAnswer(VORNAME, `${XSS}\nzweite Zeile`),
      });

      expect(rendered).toContain('&lt;img');
      expect(rendered).not.toContain('<img');
      expect(rendered).not.toMatch(/<[^>]*onerror/i);
      // Exactly one tag in the output, and it is the one this module wrote.
      expect(rendered.match(/<[a-z]/gi)).toHaveLength(1);
      expect(rendered).toContain('<br />zweite Zeile');
    });

    it('does not let a value spell its own <br />', () => {
      const rendered = renderMailTemplate({
        template: questionPlaceholderToken(VORNAME),
        format: 'html',
        context: withAnswer(VORNAME, 'eins<br />zwei'),
      });

      // Written by a participant, so it is text — the break belongs to the
      // newline the participant pressed, never to the characters they typed.
      expect(rendered).toBe('eins&lt;br /&gt;zwei');
    });

    it('stays a plain line break in the text alternative', () => {
      const rendered = renderMailTemplate({
        template: questionPlaceholderToken(VORNAME),
        format: 'text',
        context: withAnswer(VORNAME, MULTILINE),
      });

      expect(rendered).not.toContain('<br');
      expect(rendered).toBe(MULTILINE);
    });

    /**
     * A subject is rendered as text and then sanitised, so it never sees this
     * branch — asserted rather than assumed, because „the subject is fine" is
     * exactly the kind of claim that stops being true when a caller switches a
     * format flag.
     */
    it('never reaches the subject line as markup', () => {
      const subject = renderMailSubject({
        template: `Anmeldung von ${questionPlaceholderToken(VORNAME)}`,
        context: withAnswer(VORNAME, MULTILINE),
      });

      expect(subject).not.toContain('<br');
      expect(subject).toBe('Anmeldung von Zeile eins Zeile zwei Zeile drei');
    });
  });

  it("keeps the administrator's own markup in an HTML template", () => {
    const rendered = renderMailTemplate({
      template: '<p>Hallo {{formularorganisation}}</p>',
      format: 'html',
      context: context(),
    });

    expect(rendered).toBe('<p>Hallo Verein Beispiel</p>');
  });
});

describe('subject sanitising', () => {
  it('removes CR *and* LF and keeps the rest of the subject', () => {
    const subject = renderMailSubject({
      template: `Anmeldung von ${questionPlaceholderToken(VORNAME)}`,
      context: withAnswer(VORNAME, 'Max\r\nBcc: evil@example.com'),
    });

    // Both characters: a test with `\n` alone survives an implementation that
    // only strips `\r`.
    expect(subject).not.toContain('\r');
    expect(subject).not.toContain('\n');
    // And the rest is still there — without this, `subject.slice(0, 0)` passes.
    expect(subject).toBe('Anmeldung von Max Bcc: evil@example.com');
  });

  it('removes a lone CR and a lone LF as well', () => {
    expect(sanitizeSubject('a\rb')).toBe('a b');
    expect(sanitizeSubject('a\nb')).toBe('a b');
  });

  it('removes control characters that are neither CR nor LF', () => {
    // A filter written for CR/LF alone lets these through, and they are the
    // ones an encoder downstream may turn back into a line break.
    const subject = sanitizeSubject('Anmeldung\u0000\u0007\u001fok');

    // eslint-disable-next-line no-control-regex -- that is what is asserted.
    expect(subject).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(subject).toContain('Anmeldung');
    expect(subject).toContain('ok');
  });

  it('renders the subject as plain text — a subject is never markup', () => {
    const subject = renderMailSubject({
      template: `Anmeldung ${questionPlaceholderToken(VORNAME)}`,
      context: withAnswer(VORNAME, XSS),
    });

    expect(subject).not.toMatch(/<[a-zA-Z]/);
    expect(subject).toBe('Anmeldung');
  });

  /**
   * The limit on the **template** is not a limit on the **result**.
   *
   * `MAIL_SUBJECT_MAX` bounds what an administrator may write; what a
   * participant types into the question behind `{{frage:…}}` is bounded by that
   * question's `maxLength`, which defaults to `null`. The rendered subject
   * becomes an SMTP header and a `mail_log.subject` row, so „so lang wie die
   * Antwort" means „so lang wie das Body-Limit von 100 KiB".
   */
  it('bounds the rendered subject, not only the template', () => {
    const answer = 'a'.repeat(100_000);
    const subject = renderMailSubject({
      template: `Anmeldung ${questionPlaceholderToken(VORNAME)}`,
      context: withAnswer(VORNAME, answer),
    });

    expect(subject.length).toBeLessThanOrEqual(MAIL_SUBJECT_MAX);
    // Shortened, not emptied and not cut off silently: the beginning is what
    // the administrator wrote, and the end says that something is missing.
    expect(subject.startsWith('Anmeldung ')).toBe(true);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('leaves a subject that fits exactly as it is', () => {
    const template = 'A'.repeat(MAIL_SUBJECT_MAX);

    expect(renderMailSubject({ template, context: context() })).toBe(template);
    expect(truncateSubject(template)).toBe(template);
  });

  it('never cuts an emoji in half', () => {
    // A lone surrogate is not text any more, and an answer with an emoji is
    // enough to land on the boundary.
    const subject = truncateSubject(`${'a'.repeat(MAIL_SUBJECT_MAX - 2)}😀😀`);

    expect(subject.length).toBeLessThanOrEqual(MAIL_SUBJECT_MAX);
    // No high surrogate without its low half — that is what „cut in half" is.
    expect(subject).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(subject.endsWith('…')).toBe(true);
  });
});

describe('recipient list', () => {
  it('rejects an entry with a display name instead of creating a recipient', () => {
    const list = parseRecipientList('Max <evil@example.com>, ok@example.de');

    // The count: a bare `split(',')` would produce two addresses here.
    expect(list.addresses).toEqual(['ok@example.de']);
    expect(list.addresses).toHaveLength(1);
    // The rejection: „silently left out" is exactly what must not happen.
    expect(list.invalid).toEqual(['Max <evil@example.com>']);
  });

  it('rejects an address with an embedded comma rather than splitting it', () => {
    const list = parseRecipientList('"a,b"@example.com');

    expect(list.addresses).toHaveLength(0);
    expect(list.invalid).toHaveLength(2);
  });

  it('rejects an entry with CR/LF — an address is not a place for a header', () => {
    const list = parseRecipientList('ok@example.de\nBcc: evil@example.com');

    expect(list.addresses).toEqual(['ok@example.de']);
    expect(list.invalid).toEqual(['Bcc: evil@example.com']);
  });

  it('does not split on a semicolon but reports the entry', () => {
    const list = parseRecipientList('a@example.de;b@example.de');

    expect(list.addresses).toHaveLength(0);
    expect(list.invalid).toEqual(['a@example.de;b@example.de']);
  });

  it('accepts a plain list, lower-cases and de-duplicates it', () => {
    const list = parseRecipientList(
      ' A@example.de , b@example.de,a@example.de, ',
    );

    expect(list.addresses).toEqual(['a@example.de', 'b@example.de']);
    expect(list.invalid).toHaveLength(0);
  });

  it('skips empty entries instead of reporting them as invalid', () => {
    expect(parseRecipientList(' , ,\n')).toEqual({
      addresses: [],
      invalid: [],
    });
  });
});

describe('resolving the stored recipient list ', () => {
  it('resolves a question recipient to exactly one address', () => {
    const list = resolveRecipients(
      [
        { kind: 'question', questionId: EMAIL },
        { kind: 'literal', address: 'buero@example.de' },
      ],
      context(),
    );

    expect(list.addresses).toEqual(['max@example.de', 'buero@example.de']);
    expect(list.invalid).toHaveLength(0);
  });

  it('does not let an answer add a second recipient', () => {
    // The form is public: this is a relay, not an edge case. One entry resolves
    // to one address or to none — a value carrying a comma is one *invalid*
    // address, never two valid ones.
    const list = resolveRecipients(
      [{ kind: 'question', questionId: EMAIL }],
      withAnswer(EMAIL, 'max@example.de, victim@example.com', 'E-Mail'),
    );

    expect(list.addresses).toHaveLength(0);
    expect(list.invalid).toEqual(['max@example.de, victim@example.com']);
  });

  it('does not let an answer smuggle a header past the address either', () => {
    const list = resolveRecipients(
      [{ kind: 'question', questionId: EMAIL }],
      withAnswer(EMAIL, 'max@example.de\nBcc: victim@example.com', 'E-Mail'),
    );

    expect(list.addresses).toHaveLength(0);
    expect(list.invalid).toHaveLength(1);
  });

  it('skips a recipient whose answer resolves to nothing', () => {
    const list = resolveRecipients(
      [
        { kind: 'question', questionId: EMAIL },
        { kind: 'literal', address: 'buero@example.de' },
      ],
      withAnswer(EMAIL, '', 'E-Mail'),
    );

    expect(list.addresses).toEqual(['buero@example.de']);
    expect(list.invalid).toHaveLength(0);
  });

  it('reports an unresolvable recipient rather than mailing it', () => {
    const list = resolveRecipients(
      [{ kind: 'question', questionId: ABSENT }],
      context(),
    );

    expect(list.addresses).toHaveLength(0);
    // Reported as the token it stands for: „one address short" has to be
    // visible, not silent.
    expect(list.invalid).toEqual([questionPlaceholderToken(ABSENT)]);
  });

  it('lower-cases and de-duplicates across literal and answered recipients', () => {
    const list = resolveRecipients(
      [
        { kind: 'literal', address: 'Max@Example.de' },
        { kind: 'question', questionId: EMAIL },
      ],
      context(),
    );

    expect(list.addresses).toEqual(['max@example.de']);
  });
});

describe('unknown placeholders', () => {
  it('leaves an unknown placeholder exactly as written, in HTML', () => {
    const template = 'Hallo {{vorname}} {{nachname}}!';
    const rendered = renderMailTemplate({
      template,
      format: 'html',
      context: context(),
    });

    // Equality with the original, not `not.toContain`: turning it into empty
    // text is the variant nobody notices until the mail is out.
    expect(rendered).toBe(template);
  });

  it('leaves an unknown placeholder exactly as written, in plain text', () => {
    const template = 'Hallo {{vorname}}!';

    expect(
      renderMailTemplate({ template, format: 'text', context: context() }),
    ).toBe(template);
  });

  it('leaves a reference to a question the response does not carry', () => {
    const template = `Hallo ${questionPlaceholderToken(ABSENT)}!`;

    expect(
      renderMailTemplate({ template, format: 'html', context: context() }),
    ).toBe(template);
  });

  it('lists the placeholders a preview has to mark', () => {
    expect(
      unknownPlaceholders(
        `{{formularorganisation}} {{vorname}} {{vorname}} {{unfug}}`,
      ),
    ).toEqual(['{{vorname}}', '{{unfug}}']);
  });

  it('marks a question reference as unknown once the form is known', () => {
    expect(
      unknownPlaceholders(
        `${questionPlaceholderToken(VORNAME)} ${questionPlaceholderToken(ABSENT)}`,
        [VORNAME],
      ),
    ).toEqual([questionPlaceholderToken(ABSENT)]);
  });

  /**
   * Moved here from the grammar tests when the two placeholder modules were
   * merged: `scanPlaceholders` no longer takes the set of known ids — matching
   * a reference against the questions a form actually has is this function's
   * job, and only this one's.
   */
  it('treats a reference to a removed question as unknown when the ids are known', () => {
    expect(
      unknownPlaceholders(
        `{{formularorganisation}} ${questionPlaceholderToken(NACHNAME)} ${questionPlaceholderToken(ABSENT)}`,
        [VORNAME, NACHNAME],
      ),
    ).toEqual([questionPlaceholderToken(ABSENT)]);
  });

  it('counts every well-formed question reference as known without the ids', () => {
    // The editor's view: the form is not at hand, so a reference is taken at
    // face value. Reporting it there would mark every chip the editor inserts.
    expect(unknownPlaceholders(questionPlaceholderToken(ABSENT))).toHaveLength(
      0,
    );
  });
});

describe('plain text format', () => {
  it('sends no markup when a value carries some', () => {
    const rendered = renderMailTemplate({
      template: `Hallo ${questionPlaceholderToken(VORNAME)}, danke!`,
      format: 'text',
      context: withAnswer(VORNAME, '<b>Max</b><script>alert(1)</script>'),
    });

    // No `<` followed by a letter — the check that a mere „no <script>" misses.
    expect(rendered).not.toMatch(/<[a-zA-Z]/);
    // And the plain text is there: stripping the whole value would pass the
    // assertion above and send an empty mail.
    expect(rendered).toContain('Max');
    expect(rendered).toContain('Hallo');
    expect(rendered).toContain('danke!');
  });

  it('sends no markup inside {{antworten}} either', () => {
    const rendered = renderMailTemplate({
      template: 'Antworten:\n{{antworten}}',
      format: 'text',
      context: withAnswer(VORNAME, XSS),
    });

    expect(rendered).not.toMatch(/<[a-zA-Z]/);
    expect(rendered).toContain('Nachname: Mustermann');
  });

  it('strips markup the administrator pasted into a plain-text template', () => {
    const rendered = renderMailTemplate({
      template: '<p>Hallo {{formularorganisation}}</p>',
      format: 'text',
      context: context(),
    });

    expect(rendered).not.toMatch(/<[a-zA-Z]/);
    expect(rendered).toBe('Hallo Verein Beispiel');
  });

  it('removes an unterminated tag as well', () => {
    expect(stripMarkup('Text <script')).toBe('Text ');
  });

  /**
   * The text alternative of an HTML notification has to stay readable.
   *
   * Removing a block tag without leaving anything behind turned two paragraphs
   * into one word („HalloDanke."), and that is what a plain-text client and
   * every spam filter reading `text/plain` get to see.
   */
  it('keeps two paragraphs apart in the plain-text alternative', () => {
    const rendered = renderMailTemplate({
      template: '<p>Hallo</p><p>Danke.</p>',
      format: 'text',
      context: context(),
    });

    expect(rendered).toBe('Hallo\n\nDanke.');
    expect(rendered).not.toContain('HalloDanke');
  });

  it('turns a line break tag into a line break', () => {
    expect(stripMarkup('Hallo<br />Danke.')).toBe('Hallo\nDanke.');
    expect(stripMarkup('<li>eins</li><li>zwei</li>')).toBe('\neins\n\nzwei\n');
  });

  it('leaves nothing behind for a tag that is not a block', () => {
    // Only *structure* becomes a line break; `<b>Max</b>` is one word, and a
    // break inside it would be an invention rather than a rescue.
    expect(stripMarkup('<b>Max</b> <a href="x">hier</a>')).toBe('Max hier');
    // `<bruder>` is not `<br>` — the word boundary is what keeps them apart.
    expect(stripMarkup('<bruder>Max')).toBe('Max');
  });

  it('keeps a `<` that is not the start of a tag', () => {
    // Removing more than markup is silent data loss in a mail that is supposed
    // to reproduce an answer.
    expect(stripMarkup('Preis <5 Euro')).toBe('Preis <5 Euro');
  });

  it('cannot let one value swallow the template text behind it', () => {
    const rendered = renderMailTemplate({
      template: `${questionPlaceholderToken(VORNAME)} — Anmeldung <ok> bestätigt`,
      format: 'text',
      context: withAnswer(VORNAME, 'Max <a href'),
    });

    // Each segment is neutralised on its own; a naive strip of the assembled
    // string would eat everything up to the next `>`.
    expect(rendered).toContain('Anmeldung');
    expect(rendered).toContain('bestätigt');
    expect(rendered).not.toMatch(/<[a-zA-Z]/);
  });
});

describe('the answer table', () => {
  it('renders every answer in form order, as text', () => {
    expect(renderAnswerTable(context().answers, 'text')).toBe(
      'Vorname: Max\nNachname: Mustermann\nE-Mail: max@example.de',
    );
  });

  it('renders a table row per answer, as HTML', () => {
    const html = renderAnswerTable(context().answers, 'html');

    expect(html.match(/<tr>/g)).toHaveLength(3);
    // Caption and value stand as a pair of cells, in this order.
    // Checked on the pair and not on the attributes of the cells: since the
    // styling (`wrapMailHtml`) those are inline styles, and an assertion
    // against a colour value would be one about the colour, not about the structure.
    expect(html).toMatch(/<th[^>]*>Vorname<\/th><td[^>]*>Max<\/td>/);
    expect(html).toMatch(/<th[^>]*>E-Mail<\/th><td[^>]*>max@example\.de<\/td>/);
  });

  /**
   * **The styling is inline, or it is not there.** A `<style>` block
   * is discarded by Gmail and some webmailers; a class without a rule is
   * then nothing. The counter-check to „sieht im Browser gut aus".
   */
  it('trägt die Gestaltung inline, nie über einen <style>-Block', () => {
    const html = renderAnswerTable(context().answers, 'html');

    expect(html).not.toContain('<style');
    expect(html).not.toContain('class=');
    expect(html).toContain('style="');
  });

  it('turns a line break in a value into a break, escaped', () => {
    // Without `questionId`: the table does not read it, and its parameter has
    // been narrowed to `MailLabelledValue` since ADR-0023 — the same function
    // now also renders the test mail and the operations messages, and those have
    // no question.
    const html = renderAnswerTable(
      [{ label: 'Anmerkung', value: 'a\n<b' }],
      'html',
    );

    expect(html).toContain('a<br />&lt;b');
  });

  it('renders nothing at all when there is no answer', () => {
    expect(renderAnswerTable([], 'html')).toBe('');
    expect(renderAnswerTable([], 'text')).toBe('');
  });
});

/**
 * `{{aenderungen}}` — what an edit changed.
 *
 * **Which rows exist is not decided here** — that is `answerChanges` in
 * `apps/api/src/notifications/notification-render.ts`, and its own cases prove
 * that an unchanged answer produces none and that `other: ''` against
 * `other: null` is not a change. What is proven here is what this module adds:
 * that both values are defused on the way into the mail, in both formats, and
 * that an empty list leaves the surrounding sentence whole.
 *
 * The escaping cases carry the malicious value on **both** sides. A stranger
 * types the old value into a public form, it sits in the database, and the same
 * stranger types the new one — so „der alte Wert ist escaped" and „der neue Wert
 * ist escaped" are two claims, and a defusing pass applied to one column only
 * would pass a test that checked either alone.
 */
describe('the change table ({{aenderungen}})', () => {
  const CHANGED = [
    {
      questionId: VORNAME,
      label: 'Vorname',
      previous: 'Max',
      current: 'Moritz',
    },
  ];

  it('names the changed question with its old and its new value, as text', () => {
    const rendered = renderMailTemplate({
      template: 'Das ist neu:\n{{aenderungen}}',
      format: 'text',
      context: context({ changes: CHANGED }),
    });

    // Three lines instead of one, since finding 34: the question, then the two
    // values, each with its own word beside it and flush-aligned.
    // `Label: alt → neu` was, with two long values, one line in which one had to
    // search for the arrow.
    expect(rendered).toBe(
      'Das ist neu:\nVorname\n  Bisher: Max\n  Neu:    Moritz',
    );
    // The unchanged answers are *not* in it — otherwise this is `{{antworten}}`
    // with two columns more, and the one sentence a change mail carries is
    // buried in the rows that did not move.
    expect(rendered).not.toContain('Mustermann');
  });

  /**
   * The alignment is the purpose of the indentation and therefore an assertion
   * of its own: flush values read as a juxtaposition, offset ones as
   * two unconnected lines. *Counter-check:* remove one space from
   * `CHANGE_TEXT_PREFIX.current` → red.
   */
  it('richtet die beiden Werte im Text bündig untereinander aus', () => {
    const rendered = renderChangeTable(CHANGED, 'text');
    const [, previous, current] = rendered.split('\n');

    expect(previous?.indexOf('Max')).toBe(current?.indexOf('Moritz'));
  });

  it('trennt mehrere Änderungen durch eine Leerzeile', () => {
    const rendered = renderChangeTable(
      [
        ...CHANGED,
        {
          questionId: NACHNAME,
          label: 'Nachname',
          previous: 'Mustermann',
          current: 'Musterfrau',
        },
      ],
      'text',
    );

    // Without the blank line six lines stand indistinguishably beneath each other,
    // and „welcher Wert gehört zu welcher Frage" is a counting exercise again.
    expect(rendered).toContain('Neu:    Moritz\n\nNachname');
  });

  it('names the changed question with its old and its new value, as HTML', () => {
    const rendered = renderMailTemplate({
      template: '<p>Das ist neu:</p>{{aenderungen}}',
      format: 'html',
      context: context({ changes: CHANGED }),
    });

    expect(rendered).toContain('Vorname');
    expect(rendered).toContain('Max');
    expect(rendered).toContain('Moritz');
    expect(rendered).not.toContain('Mustermann');
  });

  /**
   * **Colour is never the only means** (WCAG 1.4.1), and in a mail that
   * is no optional extra: an inverting dark mode, a client that discards
   * colours, or a red-green weakness take away exactly this one means.
   * Each side therefore carries its word — and the old one the
   * strikethrough in addition.
   *
   * *Counter-check:* remove `CHANGE_LABELS` from `changeCard` and leave the
   * assignment to the colours alone → both of the first assertions red.
   */
  it('benennt beide Seiten in Worten, nicht nur in Farbe', () => {
    const html = renderChangeTable(CHANGED, 'html');

    expect(html).toContain('>Bisher<');
    expect(html).toContain('>Neu<');
    expect(html).toContain('line-through');
  });

  it('escapes the old and the new value alike, in HTML', () => {
    const rendered = renderMailTemplate({
      template: '{{aenderungen}}',
      format: 'html',
      context: context({
        changes: [
          {
            questionId: VORNAME,
            label: 'Vorname',
            previous: `alt ${XSS}`,
            current: `neu ${XSS}`,
          },
        ],
      }),
    });

    // Positively: both sides arrive as text…
    expect(rendered.match(/&lt;img/g)).toHaveLength(2);
    // …and negatively: no tag, and no attribute inside one.
    expect(rendered).not.toMatch(/<[^>]*onerror/i);
    expect(rendered).not.toContain('<img');
    // The table itself is still a table — escaping our own markup as well
    // would satisfy the two assertions above and send an unreadable mail.
    expect(rendered).toContain('<table');
  });

  /**
   * A finding of the 2026-07-28 review: the caption comes from the question an
   * *editor* wrote, not from a participant's answer — but it still travels
   * through `{{aenderungen}}` unescaped otherwise, and `previous`/`current`
   * being covered above proves nothing about the third value on the same row.
   */
  it('escapes the caption too, in HTML', () => {
    const rendered = renderMailTemplate({
      template: '{{aenderungen}}',
      format: 'html',
      context: context({
        changes: [
          {
            questionId: VORNAME,
            label: XSS,
            previous: 'Max',
            current: 'Moritz',
          },
        ],
      }),
    });

    expect(rendered).toContain('&lt;img');
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('<table');
  });

  it('strips markup out of the old and the new value alike, in text', () => {
    const rendered = renderMailTemplate({
      template: '{{aenderungen}}',
      format: 'text',
      context: context({
        changes: [
          {
            questionId: VORNAME,
            label: 'Vorname',
            previous: `${XSS}Max`,
            current: `${XSS}Moritz`,
          },
        ],
      }),
    });

    expect(rendered).toBe('Vorname\n  Bisher: Max\n  Neu:    Moritz');
    expect(rendered).not.toMatch(/<[a-zA-Z]/);
  });

  it('says „(leer)" for a question that was blank or has been cleared', () => {
    const rendered = renderMailTemplate({
      template: '{{aenderungen}}',
      format: 'text',
      context: context({
        changes: [
          {
            questionId: VORNAME,
            label: 'Beruf',
            previous: '',
            current: 'Jurist',
          },
          {
            questionId: NACHNAME,
            label: 'Zimmer',
            previous: 'Einzel',
            current: '',
          },
        ],
      }),
    });

    expect(rendered).toBe(
      'Beruf\n  Bisher: (leer)\n  Neu:    Jurist\n\n' +
        'Zimmer\n  Bisher: Einzel\n  Neu:    (leer)',
    );
  });

  it('renders to nothing in a mail that is not a correction, sentence intact', () => {
    const rendered = renderMailTemplate({
      template: 'Danke! {{aenderungen}} Bis bald.',
      format: 'text',
      // `changes: []` is what a submission passes (`previousAnswers: null`,
      // `mailContextOf`) — and what an edit that changed nothing passes too.
      context: context(),
    });

    // Both halves: the placeholder is gone **and** the text around it stands.
    // „Enthält den Platzhalter nicht" alone would be green for an empty mail.
    expect(rendered).toBe('Danke!  Bis bald.');
    expect(rendered).not.toContain('aenderungen');
  });

  it('renders nothing at all when nothing changed', () => {
    expect(renderChangeTable([], 'html')).toBe('');
    expect(renderChangeTable([], 'text')).toBe('');
  });
});

/**
 * `{{bearbeiten}}` — the one placeholder that is **not** resolved when the mail
 * is queued.
 *
 * The cases are written so that each of the three states fails on its own:
 * „deferred" is checked against the mark **and** against the absence of a URL,
 * „resolved" against the address and the format that carries it, and „no link"
 * both negatively (no address, no mark) and **positively** — the rest of the
 * sentence has to survive, or „resolves to nothing" would be satisfied by an
 * implementation that dropped the whole line.
 */
describe('the edit link placeholder ({{bearbeiten}})', () => {
  const TEMPLATE = 'Hallo! Ändern: {{bearbeiten}} — bis bald.';
  const URL = 'https://formulare.example/a/Abc-123_xyz';

  it('leaves a mark instead of a link when the slot is deferred', () => {
    const rendered = renderMailTemplate({
      template: TEMPLATE,
      format: 'text',
      context: context(),
      editLink: DEFERRED_EDIT_LINK,
    });

    expect(rendered).toContain(EDIT_LINK_MARK);
    // Not merely „different from the URL": nothing that looks like an address
    // may be in a body that has not been through the send step.
    expect(rendered).not.toContain('/a/');
    expect(rendered).toContain('Hallo!');
  });

  it('writes the bare address in plain text', () => {
    expect(
      renderMailTemplate({
        template: TEMPLATE,
        format: 'text',
        context: context(),
        editLink: { kind: 'resolved', url: URL },
      }),
    ).toBe(`Hallo! Ändern: ${URL} — bis bald.`);
  });

  it('writes a clickable anchor in HTML', () => {
    const rendered = renderMailTemplate({
      template: TEMPLATE,
      format: 'html',
      context: context(),
      editLink: { kind: 'resolved', url: URL },
    });

    // Both halves: a bare URL in HTML is only a link if the mail client
    // happens to auto-link it.
    expect(rendered).toContain(`<a href="${URL}">${URL}</a>`);
  });

  it('renders nothing at all when there is no link, and keeps the rest', () => {
    for (const format of ['text', 'html'] as const) {
      const rendered = renderMailTemplate({
        template: TEMPLATE,
        format,
        context: context(),
        editLink: { kind: 'resolved', url: null },
      });

      expect(rendered).not.toContain('/a/');
      expect(rendered).not.toContain(EDIT_LINK_MARK);
      // **And the token itself is gone.** Measured while writing this file:
      // with the whole `bearbeiten` case deleted from `renderPlaceholder` the
      // placeholder falls through to „unknown" and stays in the text verbatim
      // — which carries neither an address nor a mark, so the three assertions
      // above stayed green on a renderer that does not know this placeholder at
      // all. „Löst zu nichts auf" has to say that nothing is left.
      expect(rendered).not.toContain('{{bearbeiten}}');
      // The sentence around it stands — „nichts" is the link, not the line.
      expect(rendered).toContain('Hallo!');
      expect(rendered).toContain('bis bald.');
    }
  });

  it('defaults to „no link", so a caller cannot ship a mark by forgetting', () => {
    const rendered = renderMailTemplate({
      template: TEMPLATE,
      format: 'text',
      context: context(),
    });

    expect(rendered).not.toContain(EDIT_LINK_MARK);
    expect(rendered).toBe('Hallo! Ändern:  — bis bald.');
  });

  it('renders nothing for a subject, which is never filled in later', () => {
    expect(
      renderMailSubject({
        template: 'Anmeldung {{bearbeiten}}',
        context: context(),
      }),
    ).toBe('Anmeldung');
  });

  /**
   * **The mark cannot be forged from an answer**, and that is why it is spelled
   * like a tag: a participant who types it into a public form would otherwise
   * get their own edit link spliced into the copy that goes to the organisation's
   * office. The existing neutralisation does the work — `<` becomes `&lt;` in
   * HTML, and anything spelled like a tag is removed in plain text — so no
   * extra pass is needed and none may be removed.
   */
  it('cannot be smuggled in through an answer', () => {
    const smuggled = context({
      answers: [
        { questionId: VORNAME, label: 'Vorname', value: EDIT_LINK_MARK },
      ],
    });

    for (const format of ['text', 'html'] as const) {
      const frozen = renderMailTemplate({
        template: `${questionPlaceholderToken(VORNAME)} / {{antworten}}`,
        format,
        context: smuggled,
        editLink: DEFERRED_EDIT_LINK,
      });

      expect(insertEditLink(frozen, format, URL)).not.toContain(URL);
    }
  });

  it('replaces every mark in a frozen body, and only the mark', () => {
    const frozen = `A ${EDIT_LINK_MARK} B ${EDIT_LINK_MARK} C`;

    expect(insertEditLink(frozen, 'text', URL)).toBe(`A ${URL} B ${URL} C`);
    expect(insertEditLink(frozen, 'text', null)).toBe('A  B  C');
  });
});

/**
 * **The marker of the reset link** (ADR-0020).
 *
 * It exists for a single reason: the stored body of a mail
 * is **displayed** (`mailLogDetailSchema.bodyText`, dispatch log), and
 * a reset link is full power over an account. What is checked here
 * is the half that this module contributes: that the marker is replaced,
 * that `'redacted'` writes a label instead of an address — and that no
 * `href` arises in the process.
 */
describe('insertPasswordResetLink', () => {
  const RESET_URL = 'https://formulare.example.org/password/AbCd';

  it('setzt die Adresse ein und entfernt die Marke, wenn es keine gibt', () => {
    const frozen = `Hier: ${PASSWORD_RESET_LINK_MARK} — Ende`;

    expect(
      insertPasswordResetLink(frozen, 'text', {
        present: true,
        url: RESET_URL,
      }),
    ).toBe(`Hier: ${RESET_URL} — Ende`);
    expect(
      insertPasswordResetLink(frozen, 'text', { present: false, url: null }),
    ).toBe('Hier:  — Ende');
  });

  it('schreibt der Detailansicht ein Etikett und niemals ein `href`', () => {
    const frozen = `Hier: ${PASSWORD_RESET_LINK_MARK}`;

    const text = insertPasswordResetLink(
      frozen,
      'text',
      { present: true, url: null },
      'redacted',
    );
    const html = insertPasswordResetLink(
      frozen,
      'html',
      { present: true, url: null },
      'redacted',
    );

    expect(text).toContain(PASSWORD_RESET_LINK_REDACTED_LABEL);
    expect(text).not.toContain(RESET_URL);
    expect(html).not.toContain(RESET_URL);
    expect(html).not.toContain('href');
  });

  it('macht die Adresse im HTML zu einem Anker und entschärft sie dabei', () => {
    const hostile = 'https://x.example/"><script>alert(1)</script>';
    const html = insertPasswordResetLink(PASSWORD_RESET_LINK_MARK, 'html', {
      present: true,
      url: hostile,
    });

    expect(html).not.toContain('<script>');
    expect(html.startsWith('<a href="')).toBe(true);
  });
});

/**
 * **The wrapper** — what turns a rendered body into a deliverable mail
 * (finding 31, ADR-0004 continuation; the footer with a link since then).
 *
 * What is checked here is not whether it „gut aussieht" — no test can do that —, but
 * the properties at which a mail fails without anybody
 * noticing: a missing character set, a colour value out of the database in a
 * `style` attribute, a `<style>` block that the client throws away, a body
 * that the wrapper changes on the way — and, since the footer carries an
 * address, **the text version**, which is otherwise the forgotten half.
 */
describe('die Hülle einer Mail (wrapMailBody)', () => {
  /** Short form for the cases that mean only the HTML version. */
  const wrapHtml = (body: string, shell?: MailShell): string =>
    wrapMailBody({ text: 'x', html: body }, shell).html ?? '';

  it('macht aus einem Fragment ein vollständiges Dokument', () => {
    const html = wrapHtml('<p>Hallo</p>');

    // Without `charset` the client decides, and „Grüße" becomes „GrÃ¼ÃŸe" —
    // the error one only sees in somebody else's mailbox.
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('width=device-width');
    expect(html).toContain('<p>Hallo</p>');
  });

  it('reicht den Rumpf unverändert durch — Zeichen für Zeichen', () => {
    // The property on which the order in `QueuedBodyRenderer` hangs:
    // first fill the markers, then wrap. If the wrapper shifted something in the
    // body, an already filled marker would no longer be what was inserted.
    // *Counter-check:* build in a `trim()` or a replacement in the body.
    const body = '<p>a &amp; b</p>\n<table><tr><td>x</td></tr></table>';

    expect(wrapHtml(body)).toContain(body);
  });

  it('lässt eine Mail ohne HTML-Fassung eine ohne HTML-Fassung', () => {
    const wrapped = wrapMailBody({ text: 'Hallo' });

    expect(wrapped.html).toBeUndefined();
    expect(wrapped.text).toContain('Hallo');
  });

  it('nimmt die Organisationsfarbe an — als Zeichenkette der Form #rrggbb', () => {
    expect(wrapHtml('<p>x</p>', { accent: '#123abc' })).toContain(
      'background-color:#123abc',
    );
  });

  /**
   * ⚠️ **The value comes from a database column**, and a column is an
   * arbitrary string. Without the predicate it would stand in a
   * `style` attribute — exactly the injection against which `branding.ts` built
   * its `HEX_COLOR`.
   *
   * *Counter-check:* remove `isBrandColor` from `shellAccent` → red.
   */
  it('verwirft eine Farbe, die keine ist, und behält die Vorgabe', () => {
    const html = wrapHtml('<p>x</p>', {
      accent: 'red;background:url(https://evil.example/x)',
    });

    expect(html).not.toContain('evil.example');
    expect(html).toContain(DEFAULT_TENANT_BRANDING.accent);
  });

  it('escaped den Namen der Organisation, in der Fußzeile wie im Titel', () => {
    const html = wrapHtml('<p>x</p>', {
      organisation: '<img src=x onerror=alert(1)>Ortsgruppe',
    });

    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[^>]*onerror/i);
  });

  it('kommt ohne Namen aus, ohne einen Platzhalter zu zeigen', () => {
    const html = wrapHtml('<p>x</p>');

    expect(html).toContain('Diese E-Mail wurde automatisch erzeugt.');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });

  /**
   * **No image, nowhere** — a decision by the user and no
   * omission: an embedded image would need the attachment mechanics of the
   * transport, would be loaded by many clients only on request and is a
   * known reason for delivery problems.
   */
  it('trägt kein Bild und keinen <style>-Block', () => {
    const html = wrapHtml('<p>x</p>', { organisation: 'Ortsgruppe' });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('cid:');
    expect(html).not.toContain('<style');
    // And no resolution that a mail client does not owe.
    expect(html).not.toContain('var(--');
    expect(html).not.toContain('color-mix(');
    expect(html).not.toContain('@font-face');
  });

  /**
   * **The link in the footer** — both versions, every time.
   *
   * The text version is the reason for most of these cases: it is the
   * half that gets forgotten (ADR-0026 says that about the foreign values, and for
   * the frame it holds just as much), and in it a link is not a caption
   * but an address.
   */
  describe('die Fußzeile verlinkt ins System', () => {
    const tenantShell: MailShell = {
      organisation: 'Ortsgruppe Nord',
      link: { owner: 'organisation', url: 'https://formulare.example' },
    };

    it('nennt in der HTML-Fassung die Organisation statt der nackten Adresse', () => {
      const html = wrapHtml('<p>x</p>', tenantShell);

      expect(html).toContain('href="https://formulare.example"');
      // `"` stands there escaped, as in every other mail of this application.
      expect(html).toContain('Formulare von „Ortsgruppe Nord&quot;</a>');
      // The caption is the name, not the URL: a bare address wraps
      // in the card and says nothing to a participant.
      expect(html).not.toContain('>https://formulare.example<');
    });

    it('nennt in der Klartextfassung die Adresse — am Zeilenende, ohne Satzzeichen dahinter', () => {
      const { text } = wrapMailBody({ text: 'Danke!' }, tenantShell);
      const lines = text.split('\n');

      expect(lines).toContain(
        'Formulare von „Ortsgruppe Nord": https://formulare.example',
      );
      // The body stands above, the footer beneath it behind two blank lines.
      expect(text.startsWith('Danke!\n\n\n')).toBe(true);
      expect(text).toContain(
        'Ortsgruppe Nord · Diese E-Mail wurde automatisch erzeugt.',
      );
    });

    /**
     * **No `--`.** A number of clients hide everything behind the signature marker
     * from RFC 3676 — the link would then be gone precisely in the mailboxes in which
     * it is needed.
     */
    it('trennt die Klartext-Fußzeile ohne Signaturmarke ab', () => {
      const { text } = wrapMailBody({ text: 'Danke!' }, tenantShell);

      expect(text.split('\n')).not.toContain('--');
      expect(text.split('\n')).not.toContain('-- ');
    });

    it('trägt für eine Mail der Installation deren Marke, nicht die einer Organisation', () => {
      const shell: MailShell = {
        organisation: 'Ortsgruppe Nord',
        link: { owner: 'installation', url: 'https://formsache.example' },
      };
      const wrapped = wrapMailBody({ text: 'Hallo', html: '<p>x</p>' }, shell);

      // The caption follows the **address**: here it belongs to the
      // installation, so it must not read „Formulare von „Ortsgruppe Nord""
      // — that would be a promise about a foreign host.
      expect(wrapped.text).toContain('Zu Formsache: https://formsache.example');
      expect(wrapped.text).not.toContain('Formulare von');
      expect(wrapped.html ?? '').toContain('href="https://formsache.example"');
      // The name of the organization nevertheless stays as the origin.
      expect(wrapped.text).toContain('Ortsgruppe Nord ·');
    });

    it('fällt auf die Marke der Installation zurück, wenn es keinen Namen gibt', () => {
      const { text } = wrapMailBody(
        { text: 'Hallo' },
        { link: { owner: 'organisation', url: 'https://formulare.example' } },
      );

      expect(text).toContain('Zu Formsache: https://formulare.example');
    });

    /**
     * **A mail without a link is better than one with a broken one.** The
     * footer is no load-bearing link: it announces nothing that would be missing
     * without it, so it may be absent without stopping the dispatch.
     */
    it('lässt den Link weg, wenn keine Adresse hinterlegt ist — und verschickt trotzdem', () => {
      const wrapped = wrapMailBody(
        { text: 'Danke!', html: '<p>x</p>' },
        { organisation: 'Ortsgruppe Nord' },
      );

      expect(wrapped.text).toContain('Danke!');
      expect(wrapped.text).toContain(
        'Ortsgruppe Nord · Diese E-Mail wurde automatisch erzeugt.',
      );
      expect(wrapped.text).not.toContain('http');
      expect(wrapped.html ?? '').not.toContain('<a href');
    });

    /**
     * ⚠️ **The attack on the `href`.** `tenant.public_base_url` is set by whoever
     * holds `can_manage_settings`, and the column is `text` — reachable
     * past the route as well. Without the second gate the value would stand in the only
     * attribute of this mail that a click triggers.
     *
     * *Counter-check:* remove `normaliseBaseUrl` from `footerOf` → red.
     */
    it('verwirft ein javascript:-Schema in der Basis-Adresse — in beiden Fassungen', () => {
      const wrapped = wrapMailBody(
        { text: 'Danke!', html: '<p>x</p>' },
        {
          organisation: 'Ortsgruppe Nord',
          // The attack that has to fail.
          link: { owner: 'organisation', url: 'javascript:alert(1)' },
        },
      );

      expect(wrapped.html ?? '').not.toContain('javascript:');
      expect(wrapped.html ?? '').not.toContain('<a href');
      expect(wrapped.text).not.toContain('javascript:');
    });

    it('verwirft ein data:-Schema und eine Adresse, die keine ist', () => {
      for (const url of [
        'data:text/html,<script>alert(1)</script>',
        'ftp://a.example',
        '/forms',
        'formulare.example',
        'https://a.example/?next=https://evil.example',
        'https://a.example/#x',
      ]) {
        const wrapped = wrapMailBody(
          { text: 'Danke!', html: '<p>x</p>' },
          { link: { owner: 'installation', url } },
        );

        expect(wrapped.html ?? '').not.toContain('<a href');
        expect(wrapped.text).not.toContain('Zu Formsache:');
      }
    });

    /**
     * ⚠️ **The quotation mark that `URL.href` does **not** escape.** `"`,
     * `<` and `>` fall into `%22`/`%3C`/`%3E` on serialization, `'`
     * by contrast stays standing. An attribute in single quotation marks would
     * thereby be open — the `href` therefore stands in double ones **and** goes through
     * `escapeHtml`.
     *
     * *Counter-check:* remove `escapeHtml` around the `href` → red.
     */
    it('maskiert Anführungszeichen in der Adresse, statt das Attribut zu öffnen', () => {
      const html = wrapHtml('<p>x</p>', {
        link: {
          owner: 'installation',
          url: "https://a.example/x'onmouseover='alert(1)",
        },
      });

      // No raw `'` in the attribute value — the attribute stays closed.
      expect(html).toContain('&#39;');
      expect(html).not.toMatch(/href="[^"]*'/);
      expect(html).not.toContain("onmouseover='");
      // And a `"` that `URL` itself would already have turned into `%22` goes
      // through `escapeHtml` here in addition.
      const second = wrapHtml('<p>x</p>', {
        link: { owner: 'installation', url: 'https://a.example/x"y' },
      });
      expect(second).toContain('href="https://a.example/x%22y"');
    });

    /**
     * ⚠️ **ADR-0026 holds for the footer too.** The name of the organization
     * is a foreign value, and since it stands in the **text version**, a
     * `\n` in it would yield an additional line in a mail that nobody
     * can call back.
     *
     * *Counter-check:* remove `collapseWhitespace` from `footerOf` → red.
     */
    it('faltet den Namen der Organisation zu einer Zeile — auch im Klartext', () => {
      const attack =
        'Ortsgruppe\n\nDein Zugang läuft ab. Jetzt bestätigen: https://boese.example\n\n—';
      const harmless = wrapMailBody(
        { text: 'Danke!' },
        { organisation: 'Ortsgruppe' },
      );
      const attacked = wrapMailBody(
        { text: 'Danke!' },
        { organisation: attack },
      );

      expect(attacked.text.split('\n')).toHaveLength(
        harmless.text.split('\n').length,
      );
      expect(attacked.text).toContain(
        'Ortsgruppe Dein Zugang läuft ab. Jetzt bestätigen: https://boese.example —',
      );
    });

    it('normalisiert eine Adresse mit Schrägstrich am Ende', () => {
      const { text } = wrapMailBody(
        { text: 'x' },
        {
          link: { owner: 'installation', url: 'https://a.example/forms/' },
        },
      );

      expect(text).toContain('Zu Formsache: https://a.example/forms');
    });
  });
});
