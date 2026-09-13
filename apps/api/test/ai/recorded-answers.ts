import type { AiFailureKind, AiFormOutcome } from '@formsache/shared';

import { AI_FORM_TOOL_NAME } from '../../src/ai/ai-form-json-schema';
import type { ProviderTransport } from '../../src/ai/ai-form-generator';

/**
 * **The recorded answers both adapters are measured against.**
 *
 * ⚠️ **Not one byte of this file was observed against a live provider.** There
 * is no Anthropic key and no Mistral key in this environment, and there will
 * not be one — that is a deliberate choice, not an omission. The
 * bodies below are written by hand from the two SDKs' own response schemas
 * (`@anthropic-ai/sdk` `Messages.Message`, `@mistralai/mistralai`
 * `ChatCompletionResponse$inboundSchema`), which is the strongest evidence
 * available here: a body that did not match would be rejected by the SDK's own
 * parser before our mapping ever ran.
 *
 * What that buys, precisely:
 *
 * - ✅ our mapping from a given wire answer to `AiFormOutcome`;
 * - ✅ the SDKs' own parsing, error classes and — measured, not believed —
 *   their retry behaviour (ADR-0015 assumption A4);
 * - ❌ whether these bodies are what the providers send **today**;
 * - ❌ whether the request either adapter builds is one the API accepts.
 *
 * The last two are first measured in a live run with a configured key. Where
 * even the SDK schema left the shape open, the entry carries its own ⚠️.
 */

/**
 * **The draft a successful recorded answer carries** — and it
 * is a document the pipeline actually accepts.
 *
 * It used to be `{ title, pages: [] }`, a stand-in that nothing parsed. Once
 * `adoptAiFormDraft` existed, that placeholder was a form with no page and
 * would have been refused, so the success row could never have been carried
 * through to a *published* form. It is written the way a model is asked to
 * answer: **no `id` anywhere** (ADR-0015 no. 3(a) — ids are minted on
 * adoption), a condition that names its source by **position**, and the free
 * `title` a model volunteers and the derived form drops.
 *
 * ⚠️ Same standing caveat as the rest of this file: this is what a *good*
 * answer looks like by our own schema, not an answer any provider has ever
 * sent.
 */
export const RECORDED_DRAFT = {
  title: 'Bestandsmeldung',
  pages: [
    {
      title: 'Bestandsmeldung',
      description: null,
      questions: [
        {
          type: 'text',
          label: 'Name',
          hint: null,
          required: true,
          width: 'full',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
        {
          type: 'select',
          label: 'Anreise',
          hint: null,
          required: false,
          width: 'full',
          options: [
            { value: 'bahn', label: 'Bahn' },
            { value: 'auto', label: 'Auto' },
          ],
          allowOther: false,
          otherLabel: null,
        },
        {
          type: 'text',
          label: 'Mitfahrgelegenheit',
          hint: null,
          required: false,
          width: 'full',
          minLength: null,
          maxLength: null,
          pattern: null,
          // The source is question **1** of the document („Anreise") — a
          // position, because a draft has no ids to point at.
          visibleIf: { operator: 'equals', value: 'bahn', questionIndex: 1 },
        },
      ],
    },
  ],
};

const RECORDED_DRAFT_TEXT = JSON.stringify(RECORDED_DRAFT);

/** How a transport behaves for one row of the contract table. */
export type RecordedBehaviour =
  /** One HTTP answer, replayed on every attempt. */
  | { readonly kind: 'answer'; readonly status: number; readonly body: unknown }
  /**
   * The connection never answers. Rejects the moment the request's own
   * `AbortSignal` fires — which is what a real `fetch` does, and what makes
   * the `timeout` row measure our deadline rather than a stub's stopwatch.
   */
  | { readonly kind: 'hang' }
  /**
   * The first attempt answers `status`, every later one answers 200 with a
   * usable draft. **The retry probe**: an adapter that repeats would succeed
   * here, so a green `rate_limited` plus `attempts === 1` is the measurement
   * of `maxRetries: 0`.
   */
  | {
      readonly kind: 'then-ok';
      readonly status: number;
      readonly body: unknown;
      /** What a *second* attempt would get: a usable draft, in this
       * provider's own shape. That is what makes the probe sharp — an adapter
       * that retried would report `ok`, not `rate_limited`. */
      readonly retryBody: unknown;
    }
  /**
   * The connection rejects — no HTTP answer at all. Built per attempt so the
   * row is replayable, and typed as `Error` so the transport can `throw` it.
   */
  | { readonly kind: 'reject'; readonly error: () => Error };

/** One row of the table: the same expectation for all three subjects. */
export interface ContractRow {
  readonly name: string;
  /** `'ok'` or the one `AiFailureKind` every subject has to produce. */
  readonly expected: 'ok' | AiFailureKind;
  readonly anthropic: RecordedBehaviour;
  readonly mistral: RecordedBehaviour;
  /** What the recording double is scripted with for this row. */
  readonly double: AiFormOutcome;
}

function anthropicMessage(overrides: {
  readonly text?: string;
  readonly stopReason: string;
}): unknown {
  return {
    id: 'msg_01RECORDED',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: overrides.text ?? RECORDED_DRAFT_TEXT }],
    stop_reason: overrides.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 412, output_tokens: 388 },
  };
}

