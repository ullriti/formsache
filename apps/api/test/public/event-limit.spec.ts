import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCESS_PROOF_HEADER } from '../../src/public/public-forms.controller';
import { SUBMISSION_REFUSAL_MESSAGES } from '../../src/public/public-forms.service';
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
 * **The participant limit of a Veranstaltung** (the specification
 * no. 51–53) — the requirement that is the trigger of this whole project: „ein
 * Zahlenfeld kann eine Anmeldung entgegennehmen, aber es kann nicht *nein*
 * sagen."
 *
 * ## Why the tests come in a pair
 *
 * **A sequential run passes the wrong build.** `SUM` and then `INSERT` without
 * a lock is correct one submission at a time and loses the moment two arrive
 * together — every one of them reads a total none of the others has committed
 * yet, and every one of them concludes there is room. The two cases below
 * therefore stand next to each other on purpose: the first is written to be
 * green under the naive implementation, the second is the assertion.
 *
 * Measured on 2026-08-01 by removing `lockForm` from the transaction: the
 * sequential case below **stayed green**, and the parallel one accepted **14 to
 * 15 of the twenty** registrations across three runs — **42 to 45 people in a
 * hall that holds 30**. The same shape was once measured for the Antwortlimit (15
 * rows against a limit of 10).
 *
 * ## Two things about the setup, both deliberate
 *
 * **`TRUST_PROXY_HOPS: 1` plus a distinct `X-Forwarded-For` per request** — the
 * public submit route allows 30 submissions a minute per address, and the
 * parallel case fires twenty. Without separate addresses this file would be
 * measuring the rate limit. Same reasoning as `submission-gate.spec.ts`.
 *
 * **No session on the submitting side.** A suite that logged in first would be
 * proving that an editor can register; the editor here only builds the fixture
 * through the real routes.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff500-0000-7000-8000-0000000000a0';
const EVENTS = '019ff500-0000-7000-8000-000000000001';
const MAIL = '019ff500-0000-7000-8000-000000000002';
/** The **second** Veranstaltungsfrage — see „across two questions“ below. */
const SECOND_EVENTS = '019ff500-0000-7000-8000-000000000003';

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

/**
 * One Veranstaltungsfrage with a bounded and an unbounded event, plus an e-mail
 * question so the mail side has something to queue for.
 */
function definition(capacity: number) {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Veranstaltungsanmeldung',
        description: null,
        questions: [
          {
            id: EVENTS,
            type: 'event',
            label: 'Veranstaltungen',
            hint: null,
            required: false,
            width: 'full',
            events: [
              {
                key: 'konzert',
                label: 'Konzert',
                when: 'Fr, 19:00',
                capacity,
                showRemaining: false,
              },
              {
                key: 'ausflug',
                label: 'Ausflug',
                when: null,
                capacity: null,
                showRemaining: false,
              },
            ],
          },
          {
            id: MAIL,
            type: 'email',
            label: 'E-Mail',
            hint: null,
            required: false,
            width: 'full',
          },
        ],
      },
    ],
  };
}

/** The questions of the fixture's single page, as plain records. */
function page0Questions(base: ReturnType<typeof definition>) {
  return base.pages[0]?.questions ?? [];
}

/** The fixture with the Konzert explicitly **unbounded**. */
function unboundedDefinition() {
  const base = definition(1);
  const page = base.pages[0];
  return {
    pages: [
      {
        ...page,
        questions: (page?.questions ?? []).map((question) =>
          (question as { type: string }).type === 'event'
            ? {
                ...question,
                events: (
                  question as { events: { capacity: number | null }[] }
                ).events.map((entry) => ({ ...entry, capacity: null })),
              }
            : question,
        ),
      },
    ],
  };
}

