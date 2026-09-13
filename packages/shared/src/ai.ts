import { z } from 'zod';

import { aiQuotaSchema, type AiQuota } from './ai-usage.ts';
import { formDefinitionSchema } from './form-schema.ts';

/**
 * **The wire contract of the AI seam** (ADR-0015 no. 1 and no. 2).
 *
 * What lives here is the **failure type and the request shape**, and
 * deliberately *not* the `AiFormGenerator` interface itself. The difference to
 * `FileStorage` (ADR-0014 no. 1, server-side only) is that the browser has to
 * be able to *name* the failure cases: the dialogue shows a different sentence
 * per case and says whether a second attempt helps. Two enumerations for that
 * would be exactly the drift `pickDefaultColumns` was shared against.
 *
 * The interface stays in `apps/api/src/ai/`, because an interface the browser
 * can implement is an invitation to call a provider from the browser — and the
 * key would have to travel for that (ADR-0015 no. 10).
 */

/**
 * The language a generated form is written in.
 *
 * A closed enumeration with exactly one member today, and it is a **named
 * place** rather than a constant baked into the system instruction (ADR-0015
 * no. 4): the alternative would reopen the question „what goes out?" at the
 * next language wish, and that question has a schema-completeness test attached to it.
 */
export const formLanguageSchema = z.enum(['de']);
export type FormLanguage = z.infer<typeof formLanguageSchema>;

/** The two providers this application supports — no third without its own ADR. */
export const aiProviderSchema = z.enum(['anthropic', 'mistral']);
export type AiProvider = z.infer<typeof aiProviderSchema>;

/**
 * Upper bound of the free text an editor may send, in characters
 * (ADR-0015 no. 4).
 *
 * Shared rather than duplicated because three places read it: the input field
 * (UX), the server (truth), and the retention notice about what lies with us
 * for 30 days (no. 8). The prototype's three examples are one to three
 * sentences; 2000 is far above that and still bounds both the bill and the
 * size of what we store.
 */
export const AI_PROMPT_MAX = 2000;

/**
 * **Everything that leaves this installation** (ADR-0015 no. 4).
 *
 * Two values, and the type is the promise: no tenant, no user, no existing
 * form, no answer. Whatever an adapter sends is either this object or
 * *static* — the system instruction, the model id, the token ceiling.
 *
 * `readonly` throughout so a caller cannot decorate it on the way to the
 * adapter. Three things measure it: the key-set assertion in `ai.test.ts`, the
 * payload check of the contract table, and the **canary search** in
 * `apps/api/test/ai/payload-canaries.spec.ts`: an organisation, a user, a form and a
 * submitted answer seeded with unmistakable strings, none of which appears in
 * the serialised payload or on the HTTP body. That guarantee carries forward
 * to the route.
 */
export interface AiFormRequest {
  readonly prompt: string;
  readonly language: FormLanguage;
}

/**
 * Builds the outgoing payload — the **one** place it comes into being.
 *
 * A function rather than an object literal at the call site, so that „was geht
 * hinaus?" has a single answer to read and a single place to break when
 * somebody adds a field. It trims and enforces {@link AI_PROMPT_MAX}; a longer
 * text is rejected here rather than truncated, because a silently shortened
 * prompt produces a form nobody asked for.
 */
export function buildAiFormRequest(input: {
  readonly prompt: string;
  readonly language: FormLanguage;
}): AiFormRequest {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new Error('AiFormRequest: prompt is empty');
  }
  if (prompt.length > AI_PROMPT_MAX) {
    throw new Error(
      `AiFormRequest: prompt exceeds ${String(AI_PROMPT_MAX)} characters`,
    );
  }
  return { prompt, language: formLanguageSchema.parse(input.language) };
}

/**
 * **The closed failure type** (ADR-0015 no. 2).
 *
 * Six cases, and the closedness is the point: an open enumeration („und sonst
 * der Text des Anbieters") is the door through which a foreign error message —
 * possibly echoing the input — reaches our log and our interface.
 *
 * Four of the six are `timeout`, `rate_limited`, `invalid_output` and
 * `truncated`. Two more earn their place:
 *
 * - **`refused`**, because a refusal would otherwise land in `invalid_output`
 *   and tell the editor „das Modell hat Unsinn geliefert" when the truth is
 *   „das Modell hat abgelehnt" — and that difference decides whether a second
 *   attempt with the same text is worth anything;
 * - **`unavailable`** as the collecting case for net, 5xx, auth and everything
 *   else, so that nothing has to travel as prose.
 */
