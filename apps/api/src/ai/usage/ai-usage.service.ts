import { Injectable } from '@nestjs/common';
import {
  berlinMonthStart,
  type AiFailureKind,
  type AiFormOutcome,
  type AiFormRequest,
  type AiProvider,
  type AiQuota,
  type AiUsageSample,
} from '@formsache/shared';

import { MailClock } from '../../mail/mail-clock';
import type { TenantScope } from '../../tenancy/tenant-scope';

/**
 * **The result of an attempted call — two arms, and the first one is the 429**.
 *
 * `spent: false` means: the quota was exhausted, **nothing has gone
 * out**, and there stands no more a row in `ai_usage` than before. The
 * caller makes a 429 out of it, together with consumption and remainder.
 */
export type AiSpendResult<R extends AiCallResult = AiFormOutcome> =
  | {
      readonly spent: false;
      readonly quota: AiQuota;
    }
  | {
      readonly spent: true;
      /** What the provider delivered — a draft or one of the six cases. */
      readonly outcome: R;
      /** Including this call. */
      readonly quota: AiQuota;
    };

/**
 * **What the bracket has to know about a call** — and no more.
 *
 * `AiFormOutcome` fulfils that, and `AiFormDraftResult` (`ai/ai-form-draft.ts`)
 * as well. That is exactly why the type stands here: the route puts the bracket
 * around **call and parse** instead of only around the call, and that is no
 * convenience but the bookkeeping of ADR-0015 no. 8. An answer that was JSON and
 * does not fulfil the schema is otherwise noted as `ok` in `ai_usage` — the
 * organisation has paid, in the column stands "it worked", and the kind of
 * failure for whose sake the column exists is lost.
 *
 * The generic parameter is the price for that and it is small: `spend` hands
 * back what the callback delivered, instead of shortening it to the narrower
 * type.
 */
export type AiCallResult =
  | { readonly ok: true; readonly usage: AiUsageSample | null }
  | {
      readonly ok: false;
      readonly failure: AiFailureKind;
      readonly usage: AiUsageSample | null;
    };

/**
 * **The counter, and it encloses the call** (ADR-0015 no. 7).
 *
 * ## Why this is one bracket and not two methods
 *
 * "Count before the call" and "a failure counts exactly once" are worthless as
 * *instructions* to a future caller — both are violated precisely when
 * somebody no longer has them in mind. As a bracket they are a
 * property of the code: {@link spend} reserves, **commits**, then calls the
 * provider and afterwards writes the verdict. Whoever wants to call the
 * provider goes through this method; a `reserve()`/`release()` pair does not
 * exist, and {@link ScopedAiUsageDelegate} has no method that takes a
 * reservation back (ADR-0015 no. 7: „die Abwesenheit eines Weges").
 *
 * ## What the caller cannot do with it
 *
 * They cannot store the text differently from how they send it: the bracket
 * takes **one** {@link AiFormRequest}, writes its `prompt` into the row
 * and hands **the same one** on to the callback. A "something other than what
 * was sent got stored" is thereby no longer a question of diligence.
 *
 * ## The clock
 *
 * The one injected clock of the application (`MailClock`; the mail-shaped name
 * is the price for it staying one — `file-purge.service.ts` writes the
 * reasoning out). From it come **both** time values: the stamp of the row
 * and the month start against which the counting happens. Two clocks would be a
 * call here that falls into the one month and is counted in the other.
 */
@Injectable()
export class AiUsageService {
  constructor(private readonly clock: MailClock) {}

