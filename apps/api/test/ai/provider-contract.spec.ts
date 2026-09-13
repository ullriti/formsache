import { describe, expect, it } from 'vitest';
import {
  buildAiFormRequest,
  type AiFormOutcome,
  type ResolvedAiConfig,
} from '@formsache/shared';

import type { AiFormGenerator } from '../../src/ai/ai-form-generator';
import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import {
  expectFormSchemaOnTheWire,
  expectNoCapabilitySurface,
  outgoingPayload,
  type WireProvider,
} from './outgoing-payload';
import {
  CONTRACT_ROWS,
  RECORDED_DRAFT,
  RECORDED_OK_USAGE,
  recordedTransport,
  type ContractRow,
} from './recorded-answers';

/**
 * **The shared contract of the AI seam — and it is the actual yield of this
 * design**, not a formality (ADR-0015 no. 1).
 *
 * Three implementations exist so that other suites can drive every
 * failure case without a key. A double that only satisfies its own tests
 * proves nothing about the adapters that ship, so all three run **this** file:
 * every row below is a promise of the seam, not of one side of it.
 *
 * ## Why two adapters in the same round
 *
 * Konzept no. 77 requires it, and rightly: a seam is only proven once a second
 * consumer has passed through it. An adapter pulled in later is literally the
 * shape „a second write path without the filter of the first" that handed a
 * secret on twice. Concretely, this table already caught what a one-column
 * version could not have: the two providers disagree on *where* the failure
 * lives (Anthropic answers HTTP 200 and says `stop_reason: "refusal"`, Mistral
 * puts truncation in `finish_reason` and rate limiting in an HTTP status), so
 * „map the status code" would have been a perfectly green single-column
 * design and a broken seam.
 *
 * ## What is measured, and what is not
 *
 * ⚠️ **Nothing here has ever run against a live provider.** The recorded
 * answers and the exact boundary of what that buys are documented in
 * `recorded-answers.ts`. In short: our mapping and the SDKs' own behaviour
 * (parsing, error classes, retries) are measured; whether the recorded bodies
 * are today's wire format is not.
 */

const REQUEST = buildAiFormRequest({
  prompt: 'Ein Formular für die Bestandsmeldung mit Name und Semester.',
  language: 'de',
});

/** A configuration whose key is a value no provider would accept. */
const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: 'sk-recorded-not-a-real-key',
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

interface Subject {
  readonly name: string;
  /**
   * Whose request shape this subject puts on the wire, or `undefined` for the
   * double, which has none. It is what lets **one** row of this table say
   * „both adapters send the schema"  instead of two separate
   * cases that could drift apart.
   */
  readonly wire?: WireProvider;
  /**
   * Builds the implementation for one row, plus the two things the row needs
   * to be able to ask about: how many HTTP attempts were made, and what went
   * out on the wire.
   */
  readonly arrange: (row: ContractRow) => {
    readonly generator: AiFormGenerator;
    readonly attempts: () => number;
    readonly bodies: () => readonly string[];
    /**
     * Present only for the double, which has no wire. Its payload promise is
     * checked on what it was **handed** instead — without this the double's
     * column asserted nothing at all about the payload.
     */
    readonly double?: RecordedFormGenerator;
  };
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'AnthropicFormGenerator',
    wire: 'anthropic',
    arrange: (row) => {
      const recorded = recordedTransport(row.anthropic);
      return {
        generator: new AnthropicFormGenerator(CONFIG, recorded.transport),
        attempts: recorded.attempts,
        bodies: recorded.bodies,
      };
    },
  },
  {
    name: 'MistralFormGenerator',
    wire: 'mistral',
    arrange: (row) => {
      const recorded = recordedTransport(row.mistral);
      return {
        generator: new MistralFormGenerator(
          { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
          recorded.transport,
        ),
        attempts: recorded.attempts,
        bodies: recorded.bodies,
      };
    },
  },
  {
    name: 'RecordedFormGenerator',
    arrange: (row) => {
      const double = new RecordedFormGenerator(row.double);
      return {
        generator: double,
        attempts: () => double.attempts,
        bodies: () => [],
        double,
      };
    },
  },
];

