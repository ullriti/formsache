import { allQuestions, type ResolvedAiConfig } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  generateAiFormDraft,
  type AiFormDraftResult,
} from '../../src/ai/ai-form-draft';
import type { AiFormGenerator } from '../../src/ai/ai-form-generator';
import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import {
  expectFormSchemaOnTheWire,
  outgoingPayload,
  type WireProvider,
} from './outgoing-payload';
import {
  CONTRACT_ROWS,
  recordedAnswerCarrying,
  recordedTransport,
} from './recorded-answers';

/**
 * The requirement, the API half — **the answer of a model becomes a form only
 * by being parsed** (ADR-0015 no. 3).
 *
 * The unit half lives in `packages/shared/src/ai-form-draft.test.ts`, where the
 * refusals are measured one by one against hand-written answers. What is worth
 * measuring *here* is the thing that file cannot see: the same pipeline driven
 * through a **real adapter** over a recorded HTTP answer, so that the document
 * being parsed is one that came out of an SDK rather than one a test wrote next
 * to the assertion.
 *
 * ⚠️ Standing caveat of this directory: no byte of the recorded answers has
 * ever been observed against a live provider (`recorded-answers.ts`).
 */

const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: 'sk-recorded-not-a-real-key',
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

/** The success row of the shared contract table — a good answer, recorded. */
function successRow() {
  const row = CONTRACT_ROWS[0];
  if (row === undefined) {
    throw new Error('the contract table is empty');
  }
  return row;
}

/** An adapter that replays the recorded success answer over the SDK. */
function anthropicWithRecordedSuccess(): AiFormGenerator {
  return new AnthropicFormGenerator(
    CONFIG,
    recordedTransport(successRow().anthropic).transport,
  );
}

const PROMPT = 'Ein Formular für die Bestandsmeldung mit Name und Anreise.';

async function draftFrom(
  generator: AiFormGenerator,
  newId?: () => string,
): Promise<AiFormDraftResult> {
  const controller = new AbortController();
  return generateAiFormDraft({
    generator,
    prompt: PROMPT,
    language: 'de',
    signal: controller.signal,
    ...(newId === undefined ? {} : { newId }),
  });
}

/** The definition of a successful run, or a failure that says what came back. */
function definitionOf(result: AiFormDraftResult) {
  if (!result.ok) {
    throw new Error(
      `Expected a form, got ${result.failure}: ${result.detail ?? '—'}`,
    );
  }
  return result.definition;
}

describe('a recorded answer becomes a parsed form (ADR-0015 Nr. 3)', () => {
  it('turns the SDK-parsed draft into a definition with our own ids', async () => {
    const result = await draftFrom(anthropicWithRecordedSuccess());

    const definition = definitionOf(result);
    const questions = allQuestions(definition);
    expect(questions.map((question) => question.label)).toEqual([
      'Name',
      'Anreise',
      'Mitfahrgelegenheit',
    ]);

    // The condition the recorded answer expressed as a **position** now names
    // the id „Anreise" was minted — the one thing the walk rewrites.
    const source = questions[1];
    expect(questions[2]?.visibleIf).toEqual({
      operator: 'equals',
      value: 'bahn',
      questionId: source?.id,
    });
    expect(result.ok && result.usage?.model).toBe('claude-opus-5');
  });

  /**
   * **„Modelle wiederholen sich"** — the reproduction of the requirement, driven
   * end to end: the *same* recorded answer, twice, through the same adapter.
   * Taking the model's ids over would make these two id sets identical; here
   * they share nothing.
   */
  it('gives two calls with the same answer disjoint ids', async () => {
    const first = definitionOf(await draftFrom(anthropicWithRecordedSuccess()));
    const second = definitionOf(
      await draftFrom(anthropicWithRecordedSuccess()),
    );

    const idsOf = (definition: typeof first): string[] => [
      ...definition.pages.map((page) => page.id),
      ...allQuestions(definition).map((question) => question.id),
    ];
    const firstIds = idsOf(first);
    const secondIds = idsOf(second);
    expect(firstIds).toHaveLength(4);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });
});

