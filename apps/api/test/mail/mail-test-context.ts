import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, type NotificationTrigger } from '@prisma/client';
import type { ApiEnv, SmtpBlock } from '@formsache/shared';

import { API_ENV } from '../../src/config/env';
import {
  MailBodyRenderer,
  type RenderedMailBody,
} from '../../src/mail/mail-body-renderer';
import { MailClock } from '../../src/mail/mail-clock';
import { MailIdentityService } from '../../src/mail/mail-identity.service';
import { MailLogPurgeService } from '../../src/mail/mail-log-purge.service';
import { MailModule } from '../../src/mail/mail.module';
import { MailQueueRepository } from '../../src/mail/mail-queue.repository';
import {
  DEFAULT_MAIL_TIMEOUTS,
  MAIL_TIMEOUTS,
  type MailTimeouts,
} from '../../src/mail/mail-timeouts';
import { MailTransport } from '../../src/mail/mail-transport';
import { MailWorkerService } from '../../src/mail/mail-worker.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { SmtpDouble } from '../support/smtp-double';
import {
  TEST_SYSTEM_SMTP_BLOCK,
  writeSystemMail,
  type SystemMailFixture,
} from '../support/create-test-app';

/**
 * A booted `MailModule` against a throwaway database, with three seams
 * replaced: transport, clock and body renderer.
 *
 * **Why not `createTestApp`.** That helper boots the whole application, which
 * is the right instrument for anything about the *application* — the startup
 * message and the „no scheduler in tests" guard use it for exactly that reason.
 * It does not, however, take provider overrides, and the queue's requirements are
 * unprovable without them: this suite needs a transport that fails on command and a
 * clock that can be moved months forward, and the body renderer does not
 * exist yet.
 *
 * The graph below is the real one — `MailModule` with its real repository, real
 * worker, real purge and the real `PrismaService` — so nothing about the queue
 * is simulated. Only the outside world is.
 */

/** A clock the test moves by hand; no test in this folder ever sleeps. */
export class MutableClock extends MailClock {
  private current: Date;

