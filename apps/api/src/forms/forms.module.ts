import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TrashModule } from '../trash/trash.module';
import { FormsController } from './forms.controller';
import { FormsService } from './forms.service';

/**
 * Forms, their versions and the answers to them.
 *
 * No `PrismaModule` import — nothing in here talks to the database except
 * through the `TenantScope` the guard chain hands in, and the lint rule in
 * `eslint.config.js` makes that a build failure rather than a review finding.
 */
@Module({
  // `TrashModule` for the four trash routes, which address a
  // form and live on this controller — see the note there.
  //
  imports: [AuthModule, TenancyModule, TrashModule],
  controllers: [FormsController],
  providers: [FormsService],
})
export class FormsModule {}
