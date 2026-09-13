import { expect } from 'vitest';

import {
  AI_FORM_JSON_SCHEMA,
  AI_FORM_TOOL_NAME,
} from '../../src/ai/ai-form-json-schema';

/**
 * **What the two adapters are allowed to put on the wire, measured at the
 * bytes** .
 *
 * Two specs ask this: the shared contract table (`provider-contract.spec.ts`),
 * where „beide Adapter schicken das Schema" belongs because it is a promise of
 * the seam and not of one side of it, and the canary test
 * (`payload-canaries.spec.ts`), which asks the capability half of the same
 * question next to its DSGVO assertions. One place, so the two cannot drift.
 *
 * ## Why the no-capability assertion changed shape, and why it did not get weaker
 *
 * Before Konzept no. 89 the structural promise was „the payload has **no** `tools`
 * key". Anthropic's route to enforced JSON *is* `tools` + `tool_choice`, so
 * that sentence could not survive — but the thing it protected can, and more
 * sharply. What this assertion is about is that the editor's free text
 * buys the model no **capability**: nothing it can *do*, only a shape it must
 * fill in. So:
 *
 * - `functions`, `mcp_servers`, `container` stay forbidden outright;
 * - `tools`, where present, must contain **exactly one** entry, it must be the
 *   output tool, and its `input_schema` must be the derived schema — byte for
 *   byte, not „something schema-shaped";
 * - **no tool entry may carry a `type` field.** That is not decoration: every
 *   server-side tool of that API — `web_search_*`, `web_fetch_*`,
 *   `code_execution_*`, `mcp_toolset`, the bash and text-editor tools — is
 *   identified by exactly that field, and a custom tool never needs it. So
 *   „ein Werkzeug ergänzen" is still a red line here, which is the property
 *   the requirement asks for in so many words.
 */

/** The request body of one recorded HTTP attempt, as an object. */
export function outgoingPayload(
  body: string | undefined,
): Record<string, unknown> {
  expect(body).toBeDefined();
  const parsed: unknown = JSON.parse(body ?? '{}');
  expect(typeof parsed).toBe('object');
  return parsed as Record<string, unknown>;
}

/** Which provider's request shape a payload is expected to have. */
export type WireProvider = 'anthropic' | 'mistral';

/**
 * **The derived JSON schema is actually on the wire** — the assertion Konzept
 * no. 89 exists for, asked of the bytes rather than of the adapter's source.
 *
 * *Reproduction:* delete `tools`/`tool_choice` from the Anthropic adapter, or
 * `responseFormat` from the Mistral one, and the corresponding row turns red
 * (run and recorded in `docs/worklog/2026-08-10-structured-output.md`).
 */
export function expectFormSchemaOnTheWire(
  payload: Record<string, unknown>,
  provider: WireProvider,
): void {
  if (provider === 'anthropic') {
    expect(payload.tools).toEqual([
      {
        name: AI_FORM_TOOL_NAME,
        description: expect.any(String) as unknown,
        input_schema: AI_FORM_JSON_SCHEMA,
      },
    ]);
    expect(payload.tool_choice).toEqual({
      type: 'tool',
      name: AI_FORM_TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    return;
  }
  expect(payload.response_format).toEqual({
    type: 'json_schema',
    json_schema: {
      name: AI_FORM_TOOL_NAME,
      schema: AI_FORM_JSON_SCHEMA,
      strict: false,
    },
  });
}

/** Keys that would turn the request into something with capabilities. */
const FORBIDDEN_KEYS: readonly string[] = [
  'functions',
  'mcp_servers',
  'container',
];

/**
 * **The free text buys no capability** — the half of the requirement that
 * survived Konzept no. 89 unchanged in meaning, see the file comment.
 */
export function expectNoCapabilitySurface(
  payload: Record<string, unknown>,
  provider: WireProvider,
): void {
  const keys = Object.keys(payload);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys).not.toContain(forbidden);
  }

  if (provider === 'mistral') {
    // This API carries the schema in `response_format`, so the request has no
    // reason to grow a tool surface at all — and the strict form of the old
    // assertion still holds for this column.
    expect(keys).not.toContain('tools');
    expect(keys).not.toContain('tool_choice');
    return;
  }

  const tools: unknown = payload.tools;
  expect(Array.isArray(tools)).toBe(true);
  const entries = Array.isArray(tools) ? tools : [];
  expect(entries).toHaveLength(1);
  for (const entry of entries) {
    expect(typeof entry).toBe('object');
    const tool = entry as Record<string, unknown>;
    expect(tool.name).toBe(AI_FORM_TOOL_NAME);
    // The one that makes adding a server-side tool red — see the file comment.
    expect(Object.keys(tool)).not.toContain('type');
  }
}
