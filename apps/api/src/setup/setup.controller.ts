import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { setupRequestSchema, type SetupState } from '@formsache/shared';

import { CsrfExempt } from '../auth/csrf.guard';
import { parseRequest } from '../common/parse-request';
import { SETUP_RATE_LIMIT, SETUP_STATE_RATE_LIMIT } from './setup.rate-limit';
import { SetupService } from './setup.service';

/**
 * Transport of the Erstinbetriebnahme (ADR-0022) — thin like every controller
 * here: parse the request, call the service, set the status.
 *
 * **Both routes are reachable without a session, and neither of them has a
 * guard that decides that.** What protects them is no permission
 * but a condition over the data stock: `POST` creates as long as there are
 * **zero rows in `user`**, and answers 404 afterwards. This condition
 * does not stand here but in the same transaction as the write
 * (`first-superadmin.ts`) — a guard in front of it would be a second check that
 * looks just the same and guarantees nothing.
 */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /**
   * Whether the application should show the setup instead of the login.
   *
   * The generous limit is intentional and reasoned: this route is asked once by
   * *every* logged-out page call, not only on the
   * setup day (`setup.rate-limit.ts`).
   */
  @Get()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: SETUP_STATE_RATE_LIMIT })
  state(): Promise<SetupState> {
    return this.setup.state();
  }

  /**
   * Sets up: first superadministrator, plus — skippable — a first
   * organisation.
   *
   * **204, without a body.** Not 201: no address comes into being to which a
   * caller could go, and nothing goes back that they would have to know.
   * Above all **no session** goes back: whoever has set up logs in
   * afterwards over the normal login. That is one line less
   * power for the most dangerous route of this application — and proves quite
   * incidentally that the credentials just set work.
   *
   * `@CsrfExempt()` for the same reason as with the login: there is
   * no session here yet on which a forgery could ride. Instead the route is
   * protected by accepting only `application/json`
   * (`app-setup.ts`) — which puts it out of reach of a stranger's form.
   */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: SETUP_RATE_LIMIT })
  @CsrfExempt()
  run(@Body() body: unknown): Promise<void> {
    return this.setup.run(parseRequest(setupRequestSchema, body));
  }
}
