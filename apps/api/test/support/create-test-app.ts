import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiEnv, SmtpBlock } from '@formsache/shared';
import { Prisma } from '@prisma/client';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule, GLOBAL_API_PREFIX } from '../../src/app.module';
import { APP_OPTIONS, configureApp } from '../../src/app-setup';
import { PublicUrlService } from '../../src/common/public-url/public-url.service';
import { AiFormGeneratorFactory } from '../../src/ai/ai-form-generator';
import type { AiFormGenerator } from '../../src/ai/ai-form-generator';
import { API_ENV } from '../../src/config/env';
import { FileStorage } from '../../src/files/file-storage';
import { MailClock } from '../../src/mail/mail-clock';
import { MailSecretsService } from '../../src/mail/mail-secrets.service';
import { SecretBoxService } from '../../src/common/secret-box/secret-box.service';
import { systemSecretContext } from '../../src/common/secret-box/secret-context';
import { MailTransport } from '../../src/mail/mail-transport';
import { SECRET_BOX_KEY_BYTES } from '../../src/common/secret-box/secret-box-key';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SYSTEM_SETTING_ID } from '../../src/system-settings/system-settings.repository';

/**
 * One key per test process, minted at runtime and never written down — no key
 * material belongs in the repository, and a constant in a test file is exactly
 * as copy-pasteable into a deployment as a real one.
 *
 * Per *process*, not per application: a suite that boots a second app against
 * the same database has to be able to read what the first one sealed.
 * `test/setup-env.ts` normally puts it into the environment already; the
 * fallback keeps this file usable on its own.
 */
const TEST_SECRET_BOX_KEY =
  process.env.SECRET_BOX_KEY ??
  randomBytes(SECRET_BOX_KEY_BYTES).toString('base64');

/**
 * A real, writable directory for the file storage — one per test process
 * (ADR-0014 no. 2).
 *
 * It has to be a real one: `LocalFileStorage` checks at startup that the path
 * is absolute, exists, is a directory and is writable, and a test application
 * that skipped that check would boot a shape production never boots.
 *
 * A suite that wants to *watch* what a write did hands in the in-memory double
 * ({@link TestAppOptions.storage}) instead of looking at this directory —
 * „welche Bytes hat der Speicher gesehen" is the measurement the requirement
 * asks for, and a directory cannot answer it. That the double needs no change
 * to production code is the property it asks for: the seam is one.
 *
 * Deliberately not removed afterwards: the directory is empty, `mkdtemp` puts
 * it under the OS temp directory, and a cleanup hook in this helper would have
 * to outlive every application it created.
 */
const TEST_FILE_STORAGE_DIR = mkdtempSync(
  join(tmpdir(), 'formsache-file-storage-'),
);

/**
 * The base address the test application answers under.
 *
 * Exported so a suite can assert against it rather than re-typing it, and
 * deliberately a host that cannot be reached: the base address is
 * *configuration*, not the `Host` of the request supertest sends, and a link
 * built from the request would be trivially wrong here — which is the point.
 *
 * **It is a row, not an environment variable**, so a suite that
 * needs absolute links has to ask for it: `systemMail: { publicBaseUrl:
 * TEST_PUBLIC_BASE_URL }`, or {@link configureSystemMail} afterwards. Not
 * seeding it by default is deliberate — the suites of the requirement assert that
 * a fresh installation has **no** `system_setting` row at all, and a helper that
 * quietly wrote one would make „keine Zeile" untestable.
 */
export const TEST_PUBLIC_BASE_URL = 'https://formulare.test.invalid';

/**
 * The system block a suite gets when it hands in a {@link TestAppOptions.transport}
 * double and no mail configuration of its own.
 *
 * **Why this exists at all** : the double replaces the outside *world*,
 * but which identity a row goes out under is still resolved from the database
 * (`MailIdentityService`, ADR-0013 no. 5). An organisation that inherits from an
 * installation with no block therefore resolves to `withhold` — the row waits,
 * nothing is attempted — and every suite that swapped in a double to watch mail
 * go out would silently watch nothing happen. Not a failure anybody could read:
 * the run reports zero attempts and the assertion says „expected 1, got 0".
 *
 * The values are inert. The double never dials anything, the host cannot
 * resolve, and there is no password to seal — a suite that wants the credentials
 * on the wire uses `systemMail` and the real transport (`smtp-credentials.spec.ts`).
 */
