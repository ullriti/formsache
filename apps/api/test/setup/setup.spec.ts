import { parseSetupState, USER_PASSWORD_MIN } from '@formsache/shared';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SETUP_LOCK } from '../../src/setup/first-superadmin';
import { SETUP_RATE_LIMIT } from '../../src/setup/setup.rate-limit';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, login, openSession } from '../support/http';

/**
 * **First-time setup** (ADR-0022) — the one route of this application that
 * creates a superadmin without anybody having logged in.
 *
 * It is the most dangerous route of the application if it lives one day too
 * long, and that is why this file predominantly measures what it does **not**
 * do. A test that only checks the permitted access proves nothing at all here:
 * that an empty installation can be set up is the easy part.
 *
 * ## The four forbidden cases
 *
 * 1. **An existing user closes the door** — and indeed *any* user, not only a
 *    superadmin. Response: 404, like a route that does not exist.
 * 2. **Two concurrent setups yield exactly one superadmin.**
 *    That is the actual promise: the condition is checked in the same
 *    transaction in which the write happens.
 * 3. **`isSuperadmin: true` in the body of another route stays without effect.**
 *    The setup is the exception; it must not soften the existing rule.
 * 4. **The rate limit takes hold**, although the route is mostly dead.
 *
 * ## Why case 2 stands there twice — and what was measured while writing it
 *
 * The obvious case („five requests at once, exactly one user afterwards")
 * **proves nothing**, and that is not a guess: measured with the pre-lock
 * removed on 2026-08-15 against a local PostgreSQL 16 it stayed **green** —
 * `created,already-set-up,already-set-up,already-set-up,already-set-up`. The
 * five transactions lie only one to two milliseconds apart, and the first one
 * is regularly done before the second issues its `findFirst`. A race that does
 * not take place in the test run is a green test about a promise nobody has
 * checked.
 *
 * The same run with an artificial pause of 200 ms between check and creation
 * (that is, with the window a real load opens anyway): **five out of five
 * `created`, five user rows, five superadmins.** The gap is real; one just does
 * not hit it on demand.
 *
 * That is why the **decisive** case stands beside it and measures the mechanism
 * instead of chance: the test plays the concurrent party itself by holding the
 * pre-lock on a second connection, sees the request wait, creates the user in
 * the meantime and only then releases. The request must answer 404 afterwards.
 *
 * Both counter-checks of this case, measured:
 *
 * - **Pre-lock removed:** `AssertionError: expected true to be false` — the
 *   request does not even begin to wait, it has long been done after 400 ms.
 * - **Check pulled ahead of `$transaction`** (the lock stays in, so the request
 *   still waits): `AssertionError: expected 204 to be 404` — it waits, and
 *   creates anyway afterwards, because it has fetched its answer already
 *   *before* the waiting. Precisely this second check is the reason why the case
 *   does not only check „it waited", but also **what comes out afterwards**.
 *
 * ## Further counter-checks, measured while writing
 *
 * - The condition weakened to „no superadmin": „an existing user closes the
 *   door" goes red — the case deliberately creates an account **without** the
 *   flag, because that is the installation in which the weaker condition would
 *   be an open door.
 * - `@Throttle` taken off the route: the rate-limit case goes red.
 */

const PASSWORD = 'einrichtung-2026-xyz';
const SETUP = apiPath('/setup');

/** A valid setup document, adjustable per case. */
function setupBody(overrides: Record<string, unknown> = {}): object {
  return {
    admin: {
      email: 'erste@example.org',
      name: 'Erste Superadministratorin',
      password: PASSWORD,
    },
    tenant: null,
    ...overrides,
  };
}