  /**
   * Takes one call off the organisation's quota and then carries it out.
   *
   * The order is the promise:
   *
   * 1. **reserve and commit** — under `SELECT … FOR UPDATE` on the
   *    quota row (see the delegate). If the quota does not suffice, it ends
   *    here: `spent: false`, and the callback is **never executed**. Exactly
   *    that is what the spy in the test measures — a counter behind the call
   *    costs money and not only state.
   * 2. **call** — outside of every transaction. A transaction around a
   *    network call with a sixty-second time limit would hold the quota row
   *    of a whole organisation for that long.
   * 3. **enter the verdict afterwards** — which of the seven exits it was and
   *    what it cost in tokens. A failure changes nothing about the consumption.
   *
   * **A thrown error gives nothing back.** The contract of the seam says an
   * adapter does not throw (`AiFormGenerator`); were it to do so anyway, the
   * slot is used up nonetheless — the provider charges for a call once begun,
   * whether our layer above it keeps it or not. The row then gets
   * `unavailable`, and the error runs on upwards.
   */
  async spend<R extends AiCallResult = AiFormOutcome>(
    scope: TenantScope,
    input: {
      readonly userId: string;
      readonly request: AiFormRequest;
      /**
       * Provider and model **of the call that is about to take place** — handed
       * in by the caller, not resolved once more here.
       *
       * Formerly this method asked `resolveAiConfig(env)` itself, which worked
       * as long as the answer had been fixed since the start. By now it stands
       * in the settings and can change between two queries —
       * the row would then carry the provider that applied at counting time, and
       * the call would go to the one that applied at generation time. An
       * argument instead of a second resolution makes that impossible.
       */
      readonly provider: AiProvider;
      readonly model: string;
      /**
       * The fixed version behind {@link model}, or `null`.
       *
       * It too comes **from the caller**, for the same reason as the two
       * above: it stems from the adapter that the same resolution produced.
       * This service knows no provider and shall know none — it
       * is the bracket around the seam, not a second participant in it.
       */
      readonly modelResolved: string | null;
    },
    call: (request: AiFormRequest) => Promise<R>,
  ): Promise<AiSpendResult<R>> {
    // Provider and model are fixed **before** the call, because they are
    // configuration (ADR-0015 no. 5) — they therefore belong on the
    // reserved row already. They come from the same resolution from which
    // the adapter arose (see `input.provider`).
    const now = this.clock.now();
    const reservation = await scope.aiUsage.reserve({
      userId: input.userId,
      prompt: input.request.prompt,
      provider: input.provider,
      model: input.model,
      modelResolved: input.modelResolved,
      now,
      monthStart: berlinMonthStart(now),
    });
    if (!reservation.granted) {
      return { spent: false, quota: reservation.quota };
    }

    let outcome: R;
    try {
      outcome = await call(input.request);
    } catch (error: unknown) {
      // No path back, not here either: only a verdict.
      await this.record(scope, reservation.id, {
        outcome: 'unavailable',
        usage: null,
      });
      throw error;
    }

    await this.record(scope, reservation.id, {
      outcome: outcome.ok ? 'ok' : outcome.failure,
      usage: outcome.usage,
    });
    return { spent: true, outcome, quota: reservation.quota };
  }

  /** Consumption and remainder of this organisation in the current calendar month. */
  async quota(scope: TenantScope): Promise<AiQuota> {
    return scope.aiUsage.quota(berlinMonthStart(this.clock.now()));
  }

  /**
   * Writes the verdict — and does **not** let an error in doing so make the
   * call fail.
   *
   * The reservation is the truth and long since committed; the verdict is an
   * observation. An `UPDATE` that fails on a torn-off connection
   * must not throw away a generated form draft — the row then stays standing
   * with `outcome IS NULL`, and **that is the trace**: the state stands in
   * the data, not in a log file.
   *
   * Nothing at all is therefore logged, and the reason stands **here** and
   * not in a guard: this service holds the free text in its hand, an
   * error message from Prisma carries the parameters of the statement, and the
   * first of them is exactly this text.
   *
   * ⚠️ The sentence "no module under `src/ai` logs" stood here once
   * as a reason and is by now **wrong**: the guard is
   * narrowed to `src/ai/*.ts`, `usage/` and `purge/` lie outside it,
   * and the purge next door has reported its number and its failure ever since.
   * What is silent here is silent out of the argument above — not because it
   * would have to be. (Review finding of the security check, 2026-08-10.)
   */
  private async record(
    scope: TenantScope,
    id: string,
    verdict: Parameters<TenantScope['aiUsage']['recordVerdict']>[1],
  ): Promise<void> {
    try {
      await scope.aiUsage.recordVerdict(id, verdict);
    } catch {
      // Deliberately empty: the row keeps its reservation and no verdict.
    }
  }
}