/**
 * The deadline the row runs under.
 *
 * Short on purpose: the `timeout` row has to *wait* for it, and a 60-second
 * production value would make this file a minute long. The value is ours
 * either way — that is the point of ADR-0015 no. 6.
 */
const TEST_DEADLINE_MS = 120;

async function run(generator: AiFormGenerator): Promise<AiFormOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TEST_DEADLINE_MS);
  try {
    return await generator.generate(REQUEST, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

describe.each(SUBJECTS)('$name — the shared contract', (subject) => {
  it.each(CONTRACT_ROWS)('$name', async (row) => {
    const arranged = subject.arrange(row);

    // **A result, never an exception** (ADR-0015 no. 2). `generate` is awaited
    // without a `try`, so an implementation that throws fails this line rather
    // than being caught into a passing assertion.
    const outcome = await run(arranged.generator);

    if (row.expected === 'ok') {
      expect(outcome.ok).toBe(true);
    } else {
      expect(outcome).toMatchObject({ ok: false, failure: row.expected });
    }

    // **Exactly one attempt, always** (ADR-0015 no. 6, assumption A4). This is
    // where the two SDKs' own retry defaults are *measured* rather than
    // believed: the `rate_limited` row answers 429 once and a usable draft on
    // every later attempt, so an adapter that repeated would report `ok` here
    // and fail the assertion above as well.
    expect(arranged.attempts()).toBe(1);
  });

  it('sends the free text, the language and the derived schema — and buys no capability', async () => {
    const row = CONTRACT_ROWS[0];
    // The success row exists — a table that lost its rows would otherwise make
    // this file pass over nothing.
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    const arranged = subject.arrange(row);
    await run(arranged.generator);

    const bodies = arranged.bodies();
    if (subject.wire === undefined) {
      // The double has no wire, so its payload promise is checked on what it
      // was handed. This used to be a bare `return` next to a comment that
      // *named* `RecordedFormGenerator.calls` — which nothing then read, so one
      // of three columns asserted nothing here.
      expect(bodies).toEqual([]);
      expect(arranged.double?.calls).toEqual([REQUEST]);
      return;
    }
    const [body] = bodies;
    const payload = outgoingPayload(body);

    // Positive: the two values that are allowed out are actually out.
    expect(body).toContain('Bestandsmeldung');
    expect(body).toContain('German');

    // **The Konzept no. 89 assertion, and it lives here on purpose:** „both
    // adapters send the schema" is a promise of the seam, so it belongs in
    // the table that runs against both columns rather than in two separate
    // cases. Measured on the bytes that actually left, byte for byte against
    // the derived schema — not on „something schema-shaped".
    expectFormSchemaOnTheWire(payload, subject.wire);

    // Structural, and deliberately over the **key set** rather than over a
    // sentence in a comment: adding a *capability* makes this red, whereas
    // „the service has no tools; the test holds that on record" would stay
    // green whatever gets built. What „no tool key"
    // meant before Konzept no. 89 is spelled out in `outgoing-payload.ts`.
    expectNoCapabilitySurface(payload, subject.wire);
  });
});

/**
 * The success row, spelled out once per adapter: the draft arrives parsed and
 * the usage sample carries the **model the answer named**, not the model that
 * was asked for. That distinction is what makes a cost attribution honest when
 * a provider serves a different model than the pinned one.
 */
describe('the success row in detail', () => {
  it.each([
    {
      name: 'anthropic',
      build: () => {
        const row = CONTRACT_ROWS[0];
        if (row === undefined) {
          throw new Error('contract table is empty');
        }
        const recorded = recordedTransport(row.anthropic);
        return new AnthropicFormGenerator(CONFIG, recorded.transport);
      },
      usage: RECORDED_OK_USAGE.anthropic,
    },
    {
      name: 'mistral',
      build: () => {
        const row = CONTRACT_ROWS[0];
        if (row === undefined) {
          throw new Error('contract table is empty');
        }
        const recorded = recordedTransport(row.mistral);
        return new MistralFormGenerator(
          { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
          recorded.transport,
        );
      },
      usage: RECORDED_OK_USAGE.mistral,
    },
  ])(
    '$name returns the draft and the usage sample',
    async ({ build, usage }) => {
      const outcome = await run(build());
      expect(outcome).toEqual({ ok: true, draft: RECORDED_DRAFT, usage });
    },
  );
});
