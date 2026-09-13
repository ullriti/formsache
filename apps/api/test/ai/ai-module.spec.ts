import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import {
  aiAvailable,
  resolveAiConfig,
  type AiSettingsFields,
} from '@formsache/shared';

import { createAiFormGenerator } from '../../src/ai/ai.module';
import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';

/**
 * **The selection happens in one place, and the two answers cannot contradict
 * each other** (ADR-0015 no. 5 and no. 9 with the addendum of 2026-08-11).
 *
 * Two things are measured, and the second one is what carries:
 *
 * 1. The provider decides **which** adapter comes into being — the only
 *    `switch` about it in the application is `createAiFormGenerator`.
 * 2. "Does the feature exist?" and "is there an adapter?" are the same
 *    predicate in **every** configuration. That is the drift this is about:
 *    a switch that says "yes" while the route has nothing to call (or the
 *    other way round) is exactly "letting the switch only hide the user
 *    interface" — and invisible as long as someone only checks the configured
 *    case.
 *
 * ## What has changed
 *
 * This file used to boot `AiModule` and read **two container bindings**: a
 * `boolean` and an adapter, both bound from the environment at startup. Since
 * the configuration lives in the settings row, these bindings no longer exist
 * — they would be an answer from a while ago from the first save onwards.
 *
 * What is measured is therefore what is left over and what really carries the
 * promise: the **pure** resolution and the **pure** factory. No container, no
 * `API_ENV`, no database — the four configurations are a table instead of four
 * processes, and that is stricter than before, because no Nest bootstrap lies
 * in between any more that could explain a result.
 */

/**
 * The four configurations named above, plus the second provider
 * — without it "the selection happens in one place" would be a statement about
 * a `switch` with one arm.
 */
const CONFIGURATIONS = [
  {
    name: 'nichts konfiguriert',
    settings: {} satisfies AiSettingsFields,
    available: false,
    adapter: null,
  },
  {
    name: 'anthropic, vollständig',
    settings: {
      provider: 'anthropic',
      apiKey: 'sk-test',
    } satisfies AiSettingsFields,
    available: true,
    adapter: AnthropicFormGenerator,
  },
  {
    name: 'mistral, vollständig',
    settings: {
      provider: 'mistral',
      apiKey: 'sk-test',
      model: 'mistral-pinned-0000',
    } satisfies AiSettingsFields,
    available: true,
    adapter: MistralFormGenerator,
  },
  {
    name: 'konfiguriert, aber installationsweit abgeschaltet',
    settings: {
      provider: 'anthropic',
      apiKey: 'sk-test',
      enabled: false,
    } satisfies AiSettingsFields,
    available: false,
    adapter: null,
  },
] as const;

/**
 * Which server the built Mistral client carries.
 *
 * ⚠️ **Read through the internals of the SDK, and that is deliberate.** The
 * alternative would have been to give the adapter a getter that only a test
 * uses — production surface for a measurement, that is. This version is more
 * brittle: if it breaks on an SDK change, that is the right moment to notice
 * it, because then the place has changed on which the promise from ADR-0015
 * no. 13 hangs. An `undefined` here would be silently green if the assertion
 * `toBe(region)` were not there.
 */
function serverOf(generator: unknown): unknown {
  const client = (generator as { client?: { _options?: { server?: unknown } } })
    .client;
  return client?._options?.server;
}

describe('die KI-Naht', () => {
  it.each(CONFIGURATIONS)(
    '$name: Verfügbarkeit und Naht stimmen überein',
    ({ settings, available, adapter }) => {
      const config = resolveAiConfig(settings);

      expect(aiAvailable(settings)).toBe(available);
      // "There is an adapter" is **the same by definition** as "there is a
      // resolution": the factory takes a resolution and cannot be called at
      // all without one. That is the structural replacement for the earlier
      // binding to `null` — the error "adapter there, switch off" can no
      // longer be expressed, instead of merely not occurring.
      expect(config === null).toBe(adapter === null);
      if (config !== null && adapter !== null) {
        expect(createAiFormGenerator(config)).toBeInstanceOf(adapter);
      }
    },
  );

  /**
   * **The off switch reaches the seam, not just the menu.**
   *
   * The reproduction here is "letting the switch only hide the
   * user interface"; this is the half that a web test cannot
   * see — with the switch off there is **nothing to call**, whatever the
   * user interface may render.
   */
  it('der abgeschaltete Schalter lässt eine vollständige Zeile ohne Naht', () => {
    expect(
      resolveAiConfig({
        provider: 'anthropic',
        apiKey: 'sk-test',
        enabled: false,
      }),
    ).toBeNull();
  });

  /**
   * The region reaches through into the adapter — it is not a display value.
   *
   * Without this assertion it would be a statement about a form field: the enum
   * would stand in the row, and the adapter would go on calling its hard-wired
   * endpoint. But the pinned EU endpoint **is** the data protection promise
   * from ADR-0015 no. 13, and a promise the call does not know about is none.
   */
  it.each(['eu', 'global', 'us'] as const)(
    'reicht die Region %s bis in den Adapter durch',
    (region) => {
      const config = resolveAiConfig({
        provider: 'mistral',
        apiKey: 'sk-test',
        model: 'mistral-pinned-0000',
        region,
      });
      expect(config?.region).toBe(region);
      // `resolveAiConfig` never returns null for this complete row — the
      // assertion one line above is the proof, not the assumption.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- proven by the line above
      const generator = createAiFormGenerator(config!);
      expect(generator).toBeInstanceOf(MistralFormGenerator);
      expect(serverOf(generator)).toBe(region);
    },
  );
});
