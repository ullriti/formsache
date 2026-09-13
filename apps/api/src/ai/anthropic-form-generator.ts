import Anthropic from '@anthropic-ai/sdk';
import { aiUsageSampleSchema } from '@formsache/shared';
import type {
  AiFormOutcome,
  AiFormRequest,
  AiUsageSample,
  ResolvedAiConfig,
} from '@formsache/shared';

import {
  AI_FORM_JSON_SCHEMA,
  AI_FORM_TOOL_DESCRIPTION,
  AI_FORM_TOOL_NAME,
} from './ai-form-json-schema';
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_SYSTEM_INSTRUCTION,
  aiUserMessage,
} from './ai-prompt';
import { AiFormGenerator, type ProviderTransport } from './ai-form-generator';
import { parseModelJson, type ParsedModelJson } from './model-json';

/**
 * **The Anthropic side of the seam** (ADR-0015 no. 1).
 *
 * Everything provider-specific ends here: `stop_reason`, the SDK's error
 * classes, HTTP status codes, the shape of `content` blocks. What leaves is
 * `AiFormOutcome` and nothing else — `test/ai/seam-types.spec.ts` is the guard
 * that turns red when something else does.
 *
 * ⚠️ **This adapter has never run against api.anthropic.com.** There is no
 * Anthropic key in this environment and there will not be one; every test it
 * passes uses a recorded HTTP answer handed in through {@link ProviderTransport}.
 * That measures the SDK's parsing, the SDK's error mapping, the SDK's retry
 * behaviour and our own mapping — it does **not** measure whether the recorded
 * answer is what the provider sends today, and it does not measure whether the
 * request below is one the API accepts. The first real measurement is the acceptance run
 * run with a configured key.
 */
export class AnthropicFormGenerator extends AiFormGenerator {
  private readonly client: Anthropic;

  /**
   * The pinned model identifier — **and deliberately not the whole config**.
   *
   * A `private readonly config` would keep the plaintext key as an own property
   * of this instance, where `util.inspect` (and therefore any log line handed
   * the adapter) reaches it at depth 1. The key goes into the SDK constructor
   * and nowhere else; the copy the SDK keeps for itself is its business, ours
   * is not to add a second one.
   */
  private readonly model: string;

  constructor(config: ResolvedAiConfig, transport?: ProviderTransport) {
    super();
    this.model = config.model;
    this.client = new Anthropic({
      /**
       * **Always explicit, never the zero-argument constructor** (ADR-0015
       * no. 5). Without an `apiKey` the SDK resolves credentials from
       * `ANTHROPIC_API_KEY`, from `ANTHROPIC_AUTH_TOKEN` and from config files
       * on disk — and then an installation with one of those set for something
       * else would quietly have a configured AI, which makes „ohne Schlüssel
       * 404" untestable. `key-confinement.spec.ts` sets `ANTHROPIC_API_KEY` in
       * the process environment and measures that it stays absent.
       */
      apiKey: config.apiKey,
      /**
       * Explicitly none, for the same reason: `authToken` has its own
       * environment fallback, and „apiKey wins" is a precedence rule of a
       * library rather than a property of this application.
       */
      authToken: null,
      /**
       * Pinned, and this is the same argument once more: the SDK reads
       * `ANTHROPIC_BASE_URL` from the process environment, so an unpinned base
       * address would let a variable that is **not** in our env contract
       * decide where our key travels.
       *
       * ⚠️ **`ANTHROPIC_CUSTOM_HEADERS` is a third environment surface, and it
       * is named here because it is not cleanly closable.** The SDK parses it
       * into `options.defaultHeaders` (`{ ...parsed, ...options.defaultHeaders }`)
       * and applies that source **after** the auth headers, so a header set
       * there overrides even `X-Api-Key`. It cannot move the target host — that
       * is what the pin above is for — and any name we spell out below wins
       * against it, but an arbitrary *new* header name cannot be enumerated in
       * advance. What it can do is send our key somewhere it does not belong on
       * a machine whose environment is already compromised; what it cannot do
       * is redirect the request.
       */
      baseURL: 'https://api.anthropic.com',
      /**
       * **Logging off, and this is a security setting, not a preference**
       * (ADR-0015 no. 10, no. 13 and Konzept no. 81).
       *
       * The client resolves its level as `options.logLevel ??
       * readEnv('ANTHROPIC_LOG') ?? 'warn'`, so this argument wins against the
       * environment. Left open, `ANTHROPIC_LOG=debug` prints the request
       * details on every call — and while this SDK *does* redact `x-api-key`,
       * `authorization` and cookies, it does **not** redact the body. The body
       * is the editor's free text, which is exactly the datum Konzept no. 81
       * promises thirty days and physical deletion for; a copy in the
       * application log knows no such deadline.
       *
       * Measured in `test/ai/debug-logging.spec.ts`, which arms the trap on a
       * bare client first so that the promise cannot pass quietly.
       */
      logLevel: 'off',
      /**
       * **What the transport says about the machine, closed** (ADR-0015 no. 13
       * point 2: what goes out is the free text and the language identifier).
       *
       * The SDK adds `X-Stainless-OS`, `-Arch` and `-Runtime-Version` to every
       * request — the host operating system, its processor architecture and the
       * exact Node version of the installation. That is not payload, but it is
       * also not nothing: it is a fingerprint of a machine an association runs,
       * handed to a third party for telemetry. A `null` value removes a header
       * in this SDK's header builder, so these three simply do not go out.
       *
       * What still travels, deliberately: `User-Agent`,
       * `X-Stainless-Lang`/`-Package-Version`/`-Runtime` and
       * `anthropic-version`. They name **our software and the protocol**, not
       * the machine, and a request without a protocol version is a request the
       * API may answer differently tomorrow.
       */
      defaultHeaders: {
        'X-Stainless-OS': null,
        'X-Stainless-Arch': null,
        'X-Stainless-Runtime-Version': null,
      },
      /**
       * **No retries** (ADR-0015 no. 6). The SDK's default is two, on
       * 408/409/429/5xx and connection errors, and it retries timeouts as
       * well — the wall clock of one call would become
       * `Zeitlimit × (Versuche + 1)`, and **one** call counted under no. 7
       * would be paid for three times. The contract table counts the attempts
       * rather than believing this line (an assumption ADR-0015 states explicitly).
       */
      maxRetries: 0,
      ...(transport === undefined
        ? {}
        : {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              transport(new Request(input, init)),
          }),
    });
  }

