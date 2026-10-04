import { describe, expect, it } from 'vitest';

import {
  LINK_PREVIEW_DESCRIPTION_MAX,
  LINK_PREVIEW_MAX_BYTES,
  previewDescription,
  renderLinkPreview,
} from './link-preview';

/**
 * The fragment the front door splices into `<head>` (ADR-0033). Which forms get
 * one is decided by the service and proved against a database
 * (`test/public/link-preview.spec.ts`); what is proved here is the markup — and
 * above all that an editor's text cannot leave its attribute.
 */
describe('renderLinkPreview', () => {
  it('names the form, its organisation and its intro', () => {
    const head = renderLinkPreview({
      title: 'Sommerfest 2026',
      description: 'Bitte bis Freitag anmelden.',
      organisation: 'Kita Sonnenschein',
    });

    expect(head).toContain('<title>Sommerfest 2026</title>');
    expect(head).toContain(
      '<meta property="og:title" content="Sommerfest 2026" />',
    );
    expect(head).toContain(
      '<meta property="og:site_name" content="Kita Sonnenschein" />',
    );
    expect(head).toContain(
      '<meta property="og:description" content="Bitte bis Freitag anmelden." />',
    );
    expect(head).toContain(
      '<meta name="description" content="Bitte bis Freitag anmelden." />',
    );
  });

  it('escapes every value, so a title cannot close its tag or attribute', () => {
    const head = renderLinkPreview({
      title: '</title><script>alert(1)</script>',
      description: '" onload="alert(2)',
      organisation: "Müller & Söhne's <Verein>",
    });

    expect(head).not.toContain('<script>');
    expect(head).not.toContain('" onload="');
    expect(head).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>',
    );
    expect(head).toContain('content="&quot; onload=&quot;alert(2)"');
    expect(head).toContain('content="Müller &amp; Söhne&#39;s &lt;Verein&gt;"');
  });

  it('leaves out the description lines when there is no intro', () => {
    for (const description of [null, '', '   \n ']) {
      const head = renderLinkPreview({
        title: 'Umfrage',
        description,
        organisation: 'Verein',
      });

      expect(head).not.toContain('description');
      expect(head).toContain('<title>Umfrage</title>');
    }
  });

  /**
   * The front door cuts the page off when the fragment outgrows its buffer
   * (see `LINK_PREVIEW_MAX_BYTES`). The worst an editor can type within the
   * schema limits — 200-character title, 60-character organisation, an intro
   * cut to 200 — of the character that escapes longest has to fit.
   */
  it('stays within the byte bound for the worst legal input', () => {
    const head = renderLinkPreview({
      title: '"'.repeat(200),
      description: '"'.repeat(1000),
      organisation: '"'.repeat(60),
    });

    expect(Buffer.byteLength(head, 'utf8')).toBeLessThanOrEqual(
      LINK_PREVIEW_MAX_BYTES,
    );
    expect(head).toContain('og:description');
  });

  it('drops the description first, and everything but the plain title last', () => {
    const longTitle = renderLinkPreview({
      title: '&'.repeat(LINK_PREVIEW_MAX_BYTES),
      description: 'Kurz.',
      organisation: 'Verein',
    });
    expect(longTitle).toBe('<title>Formsache</title>\n');

    const tight = renderLinkPreview({
      // Fits alone, not with the description beside it.
      title: '&'.repeat(Math.floor(LINK_PREVIEW_MAX_BYTES / 10) - 50),
      description: '&'.repeat(150),
      organisation: 'Verein',
    });
    expect(Buffer.byteLength(tight, 'utf8')).toBeLessThanOrEqual(
      LINK_PREVIEW_MAX_BYTES,
    );
    expect(tight).toContain('og:title');
    expect(tight).not.toContain('description');
  });

  it('gives the plain product title for nothing fillable', () => {
    expect(renderLinkPreview(null)).toBe('<title>Formsache</title>\n');
  });
});

describe('previewDescription', () => {
  it('flattens line breaks into one line', () => {
    expect(previewDescription('  Erste Zeile.\n\nZweite   Zeile. ')).toBe(
      'Erste Zeile. Zweite Zeile.',
    );
  });

  it('keeps a text at the bound unchanged', () => {
    const exact = 'a'.repeat(LINK_PREVIEW_DESCRIPTION_MAX);
    expect(previewDescription(exact)).toBe(exact);
  });

  it('cuts a longer text at a word boundary, within the bound', () => {
    const long = 'Wort '.repeat(100);
    const cut = previewDescription(long);

    expect(cut.length).toBeLessThanOrEqual(LINK_PREVIEW_DESCRIPTION_MAX);
    expect(cut.endsWith('Wort…')).toBe(true);
  });

  it('never cuts through an emoji', () => {
    const cut = previewDescription('😀'.repeat(300));

    expect(cut).not.toContain('\uFFFD');
    expect(cut).toMatch(/^(😀)+…$/u);
  });

  it('cuts a single overlong word mid-word instead of dropping it', () => {
    const cut = previewDescription('x'.repeat(500));

    expect(cut).toHaveLength(LINK_PREVIEW_DESCRIPTION_MAX);
    expect(cut.endsWith('x…')).toBe(true);
  });
});
