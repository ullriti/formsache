import type {
  AiFormOutcome,
  AiFormRequest,
  ResolvedAiConfig,
} from '@formsache/shared';

/**
 * **The one seam between this application and a foreign language model**
 * (ADR-0015 no. 1).
 *
 * One method, and the list of what is deliberately missing is as much the
 * decision as the list of what is here:
 *
 * - **no `listModels()` / `estimateCost()`** — the model is a decision of the
 *   configuration, not a runtime query. An adapter that enumerates
 *   models is the first step towards a picker in the interface, and therefore
 *   towards a cost lever no guard watches;
 * - **no streaming** — the application needs *one document*, not a token
 *   stream. A stream would bring partial states there is no domain for
 *   (half a form is not a form) and a second path on which a truncated answer
 *   passes unnoticed;
 * - **no retry/backoff** — see ADR-0015 no. 6: an adapter that quietly repeats
 *   turns one counted call into three paid ones;
 * - **no tenant or user parameter** — the seam knows no Organisationen. Who may, and
 *   how much is left, is decided by the guard chain and the counter *before*
 *   the call; an adapter with tenant knowledge would be a second place where
 *   tenant logic has to stay true;
 * - **no raw access to the provider answer** (`raw`, `response`, `headers`) —
 *   that is exactly the hole through which provider-specific properties wander
 *   back in (no. 2). The service knows one field: `draft: unknown`.
 *
 * An abstract class rather than an interface plus a symbol, following
 * `FileStorage`, `MailClock` and `MailTransport`: NestJS can use the class
 * itself as the injection token, so there is one name instead of a token and a
 * type that can drift apart.
 *
 * ## Three implementations, one test table
 *
 * `AnthropicFormGenerator`, `MistralFormGenerator` and — in
 * `test/support/recorded-form-generator.ts` — `RecordedFormGenerator`. All
 * three pass `test/ai/provider-contract.spec.ts`, and **that table is the
 * actual yield of this package**: a double that only satisfies its own tests
 * proves nothing about the adapters that ship, and a second adapter pulled in
 * later is literally the shape „zweiter Schreibpfad ohne den Filter des
 * ersten" that handed a secret on twice.
 *
 * ## What `packages/shared` gets, and what it does not
 *
 * The **failure type and the request shape** (`packages/shared/src/ai.ts`),
 * because the browser has to name the cases. **Not** this class: an interface
 * the browser could implement is an invitation to call a provider from the
 * browser, and the key would have to travel for that (ADR-0015 no. 10).
 */
export abstract class AiFormGenerator {
  /**
   * Turns one free text into one draft — or into one of six named failures.
   *
   * **Returns a result, never throws.** A `throw` would carry a provider stack
   * trace and provider prose through every layer that fails to catch it;
   * `AiFormOutcome` forces the caller to switch the six cases exhaustively.
   * An implementation that lets an exception escape fails the contract table.
   *
   * `signal` is **our** deadline (`AI_REQUEST_TIMEOUT_MS`, ADR-0015 no. 6),
   * minted by the caller and passed straight through. It is not the SDK
   * client's timeout, whose default is ten minutes.
   */
  abstract generate(
    request: AiFormRequest,
    signal: AbortSignal,
  ): Promise<AiFormOutcome>;

  /**
   * **Which fixed version sits behind the configured id** — or
   * `null` when this provider does not say (2026-08-12).
   *
   * Since the selection list stands on aliases, the configured id is a
   * wandering name, and **the provider's answer reports it back instead of
   * the resolved version** (measured against `api.eu.mistral.ai`). Without this
   * method `ai_usage.model` would carry „mistral-large-latest" for all time, and
   * the question „which version ran in March?" would be unanswerable as soon as
   * the alias moves on.
   *
   * ⚠️ **`null` is a full-fledged result.** Anthropic's models API carries
   * no alias field at all — a `GET /v1/models/claude-haiku-4-5` answers
   * with exactly that id. There is nothing to resolve there, and the column stays
   * empty. An invented mapping would be worse than a missing one.
   *
   * **Does not throw, for the same reason as {@link generate}** — and in
   * addition for one of its own: this is a *side finding*. A provider that does
   * not hand out its model list must not prevent the form draft.
   *
   * **No cache, and that is a decision.** The quota
   * stands at 50 calls per Organisation and month; one additional
   * call per draft is not measurable at that order of magnitude, and it is
   * **more accurate** than any cache: it describes the state at the moment of
   * the call rather than that of the last refresh. A daily job was considered
   * and rejected — it would be a sixth background run that can go stale
   * silently, for a piece of information that already stands on the row
   * without it.
   */
  abstract resolveModel(signal: AbortSignal): Promise<string | null>;
}

/**
 * **How an adapter comes out of a resolved configuration** (ADR-0015 no. 5
 * with the addendum of 2026-08-11).
 *
 * There used to be an `AI_AVAILABLE` symbol here: a `boolean` that `AiModule`
 * bound from the environment at startup, and next to it a binding of
 * {@link AiFormGenerator} to `null` or to a finished adapter. Both worked
 * as long as the configuration no longer changed after startup time.
 *
 * **Since the move into the settings it changes while the system runs**,
 * and with that no container token can hold an answer any more: a superadmin
 * who switches the provider would otherwise get the old adapter until the next
 * restart. The adapter is therefore created **per resolution**, and what is bound
 * is the factory.
 *
 * An abstract class and not a symbol, because a test puts its double in exactly
 * here (`create-test-app.ts`): a class is a Nest token *and* a
 * type, a symbol only the first.
 */
export abstract class AiFormGeneratorFactory {
  abstract create(config: ResolvedAiConfig): AiFormGenerator;
}

/**
 * **The seam an adapter has to the network — and the only place a recorded
 * answer can enter.**
 *
 * There are no API keys in this environment, for neither provider, and there
 * will not be any: both adapters are therefore measured against *recorded*
 * HTTP answers, handed in here. Deliberately at the **transport** level rather
 * than by stubbing the SDK, because that is what makes the measurement worth
 * anything: the SDK's own error mapping, its own response parsing and — above
 * all — its own retry behaviour run in the test exactly as they run in
 * production. `provider-contract.spec.ts` counts the attempts rather than
 * believing the documentation (ADR-0015: measured, not assumed, for both SDKs).
 *
 * ⚠️ **Nothing in this repository has ever run against a live Anthropic or
 * Mistral endpoint.** Every green test about these adapters says „unsere
 * Abbildung stimmt für diese aufgezeichnete Antwort" and nothing about whether
 * the recorded answer is what the provider sends today. The fixtures are
 * hand-written from the SDKs' own response schemas; where even that left a gap
 * it is marked in `test/ai/recorded-answers.ts` as an assumption. The first
 * real measurement is the acceptance run with a configured key.
 */
export type ProviderTransport = (request: Request) => Promise<Response>;
