import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FORM_PAGE_SIZE_DEFAULT,
  FORM_PAGE_SIZE_MAX,
  formListPageSchema,
  type FormListPage,
} from '@formsache/shared';

import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { cookieHeader, openSession } from '../support/http';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';

/**
 * **The requirement — `GET /api/forms` has a limit and a pagination**,
 * against real PostgreSQL.
 *
 * Written the way `CONTRIBUTING.md` demands: every guarantee is asserted through
 * the case that must fail. Three of the four proofs are only expressible
 * that way at all —
 *
 * - a page that is *complete* proves nothing unless the same walk also shows it
 *   is **overlap-free** : a list that repeats one row and drops
 *   another has the right length on every page;
 * - a stable order is invisible until two rows **tie** , so this
 *   suite writes the tie by hand rather than hoping two `createMany` rows land
 *   in the same millisecond;
 * - a filter is indistinguishable from no filter until the hidden row would
 *   have been on **page two**  — which is the whole reason the
 *   fixture below places it there deliberately instead of wherever it fell.
 *
 * **Negative probes, measured while writing this file** — see the worklog
 * `docs/worklog/2026-08-10-d3-d4-paginierung.md` for the full output.
 */

const PASSWORD = 'test-password';

/** A minimal but real definition — one page, one required text question. */
function definition(label = 'Name') {
  return {
    pages: [
      {
        id: '019fd000-0000-7000-8000-0000000000a0',
        title: 'Seite 1',
        questions: [
          {
            id: '019fd000-0000-7000-8000-000000000001',
            type: 'text',
            label,
            hint: null,
            required: true,
            width: 'full',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}

describe('the paged form list ', () => {
  let database: TestDatabase;
  let app: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** An administrator of ALPHA — unrestrictable, sees every form of the organisation. */
  let adminSession: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    app = await createTestApp({ databaseUrl: database.url });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await database.release();
  });

  beforeEach(async () => {
    // Every describe below builds its own population, so the previous one must
    // be gone: a leftover form of the last block would land in the middle of
    // this one's order and make „vollständig" a statement about two fixtures.
    await app.prisma.formPermission.deleteMany({});
    await app.prisma.form.deleteMany({});
    await app.prisma.membership.deleteMany({});
    await app.prisma.session.deleteMany({});
    await app.prisma.user.deleteMany({});
    await app.prisma.group.deleteMany({});
    await app.prisma.tenant.deleteMany({});

    alpha = await createTenant(app.prisma, 'alpha');
    beta = await createTenant(app.prisma, 'beta');
    const admin = await createUser(app.prisma, {
      email: 'admin@alpha.example',
      password: PASSWORD,
      tenants: [alpha],
    });
    adminSession = await openSession(app, admin.id, alpha.id);
  });

  /**
   * Creates `count` forms of a tenant with a **deterministic** order.
   *
   * `updated_at` is written by raw SQL afterwards rather than handed to Prisma:
   * the column is `@updatedAt`, so Prisma owns it on every write, and a fixture
   * that fought it would be testing Prisma. One second apart and counting
   * *down* from a fixed instant, so index 0 is the newest and therefore the
   * first row of page one — which is what lets a test say „auf Seite zwei"
   * about a specific form instead of about whichever one landed there.
   */
  async function seedForms(
    tenant: TenantFixture,
    count: number,
    titleOf: (index: number) => string = (index) =>
      `Formular ${String(index).padStart(3, '0')}`,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const form = await app.prisma.form.create({
        data: {
          tenantId: tenant.id,
          title: titleOf(index),
          draftSchema: definition(),
          publicSlug: `slug-${tenant.shortName}-${String(index)}`,
        },
        select: { id: true },
      });
      ids.push(form.id);
      await app.prisma.$executeRaw`
        UPDATE form
        SET updated_at = TIMESTAMPTZ '2026-08-01T12:00:00Z' - (${index}::text || ' seconds')::interval
        WHERE id = ${form.id}::uuid`;
    }
    return ids;
  }

  /** One request through the whole guard chain, parsed by the wire contract. */
  async function fetchPage(session: string, query = ''): Promise<FormListPage> {
    const response = await request(app.server)
      .get(`${apiPath('/forms')}${query}`)
      .set('Cookie', cookieHeader(session));
    expect(response.status).toBe(200);
    // Parsed rather than read: a payload that lost `total` must fail here
    // rather than make an assertion about `undefined` further down.
    return formListPageSchema.parse(response.body);
  }

  /**
   * Walks **every** page and returns the ids in the order they arrived —
   * duplicates included, because the duplicates are the finding.
   */
  async function walkAllPages(
    session: string,
    limit: number,
    extraQuery = '',
  ): Promise<{ ids: string[]; total: number; pages: number }> {
    const ids: string[] = [];
    let offset = 0;
    let total = 0;
    let pages = 0;
    // A bound rather than `while (true)`: a route that always answers a full
    // page would otherwise hang the suite instead of failing it.
    const MAX_PAGES = 200;
    for (; pages < MAX_PAGES; pages += 1) {
      const page = await fetchPage(
        session,
        `?limit=${String(limit)}&offset=${String(offset)}${extraQuery}`,
      );
      total = page.total;
      ids.push(...page.items.map((form) => form.id));
      offset += page.limit;
      if (offset >= page.total) {
        pages += 1;
        break;
      }
    }
    return { ids, total, pages };
  }

  describe('the wire contract ', () => {
    it('answers one page of the measured size when asked for nothing', async () => {
      await seedForms(alpha, FORM_PAGE_SIZE_DEFAULT + 7);

      const page = await fetchPage(adminSession);

      expect(page.items).toHaveLength(FORM_PAGE_SIZE_DEFAULT);
      expect(page.limit).toBe(FORM_PAGE_SIZE_DEFAULT);
      expect(page.offset).toBe(0);
      // The total is the **whole** list, not the page — the number the
      // dashboard's „n Formulare" reads.
      expect(page.total).toBe(FORM_PAGE_SIZE_DEFAULT + 7);
    });

    /**
     * ⚠️ The line the requirement marks: „ein `limit=100000` aus der Adresszeile
     * bekommt den Deckel, nicht die Zahl."
     *
     * Asserted on **both** halves — the echoed `limit` and the number of rows
     * actually delivered. A server that echoed the ceiling and still sent
     * everything would pass an assertion on either one alone.
     */
    it('caps a page size out of the address bar instead of obeying it', async () => {
      await seedForms(alpha, FORM_PAGE_SIZE_MAX + 15);

      const page = await fetchPage(adminSession, '?limit=100000');

      expect(page.limit).toBe(FORM_PAGE_SIZE_MAX);
      expect(page.items).toHaveLength(FORM_PAGE_SIZE_MAX);
      expect(page.total).toBe(FORM_PAGE_SIZE_MAX + 15);
    });

    it('refuses a limit that is not a number rather than guessing one', async () => {
      await seedForms(alpha, 3);

      const response = await request(app.server)
        .get(`${apiPath('/forms')}?limit=alle`)
        .set('Cookie', cookieHeader(adminSession));

      expect(response.status).toBe(400);
    });

    /**
     * The other two tiles of the dashboard's KPI row, measured a little more
     * thoroughly than strictly required.
     *
     * The fixture is built so that no reading off the page can produce these
     * numbers by accident: more forms than fit on a page, a minority of them
     * published, and the answers deliberately unevenly distributed. A server
     * that counted its own page would answer 24 / 24 / 0.
     */
    it('counts active forms and answers over the whole list, not the page', async () => {
      const seeded = await seedForms(alpha, 30);
      // Seven published — the rest stay drafts.
      await app.prisma.form.updateMany({
        where: { id: { in: seeded.slice(0, 7) } },
        data: { status: 'active' },
      });
      // Five answers, all on one form, so „gesamt" cannot be „eine je Karte".
      const version = await app.prisma.formVersion.create({
        data: {
          tenantId: alpha.id,
          formId: seeded[0] ?? '',
          version: 1,
          schema: definition(),
        },
      });
      await app.prisma.response.createMany({
        data: Array.from({ length: 5 }, () => ({
          tenantId: alpha.id,
          formId: seeded[0] ?? '',
          formVersionId: version.id,
          answers: {},
        })),
      });

      const page = await fetchPage(adminSession, '?limit=10');

      expect(page.items).toHaveLength(10);
      expect(page.total).toBe(30);
      expect(page.activeTotal).toBe(7);
      expect(page.responseTotal).toBe(5);
    });

    /**
     * …and the three figures narrow **together**. A search that moved `total`
     * while leaving „Aktiv" and „Antworten gesamt" describing the whole organisation
     * would put three numbers on screen that answer three different questions
     * under one heading.
     */
    it('narrows all three figures under a search, not only the total', async () => {
      const seeded = await seedForms(alpha, 20, (index) =>
        index < 4
          ? `Jahrestagung ${String(index)}`
          : `Semester ${String(index)}`,
      );
      await app.prisma.form.updateMany({
        where: { id: { in: seeded.slice(0, 2) } },
        data: { status: 'active' },
      });

      const page = await fetchPage(adminSession, '?q=Jahrestagung');

      expect(page.total).toBe(4);
      expect(page.activeTotal).toBe(2);
      expect(page.responseTotal).toBe(0);
    });

    it('answers an empty page past the end rather than wrapping around', async () => {
      await seedForms(alpha, 5);

      const page = await fetchPage(adminSession, '?limit=5&offset=50');

      expect(page.items).toEqual([]);
      expect(page.total).toBe(5);
      expect(page.offset).toBe(50);
    });
  });

  describe('completeness and overlap over all pages ', () => {
    it('delivers every form exactly once across the pages', async () => {
      const seeded = await seedForms(alpha, 57);

      const { ids, total, pages } = await walkAllPages(adminSession, 10);

      expect(total).toBe(57);
      // More than one page, or this test is about nothing.
      expect(pages).toBeGreaterThan(1);
      // **Vollständigkeit** and **Überschneidungsfreiheit** as two separate
      // assertions: a walk that returned one row twice and dropped another has
      // the right length, and a `Set` comparison alone would forgive it.
      expect(ids).toHaveLength(57);
      expect(new Set(ids).size).toBe(57);
      expect([...ids].sort()).toEqual([...seeded].sort());
    });

    it('keeps the newest-first order across the page boundary', async () => {
      await seedForms(alpha, 30);

      const first = await fetchPage(adminSession, '?limit=10&offset=0');
      const second = await fetchPage(adminSession, '?limit=10&offset=10');

      const lastOfFirst = first.items.at(-1);
      const firstOfSecond = second.items.at(0);
      expect(lastOfFirst).toBeDefined();
      expect(firstOfSecond).toBeDefined();
      // The order is „zuletzt geändert zuerst", so the boundary must not step
      // *forwards* in time.
      expect(
        new Date(firstOfSecond?.updatedAt ?? 0).getTime(),
      ).toBeLessThanOrEqual(new Date(lastOfFirst?.updatedAt ?? 0).getTime());
    });
  });

  describe('the order is stable under ties ', () => {
    /**
     * **The tie is written on purpose.** Two forms saved in the same
     * millisecond are the case the tiebreaker exists for, and hoping for one is
     * not a test — so every row here carries the *same* `updated_at`, which
     * makes `ORDER BY updated_at DESC` alone a partial order over the whole
     * population rather than over an accidental pair.
     *
     * With `LIMIT`/`OFFSET` PostgreSQL answers such a query from a top-N
     * heapsort, and the top 5 of an unordered tie is not a prefix of the top 10:
     * a row can be on page one *and* page two while another is on neither.
     */
    async function seedTiedForms(count: number): Promise<string[]> {
      const ids = await seedForms(alpha, count);
      await app.prisma.$executeRaw`
        UPDATE form SET updated_at = TIMESTAMPTZ '2026-08-01T12:00:00Z'`;
      return ids;
    }

    it('delivers every tied form exactly once across the pages', async () => {
      const seeded = await seedTiedForms(40);

      const { ids, total } = await walkAllPages(adminSession, 5);

      expect(total).toBe(40);
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
      expect([...ids].sort()).toEqual([...seeded].sort());
    });

    /**
     * The same population read twice with **different page sizes**. Under a
     * total order the two sequences are identical; under a partial one they are
     * two different top-N results over the same tie.
     */
    it('answers the same sequence whatever the page size', async () => {
      await seedTiedForms(40);

      const byFive = await walkAllPages(adminSession, 5);
      const byThirteen = await walkAllPages(adminSession, 13);

      expect(byFive.ids).toEqual(byThirteen.ids);
    });
  });

  describe('the boundaries hold per page, not only on the first ', () => {
    /**
     * A member of ALPHA who may build, with **one** form taken away from them —
     * and the taken form deliberately placed **on page two**.
     *
     * Index 30 of a 60-form population read at `limit=25` is on the second
     * page. A revoked form on page *one* would be caught by a filter that runs
     * only on the first query, which is exactly the reproduction the requirement
     * names — so the fixture puts it where that mistake survives.
     */
    async function revokedOnSecondPage(): Promise<{
      session: string;
      hiddenId: string;
      seeded: string[];
    }> {
      const seeded = await seedForms(alpha, 60);
      const member = await createRestrictedMember(app.prisma, alpha, {
        email: 'bearbeiter@alpha.example',
        groupName: 'bearbeiter',
        permissions: { canBuild: true, canViewResponses: true },
      });
      const hiddenId = seeded[30];
      expect(hiddenId).toBeDefined();
      await app.prisma.formPermission.create({
        data: {
          tenantId: alpha.id,
          // Checked above; a non-null assertion in a test is a claim the test
          // cannot check, so the value is read out of the array again.
          formId: seeded[30] ?? '',
          userId: member.id,
          accessRevoked: true,
        },
      });
      return {
        session: await openSession(app, member.id, alpha.id),
        hiddenId: seeded[30] ?? '',
        seeded,
      };
    }

    it('never shows a revoked form on any page, and does not count it', async () => {
      const { session, hiddenId, seeded } = await revokedOnSecondPage();

      const { ids, total } = await walkAllPages(session, 25);

      // Absent from **every** page — searched over the whole walk, not over the
      // first payload.
      expect(ids).not.toContain(hiddenId);
      // …and absent from the count as well: a `total` that includes a form the
      // caller can never reach makes the last page short forever and the
      // dashboard's figure a lie.
      expect(total).toBe(seeded.length - 1);
      expect(ids).toHaveLength(seeded.length - 1);
      expect(new Set(ids).size).toBe(seeded.length - 1);
    });

    /**
     * The same form, asked for **by id**. `?id=…` narrows the same statement,
     * so the restriction has to survive the narrowing — a second code path here
     * would be the „zweiter Schreibpfad erbt den Filter des ersten nicht" rule,
     * in read form.
     */
    it('answers an empty page for a revoked form asked for by id', async () => {
      const { session, hiddenId } = await revokedOnSecondPage();

      const page = await fetchPage(session, `?id=${hiddenId}`);

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });

    it('answers the one form for an id the caller may see', async () => {
      const { session, seeded } = await revokedOnSecondPage();
      const visible = seeded[31] ?? '';

      const page = await fetchPage(session, `?id=${visible}`);

      expect(page.items.map((form) => form.id)).toEqual([visible]);
      expect(page.total).toBe(1);
    });

    /**
     * **`?id=` does not step around the organisation either.** The narrowing parameter
     * takes an id the caller may know from anywhere — a bookmark, a colleague,
     * a guess — so „ich nenne die id" must not be a way past the tenant.
     *
     * The counterpart of `GET /forms/:id` answering 404 for a foreign form
     * ; here the honest answer is an empty page, because this is a list.
     */
    it('answers an empty page for a form of another organisation asked for by id', async () => {
      await seedForms(alpha, 5);
      const betaIds = await seedForms(beta, 5);

      const page = await fetchPage(adminSession, `?id=${betaIds[0] ?? ''}`);

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });

    /**
     * The tenant boundary, per page. BETA's forms outnumber one page of ALPHA's
     * on purpose: a suite where each organisation owns fewer forms than fit on a page
     * cannot tell „die Query ist tenant-gebunden" from „es gab nur diese".
     */
    it('never shows a form of another organisation on any page', async () => {
      await seedForms(alpha, 30);
      const betaIds = await seedForms(beta, 40);

      const { ids, total } = await walkAllPages(adminSession, 7);

      expect(total).toBe(30);
      for (const foreign of betaIds) {
        expect(ids).not.toContain(foreign);
      }
    });
  });

  describe('the search is server-side ', () => {
    /**
     * The hit is on **page three** of the unfiltered list, so a client-side
     * filter over the loaded page would answer „keine Treffer". That placement
     * is the test; a search whose hit is on page one passes with the defect in
     * place.
     */
    it('finds a form that no loaded page holds', async () => {
      await seedForms(alpha, 60, (index) =>
        index === 55 ? 'Sterbefallmeldung' : `Formular ${String(index)}`,
      );

      const page = await fetchPage(
        adminSession,
        '?q=Sterbefallmeldung&limit=24',
      );

      expect(page.items.map((form) => form.title)).toEqual([
        'Sterbefallmeldung',
      ]);
      // The **filtered** total, not the organisation's — the figure the dashboard shows
      // while a search is active.
      expect(page.total).toBe(1);
    });

    /**
     * **Regression, review finding of this package: the term is escaped.**
     *
     * `contains` compiles to `ILIKE '%' || $1 || '%'` and Prisma inserts the
     * term **verbatim**, so `LIKE`'s wildcards used to travel with it. Both
     * halves are asserted, because they fail differently:
     *
     * 1. `%` alone matched **every** form of the organisation — the dashboard said
     *    „30 Treffer für „%"" and showed the whole list under a search;
     * 2. a term with a `%` in it matched titles that merely share its literal
     *    parts — „50%" found „500 Jahre", a wrong answer to a real question.
     *
     * *Reproduction:* dropping `escapeLikeTerm` from `searchFilter` turns both
     * of these red and nothing else in this file.
     */
    it('treats % and _ as characters, not as wildcards', async () => {
      await seedForms(alpha, 30, (index) =>
        index === 20 ? 'Beitrag 50% ermäßigt' : `Formular ${String(index)}`,
      );

      // 1. The wildcard on its own selects nothing, because no title contains
      //    a literal per-cent sign except the one.
      const wildcard = await fetchPage(adminSession, '?q=%25');
      expect(wildcard.total).toBe(1);
      expect(wildcard.items.map((entry) => entry.title)).toEqual([
        'Beitrag 50% ermäßigt',
      ]);

      // 2. `_` likewise: it must not stand for „any character".
      const underscore = await fetchPage(adminSession, '?q=Formular_1');
      expect(underscore.total).toBe(0);

      // …while the literal term around the per-cent sign still finds its form.
      const literal = await fetchPage(adminSession, '?q=50%25%20erm');
      expect(literal.items.map((entry) => entry.title)).toEqual([
        'Beitrag 50% ermäßigt',
      ]);
    });

    /**
     * **Regression, review finding of this package: an absurd offset is a 400,
     * not a 500.**
     *
     * Nineteen digits pass the digit regex and `Number.isInteger`; without the
     * bound in `formListQuerySchema` the value reached Prisma's `skip`, did not
     * fit a 64-bit signed integer, and left the controller as a server error.
     */
    it('refuses an offset too large to represent instead of failing at the database', async () => {
      await seedForms(alpha, 3);

      const response = await request(app.server)
        .get(`${apiPath('/forms')}?offset=10000000000000000000`)
        .set('Cookie', cookieHeader(adminSession));

      expect(response.status).toBe(400);
    });

    it('matches without regard to case', async () => {
      await seedForms(alpha, 40, (index) =>
        index === 33 ? 'Bestandsmeldung' : `Formular ${String(index)}`,
      );

      const page = await fetchPage(adminSession, '?q=bestandsMELD');

      expect(page.items.map((form) => form.title)).toEqual(['Bestandsmeldung']);
    });

    /**
     * A search that pages. Without it the search would be „server-side" only up
     * to the first 24 hits, which is the same defect one page further along.
     */
    it('pages the hits and counts only them', async () => {
      await seedForms(alpha, 60, (index) =>
        index % 2 === 0
          ? `Jahrestagung ${String(index)}`
          : `Semester ${String(index)}`,
      );

      const { ids, total } = await walkAllPages(
        adminSession,
        10,
        '&q=Jahrestagung',
      );

      expect(total).toBe(30);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
    });

    /**
     * The search runs **inside** the restriction, not next to it. A search that
     * built its own statement would be the second read path that forgot the
     * fourth link — and it would hand an editor the one form they were
     * locked out of, by name.
     */
    it('does not surface a revoked form through the search', async () => {
      const seeded = await seedForms(alpha, 40, (index) =>
        index === 30 ? 'Geheime Anmeldung' : `Formular ${String(index)}`,
      );
      const member = await createRestrictedMember(app.prisma, alpha, {
        email: 'bearbeiter2@alpha.example',
        groupName: 'bearbeiter2',
        permissions: { canBuild: true },
      });
      await app.prisma.formPermission.create({
        data: {
          tenantId: alpha.id,
          formId: seeded[30] ?? '',
          userId: member.id,
          accessRevoked: true,
        },
      });
      const session = await openSession(app, member.id, alpha.id);

      const page = await fetchPage(session, '?q=Geheime');

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });

    /**
     * The trash, under the search. `deletedAt: null` lives in the same
     * `where` as everything else — this is the assertion that says so, rather
     * than a comment claiming it.
     */
    it('does not surface a deleted form through the search', async () => {
      const seeded = await seedForms(alpha, 10, (index) =>
        index === 4 ? 'Weggeworfen' : `Formular ${String(index)}`,
      );
      await app.prisma.form.update({
        where: { id: seeded[4] ?? '' },
        data: { deletedAt: new Date() },
      });

      const page = await fetchPage(adminSession, '?q=Weggeworfen');

      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });
});
