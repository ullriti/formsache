import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  AI_FAILURE_KINDS,
  buildAiFormRequest,
  type AiFormOutcome,
  type ResolvedAiConfig,
} from '@formsache/shared';

import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';
import { CONTRACT_ROWS, recordedTransport } from './recorded-answers';

/**
 * **No provider-specific type leaves the seam** (ADR-0015 no. 2).
 *
 * The ADR names the list this file is written against:
 *
 * | Provider-specific | Why it ends at the seam |
 * |---|---|
 * | `stop_reason`, `stop_details`, `finish_reason` | the meaning differs per provider; the *adapter* maps it onto `truncated`/`refused` |
 * | SDK error classes (`RateLimitError`, `SDKError`, …) | a type dependency on an SDK in the calling layer makes the second adapter impossible without anything going red |
 * | HTTP status, `retry-after`, headers, `request_id` | transport detail |
 * | the raw answer structure (`content` blocks, `choices`) | the service knows one field: `draft: unknown` |
 * | beta flags, `effort`, `output_config` | provider knobs; they belong next to their adapter |
 *
 * ## Two halves, and neither alone would do
 *
 * **Values** are caught at runtime (first describe): the outcome's key set is
 * an *equality*, and everything except `draft` is walked for a forbidden name.
 * A test that only checked „`failure` ist einer der sechs" would stay green
 * while an extra `stopReason` rode along beside it — which is exactly the
 * reproduction the requirement names.
 *
 * **Types** erase at runtime and are therefore caught at the source (second
 * describe): no file outside `apps/api/src/ai/**` may import either SDK. That
 * is the half that keeps a `catch (e: RateLimitError)` out of the service
 * this file builds — a runtime scan can never see it, because the value never travels.
 *
 * `draft` is deliberately **excluded** from the value scan: it is the model's
 * own document, and a form whose question is called „content" is a perfectly
 * good form. Scanning it would make this guard reject legitimate output, and a
 * guard that cries wolf is switched off within a week.
 */

/** Names that must never appear in an outcome, outside `draft`. */
const FORBIDDEN_KEYS = [
  'stop_reason',
  'stopReason',
  'stop_details',
  'stopDetails',
  'finish_reason',
  'finishReason',
  'status',
  'statusCode',
  'headers',
  'request_id',
  'requestId',
  'retry_after',
  'retryAfter',
  'raw',
  'rawResponse',
  'response',
  'choices',
  'content',
  'error',
];

/** The exact shape an outcome may have — an equality, not a superset. */
const OUTCOME_KEYS = {
  ok: ['draft', 'ok', 'usage'],
  failed: ['failure', 'ok', 'usage'],
} as const;

const USAGE_KEYS = ['inputTokens', 'model', 'outputTokens', 'provider'];

const REQUEST = buildAiFormRequest({
  prompt: 'Ein Formular für die Bestandsmeldung.',
  language: 'de',
});

const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: 'sk-recorded-not-a-real-key',
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

function collectKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || typeof value !== 'object' || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, into, depth + 1);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    into.add(key);
    collectKeys(nested, into, depth + 1);
  }
}

