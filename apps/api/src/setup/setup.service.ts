import { Injectable, NotFoundException } from '@nestjs/common';
import type { SetupRequest, SetupState } from '@formsache/shared';

import { hashPassword } from '../auth/password';
import { PrismaService } from '../prisma/prisma.service';
import { createFirstSuperadmin } from './first-superadmin';

/**
 * The first-time setup (ADR-0022) — two questions, and both without a session.
 *
 * ---------------------------------------------------------------------------
 * **This directory uses `PrismaService` directly.** `apps/api/src/setup/**`
 * is on the allow-list in `eslint.config.js`; the entry is spelled out there,
 * and the argument is repeated here, where somebody who changes this code
 * actually looks:
 *
 * 1. **There is no organisation here.** A `TenantScope` arises from a
 *    membership, a membership from a session, a session from an account — and
 *    that there is **no** account is the precondition of these routes. A
 *    scope would have nothing to refer to.
 * 2. **Nothing out of a request selects a row.** The read query has no
 *    parameter („is there any user row at all"), the writing one only
 *    creates. There is no identifier a caller could name.
 * 3. **Nothing leaves the queries.** The answer of the one is a boolean, that
 *    of the other is empty (204). What is read are identifiers only — no
 *    address, no name, no number.
 *
 * **It is the counter-check that makes the entry defensible**, and it is
 * narrow: this directory has exactly two routes, and both stop existing as
 * soon as the installation has a user. There is no method here that reads an
 * organisation, a form or a response, and there must not be one. Whoever
 * creates something here that answers a *set-up* installation is no longer
 * building a first-time setup.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class SetupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the installation still has to be set up.
   *
   * One query, one index access, one identifier — and the identifier is
   * discarded. What goes back is a boolean.
   */
  async state(): Promise<SetupState> {
    const anyUser = await this.prisma.user.findFirst({ select: { id: true } });
    return { setupRequired: anyUser === null };
  }

  /**
   * Sets up — or behaves as if this route did not exist.
   *
   * **Hashing happens before the transaction.** Argon2id costs 19 MiB and two
   * passes here; doing that inside an open transaction would mean holding a
   * connection *and* the advisory lock for the duration of a CPU computation.
   * The price of this order is spelled out and bounded: an already set-up
   * installation pays one hash for a stranger's call before it says 404 — just
   * as much as for an invented sign-in attempt, and capped by the same number
   * (`setup.rate-limit.ts`).
   *
   * **The 404 is the only disclosure.** Not 409 („already set up"), not 403
   * („not permitted"): both would be a statement about the state of the
   * installation to somebody who has none. 404 is what a route answers that
   * does not exist — and that is exactly what this one is meant to be.
   */
  async run(request: SetupRequest): Promise<void> {
    const passwordHash = await hashPassword(request.admin.password);

    const outcome = await createFirstSuperadmin(this.prisma, {
      email: request.admin.email,
      name: request.admin.name,
      passwordHash,
      tenant: request.tenant,
    });

    if (outcome.kind === 'already-set-up') {
      throw new NotFoundException();
    }
  }
}