/**
 * **The shape a forced tool call comes back in** .
 *
 * Since the Anthropic adapter offers one tool and forces it, a *good* answer
 * is no longer a text block with JSON in it: it is `stop_reason: "tool_use"`
 * and a `tool_use` block whose `input` the SDK has already turned into an
 * object. The text form is not gone from this file — the `invalid_output` row
 * still uses it, which is what keeps the adapter's fallback path measured.
 *
 * ⚠️ Same standing caveat as everything here: written from the SDK's own
 * `ToolUseBlock` (`id`, `caller`, `input`, `name`, `type`), never observed
 * against api.anthropic.com.
 */
function anthropicToolUse(input: unknown): unknown {
  return {
    id: 'msg_01RECORDED',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01RECORDED',
        caller: { type: 'direct' },
        name: AI_FORM_TOOL_NAME,
        input,
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 412, output_tokens: 388 },
  };
}

function anthropicError(type: string, message: string): unknown {
  return { type: 'error', error: { type, message } };
}

function mistralCompletion(overrides: {
  readonly text?: string;
  readonly finishReason: string;
}): unknown {
  return {
    id: 'cmpl-recorded',
    object: 'chat.completion',
    model: 'mistral-recorded-0000',
    created: 1_780_000_000,
    usage: { prompt_tokens: 401, completion_tokens: 377, total_tokens: 778 },
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: overrides.text ?? RECORDED_DRAFT_TEXT,
        },
        finish_reason: overrides.finishReason,
      },
    ],
  };
}

function mistralError(message: string): unknown {
  return { object: 'error', message, type: 'error', param: null, code: null };
}

const okUsage = {
  anthropic: {
    provider: 'anthropic' as const,
    model: 'claude-opus-5',
    inputTokens: 412,
    outputTokens: 388,
  },
  mistral: {
    provider: 'mistral' as const,
    model: 'mistral-recorded-0000',
    inputTokens: 401,
    outputTokens: 377,
  },
};

/**
 * **The table.** Eight rows — the four the requirement names, the two extra
 * failure kinds of ADR-0015 no. 2, the success case and the provider-side
 * timeout — and every row runs against **both** adapters and the double.
 */
