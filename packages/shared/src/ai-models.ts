import type { AiProvider } from './ai.ts';

/**
 * **The model identifiers as a module of their own — and why they do not live
 * with `resolveAiConfig`** (review follow-up, 2026-08-12).
 *
 * The list is needed at two ends: by the resolution (`ai-config.ts`,
 * for the default value) **and** by the write schema (`ai-settings.ts`, which
 * rejects a model of the respective other provider). Both files already hang
 * on each other — `ai-config.ts` reads `AI_REGION_DEFAULT` from `ai-settings.ts`
 * —, and building the check in there would have made a cycle out of it. A
 * cycle that works today because both accesses lie in function bodies
 * is not a design, but a bet on the evaluation order
 * of the next bundler. This module therefore imports **only** the
 * provider type and is read by both.
 */

/** One entry of {@link AI_MODEL_CHOICES} — the identifier and what to call it. */
export interface AiModelChoice {
  /**
   * The identifier as the provider's API takes it. **A moving alias by
   * decision** — see the "Why aliases" section at {@link AI_MODEL_CHOICES}
   * for what that buys and what it costs.
   */
  readonly id: string;
  /** German, because it is read in a `select`. */
  readonly label: string;
}

/**
 * **The models that stand for selection — a curated list instead of a
 * free-text field** (ADR-0015 no. 5).
 *
 * Up to here the model identifier was a text field: whoever mistyped got
 * no error on saving, but a 404 from the provider on the first
 * form draft — that is, at the place where nobody thinks about the
 * settings field any more. The list moves the error back to where it
 * arises, and it is at the same time the answer to the second question that the
 * text field left open: *which* identifier makes any sense here.
 *
 * **Included is only what this application can really use.** The
 * AI form draft requires a **nested JSON schema**
 * (`aiFormDraftSchema`, ~11.8 kB, sixteen field kinds and conditional logic) —
 * with Anthropic as the input schema of a forced tool call
 * (`anthropic-form-generator.ts`), with Mistral as `json_schema` in the
 * `response_format`. The edge models (`ministral-*`) therefore stay outside,
 * and everything that is no chat model at all (`*-embed`, `*-ocr-*`, `voxtral-*`,
 * `codestral-*`).
 *
 * ⚠️ **Expressly *not* required is `strict: true`.**
 * `mistral-form-generator.ts` sends `strict: false`, and with reason: the
 * derived schema carries length and range limits at which the strict
 * mode would reject *every* call. Whether `strict` is worth it is one of the four
 * measurements that are waiting for a real key (Issue #23).
 *
 * ⚠️ **And just as little is the suitability of these six *measured*.** What is
 * evidenced is that they exist; whether each of them reliably hits the nested
 * schema is open. For Anthropic there is a first indication
 * (nine drafts, 8 accepted after the `visibleIf` fix), for Mistral none.
 *
 * ## Why **aliases** and not the dated identifiers
 *
 * **Settled on 2026-08-12.** The first version of this
 * list carried the firmest forms (`mistral-large-2512`,
 * `claude-haiku-4-5-20251001`) with the reasoning that a moving alias swaps
 * the model out under a running installation. The objection that overturned
 * that: **reproducibility was not to be had anyway.** The provider
 * changes the price of a model during its lifetime without a
 * pinned identifier changing anything about it — and what a fixed identifier
 * *certainly* brings is the day on which it is deprecated and the feature stands
 * still until somebody builds a release. An alias carries itself onward.
 *
 * **The price, measured and not asserted** (2026-08-12, against
 * `api.eu.mistral.ai`):
 *
 * - An answer to `mistral-large-latest` reports **the alias back in the field
 *   `model`, not the resolved identifier**. `ai_usage.model` therefore
 *   in future writes „mistral-large-latest" — the cost evaluation can afterwards no
 *   longer say *which* model actually ran in a given month. What remains
 *   is the timestamp of the row.
 * - The recorded provider answers (`apps/api/test/ai/recorded-answers.ts`)
 *   evidence a behaviour that no longer has to run. They stay green no matter
 *   what the provider does — that is the limit of these proofs, expressly.
 *
 * ## Sources — and what the measurement corrected in the old version
 *
 * - **Mistral: `GET /v1/models` at `api.eu.mistral.ai`, run on
 *   2026-08-12** (56 entries). That ends two suppositions:
 *   - `mistral-medium-3-5` is **itself an alias** — it points to the same
 *     thing as `mistral-medium-2604`, `mistral-medium-3`, `mistral-medium` and
 *     `mistral-medium-latest`. The old version called it „fest"; that was
 *     wrong. **Fixed with Mistral is `name-YYMM` alone.**
 *   - `mistral-medium-2604` really does exist — exactly the identifier that on
 *     2026-08-06 was *not* guessed as an „naheliegende Extrapolation". The
 *     restraint was right nonetheless: a supposition that turns out to be
 *     right was a supposition at the time of the decision.
 *   - What the measurement confirmed is the deprecation: `mistral-medium-2508` and
 *     `mistral-medium-2505` carry `deprecated=2026-08-31`.
 * - **Anthropic: model catalogue of the agent skill `claude-api`** (as of
 *   2026-06-24, **outside this repository**, therefore not verifiable for a
 *   reader here — which is why the date stands with it). `claude-opus-5` ($5/$25
 *   per 1 million tokens, 1 million context) and `claude-sonnet-5` ($3/$15) carry
 *   no dated form at all; `claude-haiku-4-5` ($1/$5, 200 k context) has one with
 *   `claude-haiku-4-5-20251001`, and here the alias now deliberately stands.
 *
 * ⚠️ **The escape hatch of the interface becomes more important through this, not
 * less important.** An installation that still has a dated identifier
 * stored (from the free-text era or from the first version of this
 * list) keeps it — and `mistral-medium-2508` dies on 2026-08-31. The
 * hint at the field says exactly that.
 *
 * ⚠️ **The typo has not disappeared, but moved** — from the
 * operator into this list, where it would hit *all* installations instead of one.
 * That is why each of the six identifiers additionally stands as a literal in
 * `ai-config.test.ts`: derived from here, every assurance about it would be
 * circular, and a slipped character would stay green.
 */
