/**
 * **The load test „Anmeldestart"** — the requirement, Konzept no. 79.
 *
 * ## What this script is for
 *
 * Konzept no. 79 promises that „Veranstaltungs-Teilnehmerlimits werden auch unter
 * Parallelität nie überschritten (**Lasttest**)". It names the Anmeldestart —
 * the minute a Jahrestagung registration opens and every organisation submits at once —
 * as the risk. It records that the number to build against is *not
 * known*, and separately decides the shape of the measurement: a **curve** over
 * 10 / 50 / 100 / 250 simultaneous submissions, with submissions per second,
 * response time p50 and p95, error rate and **seats taken against the
 * Obergrenze** at every step — and either the step at which it breaks, or the
 * explicit statement that nothing broke up to 250, with the numbers beside it.
 *
 * ## Why it is a script and not a `*.spec.ts`
 *
 * Two reasons, and the second is the one that matters.
 *
 * It takes minutes, and `pnpm -r test` is a gate that runs on every change
 * (the evidence — `test/load/gate-exclusion.spec.ts` is what keeps
 * that true rather than merely intended; note that this file's name does *not*
 * end in `.spec.ts`, which is what keeps Vitest from collecting it).
 *
 * And it writes into the **development database**, not into a throwaway one.
 * That is deliberate and it is the whole of the evidence: a load test whose
 * database is dropped afterwards can never tell you that its cleanup is broken,
 * because the drop hides everything. The residue measurement at the end
 * ({@link measureResidue}) counts by the **marks this run leaves** — a tenant
 * short name prefix and an e-mail domain — so a tenant that survived cleanup is
 * found, and so are its rows. That is a lesson learned once: the acceptance run got expensive
 * because a green suite had left thousands of rows behind.
 *
 * ## How to run it
 *
 *     pnpm --filter @formsache/api load-test
 *     pnpm --filter @formsache/api load-test -- --stages=10,50 --skip-curve
 *
 * Documented in `docs/kb/04-build-run.md`. It needs a reachable local
 * PostgreSQL and **no Docker** ; {@link preflight} refuses before
 * anything is written when either assumption does not hold.
 *
 * ⚠️ **Never at the same time as the central gates.** Once, a full run reported
 * an overbooking that did not exist — a review gate had removed the lock on
 * purpose at that moment. A red number here is read against `git diff` first.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { Client } from 'pg';
import { z } from 'zod';

import { SessionService } from '../../src/auth/session.service';
import { CSRF_HEADER_NAME, deriveCsrfToken } from '../../src/auth/csrf';
import { SESSION_COOKIE_NAME } from '../../src/auth/session-cookie';
import { loadEnvFile } from '../../src/config/env';
import { SECRET_BOX_KEY_BYTES } from '../../src/common/secret-box/secret-box-key';
import { createTenant, createUser } from '../support/fixtures';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';

// ---------------------------------------------------------------------------
// Marks, so that a crashed run is findable and a residue measurement means
// something
// ---------------------------------------------------------------------------

/**
 * Every tenant this script creates carries this prefix in its `short_name`.
 *
 * It is the handle for three things at once: the sweep of a **previous**
 * crashed run ({@link sweepOrphans}), this run's own cleanup, and the residue
 * measurement. One mark rather than three, because a cleanup that deletes by
 * one rule and a measurement that counts by another is exactly how „grün,
 * und tausend Zeilen liegen geblieben" happens.
 */
const TENANT_MARK = 'LOADTEST-';

/** The same mark for the editor account — `user` carries no `tenant_id`. */
const USER_MARK = '@loadtest.invalid';

/**
 * The seat limit of the control pair, and the number of registrations fired at
 * it. Twenty against ten is the shape earlier measurements already measured the
 * missing lock with (15 rows against a limit of 10), so a number from this run
 * is directly comparable with those.
 */
const CONTROL_SUBMISSIONS = 20;
const CONTROL_CAPACITY = 10;

/** The curve Konzept no. 79 specifies. */
const DEFAULT_STAGES = [10, 50, 100, 250] as const;

/**
 * Documentation address blocks (RFC 5737) — never a real caller, and three of
 * them because one is not enough.
 *
 * The public submit route allows **30 submissions a minute per address**
 * (`public-forms.rate-limit.ts`). A run that reused addresses would be
 * measuring the rate limit rather than the participant limit, so every single
 * submission of the whole run gets its own. Three /24 blocks give 762, and
 * {@link ownAddress} **throws** rather than wrapping — a silent wrap would turn
 * the second half of the curve into a 429 study without saying so.
 */
