import { Injectable, NotFoundException } from '@nestjs/common';
import {
  buildAiFormRequest,
  type AiFormDraftResponse,
  type AiFormPromptRequest,
  type AiQuota,
} from '@formsache/shared';

import { AiSettingsService } from '../system-settings/ai-settings.service';
import type { TenantScope } from '../tenancy/tenant-scope';
import { generateAiFormDraft, type AiFormDraftResult } from './ai-form-draft';
import { AI_NOT_AVAILABLE_MESSAGE } from './ai-feature.guard';
import { AiFormGeneratorFactory } from './ai-form-generator';
import { AiUsageService } from './usage/ai-usage.service';

/**
 * What {@link AiFormsService.generate} hands the controller.
 *
 * Two arms, because they are two different HTTP answers: `exhausted` is the
 * **429** of the requirement — nothing went out, nothing was counted — and
 * `answered` is a 200 carrying either a draft or one of the six named failures
 * (`aiFormDraftResponseSchema`). The controller maps, it does not decide.
 */
export type AiFormDraftAttempt =
  | { readonly kind: 'exhausted'; readonly quota: AiQuota }
  | { readonly kind: 'answered'; readonly response: AiFormDraftResponse };

/**
 * **The bracket of the route: quota → call → parse.**
 *
 * This service composes three pieces that already exist and **adds no fourth**:
 *
 * 1. {@link AiUsageService.spend} — reserves a call of the organisation's monthly quota
 *    and commits *before* anything is dialled (ADR-0015 no. 7);
 * 2. {@link AiFormGenerator} — the one seam to the provider, chosen once in
 *    `AiModule`;
 * 3. {@link generateAiFormDraft} — the payload, the call and the parse against
 *    the shared schema, ids minted on adoption.
 *
 * **Why the bracket goes around 2 *and* 3.** The counter records a verdict per
 * row (`ai_usage.outcome`), and the honest verdict for „das Modell hat mit JSON
 * geantwortet, das unser Schema nicht erfüllt" is `invalid_output`, not `ok`.
 * With the parse outside the bracket, that row would say the call succeeded —
 * the organisation paid and the column that exists to tell six failure kinds apart
 * (ADR-0015 no. 8) would say „irgendwas war". `AiUsageService.spend` therefore
 * takes the whole attempt; see `AiCallResult` there.
 *
 * **What this service deliberately does not do:** it does not store the form
 * (ADR-0015 no. 11 — *Übernehmen* goes through the ordinary creation path, so
 * an open draft can never be overwritten), it does not retry (no. 6 — a quiet
 * repeat turns one counted call into three paid ones), and it logs nothing:
 * it holds the editor's free text, which is the datum the retention policy promises
 * thirty days and physical deletion for.
 */
@Injectable()
export class AiFormsService {
  constructor(
    /**
     * The one reader of the AI row. **The resolution happens per call**, not
     * at start-up: the configuration lives in the settings
     * and changes during operation, and an adapter held fast would still serve
     * the old provider after a provider change.
     */
    private readonly settings: AiSettingsService,
    /** Turns the resolution into an adapter — a test's double goes in here. */
    private readonly generators: AiFormGeneratorFactory,
    private readonly usage: AiUsageService,
  ) {}

  /**
   * One free text in, one form draft out — or a named failure, or a 429.
   *
   * `scope` and `userId` come from the guard chain, never from the body: the
   * Organisation whose quota is spent is the session's active one, and the row in
   * `ai_usage` names the person who pressed the button.
   */
  async generate(
    scope: TenantScope,
    userId: string,
    input: AiFormPromptRequest,
  ): Promise<AiFormDraftAttempt> {
    const config = await this.settings.resolve();
    if (config === null) {
      // ⚠️ **Reachable, and therefore a 404 rather than an error.**
      //
      // The comment here said „unreachable behind `AiFeatureGuard`" — that
      // was a claim about a time window, not a promise. Guard and
      // service read the row **twice**; whoever removes the provider between the two
      // readings (or rotates `SECRET_BOX_KEY`) got a 500 with a
      // stack in the log — for an entirely legitimate state.
      //
      // The same answer as the guard, from the same constant: „does not exist
      // here" is true even when it did exist one query earlier.
      throw new NotFoundException(AI_NOT_AVAILABLE_MESSAGE);
    }
    const generator = this.generators.create(config);

    // **Our** deadline, minted here and handed straight through (ADR-0015
    // no. 6) — never the SDK's, whose default is ten minutes. `AbortSignal`
    // rather than a `Promise.race`: it has to reach the HTTP request itself,
    // or a call we stopped waiting for keeps running and keeps costing.
    const signal = AbortSignal.timeout(config.timeoutMs);

    const spent = await this.usage.spend<AiFormDraftResult>(
      scope,
      {
        userId,
        request: buildAiFormRequest(input),
        // Provider and model come from **the same** resolution that produced the
        // adapter — not from a second one. The counter itself used to
        // resolve once more; two resolutions around one call
        // are two opportunities to disagree.
        provider: config.provider,
        model: config.model,
        /**
         * **Which fixed version the alias currently means** .
         *
         * Before the call and not after it — the same place where provider and
         * model are already recorded, and for the same reason:
         * they belong on the *reserved* row, so that a failure does not lose
         * them.
         *
         * A network call of its own per draft, without a cache. With a
         * quota of 50 calls per organisation and month that is not measurable,
         * and it is more accurate than any cache. `resolveModel` does not throw and
         * returns `null` when the provider does not give the information — the
         * draft then runs without it.
         */
        modelResolved: await generator.resolveModel(signal),
      },
      (request) =>
        generateAiFormDraft({
          generator,
          prompt: request.prompt,
          language: request.language,
          signal,
        }),
    );

    if (!spent.spent) {
      return { kind: 'exhausted', quota: spent.quota };
    }

    const result = spent.outcome;
    return {
      kind: 'answered',
      response: result.ok
        ? {
            ok: true,
            title: result.title,
            definition: result.definition,
            quota: spent.quota,
          }
        : {
            ok: false,
            failure: result.failure,
            detail: result.detail,
            quota: spent.quota,
          },
    };
  }

  /** The consumption and remainder of the active organisation. */
  quota(scope: TenantScope): Promise<AiQuota> {
    return this.usage.quota(scope);
  }
}
