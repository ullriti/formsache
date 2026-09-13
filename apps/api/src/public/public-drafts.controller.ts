import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  saveDraftRequestSchema,
  type ResponseDraft,
  type SavedDraft,
} from '@formsache/shared';

import { CsrfExempt } from '../auth/csrf.guard';
import {
  PUBLIC_READ_RATE_LIMIT,
  PUBLIC_SUBMIT_RATE_LIMIT,
} from './public-forms.rate-limit';
import { PublicFormsService } from './public-forms.service';

/**
 * *Zwischenspeichern* — the two token-borne routes of the requirement.
 *
 * **A controller of its own, under `public/drafts`, and not two more methods on
 * `public/forms/:slug`.** The address a participant reads off their screen
 * carries a token and nothing else: no slug, no form id, no organisation. That is the
 * point of the capability — the address says *which draft*, and everything else
 * is looked up from it. Nesting these under a slug would put a second identifier
 * into an address somebody copies by hand, for no gain.
 *
 * The guard chain is absent for the reason it is absent in both neighbours: a
 * participant has no account. What stands in its place:
 *
 * - **the token** — 128 bits of CSPRNG on the draft's own row
 *   (`draft-token.ts`), resolved before anything else is decided, and revocable
 *   by deleting that row;
 * - **the switch, read on every access** — a draft address stops working the
 *   moment *Zwischenspeichern* is turned off, which is the third thing this
 *   rule states for `allowEdit`;
 * - **the expiry, read on every access** — an expired draft answers the one 404,
 *   whether or not a purge has reached it yet;
 * - **a rate limit on every route here**, keyed by address at the root
 *   (`common/rate-limit.module.ts`, IPv6 reduced to its /64). There is still
 *   exactly **one** `ThrottlerModule.forRoot`; these routes name their numbers
 *   with `@Throttle` and inherit nothing by accident. ⚠️ **Each route
 *   counts in a bucket of its own** — see the note at the write limit below;
 * - **the JSON body limit** from `app-setup.ts`;
 * - **schema validation derived from the draft's own snapshot** — everything a
 *   submission is held to except the Pflicht rule (`safeParseDraftAnswers`).
 *
 * **Nothing here queues a mail**, and that is the decision of the design rather
 * than an omission: the participant is shown the address and copies it, so the
 * trigger „Zwischenspeichern" is not built at all.
 */
@Controller('public/drafts')
export class PublicDraftsController {
  constructor(private readonly forms: PublicFormsService) {}

  /**
   * The half-filled form behind a draft address — **the whole reason the draft
   * lives on the server**: this answers a browser that has never seen the form.
   *
   * Reuses the public read's generous **number** rather than a third one: this
   * is the same kind of request — somebody opening a page, going back and
   * reloading — and a tighter counter would trip on the honest case first. It
   * is the number that is shared, not the counter; see the write route below.
   */
  @Get(':token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_READ_RATE_LIMIT })
  byToken(@Param('token') token: string): Promise<ResponseDraft> {
    return this.forms.byDraftToken(token);
  }

  /**
   * Replaces the answers of an existing draft — **`PUT`, because it is a
   * replacement of one existing thing** and not the creation of another. The
   * first save is the `POST` under the form, which is where the address is
   * minted; a second `POST` here would produce a second draft and a second
   * address for one participant.
   *
   * `@CsrfExempt()` with the same justification as everywhere else on this
   * surface: there is no session to ride on, and a forged request can only
   * change a draft whose token the forger already holds — holding the token *is*
   * the authorisation, so there is no privilege to borrow.
   *
   * **`PUBLIC_SUBMIT_RATE_LIMIT` is the same number, in a bucket of its own**
   * (the drafts review). `ThrottlerGuard` keys its counter by handler, so
   * every route naming this constant gets its own thirty per minute — not a
   * shared counter. *Measured on 2026-08-05:* the same address exhausts the
   * drafts (429) and afterwards still gets 200 on `POST …/responses` — it is 30
   * **plus** 30 writes per minute, and with the deletion below 90.
   *
   * Left as it is rather than merged into one counter, and the reason is what
   * each number is for: a rate limit bounds how fast one address may act on
   * *this* kind of resource, and „ich sende ab" and „ich speichere zwischen"
   * are different resources with different costs. What bounds the *total* a
   * draft path can accumulate is not this counter at all — it is the Mengen-
   * grenze of `draft-quota.ts`, which no number of addresses can walk around.
   */
  @Put(':token')
  @HttpCode(HttpStatus.OK)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_SUBMIT_RATE_LIMIT })
  update(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<SavedDraft> {
    // The same envelope the first save uses — deliberately not a schema of its
    // own: continuing a draft *is* saving one, and a second contract would be a
    // second place for the two to disagree about what a draft carries.
    const parsed = saveDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The envelope, not the answers — the same sentence every other public
      // route gives.
      throw new BadRequestException('Die Anfrage ist ungültig.');
    }
    return this.forms.updateDraft(token, parsed.data.answers);
  }

  /**
   * **The way to get rid of a draft** (DSGVO Art. 17).
   *
   * The person a draft belongs to has no account and no trash, so without
   * this route the only thing they could do was overwrite the answers and leave
   * the row — with its organisation, its form reference and its timestamps — standing
   * until the retention ran out. `DELETE` on the draft's own address is the
   * smallest thing that is actually a deletion.
   *
   * **204 and no body**: there is nothing to say, and an answer that named the
   * form or the organisation would be an oracle handed out at the moment the capability
   * stops working. A second `DELETE` with the same token meets the one 404 like
   * every other token that names nothing.
   *
   * The switch is **not** consulted here, unlike on `GET` and `PUT` — see
   * `PublicFormsService.deleteDraft`: a setting that governs saving must not
   * become a lock on the exit.
   *
   * `@CsrfExempt()` for the reason its neighbours give, with one addition worth
   * naming: a forged request from another site can destroy a draft whose token
   * the forger already holds, and holding it already allows overwriting the
   * answers with an empty document. So there is nothing here a `PUT` did not
   * already allow.
   *
   * The write limit, in a bucket of its own like every other route — the note at
   * the `PUT` above says what that does and does not mean.
   */
  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_SUBMIT_RATE_LIMIT })
  remove(@Param('token') token: string): Promise<void> {
    return this.forms.deleteDraft(token);
  }
}
