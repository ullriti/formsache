import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import type { ApiEnv } from '@formsache/shared';
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { AiFeatureGuard } from '../../src/ai/ai-feature.guard';
import {
  AiFormGenerator,
  AiFormGeneratorFactory,
} from '../../src/ai/ai-form-generator';
import { AiFormsService } from '../../src/ai/ai-forms.service';
import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { AiUsageService } from '../../src/ai/usage/ai-usage.service';
import { API_ENV } from '../../src/config/env';
import { PublicFormsModule } from '../../src/public/public-forms.module';
import { PublicFormsService } from '../../src/public/public-forms.service';

/**
 * **The public path does not know the AI** .
 *
 * Model and reasoning: `test/files/module-shape.spec.ts`. What is measured
 * here is the **assembled module graph** — `{ strict: false }` searches
 * everything `PublicFormsModule` imported, transitively — and that is the whole
 * point of the file: the `no-restricted-imports` entry for
 * `apps/api/src/public/**` sees *import strings* and would stay green for a
 * service that arrives through a module imported for something else. That is
 * not a hypothetical: a review finding once handed `MailSecretsService`, `MailIdentityService`
 * and `MailTransport` to the public path through an import „nur für die Uhr",
 * while the comment on that module claimed the opposite.
 *
 * *Reproduction:* add `AiModule` (or `AiFormsModule`) to `PublicFormsModule`'s
 * imports — every assertion below turns red, and the lint entry stays green,
 * which is exactly the asymmetry the requirement names.
 *
 * ⚠️ **What this file does not prove** is that no *route* of the public path
 * could reach the AI by other means; it proves that nothing in that graph can
 * be injected. The route-side half is `route-access.spec.ts`, where the guard
 * chain answers.
 */

/** The environment fields the public graph reads at construction time. */
const TEST_ENV = {
  FILE_STORAGE_DIR: '/nonexistent-on-purpose',
  // Minted per run and never written down — no key material in the repository
  // . `SecretBoxModule` decodes it while the graph is built.
  SECRET_BOX_KEY: randomBytes(32).toString('base64'),
  FILE_PURGE_INTERVAL_MS: 0,
  // The AI **configured**, deliberately: a graph that cannot reach the seam
  // because there is no seam would prove nothing. Every assertion below has to
  // hold on an installation that has an AI.
  AI_PROVIDER: 'anthropic',
  AI_ANTHROPIC_API_KEY: 'sk-module-shape',
  AI_ENABLED: true,
} as unknown as ApiEnv;

describe('PublicFormsModule — the public path cannot reach the AI ', () => {
  const build = async () =>
    Test.createTestingModule({ imports: [PublicFormsModule] })
      .overrideProvider(API_ENV)
      .useValue(TEST_ENV)
      .compile();

  it.each([
    { name: 'the seam', token: AiFormGenerator },
    { name: 'the counter', token: AiUsageService },
    { name: 'the route service', token: AiFormsService },
    { name: 'the availability guard', token: AiFeatureGuard },
    { name: 'the concrete adapter', token: AnthropicFormGenerator },
  ])(
    'hands out neither $name, not even from the whole graph',
    async ({ token }) => {
      const moduleRef = await build();
      expect(() => {
        moduleRef.get(token, { strict: false });
      }).toThrow();
    },
  );

  /**
   * The availability flag as well, and it is worth its own case: it is a plain
   * `boolean` token, so a stray import would not be caught by „no service of
   * ours is reachable" — and it is the value that says whether this
   * installation pays for an AI, which a route without a session has no
   * business knowing.
   */
  it('hands out no generator factory either', async () => {
    const moduleRef = await build();
    expect(() => {
      moduleRef.get(AiFormGeneratorFactory, { strict: false });
    }).toThrow();
  });

  /**
   * The premise, measured rather than assumed — the same guard
   * `key-confinement.spec.ts` puts under its repository walk. Without it every
   * assertion above would also pass against a module that failed to compile
   * anything at all.
   */
  it('reads a graph that does contain the public services', async () => {
    const moduleRef = await build();
    expect(moduleRef.get(PublicFormsService, { strict: false })).toBeInstanceOf(
      PublicFormsService,
    );
  });
});
