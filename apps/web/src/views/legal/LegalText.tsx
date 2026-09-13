import type { ReactElement, ReactNode } from 'react';
import type { LegalBlock, LegalInline } from '@formsache/shared';

/**
 * **The renderer of a legal text — and the place where `dangerouslySetInnerHTML`
 * does not stand.**
 *
 * It cannot stand there, and that is the point: what comes in here is
 * a tree of {@link LegalBlock}, and a tree has no string one could hand
 * to a browser as markup. The decision about what structure
 * a legal text may have has already been made — in
 * `packages/shared/src/legal-text.ts`, on the server, before the answer. This
 * file only carries it out.
 *
 * That is the build shape `docs/legal/README.md` 5.6 demands („Rendern als
 * Text, niemals über `dangerouslySetInnerHTML`") and that this repository already
 * holds in three places (`SandboxedHtmlFrame.tsx`,
 * `NotificationPreview.tsx`, `ConfirmationPreview.tsx`). The difference from
 * those three: there foreign HTML is **locked up**, here there is none at
 * all — the legal text is plain text in the column and stays that up to here.
 *
 * ## The gap is visible, and that is deliberate
 *
 * A placeholder nobody has filled in becomes a `gap` run and
 * appears as a marked, named blank. A legal text with a
 * remaining `[[PLATZHALTER]]` that somebody publishes unchecked is
 * worse than an empty field — so it is neither kept silent about nor
 * rebuilt, but named.
 */
export function LegalText({
  blocks,
}: {
  readonly blocks: readonly LegalBlock[];
}): ReactElement {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  );
}

function Block({ block }: { readonly block: LegalBlock }): ReactElement {
  switch (block.kind) {
    case 'heading':
      return block.level === 2 ? (
        <h2 className="legal-text__h2">
          <Runs runs={block.runs} />
        </h2>
      ) : (
        <h3 className="legal-text__h3">
          <Runs runs={block.runs} />
        </h3>
      );
    case 'paragraph':
      return (
        <p className="legal-text__p">
          <Runs runs={block.runs} />
        </p>
      );
    case 'list':
      return (
        <ul className="legal-text__list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Runs runs={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        /*
          The scroll region of its own that `AGENTS.md` demands for wide content:
          a table with three columns of running text does not fit on a phone,
          and the page itself must not scroll horizontally because of it.
        */
        <div className="legal-text__table-scroll">
          <table className="legal-text__table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} scope="col">
                    <Runs runs={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <Runs runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Runs({
  runs,
}: {
  readonly runs: readonly LegalInline[];
}): ReactElement {
  return (
    <>
      {runs.map((run, index) => (
        <Run key={index} run={run} />
      ))}
    </>
  );
}

function Run({ run }: { readonly run: LegalInline }): ReactNode {
  switch (run.kind) {
    case 'text':
      return run.text;
    case 'strong':
      return <strong>{run.text}</strong>;
    case 'link':
      /*
        `href` has passed the server's allow-list (`safeLegalHref`) —
        `http:`, `https:`, `mailto:` or a path of our own, and nothing else.
        A target that fell through does not arrive here as a link at all but as
        text; so there is nothing this line could still check that
        has not already been checked.

        `rel="noreferrer"` in addition to the application's header
        (`Referrer-Policy: no-referrer`, `common/no-store.ts`): the same
        duplication that is reasoned out there — the header covers the server, the
        attribute covers this one page, even when somebody else delivers it.
      */
      return (
        <a className="legal-text__link" href={run.href} rel="noreferrer">
          {run.label}
        </a>
      );
    case 'gap':
      return <mark className="legal-text__gap">Angabe fehlt: {run.label}</mark>;
  }
}
