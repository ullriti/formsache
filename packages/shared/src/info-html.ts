import { safeLegalHref } from './legal-text.ts';

/**
 * **The Infotext's HTML — a small allow-list, parsed into a tree.**
 *
 * An Infotext may carry formatting („einfaches HTML": Absätze, Listen, Fett,
 * Links). What this file refuses to do is hand a stranger-facing page a *string
 * with angle brackets*: the text is parsed here into {@link InfoNode}s and the
 * browser builds React elements from that tree. There is no `innerHTML` at the
 * end of it, so a tag this file does not know cannot reach the page — it is
 * not „escaped", it is not in the tree. The same rule the legal texts follow
 * (`legal-text.ts`).
 *
 * ## What is kept
 *
 * `p`, `br`, `hr`, `strong`/`b`, `em`/`i`, `u`, `ul`, `ol`, `li`, `h3`/`h4`
 * (`h1`/`h2` become `h3`, `h5`/`h6` become `h4`: the page's own heading is the
 * form's title), `blockquote` and `a`. Of an `a` **only `href` survives**, and
 * only an address {@link safeLegalHref} accepts (an own path, `http(s)`,
 * `mailto`) — no `javascript:`, no `data:`, no `on…` attribute of any tag.
 *
 * ## What is not
 *
 * An unknown tag is dropped and its **children stay** (`<font>text</font>` is
 * `text`). The tags whose *content* is not text a reader should see —
 * `script`, `style`, `iframe`, `object`, `embed`, `noscript`, `template`,
 * `textarea`, `title`, `svg`, `math` — are dropped **with** their content.
 * Comments are dropped.
 *
 * ## Newlines are line breaks
 *
 * A plain-text Infotext with no tag at all keeps its lines: `\n` becomes a
 * `br` — except next to a block element, where it is only the formatting of the
 * source and would otherwise stack blank lines between paragraphs.
 *
 * ## Bounded
 *
 * Depth and node count are capped ({@link INFO_MAX_DEPTH},
 * {@link INFO_MAX_NODES}): the schema bounds the *length* of the source, and a
 * length alone says nothing about a tree of thousands of nested elements.
 * Beyond the cap an element is flattened into its parent, and past the node
 * cap the rest is not read.
 */

/** The elements that survive, after the renames described above. */
export type InfoTag =
  | 'p'
  | 'strong'
  | 'em'
  | 'u'
  | 'ul'
  | 'ol'
  | 'li'
  | 'h3'
  | 'h4'
  | 'blockquote'
  | 'a';

export type InfoNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'br' }
  | { readonly kind: 'hr' }
  | {
      readonly kind: 'el';
      readonly tag: InfoTag;
      /** Set on `a` only, and only ever a {@link safeLegalHref} result. */
      readonly href?: string;
      readonly children: readonly InfoNode[];
    };

export const INFO_MAX_DEPTH = 12;
export const INFO_MAX_NODES = 2000;

const TAG_ALIASES: Readonly<Record<string, InfoTag>> = {
  p: 'p',
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'u',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  h1: 'h3',
  h2: 'h3',
  h3: 'h3',
  h4: 'h4',
  h5: 'h4',
  h6: 'h4',
  blockquote: 'blockquote',
  a: 'a',
};

/** Tags whose content is dropped together with the tag. */
const DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'textarea',
  'title',
  'svg',
  'math',
]);

const BLOCK_TAGS = new Set<InfoTag>([
  'p',
  'ul',
  'ol',
  'li',
  'h3',
  'h4',
  'blockquote',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/gu,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) {
        return NAMED_ENTITIES[name] ?? whole;
      }
      const code =
        decimal !== undefined
          ? Number.parseInt(decimal, 10)
          : Number.parseInt(hex ?? '', 16);
      // Printable code points only: no control characters, no surrogates, and
      // nothing past the Unicode range.
      return (code >= 0x20 && code < 0xd800) ||
        (code > 0xdfff && code <= 0x10ffff)
        ? String.fromCodePoint(code)
        : '';
    },
  );
}

interface OpenElement {
  readonly tag: InfoTag;
  readonly href?: string;
  readonly children: InfoNode[];
}

interface RawTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
  /** Index just past the `>`. */
  readonly end: number;
}