  constructor(start: Date) {
    super();
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * A renderer that hands back a fixed body.
 *
 * The suites in this folder are about the *queue* — claim, backoff, ceiling,
 * purge — and enqueue their rows directly with {@link enqueueMail}, so those
 * rows carry no frozen body and the real `QueuedBodyRenderer` would refuse
 * every one of them. What the real one does is proven where a real submission
 * writes the row: `test/public/frozen-mail-body.spec.ts`.
 */
export class StubBodyRenderer extends MailBodyRenderer {
  constructor(private readonly body: RenderedMailBody = { text: 'Testtext' }) {
    super();
  }

  render(): Promise<RenderedMailBody> {
    return Promise.resolve(this.body);
  }
}

export interface MailContextOptions {
  readonly databaseUrl: string;
  /** Where the injected clock starts. Defaults to a fixed, obvious instant. */
  readonly now?: Date;
  /** Overrides on top of the mail-relevant defaults (SMTP variables, intervals). */
  readonly env?: Partial<ApiEnv>;
  /**
   * Left out to get a `SmtpDouble` that always succeeds; passed to script
   * failures — or omitted **and** `useRealTransport` set for the SMTP tests
   * that need `NodemailerTransport` itself.
   */
  readonly transport?: MailTransport;
  /** Keeps the real `NodemailerTransport` — only those tests want this. */
  readonly useRealTransport?: boolean;
  readonly renderer?: MailBodyRenderer;
  /**
   * Compresses the timeout scale of the queue, keeping its relative order.
   *
   * The shipped numbers are minutes; a test's patience is seconds. Only the
   * *order* carries meaning (`mail-timeouts.ts`), so a suite may scale all of
   * them down — and has to be able to, or „der Mailserver antwortet nach `DATA`
   * nie mehr" is not a case any test can reach.
   */
  readonly timeouts?: Partial<MailTimeouts>;
  /**
   * A logger for this module, replacing Nest's `TestingLogger`.
   *
   * Needed by exactly one case, and the reason is a property of `@nestjs/
   * testing` rather than of this application: `TestingModuleBuilder.compile()`
   * installs a `TestingLogger` whose `log`, `warn`, `debug` and `verbose` are
   * empty methods — only `error` reaches the console. The startup notice of
   * the requirement is a **warning**, correctly so (an installation without a mail
   * server is a supported state, not a fault), and it is therefore invisible in
   * any suite booted through `Test.createTestingModule`, `createTestApp`
   * included. Handing in a real `ConsoleLogger` restores what the shipped
   * application does through `NestFactory.create`.
   */
  readonly logger?: LoggerService;
  /**
   * The installation's mail configuration, written into `system_setting`
   * **before the worker's `onModuleInit` runs** .
   *
   * This was formerly `env: { SMTP_HOST: … }`. The order matters for one
   * assertion in particular: the startup notice of the requirement is written
   * exactly when there is no mail server at boot, so a fixture applied after
   * `init()` would produce it in a suite that configured one.
   */
  readonly systemMail?: SystemMailFixture;
}

export interface MailContext {
  readonly prisma: PrismaService;
  readonly worker: MailWorkerService;
  readonly purge: MailLogPurgeService;
  readonly repository: MailQueueRepository;
  readonly clock: MutableClock;
  /** The double, when one was used. `undefined` with `useRealTransport`. */
  readonly double: SmtpDouble | undefined;
  /**
   * The application's own sealing service, so a suite can give an organisation its own
   * SMTP block the way the *Mailversand*-Reiter does.
   *
   * Handed out rather than reimplemented: what must never drift is *which
   * context the password is sealed under*, and a fixture that sealed by hand
   * would be the second answer to that question.
   */
  readonly secrets: MailSecretsService;
  /**
   * The very instance the worker resolves identities through.
   *
   * Handed out so a suite can count *when* and *how often* it is asked — „vor
   * der Transaktion" and „einmal je Lauf" are promises about the call, not about
   * a row, and there is nothing in the database to read them off.
   */
  readonly identities: MailIdentityService;
  readonly close: () => Promise<void>;
}

/**
 * A fixed instant far from any boundary the suites care about, so a failure
 * points at the code rather than at „today happens to be the first of March".
 */
export const MAIL_TEST_EPOCH = new Date('2026-06-15T09:00:00.000Z');

export async function createMailContext(
  options: MailContextOptions,
): Promise<MailContext> {
  const clock = new MutableClock(options.now ?? MAIL_TEST_EPOCH);
  const double =
    options.useRealTransport === true
      ? undefined
      : ((options.transport as SmtpDouble | undefined) ?? new SmtpDouble());

  const env: ApiEnv = {
    NODE_ENV: 'test',
    API_PORT: 3000,
    APP_VERSION: '0.0.0-test',
    DATABASE_URL: options.databaseUrl,
    SESSION_TTL_HOURS: 12,
    TRUST_PROXY_HOPS: 0,
    SECRET_BOX_KEY: randomBytes(32).toString('base64'),
    // Required (ADR-0014 no. 2), and never read here: this
    // harness boots `MailModule` alone, so no storage adapter is constructed
    // and nothing checks the path. It is set because `ApiEnv` is an exact
    // shape — which is what turned this file red the moment the variable
    // became required, and that is the mechanism working, not an accident.
    FILE_STORAGE_DIR: '/nonexistent-on-purpose',
    // Both schedulers off, exactly as `create-test-app.ts` has them: a worker
    // that starts on its own drains the queue this file is counting.
    MAIL_WORKER_INTERVAL_MS: 0,
    MAIL_PURGE_INTERVAL_MS: 0,
    // Required and never read here — this harness boots
    // `MailModule` alone, which holds no `FilePurgeService`. Set for the same
    // reason `FILE_STORAGE_DIR` above is: `ApiEnv` is an exact shape.
    FILE_PURGE_INTERVAL_MS: 0,
    // Required and never read here either — the 30-day purge of
    // the trash lives in `RetentionPurgeModule`, which this harness does
    // not boot. Same reason as the two above: `ApiEnv` is an exact shape.
    TRASH_PURGE_INTERVAL_MS: 0,
    // The AI variables (ADR-0015). Never read by this harness — it boots
    // `MailModule` alone — and set for the same reason `FILE_STORAGE_DIR` is:
    // `ApiEnv` is an exact shape, so this file turned red the moment they
    // arrived. That is the mechanism working.
    //
    // ⚠️ **And it is a shore the env guard does not know about.**
    // `env-contract.test.ts` names four (`env.ts`, `.env.example`, the compose
    // block, `create-test-app.ts`); this literal is a fifth, and it is held to
    // the contract only by the type annotation above it. Widening that
    // annotation would leave it silently behind — the finding is recorded in
    // the review report, not fixed here.
    AI_REQUEST_TIMEOUT_MS: 60_000,
    AI_USAGE_PURGE_INTERVAL_MS: 0,
    // Like the four intervals above: no scheduler in a suite that triggers
    // runs itself.
    OPS_ALERT_INTERVAL_MS: 0,
    // The seventh timer, off for the same reason (a review finding).
    SESSION_PURGE_INTERVAL_MS: 0,
    ...options.env,
  };

  let builder = Test.createTestingModule({ imports: [MailModule] })
    .overrideProvider(API_ENV)
    .useValue(env)
    .overrideProvider(MailClock)
    .useValue(clock)
    .overrideProvider(MailBodyRenderer)
    .useValue(options.renderer ?? new StubBodyRenderer())
    .overrideProvider(MAIL_TIMEOUTS)
    .useValue({ ...DEFAULT_MAIL_TIMEOUTS, ...options.timeouts });

  if (double !== undefined) {
    builder = builder.overrideProvider(MailTransport).useValue(double);
  }
  if (options.logger !== undefined) {
    builder = builder.setLogger(options.logger);
  }

  const moduleRef = await builder.compile();
  // A double replaces the outside world, not the configuration: which identity
  // a row goes out under is resolved from the database either way, so a harness
  // with a double and no block would withhold every mail instead of sending it
  // (`TEST_SYSTEM_SMTP_BLOCK`). `useRealTransport` gets nothing by default —
  // that is how `mail-unconfigured.spec.ts` reaches the state of the requirement.
  //
  // **`systemMail: { smtp: null }` opts out** and keeps the double: „ohne
  // Konfiguration geht nichts hinaus" is a suite this harness has to be able to
  // host, and seeding a block under it would make it green for the one reason
  // that would not be a proof (see `SystemMailFixture.smtp`).
  const systemMail: SystemMailFixture | undefined =
    double !== undefined && options.systemMail?.smtp === undefined
      ? { ...options.systemMail, smtp: TEST_SYSTEM_SMTP_BLOCK }
      : options.systemMail;
  if (systemMail !== undefined) {
    // **Between `compile()` and `init()`**: the row has to be there before the
    // worker asks whether this installation has a mail server — see
    // `MailContextOptions.systemMail`.
    await writeSystemMail(
      moduleRef.get(PrismaService),
      moduleRef.get(MailSecretsService),
      systemMail,
    );
  }
  // `init()` and not just `compile()`: the scheduler is armed in
  // `onModuleInit`, and the „interval 0 arms nothing" guard has to observe the
  // same lifecycle the application runs.
  await moduleRef.init();

  return {
    prisma: moduleRef.get(PrismaService),
    worker: moduleRef.get(MailWorkerService),
    purge: moduleRef.get(MailLogPurgeService),
    repository: moduleRef.get(MailQueueRepository),
    clock,
    double,
    secrets: moduleRef.get(MailSecretsService),
    identities: moduleRef.get(MailIdentityService),
    // `close()` runs `onModuleDestroy`, which closes and **empties** the
    // transport's per-Organisation cache. That is what keeps test *n+1* from sending
    // over test *n*'s remote — a failure that looks like flakiness rather than
    // like a missing step.
    close: () => moduleRef.close(),
  };
}

/**
 * Empties the two tables these suites count.
 *
 * One throwaway database is shared per spec file — creating and migrating one
 * per case would multiply a fast suite by its number of cases — and almost
 * every assertion here is a **count**: „one log line, not two", „one row
 * deleted", „each recipient exactly once". A leftover row from the previous
 * case makes those pass or fail for reasons the case never mentions, which is
 * the worst kind of green.
 */
export async function resetMailTables(prisma: PrismaService): Promise<void> {
  await prisma.mailLog.deleteMany();
  // `mail_log` cascades from `tenant`; the explicit delete above keeps this
  // honest even if that ever changes.
  await prisma.tenant.deleteMany();
}

/**
 * The own mail server that a test organisation gets by default
 * (ADR-0023).
 *
 * **`auth: null` on purpose.** A relay without login is a supported
 * operating mode, and it is the only one this module can write down without the
 * `MailSecretsService`: a password would have to be sealed,
 * and `createMailTenant` gets no key handed to it. Whoever
 * needs credentials (`smtp-credentials.spec.ts`) writes their block
 * themselves over `sealTenantBlock` anyway.
 *
 * The host points into the void; the suites of this folder run against a
 * transport double that accepts the block instead of dialling it. Where a
 * real connection is meant, the case sets the block itself.
 */
export const TEST_TENANT_SMTP_BLOCK = {
  host: 'mail.organisation.invalid',
  port: 587,
  secure: false,
  auth: null,
  from: 'post@organisation.invalid',
} as const satisfies SmtpBlock;

/**
 * A tenant to hang `mail_log` rows off. Only what the queue reads is filled.
 *
 * ⚠️ **It gets its own mail server, and since ADR-0023 that is the
 * precondition for anything going out at all.** Before, the
 * column was empty and the organisation inherited the installation's block; without
 * the inheritance an empty column would mean "this organisation does not send", and
 * every queue suite here would only prove that things are withheld.
 *
 * `smtp: null` has therefore become an **explicit** parameter and no longer a
 * default: "without a mail server the row stays lying there" is a case
 * one has to mean (`mail-unconfigured.spec.ts`).
 */
export async function createMailTenant(
  prisma: PrismaService,
  name = 'Organisation Alpha',
  smtp: SmtpBlock | null = TEST_TENANT_SMTP_BLOCK,
): Promise<string> {
  const tenant = await prisma.tenant.create({
    data: {
      shortName: `T${randomUUID().slice(0, 8)}`,
      name,
      logoWide: false,
      stripeColors: ['#212226'],
      accentColor: '#cea967',
      headerColor: '#212226',
      canvasColor: '#e9e6df',
      smtp: smtp ?? Prisma.DbNull,
    },
  });
  return tenant.id;
}

export interface QueuedMailOptions {
  readonly tenantId: string;
  readonly recipient?: string;
  readonly subject?: string;
  /** Explicit, always — the purge boundary is measured against it. */
  readonly createdAt?: Date;
  readonly nextAttemptAt?: Date | null;
  readonly attempts?: number;
  /**
   * Why this row goes out — and thereby, **under which identity**
   * (ADR-0020).
   *
   * Default `submit`, as in the column: the suites here measure the
   * queue, and its ordinary row is a form confirmation.
   * `system` is the value that puts the row into the system lane instead of the
   * organisation's — without this parameter the lane separation is not
   * reachable by a test at all (`MailLaneKey`).
   */
  readonly trigger?: NotificationTrigger;
}

/**
 * One queued row.
 *
 * The recipient defaults to a `.invalid` address: even if a suite ever reached
 * a real transport by mistake, the name cannot resolve and no mail can leave.
 */
export async function enqueueMail(
  prisma: PrismaService,
  options: QueuedMailOptions,
): Promise<string> {
  const row = await prisma.mailLog.create({
    data: {
      tenantId: options.tenantId,
      recipient: options.recipient ?? `bbr-${randomUUID()}@example.invalid`,
      subject: options.subject ?? 'Anmeldung eingegangen',
      status: 'queued',
      attempts: options.attempts ?? 0,
      ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
      ...(options.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: options.nextAttemptAt }),
    },
  });
  return row.id;
}
