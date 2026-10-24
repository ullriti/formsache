import type { ReactElement, ReactNode } from 'react';
import { parseInfoHtml, type InfoNode } from '@formsache/shared';

/**
 * The body of an Infotext — simple HTML, **rendered from a parsed tree**.
 *
 * `parseInfoHtml` (`@formsache/shared`) reads the source against an allow-list
 * and hands back nodes; this component turns them into React elements. There is
 * no `dangerouslySetInnerHTML` anywhere on the path, so what the allow-list does
 * not name has no way onto the page — not as markup, and not as an attribute.
 *
 * Used by the fill-in view and by the builder's card, so an editor sees what a
 * participant gets (including the tags that are *not* kept).
 */
export function InfoContent({
  source,
  className,
}: {
  readonly source: string;
  readonly className?: string;
}): ReactElement {
  return (
    <div className={className ?? 'info-content'}>
      {renderNodes(parseInfoHtml(source))}
    </div>
  );
}

function renderNodes(nodes: readonly InfoNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    const key = index;
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'br':
        return <br key={key} />;
      case 'hr':
        return <hr key={key} />;
      case 'el': {
        const children = renderNodes(node.children);
        switch (node.tag) {
          case 'a':
            return node.href === undefined ? (
              <span key={key}>{children}</span>
            ) : (
              <a
                key={key}
                href={node.href}
                // A new tab only for another site; `noopener` always, so the
                // opened page gets no handle on this one.
                {...(node.href.startsWith('/')
                  ? {}
                  : { target: '_blank', rel: 'noopener noreferrer' })}
              >
                {children}
              </a>
            );
          case 'p':
            return <p key={key}>{children}</p>;
          case 'strong':
            return <strong key={key}>{children}</strong>;
          case 'em':
            return <em key={key}>{children}</em>;
          case 'u':
            return <u key={key}>{children}</u>;
          case 'ul':
            return <ul key={key}>{children}</ul>;
          case 'ol':
            return <ol key={key}>{children}</ol>;
          case 'li':
            return <li key={key}>{children}</li>;
          case 'h3':
            return <h3 key={key}>{children}</h3>;
          case 'h4':
            return <h4 key={key}>{children}</h4>;
          case 'blockquote':
            return <blockquote key={key}>{children}</blockquote>;
        }
      }
    }
  });
}
