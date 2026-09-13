import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HONEYPOT_SUPPRESSION_REASON,
  MAIL_BUDGET_EXCEEDED_REASON,
} from '../../src/public/mail-suppression';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
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
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **Das Versandbudget** — the requirements (Absendung) and (Bearbeiten).
 *
 * ## The one assertion that carries this file
 *
 * ⚠️ **Every case counts the rows in `response` first, then those in
 * `mail_log`.** A test that only counted „ab der sechsten Mail geht nichts mehr
 * raus" stays green when the submission *fails* instead — and a spam defence
 * that refuses registrations is the exact inversion of this measure. So the
 * response count is the first `expect` of every case here, never a side
 * condition, and every request's status is asserted as 200.
 *
 * ## The negative probes, measured while writing this file
 *
 * - **N1: the budget check made to throw** instead of capping (a
 *   `ConflictException` where `capMails` is called): the first case turns red
 *   on `expect(responses).toBe(8)` — before it ever looks at `mail_log`.
 * - **N2: the reason left out** (`lastError: null` on a capped row): the first
 *   case turns red on the **text** of the column, not on the status, which is
 *   the same shape an earlier probe of this kind has.
 * - **N3: the budget hard-wired** (`5` instead of `settings.mailBudgetLimit`):
 *   the inheritance case turns red — the organisation that raised its budget is capped
 *   at the system's number.
 * - **N4: the window computed „seit Beginn"** (`new Date(0)` instead of
 *   {@link budgetWindowStart}): the sliding-window case turns red; nothing is
 *   let through after the clock moves.
 * - **N5: the budget applied in `submit()` only**, not on the edit route: the
 *   editing case turns red. Removing the „no change, no mail" rule of 2026-07-29
 *   does **not** turn it red, deliberately — two measures against two problems,
 *   two proofs.
 * - **N6: the `NOT (failed AND attempts = 0)` clause removed** from the count
 *   (`PublicFormsService.mailAllowance`): „Köder verbraucht nichts" turns red —
 *   the second clean submission behind a baited one is capped. A review finding
 *   exists because *no* case in this file was red without that clause; the
 *   five that were here counted rows the clause changes nothing about.
 * - **N7: the clause widened to „every `failed` row is free"**
 *   (`status: { not: 'failed' }`): „aufgegebene Zeile verbraucht" turns red —
 *   a delivery the worker really attempted and really gave up on would stop
 *   counting, and an organisation with a dead SMTP server would have no budget at all.
 *
 * ## Where the bound of the parallel case comes from
 *
 * From the construction of the case itself — two waves, the second of them
 * exact — and no longer from a constant. See {@link BURST}, which also says why
 * the pool-derived tolerance that used to stand here stopped being derivable.
 */

const PASSWORD = 'test-password';

const PAGE = '019ffe00-0000-7000-8000-0000000000a0';
const NAME_QUESTION = '019ffe00-0000-7000-8000-000000000001';

const OFFICE_ADDRESS = 'buero@example.org';

/**
 * The parallel case runs **two waves of this size**, and the shape is the whole
 * measurement (two review findings, one colliding with the other).
 *
 * ## Why the old bound measured nothing
 *
 * It asserted „höchstens Budget + Toleranz" with the tolerance derived from
 * `DB_POOL_MAX` (`src/prisma/prisma.service.ts`): `10 + (10 - 1) = 19` against a
 * burst of twenty, i.e. exactly the trivial neighbour of „< 20" it stood
 * beside. A bound that only excludes the single worst case excludes nothing
 * worth stating.
 *
 * ## Why the obvious repair does not work any more
 *
 * Raising the burst alone would not fix it, because the derivation itself
 * stopped holding with that review finding: the count runs **before** the transaction
 * now, not inside it, so „at most `DB_POOL_MAX - 1` submissions can hold a
 * stale count" is no longer true. A submission reads the count, releases the
 * connection, and then queues for a transaction — so the number that can sit
 * between their count and their commit is bounded by the concurrency, not by
 * the pool. Keeping the old constant would have been folklore dressed as a
 * derivation.
 *
 * ## What replaces it, and why it is exact
 *
 * Two waves of {@link BURST}, awaited in turn.
 *
 * *Wave one* is the soft half and stays soft: submissions race, each may read a
 * count the others have not committed yet, and the assertion is only that not
 * all of them got through — with `BURST` at twice the budget, „< BURST" is a
 * statement rather than a tautology.
 *
 * *Wave two* is **exact, and it is what carries this case.** By the time it
 * starts, wave one has committed, and wave one has committed **at least
 * `budget` queued rows** whatever the interleaving: a submission is capped only
 * if it read `spent >= budget`, which means those rows already existed; and if
 * none was capped, all `BURST` of them queued. So every count in wave two sees
 * a spent budget, and every single row it produces must be `failed` with the
 * budget's reason — twenty of them, racing each other, and not one may slip
 * through. That is a far sharper statement than one deterministic follow-up
 * submission, which is why the follow-up is gone.
 *
 * **A test demanding „genau Budget" over the whole burst would force the wrong
 * construction:** a second form-wide lock, taken by every submission of every
 * form, to save a handful of mails on a limit whose whole design is to be
 * generous (second proof). Wave two is how this file gets an exact
 * assertion without asking for that lock.
 */
