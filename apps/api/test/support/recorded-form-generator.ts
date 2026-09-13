import type { AiFormOutcome, AiFormRequest } from '@formsache/shared';

import { AiFormGenerator } from '../../src/ai/ai-form-generator';

/**
 * **The recording test double of the AI seam** (ADR-0015 no. 1) — the third
 * implementation, and the one every later package measures against.
 *
 * Two jobs, and the first one is why it is called *recording*:
 *
 * 1. **It keeps what it was handed.** {@link RecordedFormGenerator.calls} is
 *    the outgoing payload as the service built it. In this package that is what
 *    `provider-contract.spec.ts` asserts the double against, so its column of
 *    the table promises the same thing the two adapters' bodies do. It is
 *    also where the canary search of the evidence
 *    runs (`test/ai/payload-canaries.spec.ts`) — over the serialised request,
 *    not over the intention of the code that built it — and it is how the
 *    usage-limit suite proves „not called": a call the counter refused
 *    leaves no entry.
 * 2. **It plays back a scripted outcome**, so the AI test suites can drive
 *    every one of the six failure cases without a key and without a network.
 *
 * It lives in `test/support/` rather than in `src/`, following
 * `InMemoryFileStorage`: a double in the shipped tree is a second
 * implementation an application can accidentally bind.
 *
 * **Its own tests prove nothing on their own** — that is the whole reason
 * `test/ai/provider-contract.spec.ts` runs the *same table* against this class
 * and the two real adapters. Where the adapters are handed a recorded HTTP
 * answer, this one is handed the outcome directly; the row asserts all three
 * arrive at the same `AiFailureKind`, return a result rather than throwing,
 * and see exactly one attempt.
 */
export class RecordedFormGenerator extends AiFormGenerator {
  /** Every request this double was handed, in order. */
  readonly calls: AiFormRequest[] = [];

  /** How often {@link generate} was entered — including refused ones. */
  get attempts(): number {
    return this.calls.length;
  }

  /**
   * @param script what to answer. A single outcome answers every call; an
   *   array answers call *n* with entry *n* and throws once it runs out, so a
   *   suite that expected three calls and got four finds out.
   */
  constructor(
    private readonly script: AiFormOutcome | readonly AiFormOutcome[],
  ) {
    super();
  }

  /**
   * Deliberately **not** `async`: the seam promises a result rather than an
   * exception, and the one thing this class does throw — an exhausted script —
   * is a mistake of the *suite*, which should surface as a rejected promise
   * exactly like a real adapter's would, not as a synchronous throw the
   * caller's `await` never sees.
   */
  /**
   * **The double resolves nothing** — and has to have the method all the same.
   *
   * That is precisely where the value of the abstract class lies: a seam that a
   * provider extends and the double does not is a seam that is a different one
   * in the test than in production. `null` is the same honest answer here as in
   * the Anthropic adapter — the suite runs no network and has nothing from
   * which it could derive a version.
   */
  resolveModel(): Promise<string | null> {
    return Promise.resolve(null);
  }

  generate(
    request: AiFormRequest,
    signal: AbortSignal,
  ): Promise<AiFormOutcome> {
    this.calls.push(request);

    // The double honours the deadline like the adapters do, so a suite can
    // drive the `timeout` row through it as well (ADR-0015 no. 6).
    if (signal.aborted) {
      return Promise.resolve({ ok: false, failure: 'timeout', usage: null });
    }

    if (!Array.isArray(this.script)) {
      return Promise.resolve(this.script as AiFormOutcome);
    }
    const outcome = (this.script as readonly AiFormOutcome[])[
      this.calls.length - 1
    ];
    if (outcome === undefined) {
      return Promise.reject(
        new Error(
          `RecordedFormGenerator: call ${String(this.calls.length)} has no ` +
            'scripted outcome — the suite expected fewer calls than happened.',
        ),
      );
    }
    return Promise.resolve(outcome);
  }
}
