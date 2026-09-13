import { Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';

import { PrismaService } from './prisma.service';

/**
 * Database access for the feature modules.
 *
 * Not `@Global()`, for the same reason as `ConfigModule`: a module that states
 * where its database access comes from is easier to follow — and easier to
 * replace in a test — than one that receives it invisibly.
 */
@Module({
  imports: [ConfigModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