describe('the Teilnehmerlimit of a Veranstaltung ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });
    /*
     * The server is put on a port **once, here** — supertest would otherwise
     * start and stop one per request, and the first of twenty in flight to
     * finish would pull the listener out from under the rest. The parallel case
     * cannot be run any other way (`submission-gate.spec.ts` says the same).
     */
    await new Promise<void>((resolve) => {
      testApp.server.listen(0, resolve);
    });

    tenant = await createTenant(testApp.prisma, 'EVENT');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A published form with a Veranstaltung of the given Obergrenze. */
  async function publishedForm(
    title: string,
    capacity: number,
  ): Promise<{ id: string; slug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(editor))
      .send({ title });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(editor))
      .send({
        title,
        definition: definition(capacity),
        revision: form.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** Writes a form's settings through the real route. */
  async function configure(
    formId: string,
    overridden: Record<string, boolean>,
    values: Record<string, unknown>,
  ): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });

    const response = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(editor))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
          ...overridden,
        },
        values,
        revision: form.settingsRevision,
        tenantRevision: tenantRow.formDefaultsRevision,
      });
    expect(response.status).toBe(200);
  }

  async function addNotification(formId: string): Promise<void> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(editor))
      .send({
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        // A fixed office address, **not** the participant's own: a `question`
        // recipient is gated by the `copyToSubmitter` switch, which is off by
        // default — the positive control below would then read
        // zero for the wrong reason.
        recipients: [
          { kind: 'literal', address: 'geschaeftsstelle@example.org' },
        ],
        replyTo: null,
      });
    expect(created.status).toBe(201);
  }

  /**
   * Saves a new definition on an existing form and publishes it again.
   *
   * Through the real routes rather than through Prisma: what the limit reads is
   * the **published** version, and a fixture that wrote `draft_schema` would be
   * measuring a document the enforcement never sees.
   */
  async function republish(
    formId: string,
    nextDefinition: unknown,
  ): Promise<void> {
    const current = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { title: true, revision: true },
    });
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(editor))
      .send({
        title: current.title,
        definition: nextDefinition,
        revision: current.revision,
      });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${formId}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);
  }

  /**
   * The same form with a **second** Veranstaltungsfrage after the first.
   *
   * Only the second one is bounded, so „the first full position in form
   * order“ has to reach past a question that can never be full.
   */
  async function publishedTwoQuestionForm(
    title: string,
    capacity: { first: number; second: number },
  ): Promise<{ id: string; slug: string }> {
    const form = await publishedForm(title, capacity.first);
    const base = definition(capacity.first);
    const page = base.pages[0];
    await republish(form.id, {
      pages: [
        {
          ...page,
          questions: [
            ...page0Questions(base),
            {
              id: SECOND_EVENTS,
              type: 'event',
              label: 'Workshops',
              hint: null,
              required: false,
              width: 'full',
              events: [
                {
                  key: 'workshop',
                  label: 'Workshop',
                  when: null,
                  capacity: capacity.second,
                  showRemaining: false,
                },
              ],
            },
          ],
        },
      ],
    });
    return form;
  }

  /** One registration naming a seat in **both** Veranstaltungsfragen. */
  async function registerBoth(
    slug: string,
    seats: { first: number; second: number },
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [EVENTS]: { seats: { konzert: seats.first } },
          [SECOND_EVENTS]: { seats: { workshop: seats.second } },
          [MAIL]: 'teilnehmer@example.org',
        },
      });
  }

  /** Lowers the Obergrenze of the Konzert on an already published form. */
  async function lowerCapacity(
    formId: string,
    capacity: number,
  ): Promise<void> {
    await republish(formId, definition(capacity));
  }

  /**
   * One registration for `seats` people at the Konzert.
   *
   * `proof` is the access-word proof and is only needed by the one fixture that
   * puts a form behind the gate — everything else here registers at a form
   * anybody may open.
   */
  async function register(
    slug: string,
    seats: number,
    extra: Record<string, unknown> = {},
    proof?: string,
  ): Promise<request.Response> {
    const call = request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress());
    return (
      proof === undefined ? call : call.set(ACCESS_PROOF_HEADER, proof)
    ).send({
      answers: {
        [EVENTS]: { seats: { konzert: seats, ...extra } },
        [MAIL]: 'teilnehmer@example.org',
      },
    });
  }

  /** A passed gate, asserted, returning the proof. */
  async function unlock(slug: string, word: string): Promise<string> {
    const response = await request(app().server)
      .post(apiPath(`/public/forms/${slug}/access`))
      .set('X-Forwarded-For', ownAddress())
      .send({ password: word });
    expect(response.status).toBe(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * A form whose registrations may be corrected afterwards.
   *
   * „Bearbeiten nach Absenden" is off by default, so every correction case has to turn
   * it on — without it the corrections below are refused with `editing_disabled`
   * and would be measuring that switch instead of the Obergrenze.
   */
  async function editableForm(
    title: string,
    capacity: number,
  ): Promise<{ id: string; slug: string }> {
    const form = await publishedForm(title, capacity);
    await configure(form.id, { access: true }, { allowEdit: true });
    return form;
  }

  /** Registers, and hands back the token its Bearbeiten-Link carries. */
  async function registerWithToken(
    slug: string,
    seats: number,
    proof?: string,
  ): Promise<string> {
    const stored = await register(slug, seats, {}, proof);
    expect(stored.status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { form: { publicSlug: slug } },
      orderBy: { submittedAt: 'desc' },
      select: { editToken: true },
    });
    // Minted for every answer, so a null here is a fault in the
    // fixture rather than a case this suite has an opinion about.
    expect(response.editToken).not.toBeNull();
    return String(response.editToken);
  }

  /** Corrects one registration to `seats` people at the Konzert. */
  async function correct(
    token: string,
    seats: number,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [EVENTS]: { seats: { konzert: seats } },
          [MAIL]: 'teilnehmer@example.org',
        },
      });
  }

  /** The Personenzahl the **stored answer** names — the row, not the reply. */
  async function storedSeats(token: string): Promise<unknown> {
    const response = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
      select: { answers: true },
    });
    return (response.answers as Record<string, unknown>)[EVENTS];
  }

  /**
   * **How many seats the Konzert holds** — read the way the enforcement
   * reads it, i.e. over `event_registration` and past the trash.
   */
  async function seatsTaken(formId: string): Promise<number> {
    const rows = await app().prisma.eventRegistration.findMany({
      where: {
        formId,
        eventKey: 'konzert',
        response: { deletedAt: null },
      },
      select: { seats: true },
    });
    return rows.reduce((sum, row) => sum + row.seats, 0);
  }

  async function responseCount(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  async function mailCount(formId: string): Promise<number> {
    return app().prisma.mailLog.count({ where: { formId } });
  }

  /**
   * **the evidence — sequential.** Grenze 10, registrations of 4, 4, 4: the
   * third is refused *at this position*, and eight seats are taken.
   *
   * ⚠️ This case is green under the wrong build as well. It is here to be
   * compared with the parallel one below, and to fail when the check is moved
   * **behind** the write — the third registration would then count its own four
   * seats and either refuse itself or let twelve people in.
   */
  it('refuses the third registration of four against a limit of ten', async () => {
    const form = await publishedForm('Nacheinander', 10);

    expect((await register(form.slug, 4)).status).toBe(200);
    expect((await register(form.slug, 4)).status).toBe(200);

    const third = await register(form.slug, 4);

    expect(third.status).toBe(409);
    expect(third.body).toMatchObject({
      reason: 'event_full',
      message: SUBMISSION_REFUSAL_MESSAGES.event_full, // **the evidence: machine-readable, and it names the Veranstaltung** — the
      // key, not the caption, so the fill-in view resolves it against the
      // definition it is already showing.
      position: { questionId: EVENTS, eventKey: 'konzert' },
    });
    expect(await seatsTaken(form.id)).toBe(8);
    // Two registrations, not three: the refusal wrote nothing.
    expect(await responseCount(form.id)).toBe(2);
  }, 60_000);

  /**
   * **the evidence — parallel.** Twenty registrations of three against a
   * limit of thirty: exactly ≤ 30 seats, not one more.
   *
   * All twenty requests are in flight before any of them is awaited, so the
   * counting and the inserting genuinely interleave — that is what makes this
   * evidence about concurrency rather than about arithmetic.
   */
  it('never exceeds the Obergrenze when twenty register at once', async () => {
    const form = await publishedForm('Gleichzeitig', 30);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => register(form.slug, 3)),
    );

    const accepted = responses.filter((one) => one.status === 200).length;
    const refused = responses.filter((one) => one.status === 409);

    // Ten of twenty fit exactly; the other ten are refused with **the same**
    // reason and the same position — a mixture would mean something other than
    // the Obergrenze had fired.
    expect(accepted).toBe(10);
    expect(refused).toHaveLength(10);
    expect(
      new Set(refused.map((one) => (one.body as { reason: string }).reason)),
    ).toStrictEqual(new Set(['event_full']));

    // The seats are the claim; the statuses are how it was reported.
    expect(await seatsTaken(form.id)).toBe(30);
    expect(await responseCount(form.id)).toBe(10);
  }, 120_000);

  /**
   * **the evidence — the rest of the registration stays submittable.** What is
   * refused is the position, not the form: the same participant, the same form,
   * the same second — with the full Veranstaltung left out it goes through.
   */
  it('takes the rest of the registration once the full position is dropped', async () => {
    const form = await publishedForm('Rest absendbar', 4);

    expect((await register(form.slug, 4)).status).toBe(200);
    expect((await register(form.slug, 1)).status).toBe(409);

    // Only the unbounded Veranstaltung — the form is not closed for anybody.
    const rest = await request(app().server)
      .post(apiPath(`/public/forms/${form.slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          [EVENTS]: { seats: { ausflug: 6 } },
          [MAIL]: 'teilnehmer@example.org',
        },
      });

    expect(rest.status).toBe(200);
    expect(await responseCount(form.id)).toBe(2);
    // „Ohne Grenze" is recorded and bounded by nothing.
    expect(
      await app().prisma.eventRegistration.count({
        where: { formId: form.id, eventKey: 'ausflug' },
      }),
    ).toBe(1);
  }, 60_000);

  /**
   * **The check stands in the chain of refusals, not behind it.** A
   * registration that failed at the Obergrenze leaves **no** `mail_log` row and
   * **no** `response` row.
   *
   * The form carries a notification on purpose: without one, a green result here
   * would mean „dieses Formular verschickt nie etwas" rather than „die Prüfung
   * steht vor dem Einreihen". The counts are therefore taken around a successful
   * registration first, so the queue is demonstrably working.
   */
  it('queues nothing and stores nothing when the Obergrenze refuses', async () => {
    const form = await publishedForm('Kette', 2);
    await addNotification(form.id);

    expect((await register(form.slug, 2)).status).toBe(200);
    expect(await responseCount(form.id)).toBe(1);
    expect(await mailCount(form.id)).toBe(1);

    expect((await register(form.slug, 1)).status).toBe(409);

    expect(await responseCount(form.id)).toBe(1);
    expect(await mailCount(form.id)).toBe(1);
  }, 60_000);

  /**
   * **An answer in the trash takes up no seats.**
   *
   * The trash itself writes `deleted_at`; what this
   * requirement asks of *this* package is that the counting query already respects
   * it, which is why the column is set directly here. The reproduction is the
   * `deleted_at IS NULL` in `takenSeats` — remove it and the second registration
   * below is refused.
   */
  /**
   * **Nothing is left lying around, not even a registration row** (a review finding).
   *
   * A previous case measured that a refused registration writes no `response` and no
   * `mail_log` row. The third table this write path touches is
   * `event_registration`, and it was the one not asked — a refusal that left a
   * row there would take seats away from everybody else for good, and the sum
   * that decides the limit is exactly the one it would poison.
   */
  it('leaves no seat row behind when the Obergrenze refuses', async () => {
    const form = await publishedForm('Kein Rest', 4);
    expect((await register(form.slug, 4)).status).toBe(200);

    const before = await app().prisma.eventRegistration.count({
      where: { formId: form.id },
    });
    expect((await register(form.slug, 1)).status).toBe(409);

    expect(
      await app().prisma.eventRegistration.count({
        where: { formId: form.id },
      }),
    ).toBe(before);
    expect(await seatsTaken(form.id)).toBe(4);
  });

  /**
   * **A capacity lowered after the fact refuses, and does not go negative**
   * (a review finding).
   *
   * The editor may set the Obergrenze below what is already taken — a hall that
   * turned out smaller. `wanted <= 0` is what keeps that from reading as „minus
   * two seats free", and the answer has to be the ordinary refusal rather than
   * an accepted registration on a negative remainder.
   */
  it('refuses once the Obergrenze is lowered below what is taken', async () => {
    const form = await publishedForm('Kleinerer Saal', 10);
    expect((await register(form.slug, 8)).status).toBe(200);

    await lowerCapacity(form.id, 5);

    const late = await register(form.slug, 1);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ reason: 'event_full' });
    expect(await seatsTaken(form.id)).toBe(8);
  });

  /**
   * **Two Veranstaltungsfragen in one form**, because „the first one in form
   * order" is a promise about *this* case and was only unit-covered (a review
   * finding). The second question's Veranstaltung is the full one, so a refusal
   * naming the first would be naming the wrong one.
   */
  it('names the first full position in form order, across two questions', async () => {
    // **Both** are bounded and both are filled to the brim — with only one full
    // position the case would pass under any search order, which is the whole
    // thing it is here to pin down.
    const form = await publishedTwoQuestionForm('Zwei Fragen', {
      first: 3,
      second: 4,
    });

    expect(
      (await registerBoth(form.slug, { first: 3, second: 4 })).status,
    ).toBe(200);

    const refused = await registerBoth(form.slug, { first: 1, second: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      reason: 'event_full',
      position: { questionId: EVENTS, eventKey: 'konzert' },
    });
  });

  /**
   * **The Obergrenze of today, not the one the answer was given under**
   * (a review finding, the blocking one).
   *
   * An edit is validated against the version its answer was submitted with —
   * that is what keeps a renamed question from turning an old answer into a
   * 400. The capacity is not part of that: it says how many people fit into a
   * hall, and an organisation lowers it without republishing what the form asks. Reading
   * it from the snapshot made the two write paths disagree, and both directions
   * were measured before the fix.
   *
   * *Reproduction:* drop `withLiveCapacity` from the edit path → the correction
   * answers 200 and this case is red on its first assertion.
   */
  it('judges a correction against the Obergrenze the organisation has today', async () => {
    const form = await editableForm('Gesenkte Grenze', 100);
    const token = await registerWithToken(form.slug, 3);

    // The hall turned out smaller.
    await lowerCapacity(form.id, 5);

    // A submission is refused against the new number …
    expect((await register(form.slug, 4)).status).toBe(409);

    // … and a correction must be too, rather than reading 100 off its snapshot.
    const raised = await correct(token, 50);
    expect(raised.status).toBe(409);
    expect(raised.body).toMatchObject({ reason: 'event_full' });

    // The stored answer is untouched — the assertion this case leans on.
    expect(await storedSeats(token)).toEqual({ seats: { konzert: 3 } });
    expect(await seatsTaken(form.id)).toBe(3);
  });

  /**
   * **The sharper half of the same finding: a limit introduced afterwards.**
   *
   * With the snapshot deciding, an answer given while the Veranstaltung was
   * „ohne Grenze" produced *no bounded position at all* — so
   * `if (bounded.length > 0)` was false and neither the lock nor the check ran.
   * Measured before the fix: a correction from 3 to 40 against a limit of 10
   * answered 200.
   *
   * *Reproduction:* drop `withLiveCapacity` → 200 instead of 409, and the sum
   * stands at 40.
   */
  it('judges a correction against an Obergrenze introduced after the answer', async () => {
    const form = await editableForm('Nachträgliche Grenze', 1);
    await republish(form.id, unboundedDefinition());
    const token = await registerWithToken(form.slug, 3);

    // The organisation introduces a limit the answer never saw.
    await lowerCapacity(form.id, 10);

    const raised = await correct(token, 40);
    expect(raised.status).toBe(409);
    expect(raised.body).toMatchObject({ reason: 'event_full' });
    expect(await storedSeats(token)).toEqual({ seats: { konzert: 3 } });
    expect(await seatsTaken(form.id)).toBe(3);

    // And the room that *is* there is still usable — the fix must refuse the
    // excess, not the Veranstaltung.
    expect((await correct(token, 9)).status).toBe(200);
    expect(await seatsTaken(form.id)).toBe(9);
  });

  /**
   * **What the lock costs — a measurement, not an assertion.**
   *
   * Skipped on purpose: it prints numbers and asserts almost nothing, so as a
   * gate it would only add run time and flakiness. It is in the repository
   * because a review asked the right question about the numbers in
   * `public-forms.service.ts`: they were there, the setup was not, and a figure
   * whose setup nobody can repeat is an opinion with decimals.
   *
   * Remove the `.skip` to repeat it. What it measures is the worry that review
   * raised — that taking `FOR UPDATE` from `BEGIN` rather than from
   * `writeSeats` widens the window edits hold submissions in. Recorded on
   * 2026-08-01, one container, PostgreSQL 16, empty form: 383–390 ms before the
   * change and 401–466 ms after, for the thirty-way round below.
   *
   * Deliberately crude: wall clock, one machine, no warm-up beyond the first
   * round. It is here to tell „milliseconds" from „seconds", which is exactly
   * the question that was asked — the 20 s in the transaction options is a
   * timeout and was never an observed wait.
   */
  it.skip('what the lock costs: fifteen edits against fifteen submissions', async () => {
    const form = await editableForm('Messung', 100_000);
    const tokens = await Promise.all(
      Array.from({ length: 15 }, () => registerWithToken(form.slug, 1)),
    );

    const started = Date.now();
    await Promise.all([
      ...tokens.map(async (token) => correct(token, 2)),
      ...Array.from({ length: 15 }, async () => register(form.slug, 1)),
    ]);
    const elapsed = Date.now() - started;

    console.info(`[bench] 15 edits + 15 submissions: ${String(elapsed)} ms`);
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);

  it('frees the seats of an answer in the Papierkorb', async () => {
    const form = await publishedForm('Papierkorb', 4);

    const first = await register(form.slug, 4);
    expect(first.status).toBe(200);
    expect((await register(form.slug, 4)).status).toBe(409);

    await app().prisma.response.updateMany({
      where: { formId: form.id },
      data: { deletedAt: new Date() },
    });

    expect((await register(form.slug, 4)).status).toBe(200);
    // The soft-deleted row still carries its registration; it simply does not
    // count any more — which is what makes a Wiederherstellen able to fail at
    // the Obergrenze later.
    expect(
      await app().prisma.eventRegistration.count({
        where: { formId: form.id, eventKey: 'konzert' },
      }),
    ).toBe(2);
    expect(await seatsTaken(form.id)).toBe(4);
  }, 60_000);

  /**
   * The stored answer and the normalised rows are **one fact**, written in one
   * transaction from one reading of the answer. A test that only counted rows
   * would not notice the two drifting apart.
   */
  it('writes the same seats into the answer and into the rows', async () => {
    const form = await publishedForm('Zwei Sichten', 100);

    expect((await register(form.slug, 3, { ausflug: 5 })).status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true, id: true },
    });
    expect(response.answers).toMatchObject({
      [EVENTS]: { seats: { konzert: 3, ausflug: 5 } },
    });

    const rows = await app().prisma.eventRegistration.findMany({
      where: { responseId: response.id },
      select: { eventKey: true, seats: true, questionId: true },
      orderBy: { eventKey: 'asc' },
    });
    expect(rows).toStrictEqual([
      { eventKey: 'ausflug', questionId: EVENTS, seats: 5 },
      { eventKey: 'konzert', questionId: EVENTS, seats: 3 },
    ]);
  }, 60_000);

  /**
   * A cleared number box writes **nothing** — neither a `0` in the answer nor a
   * row (the single spelling of „nicht angemeldet"). Without
   * `canonicalAnswerValue` this is where the second spelling would first become
   * visible: a row with `seats: 0` that the `CHECK` in the migration refuses,
   * i.e. a 500 on an ordinary registration.
   */
  it('stores no seat and no row for a Veranstaltung answered with zero', async () => {
    const form = await publishedForm('Null', 100);

    expect((await register(form.slug, 0, { ausflug: 2 })).status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { answers: true, id: true },
    });
    expect(response.answers).toStrictEqual({
      [EVENTS]: { seats: { ausflug: 2 } },
      [MAIL]: 'teilnehmer@example.org',
    });
    expect(
      await app().prisma.eventRegistration.findMany({
        where: { responseId: response.id },
        select: { eventKey: true },
      }),
    ).toStrictEqual([{ eventKey: 'ausflug' }]);
  }, 60_000);

  /**
   * **A correction moves the seats along with it**  — the same „one
   * fact" as above, on the Bearbeiten-Pfad.
   *
   * ⚠️ This is **not** the requirement — that is the block of cases below. What is
   * asserted here is the property that has to hold whatever the check decides
   * and would be silently lost otherwise: the seat rows say what the stored
   * answer says. The Obergrenze is generous on purpose, so this case measures
   * the bookkeeping and not the limit.
   */
  it('moves the seats with a correction, in both directions', async () => {
    const form = await publishedForm('Korrektur', 100);
    // „Bearbeiten nach Absenden" is off by default — without this the
    // correction below is refused with `editing_disabled` and the case would be
    // measuring that switch instead of the seats.
    await configure(form.id, { access: true }, { allowEdit: true });

    const first = await register(form.slug, 6, { ausflug: 2 });
    expect(first.status).toBe(200);

    const response = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { id: true, editToken: true },
    });
    const token = response.editToken;
    expect(token).not.toBeNull();

    const corrected = await request(app().server)
      .put(apiPath(`/public/responses/${String(token)}`))
      .set('X-Forwarded-For', ownAddress())
      .send({
        answers: {
          // Down from six, and the Ausflug dropped entirely.
          [EVENTS]: { seats: { konzert: 2 } },
          [MAIL]: 'teilnehmer@example.org',
        },
      });
    expect(corrected.status).toBe(200);

    expect(
      await app().prisma.eventRegistration.findMany({
        where: { responseId: response.id },
        select: { eventKey: true, seats: true },
        orderBy: { eventKey: 'asc' },
      }),
    ).toStrictEqual([{ eventKey: 'konzert', seats: 2 }]);
    // And the freed seats are free: the count the enforcement reads agrees.
    expect(await seatsTaken(form.id)).toBe(2);
  }, 60_000);

  /**
   * **the evidence — an increase without room is refused, and the stored
   * answer is unchanged.**
   *
   * Grenze 10, six seats with somebody else, three with this registration: an
   * increase from 3 to 5 needs two free ones, there is one.
   *
   * ⚠️ **The load-bearing assertion is the content of the `response` row**, not
   * the error message. A build that refuses *after* writing would answer with
   * exactly the same 409, and the participant would find five people in their
   * registration the next time they opened the link.
   */
  it('refuses a correction that rises past the Obergrenze and leaves the answer alone', async () => {
    const form = await editableForm('Erhöhung ohne Platz', 10);
    const token = await registerWithToken(form.slug, 3);
    expect((await register(form.slug, 6)).status).toBe(200);

    const raised = await correct(token, 5);

    expect(raised.status).toBe(409);
    expect(raised.body).toMatchObject({
      reason: 'event_full',
      message: SUBMISSION_REFUSAL_MESSAGES.event_full,
      position: { questionId: EVENTS, eventKey: 'konzert' },
    });
    // The answer, the rows and the sum — all three still say three.
    expect(await storedSeats(token)).toStrictEqual({
      seats: { konzert: 3 },
    });
    expect(await seatsTaken(form.id)).toBe(9);
    expect(
      await app().prisma.eventRegistration.findMany({
        where: { response: { editToken: token } },
        select: { seats: true },
      }),
    ).toStrictEqual([{ seats: 3 }]);
  }, 60_000);

  /**
   * **The reproduction of the requirement, in its first direction.** Grenze 10,
   * eight seats taken, three of them with this registration: the increase from
   * 3 to 4 needs **one** free seat and there are two.
   *
   * Checked against the *new* value — `request.seats` instead of the difference
   * — this reads 8 + 4 > 10 and refuses a correction that fits, which is the
   * mistake this requirement names first. It is the counterpart of the case above: one of the
   * two is red for either mistake, and neither alone would notice both.
   */
  it('lets a correction rise into the seats that are free', async () => {
    const form = await editableForm('Erhöhung mit Platz', 10);
    const token = await registerWithToken(form.slug, 3);
    expect((await register(form.slug, 5)).status).toBe(200);

    expect((await correct(token, 4)).status).toBe(200);

    expect(await storedSeats(token)).toStrictEqual({
      seats: { konzert: 4 },
    });
    expect(await seatsTaken(form.id)).toBe(9);
  }, 60_000);

  /**
   * **the evidence — a decrease frees up immediately**, measured by the fact
   * that another participant gets through afterwards.
   *
   * „Sofort" is the word under test: the seats are free at the commit of the
   * correction, without a purge, a recount or a background job in between.
   */
  it('frees the seats of a lowered correction for the next participant', async () => {
    const form = await editableForm('Verringerung', 10);
    const token = await registerWithToken(form.slug, 8);

    // Four do not fit behind eight — that is the state the correction changes.
    expect((await register(form.slug, 4)).status).toBe(409);

    expect((await correct(token, 3)).status).toBe(200);

    const next = await register(form.slug, 4);
    expect(next.status).toBe(200);
    expect(await seatsTaken(form.id)).toBe(7);
  }, 60_000);

  /**
   * **the evidence — parallel**, and it is the case the whole lock is for.
   *
   * Twenty registrations of one seat each against a Grenze of 30 leave ten
   * free; all twenty are then corrected upward to three at once, i.e. each asks
   * for two more and the ten free seats can serve five of them. **Exactly five
   * corrections succeed and the sum is exactly 30.**
   *
   * ⚠️ **The requirement's literal wording — „zwei Tabs erhöhen *dieselbe*
   * Antwort" — cannot overbook by itself and is therefore not the evidence.**
   * One answer's rows are *replaced*, not added to, so two tabs raising the
   * same registration to five end with five however they interleave. The sharp
   * version is this one: different answers, each rising, competing for the same
   * last free seats. Measured on 2026-08-01 without the check (and without
   * `lockForm`) on the edit path: **all twenty corrections were accepted and 60
   * seats stood in a hall for 30.**
   */
  it('never exceeds the Obergrenze when twenty corrections rise at once', async () => {
    const form = await editableForm('Gleichzeitig korrigiert', 30);

    const tokens: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      // Sequentially: the fixture is the *starting state*, not the measurement,
      // and twenty registrations in flight would be measuring the earlier case again.
      tokens.push(await registerWithToken(form.slug, 1));
    }
    expect(await seatsTaken(form.id)).toBe(20);

    const corrections = await Promise.all(
      tokens.map((token) => correct(token, 3)),
    );

    const accepted = corrections.filter((one) => one.status === 200).length;
    const refused = corrections.filter((one) => one.status === 409);

    expect(accepted).toBe(5);
    expect(refused).toHaveLength(15);
    expect(
      new Set(refused.map((one) => (one.body as { reason: string }).reason)),
    ).toStrictEqual(new Set(['event_full']));

    // The seats are the claim; the statuses are how it was reported.
    expect(await seatsTaken(form.id)).toBe(30);
  }, 180_000);

  /* --- What the public payload may say about the seats ---------------- */

  /**
   * **The requirement, the evidence** — „die Zahl steht in der öffentlichen Nutzlast
   * **nur**, wenn der Schalter an ist".
   *
   * Measured here rather than in `public-forms.spec.ts` because this suite is
   * the one that can *take* seats: a switch that is off is only proven off while
   * there is a number it could have leaked. Every case below therefore registers
   * first and reads afterwards.
   *
   * ⚠️ **The lock in the browser is not the limit.** Nothing in this block says
   * anything about the Obergrenze holding — that is the pair of cases at the top
   * of this file, and it holds for a caller who never loaded the page at all.
   */
  describe('die Restplatz-Anzeige', () => {
    /** The `eventSeats` of the public payload, keyed by `eventKey`. */
    async function eventSeatsOf(
      slug: string,
    ): Promise<Record<string, Record<string, unknown>>> {
      const read = await request(app().server).get(
        apiPath(`/public/forms/${slug}`),
      );
      expect(read.status).toBe(200);
      const entries = (read.body as { eventSeats: Record<string, unknown>[] })
        .eventSeats;
      return Object.fromEntries(
        entries.map((entry) => [String(entry.eventKey), entry]),
      );
    }

    /** The fixture with „Restplätze anzeigen" set on the **Konzert**. */
    function showingRemaining(capacity: number) {
      const base = definition(capacity);
      return {
        pages: [
          {
            ...base.pages[0],
            questions: page0Questions(base).map((question) =>
              (question as { type: string }).type === 'event'
                ? {
                    ...question,
                    events: (
                      question as { events: { key: string }[] }
                    ).events.map((entry) => ({
                      ...entry,
                      showRemaining: entry.key === 'konzert',
                    })),
                  }
                : question,
            ),
          },
        ],
      };
    }

    /**
     * The same fixture plus a **second** Veranstaltungsfrage, both showing
     * their Restplätze — the version published after an answer was already in.
     */
    function withWorkshops(capacity: number) {
      const base = showingRemaining(capacity);
      const page = base.pages[0];
      return {
        pages: [
          {
            ...page,
            questions: [
              ...(page?.questions ?? []),
              {
                id: SECOND_EVENTS,
                type: 'event',
                label: 'Workshops',
                hint: null,
                required: false,
                width: 'full',
                events: [
                  {
                    key: 'workshop',
                    label: 'Workshop',
                    when: null,
                    capacity: 5,
                    showRemaining: true,
                  },
                ],
              },
            ],
          },
        ],
      };
    }

    it('withholds the figure while the switch is off, and still says „ausgebucht"', async () => {
      const form = await publishedForm('Ohne Restplatzanzeige', 10);
      expect((await register(form.slug, 4)).status).toBe(200);

      const seats = await eventSeatsOf(form.slug);
      // The reproduction of the requirement is this one line: write the figure
      // unconditionally in `publicEventSeats` and this goes red. It is asserted
      // as an **absent key**, not as `undefined` — a `remaining: null` would
      // also satisfy `toBeUndefined()` and would still be a field on the wire.
      expect(Object.keys(seats.konzert ?? {}).sort()).toStrictEqual([
        'eventKey',
        'full',
        'questionId',
      ]);
      expect(seats.konzert?.full).toBe(false);

      // …and „ausgebucht" arrives without the switch, which is the other half
      // of the requirement.
      expect((await register(form.slug, 6)).status).toBe(200);
      expect((await eventSeatsOf(form.slug)).konzert?.full).toBe(true);
    }, 60_000);

    it('sends the figure once the Bearbeiter switched it on', async () => {
      const form = await publishedForm('Mit Restplatzanzeige', 10);
      await republish(form.id, showingRemaining(10));
      expect((await register(form.slug, 4)).status).toBe(200);

      const seats = await eventSeatsOf(form.slug);
      expect(seats.konzert).toMatchObject({ full: false, remaining: 6 });

      // Per **Veranstaltung**, not per question: the Ausflug of the same
      // question keeps its switch off — and, being „ohne Grenze", is not in the
      // list at all.
      expect(seats.ausflug).toBeUndefined();
    }, 60_000);

    it('counts the seats a corrected answer freed, and never publishes a negative', async () => {
      const form = await editableForm('Restplätze nach Korrektur', 10);
      await republish(form.id, showingRemaining(10));
      const token = await registerWithToken(form.slug, 8);
      expect((await eventSeatsOf(form.slug)).konzert?.remaining).toBe(2);

      expect((await correct(token, 3)).status).toBe(200);
      expect((await eventSeatsOf(form.slug)).konzert?.remaining).toBe(7);

      // An Obergrenze lowered under the registrations already taken: the figure
      // clamps at zero rather than publishing „−4 frei", and „ausgebucht" is
      // what a participant reads.
      await republish(form.id, showingRemaining(1));
      const lowered = (await eventSeatsOf(form.slug)).konzert;
      expect(lowered).toMatchObject({ full: true, remaining: 0 });
    }, 60_000);

    /**
     * **The correction sees its own seats as free** .
     *
     * Without this, the one change this requirement promises always works — lowering a
     * registration — would be locked out by the view: „Ausgebucht" would stand
     * over the box holding the participant's own eight seats.
     */
    it('does not call a Veranstaltung full for the answer that fills it', async () => {
      const form = await editableForm('Eigene Plätze', 10);
      await republish(form.id, showingRemaining(10));
      const token = await registerWithToken(form.slug, 10);

      // A stranger sees the hall as full…
      expect((await eventSeatsOf(form.slug)).konzert).toMatchObject({
        full: true,
        remaining: 0,
      });

      // …the holder of those ten seats sees ten of them as theirs.
      const edit = await request(app().server).get(
        apiPath(`/public/responses/${token}`),
      );
      expect(edit.status).toBe(200);
      const seats = (
        edit.body as { form: { eventSeats: Record<string, unknown>[] } }
      ).form.eventSeats;
      expect(seats).toContainEqual({
        questionId: EVENTS,
        eventKey: 'konzert',
        full: false,
        remaining: 10,
      });
    }, 60_000);

    /**
     * **An edit token sees only the Veranstaltungen of its own version** (a
     * security review finding).
     *
     * `byEditToken` renders the snapshot of the answer's version *and* passes
     * the access word by design — the token is the proof. Its seat view was
     * built from the **live** definition, so a Veranstaltung published after the
     * answer arrived in `eventSeats` with its `questionId`, its `eventKey`, its
     * „ausgebucht" and, with the switch on, its remaining-seat count. On the form
     * below that is a statement about content **behind the gate**, handed to
     * whoever holds one old link.
     *
     * The gate is set **before** the answer on purpose: switching the word on
     * afterwards revokes every token, and the fixture would then be
     * testing that instead.
     *
     * The same case carries the other half of the requirement: the ten seats the token
     * itself holds still come off the sum, so the holder reads „10 frei" over
     * the box holding their own ten while a stranger at the front door reads
     * „ausgebucht". Drop the subtraction and this goes red as well.
     */
    it('says nothing about a Veranstaltung published after the answer', async () => {
      const word = 'Jahrestagung2026';
      const form = await publishedForm('Hinter dem Tor', 10);
      await configure(
        form.id,
        { access: true },
        { allowEdit: true, passwordEnabled: true, password: word },
      );
      await republish(form.id, showingRemaining(10));

      const proof = await unlock(form.slug, word);
      const token = await registerWithToken(form.slug, 10, proof);

      // Only now does the second Veranstaltungsfrage appear — the answer above
      // never saw it.
      await republish(form.id, withWorkshops(10));

      const edit = await request(app().server).get(
        apiPath(`/public/responses/${token}`),
      );
      expect(edit.status).toBe(200);
      const seats = (
        edit.body as { form: { eventSeats: Record<string, unknown>[] } }
      ).form.eventSeats;

      // The whole finding in one assertion: the list is the snapshot's, and the
      // Workshop is not in it — not as „ausgebucht", not as a bare position.
      expect(seats).toStrictEqual([
        {
          questionId: EVENTS,
          eventKey: 'konzert',
          full: false,
          remaining: 10,
        },
      ]);
      // …and it is nowhere else in the payload either.
      expect(edit.text).not.toContain(SECOND_EVENTS);
      expect(edit.text).not.toContain('workshop');

      // The positive control: somebody who passes the gate today *does* get the
      // Workshop, so the absence above is the snapshot doing its work and not a
      // form that failed to publish.
      const front = await request(app().server)
        .get(apiPath(`/public/forms/${form.slug}`))
        .set(ACCESS_PROOF_HEADER, proof);
      expect(front.status).toBe(200);
      expect(
        (front.body as { eventSeats: Record<string, unknown>[] }).eventSeats,
      ).toStrictEqual([
        {
          questionId: EVENTS,
          eventKey: 'konzert',
          // The stranger's view of the same hall: full, while the holder of
          // those ten seats reads ten free.
          full: true,
          remaining: 0,
        },
        {
          questionId: SECOND_EVENTS,
          eventKey: 'workshop',
          full: false,
          remaining: 5,
        },
      ]);
    }, 60_000);

    /**
     * **What the switch cannot buy back: the refusal is an oracle.**
     *
     * A security review built this and it works. `capacity` is public
     * — it stands in `definition`, an editor typed it. A refusal names the
     * position it fired on (the evidence), and a refusal writes nothing. Put a
     * second, deliberately impossible position behind the one under
     * investigation and every probe is free: the answer names the *first*
     * exhausted position, so „it named the second one" means the first one fit.
     * Seven probes then bisect the registration state exactly, with „Restplätze
     * anzeigen" off.
     *
     * It is recorded rather than repaired because **there is nothing here to
     * repair without giving up the position check itself.** Any honest refusal distinguishes „your N
     * fit" from „your N did not", and that distinction *is* the oracle; hiding
     * the position only forces the attacker to probe one position per form. The
     * figure is derivable by anyone willing to spend refused submissions, and
     * the switch was never the thing standing in their way.
     *
     * What the switch does buy is real and worth keeping: the number does not travel to
     * everybody who merely opens the page — no probing, no rate limit spent, no
     * intent required. The cost of learning it is the whole difference, and
     * `PUBLIC_SUBMIT_RATE_LIMIT` is what sets that cost.
     *
     * The residual risk is named in `docs/kb/07-oeffentliche-pfade.md` and in
     * the Hilfetext of the switch, so that an editor who leaves it off is not
     * told a secret is being kept.
     */
    it('is derivable from the refusal even while the switch is off', async () => {
      // The Konzert takes 100, the Workshop exactly one — the Workshop is
      // the companion that guarantees every probe below is refused and free.
      const form = await publishedTwoQuestionForm('Orakel', {
        first: 100,
        second: 1,
      });
      const secret = 37;
      expect((await register(form.slug, secret)).status).toBe(200);

      // Nothing is on offer through the front door.
      const seats = await eventSeatsOf(form.slug);
      expect(seats.konzert).toStrictEqual({
        questionId: EVENTS,
        eventKey: 'konzert',
        full: false,
      });

      /** Does `n` still fit at the Konzert? Costs one refused request. */
      async function fits(n: number): Promise<boolean> {
        const probe = await registerBoth(form.slug, { first: n, second: 2 });
        expect(probe.status).toBe(409);
        const body = probe.body as {
          reason: string;
          position: { eventKey: string };
        };
        expect(body.reason).toBe('event_full');
        // The Workshop was named, so the Konzert was not the first to fail.
        return body.position.eventKey === 'workshop';
      }

      let low = 0;
      let high = 100;
      let probes = 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        probes += 1;
        if (await fits(middle)) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }

      expect(low).toBe(100 - secret);
      expect(probes).toBeLessThanOrEqual(7);

      // And not one of those probes left a trace to notice it by.
      expect(await responseCount(form.id)).toBe(1);
      expect(await seatsTaken(form.id)).toBe(secret);
    }, 60_000);
  });
});
