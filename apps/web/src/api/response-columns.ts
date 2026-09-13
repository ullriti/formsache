import type { ResponseColumnSet } from '@formsache/shared';
import { parseResponseColumnSet } from '@formsache/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';

import { requestJson } from './http';

/**
 * The columns of the responses view and the snapshots its cells render against.
 *
 * ## Why this is a query of its own
 *
 * The columns used to be derived from `FormDetail.definition` — the **draft**
 * the builder edits. Two things were wrong with that, and the client named both:
 * an unsaved experiment in the builder changed what the responses view showed,
 * and a question someone removed took the answers already given to it out of the
 * table and the export. The data was never deleted, only unreachable, which is
 * the kind of loss nobody notices until it is needed.
 *
 * The server therefore answers this from the **published versions**: the union
 * of every question ever published, active ones first and retired ones behind
 * them, plus the snapshot each row renders against. A file in its own module
 * rather than in `forms.ts`, because it is a different document about a
 * different question — `forms.ts` is the draft.
 *
 * ## Its own cache key, deliberately not a child of the answers
 *
 * `['forms', id, 'response-columns']` sits *beside* `['forms', id, 'responses']`
 * instead of underneath it. What invalidates the two is disjoint: a new answer
 * arrives without changing a single column, and publishing changes the columns
 * without adding an answer. Nesting them would tie every incoming answer to a
 * refetch of the whole version history for nothing.
 */

export function responseColumnsQueryKey(formId: string): readonly string[] {
  return ['forms', formId, 'response-columns'];
}

export function useResponseColumns(
  formId: string,
): UseQueryResult<ResponseColumnSet> {
  return useQuery({
    queryKey: responseColumnsQueryKey(formId),
    queryFn: async () =>
      parseResponseColumnSet(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/responses/columns`,
          {
            method: 'GET',
          },
        ),
      ),
  });
}