const ADDRESS_BLOCKS = ['192.0.2', '198.51.100', '203.0.113'] as const;
const ADDRESSES_PER_BLOCK = 254;

let addressesIssued = 0;

function ownAddress(): string {
  const index = addressesIssued;
  addressesIssued += 1;
  const block = ADDRESS_BLOCKS[Math.floor(index / ADDRESSES_PER_BLOCK)];
  if (block === undefined) {
    throw new Error(
      `Adressraum erschöpft nach ${String(index)} Absendungen: die Läufe würden ` +
        `sich das Rate-Limit von 30/min teilen und die Messung wäre eine ` +
        `Messung des Rate-Limits. Stufen verkleinern oder einen weiteren ` +
        `Dokumentationsblock ergänzen.`,
    );
  }
  return `${block}.${String((index % ADDRESSES_PER_BLOCK) + 1)}`;
}

// ---------------------------------------------------------------------------
// The fixture document
// ---------------------------------------------------------------------------

const PAGE_ID = '019ff900-0000-7000-8000-0000000000a0';
const EVENT_QUESTION = '019ff900-0000-7000-8000-000000000001';
const NAME_QUESTION = '019ff900-0000-7000-8000-000000000002';
const MAIL_QUESTION = '019ff900-0000-7000-8000-000000000003';
const BOUNDED_EVENT = 'konzert';
const UNBOUNDED_EVENT = 'ausflug';

/**
 * One Veranstaltungsfrage with a bounded and an unbounded event, plus the two
 * questions a registration really carries.
 *
 * The extra questions are not decoration: a refused submission still parses and
 * validates the **whole** document before the transaction refuses it, so a
 * fixture with nothing but the event question would measure a cheaper request
 * than the one an Anmeldestart actually sends.
 */