describe('eine leere Installation richtet sich selbst ein', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it('sagt vor der Einrichtung, dass sie nötig ist', async () => {
    const response = await request(testApp.server).get(SETUP);

    expect(response.status).toBe(200);
    // Parsed against the shared schema instead of read loosely: it is a
    // `strictObject`, so a field that started to travel would show up here.
    expect(parseSetupState(response.body)).toStrictEqual({
      setupRequired: true,
    });
  });

  it.each([
    [
      'ein zu kurzes Passwort',
      setupBody({
        admin: {
          email: 'a@b.example',
          name: 'A',
          password: 'x'.repeat(USER_PASSWORD_MIN - 1),
        },
      }),
    ],
    // Without `tenant` at all: skipping is **said** (`null`), not hinted at by
    // omission — otherwise a forgotten field would be a decision nobody has
    // taken.
    [
      'ein weggelassenes `tenant`',
      {
        admin: {
          email: 'a@b.example',
          name: 'A',
          password: PASSWORD,
        },
      },
    ],
    [
      'einen Kurznamen mit Leerzeichen',
      setupBody({
        tenant: { shortName: 'Dach Org', name: 'Dachorganisation' },
      }),
    ],
  ])('weist %s ab, ohne etwas anzulegen', async (_what, body) => {
    const response = await request(testApp.server).post(SETUP).send(body);

    expect(response.status).toBe(400);
    expect(await testApp.prisma.user.count()).toBe(0);
  });

  it('legt einen Superadministrator **ohne** Organisation an — ein gültiger Endzustand', async () => {
    const response = await request(testApp.server)
      .post(SETUP)
      .send(setupBody());

    // 204: no body, no session, no secret. What comes back is the absence of
    // everything.
    expect(response.status).toBe(204);
    expect(response.body).toStrictEqual({});
    expect(response.text).toBe('');
    expect(response.headers['set-cookie']).toBeUndefined();

    const user = await testApp.prisma.user.findUniqueOrThrow({
      where: { email: 'erste@example.org' },
      select: { isSuperadmin: true, passwordHash: true, memberships: true },
    });
    expect(user.isSuperadmin).toBe(true);
    // **Argon2id**, the same check as everywhere — not plaintext, not another
    // algorithm, because this one path runs past the login.
    expect(user.passwordHash?.startsWith('$argon2id$')).toBe(true);
    // Without a membership, and that is not a gap: `user` carries no
    // `tenant_id`, `SuperadminGuard` runs without `TenantScopeGuard`.
    expect(user.memberships).toStrictEqual([]);
    expect(await testApp.prisma.tenant.count()).toBe(0);
  });

  it('lässt das eben gesetzte Passwort sich anmelden', async () => {
    // The proof that the setup leaves behind a *usable* account and not just a
    // row. Without it a hash that `verifyPassword` does not open would be a
    // green test and a dead installation.
    const token = await login(testApp, 'erste@example.org', PASSWORD);
    expect(token.length).toBeGreaterThan(0);
  });

  it('antwortet danach „nicht nötig" und schließt die schreibende Tür', async () => {
    const state = await request(testApp.server).get(SETUP);
    expect(parseSetupState(state.body)).toStrictEqual({ setupRequired: false });

    const again = await request(testApp.server)
      .post(SETUP)
      .send(
        setupBody({
          admin: {
            email: 'zweite@example.org',
            name: 'Zweite',
            password: PASSWORD,
          },
        }),
      );

    // 404 — not 409, not 403: both would be a statement about the state of this
    // installation to somebody who has none.
    expect(again.status).toBe(404);
    expect(await testApp.prisma.user.count()).toBe(1);
  });
});

