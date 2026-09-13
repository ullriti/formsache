import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { toInstant } from '@formsache/shared';

import { SUBMISSION_REFUSAL_MESSAGES } from '../../src/public/public-forms.service';
import { StartTokenService } from '../../src/public/start-token.service';
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
 * **The enforcement** .
 *
 * Everything here goes straight at the public endpoint, past the browser: that
 * is the whole claim of the stage. And every refusal is checked by **counting
 * `response` rows before and after**, never by looking at the answer alone —
 * the stage's preamble asks for exactly that, and a refusal that still wrote a
 * row would look identical from the outside.
 *
 * ## Two things about the setup, and both are deliberate
 *
 * **`TRUST_PROXY_HOPS: 1` plus a distinct `X-Forwarded-For` per request.** The
 * public submit route allows 30 submissions a minute *per address*
 * (`public-forms.rate-limit.ts`), and one case alone fires twenty. Without separate
 * addresses this suite would be measuring the rate limit rather than the gates,
 * and a 429 in the middle of a concurrency test is the kind of flake that gets
 * a real defect dismissed. The limit itself is covered where it belongs, in
 * `public-forms.spec.ts`, from one address and as the last test of that file.
 *
 * **No session anywhere.** A suite that logged in first would be proving that
 * an editor can submit, which is not what a participant does. The editor
 * session below exists only to *build* the fixtures through the real routes.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff300-0000-7000-8000-0000000000a0';
const NAME = '019ff300-0000-7000-8000-000000000001';

function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: NAME,
            type: 'text',
            label: 'Name',
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

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

