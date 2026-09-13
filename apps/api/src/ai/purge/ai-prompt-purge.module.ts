import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { MailClockModule } from '../../mail/mail-clock.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AiPromptPurgeService } from './ai-prompt-purge.service';
import { JobRunModule } from '../../observability/job-run.module';

/**
 * The purge of the AI free texts — **a module of its
 * own in a directory of its own**, and both halves are the decision.
 *
 * *A directory of its own*, because this is the only place in the AI code that
 * holds `PrismaService` without a `TenantScope` around it: the job works across
 * organizations. The allowlist in `eslint.config.js` therefore names
 * `apps/api/src/ai/purge/**` and not `ai/**` — the same cut as with
 * `files/purge/**`. The read and write path next door stays fenced in, and it
 * is exactly this counter-check that makes the entry defensible (ADR-0015 no. 8).
 *
 * *A module of its own*, because `AiModule` provides exactly two things — the
 * seam and the availability flag — and one more provider there widens what an
 * importer can inject (an import "just for the clock" brought along three
 * services that can open a plaintext secret). The purge needs nothing from
 * `AiModule` and `AiModule` nothing from it: it runs **even then**, when
 * the feature is switched off, because a deletion promise does not disappear
 * along with the key.
 *
 * `MailClockModule` is this application's one injected clock; it provides one
 * binding and exports one token, so it brings nothing along.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailClockModule, // the requirement: this run keeps books.
    JobRunModule,
  ],
  providers: [AiPromptPurgeService],
})
export class AiPromptPurgeModule {}