describe('an answer that is not a form is a named failure (ADR-0015 Nr. 2)', () => {
  it('reports invalid_output with a detail that names the field', async () => {
    const double = new RecordedFormGenerator({
      ok: true,
      // Well-formed JSON, and not a form: exactly the shape „fast passend"
      // takes when a model narrates instead of answering.
      draft: {
        pages: [{ title: 'Seite 1', questions: [{ type: 'signature' }] }],
      },
      usage: null,
    });

    const result = await draftFrom(double);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failure: 'invalid_output' });
    expect(result.ok ? '' : result.detail).toContain(
      'pages.0.questions.0.type',
    );
  });

  /**
   * A failure the adapter reported keeps its own kind and carries **no**
   * detail: there was nothing to read, and a sentence here would suggest we saw
   * more than we did.
   */
  it('passes an adapter failure through untouched', async () => {
    const double = new RecordedFormGenerator({
      ok: false,
      failure: 'truncated',
      usage: null,
    });

    const result = await draftFrom(double);

    expect(result).toEqual({
      ok: false,
      failure: 'truncated',
      detail: null,
      usage: null,
    });
  });

  /**
   * The judge runs over the document *we* assembled as well: a defective
   * minter is caught as a duplicate question id rather than trusted because we
   * minted it ourselves.
   */
  it('refuses a run whose id assignment collided', async () => {
    const result = await draftFrom(
      anthropicWithRecordedSuccess(),
      () => '019ffc00-0000-7000-8000-000000000001',
    );

    expect(result).toMatchObject({ ok: false, failure: 'invalid_output' });
    expect(result.ok ? '' : result.detail).toContain('Doppelte Frage-ID.');
  });
});

/**
 * **The Auflage of the requirement, and the reason it is a test rather than a
 * sentence.**
 *
 * *„⚠️ Das Parsen bleibt, wie es ist. Ein Anbieter, der trotz Schema Unsinn
 * schickt, wird genauso abgewiesen; das Schema an der Leitung ist eine
 * Verbesserung der Quote, **nie** ein Grund, die Prüfung aufzuweichen."*
 *
 * Two halves in one case, and the first is what makes the second mean
 * anything: the request that produced this answer is measured to **carry the
 * derived schema**, and the answer is refused anyway. A future change that
 * softens `adoptAiFormDraft` or `parseModelJson` because „das Schema garantiert
 * es ja schon" turns this red — which is the whole assurance.
 *
 * Both adapters, because both now send a schema and both would have to be
 * softened separately for the loophole to open twice.
 */
describe('a schema on the wire is no reason to trust the answer ', () => {
  /**
   * Well-formed JSON, plausible at a glance, and not a form this application
   * has: `signature` is not one of its question types. A model *could* send
   * this despite the schema — the schema is a hint, not a guarantee — and this
   * is what happens when it does.
   */
  const NOT_A_FORM = {
    title: 'Bestandsmeldung',
    pages: [
      {
        title: 'Angaben',
        description: null,
        questions: [{ type: 'signature', label: 'Unterschrift' }],
      },
    ],
  };

  const SUBJECTS: readonly {
    readonly name: WireProvider;
    readonly build: (transport: ReturnType<typeof recordedTransport>) => {
      generator: AiFormGenerator;
    };
  }[] = [
    {
      name: 'anthropic',
      build: (recorded) => ({
        generator: new AnthropicFormGenerator(CONFIG, recorded.transport),
      }),
    },
    {
      name: 'mistral',
      build: (recorded) => ({
        generator: new MistralFormGenerator(
          { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
          recorded.transport,
        ),
      }),
    },
  ];

  it.each(SUBJECTS)(
    '$name — the schema goes out and the answer is still refused',
    async ({ name, build }) => {
      const recorded = recordedTransport(
        recordedAnswerCarrying(NOT_A_FORM)[name],
      );
      const result = await draftFrom(build(recorded).generator);

      // Half one: the schema really was on the wire for this very call. Without
      // it, „trotz gesetztem Schema" would be an assumption about the adapter
      // rather than a property of the request that produced this answer.
      expectFormSchemaOnTheWire(outgoingPayload(recorded.bodies()[0]), name);

      // Half two: refused all the same, and with a message that names the
      // field — the parse is untouched.
      expect(result).toMatchObject({ ok: false, failure: 'invalid_output' });
      expect(result.ok ? '' : result.detail).toContain(
        'pages.0.questions.0.type',
      );
    },
  );
});
