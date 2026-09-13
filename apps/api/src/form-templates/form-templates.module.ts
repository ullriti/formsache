import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  FormTemplateSaveController,
  FormTemplatesController,
} from './form-templates.controller';
import { FormTemplatesService } from './form-templates.service';

/**
 * *Vorlagen & Blöcke*  — **der Mechanismus, ohne
 * mitgelieferten Inhalt** .
 *
 * Two controllers, one service: saving is a property of the form it copies
 * from (`forms/:formId/templates`), while listing, inserting and deleting are
 * properties of the organisation (`form-templates`). Splitting them is what lets the
 * fourth link of the guard chain read the form id off the route on the one
 * that has one, and say out loud that the others have none.
 *
 * No `PrismaModule` import — nothing in here talks to the database except
 * through the `TenantScope` the guard chain hands in, and the lint rule in
 * `eslint.config.js` makes that a build failure rather than a review finding.
 */
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [FormTemplateSaveController, FormTemplatesController],
  providers: [FormTemplatesService],
})
export class FormTemplatesModule {}
