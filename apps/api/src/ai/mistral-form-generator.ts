import { HTTPClient, Mistral } from '@mistralai/mistralai';
import { aiUsageSampleSchema } from '@formsache/shared';
import type {
  AiFailureKind,
  AiFormOutcome,
  AiFormRequest,
  AiUsageSample,
  ResolvedAiConfig,
} from '@formsache/shared';

import { AI_FORM_JSON_SCHEMA, AI_FORM_TOOL_NAME } from './ai-form-json-schema';
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_SYSTEM_INSTRUCTION,
  aiUserMessage,
} from './ai-prompt';
import { AiFormGenerator, type ProviderTransport } from './ai-form-generator';
import { pinnedMistralModelInList } from './mistral-model-alias';
import { parseModelJson } from './model-json';

/**
 * A logger that discards everything — the object whose mere presence keeps this
 * SDK from reaching for the global console object; the constructor below says
 * why that matters. It satisfies the SDK's `Logger` shape structurally
 * (`group`, `groupEnd`, `log`) — the type itself is not imported, because its
 * subpath does not resolve under the API's `moduleResolution`.
 */
const SILENT_LOGGER = {
  group: (): void => undefined,
  groupEnd: (): void => undefined,
  log: (): void => undefined,
};

/**
 * **The Mistral side of the seam** — the second consumer that makes the seam
 * more than a name (ADR-0015 no. 1).
 *
 * It exists in the same round as the Anthropic one on purpose: a second
 * adapter pulled in later is the shape „zweiter Schreibpfad ohne den Filter
 * des ersten", which handed a secret on twice. The proof that the seam
 * holds is that **the same table** in `test/ai/provider-contract.spec.ts` runs
 * against both columns and expects the same `AiFailureKind` per row.
 *
 * ⚠️ **This adapter has never run against api.mistral.ai**, and it carries one
 * more unknown than its Anthropic counterpart: the provider documentation was
 * not reachable from this environment on 2026-08-06 (HTTP 403), so the
 * recorded answers are reconstructed from the **SDK's own response schemas**
 * rather than from an observed exchange. Where even the SDK left a gap it is
 * marked below and in `test/ai/recorded-answers.ts`.
 */
export class MistralFormGenerator extends AiFormGenerator {
  private readonly client: Mistral;

  /**
   * The pinned model identifier — **and deliberately not the whole config**.
   *
   * A `private readonly config` would keep the plaintext key as an own property
   * of this instance, where `util.inspect` (and therefore any log line that is
   * handed the adapter) reaches it at depth 1. The key goes into the SDK
   * constructor and nowhere else; the copy the SDK keeps for itself is its
   * business, ours is not to add a second one.
   */
  private readonly model: string;