export const TEST_SYSTEM_SMTP_BLOCK: SmtpBlock = {
  host: 'smtp.installation.invalid',
  port: 587,
  secure: false,
  auth: null,
  from: 'formulare@installation.invalid',
};

/**
 * The installation-wide mail configuration a suite wants in place — the two
 * values that left the environment.
 *
 * `smtp` is handed in as **plaintext**: `configureSystemMail` seals the password
 * through the application's own `MailSecretsService`, so a suite cannot
 * accidentally write a ciphertext nobody can open, and the sealing under test is
 * the sealing that runs.
 */
export interface SystemMailFixture {
  readonly publicBaseUrl?: string;
  /**
   * The installation's block — or **`null` to say „keinen, und zwar
   * ausdrücklich"**.
   *
   * The three values are three different states, and the middle one had no way
   * to be expressed: left out, a suite that hands in a transport double gets
   * {@link TEST_SYSTEM_SMTP_BLOCK} seeded for it, which is right for the suites
   * that want to watch mail go out and silently wrong for a suite that wants to
   * prove **nothing** goes out without a configuration — it would seed the very
   * thing under test and pass (a review finding). `null` clears the column
   * instead.
   */
  readonly smtp?: SmtpBlock | null;
  /**
   * The installation-wide default for `Reply-To`.
   *
   * The same three states as with {@link SystemMailFixture.smtp}: left out
   * means „dazu sage ich nichts" and leaves the column as it is; `null` clears
   * it explicitly. The difference counts here just as much, because „keine
   * Vorgabe" is the state in which a mail goes out **without** the header — a
   * promise a test has to be able to measure.
   */
  readonly replyTo?: string | null;
}

/**
 * Boots the real application against a throwaway database.
 *
 * The whole `AppModule` rather than a hand-assembled testing module: guards,
 * the global prefix and the exception filters are part of what the requirements
 * promise, and a module stitched together in the test would quietly leave them
 * out. In particular the prefix is applied here exactly as `main.ts` applies
 * it — a suite that reached `/auth/login` while the server serves
 * `/api/auth/login` would be green about the wrong URL.
 */
export interface TestApp {
  readonly app: INestApplication;
  /** The http server supertest drives, named once so no caller re-types it. */
  readonly server: Server;
  readonly prisma: PrismaService;
  readonly close: () => Promise<void>;
}