describe('eine Installation mit irgendeinem Konto ist eingerichtet', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    tenant = await createTenant(testApp.prisma, 'ZUG');
    // **Explicitly without `isSuperadmin`.** This is the case that the weaker
    // condition „there is no superadmin" would have let through: a running
    // installation whose only superadmin was deleted would stand open to every
    // stranger — and precisely at the moment when it is most expensive.
    await createUser(testApp.prisma, {
      email: 'nur-mitglied@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it('meldet „keine Einrichtung nötig"', async () => {
    const response = await request(testApp.server).get(SETUP);

    expect(parseSetupState(response.body)).toStrictEqual({
      setupRequired: false,
    });
  });

  it('antwortet auf die schreibende Route wie eine Route, die es nicht gibt', async () => {
    const response = await request(testApp.server)
      .post(SETUP)
      .send(setupBody());

    expect(response.status).toBe(404);
    expect(await testApp.prisma.user.count()).toBe(1);
    expect(
      await testApp.prisma.user.count({ where: { isSuperadmin: true } }),
    ).toBe(0);
  });

  it('bleibt auch mit gültigem Dokument und erster Organisation verschlossen', async () => {
    const response = await request(testApp.server)
      .post(SETUP)
      .send(
        setupBody({ tenant: { shortName: 'NEU', name: 'Neue Organisation' } }),
      );

    expect(response.status).toBe(404);
    // And nothing came into being *halfway* either: the organisation is created
    // in the same transaction as the user, so it does not exist.
    expect(
      await testApp.prisma.tenant.findFirst({ where: { shortName: 'NEU' } }),
    ).toBeNull();
  });

  it('macht `isSuperadmin: true` im Rumpf einer anderen Route weiterhin wirkungslos', async () => {
    // The setup is **the** exception. It must not soften the existing rule, and
    // the proof of that belongs here, where the exception was built — not into a
    // file that nobody reads beside it.
    const superadmin = await createUser(testApp.prisma, {
      email: 'root@example.org',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    const session = await openSession(testApp, superadmin.id, tenant.id);

    const response = await request(testApp.server)
      .post(apiPath('/admin/tenants'))
      .set(authedMutation(session))
      .send({
        shortName: 'FLAG',
        name: 'Organisation mit Flaggenversuch',
        admin: {
          email: 'moechtegern@example.org',
          name: 'Möchtegern',
          password: PASSWORD,
          isSuperadmin: true,
        },
      });

    // `tenantCreateSchema` is a `strictObject`: the field is not silently
    // dropped, instead the request is refused. Both outcomes would be safe, but
    // only one is recognisable.
    expect(response.status).toBe(400);
    expect(
      await testApp.prisma.user.findUnique({
        where: { email: 'moechtegern@example.org' },
      }),
    ).toBeNull();
  });
});

describe('die Einrichtung wartet auf die Vorsperre und prüft danach', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  /** The second connection on which the test holds the lock itself. */
  let holder: Client;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    holder = new Client({ connectionString: database.url });
    await holder.connect();
  }, 120_000);

  afterAll(async () => {
    await holder.end();
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * **The deterministic proof** that „is there already a user" is answered
   * behind the lock and therefore *after* the waiting.
   *
   * The test plays the concurrent party itself instead of hoping for it: it
   * holds {@link SETUP_LOCK} on a connection of its own — as a **session** lock,
   * because it has to outlive a transaction —, sends the setup off and sees it
   * wait. Then it creates the user that the „first" request would have created,
   * and releases.
   *
   * What comes back afterwards is the whole promise: **404**, not 204. The
   * request has repeated its check after the waiting and seen the row that has
   * been committed in the meantime — that is exactly the property `READ
   * COMMITTED` delivers and `REPEATABLE READ` would destroy.
   *
   * The key comes from `SETUP_LOCK` and is not typed out a second time here: a
   * second spelling would yield a test that holds a lock nobody takes, and that
   * is then green because nothing waits.
   */
  it('wartet, solange die Sperre gehalten wird, und antwortet danach 404', async () => {
    await holder.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [
      SETUP_LOCK.namespace,
      SETUP_LOCK.id,
    ]);

    let settled = false;
    const pending = request(testApp.server)
      .post(SETUP)
      .send(setupBody())
      .then((response) => {
        settled = true;
        return response;
      });

    // Generously above everything Argon2id plus five statements need, and far
    // below the five seconds after which Prisma aborts an interactive
    // transaction.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);

    // The „first" request, played by the test: it is done and committed.
    await testApp.prisma.user.create({
      data: {
        email: 'schneller@example.org',
        name: 'Die Schnellere',
        passwordHash: 'x'.repeat(10),
        isSuperadmin: true,
      },
    });

    await holder.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [
      SETUP_LOCK.namespace,
      SETUP_LOCK.id,
    ]);

    const response = await pending;
    expect(response.status).toBe(404);
    expect(await testApp.prisma.user.count()).toBe(1);
  }, 30_000);
});

describe('fünf gleichzeitige Einrichtungen ergeben genau einen Superadministrator', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  /**
   * Five, not two — and **complementary**, not load-bearing: which request in a
   * test run really overlaps with which one is decided by the event loop and not
   * by this case (see the file header). What it contributes is the statement
   * about the *whole* block: four lost requests must not leave behind four
   * orphaned organisations either.
   *
   * Five stays below the rate limit of ten.
   */
  const CONCURRENT = 5;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it('lässt genau eine durch und weist die übrigen als „gibt es nicht" ab', async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, (_unused, index) =>
        request(testApp.server)
          .post(SETUP)
          .send(
            setupBody({
              admin: {
                email: `gleichzeitig-${String(index)}@example.org`,
                name: `Bewerberin ${String(index)}`,
                password: PASSWORD,
              },
              // Every request wants an organisation **as well**. That way the
              // case measures not only „one user", but that the whole block is
              // undivided: four lost requests must not leave behind four
              // orphaned organisations.
              tenant: {
                shortName: `ORG${String(index)}`,
                name: `Organisation ${String(index)}`,
              },
            }),
          ),
      ),
    );

    const created = responses.filter((response) => response.status === 204);
    const refused = responses.filter((response) => response.status === 404);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(CONCURRENT - 1);

    // The actual promise stands in the database, not in the status codes: a
    // status code can be mistaken, a second row cannot.
    expect(await testApp.prisma.user.count()).toBe(1);
    expect(
      await testApp.prisma.user.count({ where: { isSuperadmin: true } }),
    ).toBe(1);
    expect(await testApp.prisma.tenant.count()).toBe(1);
    expect(await testApp.prisma.membership.count()).toBe(1);
  });
});

