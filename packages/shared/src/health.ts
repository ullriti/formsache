import { z } from 'zod';

export const healthStatusSchema = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * Wire contract of `GET /api/health` — the API is mounted under the global
 * `api` prefix (`GLOBAL_API_PREFIX`). The API produces it, the web client parses
 * it — one schema, no parallel interface.
 *
 * `version` is fed from `APP_VERSION`; from milestone C onwards that value
 * comes from GitVersion and matches the image tag.
 */
export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export function parseHealthResponse(source: unknown): HealthResponse {
  return healthResponseSchema.parse(source);
}

/**
 * Wire contract of `GET /api/health/ready` — **readiness**, the other half of
 * the split ADR-0016 draws.
 *
 * ⚠️ **One boolean, and deliberately nothing else.** This route answers from
 * outside the session, so every field it carries is a field a stranger reads.
 * „Which dependency is down", „which host", „which driver error" are exactly
 * the details an operator wants and an attacker wants more; they belong in the
 * ops status behind the superadmin guard, not here. The status
 * code is the message: **200** or **503**.
 *
 * The body exists at all so that a probe which only looks at the payload — and
 * some do — cannot mistake an empty 200 for readiness.
 */
export const readinessResponseSchema = z.object({ ready: z.boolean() });
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export function parseReadinessResponse(source: unknown): ReadinessResponse {
  return readinessResponseSchema.parse(source);
}