/** Reads a tag starting at `start` (`source[start] === '<'`), or `null`. */
function readTag(source: string, start: number): RawTag | null {
  const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/u.exec(
    source.slice(start, start + 40),
  );
  if (head === null) {
    return null;
  }
  const closing = head[1] === '/';
  const name = (head[2] ?? '').toLowerCase();
  let index = start + head[0].length;
  const attributes = new Map<string, string>();
  let selfClosing = false;

  while (index < source.length) {
    const char = source[index];
    if (char === '>') {
      return { name, closing, selfClosing, attributes, end: index + 1 };
    }
    if (char === '/') {
      selfClosing = true;
      index += 1;
      continue;
    }
    if (char === undefined || /\s/u.test(char)) {
      index += 1;
      continue;
    }
    const attribute =
      /^([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/u.exec(
        source.slice(index, index + 2100),
      );
    if (attribute === null) {
      index += 1;
      continue;
    }
    selfClosing = false;
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    attributes.set((attribute[1] ?? '').toLowerCase(), value);
    index += Math.max(1, attribute[0].length);
  }
  // Unterminated tag: not a tag, the `<` is text.
  return null;
}

/** Index of the end of a dropped element (`</name …>`), or the end of input. */
function skipContent(source: string, from: number, name: string): number {
  const pattern = new RegExp(`</${name}\\s*>`, 'iu');
  const match = pattern.exec(source.slice(from));
  return match === null ? source.length : from + match.index + match[0].length;
}

/**
 * Parses an Infotext into the tree that is rendered. Never throws, whatever the
 * input is.
 */
export function parseInfoHtml(source: string): InfoNode[] {
  const root: OpenElement = { tag: 'p', children: [] };
  const stack: OpenElement[] = [root];
  let nodes = 0;
  let text = '';

  const top = (): OpenElement => stack[stack.length - 1] ?? root;
  const append = (node: InfoNode): void => {
    if (nodes < INFO_MAX_NODES) {
      nodes += 1;
      top().children.push(node);
    }
  };
  const flush = (): void => {
    if (text !== '') {
      append({ kind: 'text', text: decodeEntities(text) });
      text = '';
    }
  };

  let index = 0;
  while (index < source.length && nodes < INFO_MAX_NODES) {
    const char = source[index];
    if (char !== '<') {
      const next = source.indexOf('<', index);
      const stop = next === -1 ? source.length : next;
      text += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    const tag = readTag(source, index);
    if (tag === null) {
      text += '<';
      index += 1;
      continue;
    }
    flush();
    index = tag.end;

    if (DROPPED_WITH_CONTENT.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) {
        index = skipContent(source, index, tag.name);
      }
      continue;
    }
    if (tag.name === 'br' && !tag.closing) {
      append({ kind: 'br' });
      continue;
    }
    if (tag.name === 'hr' && !tag.closing) {
      append({ kind: 'hr' });
      continue;
    }
    const mapped = TAG_ALIASES[tag.name];
    if (mapped === undefined) {
      continue;
    }
    if (tag.closing) {
      const at = stack.map((entry) => entry.tag).lastIndexOf(mapped);
      if (at > 0) {
        stack.length = at;
      }
      continue;
    }
    if (tag.selfClosing || stack.length > INFO_MAX_DEPTH) {
      continue;
    }
    const href =
      mapped === 'a'
        ? safeLegalHref(decodeEntities(tag.attributes.get('href') ?? ''))
        : null;
    const element: OpenElement = {
      tag: mapped,
      ...(href === null ? {} : { href }),
      children: [],
    };
    // A block cannot sit inside a paragraph: opening one closes the open `p`,
    // the way the browser's own parser reads `<p>a<ul>…`.
    if (BLOCK_TAGS.has(mapped) && top().tag === 'p' && stack.length > 1) {
      stack.pop();
    }
    append({
      kind: 'el',
      tag: mapped,
      children: element.children,
      ...(href === null ? {} : { href }),
    });
    stack.push(element);
  }
  flush();

  return withLineBreaks(root.children);
}

function isBlock(node: InfoNode | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === 'hr' || (node.kind === 'el' && BLOCK_TAGS.has(node.tag)))
  );
}

/**
 * Turns newlines into `br` and removes the ones that are only source
 * formatting next to a block element or at the edge of a container.
 */
function withLineBreaks(children: readonly InfoNode[]): InfoNode[] {
  const out: InfoNode[] = [];

  children.forEach((node, position) => {
    if (node.kind === 'el') {
      out.push({ ...node, children: withLineBreaks(node.children) });
      return;
    }
    if (node.kind !== 'text') {
      out.push(node);
      return;
    }
    let value = node.text.replace(/\r\n?/gu, '\n');
    if (position === 0 || isBlock(children[position - 1])) {
      value = value.replace(/^\s*\n\s*/u, '');
    }
    if (position === children.length - 1 || isBlock(children[position + 1])) {
      value = value.replace(/\s*\n\s*$/u, '');
    }
    if (value === '') {
      return;
    }
    value.split('\n').forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        out.push({ kind: 'br' });
      }
      if (line !== '') {
        out.push({ kind: 'text', text: line });
      }
    });
  });

  return out;
}
