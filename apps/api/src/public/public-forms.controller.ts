import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  accessProofSchema,
  accessRequestSchema,
  saveDraftRequestSchema,
  submitResponseRequestSchema,
  type AccessGrant,
  type SavedDraft,
  type SubmitResponseResponse,
} from '@formsache/shared';

import { CsrfExempt } from '../auth/csrf.guard';
import { accessAttemptTracker } from './access-attempt-tracker';
import {
  PUBLIC_ACCESS_RATE_LIMIT,
  PUBLIC_READ_RATE_LIMIT,
  PUBLIC_SUBMIT_RATE_LIMIT,
} from './public-forms.rate-limit';
import {
  PublicFormsService,
  type PublicFormReadPayload,
} from './public-forms.service';

/**
 * Header the access proof of the requirement travels in, on the read **and** on
 * the submission.
 *
 * A header rather than a path segment or a query parameter, for the same reason
 * the word itself may only be in a body: a URL is written to the access log,
 * handed to the next site in `Referer` and kept in the browser's history. The
 * proof is not the word, but it opens the same door for an hour, so it is given
 * the same treatment.
 *
 * A header rather than the body on the submission, too — even though the start
 * token rides in the body there. The read is a `GET` and has no body at
 * all, so one of the two requests had to use a header; using it for both means
 * the client attaches the proof in one place and the server reads it in one
 * place, instead of the same value having two homes.
 */
export const ACCESS_PROOF_HEADER = 'x-form-access';

/**
 * The proof as it arrives, bounded by its own contract — or `undefined`.
 *
 * `startTokenSchema` was enforced on the way in from the first day, because the
 * token rides in a body that is parsed as a whole. The proof rides in a header
 * and was taken as a raw `string`, so `accessProofSchema` existed and was applied
 * to nothing on this side of the wire. Nothing broke — `AccessProofService.holds`
 * refuses a malformed value like any other, and a header is length-bounded by the
 * HTTP server long before it gets here — but an asymmetry like that reads as a
 * decision, and the next person to add a header will copy whichever half they see
 * first.
 *
 * A value that does not parse becomes „no proof", not a 400: a caller who sends a
 * broken header has to meet the same locked form as one who sends none, or the
 * refusal starts distinguishing between shapes of failure (second
 * bullet).
 */