export interface TestAppOptions {
  readonly databaseUrl: string;
  /** Overrides on top of the test defaults, e.g. a production `NODE_ENV`. */
  readonly env?: Partial<ApiEnv>;
  /**
   * Replaces the outside world of the mail queue.
   *
   * The one override this helper takes, and it is here rather than in a
   * general-purpose hook because there is exactly one thing a suite must be
   * able to swap while still booting the **real** `AppModule`: this asks what a
   * submission does „wenn der Mailserver tot ist", and that question is only
   * answerable against an application whose public route, transaction and
   * worker are the shipped ones. Everything else in the graph stays untouched
   * — see `test/mail/mail-test-context.ts` for the narrower harness the queue's
   * own requirements use.
   */
  readonly transport?: MailTransport;
  /**
   * Replaces the calendar of the mail queue — the companion of `transport`.
   *
   * A suite that wants to see „geht raus, sobald der Transport antwortet"
   *  has to get past the backoff, and the alternatives are
   * both worse: sleeping for the retry delay, or editing `next_attempt_at` in
   * the database, which would test the suite's own SQL instead of the worker's.
   * No test in this repository sleeps.
   */
  readonly clock?: MailClock;
  /**
   * Replaces the resolver of the installation's/organisation's own address.
   *
   * The one case this is for: proving that a database hiccup while building
   * the edit link — a real possibility since the address became a read
   * against `tenant`/`system_setting` rather than an environment variable —
   * degrades to `editUrl: null` instead of a 500 on an answer that already
   * committed (a review finding). A suite that needs that has no way to
   * make the real `PublicUrlService` fail on demand short of breaking the
   * schema out from under every other query in the same request, so it swaps
   * the provider instead — the same shape `transport` and `clock` already
   * use for the same reason.
   */
  readonly publicUrl?: PublicUrlService;
  /**
   * A logger for this application, replacing Nest's `TestingLogger`.
   *
   * Needed by any suite that **counts** a log line, and the reason is a
   * property of `@nestjs/testing` rather than of this application:
   * `TestingModuleBuilder.compile()` installs a logger whose `log`, `warn`,
   * `debug` and `verbose` are empty methods. A requirement satisfied by a
   * *warning* is therefore invisible in every suite booted through
   * `Test.createTestingModule`, this helper included — a lesson learned before,
   * where the „einmal beim Start" notice had to be moved to a second boot.
   *
   * Handing in a real `ConsoleLogger` restores what `NestFactory.create`
   * leaves in place in the shipped application. Pass it whenever the assertion
   * is `countOf(...) === 1`, even for a line written at `error` level: the
   * count must not depend on which levels the test harness happens to forward
   * today.
   */
  readonly logger?: LoggerService;
  /**
   * Replaces where the bytes go (ADR-0014 no. 1).
   *
   * The one measurement the requirement actually asks for: „gemessen am
   * **Storage-Doppel** (welche Bytes es gesehen hat), nicht an einer
   * HTTP-Antwort — eine 413 sagt nichts darüber, was vorher auf die Platte
   * lief." `InMemoryFileStorage.bytesSeen` is that number, and a suite can only
   * read it if the application it drives is holding the double.
   *
   * That this override needs **no** change to production code is the requirement's
   * first proof: the seam is one, the double extends the same abstract class,
   * and it inherits the key check rather than repeating it.
   */
  readonly storage?: FileStorage;
  /**
   * Writes the `system_setting` row with the installation's mail configuration
   * before the helper returns.
   *
   * Deliberately **not** applied by default — see {@link TEST_PUBLIC_BASE_URL}.
   */
  readonly systemMail?: SystemMailFixture;
  /**
   * Replaces the AI seam (ADR-0015 no. 1, the requirements).
   *
   * There is no provider key in this environment and there will not be one, so
   * a suite that drives the route hands in `RecordedFormGenerator` — the same
   * double the contract table elsewhere measures the two shipped adapters
   * against. It needs **no** change to production code, which is the property
   * of the seam.
   *
   * ⚠️ Handing in a double does **not** make the feature available: whether the
   * route answers 404 is decided by the settings row, i.e. by {@link ai}. A
   * suite that wants a working route asks for both — and that separation is
   * deliberate, because it is what lets a suite have a configured installation
   * whose seam it can watch, and another one with the very same double and no
   * configuration, to see the 404.
   */
  readonly aiGenerator?: AiFormGenerator;
  /**
   * Writes the AI configuration into the `system_setting` row before the
   * helper returns.
   *
   * This used to be an `env` entry. Since the move it is a row, and the
   * distinction is exactly the promise: an installation can gain and lose the
   * feature **in operation**, without restarting.
   *
   * The key is written sealed here — through the same `SecretBoxService` the
   * application uses —, so that a suite looking raw into the database finds no
   * plaintext there (the evidence).
   */
  readonly ai?: AiFixture;
}

/** What a suite can say about the installation's AI configuration. */
export interface AiFixture {
  readonly provider?: 'anthropic' | 'mistral';
  readonly apiKey?: string;
  readonly model?: string;
  readonly region?: 'eu' | 'global' | 'us';
  /** The installation-wide switch; default `true`, as in the column. */
  readonly enabled?: boolean;
}