  constructor(config: ResolvedAiConfig, transport?: ProviderTransport) {
    super();
    this.model = config.model;
    this.client = new Mistral({
      /**
       * **Always explicit** (ADR-0015 no. 5) — the same reason as on the
       * Anthropic side, and here it is not a documentation claim but a line of
       * this SDK: `lib/security.ts` resolves `security?.apiKey ??
       * env().MISTRAL_API_KEY`. Without this argument a machine with
       * `MISTRAL_API_KEY` set for something else would have a configured AI.
       */
      apiKey: config.apiKey,
      /**
       * **Where this provider is called** — a choice out of three values with
       * `eu` as the default, hard-wired before that.
       *
       * This SDK offers exactly three servers in `lib/config.ts` — `global`,
       * `eu` and `us` —, and the data protection promise demands EU hosting.
       * Hence **an enum and never a free address**: a URL field would turn the
       * data protection promise of ADR-0015 no. 13 into a supposition, and
       * `z.string().url()` would have been the convenient way to exactly that.
       * If the line is missing, `eu` applies — not „the first region found",
       * otherwise a fresh installation would process outside the EU without
       * anybody having set anything.
       *
       * That the choice is **selectable** is not a softening of the promise but
       * its condition: the only lever of an operator whose pinned model lies
       * outside the EU was to switch the feature off entirely. Now it is a
       * deliberate, visible decision with an explanatory text at the field —
       * and the Verarbeitungsverzeichnis lists it as the field that bears on
       * the third-country question.
       *
       * ⚠️ **What even that does not promise:** whether the EU endpoint serves
       * the same models as the global one cannot be checked from here — the
       * provider documentation answers from this environment with HTTP 403. A
       * pinned model that exists only globally fails at the first call.
       */
      server: config.region,
      /**
       * **No retries** (ADR-0015 no. 6). `none` also happens to be this SDK's
       * default — written out anyway, because a default is a property of a
       * dependency and this is a promise of the application. The contract table
       * counts the attempts either way (an assumption ADR-0015 states explicitly).
       */
      retryConfig: { strategy: 'none' },
      /**
       * **The debug logger is closed, and this is a security fix, not tidiness**
       * (ADR-0015 no. 10 „nie protokolliert", no. 13).
       *
       * `lib/sdks.js` reads `this._options.debugLogger` **first** and only falls
       * back to `console` when it is absent *and* `MISTRAL_DEBUG` is set — so a
       * truthy object here switches the branch off before the environment is
       * consulted. Without it, `logRequest` prints **every header verbatim**,
       * `authorization: Bearer <key>` included, plus the body with the free
       * text.
       *
       * Two things make this worse than an ordinary debug switch and are the
       * reason it is closed rather than documented:
       *
       * 1. **`MISTRAL_DEBUG` is `z.coerce.boolean()`** in `lib/env.ts`, so the
       *    string `"false"` coerces to `true`. Whoever switches it off switches
       *    it on.
       * 2. **No guard of this repository can see it.** The scan in
       *    `key-confinement.spec.ts` reads our own files for `console`/`Logger`;
       *    this logger lives in `node_modules`.
       *
       * Measured in `test/ai/debug-logging.spec.ts`, which arms the trap on a
       * bare client first so that the promise cannot pass quietly.
       */
      debugLogger: SILENT_LOGGER,
      ...(transport === undefined
        ? {}
        : { httpClient: new HTTPClient({ fetcher: transport }) }),
    });
  }

  /**
   * **The pinned version behind the configured id** .
   *
   * The only one of the two providers that says it at all: its model list
   * gives the names that belong together for every entry — **symmetrically**,
   * though, so without giving away which of them is the pinned one. The
   * decision is made by `pinnedMistralModel` on the shape of the id; the
   * reasoning, including the measured table, stands there.
   *
   * **Catches everything and returns `null`.** A side finding must not prevent
   * the form draft — and a provider that is not handing out its model list at
   * the moment is no reason to let a call fail that works completely without
   * this piece of information.
   */
  async resolveModel(signal: AbortSignal): Promise<string | null> {
    try {
      const list = await this.client.models.list(undefined, {
        fetchOptions: { signal },
      });
      return pinnedMistralModelInList(list, this.model);
    } catch {
      return null;
    }
  }

