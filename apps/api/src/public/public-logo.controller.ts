import {
  Controller,
  Get,
  Header,
  Param,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { PUBLIC_READ_RATE_LIMIT } from './public-forms.rate-limit';
import { PublicLogoService } from './public-logo.service';

/**
 * **The Logo — deliberately public, deliberately embedded** (* ADR-0014 no. 11a).
 *
 * The one route in this application that hands bytes to somebody with no
 * session at all, and the reason is deliberate: a participant opening an organisation's
 * fill-in page sees that organisation's Logo, and there is nobody to sign in as. It
 * is the *other half* of the pair — the attachment of an answer
 * (`files/attachment.controller.ts`) is behind the whole guard chain — and the
 * difference between the two is what matters.
 *
 * What protects this one, since the address is all there is:
 *
 * - **the reference** — 16 bytes of CSPRNG, base64url, the alphabet and length
 *   of `public_slug` (no. 9). It is not the authorisation of anything, it is
 *   what keeps a Logo from being enumerable;
 * - **the list** — only `image/png` and `image/jpeg` reach a browser from here.
 *   No SVG, because this file is *embedded* and a script inside one would run
 *   in the origin of this application; no PDF, although the attachment list has
 *   it and both kinds live in one table. A row that carries an unexpected type
 *   answers **404**, byte-identical to an invented reference (no. 11a);
 * - **`X-Content-Type-Options: nosniff`**, and here it is load-bearing rather
 *   than decoration: the bytes come from the **same origin** as the
 *   application, so a browser that decided to read them as HTML would be XSS in
 *   our own origin. `nosniff` is the mechanism that forbids the deciding.
 *
 * `Content-Disposition: inline`, not `attachment`: the design says the Logo
 * is delivered embedded. `attachment` on an `<img>` subresource would „work"
 * only because browsers ignore the header there — a promise resting on
 * behaviour we do not control (ADR-0014 assumption A2), which is why the list and
 * `nosniff` carry this route and the disposition does not.
 *
 * `Cache-Control: no-store` stays, without exception: the global `noStore`
 * covers every answer, and „eine pauschale Regel, die gelegentlich zu streng
 * ist, schlägt eine Liste, die gelegentlich zu locker ist" (`no-store.ts`).
 * The cost is one fetch per page view for a few hundred kilobytes, and it is
 * carried rather than carved out here.
 */
@Controller('public/files')
export class PublicLogoController {
  constructor(private readonly logos: PublicLogoService) {}

  /**
   * Rate-limited **per address**, like the public read next door — `CONTRIBUTING.md`
   * asks it of every public endpoint, and 120 a minute is far above what a
   * page with one Logo on it can produce while still bounding a script.
   *
   * Deliberately **not** keyed per organisation or per reference: every ceiling foreign
   * traffic can reach is a lever, and a counter „je Logo" would be one a
   * stranger pulls to blank an organisation's fill-in page from a single laptop. The
   * rule, unchanged.
   */
  @Get(':ref')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: PUBLIC_READ_RATE_LIMIT })
  @Header('X-Content-Type-Options', 'nosniff')
  logo(@Param('ref') ref: string): Promise<StreamableFile> {
    return this.logos.byRef(ref);
  }
}