describe('die erste Organisation ist dieselbe wie jede spätere', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * The counter-check to „two places create an organisation".
   *
   * It does not compare constants with constants, but **the two results**: the
   * organisation of the setup against one that `POST /api/admin/tenants`
   * creates. A colour that is updated in only one of the two places, and a
   * permission that only one of the two group lists gets, are red here — and
   * only here.
   */
  it('legt dieselben Gruppen und dasselbe Erscheinungsbild an wie „+ Neue Organisation"', async () => {
    const setup = await request(testApp.server)
      .post(SETUP)
      .send(
        setupBody({
          tenant: { shortName: 'ERSTE', name: 'Erste Organisation' },
        }),
      );
    expect(setup.status).toBe(204);

    const session = await login(testApp, 'erste@example.org', PASSWORD);
    const later = await request(testApp.server)
      .post(apiPath('/admin/tenants'))
      .set(authedMutation(session))
      .send({
        shortName: 'SPAETER',
        name: 'Spätere Organisation',
        /*
         * `admin: null` — „the logged-in superadmin account" (ADR-0024).
         *
         * Previously address, name and password of a new person stood here. The
         * password field does not exist any more, and a **new** person would now
         * be invited, thus presupposing a mail server of the instance — which
         * this suite deliberately does not set up, because it describes a freshly
         * set-up installation. What the case compares are the columns of the
         * organisation anyway, not its first administrator.
         *
         * ⚠️ **The path „later organisation with a *new* administrator" is
         * therefore not uncovered, it just stands elsewhere** —
         * `apps/api/test/admin/tenants.spec.ts`, „gives it the three standard
         * groups and one working administrator" and the cases beside it. The
         * reference stands here because otherwise this case looks like a softened
         * test on the next reading: it has swapped its `admin` object for `null`
         * and proves something else afterwards than before.
         */
        admin: null,
      });
    expect(later.status).toBe(201);

    const columns = {
      logoRef: true,
      logoWide: true,
      stripeColors: true,
      accentColor: true,
      headerColor: true,
      canvasColor: true,
      formDefaults: true,
      oidcEnabled: true,
    } as const;

    const first = await testApp.prisma.tenant.findUniqueOrThrow({
      where: { shortName: 'ERSTE' },
      select: columns,
    });
    const second = await testApp.prisma.tenant.findUniqueOrThrow({
      where: { shortName: 'SPAETER' },
      select: columns,
    });
    expect(first).toStrictEqual(second);

    // `form_defaults` stays `{}` — the organisation keeps inheriting from the
    // system layer (ADR-0011). A copy would look the same on the first day and
    // would cut off the *first* organisation of all things for good.
    expect(first.formDefaults).toStrictEqual({});

    const groupsOf = async (shortName: string) =>
      testApp.prisma.group.findMany({
        where: { tenant: { shortName } },
        orderBy: { name: 'asc' },
        select: {
          name: true,
          color: true,
          rank: true,
          isSystem: true,
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          canManageSettings: true,
          canManageFormSettings: true,
          canManageUsers: true,
        },
      });
    expect(await groupsOf('ERSTE')).toStrictEqual(await groupsOf('SPAETER'));

    // And it is „immediately able to work": the superadmin is at the same time
    // administrator of their first organisation, otherwise the tenant selection
    // would be empty on the first login.
    const membership = await testApp.prisma.membership.findFirstOrThrow({
      where: { tenant: { shortName: 'ERSTE' } },
      select: { group: { select: { name: true, isSystem: true } } },
    });
    expect(membership.group).toStrictEqual({ name: 'admin', isSystem: true });
  });
});

describe('die Einrichtungsroute ist gedrosselt, auch wenn sie tot ist', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
    // Set up, so every request below answers 404 — until the counter speaks.
    // That is exactly the point: the throttle has to run **before** the handler,
    // not instead of it.
    await createUser(testApp.prisma, {
      email: 'vorhanden@example.org',
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  it(`antwortet nach ${String(SETUP_RATE_LIMIT.limit)} Versuchen je Adresse mit 429`, async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= SETUP_RATE_LIMIT.limit; attempt += 1) {
      // One after another, not in parallel: what is counted is what the counter
      // says on the n-th call, and `Promise.all` would turn „which number in the
      // sequence" into a question of chance.
      const response = await request(testApp.server)
        .post(SETUP)
        .send(setupBody());
      statuses.push(response.status);
    }

    expect(statuses.slice(0, SETUP_RATE_LIMIT.limit)).toStrictEqual(
      Array.from({ length: SETUP_RATE_LIMIT.limit }, () => 404),
    );
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);
});
