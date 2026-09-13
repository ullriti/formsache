import type { ReactElement } from 'react';
import { useRef } from 'react';
import { parseFormDefinition, type ResponseDetail } from '@formsache/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../../test/render-with-query';
import { ResponseDetailPanel } from './ResponseDetailPanel';
import { ResponsesTable } from './ResponsesTable';
import { toRow } from './response-rows';

/**
 * **„In der Antworten-Tabelle und im Detail: der Dateiname als Link"** —
 * the requirement, on both surfaces, because a link on one of them and plain
 * text on the other is exactly the drift `AttachmentLinks` exists against.
 *
 * The address is the one of ADR-0014 no. 11(b), behind the whole guard chain.
 * The **negative** half is asserted too and is the one that matters: this
 * address is on this screen and nowhere else — never in the CSV export, which
 * carries the name alone (no. 17).
 */

const PAGE = '019fe800-0000-7000-8000-0000000000a0';
const FILE_ID = '019fe800-0000-7000-8000-000000000001';
const REF = 'AbCdEfGhIjKlMnOpQrStUv';

const definition = parseFormDefinition({
  pages: [
    {
      id: PAGE,
      title: 'Anmeldung',
      questions: [
        {
          id: FILE_ID,
          type: 'file',
          label: 'Nachweis',
          hint: null,
          required: false,
          width: 'full',
          maxFiles: 2,
        },
      ],
    },
  ],
});

const response: ResponseDetail = {
  id: '019fe800-0000-7000-8000-0000000000f1',
  formId: '019fe800-0000-7000-8000-0000000000e1',
  submittedAt: '2026-07-27T09:05:00.000Z',
  formVersion: 1,
  answers: {
    [FILE_ID]: { files: [{ ref: REF, name: 'Nachweis Müller.pdf' }] },
  },
};

const row = toRow(response, definition);
const FORM_ID = '019fe800-0000-7000-8000-0000000000e1';

/**
 * `ResponseDetailPanel` needs a `fallbackRef` for `useFocusTrap` (the requirement's delete) — a plain object literal will not do, `useFocusTrap` reads
 * `.current` after every render, and a wrapper is the shortest way to hand it
 * a real `RefObject` from inside a test.
 */
function Panel({ onClose }: { readonly onClose: () => void }): ReactElement {
  const fallbackRef = useRef<HTMLElement>(null);
  return (
    <ResponseDetailPanel
      row={row}
      retiredKeys={new Set()}
      formId={FORM_ID}
      canDelete={false}
      fallbackRef={fallbackRef}
      onClose={onClose}
    />
  );
}

function link(): HTMLAnchorElement {
  const found = screen.getByRole('link', { name: 'Nachweis Müller.pdf' });
  if (!(found instanceof HTMLAnchorElement)) {
    throw new Error('Der Dateiname ist kein Link.');
  }
  return found;
}

describe('the attachment of an answer, as a link ', () => {
  it('renders the file name as a link in the responses table', () => {
    render(
      <ResponsesTable
        caption="Antworten"
        columns={[{ key: FILE_ID, label: 'Nachweis', retired: false }]}
        rows={[row]}
        sort={{ key: FILE_ID, direction: 1 }}
        onSort={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(link().getAttribute('href')).toBe(`/api/responses/files/${REF}`);
  });

  it('renders it in the detail panel too, at the same address', () => {
    renderWithQuery(<Panel onClose={vi.fn()} />);

    expect(link().getAttribute('href')).toBe(`/api/responses/files/${REF}`);
  });

  /**
   * The **folded cell** keeps the plain name — that is what sorting and the
   * search run over, and what the export writes (`formatAnswerCell`). The link
   * is rendered *beside* it rather than out of it: building one by splitting
   * the joined cell on „, " would break on a file name containing one.
   */
  it('keeps the folded cell as the text the search and the export use', () => {
    expect(row.cells[FILE_ID]).toBe('Nachweis Müller.pdf');
    expect(row.attachments[FILE_ID]).toStrictEqual([
      { ref: REF, name: 'Nachweis Müller.pdf' },
    ]);
  });
});
