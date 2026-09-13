import {
  parseMailLogDetail,
  parseMailLogList,
  type MailLogDetail,
  type MailLogFilter,
  type MailLogListResponse,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';

/**
 * Server state of the mail log — TanStack Query only.
 *
 * **The filter is part of the cache key, not of a local copy of the list.** The
 * KPI tiles are filters and the form prefilter comes out of the
 * address; filtering a cached array in the browser would show
 * counters computed over the rows that happen to be loaded, while the server
 * counts over the whole organisation. Two answers to „wie viele sind fehlgeschlagen?"
 * is exactly the drift this project keeps paying for, so there is one: the
 * server's.
 */

/** Prefix every mail-log query shares — what a retry invalidates. */
const MAIL_LOG_QUERY_ROOT = ['mail-log'] as const;

export function mailLogQueryKey(filter: MailLogFilter): readonly unknown[] {
  return [
    ...MAIL_LOG_QUERY_ROOT,
    filter.status ?? 'all',
    filter.formId ?? 'all',
  ];
}

/** The log with its four counters, narrowed by status and/or form. */
export function useMailLog(
  filter: MailLogFilter,
): UseQueryResult<MailLogListResponse> {
  return useQuery({
    queryKey: mailLogQueryKey(filter),
    /**
     * The previous answer stays on screen while the next one is fetched.
     *
     * Without it every click on a KPI tile is a new cache key, so the query
     * goes back to `pending` and the view falls to „wird geladen…" — the tiles
     * themselves disappear, and the filter one just pressed vanishes with them.
     * The numbers shown for that moment are the old ones, which is exactly what
     * a filter change means: they are still the organisation's counters, and the next
     * payload carries the same four.
     */
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const query = new URLSearchParams();
      if (filter.status !== undefined) {
        query.set('status', filter.status);
      }
      if (filter.formId !== undefined) {
        query.set('formId', filter.formId);
      }
      const search = query.toString();

      return parseMailLogList(
        await requestJson(`/mail-log${search === '' ? '' : `?${search}`}`, {
          method: 'GET',
        }),
      );
    },
  });
}

/**
 * One line **with the mail as it was rendered**.
 *
 * `enabled` is the caller's choice, not this hook's: the detail panel of
 * `MailLogView.tsx` only opens for one row at a time, and a query that fired
 * for a row nobody is looking at would ask a route whose payload carries
 * answer values (`mail-log.controller.ts`) for no reason to show them.
 *
 * A `mail-log` cache key, not `mail-log-detail`: the retry mutation
 * invalidates the whole `['mail-log']` prefix (Konzept no. 31 — one line, one
 * requeue), and a row's detail is stale in exactly the same situations its
 * entry in the list is.
 */
export function useMailLogDetail(
  id: string | null,
): UseQueryResult<MailLogDetail> {
  return useQuery({
    queryKey: [...MAIL_LOG_QUERY_ROOT, 'detail', id],
    enabled: id !== null,
    queryFn: async () =>
      parseMailLogDetail(
        await requestJson(`/mail-log/${encodeURIComponent(id ?? '')}`, {
          method: 'GET',
        }),
      ),
  });
}

/**
 * „↻ Erneut" on one failed line — 204, no body.
 *
 * **Every** mail-log query is invalidated afterwards, not only the one on
 * screen. The row leaves „Fehlgeschlagen" and joins „In Warteschlange", so both
 * the table *and* the tiles above it are stale — and so is the log under every
 * other filter. The server answers without a body for precisely this reason
 * (`mail-log.controller.ts`): there is no single entry that could be patched
 * into place without the numbers drifting away from the row.
 *
 * `retry: false`: the route is rate limited to 30 a minute, and an automatic
 * repeat would spend that budget on a request the server already answered.
 */
export function useRetryMailLogEntry(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (entryId: string) =>
      requestVoid(`/mail-log/${encodeURIComponent(entryId)}/retry`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MAIL_LOG_QUERY_ROOT });
    },
  });
}