const BURST = 20;

const questionBase = { hint: null, required: false, width: 'full' as const };

function definition(): unknown {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            ...questionBase,
            id: NAME_QUESTION,
            type: 'text',
            label: 'Name',
            minLength: null,
            maxLength: null,
            pattern: null,
          },
        ],
      },
    ],
  };
}

const ANSWERS = { [NAME_QUESTION]: 'Anton Aktiv' };

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('Versandbudget ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let Organisation: TenantFixture;
  let editor: string;
  let clock: MutableClock;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // The queue's calendar, injected — the sliding window is proven by moving
    // it, never by waiting (`mail-clock.ts`).
    clock = new MutableClock(new Date());
    testApp = await createTestApp({
      databaseUrl: database.url,
      // Own address per request: the public submit route allows 30 a minute per
      // address and this file sends well over that.
      env: { TRUST_PROXY_HOPS: 1 },
      clock,
    });

    /*
     * **The server listens here itself, once for the whole file** — a property
     * of the test client, not of the application.
     *
     * supertest starts a non-listening server itself on the first request —
     * and **closes it again** as soon as exactly that request is finished
     * (`supertest/lib/test.js`: `if (!addr) this._server = app.listen(0)`,
     * later `server.close(...)`). As long as a case sends only *one* wave of
     * simultaneous requests, that does not show. The parallel case below sends
     * two, and the closing of the first reproducibly falls in the middle of
     * the second: the last connections die with `ECONNRESET`, without the
     * application ever having been asked.
     *
     * If the server is already listening, supertest does not take it over and
     * never closes it; it is shut down by `testApp.close()` as before.
     */
    await new Promise<void>((resolve) => {
      testApp.server.listen(0, resolve);
    });

    Organisation = await createTenant(testApp.prisma, 'BUDG');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [Organisation],
    });
    editor = await openSession(testApp, user.id, Organisation.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // Fixtures, through the real routes
  // ═══════════════════════════════════════════════════════════════════════

  interface Form {
    readonly id: string;
    readonly slug: string;
  }

  async function publishedForm(title: string, session: string): Promise<Form> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(session))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(session))
      .send({ title, definition: definition(), revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(session))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /**
   * One notification to a **literal** address, firing on both triggers.
   *
   * Literal rather than a question recipient, so exactly one row is queued per
   * submission without `copyToSubmitter` entering the picture: this file is
   * about *how many*, and that switch has its own suite.
   */
  async function addNotification(
    formId: string,
    session: string,
    triggers: readonly string[] = ['submit'],
  ): Promise<void> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(session))
      .send({
        name: 'An das Büro',
        subject: 'Anmeldung eingegangen',
        body: 'Danke.',
        triggers,
        recipients: [{ kind: 'literal', address: OFFICE_ADDRESS }],
        replyTo: null,
      });
    expect(created.status).toBe(201);
  }

  /**
   * Writes a form's own budget through the real settings route.
   *
   * `allowEditing` takes *Zugriff & Sicherheit* over as well, and the pair is
   * worth a sentence: the two sections are independent, so a form that decides
   * its own editing rule keeps whatever budget it inherits — which is the
   * placement decision of the specification exercised in passing.
   */
  async function setFormBudget(
    formId: string,
    session: string,
    values: { mailBudgetLimit: number; mailBudgetWindowMin?: number },
    allowEditing = false,
  ): Promise<void> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const owner = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });

    const response = await request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(session))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: true,
          ...(allowEditing ? { access: true } : {}),
        },
        values: {
          mailBudgetWindowMin: 60,
          ...(allowEditing ? { allowEdit: true } : {}),
          ...values,
        },
        revision: form.settingsRevision,
        tenantRevision: owner.formDefaultsRevision,
      });
    expect(response.status).toBe(200);
  }

  function submit(
    slug: string,
    /** Extra top-level wire fields — the decoy, for the two cases below. */
    extra: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: ANSWERS, ...extra });
  }

  function responseCount(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  /**
   * The form's lines, oldest first.
   *
   * `id` is the tie-breaker and it is needed: the clock is injected and frozen,
   * so submissions made without moving it share one `created_at` to the
   * millisecond. `uuid(7)` is time-ordered, which makes „die ersten fünf" a
   * statement rather than a coincidence of the query plan.
   */
  function mailsOf(formId: string) {
    return app().prisma.mailLog.findMany({
      where: { formId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — eight submissions against a budget of five
  // ═══════════════════════════════════════════════════════════════════════

  it('speichert alle acht Antworten und deckelt nur die Mails', async () => {
    const form = await publishedForm('Budget fünf', editor);
    await addNotification(form.id, editor);
    await setFormBudget(form.id, editor, { mailBudgetLimit: 5 });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // Sequentially, so this case measures the rule and not a race — the race
      // is the next case's job.
      statuses.push((await submit(form.slug)).status);
    }

    // **First assertion: not one submission failed.**
    expect(statuses).toStrictEqual([200, 200, 200, 200, 200, 200, 200, 200]);
    expect(await responseCount(form.id)).toBe(8);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(8);
    expect(mails.filter((mail) => mail.status === 'queued')).toHaveLength(5);

    const capped = mails.filter((mail) => mail.status === 'failed');
    expect(capped).toHaveLength(3);
    // The **text** of the column, not just the status (N2).
    expect(capped.map((mail) => mail.lastError)).toStrictEqual([
      MAIL_BUDGET_EXCEEDED_REASON,
      MAIL_BUDGET_EXCEEDED_REASON,
      MAIL_BUDGET_EXCEEDED_REASON,
    ]);
    // A capped line still says whom it would have gone to, or the
    // mail log cannot be read.
    expect(capped[0]?.recipient).toBe(OFFICE_ADDRESS);
    // The first five, in order, are the ones that were let through.
    expect(mails.slice(0, 5).every((mail) => mail.status === 'queued')).toBe(
      true,
    );
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — twenty simultaneous submissions against a budget of ten
  // ═══════════════════════════════════════════════════════════════════════

  it('verliert unter Parallelität keine Antwort und deckelt weich', async () => {
    const form = await publishedForm('Budget zehn, parallel', editor);
    await addNotification(form.id, editor);
    await setFormBudget(form.id, editor, { mailBudgetLimit: 10 });

    const wave = (): Promise<request.Response[]> =>
      Promise.all(Array.from({ length: BURST }, () => submit(form.slug)));

    const first = await wave();
    // The rows of the first wave, **held on to instead of counted off later**:
    // the clock stands still, all forty rows carry the same `created_at`, and a
    // `slice(0, BURST)` over the ordering would be a bet on the
    // sub-millisecond bits of `uuid(7)`.
    const firstWave = await mailsOf(form.id);
    // The second wave **after** the first. This `await` is the whole
    // construction of the exact part further down (see {@link BURST}).
    const second = await wave();

    // **First assertion, and the most expensive one:** an Anmeldestart must
    // not fail at an abuse defence.
    expect(
      [...first, ...second].map((response) => response.status),
    ).toStrictEqual(Array.from({ length: 2 * BURST }, () => 200));
    expect(await responseCount(form.id)).toBe(2 * BURST);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2 * BURST);
    expect(
      mails
        .filter((mail) => mail.status === 'failed')
        .every((mail) => mail.lastError === MAIL_BUDGET_EXCEEDED_REASON),
    ).toBe(true);

    // **Wave one, soft — and that is why *no* upper bound stands here.**
    // The budget counts without an additional lock (a second form-wide lock at
    // the Anmeldestart is more expensive than a few mails too many). With
    // really simultaneous submissions **all** twenty may therefore read the
    // count before the first one has written its row — then the cap does not
    // bite in this wave at all, and that is the price borne, not a fault.
    //
    // An earlier `expect(queued).toBeLessThan(BURST)` stood here and fell on
    // 2026-07-31, **measured**: under the load of `pnpm -r test` (shared, web
    // and api at the same time) it went red reliably in every second full run,
    // while three single runs of the api suite stayed green —
    // `expected 20 to be less than 20`. It was the remainder of the tolerance
    // that had already been replaced once because it was trivially satisfied;
    // what was replaced back then was the number, what stayed standing is the
    // **direction**, and that demands that a soft bound bites in time. That is
    // exactly what it does not assure. What it does assure is measured by the
    // second wave below — exactly.
    expect(firstWave).toHaveLength(BURST);
    const queued = firstWave.filter((mail) => mail.status === 'queued').length;
    expect(queued).toBeGreaterThanOrEqual(10);

    // **Wave two, exact.** The budget is demonstrably used up, so of twenty
    // **simultaneous** submissions not a single one may get through. That is
    // the assertion which carries the soft bound above — and it measures more
    // than a single straggler submission that races against nothing.
    const inFirstWave = new Set(firstWave.map((mail) => mail.id));
    const secondWave = mails.filter((mail) => !inFirstWave.has(mail.id));
    expect(secondWave).toHaveLength(BURST);
    expect(secondWave.filter((mail) => mail.status === 'queued')).toHaveLength(
      0,
    );
    expect(
      secondWave.every(
        (mail) =>
          mail.status === 'failed' &&
          mail.lastError === MAIL_BUDGET_EXCEEDED_REASON,
      ),
    ).toBe(true);
  }, 180_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the time window really slides
  // ═══════════════════════════════════════════════════════════════════════

  it('lässt nach einem gleitenden Fenster wieder etwas hinaus', async () => {
    const form = await publishedForm('Budget mit Fenster', editor);
    await addNotification(form.id, editor);
    await setFormBudget(form.id, editor, {
      mailBudgetLimit: 2,
      mailBudgetWindowMin: 60,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await submit(form.slug)).status).toBe(200);
    }
    const filled = await mailsOf(form.id);
    expect(filled.filter((mail) => mail.status === 'queued')).toHaveLength(2);
    expect(filled.filter((mail) => mail.status === 'failed')).toHaveLength(1);

    // **The clock, not the wall clock** — no `sleep` in this repository.
    //
    // First a jump **inside** the window. With that the case checks both
    // directions: a test that only moves it far enough forward would be green
    // as well if *any* moving forward emptied the count — it would not tell
    // „gleitend um `mailBudgetWindowMin`" apart from „vergisst alles, sobald
    // sich die Uhr bewegt".
    clock.advance(30 * 60_000);
    expect((await submit(form.slug)).status).toBe(200);
    const halfway = await mailsOf(form.id);
    expect(halfway).toHaveLength(4);
    expect(halfway[3]?.status).toBe('failed');

    // …and now beyond the width of the window.
    clock.advance(31 * 60_000);
    expect((await submit(form.slug)).status).toBe(200);

    const afterwards = await mailsOf(form.id);
    expect(await responseCount(form.id)).toBe(5);
    expect(afterwards).toHaveLength(5);
    // The fifth row is queued again — computed „seit Beginn" it would be the
    // fourth rejection (N4).
    expect(afterwards[4]?.status).toBe('queued');
    expect(afterwards[4]?.lastError).toBeNull();
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // The editing path is a mail trigger as well
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * N edits through the same token, beyond the debounce.
   *
   * „Beyond the debounce" does not mean „after 15 seconds" here: the debounce
   * of this path has been „keine Änderung, keine Mail" since 29.07.2026
   * (`storeEditWithMails`), so a different value is written on **every** edit.
   * With that every edit really triggers a mail, and what caps it is the
   * budget alone — exactly the separation the requirement demands: removing
   * the debounce does **not** turn this test red.
   */
  it('deckelt auch den Bearbeiten-Pfad — und die Bearbeitung gelingt weiter', async () => {
    const form = await publishedForm('Budget beim Bearbeiten', editor);
    await addNotification(form.id, editor, ['submit', 'edit']);
    await setFormBudget(form.id, editor, { mailBudgetLimit: 3 }, true);

    expect((await submit(form.slug)).status).toBe(200);
    const stored = await app().prisma.response.findFirstOrThrow({
      where: { formId: form.id },
      select: { id: true, editToken: true },
    });
    const token = stored.editToken;
    expect(token).not.toBeNull();

    const names = ['Berta B.', 'Cäsar C.', 'Dorothea D.', 'Emil E.'];
    for (const name of names) {
      const edited = await request(app().server)
        .put(apiPath(`/public/responses/${token ?? ''}`))
        .set('X-Forwarded-For', ownAddress())
        .send({ answers: { [NAME_QUESTION]: name } });
      // **First assertion: the edit still succeeds.**
      expect(edited.status).toBe(200);
    }

    // …and it carries the new content, including the ones whose mail was capped.
    const answer = await app().prisma.response.findUniqueOrThrow({
      where: { id: stored.id },
      select: { answers: true, editedAt: true },
    });
    expect(answer.answers).toStrictEqual({ [NAME_QUESTION]: 'Emil E.' });
    expect(answer.editedAt).not.toBeNull();
    // No second row — an edit replaces.
    expect(await responseCount(form.id)).toBe(1);

    // One submission plus four edits are five triggers at a budget of three.
    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(5);
    expect(mails.filter((mail) => mail.status === 'queued')).toHaveLength(3);
    const capped = mails.filter((mail) => mail.status === 'failed');
    expect(capped).toHaveLength(2);
    expect(
      capped.every((row) => row.lastError === MAIL_BUDGET_EXCEEDED_REASON),
    ).toBe(true);
    // The trigger stands in the row: the capping happened on the editing path.
    expect(capped.map((row) => row.trigger)).toStrictEqual(['edit', 'edit']);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // The counting rule itself — `NOT (failed AND attempts = 0)`
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **What was never queued uses nothing up** — and that is not a subtlety but
   * the flood property of the measure (a review finding).
   *
   * The honeypot writes its capped rows with `attempts = 0`. If they counted
   * along, a bot with a filled decoy could drain the budget of a form within a
   * minute and thereby switch off **the confirmations of the real
   * registrants** alongside it — the defence would be the attack.
   *
   * Budget two, one decoy submission, then two clean ones: **both** have to be
   * queued. Without the clause the second one would be capped; that is
   * reproduction N6, and it is the only case in this file that sees it.
   */
  it('lässt eine Köder-Zeile nichts vom Budget verbrauchen', async () => {
    const form = await publishedForm('Köder zahlt nicht', editor);
    await addNotification(form.id, editor);
    await setFormBudget(form.id, editor, { mailBudgetLimit: 2 });

    expect(
      (await submit(form.slug, { honeypot: 'https://spam.example' })).status,
    ).toBe(200);
    expect((await submit(form.slug)).status).toBe(200);
    expect((await submit(form.slug)).status).toBe(200);

    // First assertion as everywhere here: not one submission failed.
    expect(await responseCount(form.id)).toBe(3);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(3);
    expect(mails[0]?.status).toBe('failed');
    expect(mails[0]?.lastError).toBe(HONEYPOT_SUPPRESSION_REASON);
    // **The load-bearing assertion:** both clean submissions got through.
    expect(mails[1]?.status).toBe('queued');
    expect(mails[2]?.status).toBe('queued');
    // And no row carries the budget reason — nothing was capped.
    expect(
      mails.filter((mail) => mail.lastError === MAIL_BUDGET_EXCEEDED_REASON),
    ).toHaveLength(0);
  }, 120_000);

  /**
   * **What the worker really attempted and gave up on very much does use
   * something up** — the other half of the same clause (a review finding).
   *
   * `NOT (failed AND attempts = 0)` expressly does *not* mean „jede
   * fehlgeschlagene Zeile ist frei". A delivery with `attempts > 0` has kept a
   * mail server busy; it is exactly the load the budget stands against, and a
   * form whose mails all fail is the case in which a cap counts most.
   *
   * The worker does not run here — the row is set to the state it leaves
   * behind (`status = failed`, `attempts = 3`). That is a fixture about the
   * outcome, not about the rule: what is checked is what the **count** makes
   * of it. Reproduction N7.
   */
  it('lässt eine aufgegebene Zustellung das Budget verbrauchen', async () => {
    const form = await publishedForm('Aufgegeben zahlt', editor);
    await addNotification(form.id, editor);
    await setFormBudget(form.id, editor, { mailBudgetLimit: 1 });

    expect((await submit(form.slug)).status).toBe(200);
    const queued = await mailsOf(form.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('queued');

    // The state that `MailWorkerService` leaves behind after the last
    // delivery: attempted, finally failed.
    await app().prisma.mailLog.update({
      where: { id: queued[0]?.id ?? '' },
      data: {
        status: 'failed',
        attempts: 3,
        lastError: 'SMTP-Verbindung abgelehnt',
        nextAttemptAt: null,
      },
    });

    expect((await submit(form.slug)).status).toBe(200);
    expect(await responseCount(form.id)).toBe(2);

    const mails = await mailsOf(form.id);
    expect(mails).toHaveLength(2);
    // **The load-bearing assertion:** the second submission is capped because
    // the first mail used the budget up — although it failed.
    expect(mails[1]?.status).toBe('failed');
    expect(mails[1]?.lastError).toBe(MAIL_BUDGET_EXCEEDED_REASON);
    expect(mails[1]?.attempts).toBe(0);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — settable per organisation and inherited (the sharpest probe of it)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Two organisations, **no form override anywhere**.
   *
   * One of them raises the budget in its standards, the other decides nothing
   * and inherits the shipped default. Both forms inherit from their
   * organisation — and the two budgets have to differ. A hard-wired number
   * makes this red; so does an inheritance that gets stuck at the
   * organisation.
   *
   * ⚠️ There were once **three** layers, and the system row set the lower
   * number. That row no longer exists (ADR-0011, continuation 2026-08-14);
   * the lower bound is now `SYSTEM_FORM_SETTINGS`, and because nobody reaches
   * its 1000 in a test, the inheriting organisation lowers it to two itself —
   * which measures the same question: does the value of *this* organisation
   * reach its form, and only its own.
   */
  it('erbt das Budget je Organisation und lässt es je Organisation anheben', async () => {
    const raised = await createTenant(app().prisma, 'RAIS');
    const raisedAdmin = await createUser(app().prisma, {
      email: 'raised@example.org',
      password: PASSWORD,
      tenants: [raised],
    });
    const raisedSession = await openSession(app(), raisedAdmin.id, raised.id);

    const inheriting = await createTenant(app().prisma, 'INHE');
    const inheritingAdmin = await createUser(app().prisma, {
      email: 'inheriting@example.org',
      password: PASSWORD,
      tenants: [inheriting],
    });
    const inheritingSession = await openSession(
      app(),
      inheritingAdmin.id,
      inheriting.id,
    );

    /** Sets an organisation's budget through its own route. */
    async function setBudget(session: string, limit: number): Promise<void> {
      const standards = await request(app().server)
        .get(apiPath('/tenant/form-defaults'))
        .set('Cookie', cookieHeader(session));
      expect(standards.status).toBe(200);
      const written = await request(app().server)
        .put(apiPath('/tenant/form-defaults'))
        .set(authedMutation(session))
        .send({
          values: { mailBudgetLimit: limit, mailBudgetWindowMin: 60 },
          revision: (standards.body as { revision: number }).revision,
        });
      expect(written.status).toBe(200);
    }

    await setBudget(raisedSession, 5);
    await setBudget(inheritingSession, 2);

    // No form takes anything over.
    const generous = await publishedForm(
      'Organisation mit Budget',
      raisedSession,
    );
    await addNotification(generous.id, raisedSession);
    const inherited = await publishedForm(
      'Organisation mit kleinem Budget',
      inheritingSession,
    );
    await addNotification(inherited.id, inheritingSession);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await submit(generous.slug)).status).toBe(200);
      expect((await submit(inherited.slug)).status).toBe(200);
    }

    // Both organisations keep every registration…
    expect(await responseCount(generous.id)).toBe(4);
    expect(await responseCount(inherited.id)).toBe(4);

    // …and only the one with the small budget is capped, at its two.
    const generousMails = await mailsOf(generous.id);
    expect(
      generousMails.filter((mail) => mail.status === 'queued'),
    ).toHaveLength(4);
    expect(
      generousMails.filter((mail) => mail.status === 'failed'),
    ).toHaveLength(0);

    const inheritedMails = await mailsOf(inherited.id);
    expect(
      inheritedMails.filter((mail) => mail.status === 'queued'),
    ).toHaveLength(2);
    const capped = inheritedMails.filter((mail) => mail.status === 'failed');
    expect(capped).toHaveLength(2);
    expect(capped[0]?.lastError).toBe(MAIL_BUDGET_EXCEEDED_REASON);
    // Each organisation's rows carry its own tenant — `mail_log` has no composite
    // foreign key, so this is asserted rather than assumed.
    expect(
      inheritedMails.every((mail) => mail.tenantId === inheriting.id),
    ).toBe(true);
    expect(generousMails.every((mail) => mail.tenantId === raised.id)).toBe(
      true,
    );
  }, 180_000);
});
