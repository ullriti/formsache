import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
} from '@formsache/shared';

import { parseRequest } from '../../common/parse-request';
import { CsrfExempt } from '../csrf.guard';
import {
  PASSWORD_RESET_FLOOR_MS,
  PasswordResetService,
} from './password-reset.service';

/**
 * The limit on **requesting** per origin (ADR-0020).
 *
 * Twenty a minute, and the number is deliberately looser than the ten of
 * signing in: what makes this route expensive — the mail — is already capped
 * **per address** (`password-reset-rate-limit.ts`, three an hour), and that is
 * the dimension in which the abuse takes place. What remains here is the
 * protection of the process against repeat runs, and for that a number in the
 * order of magnitude of the public submit route is right. Set too tight it
 * would first hit a branch office behind **one** NAT address, on a Monday
 * morning on which three people have forgotten their password at the same time
 * — and the two-dimension limiting of the work item exists precisely so that
 * the one dimension does not have to carry both.
 */
export const PASSWORD_RESET_REQUEST_RATE_LIMIT = {
  limit: 20,
  ttl: 60_000,
} as const;

/**
 * The limit on **redeeming** per origin.
 *
 * The same number as when signing in, and for the same reason: every call
 * computes an Argon2id on **every** path — the price for an invalid token not
 * being recognisable from the response time (`PasswordResetService.confirm`).
 * Without a cap the measure that prevents the measuring would be an amplifier.
 *
 * `@Throttle` and not the registered default: `ThrottlerGuard` counts per
 * handler, so the two routes share **no** quota. That is intended — whoever
 * occupies the one path should not block the other — and the reason why the
 * numbers stand at the routes and are not merely inherited.
 */
export const PASSWORD_RESET_CONFIRM_RATE_LIMIT = {
  limit: 10,
  ttl: 60_000,
} as const;

/**
 * „Passwort vergessen" — two routes, both reachable without being signed in.
 *
 * ## Why an own controller next to `AuthController`
 *
 * Because different rules apply here and they should be visible: no
 * `SessionGuard` (there is no session), `@CsrfExempt` (there is no cookie to
 * abuse), an own limit — and every answer is deliberately free of
 * information. In `AuthController` these four exceptions would stand among
 * routes for which the opposite holds.
 *
 * ## Why no `GET` on the token
 *
 * The obvious third route — „is this link still valid?", so that the page does
 * not show the form in the first place — does not exist. It would be a testing
 * device for guessed values that would not have the Argon2id brake of the
 * redeeming, and it would spare nobody anything: the page shows the form, and
 * the refusal comes on submitting. One path, one price.
 */
@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  /**
   * Requests a reset link.
   *
   * **204, always.** No body, no difference between an address that exists and
   * one that does not — and none between a local account and an SSO account.
   * An invalid body answers this way too: a 400 for „that is not an e-mail
   * address" would be harmless in itself, but there would be two answers where
   * there is meant to be one, and the next addition to this route would have to
   * think the distinction through again. What is actually mistyped is said by
   * the form in the browser, before it submits.
   */
  @Post('request')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PASSWORD_RESET_REQUEST_RATE_LIMIT })
  // There is no session that a foreign page call could exploit; the route is
  // instead protected by accepting only `application/json` (`app-setup.ts`) —
  // the same situation as when signing in.
  @CsrfExempt()
  async request(@Body() body: unknown): Promise<void> {
    // **The floor lies around both exits, not only around the one** (a
    // security finding). A body rejected by the schema previously came back
    // after ~1 ms, while every other path needed 400 ms. That is no
    // enumeration — it distinguishes syntax, not existence —, but the promise
    // reads „one exit, one floor", and a promise with one exception is the
    // template for the next exception.
    await settleFloor(async () => {
      const parsed = passwordResetRequestSchema.safeParse(body);
      if (parsed.success) {
        await this.resets.request(parsed.data.email);
      }
    });
  }

  /**
   * Redeems a link and sets the new password.
   *
   * 204 on success, otherwise **one** refusal (400) — equally for an unknown,
   * expired, used-up or foreign token
   * (`PASSWORD_RESET_INVALID_MESSAGE`, thrown in the service).
   *
   * A **too short password**, by contrast, gets the ordinary field message
   * from {@link parseRequest}, and that is no breach of the rule above it: the
   * check runs before any token is looked up, and says something only about
   * the body the sender wrote themselves. Merging it with the token refusal
   * would mean telling somebody „Ihr Link ist abgelaufen" while in truth their
   * password had six characters — a dead end nobody finds their way out of.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PASSWORD_RESET_CONFIRM_RATE_LIMIT })
  @CsrfExempt()
  async confirm(@Body() body: unknown): Promise<void> {
    const parsed = parseRequest(passwordResetConfirmSchema, body);
    await this.resets.confirm(parsed.token, parsed.password);
  }
}

/**
 * Runs `run` and answers at the earliest after {@link PASSWORD_RESET_FLOOR_MS}.
 *
 * Here and not (any more) only in the service, so that **every** exit of this
 * route has the same floor — including the one that does not reach the service
 * at all. The service keeps its own floor: it is the place where the two
 * domain branches („the account exists" / „it does not exist") diverge, and a
 * floor that lies only at the route would be the first one a second caller of
 * the service would not have. Two floors of the same height cost nothing —
 * `settleAt` waits until the point in time is reached, and that is the same
 * one.
 */
async function settleFloor(run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
  } finally {
    const remaining = startedAt + PASSWORD_RESET_FLOOR_MS - Date.now();
    if (remaining > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remaining);
      });
    }
  }
}
