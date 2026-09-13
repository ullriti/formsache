import { Injectable, Module } from '@nestjs/common';
import type { ResolvedAiConfig } from '@formsache/shared';

import { ConfigModule } from '../config/config.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { AiFormGenerator, AiFormGeneratorFactory } from './ai-form-generator';
import { AnthropicFormGenerator } from './anthropic-form-generator';
import { MistralFormGenerator } from './mistral-form-generator';
import { AiUsageService } from './usage/ai-usage.service';

/**
 * **The one place the provider is chosen** (ADR-0015 no. 5).
 *
 * A `switch` over `AI_PROVIDER` exists exactly here. `resolveAiConfig` in
 * `packages/shared` decides *whether* there is a configuration and *which*;
 * this function turns that answer into an adapter, and no other file in the
 * application knows that there are two of them.
 *
 * `null` when the feature is not configured — which is the same `null` the
 * route answers **404** to. „Gibt es hier nicht" is a different
 * statement from „ist gerade kaputt", and the second one invites a retry and
 * promises a return (ADR-0015 no. 9).
 */
export function createAiFormGenerator(
  config: ResolvedAiConfig,
): AiFormGenerator {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicFormGenerator(config);
    case 'mistral':
      return new MistralFormGenerator(config);
  }
}

/**
 * The factory as a binding — a one-liner around {@link createAiFormGenerator}.
 *
 * Separate from the function because the function is meant to stay **pure**: it is
 * what `ai-module.spec.ts` tries out across all providers without building a
 * Nest container.
 */
@Injectable()
export class DefaultAiFormGeneratorFactory extends AiFormGeneratorFactory {
  create(config: ResolvedAiConfig): AiFormGenerator {
    return createAiFormGenerator(config);
  }
}

/**
 * The AI seam, and nothing else.
 *
 * **One binding plus the availability flag, and that shape is the decision**
 * rather than housekeeping — the same argument `FileStorageModule` makes: a
 * module that provides exactly one thing cannot hand out a second one by
 * accident. Whoever adds a provider here widens what an importer can inject,
 * and that is the sentence they have to write in the review.
 *
 * The public fill-in path must **never** import this module;
 * the proof of that is the module-shape test, not the lint —
 * ESLint sees direct import strings, not the transitive DI chain (one
 * import „nur für die Uhr" defeated the list while its own comment claimed the
 * opposite).
 *
 * ## Why no availability switch is bound here any more
 *
 * This module used to bind two things out of the environment: a `boolean`
 * `AI_AVAILABLE` and a finished adapter (or `null`). Both were
 * expressions of **one** resolution and therefore could not drift apart.
 *
 * By now the configuration lives in `system_setting` and changes
 * during operation. A `boolean` held fast in the container would be a lie from the
 * first save on — which is why this module binds **no answer**
 * any more but imports the one reader (`AiSettingsService`) and a
 * factory. The property „menu and route cannot drift apart"
 * remains and has even become tighter: there is now exactly **one** place that
 * reads the row, and all three askers — guard, session payload and
 * generation — go through it.
 *
 * ## And why the counter is here
 *
 * {@link AiUsageService} is the **bracket around** the seam (ADR-0015 no. 7):
 * whoever calls the provider goes through it, because counting happens before the call and a
 * failure counts exactly once. Keeping both in one module is the point —
 * a route that can inject `AiFormGenerator` but would have to look for the counter in
 * another module would be an invitation to forget it. It brings
 * **no** `PrismaService` with it: counting happens over the `TenantScope` the
 * guard chain hands in, and `MailClockModule` provides one binding and
 * exports one token.
 *
 * The **purge** of the free texts is explicitly *not* here but in
 * `ai/purge/` with a module of its own: it holds `PrismaService` without a tenant and
 * runs even when the feature is switched off.
 */
@Module({
  imports: [ConfigModule, MailClockModule, SystemSettingsModule],
  providers: [
    AiUsageService,
    {
      provide: AiFormGeneratorFactory,
      useClass: DefaultAiFormGeneratorFactory,
    },
  ],
  exports: [AiFormGeneratorFactory, AiUsageService],
})
export class AiModule {}