describe('the submission gate ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let startTokens: StartTokenService;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      // See the note at the top of the file.
      env: { TRUST_PROXY_HOPS: 1 },
    });
    /*
     * The server is put on a port **once, here**, and that is not a detail.
     *
     * supertest starts the server itself when it has no address yet — and
     * closes it again when *that* request ends. Sequentially nobody notices;
     * with twenty requests in flight the first one to finish pulls the listener
     * out from under the rest, and they come back as `ECONNRESET`. This is the
     * one requirement in this file that cannot be tested any other way, so the
     * listener belongs to the suite rather than to whichever request happened
     * to arrive first. `app.close()` in `afterAll` takes it down again.
     */
    await new Promise<void>((resolve) => {
      testApp.server.listen(0, resolve);
    });

    // The application's **own** signer, so a token minted in a test is one this
    // server would accept — a second implementation here could keep passing
    // after the real one changed, which is the one thing a test of a signature
    // must not do.
    startTokens = testApp.app.get(StartTokenService);

    tenant = await createTenant(testApp.prisma, 'GATE');
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

  afterEach(() => {
    // Only ever switched on inside the one test that needs a fixed clock; this
    // makes sure a failure there cannot leave the rest of the file frozen.
    vi.useRealTimers();
  });

  /** A published form, through the real routes. */
  async function publishedForm(
    title: string,
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
      .send({ title, definition: definition(), revision: form.revision });
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

  /** The public read — and the token it mints. */
  async function read(slug: string): Promise<request.Response> {
    return request(app().server)
      .get(apiPath(`/public/forms/${slug}`))
      .set('X-Forwarded-For', ownAddress());
  }

  async function startTokenOf(slug: string): Promise<string> {
    const response = await read(slug);
    expect(response.status).toBe(200);
    return (response.body as { startToken: string }).startToken;
  }

  /** One submission, from an address of its own. */
  async function submit(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers: { [NAME]: 'Anton' }, ...body });
  }

  async function rowsOf(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  /**
   * A refusal, checked end to end: the status, the reason, the sentence — and
   * **no new row**.
   *
   * The row count is taken around the call rather than compared against a
   * remembered total, so a test that runs next to another one still measures
   * its own form.
   */
  async function expectRefused(
    form: { id: string; slug: string },
    reason: keyof typeof SUBMISSION_REFUSAL_MESSAGES,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const before = await rowsOf(form.id);
    const response = await submit(form.slug, body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      reason,
      message: SUBMISSION_REFUSAL_MESSAGES[reason],
    });
    expect(await rowsOf(form.id)).toBe(before);
    return response;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Fail closed — the rule the whole stage rests on
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The display path falls back, the enforcement does not.**
   *
   * Unreadable settings degrade to the system defaults where a *page* is
   * rendered, so one bad row cannot take a whole organisation's fill-in pages down
   * during a rolling deploy. That fallback must not be inherited by the code
   * that decides whether an answer is accepted: "unreadable" would then mean
   * "no deadline, no limit, no password", and a registration closed on Sunday
   * would start taking answers again on Monday because somebody deployed.
   *
   * The row is written **straight into the column**, because the API cannot
   * produce it — and that is the point: the writer is a different version of
   * this API.
   */
  describe('unreadable settings (fail closed)', () => {
    async function breakOverride(formId: string): Promise<void> {
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'overridden', jsonb_build_object(
             'access', false, 'confirm', false, 'display', false
           ),
           'values', jsonb_build_object('einstellungAusM9', true)
         ) WHERE "id" = $1::uuid`,
        formId,
      );
    }

    it('refuses the submission and writes nothing, and locks the page instead of 500', async () => {
      const form = await publishedForm('Unlesbare Einstellungen');
      await breakOverride(form.id);

      /*
       * **The display half changed later, deliberately.**
       *
       * Until then this asserted 200 *with the questions*, on the argument that
       * the settings are incidental to a rendered page. This change makes one of them
       * anything but incidental: if "unreadable" degraded to the system
       * defaults here, it would degrade to `passwordEnabled: false`, and a
       * password-protected registration would hand out its questions in the
       * minute its document stopped parsing. That is the fail-open
       * `settings-enforcement.ts` exists to prevent.
       *
       * So the read fails closed too: **still 200, still the organisation and the
       * title, but locked and without a definition**. Two things are worth
       * saying about the trade, because neither is free:
       *
       * - A form that has *no* password now shows a gate nobody can pass while
       *   the document is broken. It is a misleading prompt for a few minutes
       *   of a rolling deploy — against a protected form being readable by
       *   anyone holding the link, which cannot be undone afterwards.
       * - The tolerant path still earns its keep: without it this would be a
       *   500 for every form of the organisation (see the next test), which is strictly
       *   worse than a page that loads and says it needs a word.
       */
      const shown = await read(form.slug);
      expect(shown.status).toBe(200);
      expect(shown.body).toEqual({
        locked: true,
        title: 'Unlesbare Einstellungen',
        tenant: expect.any(Object) as unknown,
      });
      expect(shown.text).not.toContain(NAME);

      // The enforcement half: refused, and counted.
      const before = await rowsOf(form.id);
      const refused = await submit(form.slug);

      expect(refused.status).toBe(503);
      expect(await rowsOf(form.id)).toBe(before);
    });

    /**
     * The organisation's row, which is the worse of the two: one unreadable
     * `form_defaults` reaches **every** form of that organisation.
     */
    it('refuses for every form of an organisation whose standards do not parse', async () => {
      const one = await publishedForm('Organisation unlesbar A');
      const other = await publishedForm('Organisation unlesbar B');
      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaults: true },
      });

      await app().prisma.$executeRawUnsafe(
        `UPDATE "tenant" SET "form_defaults" =
           jsonb_build_object('einstellungAusM9', true)
         WHERE "id" = $1::uuid`,
        tenant.id,
      );

      try {
        for (const form of [one, other]) {
          const rows = await rowsOf(form.id);
          expect((await submit(form.slug)).status).toBe(503);
          expect(await rowsOf(form.id)).toBe(rows);
          /*
           * …and each of them still *renders* — which is the whole point of
           * keeping the tolerant read on the display path. It renders
           * **locked** since that change (see the test above for why), and that is the
           * difference that matters: a page that loads, not a 500 for every
           * form the organisation has.
           */
          const shown = await read(form.slug);
          expect(shown.status).toBe(200);
          expect((shown.body as { locked: unknown }).locked).toBe(true);
        }
      } finally {
        await app().prisma.tenant.update({
          where: { id: tenant.id },
          data: { formDefaults: before.formDefaults ?? {} },
        });
      }
    });

    /**
     * The counter-example that keeps the two apart: an **absent** column is not
     * an unreadable one. A form created before this feature existed has never had its settings touched, and
     * "nothing decided" has to keep meaning "everything open" (no
     * backfill) — a fail-closed reading that also refused *this* would shut
     * every form built earlier.
     */
    it('accepts a form whose settings were never touched', async () => {
      const form = await publishedForm('Ohne Einstellungen');
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = '{}'::jsonb WHERE "id" = $1::uuid`,
        form.id,
      );

      expect((await submit(form.slug)).status).toBe(200);
      expect(await rowsOf(form.id)).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The deadline
  // ═══════════════════════════════════════════════════════════════════════

  describe('die Anmeldefrist', () => {
    it('refuses before the opening instant', async () => {
      const form = await publishedForm('Öffnet später');
      await configure(
        form.id,
        {},
        { openEnabled: true, openAt: '2099-01-01T00:00:00.000Z' },
      );

      await expectRefused(form, 'not_yet_open');
    });

    it('refuses after the closing instant', async () => {
      const form = await publishedForm('Frist vorbei');
      await configure(
        form.id,
        {},
        { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
      );

      await expectRefused(form, 'closed');
    });

    /**
     * **The case the requirement calls the most important one: the browser tab
     * left open.**
     *
     * The form is *read* while it is still open — the payload says so — and
     * submitted after the deadline has passed. What decides is the server's
     * clock at the moment the submission arrives, never the verdict the page
     * was rendered with. Both halves are asserted, because a test that only
     * submitted late would also pass against a form that was closed all along.
     *
     * The wait is real and short: the deadline is set a second and a half into
     * the future, which is the honest way to make "the clock kept running" the
     * only thing that changed between the two requests. Nothing about the
     * settings is touched in between.
     */
    it('refuses a submission from a page that was opened before the deadline', async () => {
      const form = await publishedForm('Offener Tab');
      const closeAt = new Date(Date.now() + 1_500).toISOString();
      await configure(form.id, {}, { openEnabled: true, closeAt });

      const loaded = await read(form.slug);
      expect(loaded.status).toBe(200);
      expect(
        (loaded.body as { availability: { state: string } }).availability,
      ).toMatchObject({ state: 'open' });

      await new Promise((resolve) => setTimeout(resolve, 1_800));

      await expectRefused(form, 'closed');
    });

    /**
     * **Across the daylight-saving boundary** — the case the specification was decided
     * for, and the reason the conversion lives in `packages/shared`.
     *
     * The editor types a wall-clock time: „25.10.2026, 02:30". On the Sunday of
     * the changeover that clock reading happens **twice**, an hour apart.
     * `toInstant` resolves it to the *first* one (still MESZ, UTC+2), which is
     * `00:30Z` — and the enforcement compares against that instant, not against
     * a wall clock it re-derives.
     *
     * So the same displayed time yields opposite verdicts an hour apart, which
     * is precisely what daylight saving means and what a test that stayed
     * inside one season could never show. The server clock is fixed for the two
     * requests (`Date` only — real timers keep running, so supertest is
     * unaffected).
     */
    it('compares against the Berlin wall-clock instant across the autumn changeover', async () => {
      const closeAt = toInstant('2026-10-25T02:30');
      // The first 02:30 of that Sunday, still summer time (UTC+2). If this ever
      // reads 01:30Z the conversion has silently moved to winter time and every
      // deadline of that night is an hour out.
      expect(closeAt).toBe('2026-10-25T00:30:00.000Z');

      const form = await publishedForm('Zeitumstellung');
      await configure(form.id, {}, { openEnabled: true, closeAt });

      vi.useFakeTimers({ toFake: ['Date'] });

      // 02:00 MESZ — half an hour before the deadline. Open.
      vi.setSystemTime(new Date('2026-10-25T00:00:00.000Z'));
      const before = await rowsOf(form.id);
      expect((await submit(form.slug)).status).toBe(200);
      expect(await rowsOf(form.id)).toBe(before + 1);

      // 02:00 MEZ — the *same* clock reading one hour later, after the clocks
      // went back. Past the deadline, and therefore closed.
      vi.setSystemTime(new Date('2026-10-25T01:00:00.000Z'));
      await expectRefused(form, 'closed');
    });

    /** A window that was configured and switched off does not close anything. */
    it('ignores a stored deadline while the switch is off', async () => {
      const form = await publishedForm('Frist ausgeschaltet');
      await configure(
        form.id,
        {},
        { openEnabled: false, closeAt: '2020-01-01T00:00:00.000Z' },
      );

      expect((await submit(form.slug)).status).toBe(200);
    });

    /**
     * **An organisation cannot set a deadline** — review finding 10
     * (ADR-0011, continuation 2026-08-14), measured at the route.
     *
     * The opposite case stood here: a deadline of the organisation which a
     * form inherits that has never touched its *availability*. That
     * inheritance no longer exists, and the route says so — 400 with the field
     * name, not a value that silently disappears and leaves a form open that
     * somebody believed to be closed.
     */
    it('refuses a deadline in the organisation’s standards', async () => {
      const organisation = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        select: { formDefaultsRevision: true },
      });

      const refused = await request(app().server)
        .put(apiPath('/tenant/form-defaults'))
        .set(authedMutation(editor))
        .send({
          values: { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
          revision: organisation.formDefaultsRevision,
        });

      expect(refused.status).toBe(400);
      expect(refused.text).toContain('closeAt');

      // …and the form that would have "inherited" the deadline goes on accepting.
      const form = await publishedForm('Erbt keine Frist');
      expect((await submit(form.slug)).status).toBe(200);
    });

    /**
     * The gates come **before** the answer check, and this is the observable
     * consequence: someone submitting rubbish to a closed form is told it is
     * closed. The other order would answer 400 about a field on a form that
     * cannot be handed in at all.
     */
    it('says „geschlossen" rather than picking holes in the answers', async () => {
      const form = await publishedForm('Zuerst die Frist');
      await configure(
        form.id,
        {},
        { openEnabled: true, closeAt: '2020-01-01T00:00:00.000Z' },
      );

      // An empty required field — a guaranteed 400 on an open form.
      await expectRefused(form, 'closed', { answers: { [NAME]: '' } });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The time limit
  // ═══════════════════════════════════════════════════════════════════════

  describe('das Zeitlimit', () => {
    /** A form with a five-minute limit. */
    async function timeLimited(title: string) {
      const form = await publishedForm(title);
      await configure(form.id, {}, { timeLimitEnabled: true, timeLimitMin: 5 });
      return form;
    }

    it('accepts a submission that started just now', async () => {
      const form = await timeLimited('Rechtzeitig');

      const response = await submit(form.slug, {
        startToken: await startTokenOf(form.slug),
      });

      expect(response.status).toBe(200);
      expect(await rowsOf(form.id)).toBe(1);
    });

    /**
     * A token that is genuinely too old — minted by the application's own
     * signer with an issue instant six minutes back, so it is *valid* in every
     * respect except its age. Waiting five real minutes would be the same
     * assertion at four hundred times the cost.
     */
    it('refuses a token older than the limit', async () => {
      const form = await timeLimited('Zu lange gebraucht');
      const stale = startTokens.issue(
        form.slug,
        new Date(Date.now() - 6 * 60_000),
      );

      await expectRefused(form, 'time_limit', { startToken: stale });
    });

    it('accepts one that is inside the limit but not fresh', async () => {
      const form = await timeLimited('Vier Minuten gebraucht');
      const token = startTokens.issue(
        form.slug,
        new Date(Date.now() - 4 * 60_000),
      );

      expect((await submit(form.slug, { startToken: token })).status).toBe(200);
    });

    /**
     * **The signature is checked, the content is not believed** — the sentence
     * the requirement puts it in.
     *
     * Three ways to try, and all three are the same refusal: a token built by
     * hand with a fresh-looking instant, one of ours with a flipped signature
     * byte, and one of ours whose instant was rewritten to *now* after signing.
     * The last is the interesting one: its payload would pass every check that
     * looked at the payload.
     */
    it('refuses a self-built, a tampered and a rewritten token alike', async () => {
      const form = await timeLimited('Selbstgebaut');
      const genuine = startTokens.issue(
        form.slug,
        new Date(Date.now() - 6 * 60_000),
      );
      const [, , signature = ''] = genuine.split('.');

      const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
      const rewritten = `s1.${Date.now().toString(36)}.${signature}`;

      for (const token of [
        // Made up entirely — a plausible shape and a fresh instant.
        `s1.${Date.now().toString(36)}.ZGFzLWlzdC1rZWluZS1zaWduYXR1cg`,
        // Ours, with one character of the MAC changed.
        `s1.${genuine.split('.')[1] ?? ''}.${flipped}`,
        // Ours, with the instant moved forward and the MAC left alone.
        rewritten,
      ]) {
        await expectRefused(form, 'time_limit', { startToken: token });
      }
    });

    /**
     * **A token from the future is tolerated, not believed indefinitely.**
     *
     * `elapsedMs <= limit` alone let *every* negative age through, which is not
     * the same promise as "be forgiving about clocks": with two replicas whose
     * clocks have drifted apart, A issues and B receives, and the time limit is
     * then simply not enforced for that attempt — no matter how long the
     * participant takes. No attack (the signature holds either way), but a
     * setting that quietly stops applying.
     *
     * The pair is the point: a minute ahead is drift and passes, an hour ahead
     * is not a clock this installation has and is refused.
     */
    it.each([
      ['a minute ahead of the server', 60_000, 200],
      ['an hour ahead of the server', 60 * 60_000, 409],
    ])('treats a token %s', async (_name, aheadMs, expected) => {
      const form = await timeLimited(`Zukunft ${String(aheadMs)}`);
      const ahead = startTokens.issue(
        form.slug,
        new Date(Date.now() + aheadMs),
      );

      const response = await submit(form.slug, { startToken: ahead });

      expect(response.status).toBe(expected);
      if (expected === 409) {
        expect(response.body).toMatchObject({ reason: 'time_limit' });
        expect(await rowsOf(form.id)).toBe(0);
      }
    });

    /**
     * A perfectly valid token — for a **different form**. The token is bound to
     * the address it was minted on, so a participant cannot open a form without
     * a limit, take its token and use it to sit on a limited one indefinitely.
     */
    it('refuses a token minted for another form', async () => {
      const form = await timeLimited('Eigenes Formular');
      const elsewhere = await publishedForm('Fremdes Formular');

      await expectRefused(form, 'time_limit', {
        startToken: await startTokenOf(elsewhere.slug),
      });
    });

    it('refuses a submission that carries no token at all', async () => {
      const form = await timeLimited('Ohne Token');

      await expectRefused(form, 'time_limit');
    });

    /**
     * And the other half, without which the tests above would be satisfied by a
     * server that simply refuses everything: with the time limit off, the token
     * is not consulted. A missing one, a stale one and a forged one all pass.
     */
    it('ignores the token entirely while no time limit is set', async () => {
      const form = await publishedForm('Kein Zeitlimit');

      for (const body of [
        {},
        { startToken: startTokens.issue(form.slug, new Date(0)) },
        { startToken: 's1.abcdef.KeineEchteSignatur' },
      ]) {
        expect((await submit(form.slug, body)).status).toBe(200);
      }
      expect(await rowsOf(form.id)).toBe(3);
    });

    /**
     * The read hands one out for **every** form, including one without a time
     * limit — the presence of the field must not disclose the setting.
     */
    it('mints a token for a form that has no time limit either', async () => {
      const form = await publishedForm('Token trotzdem');

      expect(await startTokenOf(form.slug)).toMatch(/^s1\./);
    });

    /** Two reads are two attempts — the reload gap, stated as a test. */
    it('mints a fresh token on every read', async () => {
      const form = await timeLimited('Neu geladen');

      const first = await startTokenOf(form.slug);
      // The instant is in milliseconds, so two reads inside the same one would
      // legitimately produce the same token; a short pause makes the assertion
      // about the mechanism rather than about scheduling.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await startTokenOf(form.slug);

      expect(second).not.toBe(first);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The response limit, under concurrency
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The requirement — "the response limit holds under concurrency too".
   *
   * **The two probes below are the requirement's own point.** The sequential one
   * is the *control*: it stays green under the naive implementation
   * (`count()`, then `insert()`), which is why a suite containing only it would
   * say nothing about concurrency. The concurrent one is the assertion, and it
   * is the one that goes red the moment the counting stops being transactional.
   *
   * Reenacted, not assumed — replacing `storeWithinLimit`'s transaction with a
   * plain count-then-insert leaves the sequential test green and overbooks the
   * concurrent one.
   */
  describe('das Antwortlimit', () => {
    const LIMIT = 10;
    const ATTEMPTS = 20;

    async function limited(title: string) {
      const form = await publishedForm(title);
      await configure(
        form.id,
        {},
        { maxResponsesEnabled: true, maxResponses: LIMIT },
      );
      return form;
    }

    /** How many of a batch were accepted and how many refused. */
    function tally(responses: readonly request.Response[]) {
      return {
        accepted: responses.filter((one) => one.status === 200).length,
        refused: responses.filter((one) => one.status === 409).length,
        reasons: new Set(
          responses
            .filter((one) => one.status === 409)
            .map((one) => (one.body as { reason: string }).reason),
        ),
      };
    }

    /**
     * The control. One after the other, twenty attempts against ten places.
     *
     * It is here to be *compared* with the test below, and it is written to be
     * green under the naive implementation on purpose: that is what makes the
     * pair evidence about concurrency rather than about arithmetic.
     */
    it('stops at the limit when the submissions arrive one by one', async () => {
      const form = await limited('Nacheinander');

      const responses: request.Response[] = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        responses.push(await submit(form.slug));
      }

      expect(tally(responses)).toMatchObject({
        accepted: LIMIT,
        refused: ATTEMPTS - LIMIT,
      });
      expect(await rowsOf(form.id)).toBe(LIMIT);
    });

    /**
     * **The assertion.** Twenty submissions let go at once against a limit of
     * ten — the burst the specification expects at a registration start.
     *
     * All twenty requests are in flight before any of them is awaited, so the
     * counting and the inserting genuinely interleave. Afterwards there are
     * exactly ten rows, ten answers are 409, and all ten carry the **same**
     * refusal — the requirement asks for that word for word, and a mixture of
     * reasons would mean something other than the limit had fired.
     */
    it('never exceeds the limit when twenty arrive at once', async () => {
      const form = await limited('Gleichzeitig');

      const responses = await Promise.all(
        Array.from({ length: ATTEMPTS }, () => submit(form.slug)),
      );

      const counted = tally(responses);
      expect(counted.accepted).toBe(LIMIT);
      expect(counted.refused).toBe(ATTEMPTS - LIMIT);
      expect([...counted.reasons]).toEqual(['limit_reached']);
      // The row count is the claim; the statuses are how it was reported.
      expect(await rowsOf(form.id)).toBe(LIMIT);
    }, 60_000);

    /**
     * A form **without** a limit takes the same burst without a lock and
     * without losing anything — the guard is paid for by the setting that asks
     * for it, and "no limit" must not quietly become one.
     */
    it('accepts a concurrent burst on a form that has no limit', async () => {
      const form = await publishedForm('Ohne Limit');

      const responses = await Promise.all(
        Array.from({ length: ATTEMPTS }, () => submit(form.slug)),
      );

      expect(tally(responses).accepted).toBe(ATTEMPTS);
      expect(await rowsOf(form.id)).toBe(ATTEMPTS);
    }, 60_000);
  });
});
