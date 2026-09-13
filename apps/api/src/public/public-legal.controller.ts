import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  systemLegalPageSchema,
  tenantLegalPageSchema,
  type PublicLegalFooter,
  type PublicLegalPage,
} from '@formsache/shared';

import { PUBLIC_READ_RATE_LIMIT } from './public-forms.rate-limit';
import { PublicLegalService } from './public-legal.service';

/**
 * The legal pages, **without a login** (ADR-0028).
 *
 * ## Why they stand here and not next to the system settings
 *
 * Because they have the same property this whole module is built around:
 * no session, no tenant scope, no group permission. What protects them
 * instead stands in the module and applies here unchanged — a rate limit per
 * address and a 404 that does not distinguish between „it does not exist" and
 * „I am not allowed to".
 *
 * ## The page key is **checked**, not passed through
 *
 * `systemLegalPageSchema` and `tenantLegalPageSchema` are the allow-list,
 * and they are it where every other allow-list of this application stands: in
 * `@formsache/shared`. A parameter that went unchecked as a key into a
 * template register would be the way on which a stranger looks things up in
 * an object at will.
 *
 * **The key and not the address segment.** `/imprint` is the address in the
 * browser; `imprint` is the name of the page in the contract.
 * The translation between the two belongs in the router (`systemLegalPageOf`),
 * and having it a second time in an HTTP route would mean keeping the same
 * table true in two places.
 *
 * ## `no-store` stays, although the analysis argues against it
 *
 * `docs/legal/README.md` 5.6 proposes delivering these pages cacheable —
 * they carry nothing personal, and „ständig verfügbar" under § 18 MStV
 * speaks for it. That is right and is nonetheless **not** done here: the
 * `no-store` bolt of this application sits as the first handler in front of
 * the body parser (`common/no-store.ts`), so that even an answer that reaches
 * no controller at all carries it, and it justifies itself expressly as
 * „a blanket rule that is occasionally too strict beats a list
 * that is occasionally too lax". This route would be the first entry of such
 * a list. What the proposal would gain is one network fetch per
 * page view for a few kilobytes of text; what it would cost is the property
 * that **every** answer of this API is unconditionally fresh. An exception to
 * that belongs in a decision of its own — it is named in the ADR as an open
 * point, not made here in passing.
 */
@Controller('public/legal')
@UseGuards(ThrottlerGuard)
@Throttle({ default: PUBLIC_READ_RATE_LIMIT })
export class PublicLegalController {
  constructor(private readonly legal: PublicLegalService) {}

  /**
   * What the footer needs about the installation.
   *
   * A tiny fetch of its own instead of a field on every fill-in answer:
   * the footer stands below six views with five different
   * payloads, and writing the field into all five contracts would be the same
   * decision five times — and five times the opportunity to forget it on the
   * sixth.
   */
  @Get()
  footer(): Promise<PublicLegalFooter> {
    return this.legal.footer();
  }

  @Get('system/:page')
  systemPage(@Param('page') raw: string): Promise<PublicLegalPage> {
    const page = systemLegalPageSchema.safeParse(raw);
    if (!page.success) {
      throw new NotFoundException('Diese Seite gibt es nicht.');
    }
    return this.legal.systemPage(page.data);
  }

  @Get('tenant/:shortName/:page')
  tenantPage(
    @Param('shortName') shortName: string,
    @Param('page') raw: string,
  ): Promise<PublicLegalPage> {
    const page = tenantLegalPageSchema.safeParse(raw);
    if (!page.success) {
      throw new NotFoundException('Diese Seite gibt es nicht.');
    }
    return this.legal.tenantPage(shortName, page.data);
  }
}
