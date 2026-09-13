import { Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { PublicUrlModule } from '../common/public-url/public-url.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { MailBodyRenderer } from './mail-body-renderer';
import { MailClockModule } from './mail-clock.module';
import { MailIdentityService } from './mail-identity.service';
import { MailLogPurgeService } from './mail-log-purge.service';
import { MailQueueRepository } from './mail-queue.repository';
import { MailSecretsService } from './mail-secrets.service';
import { MAIL_TIMEOUTS, DEFAULT_MAIL_TIMEOUTS } from './mail-timeouts';
import { MailTransport, NodemailerTransport } from './mail-transport';
import { MailWorkerService } from './mail-worker.service';
import { QueuedBodyRenderer } from './queued-body-renderer';
import { JobRunModule } from '../observability/job-run.module';

/**
 * Mail delivery (ADR-0004).
 *
 * **What is here:** the transport, the queue worker with retry, backoff
 * and attempt ceiling (the requirements), the 90-day purge and the body renderer (the requirements).
 *
 * Three of the four bindings below are abstract classes used as their own
 * injection token — `MailTransport`, `MailClock` and `MailBodyRenderer`. That
 * is what lets a suite replace the outside world, the calendar or the renderer
 * with `overrideProvider(...)` and leave the rest of the graph untouched
 * . `MailBodyRenderer` is bound to `QueuedBodyRenderer`,
 * which since the freeze decision of 2026-07-28 **reads** the stored body and
 * only fills the `{{bearbeiten}}` slot — hence `PublicUrlModule`
 * among the imports: the link is built from `PUBLIC_BASE_URL`, never from the
 * `Host` of a request, because there is no request here at all.
 *
 * `MailTransport` is provided under the abstract class as its token, so a suite
 * replaces the whole outside world with `overrideProvider(MailTransport)` and
 * the graph is otherwise untouched.
 *
 * ---------------------------------------------------------------------------
 * **`apps/api/src/mail/**` is the fifth entry in the `PrismaService`
 * allow-list of `eslint.config.js`, and whoever changes a file here should know
 * why before adding the next one.**
 *
 * The worker and the purge work **across tenants by design**: the queue is an
 * installation resource, not an organisation's datum. There is no request behind them,
 * no caller, no tenant parameter — the row selection is `status` and
 * `next_attempt_at`, never an input from outside — and claiming a row needs
 * `$queryRaw` for `SELECT … FOR UPDATE SKIP LOCKED`, which a `TenantScope` has
 * no way to express and no business expressing.
 *
 * **The counter-check is what makes that entry bearable, and it is a rule and
 * not a preference:** the *reading* side of the mail log goes
 * strictly through `ScopedMailLogDelegate` (`src/tenancy/tenant-scope.ts`), in
 * `src/mail-log/`, which is **not** on the allow-list. Two callers, two ways
 * in. A `MailLogService` that reached for the worker's repository because it
 * was within arm's length would be the regression every test survives — and it
 * would land on the one table whose only tenant boundary is that delegate,
 * because `mail_log` has no composite foreign key underneath it.
 * ---------------------------------------------------------------------------
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // the requirement: the worker and the mail-log purge keep a record — one
    // line per run, on success **and** on failure (ADR-0016).
    JobRunModule,
    PublicUrlModule,
    // The key of the third database secret: the SMTP password
    // of the system block and of every organisation is sealed, and `MailSecretsService`
    // is the one place that opens it.
    SecretBoxModule,
    // Where the **system mail block** comes from — `SMTP_*` left the
    // environment. (It once also carried a settings layer the renderer had to
    // resolve; that layer is gone — ADR-0011, continuation 2026-08-14.)
    SystemSettingsModule,
    // The one binding of `MailClock` in this application (a review finding).
    // It sits in a module of its own so that a consumer needing
    // only the calendar — `PublicFormsModule`, for the sending budget —
    // can have it **without** the four secret-bearing exports below; binding it
    // a second time here would be a second clock, which is the fault
    // `mail-clock.ts` names.
    MailClockModule,
  ],
  providers: [
    { provide: MailTransport, useClass: NodemailerTransport },
    { provide: MailBodyRenderer, useClass: QueuedBodyRenderer },
    // One scale for the SMTP conversation, the send deadline and the claim
    // transaction — `mail-timeouts.ts` says why they only mean anything
    // together, and a token is what lets a suite compress all of them at their
    // real relative order.
    { provide: MAIL_TIMEOUTS, useValue: DEFAULT_MAIL_TIMEOUTS },
    MailSecretsService,
    // „Welche Identität gilt für diese Zeile?" A provider of its
    // own next to the worker rather than a method inside it — ADR-0013's own
    // „Consequences" asks for exactly that split, and it is what lets the three
    // arms of no. 5 be tested without a queue.
    MailIdentityService,
    MailQueueRepository,
    MailWorkerService,
    MailLogPurgeService,
  ],
  /*
   * **`MailClockModule` and `MailBodyRenderer` are exported; the worker and the
   * repository are not.**
   *
   * The clock is re-exported as its **module** rather than as a token of this
   * one, which is what the split of a review finding costs and all it costs:
   * `MailClock` is no longer provided here, so `exports: [MailClock]` would be
   * an `UnknownExportException` at boot. Importers of `MailModule` reach it
   * exactly as before — `MailLogService` still asks for `MailClock` and still
   * gets the one instance. What changed is that a consumer needing *only* the
   * calendar can import `MailClockModule` and thereby not reach the four
   * exports below (`mail-clock.module.ts`).
   *
   * The clock, because `MailLogService` schedules „↻ Erneut" against it: the
   * worker claims a row by comparing `next_attempt_at` with a `Date` **it**
   * computes, so a retry stamped from a second clock is a line that is claimed
   * a moment too early or — with the two drifted the other way — not at all.
   * One calendar for the whole queue, and a suite that moves it moves all of it.
   *
   * `MailBodyRenderer` is exported „Die gerenderte Mail ansehen":
   * the mail log's detail route resolves `{{bearbeiten}}` the same way
   * the worker does, and the alternative — `MailLogService` reading
   * `response`/`allowEdit` a second time — is exactly the drift `CONTRIBUTING.md`
   * warns about. It is bound to `QueuedBodyRenderer` here, as always; the
   * consuming module asks for the abstract token, same as the worker.
   *
   * The **worker** used to be exported for a „↻ Erneut" that would ask for a run
   * instead of waiting for the next tick. That is not what was built (the route
   * requeues the row and the scheduler picks it up, `MailLogService.retry`), so
   * the export said something about this application that was not true.
   *
   * The **repository** stays unexported for the reason the block above gives:
   * the reading side of the mail log goes through
   * `ScopedMailLogDelegate`, and that split is the only thing making the
   * tenant-boundary test mean anything. Exporting `MailBodyRenderer` does
   * not weaken that: it renders a row it is handed, it does not fetch one.
   */
  /*
   * `MailSecretsService` is exported for the service that resolves an organisation's
   * identity, and for the surface that stores one. Sealing and opening
   * happen in **one** file for both levels; a second one would be a second
   * answer to „unter welchem Kontext?", and the two would drift apart silently.
   */
  /*
   * `MailIdentityService` is exported for the same reason `MailSecretsService`
   * is: the *Mailversand*-Reiter of an organisation (`tenant-admin/smtp-config.*`) and
   * the queue must agree on what a stored block means, down to which documents
   * are refused. A tab that showed a configuration the worker will not send
   * with would be worse than one that showed nothing.
   */
  /*
   * `MAIL_TIMEOUTS` is exported for the testmail route (`test-mail.service.ts`), for
   * the same reason `mail-timeouts.ts` gives for keeping the three timeouts in
   * one place: a testmail attempt runs a real `transport.send()` inside a
   * database transaction, exactly like the worker's `deliverOne`, and the
   * transaction's budget has to stay in the same relative order as the send
   * deadline or a slow server tears the transaction down *under* a send that
   * is still running (`mail-timeouts.ts`'s own account of that bug). A second,
   * unrelated timeout invented for the testmail route would be the thing that
   * drifts.
   */
  exports: [
    MailTransport,
    MailClockModule,
    MailBodyRenderer,
    MailLogPurgeService,
    MailSecretsService,
    MailIdentityService,
    MAIL_TIMEOUTS,
  ],
})
export class MailModule {}
