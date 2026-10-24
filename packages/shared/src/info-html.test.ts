import { describe, expect, it } from 'vitest';

import {
  INFO_MAX_DEPTH,
  INFO_MAX_NODES,
  parseInfoHtml,
  type InfoNode,
} from './info-html.ts';

/** The tree flattened to a tag-and-text string — what a test can read at a glance. */
function show(nodes: readonly InfoNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return node.text;
        case 'br':
          return '<br>';
        case 'hr':
          return '<hr>';
        case 'el':
          return `<${node.tag}${node.href === undefined ? '' : ` href=${node.href}`}>${show(node.children)}</${node.tag}>`;
      }
    })
    .join('');
}

describe('parseInfoHtml', () => {
  it('keeps the allowed formatting', () => {
    expect(
      show(parseInfoHtml('<p>Hallo <b>Welt</b> und <em>mehr</em></p>')),
    ).toBe('<p>Hallo <strong>Welt</strong> und <em>mehr</em></p>');
  });

  it('keeps lists and headings, mapping h1/h2 down to h3', () => {
    expect(
      show(parseInfoHtml('<h1>Titel</h1><ul><li>a</li><li>b</li></ul>')),
    ).toBe('<h3>Titel</h3><ul><li>a</li><li>b</li></ul>');
  });

  it('turns newlines of a plain text into line breaks', () => {
    expect(show(parseInfoHtml('Zeile 1\nZeile 2\r\nZeile 3'))).toBe(
      'Zeile 1<br>Zeile 2<br>Zeile 3',
    );
  });

  it('does not stack blank lines between blocks that sit on their own lines', () => {
    expect(show(parseInfoHtml('<p>A</p>\n<p>B</p>\n'))).toBe(
      '<p>A</p><p>B</p>',
    );
  });

  it('decodes entities into text, never into markup', () => {
    // `&lt;script&gt;` is the *text* „<script>" — a text node, rendered as text.
    expect(
      show(parseInfoHtml('a &amp; b &lt;script&gt;x&lt;/script&gt;')),
    ).toBe('a & b <script>x</script>');
    expect(parseInfoHtml('&lt;b&gt;')).toEqual([{ kind: 'text', text: '<b>' }]);
  });

  describe('what is refused', () => {
    it.each([
      ['<script>alert(1)</script>Text', 'Text'],
      ['<SCRIPT >alert(1)</SCRIPT>Text', 'Text'],
      ['<style>p{color:red}</style>Text', 'Text'],
      ['<iframe src="https://evil.example"></iframe>Text', 'Text'],
      ['<object data="x"></object>Text', 'Text'],
      ['<svg onload=alert(1)><circle/></svg>Text', 'Text'],
      ['<!-- <script>x</script> -->Text', 'Text'],
      ['<script>unterminated', ''],
    ])('drops %s together with its content', (source, expected) => {
      expect(show(parseInfoHtml(source))).toBe(expected);
    });

    it('drops unknown tags and keeps their text', () => {
      expect(
        show(parseInfoHtml('<font color="red">rot</font><marquee>x</marquee>')),
      ).toBe('rotx');
    });

    it('drops every attribute except a safe href on a link', () => {
      expect(
        show(
          parseInfoHtml(
            '<p onclick="x()" style="color:red" class="a">t</p><b onmouseover=x>b</b>',
          ),
        ),
      ).toBe('<p>t</p><strong>b</strong>');
    });

    it.each([
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      '//evil.example/x',
    ])('refuses the address %s', (href) => {
      expect(show(parseInfoHtml(`<a href="${href}">x</a>`))).toBe('<a>x</a>');
    });

    it.each([
      'https://example.org/a?b=c',
      'http://example.org',
      'mailto:info@example.org',
      '/impressum',
    ])('keeps the address %s', (href) => {
      const [link] = parseInfoHtml(`<a href="${href}">x</a>`);
      expect(link?.kind === 'el' ? link.href : undefined).toBeTypeOf('string');
    });

    it('does not read an entity-encoded javascript: address as safe', () => {
      expect(
        show(parseInfoHtml('<a href="java&#115;cript:alert(1)">x</a>')),
      ).toBe('<a>x</a>');
    });
  });

  describe('bounds', () => {
    it('flattens elements past the depth limit', () => {
      const source = '<blockquote>'.repeat(INFO_MAX_DEPTH + 50) + 'x';
      let depth = 0;
      let node: InfoNode | undefined = parseInfoHtml(source)[0];
      while (node?.kind === 'el') {
        depth += 1;
        node = node.children[0];
      }
      expect(depth).toBeLessThanOrEqual(INFO_MAX_DEPTH + 1);
    });

    it('stops reading at the node limit', () => {
      const nodes = parseInfoHtml('<b>x</b>'.repeat(INFO_MAX_NODES));
      expect(nodes.length).toBeLessThanOrEqual(INFO_MAX_NODES);
    });

    /**
     * **Linear, not quadratic.** An unterminated tag used to make the reader
     * scan to the end of the input for every `<` — measured at seconds for a
     * text of `INFO_TEXT_MAX` characters, on a page every participant opens.
     */
    it.each(['<a ', '<a x', '<a b=', '<a b="', '</', '<!x'])(
      'reads 20 000 characters of %j fast',
      (piece) => {
        const source = piece.repeat(Math.ceil(20_000 / piece.length));
        const started = performance.now();
        parseInfoHtml(source);
        expect(performance.now() - started).toBeLessThan(500);
      },
    );

    it('stays fast when a far `>` makes every tag look reachable', () => {
      const source = `${'<a x '.repeat(3800)}>`;
      const started = performance.now();
      parseInfoHtml(source);
      expect(performance.now() - started).toBeLessThan(500);
    });

    it('never throws on broken input', () => {
      for (const source of [
        '<',
        '<a',
        '<a href="x',
        '</p></p></b>',
        '<<<>>>',
        '<p><b><i>',
        '&#99999999999;&#x;&;',
        '\u0000<b>\u0000',
      ]) {
        expect(() => parseInfoHtml(source)).not.toThrow();
      }
    });
  });
});