export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  const env: ApiEnv = {
    NODE_ENV: 'test',
    API_PORT: 3000,
    APP_VERSION: '0.0.0-test',
    DATABASE_URL: options.databaseUrl,
    SESSION_TTL_HOURS: 12,
    // No trusted proxy by default — the same posture the shipped default
    // takes, so a test that wants a hop has to ask for it.
    TRUST_PROXY_HOPS: 0,
    SECRET_BOX_KEY: TEST_SECRET_BOX_KEY,
    // A throwaway directory per test process — see {@link TEST_FILE_STORAGE_DIR}.
    FILE_STORAGE_DIR: TEST_FILE_STORAGE_DIR,
    // **All four schedulers off** . A mail worker
    // that starts on its own drains queues another suite is in the middle of
    // counting, and a purge that starts on its own deletes rows a third one
    // just wrote — non-determinism that reads like flakiness rather than like a
    // missing setting. Suites drive `runOnce()` themselves, which is also what
    // makes the backoff tests expressible at all.
    //
    // `FILE_PURGE_INTERVAL_MS` joined them later and the hazard is the
    // sharper one: every suite in `test/files/` and `test/public/` writes `file`
    // rows, and an armed purge deletes exactly the unclaimed ones they are in
    // the middle of counting.
    //
    // `TRASH_PURGE_INTERVAL_MS` joined them later still and is the sharpest of
    // the four: an armed run destroys deleted forms, deleted answers **and
    // deleted organisations** across the whole database — every suite in `test/trash/`
    // and `test/admin/` puts rows into exactly that state on purpose. It would
    // also delete `user` rows, i.e. rows other suites are logged
    // in as.
    MAIL_WORKER_INTERVAL_MS: 0,
    MAIL_PURGE_INTERVAL_MS: 0,
    FILE_PURGE_INTERVAL_MS: 0,
    TRASH_PURGE_INTERVAL_MS: 0,
    // The fifth scheduler, off for the same reason (ADR-0015 no. 8).
    AI_USAGE_PURGE_INTERVAL_MS: 0,
    // Like the four intervals above: no scheduler in a suite that triggers
    // the runs itself.
    OPS_ALERT_INTERVAL_MS: 0,
    // The seventh, for the same reason and with the sharpest side effect of
    // them all (a review finding): an armed run deletes `session` rows right
    // across the database — that is, exactly the rows other suites are logged
    // in with.
    SESSION_PURGE_INTERVAL_MS: 0,
    // **The AI is off in the shipped test application** (ADR-0015 no. 9)
    // — and *here* there is nothing more about it: provider,
    // key, model and switch are columns of the settings row. A suite that
    // wants the feature configured passes `ai: { … }`
    // and additionally puts in the recorded double.
    //
    // What remains is our own time limit — a property of this process.
    AI_REQUEST_TIMEOUT_MS: 60_000,
    // The mail server and the base address are **not** here: they
    // are rows, and a suite that wants either asks for it through `systemMail`.
    // The shipped state of the test application stays the unconfigured one of
    // the requirement.
    ...options.env,
  };

  let builder = Test.createTestingModule({ imports: [AppModule] })
    // The application's own environment points at the development database;
    // the test has to run against the throwaway one.
    .overrideProvider(API_ENV)
    .useValue(env);

  if (options.transport !== undefined) {
    builder = builder
      .overrideProvider(MailTransport)
      .useValue(options.transport);
  }
  if (options.clock !== undefined) {
    builder = builder.overrideProvider(MailClock).useValue(options.clock);
  }
  if (options.storage !== undefined) {
    builder = builder.overrideProvider(FileStorage).useValue(options.storage);
  }
  if (options.aiGenerator !== undefined) {
    // **The factory, not the adapter** — the adapter comes into being
    // per resolution, because the configuration can change in operation. A
    // double that were bound as a finished instance would hang on an answer
    // from startup time.
    const double = options.aiGenerator;
    builder = builder
      .overrideProvider(AiFormGeneratorFactory)
      .useValue({ create: () => double });
  }
  if (options.publicUrl !== undefined) {
    builder = builder
      .overrideProvider(PublicUrlService)
      .useValue(options.publicUrl);
  }
  if (options.logger !== undefined) {
    builder = builder.setLogger(options.logger);
  }

  const moduleRef = await builder.compile();

  // `APP_OPTIONS` has to be handed in at construction — `bodyParser: false`
  // is decided before the application exists and cannot be undone afterwards.
  // Passing it here is what keeps the login-CSRF defence under test rather
  // than merely in production.
  const app =
    moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  // The same call `main.ts` makes — one configuration, so the application
  // under test cannot drift from the one that ships.
  configureApp(app, env);
  await app.init();

  const testApp: TestApp = {
    app,
    server: app.getHttpServer(),
    prisma: app.get(PrismaService),
    close: () => app.close(),
  };

  // A double stands in for the outside world, not for the configuration: the
  // identity of a row is still resolved from the database. Without a block to
  // resolve to, every organisation inherits „nicht eingerichtet" and nothing is ever
  // attempted — see {@link TEST_SYSTEM_SMTP_BLOCK}. An explicit `systemMail.smtp`
  // always wins, **`null` included**: that is how a suite keeps the unconfigured
  // state *and* a double to count with (see {@link SystemMailFixture.smtp}).
  // Passing no transport at all is the other way, and what
  // `mail-unconfigured.spec.ts` does.
  const seeded: SystemMailFixture | undefined =
    options.transport !== undefined && options.systemMail?.smtp === undefined
      ? { ...options.systemMail, smtp: TEST_SYSTEM_SMTP_BLOCK }
      : options.systemMail;

  if (seeded !== undefined) {
    await configureSystemMail(testApp, seeded);
  }
  if (options.ai !== undefined) {
    await configureAi(testApp, options.ai);
  }

  return testApp;
}

