import type { ReactElement } from 'react';
import type { FileAttachment } from '@formsache/shared';

import { API_BASE } from '../../api/http';

/**
 * The attachments of one answer, **as links** (the requirement: „In der
 * Antworten-Tabelle und im Detail: der Dateiname als Link").
 *
 * One component for the table cell and for the detail panel, so the two cannot
 * disagree about what a link is called or where it points.
 *
 * ## The address, and what it is not
 *
 * `GET /api/responses/files/:ref`, behind the whole guard chain — session,
 * tenant scope, group permissions, form restriction, `can_view_responses`
 * (ADR-0014 no. 11b). A plain `<a href>` rather than a fetch-and-blob dance:
 * the cookie is `httpOnly` and travels with a same-origin navigation by itself,
 * and the server sets `Content-Disposition: attachment` with the name it stored,
 * so the browser downloads it under the right name without this file knowing
 * one.
 *
 * **This address is deliberately nowhere else.** It is not in the CSV export
 * (no. 17: „eine Zelle, der Dateiname, kein Verweis, keine Kennung, keine URL"),
 * because an export is the document that gets mailed on and left on network
 * drives. The way to a file is this screen, behind the chain — which is the
 * whole reason the link exists here at all.
 *
 * `rel="noreferrer"` with the `target`: the response opens in a new tab so the
 * table behind it keeps its scroll position and its open detail panel, and a
 * download that carries this page's address on to wherever it lands is a leak
 * of a form id and an organisation for nothing.
 */
export function AttachmentLinks({
  files,
}: {
  readonly files: readonly FileAttachment[];
}): ReactElement {
  return (
    <>
      {files.map((file, index) => (
        <span key={file.ref}>
          {index === 0 ? null : ', '}
          <a
            className="responses__attachment"
            href={`${API_BASE}/responses/files/${encodeURIComponent(file.ref)}`}
            target="_blank"
            rel="noreferrer"
            // The row itself opens the detail panel (`ResponsesTable`), so a
            // click on the link would do both. Stopped here rather than by
            // taking the handler off the row: the row-wide click is what the
            // handoff describes, and this is the one element inside it that
            // means something else.
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {file.name}
          </a>
        </span>
      ))}
    </>
  );
}