  /**
   * **There is nothing to resolve here — and that is the information** .
   *
   * Anthropic's models API carries `id`, `display_name` and capabilities, but
   * **no alias field**: `GET /v1/models/claude-haiku-4-5` answers with exactly
   * this identifier, not with `claude-haiku-4-5-20251001`. The mapping stands
   * in the catalogue alone, which a human reads.
   *
   * Hence `null` **without** a network call. Making one that demonstrably cannot
   * answer the question would be one request per draft for
   * nothing — and `ai_usage.model_resolved` would stay just as empty.
   */
  resolveModel(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async generate(
    request: AiFormRequest,
    signal: AbortSignal,
  ): Promise<AiFormOutcome> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: AI_MAX_OUTPUT_TOKENS,
          system: AI_SYSTEM_INSTRUCTION,
          messages: [{ role: 'user', content: aiUserMessage(request) }],
          /**
           * **Structured output, the Anthropic way** .
           *
           * There is exactly **one** tool and it grants no capability: it is
           * the shape of the answer, not something the model may *do*. Its
           * `input_schema` is `aiFormDraftSchema` rendered to JSON Schema
           * (`ai-form-json-schema.ts`) — derived, never written twice.
           *
           * The promise „der Freitext kauft keine Fähigkeiten"  is therefore no longer „the payload has no `tools`
           * key" but the sharper statement the tests now measure: the payload
           * carries this one tool, its schema is the derived one, and **no**
           * entry carries a `type` — every server-side tool of this API
           * (`web_search_*`, `code_execution_*`, `mcp_toolset`, …) is
           * identified by exactly that field. Adding one still turns the
           * structural assertion red.
           */
          tools: [
            {
              name: AI_FORM_TOOL_NAME,
              description: AI_FORM_TOOL_DESCRIPTION,
              input_schema: AI_FORM_JSON_SCHEMA,
            },
          ],
          /**
           * Forced, and forced to **one**: `tool_choice: { type: 'tool' }`
           * makes the tool the only way to answer, and
           * `disable_parallel_tool_use` means the model emits a single
           * `tool_use` block rather than several. Two blocks would raise the
           * question which of them is the form, and the answer would be a
           * heuristic in an adapter — the kind of guess this seam exists to
           * avoid.
           *
           * ⚠️ **`strict` is deliberately absent** — see
           * `ai-form-json-schema.ts` for the reasoning: the derived schema
           * carries optional properties and length/range bounds that strict
           * mode rejects, so switching it on would fail every call rather than
           * validate one. The judge is `adoptAiFormDraft`, unchanged.
           */
          tool_choice: {
            type: 'tool',
            name: AI_FORM_TOOL_NAME,
            disable_parallel_tool_use: true,
          },
        },
        { signal },
      );
    } catch (error: unknown) {
      return { ok: false, failure: this.classify(error, signal), usage: null };
    }

    const usage = this.sample(message);
    switch (message.stop_reason) {
      // `tool_use` is the expected end of a forced tool call and is the shape
      // a well-behaved answer now takes; the other two are what a model that
      // ignored the tool produces, and they are still read (see `draft`).
      case 'tool_use':
      case 'end_turn':
      case 'stop_sequence': {
        const parsed = this.draft(message);
        return parsed.ok
          ? { ok: true, draft: parsed.value, usage }
          : { ok: false, failure: 'invalid_output', usage };
      }
      case 'max_tokens':
      case 'model_context_window_exceeded':
        // Both are „the answer ended at a boundary". They are one case for the
        // reader, because the action is the same: the draft is incomplete and
        // a shorter request may help.
        return { ok: false, failure: 'truncated', usage };
      case 'refusal':
        // HTTP 200 with `stop_reason: "refusal"` — the reason `refused` exists
        // as a case of its own (ADR-0015 no. 2). Without it this would land in
        // `invalid_output` and tell the editor the model produced nonsense
        // when it declined.
        return { ok: false, failure: 'refused', usage };
      default:
        // `pause_turn` belongs to the server-side tools, which this request
        // does not carry (the one tool it offers is answered by the model
        // itself), and `null` is not a documented shape for a non-streaming
        // answer. Anything that does turn up here is the provider behaving in a
        // way this adapter does not model, which is what `unavailable` is for.
        return { ok: false, failure: 'unavailable', usage };
    }
  }

  /**
   * **The one place a message becomes `unknown`** — the tool's input if the
   * model used the tool, the text otherwise.
   *
   * The second half is not a leftover: `AI_MODEL` is operator-configurable and
   * the recorded fixtures are not a live provider, so „the model always uses
   * the forced tool" is a documented promise of an API rather than something
   * measured here. Reading the text when there is no tool block costs nothing
   * and keeps a model that answers in prose from being refused for its
   * punctuation.
   *
   * ⚠️ **Neither branch judges anything.** `block.input` is `unknown` in the
   * SDK's own typing and stays `unknown` all the way into `adoptAiFormDraft`;
   * the schema on the wire buys a better hit rate and **no** trust. Konzept no. 89
   * is explicit that the parse does not soften because a schema was sent.
   */
  private draft(message: Anthropic.Message): ParsedModelJson {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === AI_FORM_TOOL_NAME) {
        return { ok: true, value: block.input };
      }
    }
    return parseModelJson(this.text(message));
  }

  /** Concatenates the text blocks; anything else in `content` is ignored. */
  private text(message: Anthropic.Message): string {
    return message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  }

  /**
   * The observation, not the limit (ADR-0015 no. 7).
   *
   * `model` is read off the **answer**, not off the configuration: what we
   * asked for and what served us can differ, and the row in `ai_usage` should
   * say which one produced the tokens it records.
   *
   * **Parsed, not cast** (`CONTRIBUTING.md`). This SDK types its response but does
   * not validate it — `message.usage.input_tokens` is `number` because a `.d.ts`
   * says so, not because anything checked. Measured before this line existed:
   * a body with `"input_tokens": "not-a-number"` and a 200-character `model`
   * crossed the seam untouched. A sample that does not hold becomes `null`, and
   * `usage` is nullable for exactly that reason — the observation is lost, the
   * counted call is not.
   */
  private sample(message: Anthropic.Message): AiUsageSample | null {
    return (
      aiUsageSampleSchema.safeParse({
        provider: 'anthropic',
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      }).data ?? null
    );
  }

  /**
   * Maps an SDK error onto the closed failure type.
   *
   * The abort check comes **first** and is provider-independent: the only
   * `AbortSignal` this adapter ever sees is our own deadline (ADR-0015 no. 6 —
   * a browser that navigates away does *not* abort the outgoing request,
   * because the cost would then hang on a network hiccup while the counter
   * said otherwise). So an aborted signal means `timeout`, whatever shape the
   * SDK chose to throw.
   */
  private classify(
    error: unknown,
    signal: AbortSignal,
  ): 'timeout' | 'rate_limited' | 'unavailable' {
    if (signal.aborted) {
      return 'timeout';
    }
    if (error instanceof Anthropic.RateLimitError) {
      return 'rate_limited';
    }
    if (
      error instanceof Anthropic.APIConnectionTimeoutError ||
      error instanceof Anthropic.APIUserAbortError
    ) {
      return 'timeout';
    }
    // 5xx, 4xx, auth, DNS, TLS — „alles Übrige" (ADR-0015 no. 2). Nothing of
    // the provider's own wording travels with it.
    return 'unavailable';
  }
}