/**
 * Writes the AI configuration into the settings row — what `AI_PROVIDER` and the key variables in the environment
 * used to do.
 *
 * Exported separately from the option, like {@link configureSystemMail}, and
 * for the same reason: „der Superadmin trägt einen Anbieter nach, und der
 * Menüeintrag erscheint **ohne Neustart**" is a state transition and no
 * default — and that transition is exactly the promise the move brings in.
 *
 * Sealing goes through the `SecretBoxService` of the application itself, under
 * the context `AiSettingsService` uses. This helper therefore does not know how
 * sealing happens — which keeps it from becoming a second version of it.
 */
export async function configureAi(
  app: TestApp,
  fixture: AiFixture,
): Promise<void> {
  const secrets = app.app.get(SecretBoxService);
  const data = {
    aiEnabled: fixture.enabled ?? true,
    aiProvider: fixture.provider ?? null,
    aiModel: fixture.model ?? null,
    aiRegion: fixture.region ?? null,
    aiApiKey:
      fixture.apiKey === undefined
        ? null
        : secrets.seal(fixture.apiKey, systemSecretContext('ai.api_key')),
  };
  await app.prisma.systemSetting.upsert({
    where: { id: SYSTEM_SETTING_ID },
    create: { id: SYSTEM_SETTING_ID, ...data },
    update: data,
  });
}

/**
 * Writes the installation's mail configuration into `system_setting`
 *  — what `SMTP_*` and `PUBLIC_BASE_URL` in the environment
 * used to do.
 *
 * Exported separately from the option, because a suite may want to change it
 * *while the application runs*: „der Superadmin trägt einen Mailserver nach und
 * die wartenden Zeilen gehen raus" is a state transition, not a fixture.
 *
 * The password is sealed by the application's own service under its own
 * context, so nothing here knows how sealing works — which is what keeps this
 * helper from becoming a second implementation of it.
 */
export async function configureSystemMail(
  app: TestApp,
  fixture: SystemMailFixture,
): Promise<void> {
  await writeSystemMail(app.prisma, app.app.get(MailSecretsService), fixture);
}

/**
 * The same write for a harness that boots something smaller than the whole
 * application — `test/mail/mail-test-context.ts` boots `MailModule` alone.
 *
 * One implementation for both, because the interesting part is *which context
 * the password is sealed under*, and two helpers would be two answers to that.
 */
export async function writeSystemMail(
  prisma: PrismaService,
  secrets: MailSecretsService,
  fixture: SystemMailFixture,
): Promise<void> {
  const data = {
    ...(fixture.publicBaseUrl === undefined
      ? {}
      : { publicBaseUrl: fixture.publicBaseUrl }),
    // `undefined` leaves the column as it is, `null` clears it: „ausdrücklich
    // kein Mailserver" is a state a suite has to be able to ask for, and it is
    // not the same as „dazu sage ich nichts".
    ...(fixture.replyTo === undefined ? {} : { replyTo: fixture.replyTo }),
    ...(fixture.smtp === undefined
      ? {}
      : {
          smtp:
            fixture.smtp === null
              ? // The SQL NULL, not the JSON one: „die Spalte ist leer" is what
                // `MailIdentityService` reads as „nicht eingerichtet".
                Prisma.DbNull
              : secrets.sealSystemBlock(fixture.smtp),
        }),
  };
  await prisma.systemSetting.upsert({
    where: { id: SYSTEM_SETTING_ID },
    create: { id: SYSTEM_SETTING_ID, ...data },
    update: data,
  });
}

/** Path of a route under the global prefix — spelled once, not per request. */
export function apiPath(path: string): string {
  return `/${GLOBAL_API_PREFIX}${path}`;
}
