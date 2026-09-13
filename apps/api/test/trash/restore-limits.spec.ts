import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESTORE_REFUSAL_MESSAGES } from '@formsache/shared';

import { RESPONSE_NOT_FOUND_MESSAGE } from '../../src/trash/trash.service';
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
import { authedMutation, openSession } from '../support/http';

/**
 * **Restoring can fail, and says why** .
 *
 * Two earlier promises meet here and both have a price the requirement names
 * outright: an answer in the trash occupies no Veranstaltungsplatz and does not count against the Antwortlimit. Both rooms can
 * be taken while it is away — and then the restore has to say so, and the
 * answer has to **stay** in the trash.
 *
 * ## The lock, and why it is measured rather than reasoned about
 *
 * The note on `heldSeats` (`public/event-seats.ts`) argued for two milestones
 * that its difference could only come out too *small* — „solange nichts
 * wiederherstellt". This suite builds the route that restores, so that sentence
 * is now a claim about code that exists. `ScopedFormDelegate.restoreResponse`
 * takes `lockForm`, the **same** `SELECT … FOR UPDATE` on the **same** `form`
 * row the submission and the correction take, before it counts anything.
 *
 * A sequential test passes without that lock (the two cases at the top of this
 * file do). The evidence is the parallel one at the bottom, and it is
 * deliberately *mixed* — restores and fresh submissions competing for the same
 * seats — because that is the pair of write paths the single lock order exists
 * for; two restores against each other would leave „hat der Sperrpfad des
 * Absendens etwas davon gemerkt?" untested.
 *
 * *Reproductions, measured on 2026-08-03 — see the individual cases.*
 *
 * **`TRUST_PROXY_HOPS: 1` plus a distinct address per public request**: the
 * submit route allows 30 a minute per address, and the parallel case fires
 * more than that in one second. Same reasoning as `event-limit.spec.ts`.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff700-0000-7000-8000-0000000000a0';
const EVENTS = '019ff700-0000-7000-8000-000000000001';
const NAME = '019ff700-0000-7000-8000-000000000002';

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

/** One Veranstaltung with an Obergrenze, plus a plain text question. */
function definition(capacity: number | null) {
  return definitionOf([
    {
      key: 'konzert',
      label: 'Konzert',
      when: 'Fr, 19:00',
      capacity,
      showRemaining: false,
    },
  ]);
}

/**
 * **Two Veranstaltungen, in the order the form defines them** — the fixture the
 * „welche Position nennt die Absage?" case needs (a review finding).
 *
 * `empfang` is deliberately the **second** one and the one that fills up: an
 * implementation that named the first row it happened to read would pass a
 * one-event form and a two-event form whose first position is the full one.
 */
function twoEvents(konzert: number, empfang: number) {
  return definitionOf([
    {
      key: 'konzert',
      label: 'Konzert',
      when: 'Fr, 19:00',
      capacity: konzert,
      showRemaining: false,
    },
    {
      key: 'empfang',
      label: 'Empfang',
      when: 'Sa, 20:00',
      capacity: empfang,
      showRemaining: false,
    },
  ]);
}

