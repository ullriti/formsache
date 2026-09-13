import type { ExportFormat, ResponseDetail } from '@formsache/shared';
import { responseDetailSchema } from '@formsache/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { requestJson } from './http';

/**
 * The answers of one form.
 *
 * Server state, so TanStack Query — the table's own state (search term,
 * sorting, chosen columns) is view state and stays in the component. Mixing
 * the two would make a refetch reset the sort order.
 */

export function responsesQueryKey(formId: string): readonly string[] {
  return ['forms', formId, 'responses'];
}

export function useResponses(formId: string): UseQueryResult<ResponseDetail[]> {
  return useQuery({
    queryKey: responsesQueryKey(formId),
    queryFn: async () =>
      z.array(responseDetailSchema).parse(
        await requestJson(`/forms/${encodeURIComponent(formId)}/responses`, {
          method: 'GET',
        }),
      ),
  });
}

/**
 * Address of the export for the **currently visible** view, in one format.
 *
 * A URL rather than a fetch, so the export can be a real link: the browser
 * then honours `Content-Disposition`, and "open in a new tab" and "save link
 * as" work the way people expect of a download. Building the file in
 * JavaScript would mean re-implementing that for no gain.
 *
 * The visible columns and the search term travel as query parameters, because
 * the requirement is that the file follows the view — and the server can only
 * follow a view it is told about.
 *
 * **The format is the extension, not a parameter** (and the route is
 * `GET :id/export.:format`): a download is saved under the last segment of its
 * URL by more than one browser and by every command-line client, so
 * `export.csv?format=xlsx` would land on disk as a workbook called
 * `export.csv`. It is typed as {@link ExportFormat} rather than as a string, so
 * the one thing that could go wrong here — a fourth spelling that no writer
 * answers to — is a compile error rather than a 400 nobody sees until the click.
 *
 * ⚠️ **One function for every format** . The row filter (`q`) and
 * the column selection are built here, once, above the format: a second URL
 * builder per format is exactly how „alle Spalten" would come to mean „alle
 * Antworten" for one of them.
 */
export function exportUrl(
  formId: string,
  format: ExportFormat,
  view: { readonly columns: readonly string[]; readonly search: string },
): string {
  const params = new URLSearchParams();
  if (view.columns.length > 0) {
    params.set('columns', view.columns.join(','));
  }
  if (view.search.trim() !== '') {
    params.set('q', view.search.trim());
  }
  const query = params.toString();
  return `/api/forms/${encodeURIComponent(formId)}/export.${format}${query === '' ? '' : `?${query}`}`;
}
