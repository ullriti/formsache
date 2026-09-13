import { inspect } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';
import { HTTPClient, Mistral } from '@mistralai/mistralai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAiFormRequest, type ResolvedAiConfig } from '@formsache/shared';

import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';
import { AI_MAX_OUTPUT_TOKENS } from '../../src/ai/ai-prompt';
import { CONTRACT_ROWS, recordedTransport } from './recorded-answers';

/**
 * **Neither SDK may be talked into printing our key or the editor's free
 * text** (ADR-0015 no. 10 „nie protokolliert", no. 13 and Konzept no. 81).
 *
 * Both SDKs carry a debug mode that is switched on from the **process
 * environment** — a surface that is outside our env contract and therefore
 * outside every guard this package has:
 *
 * - `MISTRAL_DEBUG` makes the Speakeasy runtime set its logger to `console` and
 *   print **every request header verbatim**, `authorization: Bearer <key>`
 *   included, followed by the request body. Its schema is
 *   `z.coerce.boolean()`, so the string `"false"` coerces to `true`: whoever
 *   switches it off switches it on. Measured with `MISTRAL_DEBUG=false`.
 * - `ANTHROPIC_LOG=debug` prints the request details. That SDK **does** redact
 *   `x-api-key` — but not the body, and the body is the free text Konzept no. 81
 *   promises thirty days and physical deletion for. A copy in the application
 *   log knows no such deadline.
 *
 * ⚠️ **No structural guard of this package can see either of them.** The scan
 * in `key-confinement.spec.ts` reads `apps/api/src/ai/**` for `console` and
 * `Logger`; both loggers live in `node_modules`. So the promise is measured
 * here, at the bytes a spied-on `console` receives.
 *
 * ## Why every case arms the trap first
 *
 * Each test drives the **bare SDK** through the same recorded transport before
 * it drives our adapter, and asserts that the bare client *does* print. Without
 * that half, a future change that merely stops the SDK from reading its
 * variable — or a memoised environment read that happened earlier in this
 * worker (Speakeasy caches `env()` on first use) — would turn this file green
 * while the hole stayed open. A guard that passes quietly is worse than none.
 *
 * Both the key and the free text used here are canaries, so a **red** run
 * prints fixtures rather than anything real.
 */

const CANARY_KEY = 'ZZKANARIE-DEBUG-KEY';
const CANARY_PROMPT =
  'ZZKANARIE-FREITEXT — ein Formular für die Bestandsmeldung.';

const REQUEST = buildAiFormRequest({
  prompt: CANARY_PROMPT,
  language: 'de',
});

const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: CANARY_KEY,
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

/** The success row — the only one that gets far enough to send a body. */
function successRow() {
  const row = CONTRACT_ROWS[0];
  if (row === undefined) {
    throw new Error('contract table is empty');
  }
  return row;
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

/**
 * Replaces every console method either SDK logs through and returns a reader
 * for what they were handed.
 *
 * Objects are rendered with `inspect` rather than `String`, because a body
 * handed over as an object would otherwise arrive as `[object Object]` and the
 * free text inside it would go unseen — the exact blind spot this file exists
 * for.
 */
function captureConsole(): () => string {
  let captured = '';
  const sink = (...args: unknown[]): void => {
    captured += `${args
      .map((arg) =>
        typeof arg === 'string' ? arg : inspect(arg, { depth: 8 }),
      )
      .join(' ')}\n`;
  };
  vi.spyOn(console, 'log').mockImplementation(sink);
  vi.spyOn(console, 'info').mockImplementation(sink);
  vi.spyOn(console, 'warn').mockImplementation(sink);
  vi.spyOn(console, 'error').mockImplementation(sink);
  vi.spyOn(console, 'debug').mockImplementation(sink);
  vi.spyOn(console, 'group').mockImplementation(sink);
  vi.spyOn(console, 'groupEnd').mockImplementation(sink);
  return () => captured;
}

describe('MISTRAL_DEBUG', () => {
  it('prints key and free text through a bare client — the trap is armed', async () => {
    // The value that reads like „off". `z.coerce.boolean()` turns the string
    // "false" into `true`, which is why this is the measurement value.
    process.env.MISTRAL_DEBUG = 'false';
    const recorded = recordedTransport(successRow().mistral);
    const read = captureConsole();

    const bare = new Mistral({
      apiKey: CANARY_KEY,
      server: 'eu',
      httpClient: new HTTPClient({ fetcher: recorded.transport }),
    });
    await bare.chat.complete({
      model: 'mistral-recorded-0000',
      maxTokens: AI_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: CANARY_PROMPT }],
    });

    const captured = read();
    expect(captured).toContain(CANARY_KEY);
    expect(captured).toContain(CANARY_PROMPT);
  });

  it('prints nothing through the adapter', async () => {
    process.env.MISTRAL_DEBUG = 'false';
    const recorded = recordedTransport(successRow().mistral);
    const read = captureConsole();

    const generator = new MistralFormGenerator(
      { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
      recorded.transport,
    );
    await generator.generate(REQUEST, new AbortController().signal);

    expect(read()).toBe('');
  });
});

describe('ANTHROPIC_LOG', () => {
  it('prints the free text through a bare client — the trap is armed', async () => {
    process.env.ANTHROPIC_LOG = 'debug';
    const recorded = recordedTransport(successRow().anthropic);
    const read = captureConsole();

    const bare = new Anthropic({
      apiKey: CANARY_KEY,
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        recorded.transport(new Request(input, init)),
    });
    await bare.messages.create({
      model: 'claude-opus-5',
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: CANARY_PROMPT }],
    });

    const captured = read();
    // The key is *not* asserted here: this SDK redacts `x-api-key` to `***`,
    // and that is the difference to the Mistral case — the body is what
    // travels, and the body is the free text of Konzept no. 81.
    expect(captured).toContain(CANARY_PROMPT);
  });

  it('prints nothing through the adapter', async () => {
    process.env.ANTHROPIC_LOG = 'debug';
    const recorded = recordedTransport(successRow().anthropic);
    const read = captureConsole();

    const generator = new AnthropicFormGenerator(CONFIG, recorded.transport);
    await generator.generate(REQUEST, new AbortController().signal);

    expect(read()).toBe('');
  });
});