export const CONTRACT_ROWS: readonly ContractRow[] = [
  {
    name: 'success — a JSON document comes back',
    expected: 'ok',
    anthropic: {
      kind: 'answer',
      status: 200,
      body: anthropicToolUse(RECORDED_DRAFT),
    },
    mistral: {
      kind: 'answer',
      status: 200,
      body: mistralCompletion({ finishReason: 'stop' }),
    },
    double: { ok: true, draft: RECORDED_DRAFT, usage: okUsage.anthropic },
  },
  {
    name: 'timeout — our deadline expires while the provider is silent',
    expected: 'timeout',
    anthropic: { kind: 'hang' },
    mistral: { kind: 'hang' },
    double: { ok: false, failure: 'timeout', usage: null },
  },
  {
    name: 'rate_limited — the provider says 429',
    expected: 'rate_limited',
    anthropic: {
      kind: 'then-ok',
      status: 429,
      body: anthropicError('rate_limit_error', 'Too many requests'),
      retryBody: anthropicToolUse(RECORDED_DRAFT),
    },
    mistral: {
      kind: 'then-ok',
      status: 429,
      body: mistralError('Requests rate limit exceeded'),
      retryBody: mistralCompletion({ finishReason: 'stop' }),
    },
    double: { ok: false, failure: 'rate_limited', usage: null },
  },
  {
    /**
     * The Anthropic column answers with **text** here, not a tool call — a
     * model that ignored the forced tool and narrated instead. That is the row
     * keeping the adapter's text fallback measured (`AnthropicFormGenerator.draft`):
     * without it, no row would ever reach `parseModelJson` in that column.
     */
    name: 'invalid_output — the answer is not a JSON document',
    expected: 'invalid_output',
    anthropic: {
      kind: 'answer',
      status: 200,
      body: anthropicMessage({
        stopReason: 'end_turn',
        text: 'Gern! Hier ist dein Formular: … (kein JSON)',
      }),
    },
    mistral: {
      kind: 'answer',
      status: 200,
      body: mistralCompletion({
        finishReason: 'stop',
        text: 'Gern! Hier ist dein Formular: … (kein JSON)',
      }),
    },
    double: { ok: false, failure: 'invalid_output', usage: null },
  },
  {
    name: 'truncated — the answer ended at the token boundary',
    expected: 'truncated',
    anthropic: {
      kind: 'answer',
      status: 200,
      body: anthropicMessage({
        stopReason: 'max_tokens',
        text: '{"title":"Semesterrück',
      }),
    },
    mistral: {
      kind: 'answer',
      status: 200,
      body: mistralCompletion({
        finishReason: 'length',
        text: '{"title":"Semesterrück',
      }),
    },
    double: { ok: false, failure: 'truncated', usage: null },
  },
  {
    name: 'refused — the provider declined the request',
    expected: 'refused',
    anthropic: {
      // HTTP 200 with `stop_reason: "refusal"` — documented in the SDK's own
      // `StopReason` union, so this shape is as evidenced as anything here.
      kind: 'answer',
      status: 200,
      body: anthropicMessage({ stopReason: 'refusal', text: '' }),
    },
    mistral: {
      /**
       * ⚠️ **The weakest fixture of this file.** `finish_reason` is an *open*
       * enum in the Mistral SDK, so `content_filter` passes through as a plain
       * string — but the SDK does not list it and the provider documentation
       * was unreachable (HTTP 403) on 2026-08-06. The value is taken from the
       * convention of the OpenAI-shaped chat API Mistral follows.
       *
       * If it is wrong, a Mistral refusal lands in `unavailable`: a wrong
       * sentence for the editor, not a wrong state, and the call is
       * counted either way. To be confirmed at the first observed refusal.
       */
      kind: 'answer',
      status: 200,
      body: mistralCompletion({ finishReason: 'content_filter', text: '' }),
    },
    double: { ok: false, failure: 'refused', usage: null },
  },
  /**
   * **The row that makes the name branch of `classify` reachable at all.**
   *
   * The `timeout` row above lets *our own* deadline fire, and `classify` asks
   * `signal.aborted` first — so it returns before the SDK's error ever gets
   * looked at. Measured: deleting the timeout detection from **both** adapters
   * left the whole suite green, which means the comment „ein Rename zeigt sich
   * als rote Zeile" was describing a branch no row entered.
   *
   * Here the transport rejects with a timeout-shaped error while our signal is
   * **not** aborted — the shape of a connection that gave up on its own, or of
   * an SDK-internal deadline. That is the only way into the branch, and it is
   * therefore the only place a renamed error class shows up as red.
   */
  {
    name: 'timeout — the connection times out while our deadline still runs',
    expected: 'timeout',
    // **The same error in both columns**, and that is the point: what `fetch`
    // rejects with on its own deadline is a `TimeoutError` either way. Each SDK
    // then does its own thing with it — Anthropic raises
    // `APIConnectionTimeoutError` (a class the adapter reads with
    // `instanceof`), Mistral wraps it into `RequestTimeoutError` (a name the
    // adapter reads off the object). Both readings have to arrive at
    // `timeout`, and a rename on either side now shows up here.
    anthropic: {
      kind: 'reject',
      error: () => new DOMException('The operation timed out.', 'TimeoutError'),
    },
    mistral: {
      kind: 'reject',
      error: () => new DOMException('The operation timed out.', 'TimeoutError'),
    },
    double: { ok: false, failure: 'timeout', usage: null },
  },
  {
    name: 'unavailable — the provider is down',
    expected: 'unavailable',
    anthropic: {
      kind: 'answer',
      status: 503,
      body: anthropicError('overloaded_error', 'Overloaded'),
    },
    mistral: {
      kind: 'answer',
      status: 503,
      body: mistralError('Service unavailable'),
    },
    double: { ok: false, failure: 'unavailable', usage: null },
  },
];

/** What the two adapters must report as usage on the success row. */
export const RECORDED_OK_USAGE = okUsage;

/**
 * One HTTP answer per provider, carrying **this** document as the model's
 * output — in each provider's own successful shape.
 *
 * It exists for the assertion Konzept no. 89 asks for by name: a document that the
 * providers accepted the schema for and that still does not fit `formSchema`
 * must be refused. Building it here rather than in the spec keeps the two
 * wire shapes in the one file that owns them.
 */
export function recordedAnswerCarrying(draft: unknown): {
  readonly anthropic: RecordedBehaviour;
  readonly mistral: RecordedBehaviour;
} {
  return {
    anthropic: { kind: 'answer', status: 200, body: anthropicToolUse(draft) },
    mistral: {
      kind: 'answer',
      status: 200,
      body: mistralCompletion({
        finishReason: 'stop',
        text: JSON.stringify(draft),
      }),
    },
  };
}

/** A transport that replays one {@link RecordedBehaviour} and counts attempts. */
export function recordedTransport(behaviour: RecordedBehaviour): {
  readonly transport: ProviderTransport;
  /** How many HTTP attempts the SDK actually made — the A4 measurement. */
  attempts: () => number;
  /** The bodies that went out, in order — what the no-capability assertion measures. */
  bodies: () => readonly string[];
} {
  let attempts = 0;
  const bodies: string[] = [];

  const transport: ProviderTransport = async (request) => {
    attempts += 1;
    bodies.push(await request.clone().text());

    if (behaviour.kind === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (request.signal.aborted) {
          abort();
          return;
        }
        request.signal.addEventListener('abort', abort, { once: true });
      });
    }

    if (behaviour.kind === 'reject') {
      throw behaviour.error();
    }

    if (behaviour.kind === 'then-ok' && attempts > 1) {
      return jsonResponse(200, behaviour.retryBody);
    }

    return jsonResponse(behaviour.status, behaviour.body);
  };

  return { transport, attempts: () => attempts, bodies: () => bodies };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
