import { Module } from '@nestjs/common';

import { API_ENV, loadEnv } from './env';

/**
 * Provides the validated environment under the `API_ENV` token.
 *
 * A module of its own rather than a provider repeated per feature module: the
 * environment is parsed once, and a second module that needs it (Prisma, and
 * the auth module) imports this instead of copying the factory. Not
 * `@Global()` on purpose — an import that is written down is easier to follow
 * than one that happens invisibly.
 */
@Module({
  providers: [{ provide: API_ENV, useFactory: () => loadEnv() }],
  exports: [API_ENV],
})
export class ConfigModule {}