function offeredProof(raw: string | undefined): string | undefined {
  const parsed = accessProofSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The public fill-in endpoints (the requirements).
 *
 * **No guards from the chain**, and that is the feature: participants have no
 * account (data minimisation), so there is no session, no tenant
 * scope and no group permission to check. What takes their place is spelled
 * out in `PublicFormsService`: the slug is the capability, and the form it
 * resolves to supplies its own tenant.
 *
 * What guards these routes instead:
 *
 * - **A rate limit on every one of them** (`public-forms.rate-limit.ts`), and
 *   for the password gate one keyed by address *and* form
 *   (`access-attempt-tracker.ts`).
 * - **The JSON body limit** from `app-setup.ts` — 100 KiB, so an oversized
 *   payload is refused by the parser before any of this runs.
 * - **Schema validation derived from the published snapshot**, which is the
 *   only thing that decides what an answer may contain.
 * - **The password gate**, for a form that has one: the questions are not
 *   delivered and a submission is not accepted without a valid proof.
 */
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly forms: PublicFormsService) {}

  /**
   * Reading carries a limit far above legitimate use (see
   * `public-forms.rate-limit.ts`): a participant reloading or stepping back
   * must never meet it, but `CONTRIBUTING.md` asks every public endpoint to have
   * one, and each call costs a lookup plus a full parse of the definition.
   */
  @Get(':slug')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_READ_RATE_LIMIT })
  bySlug(
    @Param('slug') slug: string,
    @Headers(ACCESS_PROOF_HEADER) proof?: string,
  ): Promise<PublicFormReadPayload> {
    return this.forms.bySlug(slug, offeredProof(proof));
  }

  /**
   * The password gate.
   *
   * `@CsrfExempt()` for the third time in this application, and with the same
   * justification as the other two: the route authenticates nobody, so there is
   * no session to ride on. A forged request from another site can only offer a
   * word the attacker already knows, and the answer goes back to the browser
   * that sent it — under `SameSite` rules the attacker's page cannot read it.
   *
   * **A `POST`, and the word is in its body.** Not `GET /:slug/access/:word`,
   * not `?password=…` — bullet 6 of the rule, and the reason is that a URL
   * outlives the request in three places nobody clears.
   *
   * The answer is deliberately unhelpful about *why* a word was refused: the
   * service raises the same 404 an unknown address gets, byte for byte.
   */
  @Post(':slug/access')
  @HttpCode(HttpStatus.OK)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  // The route's own numbers **and its own key**. The registered default is the
  // login's stricter limit (`common/rate-limit.module.ts`); stating both here
  // keeps the second dimension of bullet 4 on the route it belongs to instead
  // of in a second global registration, which is what deleted the login's limit
  // once already.
  @Throttle({
    default: { ...PUBLIC_ACCESS_RATE_LIMIT, getTracker: accessAttemptTracker },
  })
  unlock(
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<AccessGrant> {
    const parsed = accessRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The envelope, not the word: „kein `password`-Feld" is a statement about
      // our own contract, and it is the same answer for an empty word and for a
      // word past `PASSWORD_MAX`. Neither says anything about the form.
      throw new BadRequestException('Die Anfrage ist ungültig.');
    }
    return this.forms.unlock(slug, parsed.data.password);
  }

  /**
   * `@CsrfExempt()` — and this is one of the cases the decorator exists for:
   * the route authenticates nobody, so there is no session to ride on. A forged
   * submission from another site is a submission the participant could equally
   * have made by visiting the form; there is no privilege to abuse.
   */
  @Post(':slug/responses')
  @HttpCode(HttpStatus.OK)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  // The route's own numbers. The registered default is the login's stricter
  // limit (`common/rate-limit.module.ts`), so relaxing it is stated here
  // rather than inherited by accident.
  @Throttle({ default: PUBLIC_SUBMIT_RATE_LIMIT })
  submit(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Headers(ACCESS_PROOF_HEADER) proof?: string,
  ): Promise<SubmitResponseResponse> {
    const parsed = submitResponseRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The envelope, not the answers: a body without an `answers` object is
      // not a submission with a wrong value in it, and saying so precisely
      // would describe our own contract to someone probing it.
      throw new BadRequestException('Die Anfrage ist ungültig.');
    }
    // The start token travels in the **body**, never in the path or the query
    // (and the same rule states for the access word): a query
    // parameter lands in access logs, in `Referer` and in the browser history.
    // The access proof travels in a header for the same reason — see
    // {@link ACCESS_PROOF_HEADER}.
    return this.forms.submit(
      slug,
      parsed.data.answers,
      parsed.data.startToken,
      offeredProof(proof),
      // The decoy of the requirement — handed on, not dropped. It travels
      // **beside** the answers because `buildAnswersSchema` derives its keys
      // from the form definition and the answers object is the one that gets
      // stored; what it decides is whether a mail goes out, never whether this
      // submission is accepted (`honeypot.ts`, `mail-suppression.ts`).
      parsed.data.honeypot,
      // The draft this submission comes out of, if the fill-in view was
      // resumed from one. It travels in the **body** for the
      // same reason the start token does: a path segment or a query parameter
      // lands in access logs, in `Referer` and in the browser history, and this
      // value opens somebody's half-filled registration.
      parsed.data.draftToken,
    );
  }

  /**
   * *Zwischenspeichern* — the first save, which is the one that mints the
   * address.
   *
   * **A `POST` under the form**, because this creates a new thing and the slug
   * is what says which form it belongs to. Continuing an existing draft is a
   * `PUT` under its own token next door (`PublicDraftsController`), exactly the
   * split the submission and the edit make.
   *
   * `@CsrfExempt()` with the same justification as its three neighbours: the
   * route authenticates nobody, so there is no session to ride on. A forged
   * request from another site can only store a half-filled form that the
   * participant could equally have stored by pressing the button — and the
   * address comes back to the browser that sent it, which under `SameSite` rules
   * the attacker's page cannot read.
   *
   * The submission's write **number** rather than a fourth one: this *is* a
   * write of a document by a stranger, at the same rate and with the same cost,
   * and a number of its own would be one more to justify. ⚠️ **The counter is
   * not shared** — `ThrottlerGuard` keys per handler, so this route has thirty
   * per minute of its own; *gemessen am 2026-08-05:* dieselbe Adresse erschöpft
   * hier (429) und bekommt danach auf `POST …/responses` weiter 200. The
   * sentence here used to claim „die Schreibgrenze der Absendung", i.e. one
   * counter, and that was never built (the drafts review). What bounds the
   * total number of drafts is `draft-quota.ts`, not this counter.
   *
   * The 100 KiB JSON body limit from `app-setup.ts` bounds the payload before
   * any of this runs — and it is what makes a second, byte-based limit on the
   * stored answers unnecessary: nothing can reach this method carrying more.
   */
  @Post(':slug/drafts')
  @HttpCode(HttpStatus.OK)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_SUBMIT_RATE_LIMIT })
  saveDraft(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Headers(ACCESS_PROOF_HEADER) proof?: string,
  ): Promise<SavedDraft> {
    const parsed = saveDraftRequestSchema.safeParse(body);
    if (!parsed.success) {
      // The envelope, not the answers — the same sentence the submission gives,
      // for the same reason: describing our own contract precisely to somebody
      // probing it says more than it needs to.
      throw new BadRequestException('Die Anfrage ist ungültig.');
    }
    return this.forms.saveDraft(slug, parsed.data.answers, offeredProof(proof));
  }
}
