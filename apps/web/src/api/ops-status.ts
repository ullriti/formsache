import { parseOpsStatus, type OpsStatus } from '@formsache/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';

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