export const aiFailureKindSchema = z.enum([
  /** Our own deadline expired (ADR-0015 no. 6) — never the SDK's. */
  'timeout',
  /** The provider rate-limited us. */
  'rate_limited',
  /** No JSON, or JSON the schema does not accept. */
  'invalid_output',
  /** The answer ended at the token boundary. */
  'truncated',
  /** The provider declined the request. */
  'refused',
  /**
   * Net, 5xx, auth — everything else.
   *
   * ⚠️ **It is a collecting case without a diagnosis, and that has a price
   * worth naming:** a permanently wrong configuration — a
   * revoked key, a model identifier the pinned provider does not serve, an
   * endpoint that does not carry it — is indistinguishable from a provider
   * having a bad afternoon, and nobody watching the installation can see the
   * difference. The counter-measure is already in ADR-0015 no. 8: `ai_usage`
   * has an `outcome` column that holds `'ok'` or one of these six. **That column
   * has to actually be written** — a row that records only that a call happened turns
   * every one of these six into „irgendwas war".
   */
  'unavailable',
]);
export type AiFailureKind = z.infer<typeof aiFailureKindSchema>;

/**
 * The six kinds as an array — the list a contract test iterates and a
 * `switch` is checked exhaustively against.
 *
 * Derived from the schema rather than written a second time; a seventh kind
 * therefore reaches every consumer that switches over this.
 */
export const AI_FAILURE_KINDS: readonly AiFailureKind[] =
  aiFailureKindSchema.options;

/**
 * What one call cost, as far as the provider is willing to say (ADR-0015
 * no. 7).
 *
 * **The model id passes the seam on purpose**, and it is the only
 * provider-specific *string* that does: it is the basis of every cost
 * attribution, and it is a **value, not a behaviour** — the same distinction
 * as „der Dateiname ist Daten" in ADR-0014 no. 10. Token counts are the
 * provider's own account of itself (assumption A8) and therefore an
 * observation, never a limit; the hard quantity is the *call*.
 *
 * Both counts are nullable because a provider may not report them — and
 * because a call that failed before any answer has none.
 *
 * ## Why this is a schema and not just an interface
 *
 * **This is the one value on the seam that is *foreign data*** — it is read off
 * the provider's answer, and `CONTRIBUTING.md` says foreign data is parsed, not
 * cast. Both adapters therefore run their sample through
 * {@link aiUsageSampleSchema} and hand on `null` when it does not hold; `usage`
 * is nullable anyway, so a malformed observation costs the observation and
 * nothing else.
 *
 * ⚠️ **The two adapters do not have the same trust in their wire, and the
 * shared contract table says nothing about that.** The Mistral SDK is
 * Speakeasy-generated and validates its response with Zod before we ever see
 * it; the Anthropic SDK casts. So on the Anthropic side this schema is the
 * *only* thing between `message.usage` and a row in `ai_usage` — measured:
 * `inputTokens: "not-a-number"` and a 200-character `model` full of markup
 * travelled the seam unchallenged before it existed. Today that is harmless;
 * once that work lands, the numbers are arithmetic and the row is written to the
 * database.
 */
export const aiUsageSampleSchema = z
  .object({
    provider: aiProviderSchema,
    /**
     * The model identifier, as the provider echoed it back.
     *
     * Bounded rather than free: it is displayed and stored, and a provider that
     * answers with a kilobyte in this field is not naming a model. The bound is
     * a bound — escaping stays the renderer's job,
     * because a charset rule here would reject a legitimate future identifier.
     */
    model: z.string().min(1).max(128),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  })
  .readonly();
export type AiUsageSample = z.infer<typeof aiUsageSampleSchema>;

/**
 * **The result of one call — a value, never an exception** (ADR-0015 no. 2).
 *
 * A `throw` would carry a provider stack trace and provider prose through every
 * layer that does not catch it. This shape forces the caller to switch over the
 * six cases exhaustively, the same construction the question types in this
 * package are switched over.
 *
 * `draft` is `unknown` and stays `unknown`: the service knows exactly one
 * field, and the parse against `formSchema` happens in the caller — a boundary
 * kept on purpose — never in the adapter.
 */
export type AiFormOutcome =
  | {
      readonly ok: true;
      readonly draft: unknown;
      readonly usage: AiUsageSample | null;
    }
  | {
      readonly ok: false;
      readonly failure: AiFailureKind;
      readonly usage: AiUsageSample | null;
    };