function definition(capacity: number): unknown {
  return {
    pages: [
      {
        id: PAGE_ID,
        title: 'Anmeldung Jahrestagung',
        description: null,
        questions: [
          {
            id: NAME_QUESTION,
            type: 'text',
            label: 'Name',
            hint: null,
            required: false,
            width: 'half',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
          {
            id: MAIL_QUESTION,
            type: 'email',
            label: 'E-Mail',
            hint: null,
            required: false,
            width: 'half',
          },
          {
            id: EVENT_QUESTION,
            type: 'event',
            label: 'Veranstaltungen',
            hint: null,
            required: false,
            width: 'full',
            events: [
              {
                key: BOUNDED_EVENT,
                label: 'Konzert',
                when: 'Fr, 19:00',
                capacity,
                showRemaining: false,
              },
              {
                key: UNBOUNDED_EVENT,
                label: 'Ausflug',
                when: null,
                capacity: null,
                showRemaining: false,
              },
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP — `node:http` rather than supertest
// ---------------------------------------------------------------------------

/**
 * The parts of an answer this script reasons about.
 *
 * `reason` and `position` are the machine-readable half of the refusal (the
 * evidence) and are read from the body rather than inferred from
 * the status: „409" alone does not say *which* of the seven links of the
 * refusal chain fired.
 */
interface Reply {
  readonly status: number;
  readonly reason: string | null;
  readonly position: { questionId: string; eventKey: string } | null;
  /** Wall-clock milliseconds from issuing the request to the last body byte. */
  readonly ms: number;
  /** Transport-level failure, or `null`. A failure is an error, never a refusal. */
  readonly failure: string | null;
}

const replyBodySchema = z.looseObject({
  reason: z.string().optional(),
  position: z
    .looseObject({ questionId: z.string(), eventKey: z.string() })
    .optional(),
});

interface Call {
  readonly port: number;
  readonly path: string;
  readonly body: unknown;
  /** `POST` unless said otherwise — the editor fixture also needs `PUT`. */
  readonly method?: 'POST' | 'PUT';
  readonly headers?: Record<string, string>;
  readonly agent?: Agent;
}

/**
 * One POST, timed.
 *
 * Never rejects: a socket error at 250 in flight is a **measurement**, not a
 * crash, and a rejected promise inside `Promise.all` would throw the other 249
 * results away with it.
 */
function post(call: Call): Promise<Reply> {
  const payload = Buffer.from(JSON.stringify(call.body), 'utf8');
  const started = performance.now();

  return new Promise<Reply>((resolve) => {
    const done = (partial: Omit<Reply, 'ms'>): void => {
      resolve({ ...partial, ms: performance.now() - started });
    };

    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: call.port,
        path: call.path,
        method: call.method ?? 'POST',
        ...(call.agent === undefined ? {} : { agent: call.agent }),
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
          ...call.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let reason: string | null = null;
          let position: Reply['position'] = null;
          try {
            const parsed = replyBodySchema.safeParse(JSON.parse(text));
            if (parsed.success) {
              reason = parsed.data.reason ?? null;
              position = parsed.data.position ?? null;
            }
          } catch {
            // A body that is not JSON is not a refusal we can read; the status
            // carries the whole story and `reason` stays null.
          }
          done({ status, reason, position, failure: null });
        });
      },
    );

    request.on('error', (error: Error) => {
      done({ status: 0, reason: null, position: null, failure: error.message });
    });
    request.end(payload);
  });
}

/** An authenticated mutating call — cookie **and** the derived CSRF header. */
function authed(token: string): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    [CSRF_HEADER_NAME]: deriveCsrfToken(token),
  };
}

/** A PUT/POST from the editor side, with its status asserted. */
async function editorCall(
  port: number,
  token: string,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  expected: number,
): Promise<void> {
  const reply = await post({
    port,
    path,
    body,
    method,
    headers: authed(token),
  });
  if (reply.status !== expected) {
    throw new Error(
      `${path}: erwartet ${String(expected)}, bekommen ${String(reply.status)}` +
        (reply.failure === null ? '' : ` (${reply.failure})`),
    );
  }
}

// ---------------------------------------------------------------------------
// Preflight — what has to hold before a single row is written
// ---------------------------------------------------------------------------

/**
 * The three assumptions of the evidence, checked **before** the
 * fixture exists.
 *
 * 1. **No Testcontainers.** `TEST_DATABASE_STRATEGY=testcontainers` is refused
 *    outright: this script never starts a container, and in an environment
 *    without Docker the alternative is a ninety-second image pull that fails
 *    with a message about a socket. Refusing here is the „Vorlauf" the
 *    requirement asks for.
 * 2. **The server answers.** A dead cluster produces `ECONNREFUSED` deep inside
 *    Nest's bootstrap otherwise, which reads like an application fault. It is
 *    not — it is `pg_ctlcluster 16 main start`, and the message says so.
 * 3. **The schema is current.** A missing migration would surface as a failing
 *    submission and be reported as a load-test finding.
 */
async function preflight(databaseUrl: string): Promise<void> {
  const strategy = process.env.TEST_DATABASE_STRATEGY ?? '';
  if (strategy === 'testcontainers') {
    throw new Error(
      'TEST_DATABASE_STRATEGY=testcontainers: dieses Skript startet keinen ' +
        'Container. Es misst gegen die lokale PostgreSQL-Instanz. Variable ' +
        'leeren oder auf „external" setzen.',
    );
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `PostgreSQL unter ${redactedUrl(databaseUrl)} nicht erreichbar ` +
        `(${error instanceof Error ? error.message : String(error)}).\n` +
        '   Das ist kein Testbefund. Starten: pg_ctlcluster 16 main start\n' +
        '   Prüfen:  pg_isready',
      { cause: error },
    );
  }

  try {
    const applied = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    const done = new Set(applied.rows.map((row) => row.migration_name));
    const onDisk = readdirSync(
      join(__dirname, '..', '..', 'prisma', 'migrations'),
      {
        withFileTypes: true,
      },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const missing = onDisk.filter((name) => !done.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Es fehlen ${String(missing.length)} Migrationen (zuerst: ${missing[0] ?? '?'}).\n` +
          '   pnpm --filter @formsache/api exec prisma migrate deploy',
      );
    }
  } finally {
    await client.end();
  }
}

/** The connection string without its credentials — safe to print. */
function redactedUrl(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null) {
    return '<unlesbare DATABASE_URL>';
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

// ---------------------------------------------------------------------------
// Fixture, sweep and cleanup
// ---------------------------------------------------------------------------

interface Fixture {
  readonly tenantId: string;
  readonly userId: string;
  readonly session: string;
}

/**
 * Removes what a **previous** run left behind, before this one measures
 * anything.
 *
 * Without it the residue measurement at the end would report another run's
 * leftovers and be read as this run's failure — and the leftovers would never
 * go away, because nobody knows which run they belong to. Same shape as the
 * orphan sweep of `test/database/test-database.ts`.
 */
async function sweepOrphans(app: TestApp): Promise<number> {
  const stale = await app.prisma.tenant.findMany({
    where: { shortName: { startsWith: TENANT_MARK } },
    select: { id: true },
  });
  for (const tenant of stale) {
    await removeTenant(app, tenant.id);
  }
  const users = await app.prisma.user.deleteMany({
    where: { email: { endsWith: USER_MARK } },
  });
  return stale.length + users.count;
}

/**
 * Deletes one marked tenant and everything hanging off it, **in dependency
 * order rather than by cascade**.
 *
 * `response.form_version_id` is `ON DELETE RESTRICT` while the tenant cascades
 * into both tables, so a bare `DELETE FROM tenant` is a coin toss on the order
 * PostgreSQL happens to take. Spelling the order out is the difference between
 * a cleanup that works and one that works until the schema grows a table.
 */
async function removeTenant(app: TestApp, tenantId: string): Promise<void> {
  const where = { where: { tenantId } };
  await app.prisma.mailLog.deleteMany(where);
  await app.prisma.eventRegistration.deleteMany(where);
  await app.prisma.responseDraft.deleteMany(where);
  await app.prisma.file.deleteMany(where);
  await app.prisma.response.deleteMany(where);
  await app.prisma.notification.deleteMany(where);
  await app.prisma.formPermission.deleteMany(where);
  await app.prisma.formTemplate.deleteMany(where);
  await app.prisma.aiUsage.deleteMany(where);
  // `form_version` cascades from `form`; the `published_version_id` back
  // reference disappears with the referencing row, so this one statement is
  // enough and the order above is what made it safe.
  await app.prisma.form.deleteMany(where);
  await app.prisma.membership.deleteMany(where);
  await app.prisma.tenant.deleteMany({ where: { id: tenantId } });
}

/** Tenant, editor and session — through Prisma, because none of it is measured. */
async function buildFixture(app: TestApp, runId: string): Promise<Fixture> {
  const tenant = await createTenant(app.prisma, `${TENANT_MARK}${runId}`);
  const user = await createUser(app.prisma, {
    email: `editor-${runId}${USER_MARK}`,
    password: randomUUID(),
    tenants: [tenant],
  });
  const { token } = await app.app.get(SessionService).issue(user.id, tenant.id);
  return { tenantId: tenant.id, userId: user.id, session: token };
}

interface LoadForm {
  readonly id: string;
  readonly slug: string;
  readonly capacity: number;
}

/**
 * A published form with a Veranstaltung of the given Obergrenze — **through the
 * real routes**, because what the limit reads is the *published* version and a
 * fixture written straight into `draft_schema` would measure a document the
 * enforcement never sees.
 *
 * It carries one notification on purpose. An Anmeldung confirms itself, and the
 * confirmation costs the submit path an aggregate query for the mail budget
 * before the transaction — leaving it out would measure a request no organisation ever
 * sends. Nothing goes out: all schedulers are off in the test application.
 */
async function publishForm(
  app: TestApp,
  fixture: Fixture,
  port: number,
  title: string,
  capacity: number,
): Promise<LoadForm> {
  const created = await post({
    port,
    path: apiPath('/forms'),
    body: { title },
    headers: authed(fixture.session),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(
      `POST /forms: ${String(created.status)} ${created.failure ?? ''}`,
    );
  }
  const form = await app.prisma.form.findFirstOrThrow({
    where: { tenantId: fixture.tenantId, title },
    select: { id: true, publicSlug: true, revision: true },
  });

  await editorCall(
    port,
    fixture.session,
    'PUT',
    apiPath(`/forms/${form.id}`),
    { title, definition: definition(capacity), revision: form.revision },
    200,
  );
  const saved = await app.prisma.form.findUniqueOrThrow({
    where: { id: form.id },
    select: { revision: true },
  });
  await editorCall(
    port,
    fixture.session,
    'POST',
    apiPath(`/forms/${form.id}/publish`),
    { revision: saved.revision },
    200,
  );
  await editorCall(
    port,
    fixture.session,
    'POST',
    apiPath(`/forms/${form.id}/notifications`),
    {
      name: 'Bestätigung',
      subject: 'Anmeldung eingegangen',
      body: 'Danke.',
      recipients: [
        { kind: 'literal', address: 'geschaeftsstelle@example.org' },
      ],
      replyTo: null,
    },
    201,
  );

  return { id: form.id, slug: form.publicSlug, capacity };
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/** One registration for one seat at the bounded Veranstaltung. */
function registration(seats: number, event = BOUNDED_EVENT): unknown {
  return {
    answers: {
      [NAME_QUESTION]: 'Testfüller',
      [MAIL_QUESTION]: 'teilnehmer@example.org',
      [EVENT_QUESTION]: { seats: { [event]: seats } },
    },
  };
}

function submitCall(
  port: number,
  form: LoadForm,
  agent?: Agent,
): Promise<Reply> {
  return post({
    port,
    path: apiPath(`/public/forms/${form.slug}/responses`),
    body: registration(1),
    headers: { 'x-forwarded-for': ownAddress() },
    ...(agent === undefined ? {} : { agent }),
  });
}

/**
 * `n` submissions **genuinely at once**: every request is issued before any of
 * them is awaited, over an agent with `n` sockets, so the counting and the
 * inserting interleave. That is what makes the result evidence about
 * concurrency rather than about arithmetic.
 */
async function fireParallel(
  port: number,
  form: LoadForm,
  n: number,
): Promise<{ replies: Reply[]; wallMs: number }> {
  const agent = new Agent({ keepAlive: false, maxSockets: n });
  const started = performance.now();
  const inFlight = Array.from({ length: n }, () =>
    submitCall(port, form, agent),
  );
  const replies = await Promise.all(inFlight);
  const wallMs = performance.now() - started;
  agent.destroy();
  return { replies, wallMs };
}

/** The same `n` submissions strictly one after the other. */
async function fireSequential(
  port: number,
  form: LoadForm,
  n: number,
): Promise<{ replies: Reply[]; wallMs: number }> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const started = performance.now();
  const replies: Reply[] = [];
  for (let index = 0; index < n; index += 1) {
    replies.push(await submitCall(port, form, agent));
  }
  const wallMs = performance.now() - started;
  agent.destroy();
  return { replies, wallMs };
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/**
 * One step of the curve — **numbers, not an opinion** (the evidence).
 *
 * `errorRate` counts what the application got *wrong*, and a refusal is not
 * that: a `409 event_full` is the Obergrenze doing its job. Anything else — a
 * 5xx, a 429 from the rate limit, a socket error, an unexpected status — is an
 * error, and `statuses` says which, because „Fehlerquote 0.4" without the
 * breakdown cannot be acted on.
 */
interface StageReport {
  readonly concurrency: number;
  readonly submissionsPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly errorRate: number;
  readonly seatsTaken: number;
  readonly seatLimit: number;
  readonly accepted: number;
  readonly refusedEventFull: number;
  readonly statuses: Record<string, number>;
  /** `true` when the database holds more seats than the Obergrenze allows. */
  readonly overbooked: boolean;
}

/** Nearest-rank percentile over a sorted copy — no interpolation, no surprises. */
function percentile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(share * sorted.length)),
  );
  return sorted[rank - 1] ?? 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Seats held for the bounded Veranstaltung, **from the database**. */
async function seatsTaken(app: TestApp, form: LoadForm): Promise<number> {
  const rows = await app.prisma.eventRegistration.findMany({
    where: {
      formId: form.id,
      eventKey: BOUNDED_EVENT,
      response: { deletedAt: null },
    },
    select: { seats: true },
  });
  return rows.reduce((sum, row) => sum + row.seats, 0);
}

async function report(
  app: TestApp,
  form: LoadForm,
  concurrency: number,
  outcome: { replies: Reply[]; wallMs: number },
): Promise<StageReport> {
  const { replies, wallMs } = outcome;
  const durations = replies.map((reply) => reply.ms).sort((a, b) => a - b);

  const statuses: Record<string, number> = {};
  for (const reply of replies) {
    const key =
      reply.failure !== null
        ? `transport:${reply.failure}`
        : reply.status === 409
          ? `409:${reply.reason ?? 'unbekannt'}`
          : String(reply.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  const accepted = replies.filter((reply) => reply.status === 200).length;
  const refusedEventFull = replies.filter(
    (reply) => reply.status === 409 && reply.reason === 'event_full',
  ).length;
  const errors = replies.length - accepted - refusedEventFull;
  const taken = await seatsTaken(app, form);

  return {
    concurrency,
    submissionsPerSecond: round((replies.length / wallMs) * 1000, 1),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    errorRate: round(errors / Math.max(1, replies.length), 4),
    seatsTaken: taken,
    seatLimit: form.capacity,
    accepted,
    refusedEventFull,
    statuses,
    overbooked: taken > form.capacity,
  };
}

function printTable(rows: readonly StageReport[]): void {
  const header = [
    'Stufe',
    'Abs./s',
    'p50 ms',
    'p95 ms',
    'Fehlerquote',
    'Plätze/Limit',
  ];
  const body = rows.map((row) => [
    String(row.concurrency),
    row.submissionsPerSecond.toFixed(1),
    row.p50Ms.toFixed(1),
    row.p95Ms.toFixed(1),
    row.errorRate.toFixed(4),
    `${String(row.seatsTaken)}/${String(row.seatLimit)}`,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((line) => (line[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padStart(widths[column] ?? 0)).join('  ');

  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of body) {
    console.log(line(row));
  }
}

// ---------------------------------------------------------------------------
// Residue
// ---------------------------------------------------------------------------

/**
 * **What is left over after the cleanup** — the evidence, and the
 * half without which a load test „meldet grün und lässt Tausende Zeilen
 * liegen".
 *
 * Counted by the **mark**, never by the tenant id this run happens to hold: a
 * tenant that survived cleanup has to be *findable*, and `where: { tenantId }`
 * against a deleted tenant is zero by construction. `user` and `session` are
 * counted separately because neither carries a `tenant_id` — that is precisely
 * the shape that left three named rows behind.
 *
 * One object rather than a series of numbers, so a failure names **everything**
 * that is left and not only the first thing.
 */
type ResidueTable =
  | 'tenants'
  | 'users'
  | 'sessions'
  | 'forms'
  | 'formVersions'
  | 'responses'
  | 'eventRegistrations'
  | 'notifications'
  | 'mailLog'
  | 'memberships'
  | 'groups';

/**
 * A `Record` over that union rather than an `interface`, and the difference is
 * not style: a mapped type carries an implicit index signature, so
 * {@link residueTotal} sums **every** entry — including one added later and
 * forgotten — instead of a hand-written list that would drift silently.
 */
type Residue = Readonly<Record<ResidueTable, number>>;

async function measureResidue(app: TestApp): Promise<Residue> {
  const marked = { tenant: { shortName: { startsWith: TENANT_MARK } } };
  const markedUser = { email: { endsWith: USER_MARK } };
  const prisma = app.prisma;
  return {
    tenants: await prisma.tenant.count({
      where: { shortName: { startsWith: TENANT_MARK } },
    }),
    users: await prisma.user.count({ where: markedUser }),
    sessions: await prisma.session.count({ where: { user: markedUser } }),
    forms: await prisma.form.count({ where: marked }),
    formVersions: await prisma.formVersion.count({ where: marked }),
    responses: await prisma.response.count({ where: marked }),
    eventRegistrations: await prisma.eventRegistration.count({ where: marked }),
    notifications: await prisma.notification.count({ where: marked }),
    mailLog: await prisma.mailLog.count({ where: marked }),
    memberships: await prisma.membership.count({ where: marked }),
    groups: await prisma.group.count({ where: marked }),
  };
}

function residueTotal(residue: Residue): number {
  return Object.values(residue).reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Options {
  readonly stages: readonly number[];
  readonly skipCurve: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let stages: readonly number[] = DEFAULT_STAGES;
  let skipCurve = false;
  for (const argument of argv) {
    // `pnpm run load-test -- --stages=10` forwards the separator itself.
    if (argument === '--') {
      continue;
    }
    if (argument.startsWith('--stages=')) {
      stages = argument
        .slice('--stages='.length)
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10));
      if (stages.some((value) => !Number.isInteger(value) || value < 1)) {
        throw new Error(`--stages: ganze Zahlen ≥ 1, bekommen „${argument}"`);
      }
    } else if (argument === '--skip-curve') {
      skipCurve = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log(
        'Lasttest „Anmeldestart" \n' +
          '  --stages=10,50,100,250  Stufen der Kurve\n' +
          '  --skip-curve            nur das Kontrollpaar (für die FOR-UPDATE-Nachstellung)\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unbekanntes Argument „${argument}"`);
    }
  }
  return { stages, skipCurve };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));

  loadEnvFile();
  if ((process.env.SECRET_BOX_KEY ?? '') === '') {
    // Same convenience as `test/setup-env.ts`: an ephemeral key per run, never
    // one written down anywhere.
    const { randomBytes } = await import('node:crypto');
    process.env.SECRET_BOX_KEY =
      randomBytes(SECRET_BOX_KEY_BYTES).toString('base64');
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL fehlt — ./scripts/dev-setup.sh ausführen.');
  }

  console.log('== Vorlauf');
  await preflight(databaseUrl);
  console.log(`   Datenbank: ${redactedUrl(databaseUrl)} (lokal, ohne Docker)`);

  const app = await createTestApp({
    databaseUrl,
    // A hop, so `X-Forwarded-For` is believed and every submission counts
    // against its own address of the 30-per-minute limit.
    env: { TRUST_PROXY_HOPS: 1 },
  });

  let failures = 0;
  const runId = randomUUID().slice(0, 8).toUpperCase();
  let fixture: Fixture | undefined;

  try {
    const swept = await sweepOrphans(app);
    if (swept > 0) {
      console.log(
        `   ${String(swept)} Rückstände eines früheren Laufs entfernt.`,
      );
    }

    const port = await new Promise<number>((resolve, reject) => {
      app.server.listen(0, () => {
        const address = app.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Server hat keinen Port bekommen.'));
          return;
        }
        resolve(address.port);
      });
    });

    fixture = await buildFixture(app, runId);
    console.log(` Lauf ${runId}, Organisation ${TENANT_MARK}${runId}\n`);

    // --- The control pair (the evidence) --------------------------------
    //
    // The pair is the requirement, not the parallel half alone: „ein
    // sequentieller Lauf besteht die falsche Bauform". Removing `lockForm`
    // leaves the first of these green and breaks only the second — that is
    // what makes the second one evidence.
    console.log(
      '== Kontrollpaar: dieselbe Grenze, nacheinander und gleichzeitig',
    );
    const sequentialForm = await publishForm(
      app,
      fixture,
      port,
      `Lasttest ${runId} nacheinander`,
      CONTROL_CAPACITY,
    );
    const sequential = await report(
      app,
      sequentialForm,
      1,
      await fireSequential(port, sequentialForm, CONTROL_SUBMISSIONS),
    );

    const parallelForm = await publishForm(
      app,
      fixture,
      port,
      `Lasttest ${runId} gleichzeitig`,
      CONTROL_CAPACITY,
    );
    const parallelOutcome = await fireParallel(
      port,
      parallelForm,
      CONTROL_SUBMISSIONS,
    );
    const parallel = await report(
      app,
      parallelForm,
      CONTROL_SUBMISSIONS,
      parallelOutcome,
    );

    console.log(
      `   nacheinander: ${String(sequential.seatsTaken)}/${String(CONTROL_CAPACITY)} Plätze, ` +
        `${String(sequential.accepted)} angenommen, ${String(sequential.refusedEventFull)} abgewiesen`,
    );
    console.log(
      `   gleichzeitig: ${String(parallel.seatsTaken)}/${String(CONTROL_CAPACITY)} Plätze, ` +
        `${String(parallel.accepted)} angenommen, ${String(parallel.refusedEventFull)} abgewiesen`,
    );
    for (const [what, stage] of [
      ['nacheinander', sequential],
      ['gleichzeitig', parallel],
    ] as const) {
      if (stage.overbooked) {
        failures += 1;
        console.error(
          `   ✗ ÜBERBUCHT (${what}): ${String(stage.seatsTaken)} Plätze gegen ` +
            `Grenze ${String(stage.seatLimit)}.`,
        );
      }
    }

    // --- the evidence: the reason is machine-readable and sits at the
    //     position, and the rest of the registration goes through ------------
    const refused = parallelOutcome.replies.find(
      (reply) => reply.status === 409,
    );
    const positionOk =
      refused?.reason === 'event_full' &&
      refused.position?.questionId === EVENT_QUESTION &&
      refused.position.eventKey === BOUNDED_EVENT;
    if (!positionOk) {
      failures += 1;
      console.error(
        `   ✗ Abweisung ohne maschinenlesbare Position: ${JSON.stringify(refused ?? null)}`,
      );
    } else {
      console.log(
        `   Abweisung: reason=${refused.reason}, position=${refused.position.eventKey} ` +
          `(Frage ${EVENT_QUESTION.slice(-4)})`,
      );
    }

    const rest = await post({
      port,
      path: apiPath(`/public/forms/${parallelForm.slug}/responses`),
      body: registration(6, UNBOUNDED_EVENT),
      headers: { 'x-forwarded-for': ownAddress() },
    });
    if (rest.status !== 200) {
      failures += 1;
      console.error(
        `   ✗ Der Rest der Anmeldung kam nicht durch: ${String(rest.status)} ` +
          (rest.reason ?? rest.failure ?? ''),
      );
    } else {
      console.log(
        '   Der Rest der Anmeldung (nur die Veranstaltung ohne Grenze) geht durch: 200\n',
      );
    }

    // --- The curve (the evidence) ---------------------------------------
    const curve: StageReport[] = [];
    if (options.skipCurve) {
      console.log('== Kurve übersprungen (--skip-curve)\n');
    } else {
      console.log('== Kurve');
      for (const concurrency of options.stages) {
        // Half the submissions fit, half must be refused: a stage whose
        // Obergrenze is never reached measures throughput and says nothing
        // about the limit, and one that is full from the start measures only
        // the refusal. This shape exercises both under the same lock.
        const capacity = Math.ceil(concurrency / 2);
        const form = await publishForm(
          app,
          fixture,
          port,
          `Lasttest ${runId} Stufe ${String(concurrency)}`,
          capacity,
        );
        const stage = await report(
          app,
          form,
          concurrency,
          await fireParallel(port, form, concurrency),
        );
        curve.push(stage);
        console.log(
          `   ${String(concurrency).padStart(3)} gleichzeitig → ` +
            `${stage.submissionsPerSecond.toFixed(1)}/s, p50 ${stage.p50Ms.toFixed(1)} ms, ` +
            `p95 ${stage.p95Ms.toFixed(1)} ms, Fehlerquote ${stage.errorRate.toFixed(4)}, ` +
            `${String(stage.seatsTaken)}/${String(stage.seatLimit)} Plätze`,
        );
        if (stage.overbooked) {
          failures += 1;
          console.error(
            `   ✗ ÜBERBUCHT: ${String(stage.seatsTaken)} Plätze gegen Grenze ${String(stage.seatLimit)}.`,
          );
        }
      }

      console.log('');
      printTable(curve);
      console.log('');
      console.log(JSON.stringify({ run: runId, stages: curve }, null, 2));
      console.log('');

      // The break point, or its absence — said outright either way.
      const broken = curve.filter(
        (stage) => stage.errorRate > 0 || stage.overbooked,
      );
      if (broken.length === 0) {
        const worst = curve.reduce(
          (a, b) => (a.p95Ms > b.p95Ms ? a : b),
          curve[0] ?? sequential,
        );
        console.log(
          `== Bruchpunkt: keiner bis ${String(options.stages[options.stages.length - 1] ?? 0)} ` +
            `gleichzeitigen Absendungen. Fehlerquote 0 auf jeder Stufe, ` +
            `kein Platz über der Grenze, höchstes p95 ${worst.p95Ms.toFixed(1)} ms ` +
            `auf Stufe ${String(worst.concurrency)}.`,
        );
      } else {
        failures += broken.filter((stage) => stage.overbooked).length;
        const first = broken[0];
        console.log(
          `== Bruchpunkt: Stufe ${String(first?.concurrency ?? 0)} — ` +
            `Fehlerquote ${first?.errorRate.toFixed(4) ?? '?'}, ` +
            `Plätze ${String(first?.seatsTaken ?? 0)}/${String(first?.seatLimit ?? 0)}, ` +
            `Statuscodes ${JSON.stringify(first?.statuses ?? {})}.`,
        );
      }
      console.log('');
    }
  } finally {
    // --- Cleanup and residue measurement (the evidence) -----------------
    //
    // In `finally`, so a run that broke halfway leaves no more behind than one
    // that finished — and each step in its own `try`, so a failure in the first
    // does not stop the second.
    console.log('== Aufräumen');
    if (fixture !== undefined) {
      try {
        await removeTenant(app, fixture.tenantId);
      } catch (error) {
        console.error('   Organisation löschen fehlgeschlagen:', error);
      }
      try {
        await app.prisma.user.deleteMany({
          where: { email: { endsWith: USER_MARK } },
        });
      } catch (error) {
        console.error('   Konten löschen fehlgeschlagen:', error);
      }
    }

    try {
      const residue = await measureResidue(app);
      const total = residueTotal(residue);
      if (total === 0) {
        console.log('   Rückstand: 0 Zeilen.');
      } else {
        failures += 1;
        console.error(
          `   ✗ Rückstand: ${String(total)} Zeilen —`,
          JSON.stringify(residue),
        );
      }
    } catch (error) {
      failures += 1;
      console.error('   ✗ Rückstandsmessung fehlgeschlagen:', error);
    }

    await app.close();
  }

  if (failures > 0) {
    console.error(`\n${String(failures)} Befund(e).`);
    return 1;
  }
  console.log('\nOhne Befund.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