async function outcomeFor(
  provider: 'anthropic' | 'mistral',
  rowIndex: number,
): Promise<AiFormOutcome> {
  const row = CONTRACT_ROWS[rowIndex];
  if (row === undefined) {
    throw new Error(`no contract row ${String(rowIndex)}`);
  }
  const recorded = recordedTransport(
    provider === 'anthropic' ? row.anthropic : row.mistral,
  );
  const generator =
    provider === 'anthropic'
      ? new AnthropicFormGenerator(CONFIG, recorded.transport)
      : new MistralFormGenerator(
          { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
          recorded.transport,
        );
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 120);
  try {
    return await generator.generate(REQUEST, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

describe('the seam carries values of the shared type only', () => {
  const providers = ['anthropic', 'mistral'] as const;
  const rows = CONTRACT_ROWS.map((row, index) => ({ name: row.name, index }));

  for (const provider of providers) {
    it.each(rows)(`${provider}: $name`, async ({ index }) => {
      const outcome = await outcomeFor(provider, index);

      // 1. The key set of the outcome is an **equality**. A `stopReason`
      //    handed through beside `failure` fails here — the reproduction of
      //    the requirement, run and confirmed red before this line was written.
      expect(Object.keys(outcome).sort()).toEqual(
        outcome.ok ? OUTCOME_KEYS.ok : OUTCOME_KEYS.failed,
      );

      // 2. `failure` is one of the six, never a provider string.
      if (!outcome.ok) {
        expect(AI_FAILURE_KINDS).toContain(outcome.failure);
      }

      // 3. The usage sample is the one place a provider *string* may travel —
      //    the model identifier, which is data and not behaviour — and its
      //    shape is an equality too.
      if (outcome.usage !== null) {
        expect(Object.keys(outcome.usage).sort()).toEqual(USAGE_KEYS);
        expect(typeof outcome.usage.model).toBe('string');
      }

      // 4. Everything except `draft` is walked for a forbidden name.
      //
      //    Written as „the outcome, minus `draft`" rather than „the usage
      //    sample": the earlier version walked `outcome.usage` alone, which
      //    step 1 had already pinned to an exact key set — so for a failure
      //    outcome this step asserted nothing at all.
      const keys = new Set<string>();
      collectKeys(outcome.ok ? { usage: outcome.usage } : outcome, keys);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect([...keys]).not.toContain(forbidden);
      }
    });
  }
});

/**
 * **The usage sample is foreign data, and it is parsed rather than cast**
 * (`CONTRIBUTING.md`, ADR-0015 no. 7).
 *
 * It is the one value on the seam read straight off a provider answer, and the
 * Anthropic SDK types its response without validating it. So a body that
 * announces `"input_tokens": "not-a-number"` and a model identifier of arbitrary
 * length used to travel into the outcome untouched — harmless while nothing
 * consumes it, and arithmetic plus a database column from the moment usage started being persisted.
 */
describe('a malformed usage sample does not cross the seam', () => {
  it.each([
    {
      name: 'a token count that is not a number',
      usage: { input_tokens: 'not-a-number', output_tokens: 388 },
      model: 'claude-opus-5',
    },
    {
      name: 'a negative token count',
      usage: { input_tokens: -1, output_tokens: 388 },
      model: 'claude-opus-5',
    },
    {
      name: 'a model identifier that is not one',
      usage: { input_tokens: 412, output_tokens: 388 },
      model: `<script>${'x'.repeat(200)}</script>`,
    },
  ])('$name is dropped, and the outcome survives', async ({ usage, model }) => {
    const recorded = recordedTransport({
      kind: 'answer',
      status: 200,
      body: {
        id: 'msg_01RECORDED',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: '{"title":"T","pages":[]}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      },
    });
    const generator = new AnthropicFormGenerator(CONFIG, recorded.transport);

    const outcome = await generator.generate(
      REQUEST,
      new AbortController().signal,
    );

    // The observation is lost — the call and its draft are not. That is why
    // `usage` is nullable in the first place (ADR-0015 no. 2).
    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The second half: the *type* dependency, which no runtime scan can see.
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd(), '..', '..');
const SKIPPED = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.playwright',
  'test-results',
  'playwright-report',
  'blob-report',
]);
const SUFFIXES = ['.ts', '.tsx'];

/** Where an SDK import is legitimate: next to the adapter that owns it. */
const SDK_HOMES = [
  join('apps', 'api', 'src', 'ai'),
  join('apps', 'api', 'test', 'ai'),
];

function sources(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) {
        sources(join(directory, entry.name), into);
      }
      continue;
    }
    if (SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      into.push(join(directory, entry.name));
    }
  }
  return into;
}

describe('the SDKs stay inside the adapters', () => {
  it('is read from the whole repository, not from an empty set', () => {
    // Without this a wrong root would make the check below pass over nothing —
    // a guard that fails quietly is worse than none.
    expect(sources(ROOT).length).toBeGreaterThan(100);
  });

  it.each(['@anthropic-ai/sdk', '@mistralai/mistralai'])(
    'nothing outside apps/api/src/ai imports %s',
    (module) => {
      const offenders = sources(ROOT)
        .filter((file) => readFileSync(file, 'utf8').includes(module))
        .map((file) => relative(ROOT, file))
        .filter((file) => !SDK_HOMES.some((home) => file.startsWith(home)))
        .map((file) => file.split(sep).join('/'))
        .sort();

      expect(
        offenders,
        'A file outside the adapters names a provider SDK. That is the type ' +
          'dependency ADR-0015 Nr. 2 forbids: it makes the second adapter ' +
          'impossible to remove without something else going red, and no ' +
          'runtime test can see it because the type erases.',
      ).toEqual([]);
    },
  );

  it('the shared wire contract names no provider at all', () => {
    for (const file of ['ai.ts', 'ai-config.ts']) {
      const text = readFileSync(
        join(ROOT, 'packages', 'shared', 'src', file),
        'utf8',
      );
      expect(text).not.toContain('@anthropic-ai');
      expect(text).not.toContain('@mistralai');
    }
  });
});