export const AI_MODEL_CHOICES: Readonly<
  Record<AiProvider, readonly AiModelChoice[]>
> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5 (stärkstes Modell)' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (günstiger)' },
    // The alias, not `claude-haiku-4-5-20251001`: of the three this is
    // the only one that carries both forms at all.
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (am günstigsten)' },
  ],
  mistral: [
    { id: 'mistral-large-latest', label: 'Mistral Large (stärkstes Modell)' },
    // Points today at `mistral-medium-2604`. The label deliberately names
    // no version number — it would be wrong from the next model change on,
    // and nobody would think of following it up.
    { id: 'mistral-medium-latest', label: 'Mistral Medium' },
    { id: 'mistral-small-latest', label: 'Mistral Small (am günstigsten)' },
  ],
};

/**
 * The default model per provider — **the choice a Betreiber gets without
 * choosing** (ADR-0015 no. 5).
 *
 * Both entries are the first of their provider's {@link AI_MODEL_CHOICES}, and
 * `ai-config.test.ts` binds the two: a default that is not in the list would be
 * a value the settings page offers under „Vorgabe" while its own dropdown
 * cannot produce it.
 *
 * **Why the strongest model in each case.** The failure mode of a weaker model
 * here is not a worse sentence — it is a draft that misses the schema and gets
 * refused (`AI_DRAFT_INVALID_LEAD`), i.e. a call that costs money and produces
 * nothing. The cheaper entries stay in the list for an installation that has
 * measured its own prompts and wants them; the *default* is the one that most
 * likely returns something usable on the first try.
 *
 * **Mistral had none until 2026-08-12** — the reason is written out at
 * {@link AI_MODEL_CHOICES} together with the source that finally closed it.
 * The gap was never an oversight: a guessed identifier would have been a
 * promise about a foreign service that no test in this repository can keep.
 *
 * ⚠️ **„The strongest" is a judgement, not a measurement, for Mistral.** The
 * nine-draft run of 2026-08-12 covered Anthropic only; nothing here has ever
 * spoken to a Mistral endpoint about a form. Issue #23 is where that
 * default gets earned or replaced.
 *
 * ⚠️ **Total, not `Partial` — since the review of 2026-08-12.** It was
 * `Partial` for exactly as long as Mistral had no evidenced identifier, and the
 * first version of the curated list kept that shape „for a third adapter that
 * lands before its identifier is evidenced". That window does not exist: a
 * provider with no models is a provider whose settings page offers an empty
 * dropdown, and {@link AI_MODEL_CHOICES} is total for the same reason. Keeping
 * `Partial` bought a `describeAiConfigGap` branch that could never run and a
 * test that reached it only by casting a string the schema cannot produce — a
 * proof of something unreachable.
 *
 * **Whoever changes an entry:** take the identifier from a *reachable* provider
 * source, not from this comment, and change `ai-config.test.ts` in the same
 * commit — the literals there are what make a guessed value conspicuous.
 */
export const DEFAULT_AI_MODEL: Readonly<Record<AiProvider, string>> = {
  anthropic: 'claude-opus-5',
  mistral: 'mistral-large-latest',
};