  async generate(
    request: AiFormRequest,
    signal: AbortSignal,
  ): Promise<AiFormOutcome> {
    let response: Awaited<ReturnType<Mistral['chat']['complete']>>;
    try {
      response = await this.client.chat.complete(
        {
          model: this.model,
          maxTokens: AI_MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: AI_SYSTEM_INSTRUCTION },
            { role: 'user', content: aiUserMessage(request) },
          ],
          /**
           * **Structured output, the Mistral way** .
           *
           * The same derived schema the Anthropic adapter puts in its tool
           * (`ai-form-json-schema.ts`) — one rendering, two providers, and the
           * shared contract table asserts both of them actually send it.
           *
           * **No `tools` key here, and that is not an oversight:** this API
           * carries a `response_format`, so the schema travels without the
           * request growing a tool surface at all. The assertion for this
           * column is therefore still the strict one — `tools` absent.
           *
           * ⚠️ **`strict: false`, written out rather than left to a default.**
           * Strict mode on this API is the OpenAI-shaped one: every object
           * closed with `additionalProperties: false` and every property in
           * `required`. The derived form has genuinely optional fields and
           * carries length and range bounds, so `strict: true` would be a
           * rejected request on every call rather than a validated one — and
           * with the provider documentation unreachable from here (HTTP 403,
           * 2026-08-06) and no key to measure with, guessing otherwise would
           * trade a working hint for a broken adapter. The judge is
           * `adoptAiFormDraft` either way.
           */
          responseFormat: {
            type: 'json_schema',
            jsonSchema: {
              name: AI_FORM_TOOL_NAME,
              schemaDefinition: AI_FORM_JSON_SCHEMA,
              strict: false,
            },
          },
        },
        { signal, retries: { strategy: 'none' } },
      );
    } catch (error: unknown) {
      return { ok: false, failure: classify(error, signal), usage: null };
    }

    const usage = sample(response.model, response.usage);
    const choice = response.choices[0];
    if (choice === undefined) {
      return { ok: false, failure: 'unavailable', usage };
    }

    switch (choice.finishReason) {
      case 'stop': {
        const parsed = parseModelJson(textOf(choice.message?.content));
        return parsed.ok
          ? { ok: true, draft: parsed.value, usage }
          : { ok: false, failure: 'invalid_output', usage };
      }
      case 'length':
      case 'model_length':
        return { ok: false, failure: 'truncated', usage };
      /**
       * ⚠️ **Assumption, and it is the weakest line of this file.**
       *
       * `finishReason` is an *open* enum in this SDK, so a value the schema
       * does not list passes through as a plain string. `content_filter` is
       * the value this adapter maps to `refused` — reconstructed from the
       * convention of the OpenAI-shaped chat API that Mistral follows, **not**
       * observed against the provider and not listed by the SDK.
       *
       * What it costs if the guess is wrong: a Mistral refusal lands in
       * `unavailable` instead of `refused`, so the editor is told „gerade
       * nicht erreichbar" where the truth is „abgelehnt" — a wrong sentence,
       * not a wrong state, and the call is counted either way. Verified by the
       * first refusal observed in the acceptance run; until then this comment is the
       * finding.
       */
      case 'content_filter':
        return { ok: false, failure: 'refused', usage };
      default:
        // `error`, `tool_calls` (we send no tools) and anything the open enum
        // lets through.
        return { ok: false, failure: 'unavailable', usage };
    }
  }
}

/** The text of an assistant message, whichever of the two shapes it has. */
function textOf(
  content: string | readonly unknown[] | null | undefined,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === null || content === undefined) {
    return '';
  }
  return content
    .map((chunk) => {
      if (typeof chunk !== 'object' || chunk === null) {
        return '';
      }
      const record = chunk as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .join('');
}

/**
 * The observation, not the limit (ADR-0015 no. 7).
 *
 * **Parsed, not cast** (`CONTRIBUTING.md`), and the same shape as on the Anthropic
 * side so the seam carries one kind of value. Worth naming rather than
 * mirroring silently: this SDK is Speakeasy-generated and has **already**
 * validated the answer with Zod by the time we get here, while the Anthropic
 * SDK only types it. The two adapters therefore do not have the same trust in
 * their wire, and the shared contract table says nothing about that — so the
 * parse stands on both sides, where it costs nothing and removes the question.
 */
function sample(
  model: string,
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
  },
): AiUsageSample | null {
  return (
    aiUsageSampleSchema.safeParse({
      provider: 'mistral',
      model,
      inputTokens: usage.promptTokens ?? null,
      outputTokens: usage.completionTokens ?? null,
    }).data ?? null
  );
}

/**
 * Maps a thrown value onto the closed failure type.
 *
 * **Read off the error's public fields rather than off its class**, and that
 * is a deliberate trade: this SDK exports its error classes only through the
 * subpath `@mistralai/mistralai/models/errors`, which the API's
 * `moduleResolution: "Node"` does not resolve — an `instanceof` here would
 * cost a resolution mode change for the whole workspace. `statusCode` on
 * `MistralError` and `name` on `HTTPClientError` are both public, documented
 * fields of this SDK's generated code.
 *
 * The price is named rather than hidden: a renamed error class would land
 * here as `unavailable` instead of `timeout`. The contract table exercises
 * both shapes through the transport, so a rename shows up as a red row rather
 * than as a wrong sentence in production.
 */
function classify(error: unknown, signal: AbortSignal): AiFailureKind {
  // Provider-independent and first: the only `AbortSignal` this adapter ever
  // sees is our own deadline (ADR-0015 no. 6).
  if (signal.aborted) {
    return 'timeout';
  }
  if (statusOf(error) === 429) {
    return 'rate_limited';
  }
  const name = nameOf(error);
  if (
    name === 'RequestTimeoutError' ||
    name === 'RequestAbortedError' ||
    name === 'TimeoutError' ||
    name === 'AbortError'
  ) {
    return 'timeout';
  }
  return 'unavailable';
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}

function nameOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return '';
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}
