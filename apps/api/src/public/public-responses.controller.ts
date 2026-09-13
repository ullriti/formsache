import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  submitResponseRequestSchema,
  type ResponseEdit,
  type SubmitResponseResponse,
} from '@formsache/shared';

import { CsrfExempt } from '../auth/csrf.guard';
import {
  PUBLIC_READ_RATE_LIMIT,
  PUBLIC_SUBMIT_RATE_LIMIT,
} from './public-forms.rate-limit';
import { PublicFormsService } from './public-forms.service';

/**
 * „Bearbeiten nach Absenden" — the two routes of the requirement.
 *
 * **A controller of its own, under `public/responses`, and not two more methods
 * on `public/forms/:slug`.** The address a participant is handed carries a token
 * and nothing else: no slug, no form id, no organisation. That is the point of the
 * capability — the link says *which answer*, and everything else is looked up
 * from it. Nesting these under a slug would put a second identifier into a URL
 * that goes out by e-mail, for no gain and with the usual cost of a URL that
 * says more than it must.
 *
 * The guard chain is absent for the same reason it is absent next door: a
 * participant has no account. What stands in its place:
 *
 * - **the token** — 128 bits of CSPRNG on the answer's own row
 *   (`edit-token.ts`), resolved before anything else is decided;
 * - **a rate limit on both routes**, keyed by address at the root
 *   (`common/rate-limit.module.ts`, IPv6 reduced to its /64). There is still
 *   exactly **one** `ThrottlerModule.forRoot`; these routes name their numbers
 *   with `@Throttle` and inherit nothing by accident;
 * - **the JSON body limit** from `app-setup.ts`;
 * - **schema validation derived from the answer's own snapshot**, never from the
 *   draft and never from the newest version.
 */
@Controller('public/responses')
export class PublicResponsesController {
  constructor(private readonly forms: PublicFormsService) {}

  /**
   * The answer behind the token, with the form it was given against.
   *
   * Reuses the public read's generous limit rather than a third number: this is
   * the same kind of request — a participant opening a page, going back and
   * reloading — and a tighter counter would trip on the honest case first.
   */
  @Get(':token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_READ_RATE_LIMIT })
  byToken(@Param('token') token: string): Promise<ResponseEdit> {
    return this.forms.byEditToken(token);
  }

  /**
   * Replaces the answers — **`PUT`, because it is a replacement of one existing
   * thing** and not the creation of another. That is not only REST manners: the
   * whole promise here is „keine zweite Zeile", and a `POST` to a
   * collection is the shape that produces one.
   *
   * `@CsrfExempt()` for the third public route, with the same justification as
   * the other two and no more: there is no session here to ride on. A forged
   * request from another site can only change an answer whose token the forger
   * already holds — and holding the token *is* the authorisation, so there is no
   * privilege for a cross-site request to borrow.
   */
  @Put(':token')
  @HttpCode(HttpStatus.OK)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_SUBMIT_RATE_LIMIT })
  update(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<SubmitResponseResponse> {
    // The same envelope a first submission uses — `answers` plus the optional
    // start token. Deliberately not a schema of its own: an edit *is* a
    // submission against the same definition, and a second contract would be a
    // second place for the two to disagree about what an answer looks like.
    const parsed = submitResponseRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The envelope, not the answers — the same sentence the submission route
      // gives, for the same reason: describing our own contract precisely to
      // somebody probing it says more than it needs to.
      throw new BadRequestException('Die Anfrage ist ungültig.');
    }
    return this.forms.updateByEditToken(
      token,
      parsed.data.answers,
      parsed.data.startToken,
      // The same decoy the first submission carries: the
      // edit page renders the same fill-in view, so a filler that takes the
      // bait here takes it there too — and this route is the token-borne,
      // public one the requirement is about.
      parsed.data.honeypot,
    );
  }
}