// ---------------------------------------------------------------------------
// The route — what the browser sends and what it gets back.
// ---------------------------------------------------------------------------

/**
 * Body of `POST /api/ai/forms` — the free text and nothing else.
 *
 * A schema of its own rather than reusing {@link AiFormRequest}: what a
 * *caller* may send and what *leaves this installation* are two different
 * statements, and collapsing them would make the payload promise of ADR-0015
 * no. 4 depend on a request body. The server takes this apart and builds the
 * outgoing payload with {@link buildAiFormRequest}, which is still the one
 * place it comes into being.
 *
 * The bound is {@link AI_PROMPT_MAX} and it is applied **before** anything
 * else: the input field enforces it for comfort, this line enforces it for
 * real, and both read the same constant. Trimmed here as well, so „nur
 * Leerzeichen" is a 400 rather than a counted call.
 *
 * `language` carries a default rather than being required — there is exactly
 * one member of {@link formLanguageSchema} today, and a required field would
 * be one the dialogue has to send to say the only thing it can say.
 */
export const aiFormPromptRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(AI_PROMPT_MAX),
  language: formLanguageSchema.default('de'),
});
export type AiFormPromptRequest = z.infer<typeof aiFormPromptRequestSchema>;

/**
 * **The answer of the generate route — a result with 200, not an HTTP error**
 * (the same construction `testMailResultSchema` uses).
 *
 * A provider that timed out, declined or answered nonsense is **news about the
 * model**, not a failure of this request: the request was authorised, the
 * quota was spent, a row stands in `ai_usage`. Mapping that onto 502 or 504
 * would say something untrue about our own server and would push the six named
 * cases of {@link aiFailureKindSchema} into a status code that cannot carry
 * them — and the dialogue needs the distinction to decide whether a second
 * attempt is worth anything.
 *
 * **`quota` travels in both arms on purpose.** A failed call is a call the organisation
 * paid for (ADR-0015 no. 7), so the number the dialogue shows has to move even
 * when nothing usable came back. The one answer that is *not* in this union is
 * „das Kontingent ist erschöpft": nothing was spent and nothing was called, and
 * that is a **429** carrying {@link aiQuotaSchema} on its own.
 */
export const aiFormDraftResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The model's suggestion, or `null` — see `aiFormDraftSchema`'s `title`. */
    title: z.string().min(1).max(200).nullable(),
    definition: formDefinitionSchema,
    quota: aiQuotaSchema,
  }),
  z.object({
    ok: z.literal(false),
    failure: aiFailureKindSchema,
    /**
     * What was wrong with an answer that *was* a document — our own German
     * sentence about our own schema, never the provider's prose (ADR-0015
     * no. 2). `null` whenever nothing was read.
     */
    detail: z.string().nullable(),
    quota: aiQuotaSchema,
  }),
]);
export type AiFormDraftResponse = z.infer<typeof aiFormDraftResponseSchema>;

/** Parses the generate route's answer — never cast (`CONTRIBUTING.md`). */
export function parseAiFormDraftResponse(source: unknown): AiFormDraftResponse {
  return aiFormDraftResponseSchema.parse(source);
}

/** Parses `GET /api/ai/quota` — the organisation's own consumption. */
export function parseAiQuota(source: unknown): AiQuota {
  return aiQuotaSchema.parse(source);
}

/**
 * What the route says when an organisation has spent its monthly allowance.
 *
 * **It lives here because two sides read it, and only one of them can send
 * it.** The route attaches it to its own 429; Nest's throttler sends a second
 * 429 carrying `ThrottlerException: Too Many Requests`, and `ApiError.detail`
 * cannot tell the two apart. Writing this sentence a second time in the
 * browser to compare against it would be the duplication this project has
 * already paid for four times — so the browser imports the one the server
 * sends.
 *
 * The wording is deliberately distinct from the throttler's own 429
 * („Zu viele Anfragen…", `apps/api/src/common/rate-limit.module.ts`), because
 * the two are different news with different remedies: „warte eine Minute"
 * against „dieser Organisation hat für diesen Monat kein Kontingent mehr, der
 * Superadmin kann es anheben" . Same status code, and that is
 * right — both mean „nicht jetzt" — but a caller who cannot tell them apart
 * cannot act on either.
 */
export const AI_QUOTA_EXHAUSTED_MESSAGE =
  'Das KI-Kontingent dieser Organisation ist für diesen Monat aufgebraucht.';
