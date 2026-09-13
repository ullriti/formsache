import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Readable } from 'node:stream';

import { CsrfExempt } from '../auth/csrf.guard';
import { clientAddress } from '../common/client-address';
import { addressFormKey } from './address-form-tracker';
import { ACCESS_PROOF_HEADER } from './public-forms.controller';
import { PUBLIC_UPLOAD_RATE_LIMIT } from './public-forms.rate-limit';
import {
  FILE_NAME_HEADER,
  PublicUploadsService,
  type UploadedFile,
} from './public-uploads.service';

/**
 * The public upload (ADR-0014 no. 14).
 *
 * **One file per request, as a raw body.** No `multer`, no `busboy`, no
 * `FileInterceptor`, and the third of the ADR's three reasons is the one that
 * decides it: a route that *demands* `application/octet-stream` and answers 415
 * to everything else is grammatically unreachable for a foreign HTML form,
 * which can only send urlencoded, multipart or plain text. That is the same
 * property `bodyParser: false` was bought for against login-CSRF — and a
 * multipart route would not have it. The other two: no parser dependency in the
 * one path every stranger on the internet reaches, and the byte counter plus
 * the abort stay **ours** rather than being a library option somebody has to
 * set correctly.
 *
 * `@CsrfExempt()` for the same reason as the other public routes: it
 * authenticates nobody, so there is no session to ride on. A forged upload from
 * another site is an upload the participant could have made by visiting the
 * form, and it takes a valid access proof for a protected form like any other
 * request here.
 */
/**
 * The transport shape this route touches — deliberately minimal, exactly like
 * `auth/request-context.ts`.
 *
 * Nest hands over the Express request, but nothing here needs Express: three
 * headers and **the body as a stream**. A structural interface keeps
 * `@types/express` out of the dependency list and makes the seam obvious — the
 * body is a `Readable` and nothing else, which is the whole of ADR-0014 no. 14.
 */
interface UploadRequest extends Readable {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

@Controller('public/forms')
export class PublicFilesController {
  constructor(private readonly uploads: PublicUploadsService) {}

  /**
   * The rate limit is keyed **address ⊕ form** (ADR-0014 no. 8), never
   * form-wide: a counter that closes a form for everybody is a lever with which
   * a stranger switches off an organisation's registration from a single laptop — the
   * rule, unchanged.
   *
   * Ten a minute, because a form may carry several file questions and somebody
   * who grabbed the wrong file uploads again. It is deliberately not the
   * binding limit; that is the per-address quota of no. 7 inside the service.
   * Ten is the number that stops an unattended script before it gets there.
   *
   * The `@Throttle` states its own numbers *and* its own key on the route,
   * rather than in a second `ThrottlerModule.forRoot` — the shape that silently
   * deleted the login's limit once already.
   */
  @Post(':slug/files')
  @HttpCode(HttpStatus.CREATED)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { ...PUBLIC_UPLOAD_RATE_LIMIT, getTracker: addressFormKey },
  })
  upload(
    @Param('slug') slug: string,
    @Req() request: UploadRequest,
    @Headers(ACCESS_PROOF_HEADER) proof?: string,
  ): Promise<UploadedFile> {
    // One cast, named: `clientAddress` and `addressFormKey` read `ip`, `ips`
    // and `params` off the request the way `@Throttle` hands it to them — a
    // bag of unknowns rather than an Express type, which is what keeps
    // `@types/express` out of this application's dependencies (the same cut
    // `auth/request-context.ts` makes).
    const counted = request as unknown as Record<string, unknown>;
    return this.uploads.upload({
      target: { kind: 'form', slug, proof },
      requestType: headerValue(request.headers['content-type']),
      encodedFileName: headerValue(request.headers[FILE_NAME_HEADER]),
      declaredLength: headerValue(request.headers['content-length']),
      // The same two keys the rate limit counts by — built from the same
      // functions, so „address ⊕ form" cannot come to mean two things
      // (`address-form-tracker.ts`, including its ceiling on distinct forms).
      key: {
        address: clientAddress(counted),
        bucket: addressFormKey(counted),
      },
      // The request itself is the body — `express.json` is registered for
      // `application/json` and does not touch this one (ADR-0014 assumption A6,
      // measured in `test/public/upload.spec.ts`).
      body: request,
    });
  }
}

/**
 * The same upload, through the **edit token** .
 *
 * A controller of its own because its path is a different root
 * (`public/responses/:token/files`, next to the edit route it belongs to) —
 * Nest joins a route onto its controller's prefix, and a second prefix is a
 * second controller. It shares the service, which is where the one order of
 * checks lives.
 */
@Controller('public/responses')
export class PublicEditFilesController {
  constructor(private readonly uploads: PublicUploadsService) {}