function definitionOf(events: readonly Record<string, unknown>[]) {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        description: null,
        questions: [
          {
            id: EVENTS,
            type: 'event',
            label: 'Veranstaltungen',
            hint: null,
            required: false,
            width: 'full',
            events,
          },
          {
            id: NAME,
            type: 'text',
            label: 'Name',
            hint: null,
            required: false,
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

describe('Wiederherstellen an seinen Grenzen ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let admin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });
    // The server is put on a port **once**: supertest would otherwise start and
    // stop one per request, and the first of twenty in flight to finish would
    // pull the listener out from under the rest.
    await new Promise<void>((resolve) => {
      testApp.server.listen(0, resolve);
    });

    tenant = await createTenant(testApp.prisma, 'RESTORE');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    admin = await openSession(testApp, user.id, tenant.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  async function publishedForm(
    title: string,
    capacity: number | null,
    // The `definition` override is what lets one case carry two Veranstaltungen
    // without a second copy of the four routes below.
    options: { readonly definition?: object } = {},
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(admin))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin))
      .send({
        title,
        definition: options.definition ?? definition(capacity),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(admin))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** Writes a form's Antwortlimit through the real settings route. */
  async function limitTo(formId: string, maxResponses: number): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });

    const written = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(admin))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { maxResponsesEnabled: true, maxResponses },
        revision: form.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(written.status).toBe(200);
  }

  /** One registration for the Konzert alone; returns the answer's id. */
  async function register(
    slug: string,
    seats: number | null,
  ): Promise<{ id: string; status: number }> {
    return registerSeats(slug, seats === null ? null : { konzert: seats });
  }

  /** The same, for a form with more than one Veranstaltung. */
  async function registerSeats(
    slug: string,
    seats: Record<string, number> | null,
  ): Promise<{ id: string; status: number }> {
    const sent = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          ...(seats === null ? {} : { [EVENTS]: { seats } }),
          [NAME]: 'Teilnehmer',
        },
      });
    if (sent.status !== 200) {
      return { id: '', status: sent.status };
    }
    const row = await app().prisma.response.findFirstOrThrow({
      where: { form: { publicSlug: slug } },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });
    return { id: row.id, status: sent.status };
  }

  function remove(formId: string, responseId: string) {
    return request(app().server)
      .delete(apiPath(`/forms/${formId}/responses/${responseId}`))
      .set(authedMutation(admin));
  }

  function restore(formId: string, responseId: string) {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/responses/${responseId}/restore`))
      .set(authedMutation(admin));
  }

  /** Whether the answer is still in the trash. */
  async function isDeleted(responseId: string): Promise<boolean> {
    const row = await app().prisma.response.findUniqueOrThrow({
      where: { id: responseId },
      select: { deletedAt: true },
    });
    return row.deletedAt !== null;
  }

  /** The seats one Veranstaltung holds — past the trash, like the enforcement. */
  async function seatsTaken(
    formId: string,
    eventKey = 'konzert',
  ): Promise<number> {
    const rows = await app().prisma.eventRegistration.findMany({
      where: { formId, eventKey, response: { deletedAt: null } },
      select: { seats: true },
    });
    return rows.reduce((sum, row) => sum + row.seats, 0);
  }

  async function liveResponses(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId, deletedAt: null } });
  }

  /**
   * Blocks until some statement of this database is **waiting for a lock**.
   *
   * The one thing a staged race may not do is sleep for a plausible number of
   * milliseconds: on a loaded machine that is a test which passes because it
   * guessed right. PostgreSQL says outright who is waiting, so the wait is on
   * the state itself.
   */
  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await app().prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND state = 'active'`;
      if (Number(rows[0]?.waiting ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no statement ever waited for a lock');
  }

  /* ---- the Antwortlimit ------------------------------------------------ */

  /**
   * **the evidence** — limit full → refused, and the answer stays put.
   *
   * *Reproduction, measured on 2026-08-03:* disabling the `maxResponsesEnabled`
   * branch of `TrashService.verdict` makes this case answer **204 where 409 is
   * asserted** — the third answer joins a form limited to two, i.e. the
   * Antwortlimit walked around through the trash, which is exactly the
   * „neuer Ausgang" the requirement warns about. **Exactly this case red, the
   * other five in the file green** — the seat checks notice nothing, which is
   * why the two limits are asserted separately.
   */
  it('refuses a restore that would put the form over its Antwortlimit', async () => {
    const form = await publishedForm('Antwortlimit', null);
    await limitTo(form.id, 2);

    const first = await register(form.slug, null);
    const second = await register(form.slug, null);
    expect(second.status).toBe(200);

    // One goes away, so the third fits — that is the freeing half of the requirement.
    expect((await remove(form.id, first.id)).status).toBe(204);
    const third = await register(form.slug, null);
    expect(third.status).toBe(200);
    expect(await liveResponses(form.id)).toBe(2);

    const back = await restore(form.id, first.id);

    expect(back.status).toBe(409);
    expect(back.body).toStrictEqual({
      message: RESTORE_REFUSAL_MESSAGES.limit_reached,
      reason: 'limit_reached',
    });
    // The load-bearing half: nothing was written and it is still recoverable.
    expect(await isDeleted(first.id)).toBe(true);
    expect(await liveResponses(form.id)).toBe(2);
  }, 90_000);

  it('lets the same answer back in once there is room again', async () => {
    const form = await publishedForm('Wieder Platz', null);
    await limitTo(form.id, 2);

    const first = await register(form.slug, null);
    await register(form.slug, null);
    await remove(form.id, first.id);
    const third = await register(form.slug, null);

    // The third leaves; now the first fits again.
    await remove(form.id, third.id);
    expect((await restore(form.id, first.id)).status).toBe(204);

    expect(await isDeleted(first.id)).toBe(false);
    expect(await liveResponses(form.id)).toBe(2);
  }, 90_000);

  /* ---- the full Veranstaltung ------------------------------------------ */

  /**
   * **the evidence** — the same for a full Veranstaltung, with the position
   * machine-readable.
   *
   * *Reproduction, measured on 2026-08-03:* disabling the `exhaustedPosition`
   * branch of `TrashService.verdict` turns **four** cases red — this one and
   * the two seat cases below answer 204 where 409 is asserted, and the parallel
   * case at the bottom accepted **18 of the twenty**, i.e. 54 seats in a hall
   * for 30. The two Antwortlimit cases above stayed **green**, which is why the
   * two limits are asserted separately rather than as one „wird abgelehnt".
   */
  it('refuses a restore into a Veranstaltung that filled up meanwhile', async () => {
    const form = await publishedForm('Ausgebucht', 10);

    const early = await register(form.slug, 6);
    expect(early.status).toBe(200);
    expect(await seatsTaken(form.id)).toBe(6);

    // The trash frees the six at once  …
    expect((await remove(form.id, early.id)).status).toBe(204);
    expect(await seatsTaken(form.id)).toBe(0);

    // … and somebody else takes eight of the ten.
    expect((await register(form.slug, 8)).status).toBe(200);
    expect(await seatsTaken(form.id)).toBe(8);

    const back = await restore(form.id, early.id);

    expect(back.status).toBe(409);
    expect(back.body).toStrictEqual({
      message: RESTORE_REFUSAL_MESSAGES.event_full,
      reason: 'event_full',
      // Keys, never labels — the client resolves them against the definition
      // it is already rendering.
      position: { questionId: EVENTS, eventKey: 'konzert' },
    });
    expect(await isDeleted(early.id)).toBe(true);
    expect(await seatsTaken(form.id)).toBe(8);
  }, 90_000);

  /**
   * The seats that come back are the **registration rows**, not a re-reading of
   * the answer document — and the difference shows on a form whose Obergrenze
   * the organisation has since *raised*: the restore has to be judged against today's
   * limit, like every other write path (`withLiveCapacity`).
   */
  it('judges the restore against the Obergrenze the form carries today', async () => {
    const form = await publishedForm('Nachträglich erweitert', 10);
    const early = await register(form.slug, 6);
    await remove(form.id, early.id);
    expect((await register(form.slug, 8)).status).toBe(200);

    // Refused at 10 …
    expect((await restore(form.id, early.id)).status).toBe(409);

    // … and accepted once the hall is bigger.
    const current = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { title: true, revision: true },
    });
    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin))
      .send({
        title: current.title,
        definition: definition(20),
        revision: current.revision,
      });
    expect(saved.status).toBe(200);
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(admin))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    expect((await restore(form.id, early.id)).status).toBe(204);
    expect(await seatsTaken(form.id)).toBe(14);
  }, 90_000);

  /**
   * A restore is **not** a correction: it asks for its full seat count, not for
   * a difference.
   *
   * The answer is deleted while `takenSeats` is read, so its own rows are not
   * in that sum — subtracting them (as `seatsBeyond` does on the Bearbeiten
   * path) would let a registration for six back into a hall with two seats
   * left. Measured as the exact boundary: six wanted, four free → refused;
   * with six free → accepted.
   */
  it('asks for the whole registration rather than a difference', async () => {
    const form = await publishedForm('Ganze Anmeldung', 10);
    const early = await register(form.slug, 6);
    await remove(form.id, early.id);

    const other = await register(form.slug, 6);
    expect(other.status).toBe(200);
    // Four free, six wanted.
    expect((await restore(form.id, early.id)).status).toBe(409);

    await remove(form.id, other.id);
    expect((await restore(form.id, early.id)).status).toBe(204);
    expect(await seatsTaken(form.id)).toBe(6);
  }, 90_000);

  /* ---- more than one Veranstaltung ------------------------------------- */

  /**
   * **A form with two Veranstaltungen: one full, one free** (a review
   * finding).
   *
   * Every seat case above has exactly one position, so „welche Position nennt
   * die Absage?" was never asked — and could not be answered, because
   * `registeredSeats` read its rows without an `ORDER BY` while
   * `exhaustedPosition` promises „die erste volle in der Reihenfolge der
   * Definition". Here the full one is the **second** in the definition, so
   * naming it is a statement and not a coincidence, and the free one has to
   * come through untouched.
   *
   * Both positions are asserted on, before and after: a refusal that quietly
   * wrote the free half would leave the answer half restored, which is the
   * state no route can undo.
   */
  it('names the full Veranstaltung and leaves the free one alone', async () => {
    const form = await publishedForm('Zwei Veranstaltungen', null, {
      definition: twoEvents(10, 4),
    });

    const early = await registerSeats(form.slug, {
      konzert: 3,
      empfang: 3,
    });
    expect(early.status).toBe(200);
    expect((await remove(form.id, early.id)).status).toBe(204);

    // Somebody else fills the Empfang and takes two of the ten Konzert.
    const other = await registerSeats(form.slug, {
      konzert: 2,
      empfang: 3,
    });
    expect(other.status).toBe(200);
    expect(await seatsTaken(form.id, 'konzert')).toBe(2);
    expect(await seatsTaken(form.id, 'empfang')).toBe(3);

    const back = await restore(form.id, early.id);

    expect(back.status).toBe(409);
    expect(back.body).toStrictEqual({
      message: RESTORE_REFUSAL_MESSAGES.event_full,
      reason: 'event_full',
      // The Empfang is full (3 + 3 > 4); the Konzert is not (2 + 3 ≤ 10).
      position: { questionId: EVENTS, eventKey: 'empfang' },
    });
    expect(await isDeleted(early.id)).toBe(true);
    // **Both** positions untouched — half a restore is the state nobody can undo.
    expect(await seatsTaken(form.id, 'konzert')).toBe(2);
    expect(await seatsTaken(form.id, 'empfang')).toBe(3);

    // …and once the Empfang has room again, the whole registration comes back.
    expect((await remove(form.id, other.id)).status).toBe(204);
    expect((await restore(form.id, early.id)).status).toBe(204);
    expect(await seatsTaken(form.id, 'konzert')).toBe(3);
    expect(await seatsTaken(form.id, 'empfang')).toBe(3);
  }, 120_000);

  /**
   * **…and when both are full, the order of the definition decides.**
   *
   * This is the case that pins the ordering rather than merely benefitting from
   * it. `registeredSeats` returns its rows by `(question_id, event_key)`, so
   * `empfang` arrives **first**; the definition names `konzert` first. With
   * both full, the two orders disagree and the message has to follow the one the
   * editor is looking at on screen.
   *
   * *Reproduction, measured on 2026-08-03:* dropping `inDefinitionOrder` from
   * `TrashService.verdict` names **`empfang`** here — the second Veranstaltung
   * of the form, reported as „die erste volle" — and leaves every other case in
   * this file green.
   */
  it('names the first full Veranstaltung of the definition, not of the rows', async () => {
    const form = await publishedForm('Beide voll', null, {
      definition: twoEvents(4, 4),
    });

    const early = await registerSeats(form.slug, {
      konzert: 3,
      empfang: 3,
    });
    expect((await remove(form.id, early.id)).status).toBe(204);
    expect(
      (await registerSeats(form.slug, { konzert: 3, empfang: 3 })).status,
    ).toBe(200);

    const back = await restore(form.id, early.id);

    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({
      reason: 'event_full',
      position: { questionId: EVENTS, eventKey: 'konzert' },
    });
    expect(await isDeleted(early.id)).toBe(true);
  }, 120_000);

  /* ---- the form underneath --------------------------------------------- */

  /**
   * **A restore must not land in a form that was deleted meanwhile** (a
   * security review finding).
   *
   * `findDeletedResponse` runs *outside* the transaction and does filter
   * `form.deleted_at`; `softDelete` on the form takes no lock at all. So the
   * form can go into the trash inside that window, and the `updateMany`
   * that clears `response.deleted_at` has nothing to object to — its `where`
   * names the answer, the form id, the organisation and `deleted_at`, and none of those
   * is a statement about the *form's* state.
   *
   * The outcome was a 204 for an answer that then lives in a deleted form:
   * listed in **neither** section of the trash (the answers section leaves
   * out the answers of deleted forms, and the forms section lists forms), while
   * `takenSeats` counts its places again — and nobody can free them until
   * somebody restores the form.
   *
   * ## How the window is staged rather than raced
   *
   * A second transaction takes the **same** `form` row lock the restore takes,
   * deletes the form under it and holds it. The restore then reads the answer
   * (the deletion is not committed, so it sees a live form), enters its
   * transaction and stops at `lockForm`. The blocker commits, the restore
   * proceeds — and now has to notice, under the lock it just got, that the form
   * has gone. Deterministic: nothing is timed, the lock does the sequencing and
   * `pg_stat_activity` is what says the restore has arrived at it.
   *
   * *Reproduction, measured on 2026-08-03:* removing the `form.deletedAt` read
   * from `ScopedFormDelegate.restoreResponse` answers **204** here and leaves
   * `deleted_at` at `NULL` — the answer in the form nobody can reach.
   */
  it('refuses a restore whose form went into the Papierkorb under the lock', async () => {
    const form = await publishedForm('Formular unter dem Lock weg', 10);
    const answer = await register(form.slug, 3);
    expect((await remove(form.id, answer.id)).status).toBe(204);

    /** Released once the restore is measurably waiting for the lock. */
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /** Resolved once the blocker *holds* the row — never a sleep. */
    let acquired: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const blocker = app().prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "form" WHERE "id" = ${form.id}::uuid FOR UPDATE`;
        // The delete this restore is racing — uncommitted until `release()`.
        await tx.$executeRaw`UPDATE "form" SET "deleted_at" = now() WHERE "id" = ${form.id}::uuid`;
        acquired();
        await held;
      },
      { timeout: 30_000 },
    );
    await locked;

    // `.then` is what *sends* a supertest request; holding the `Test` object
    // would stage a race against a request that never left.
    const restoring = restore(form.id, answer.id).then((sent) => sent);
    // Waits for the restore to be *in* its transaction and blocked on the row,
    // rather than for a number of milliseconds.
    await waitForLockWaiter();
    release();
    await blocker;

    const back = await restoring;

    expect(back.status).toBe(404);
    expect(back.body).toMatchObject({ message: RESPONSE_NOT_FOUND_MESSAGE });
    // The load-bearing half: it is still in the trash, so restoring the
    // form brings it back into a section where „wiederherstellen" means
    // something.
    expect(await isDeleted(answer.id)).toBe(true);
    expect(await seatsTaken(form.id)).toBe(0);

    await app().prisma.form.update({
      where: { id: form.id },
      data: { deletedAt: null },
    });
  }, 120_000);

  /* ---- the lock -------------------------------------------------------- */

  /**
   * **The evidence for `lockForm` on the restore path** — the case a sequential
   * run cannot produce.
   *
   * Ten deleted registrations of three seats each and ten fresh submissions of
   * three, all fired at once against an empty Obergrenze of 30: exactly ten of
   * the twenty can fit, whichever they are, and the sum has to be exactly 30.
   *
   * The two sides are the point. Restores serialise against *submissions*
   * because both take the same lock on the same `form` row — one lock order,
   * no deadlock — and this is what a review asked for when it said the
   * `heldSeats` argument holds „solange nichts wiederherstellt".
   *
   * *Reproduction, measured on 2026-08-03:* removing `await lockForm(tx, …)`
   * from `ScopedFormDelegate.restoreResponse` — leaving the count, the sum and
   * the verdict exactly as they are — accepted **14, 12 and 11 of the twenty**
   * across three runs, i.e. **42, 36 and 33 seats in a hall for 30**. The
   * overrun varies because the interleaving does; that it *never* stayed at ten
   * is the point. Every sequential case in this file stayed green under the
   * same build (checked on „refuses a restore that would put the form over its
   * Antwortlimit").
   */
  it('never exceeds the Obergrenze when restores and submissions arrive together', async () => {
    const form = await publishedForm('Gleichzeitig zurück', 30);

    const deleted: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      // Sequentially: this is the *starting state*, not the measurement.
      const answer = await register(form.slug, 3);
      expect(answer.status).toBe(200);
      expect((await remove(form.id, answer.id)).status).toBe(204);
      deleted.push(answer.id);
    }
    expect(await seatsTaken(form.id)).toBe(0);

    const attempts = await Promise.all([
      ...deleted.map((id) => restore(form.id, id)),
      ...Array.from({ length: 10 }, () =>
        request(app().server)
          .post(apiPath(`/public/forms/${form.slug}/responses`))
          .set('X-Forwarded-For', ownAddress())
          .send({
            answers: {
              [EVENTS]: { seats: { konzert: 3 } },
              [NAME]: 'Teilnehmer',
            },
          }),
      ),
    ]);

    const accepted = attempts.filter(
      (one) => one.status === 204 || one.status === 200,
    );
    const refused = attempts.filter((one) => one.status === 409);

    expect(accepted).toHaveLength(10);
    expect(refused).toHaveLength(10);
    expect(
      new Set(refused.map((one) => (one.body as { reason: string }).reason)),
    ).toStrictEqual(new Set(['event_full']));

    // The seats are the claim; the statuses are how it was reported.
    expect(await seatsTaken(form.id)).toBe(30);
  }, 180_000);
});
