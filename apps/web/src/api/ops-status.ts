import {
  parseOpsStatus,
  type AckDuration,
  type OpsMetricName,
  type OpsStatus,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson } from './http';

/**
 * The operational status of the installation (ADR-0016).
 *
 * Behind the superadmin guard; for everybody else the route answers 403, and
 * the view says what that means — the visibility in the menu is comfort, the
 * boundary lies at the server.
 */
export const OPS_STATUS_QUERY_KEY = ['ops-status'] as const;

/**
 * How often the view asks again.
 *
 * ⚠️ **One minute, and that is a decision about load, not about freshness.**
 * The status counts over `mail_log`, `job_run`, `ai_usage` and the upload
 * directory; an open tab that asked every five seconds would be a continuous
 * run over four tables that nobody ordered. The figures that matter move in
 * minutes (the queue) or hours (the runs) — and the **alert** does not hang on
 * this view anyway but on the thresholds in the server.
 */
const REFETCH_MS = 60_000;

export function useOpsStatus(): UseQueryResult<OpsStatus> {
  return useQuery({
    queryKey: OPS_STATUS_QUERY_KEY,
    queryFn: async () =>
      parseOpsStatus(await requestJson('/admin/ops', { method: 'GET' })),
    refetchInterval: REFETCH_MS,
    // A tab that lies in the background measures nothing anybody reads.
    refetchIntervalInBackground: false,
  });
}

/**
 * **Quittieren und Aufheben** (ADR-0016, Fortschreibung 2026-09-16).
 *
 * Both routes answer with the whole operations status, which is written
 * straight into the cache: a redraw from the reply is one round trip shorter
 * than an invalidation, and the reply is the same document the query holds.
 */
export interface AcknowledgeVariables {
  readonly metric: OpsMetricName;
  readonly duration: AckDuration;
  /** An empty reason is not sent at all — see `useAcknowledgeAlert`. */
  readonly note: string;
}

function acknowledgementPath(metric: OpsMetricName): string {
  return `/admin/ops/alerts/${metric}/acknowledgement`;
}

export function useAcknowledgeAlert(): UseMutationResult<
  OpsStatus,
  Error,
  AcknowledgeVariables
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ metric, duration, note }: AcknowledgeVariables) =>
      parseOpsStatus(
        await requestJson(acknowledgementPath(metric), {
          method: 'POST',
          body: { duration, ...(note === '' ? {} : { note }) },
        }),
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(OPS_STATUS_QUERY_KEY, status);
    },
  });
}

export function useReleaseAlert(): UseMutationResult<
  OpsStatus,
  Error,
  OpsMetricName
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (metric: OpsMetricName) =>
      parseOpsStatus(
        await requestJson(acknowledgementPath(metric), { method: 'DELETE' }),
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(OPS_STATUS_QUERY_KEY, status);
    },
  });
}