  /**
   * The upload behind an edit token.
   *
   * A route of its own rather than a flag on the one above, because the door is
   * what decides the refusal chain (`UploadTarget` in the service): this one inherits the
   * chain of a *correction* — `editing_disabled`, the deadline, the one 404 —
   * and not the password gate, so a participant correcting a registration to a
   * protected form can replace the scan they got wrong.
   *
   * **The rate limit is keyed by address alone here**, and that is a decision
   * rather than an omission. The other route keys „Adresse ⊕ Formular" because
   * the form stands in its path; here what stands there is a **capability**, and
   * keying by it would put one participant's token into a counter key. Address
   * alone is **stricter than the same tracker would be with a form in it** —
   * one budget across every correction from that address, whichever form it is
   * — and is still per address, so it is not the lever the rule
   * forbids: nobody can spend anybody else's allowance.
   *
   * ⚠️ **„Stricter" is a statement about this counter, not about the route's
   * total, and the sentence here used to blur the two** (a security review).
   * `ThrottlerGuard` keys per handler, so this route's ten and
   * the slug route's ten are separate budgets: an address that has spent this
   * one may still upload through the other. Three doors, thirty a minute in
   * aggregate — written out, with the reason it stays that way, at
   * {@link PUBLIC_UPLOAD_RATE_LIMIT}.
   *
   * What this comment claimed until a security review — that keying by
   * the token would let an invented one mint a bucket per request — is **not
   * true** and is written down here so it is not repeated. `formOf` reads
   * `req.params.slug` (`address-form-tracker.ts`), which this route does not
   * have, so every request would fall into `NO_FORM`: one bucket per address
   * either way. The real reason to spell the bare address out is that it cannot
   * then collide with `<address>\0no-such-form`.
   */
  @Post(':token/files')
  @HttpCode(HttpStatus.CREATED)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { ...PUBLIC_UPLOAD_RATE_LIMIT, getTracker: uploadAddressKey },
  })
  uploadForEdit(
    @Param('token') token: string,
    @Req() request: UploadRequest,
  ): Promise<UploadedFile> {
    const counted = request as unknown as Record<string, unknown>;
    return this.uploads.upload({
      target: { kind: 'edit', token },
      requestType: headerValue(request.headers['content-type']),
      encodedFileName: headerValue(request.headers[FILE_NAME_HEADER]),
      declaredLength: headerValue(request.headers['content-length']),
      // Both keys are the address here — the quota of no. 7 counts
      // „unbeansprucht je Adresse ⊕ Formular", and this route has no form in
      // its path to key by. One bucket per address is the stricter reading of
      // that pair, never the looser one.
      key: {
        address: clientAddress(counted),
        bucket: uploadAddressKey(counted),
      },
      body: request,
    });
  }
}

/**
 * The same upload once more, through the **draft token** (the requirement —
 * a finding of the acceptance run).
 *
 * A third controller for the reason there is a second: `public/drafts` is a
 * root of its own, next to the two routes that read and write the draft, and
 * Nest joins a route onto its controller's prefix. It shares the service, where
 * the one order of checks lives.
 *
 * **Why a resumed draft gets a door at all** is argued at
 * `PublicFormsService.openForUploadByDraftToken`; the short of it is that
 * without one a participant on their second device can remove their scan and
 * never replace it, and that a draft whose attachment has outlived the purge
 * window cannot be submitted by any route.
 */
@Controller('public/drafts')
export class PublicDraftFilesController {
  constructor(private readonly uploads: PublicUploadsService) {}

  /**
   * **The rate limit is keyed by address alone**, exactly as on the edit route
   * and for the identical reason: what stands in this path is a *capability*,
   * not a form, and keying by it would put one participant's token into a
   * counter key. One budget across every draft that address is continuing, and
   * still per address, so it is not the lever the rule forbids.
   *
   * ⚠️ **„One budget" ends at this handler**, and the sentence here said
   * otherwise until a follow-up security review: it read „one
   * budget across every draft that address is continuing" as though that were
   * the address's whole upload allowance. It is not — `ThrottlerGuard` keys per
   * route, so the same address gets a fresh ten at each of the three doors.
   * *Measured on 2026-08-05:* draft door 10×201, then 429, and at the slug
   * door immediately 201 again. Thirty a minute in aggregate, and why that
   * stands rather than being merged into one counter, at
   * {@link PUBLIC_UPLOAD_RATE_LIMIT}.
   */
  @Post(':token/files')
  @HttpCode(HttpStatus.CREATED)
  @CsrfExempt()
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: { ...PUBLIC_UPLOAD_RATE_LIMIT, getTracker: uploadAddressKey },
  })
  uploadForDraft(
    @Param('token') token: string,
    @Req() request: UploadRequest,
  ): Promise<UploadedFile> {
    const counted = request as unknown as Record<string, unknown>;
    return this.uploads.upload({
      target: { kind: 'draft', token },
      requestType: headerValue(request.headers['content-type']),
      encodedFileName: headerValue(request.headers[FILE_NAME_HEADER]),
      declaredLength: headerValue(request.headers['content-length']),
      // Both keys are the address, the same cut the edit route makes: the quota
      // of no. 7 counts „unbeansprucht je Adresse ⊕ Formular", and this route
      // has no form in its path to key by. One bucket per address is the
      // stricter reading of that pair, never the looser one.
      key: {
        address: clientAddress(counted),
        bucket: uploadAddressKey(counted),
      },
      body: request,
    });
  }
}

/** The address alone, as a counter key — see {@link PublicFilesController.uploadForEdit}. */
function uploadAddressKey(request: Record<string, unknown>): string {
  return clientAddress(request);
}

/**
 * A header as a single value.
 *
 * Node hands repeated headers over as an array, and a caller may repeat any
 * header they like. Refusing that outright would be a 400 about our own
 * plumbing; taking the first entry is not right either, because „welcher
 * Dateiname gilt" would then depend on the order. So a repeated header becomes
 * *no* header, and the caller meets the ordinary „der Dateiname fehlt".
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
