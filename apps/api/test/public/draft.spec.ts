import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_DRAFTS_PER_FORM,
  TRASH_RETENTION_DAYS,
  UNCLAIMED_FILE_LIFETIME_MS,
} from '@formsache/shared';

import { REFERRER_POLICY } from '../../src/common/no-store';
import { PublicFormsModule } from '../../src/public/public-forms.module';
import {
  PUBLIC_UPLOAD_DOORS,
  PUBLIC_UPLOAD_RATE_LIMIT,
} from '../../src/public/public-forms.rate-limit';
import {
  PUBLIC_FORM_NOT_FOUND_MESSAGE,
  SUBMISSION_REFUSAL_MESSAGES,
} from '../../src/public/public-forms.service';
import { RetentionPurgeService } from '../../src/trash/purge/retention-purge.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { MutableClock } from '../mail/mail-test-context';
import {
  TEST_PUBLIC_BASE_URL,
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
 * The requirement — **Zwischenspeichern: a draft on the server, the link
 * stands on the screen, and *no* mail goes out.**
 *
 * Everything here goes at the public routes past the browser. The four counting
 * assertions of the evidence (Antwortlimit, `takenSeats`, Auswertung, Export) are
 * measured **around** a saved draft, because that is the one claim a flag on
 * `response` would have broken in several places at once — and the one a suite
 * that only checked „the draft is saved" would never see.
 *
 * ## The two things this file is built around
 *
 * **The clock is injected and moved by hand.** the evidence is „29 days stays,
 * 31 is gone", measured *over the route* — so the boundary has to be written by
 * a calendar a test can move, and the read has to consult the same one. No test
 * here sleeps.
 *
 * **`TRUST_PROXY_HOPS: 1` plus a distinct `X-Forwarded-For` per request**, like
 * the submission gate next door: the write routes allow 30 requests a minute per
 * address, and a suite that spent them on fixtures would be measuring the rate
 * limit rather than the requirement.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff600-0000-7000-8000-0000000000a0';
const NAME = '019ff600-0000-7000-8000-000000000001';
const SEMESTER = '019ff600-0000-7000-8000-000000000002';
const EVENTS = '019ff600-0000-7000-8000-000000000003';
/** The three composite Pflicht types of a review finding — each on a page of its own form. */
const COMPOSITE_PAGE = '019ff600-0000-7000-8000-0000000000b0';
const ADDRESS = '019ff600-0000-7000-8000-000000000011';
const MATRIX = '019ff600-0000-7000-8000-000000000012';
const TABLE = '019ff600-0000-7000-8000-000000000013';

const DAY_MS = 86_400_000;

/** Documentation range (RFC 5737) — never a real caller. */
let nextAddress = 0;
function ownAddress(): string {
  nextAddress += 1;
  return `198.51.100.${String((nextAddress % 250) + 1)}`;
}

/**
 * One Pflicht-Textfrage with a Muster, one Pflicht-Zahl with bounds, and a
 * Veranstaltung with an Obergrenze.
 *
 * All three are deliberate: the Pflicht questions are what a draft is allowed to
 * leave empty, their rules are what it is **not** allowed to break, and the
 * Veranstaltung is what proves a draft occupies no seat.
 */
function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        description: null,
        questions: [
          {
            id: NAME,
            type: 'text',
            label: 'Kürzel',
            hint: null,
            required: true,
            width: 'full',
            minLength: 2,
            maxLength: 4,
            pattern: '^[A-Z]+$',
          },
          {
            id: SEMESTER,
            type: 'number',
            label: 'Semester',
            hint: null,
            required: true,
            width: 'full',
            min: 1,
            max: 30,
            integer: true,
          },
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
                capacity: 10,
                showRemaining: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * **The three composite Pflicht types** (a review finding).
 *
 * A form of their own rather than three more questions on {@link definition}:
 * they are `required`, so every other submission in this file would have to
 * answer them, and the file's other assertions are about something else.
 */
function compositeDefinition() {
  const base = { hint: null, required: true, width: 'full' } as const;
  return {
    pages: [
      {
        id: COMPOSITE_PAGE,
        title: 'Zusammengesetzt',
        description: null,
        questions: [
          { ...base, id: ADDRESS, type: 'address', label: 'Anschrift' },
          {
            ...base,
            id: MATRIX,
            type: 'matrix',
            label: 'Bewertung',
            rows: [
              { value: 'organisation', label: 'Organisation' },
              { value: 'programm', label: 'Programm' },
            ],
            columns: [{ value: 'gut', label: 'Gut' }],
            multiple: false,
          },
          {
            ...base,
            id: TABLE,
            type: 'table',
            label: 'Begleitpersonen',
            columns: [{ key: 'name', label: 'Name', type: 'text' }],
            rows: 2,
          },
        ],
      },
    ],
  };
}

describe('Zwischenspeichern', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let clock: MutableClock;

  const app = (): TestApp => testApp;
  const purge = (): RetentionPurgeService =>
    testApp.app.get(RetentionPurgeService);

  beforeAll(async () => {
    database = await acquireTestDatabase();
    clock = new MutableClock(new Date());
    testApp = await createTestApp({
      databaseUrl: database.url,
      // The installation's own address is a **row**. A suite that
      // asserts on an absolute address has to put one there — which is also what
      // makes „if it is missing, there is no address" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      // The one injected calendar (`mail-clock.ts`), which the draft's expiry is
      // written from and its resume is judged against.
      clock,
      env: { TRUST_PROXY_HOPS: 1 },
    });

    tenant = await createTenant(testApp.prisma, 'DRAFT');
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

  // ─── fixtures, through the real routes ──────────────────────────────────

  async function publishedForm(
    title: string,
    schema: unknown = definition(),
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
      .send({ title, definition: schema, revision: form.revision });
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

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

  /**
   * The organisation's standard — the **second** write path of the
   * specification.
   *
   * A patch and no more switches (review finding 10): an organisation has a
   * complete set of values, and what changes is written.
   */
  async function configureTenant(
    values: Record<string, unknown>,
  ): Promise<void> {
    const tenantRow = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { formDefaultsRevision: true },
    });
    const response = await request(app().server)
      .put(apiPath('/tenant/form-defaults'))
      .set(authedMutation(editor))
      .send({ values, revision: tenantRow.formDefaultsRevision });
    expect(response.status).toBe(200);
  }

  async function saveDraft(
    slug: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/drafts`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function readDraft(token: string): Promise<request.Response> {
    return request(app().server)
      .get(apiPath(`/public/drafts/${token}`))
      .set('X-Forwarded-For', ownAddress());
  }

  async function writeDraft(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/drafts/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function submit(
    slug: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send(body);
  }

  function tokenOf(draftUrl: string): string {
    const token = draftUrl.slice(draftUrl.lastIndexOf('/') + 1);
    expect(token).not.toBe('');
    return token;
  }

  /** A form with *Zwischenspeichern* on, and one draft saved against it. */
  async function draftable(title: string): Promise<{
    form: { id: string; slug: string };
    token: string;
    draftUrl: string;
    expiresAt: string;
  }> {
    const form = await publishedForm(title);
    await configure(form.id, { access: true }, { allowSaveDraft: true });

    const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
    expect(saved.status).toBe(200);
    const body = saved.body as { draftUrl: string; expiresAt: string };
    return {
      form,
      token: tokenOf(body.draftUrl),
      draftUrl: body.draftUrl,
      expiresAt: body.expiresAt,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the address stands on the screen, and no mail goes out
  // ═══════════════════════════════════════════════════════════════════════

  describe('die Adresse', () => {
    it('kommt absolut aus der Basis-Adresse, nicht aus dem Request-Host', async () => {
      const form = await publishedForm('Entwurf-Adresse');
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const saved = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/drafts`))
        .set('X-Forwarded-For', ownAddress())
        .set('Host', 'angreifer.invalid')
        .send({ answers: { [NAME]: 'ABC' } });

      expect(saved.status).toBe(200);
      const { draftUrl } = saved.body as { draftUrl: string };
      expect(draftUrl.startsWith(`${TEST_PUBLIC_BASE_URL}/e/`)).toBe(true);
      expect(draftUrl).not.toContain('angreifer.invalid');
    });

    /**
     * The specification, in one assertion: **no mail goes out.** The trigger
     * „Zwischenspeichern" is not built, so a saved draft must leave the
     * mail log exactly as it found it — including the case where the
     * form has a notification that fires on submission.
     */
    it('reiht nichts in die Mail-Queue ein', async () => {
      const { form } = await draftable('Entwurf-ohne-Mail');
      expect(
        await app().prisma.mailLog.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    /**
     * The other half of the evidence, and the half the *view* owns: without this
     * field the fill-in view cannot leave the button off, so it would offer an
     * action that answers 409. It is a statement about the **view** — `false` on
     * the edit page of a submitted answer even where the form allows saving.
     */
    it('sagt der Ausfüllansicht, ob es das Bedienelement überhaupt geben darf', async () => {
      const off = await publishedForm('Entwurf-Schalter-aus');
      // Switched off, not unset — since review finding 16 the application's
      // default is „on", and this case measures both positions.
      await configure(off.id, { access: true }, { allowSaveDraft: false });
      const readOff = await request(app().server)
        .get(apiPath(`/public/forms/${off.slug}`))
        .set('X-Forwarded-For', ownAddress());
      expect((readOff.body as { canSaveDraft: boolean }).canSaveDraft).toBe(
        false,
      );

      await configure(off.id, { access: true }, { allowSaveDraft: true });
      const readOn = await request(app().server)
        .get(apiPath(`/public/forms/${off.slug}`))
        .set('X-Forwarded-For', ownAddress());
      expect((readOn.body as { canSaveDraft: boolean }).canSaveDraft).toBe(
        true,
      );

      // …and the resume of a draft says `true` by construction.
      const { token } = await draftable('Entwurf-Schalter-Ansicht');
      const resumed = await readDraft(token);
      expect(
        (resumed.body as { form: { canSaveDraft: boolean } }).form.canSaveDraft,
      ).toBe(true);
    });

    it('nennt das Ende der Frist als Zeitpunkt, nicht als Anzahl Tage', async () => {
      const { expiresAt } = await draftable('Entwurf-Frist');
      expect(new Date(expiresAt).getTime()).toBe(
        clock.now().getTime() + TRASH_RETENTION_DAYS * DAY_MS,
      );
    });

    /**
     * **The closed list of this payload**, as the read payload next door
     * already has it — and the nail on `token` (a review finding).
     *
     * The token names the draft just written and is what makes the second
     * press on *Zwischenspeichern* a `PUT` instead of a second `POST`. It
     * gives away nothing the address does not already give — it *is* its last
     * path segment —, and exactly that is measured here so that the two
     * cannot drift apart.
     */
    it('trägt genau drei Schlüssel, und der Token ist der Adresse', async () => {
      const form = await publishedForm('Entwurf-Speicher-Schlüssel');
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(saved.status).toBe(200);
      const body = JSON.parse(saved.text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'draftUrl',
        'expiresAt',
        'token',
      ]);
      expect(body.token).toBe(tokenOf(body.draftUrl as string));

      // And when writing on it is the same token: a `PUT` replaces a draft, it
      // does not move it to a new address.
      const written = await writeDraft(body.token as string, {
        [NAME]: 'ABC',
        [SEMESTER]: 4,
      });
      expect(written.status).toBe(200);
      expect((written.body as { token: string }).token).toBe(body.token);
      expect((written.body as { draftUrl: string }).draftUrl).toBe(
        body.draftUrl,
      );
    });

    /**
     * **One participant, one draft, one row** — the server side of
     * a review finding (2026-08-05).
     *
     * The fill-in view passed every press through as a `POST`, because the
     * payload carried no token. *Measured:* pressed twice → two addresses,
     * `responseDraft.count === 2`, and the first row lived on for thirty days
     * with an older set of personal data. This is the promise the view is
     * built against: with the token from the answer it stays **one** row with
     * the **newest** state.
     */
    it('bleibt beim Weiterschreiben eine einzige Zeile mit dem neuesten Stand', async () => {
      const form = await publishedForm('Entwurf-eine-Zeile');
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const first = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(first.status).toBe(200);
      const { token } = first.body as { token: string };

      const second = await writeDraft(token, { [NAME]: 'ABCD' });
      expect(second.status).toBe(200);

      const rows = await app().prisma.responseDraft.findMany({
        where: { formId: form.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.answers).toStrictEqual({ [NAME]: 'ABCD' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — opened in another context it shows the typed values
  // ═══════════════════════════════════════════════════════════════════════

  describe('der Gerätewechsel', () => {
    it('gibt die getippten Werte an einen Aufrufer ohne jede Vorgeschichte zurück', async () => {
      const { token } = await draftable('Entwurf-Gerätewechsel');

      // No cookie, no access proof, no prior read of the form — a second
      // browser holding nothing but the address.
      const resumed = await readDraft(token);
      expect(resumed.status).toBe(200);
      const body = resumed.body as {
        form: { definition: unknown; startToken: string };
        answers: Record<string, unknown>;
      };
      expect(body.answers).toStrictEqual({ [NAME]: 'ABC' });
      // The whole form comes with it — that is what makes it fillable there.
      expect(body.form.definition).toBeTruthy();
      // A fresh attempt, so a fresh start token: the time limit of a form
      // that has one runs from the resume, not from the sitting that was broken
      // off.
      expect(body.form.startToken.length).toBeGreaterThan(0);
    });

    it('nimmt weitere Eingaben unter derselben Adresse an', async () => {
      const { token } = await draftable('Entwurf-weiterfüllen');

      const written = await writeDraft(token, {
        [NAME]: 'ABC',
        [SEMESTER]: 4,
      });
      expect(written.status).toBe(200);

      const resumed = await readDraft(token);
      expect((resumed.body as { answers: unknown }).answers).toStrictEqual({
        [NAME]: 'ABC',
        [SEMESTER]: 4,
      });
    });

    /**
     * **The closed list of this payload** (a review finding) — the third public read payload, and up to here the
     * only one without this nail, although it hands out the **complete field
     * definition** without a session.
     *
     * The literal *is* the expectation; a list derived from the answer would
     * agree with everything the server sends. If a field is added, this line
     * turns red and somebody has to justify why strangers get it.
     */
    it('trägt genau die dokumentierten Schlüssel, oben und im Formular', async () => {
      const { form, token } = await draftable('Entwurf-Schlüsselliste');

      const answered = await readDraft(token);
      expect(answered.status).toBe(200);
      const body = JSON.parse(answered.text) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual([
        'answers',
        // a review finding of the security review on the door commit: whether
        // the references in `answers` still name anything, and for how much
        // longer. Without this key the payload hands out an attachment long
        // since collected as „attached" for thirty days, and the participant
        // learns of it only at the `409` of their submission.
        'attachments',
        'expiresAt',
        'form',
        'formSlug',
        'savedAt',
      ]);
      // Empty for a form without a file question — and an array, not
      // `undefined`: the client does not distinguish „no attachments" from
      // „not answered".
      expect(body.attachments).toStrictEqual([]);
      // the evidence — the address the submission goes to. The token names the
      // draft, not the form, and the address is deliberately derivable from no
      // id: without this key a resumed draft is readable and writable, but
      // **not submittable**.
      expect(body.formSlug).toBe(form.slug);
      // The same document `GET /public/forms/:slug` delivers — so the same
      // twelve keys, `locked` included.
      const formPayload = body.form as Record<string, unknown>;
      expect(Object.keys(formPayload).sort()).toEqual([
        'availability',
        'canSaveDraft',
        'definition',
        'display',
        'eventSeats',
        'locked',
        // **The privacy notice of this form** (ADR-0028 no. 4) — the one key
        // of this list that was written expressly to be read by the
        // participating person. It does not bind them and wards off nothing; it
        // is the information Art. 13 Abs. 1 DSGVO demands „zum Zeitpunkt der
        // Erhebung", and withholding it would not be data minimisation but the
        // breach of duty itself. `null` means „nothing stored".
        'privacyNotice',
        'startToken',
        'tenant',
        // The time limit (finding 32), and on **this** route it is what
        // otherwise surprises hardest: resuming mints a fresh start proof, so
        // the minutes run from the return. Whoever carries on a week later has
        // to be able to read that before they type.
        'timeLimitMin',
        'title',
        'version',
      ]);
    });

    /**
     * **`Referrer-Policy: no-referrer`** (a review finding). This
     * address carries its authorisation in the path — exactly like the
     * Bearbeiten-Link —, and without this header a browser hands it to
     * everyone the participant clicks next. The page itself and the
     * nginx template are nailed down in `@formsache/shared`
     * (`referrer-policy.test.ts`); here stands the API side.
     */
    it('antwortet mit einer Referrer-Policy, die nichts hinausträgt', async () => {
      const { token } = await draftable('Entwurf-Referrer');
      const answered = await readDraft(token);
      expect(answered.headers['referrer-policy']).toBe(REFERRER_POLICY);
      // On the refusal too: a 404 is the answer a guessed token gets, and it
      // goes to the same browsers.
      expect(
        (await readDraft('AAAAAAAAAAAAAAAAAAAAAA')).headers['referrer-policy'],
      ).toBe(REFERRER_POLICY);
    });

    /**
     * The one 404 of the public routes, for a token that is malformed, unknown
     * or belongs to nobody. Byte-identical to every other „does not exist", so
     * a guessed address cannot tell „this draft exists" from „this one not".
     */
    it.each([
      ['unbekannt', 'AAAAAAAAAAAAAAAAAAAAAA'],
      ['missgestaltet', 'nicht%00erlaubt'],
      ['zu lang', 'x'.repeat(500)],
    ])('antwortet auf ein %s-Token mit dem einen 404', async (_name, token) => {
      const answered = await readDraft(token);
      expect(answered.status).toBe(404);
      expect((answered.body as { message: string }).message).toBe(
        PUBLIC_FORM_NOT_FOUND_MESSAGE,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — switch off: the route answers refusing, on EVERY access
  // ═══════════════════════════════════════════════════════════════════════

  describe('der Schalter', () => {
    it('lehnt das Speichern ab, solange Zwischenspeichern aus ist', async () => {
      const form = await publishedForm('Entwurf-aus');
      // **Switched off, not unset** (review finding 16): since 2026-08-17 the
      // application's default is „on", so this case has to produce the state it
      // is about — otherwise from now on it would check the opposite and would
      // still have been green as long as the default was „off".
      await configure(form.id, { access: true }, { allowSaveDraft: false });
      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });

      expect(saved.status).toBe(409);
      expect(saved.body).toMatchObject({
        reason: 'saving_disabled',
        message: SUBMISSION_REFUSAL_MESSAGES.saving_disabled,
      });
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    /**
     * **The reconstruction of the fourth trap.** The setting is evaluated on
     * *every* access and not when the address was handed out: a draft saved
     * while the switch was on stops opening the moment it is switched off.
     *
     * A route that only checked at issuing time answers 200 here — which is what
     * makes this the assertion that would go red.
     */
    it('lehnt Lesen und Weiterschreiben ab, sobald der Schalter umgelegt wird', async () => {
      const { form, token } = await draftable('Entwurf-nachträglich-aus');
      expect((await readDraft(token)).status).toBe(200);

      await configure(form.id, { access: true }, { allowSaveDraft: false });

      const read = await readDraft(token);
      expect(read.status).toBe(409);
      expect(read.body).toMatchObject({ reason: 'saving_disabled' });

      const written = await writeDraft(token, { [NAME]: 'ABCD' });
      expect(written.status).toBe(409);
      expect(written.body).toMatchObject({ reason: 'saving_disabled' });

      // Refused, and nothing written: the stored answers are the ones from
      // before the switch.
      const row = await app().prisma.responseDraft.findFirstOrThrow({
        where: { formId: form.id },
      });
      expect(row.answers).toStrictEqual({ [NAME]: 'ABC' });
    });

    /**
     * **After the deadline the form accepts no draft any more — and the
     * existing one is gone.**
     *
     * The two answers are different, and since a review finding that is a
     * statement about two things: the *saving* hits the refusal chain
     * (`closed`), the *existing draft* died with the deadline — the settings
     * pull `expires_at` after them —, and an expired address answers the one
     * 404 like every other. Before, `closed` stood here twice, because the row
     * kept the old deadline: 29 days past the deadline the specification
     * promises.
     */
    it('lehnt Speichern nach Fristende ab und nimmt den Entwurf mit', async () => {
      const { form, token } = await draftable('Entwurf-Frist-vorbei');

      await configure(
        form.id,
        // **Both sections**, because a `PUT` replaces the whole override: an
        // `access: false` here would put *Zwischenspeichern* back on the organisation's
        // standard, and the refusal under test would be `saving_disabled`
        // rather than the deadline's.
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: new Date(Date.now() - 60_000).toISOString(),
        },
      );

      const read = await readDraft(token);
      expect(read.status).toBe(404);
      expect((read.body as { message: string }).message).toBe(
        PUBLIC_FORM_NOT_FOUND_MESSAGE,
      );
      expect(
        (await saveDraft(form.slug, { [NAME]: 'ABC' })).body,
      ).toMatchObject({ reason: 'closed' });
    });

    /**
     * The password gate is link 3 of the save's chain, **in front of** the
     * switch: somebody without the word learns that a gate is there and nothing
     * about the state of the registration behind it.
     */
    it('verlangt das Zugangswort, bevor es überhaupt über den Schalter spricht', async () => {
      const form = await publishedForm('Entwurf-Zugangswort');
      await configure(
        form.id,
        { access: true },
        // Deliberately *off*: a caller without the word must still hear
        // „password_required" and never „saving_disabled".
        {
          allowSaveDraft: false,
          passwordEnabled: true,
          password: 'Fuxenstall-2026',
        },
      );

      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(saved.status).toBe(409);
      expect(saved.body).toMatchObject({ reason: 'password_required' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — a draft is NOT a response: four counts
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The first trap, measured in all four places at once.** A draft stored as a
   * flagged `response` would have to be excluded by a `WHERE` in each of them;
   * stored in a table of its own, all four are right because the row is not
   * there. These assertions are what would go red if it ever moved.
   */
  describe('ein Entwurf ist keine Antwort', () => {
    it('zählt nicht gegen das Antwortlimit', async () => {
      const form = await publishedForm('Entwurf-Antwortlimit');
      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          maxResponsesEnabled: true,
          maxResponses: 1,
        },
      );

      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(saved.status).toBe(200);

      // The public read's verdict — the number a participant is shown.
      const read = await request(app().server)
        .get(apiPath(`/public/forms/${form.slug}`))
        .set('X-Forwarded-For', ownAddress());
      expect(
        (read.body as { availability: { state: string } }).availability.state,
      ).toBe('open');

      // And the enforcement: the one place left is still free.
      const submitted = await submit(form.slug, {
        answers: { [NAME]: 'XYZ', [SEMESTER]: 3 },
      });
      expect(submitted.status).toBe(200);
    });

    it('belegt keine Veranstaltungsplätze', async () => {
      const form = await publishedForm('Entwurf-Plätze');
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const saved = await saveDraft(form.slug, {
        [NAME]: 'ABC',
        [EVENTS]: { seats: { konzert: 4 } },
      });
      expect(saved.status).toBe(200);

      // The normalised table the Obergrenze is summed over — a draft writes no
      // row into it, because nothing outside the submission and the edit path
      // ever does.
      expect(
        await app().prisma.eventRegistration.count({
          where: { formId: form.id },
        }),
      ).toBe(0);

      // …and the figure a participant is shown is the untouched one.
      const read = await request(app().server)
        .get(apiPath(`/public/forms/${form.slug}`))
        .set('X-Forwarded-For', ownAddress());
      expect(
        (read.body as { eventSeats: { remaining?: number }[] }).eventSeats,
      ).toStrictEqual([
        {
          questionId: EVENTS,
          eventKey: 'konzert',
          full: false,
          remaining: 10,
        },
      ]);
    });

    it('erscheint nicht in der Auswertung und nicht im Export', async () => {
      const form = await publishedForm('Entwurf-Auswertung');
      await configure(form.id, { access: true }, { allowSaveDraft: true });
      expect((await saveDraft(form.slug, { [NAME]: 'ABC' })).status).toBe(200);

      const listed = await request(app().server)
        .get(apiPath(`/forms/${form.id}/responses`))
        .set(authedMutation(editor));
      expect(listed.status).toBe(200);
      expect(listed.body).toStrictEqual([]);

      const exported = await request(app().server)
        .get(apiPath(`/forms/${form.id}/export.csv`))
        .set(authedMutation(editor));
      expect(exported.status).toBe(200);
      // Header line only — no data row, and „ABC" nowhere in the file.
      expect(exported.text).not.toContain('ABC');
      expect(exported.text.trimEnd().split('\n')).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — 29 days stays, 31 days is gone (injected clock, over the route)
  // ═══════════════════════════════════════════════════════════════════════

  describe('die Frist', () => {
    it('hält einen Entwurf nach 29 Tagen und lässt ihn nach 31 verschwinden', async () => {
      const start = clock.now();
      const { token } = await draftable('Entwurf-30-Tage');

      clock.set(new Date(start.getTime() + 29 * DAY_MS));
      expect((await readDraft(token)).status).toBe(200);

      clock.set(new Date(start.getTime() + 31 * DAY_MS));
      const gone = await readDraft(token);
      expect(gone.status).toBe(404);
      expect((gone.body as { message: string }).message).toBe(
        PUBLIC_FORM_NOT_FOUND_MESSAGE,
      );

      clock.set(start);
    });

    /**
     * The **row is still there** when the route refuses — which is the point of
     * enforcing the boundary on every access rather than leaving it to a purge:
     * a purge that is late must not hand anything out.
     */
    it('lehnt einen abgelaufenen Entwurf ab, auch bevor ihn ein Purge entfernt', async () => {
      const start = clock.now();
      const { form, token } = await draftable('Entwurf-abgelaufen');

      clock.set(new Date(start.getTime() + 31 * DAY_MS));
      expect((await readDraft(token)).status).toBe(404);
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(1);

      clock.set(start);
    });

    /**
     * **An expired draft does not cost the submission** — and this case
     * stands here because a comment at first claimed the opposite: that the
     * refusal `draft_already_submitted` hits „an expired or revoked draft"
     * just the same.
     *
     * It does not. In the `DELETE` that consumes the draft there is **no**
     * deadline predicate: the row lies there until the purge, so it is matched
     * and deleted, and the submission goes through. That is also the right
     * outcome — whoever submits now is measured against `availabilityOf`, not
     * against the moment at which they once saved a draft.
     */
    it('lässt eine Absendung aus einem abgelaufenen Entwurf durch', async () => {
      const start = clock.now();
      const { form, token } = await draftable('Entwurf-abgelaufen-absenden');

      clock.set(new Date(start.getTime() + 31 * DAY_MS));
      // The read is shut — the submission nonetheless is not.
      expect((await readDraft(token)).status).toBe(404);

      const sent = await submit(form.slug, {
        answers: { [NAME]: 'XYZ', [SEMESTER]: 2 },
        draftToken: token,
      });
      expect(sent.status).toBe(200);
      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(1);
      // And the draft is consumed, not left lying.
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);

      clock.set(start);
    });

    it('endet mit dem Fristende des Formulars, wo eines gesetzt ist', async () => {
      const form = await publishedForm('Entwurf-mit-Formularfrist');
      const closeAt = new Date(clock.now().getTime() + 3 * DAY_MS);
      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: closeAt.toISOString(),
        },
      );

      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(saved.status).toBe(200);
      expect(
        new Date((saved.body as { expiresAt: string }).expiresAt).getTime(),
      ).toBe(closeAt.getTime());
    });

    /**
     * **„Disappears" means: the row is gone** (`CONTRIBUTING.md`, a review finding).
     *
     * The test measures the **row count after the run**, not the status code
     * before it — that is exactly what the finding consisted of: *measured on
     * 2026-08-05* `GET` answered 404 after 400 days, `runOnce()` reported
     * `remaining: 0`, and the row with the typed answers lay unchanged in the
     * table. A read lock is not a deletion.
     *
     * *Reproduction:* remove `purgeDrafts` from `runOnce` → both numbers below
     * turn red.
     */
    it('löscht einen abgelaufenen Entwurf physisch, nicht nur unerreichbar', async () => {
      const start = clock.now();
      const { form, token } = await draftable('Entwurf-Purge');
      const rows = (): Promise<number> =>
        app().prisma.responseDraft.count({ where: { formId: form.id } });

      // **The rows of this form**, not the run's counter: the run goes over
      // the whole installation, and the drafts of the other cases of this file
      // stand in the same database. What the requirement promises is a
      // statement about the row anyway.
      clock.set(new Date(start.getTime() + 29 * DAY_MS));
      await purge().runOnce();
      expect(await rows()).toBe(1);
      expect((await readDraft(token)).status).toBe(200);

      // Day 31: the row goes — and the run counts it.
      clock.set(new Date(start.getTime() + 31 * DAY_MS));
      const run = await purge().runOnce();
      expect(run.drafts).toBeGreaterThanOrEqual(1);
      expect(await rows()).toBe(0);

      // Idempotent: a second run finds nothing more here, and `remaining` is
      // the recounted zero.
      const again = await purge().runOnce();
      expect(again.drafts).toBe(0);
      expect(again.remaining).toBe(0);

      clock.set(start);
    });

    /**
     * **Not via `trashCutoff`** — the boundary stands on the row. A purge that
     * added the trash's 30 days *on top of* `expires_at` would leave standing
     * exactly the span the deadline was to end: the draft below expires after
     * three days, and on day 4 it has to be gone — not on day 34.
     */
    it('nimmt einen Entwurf, sobald seine eigene Frist um ist', async () => {
      const start = clock.now();
      const form = await publishedForm('Entwurf-Purge-Formularfrist');
      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: new Date(start.getTime() + 3 * DAY_MS).toISOString(),
        },
      );
      expect((await saveDraft(form.slug, { [NAME]: 'ABC' })).status).toBe(200);

      clock.set(new Date(start.getTime() + 4 * DAY_MS));
      await purge().runOnce();
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);

      clock.set(start);
    });

    /**
     * **A retention period shortened afterwards pulls the already saved
     * drafts along** (a review finding).
     *
     * *Measured on 2026-08-05:* draft without a deadline → `expiresAt` 30 days
     * ahead; then the deadline set to tomorrow → the row stayed where it was,
     * i.e. **29 days past the deadline**.
     *
     * The opposite direction stands beside it and is the decision, not its
     * remainder: a **lengthened** deadline pulls nothing upwards.
     */
    it('zieht die Frist eines gespeicherten Entwurfs nach, wenn sie verkürzt wird', async () => {
      const start = clock.now();
      const { form, token } = await draftable('Entwurf-Frist-verkürzt');
      const stored = (): Promise<Date> =>
        app()
          .prisma.responseDraft.findFirstOrThrow({ where: { token } })
          .then((row) => row.expiresAt);
      expect((await stored()).getTime()).toBe(
        start.getTime() + TRASH_RETENTION_DAYS * DAY_MS,
      );

      const closeAt = new Date(start.getTime() + DAY_MS);
      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: closeAt.toISOString(),
        },
      );
      expect((await stored()).getTime()).toBe(closeAt.getTime());

      // …and a later extension does not raise it again: the boundary was
      // promised, and whoever needs longer writes on (`updateDraft` then
      // recomputes it from the new settings).
      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: new Date(start.getTime() + 10 * DAY_MS).toISOString(),
        },
      );
      expect((await stored()).getTime()).toBe(closeAt.getTime());

      clock.set(start);
    });

    /*
     * The same rule over the organisation standard — the second write path —
     * stood here. For *Verfügbarkeit* it no longer exists: an organisation
     * prescribes no deadline (ADR-0011, continuation 2026-08-14), so it cannot
     * shorten one either. What a save on that page does with drafts is
     * therefore „nothing", and that stands as an assertion in
     * `FormSettingsService.replaceOfTenant` (`capDraftsAt: null`).
     */

    it('rechnet die Frist beim Weiterschreiben neu', async () => {
      const start = clock.now();
      const { token } = await draftable('Entwurf-verlängert');

      clock.set(new Date(start.getTime() + 20 * DAY_MS));
      const written = await writeDraft(token, { [NAME]: 'ABCD' });
      expect(written.status).toBe(200);
      expect(
        new Date((written.body as { expiresAt: string }).expiresAt).getTime(),
      ).toBe(clock.now().getTime() + TRASH_RETENTION_DAYS * DAY_MS);

      clock.set(start);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the evidence — the submission creates ONE response, and the draft is gone
  // ═══════════════════════════════════════════════════════════════════════

  describe('das Absenden aus einem Entwurf', () => {
    it('erzeugt genau eine Antwort und räumt den Entwurf ab', async () => {
      const { form, token } = await draftable('Entwurf-absenden');

      const submitted = await submit(form.slug, {
        answers: { [NAME]: 'ABC', [SEMESTER]: 5 },
        draftToken: token,
      });
      expect(submitted.status).toBe(200);

      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(1);
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
      // …and the address stops working, in the same breath.
      expect((await readDraft(token)).status).toBe(404);
    });

    /**
     * The other half of „in one transaction": a submission that is **refused**
     * keeps the draft. Otherwise a participant whose Veranstaltung filled up
     * between the resume and the send would lose everything they had typed for
     * the sake of one number they were being asked to change.
     */
    it('behält den Entwurf, wenn die Absendung abgelehnt wird', async () => {
      const { form, token } = await draftable('Entwurf-abgelehnt');

      const refused = await submit(form.slug, {
        answers: {
          [NAME]: 'ABC',
          [SEMESTER]: 5,
          [EVENTS]: { seats: { konzert: 11 } },
        },
        draftToken: token,
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'event_full' });

      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(0);
      expect((await readDraft(token)).status).toBe(200);
    });

    /**
     * **Two simultaneous submissions of the same draft yield one response**
     * (a review finding).
     *
     * *Measured on 2026-08-05, before the check:* 200/200, **two**
     * `response` rows and `SUM(seats) = 6` instead of 3 — two tabs, a double
     * click or a retry after a lost connection were enough for a double
     * registration. The draft itself is the idempotency key: the `DELETE` in
     * the transaction serialises the two, and the second matches zero rows.
     *
     * *Reproduction:* remove the `count === 0` check from `storeWithinLimit`
     * → this case turns red, in **both** numbers.
     */
    it('erzeugt bei zwei gleichzeitigen Absendungen genau eine Antwort', async () => {
      const { form, token } = await draftable('Entwurf-doppelt-abgesendet');
      const body = {
        answers: {
          [NAME]: 'ABC',
          [SEMESTER]: 5,
          [EVENTS]: { seats: { konzert: 3 } },
        },
        draftToken: token,
      };

      const [first, second] = await Promise.all([
        submit(form.slug, body),
        submit(form.slug, body),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toStrictEqual([200, 409]);
      const refused = first.status === 409 ? first : second;
      expect(refused.body).toMatchObject({
        reason: 'draft_already_submitted',
        message: SUBMISSION_REFUSAL_MESSAGES.draft_already_submitted,
      });

      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(1);
      // And the seats: one registration for three people, not two for six.
      // That is the number by which the double registration was measured.
      const seats = await app().prisma.eventRegistration.aggregate({
        where: { formId: form.id },
        _sum: { seats: true },
      });
      expect(seats._sum.seats).toBe(3);
    });

    /**
     * The same check, one after the other instead of simultaneously — the
     * everyday case „back in the browser and sent once more".
     */
    it('lehnt eine zweite Absendung desselben Entwurfs ab', async () => {
      const { form, token } = await draftable('Entwurf-zweimal-abgesendet');
      const body = {
        answers: { [NAME]: 'ABC', [SEMESTER]: 5 },
        draftToken: token,
      };

      expect((await submit(form.slug, body)).status).toBe(200);

      const again = await submit(form.slug, body);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ reason: 'draft_already_submitted' });
      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(1);
    });

    /**
     * **A token that names nothing refuses the submission** — and that is the
     * reversal of an earlier decision (review).
     *
     * Up to here the counter of the `DELETE` was deliberately not checked, so
     * that an expired or revoked draft costs nobody their response. The price
     * was that „already submitted" is not distinguishable from it — and
     * exactly that case is the frequent one. The price of the new answer is
     * named: whoever submits with a dead token gets 409 and has to reload the
     * page; whoever submits **without** a token is untouched.
     */
    it('lehnt eine Absendung mit einem Token ab, das nichts mehr benennt', async () => {
      const { form } = await draftable('Entwurf-totes-Token');

      const submitted = await submit(form.slug, {
        answers: { [NAME]: 'XYZ', [SEMESTER]: 2 },
        draftToken: 'AAAAAAAAAAAAAAAAAAAAAA',
      });
      expect(submitted.status).toBe(409);
      expect(submitted.body).toMatchObject({
        reason: 'draft_already_submitted',
      });
      expect(
        await app().prisma.response.count({ where: { formId: form.id } }),
      ).toBe(0);

      // Without a token the same body is an ordinary submission.
      expect(
        (await submit(form.slug, { answers: { [NAME]: 'XYZ', [SEMESTER]: 2 } }))
          .status,
      ).toBe(200);
    });

    /**
     * The delete is scoped to **this form of this organisation**: a token naming another
     * form's draft matches nothing rather than removing it — and „matcht nichts"
     * is now a refusal (see the case above), so the assertion that carries the
     * isolation is the **other draft**, which is still there.
     */
    it('räumt keinen fremden Entwurf ab', async () => {
      const mine = await draftable('Entwurf-eigener');
      const other = await draftable('Entwurf-fremder');

      const submitted = await submit(mine.form.slug, {
        answers: { [NAME]: 'ABC', [SEMESTER]: 1 },
        draftToken: other.token,
      });
      expect(submitted.status).toBe(409);

      expect((await readDraft(other.token)).status).toBe(200);
      expect(
        await app().prisma.responseDraft.count({
          where: { formId: mine.form.id },
        }),
      ).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // the specification — the access word also revokes the draft addresses
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Both write paths, because the rule has two readers.** `revokesEditLinks`
   * is asked once, in `@formsache/shared`; what a `true` takes back is the edit tokens
   * *and* the drafts, and an organisation's standard reaches every form that has not
   * taken *Zugriff & Sicherheit* over.
   */
  describe('das Zugangswort widerruft Entwürfe', () => {
    it('nimmt die Entwurfs-Adresse zurück, wenn ein Formular geschützt wird', async () => {
      const { form, token } = await draftable('Entwurf-Widerruf-Formular');

      await configure(
        form.id,
        { access: true },
        {
          allowSaveDraft: true,
          passwordEnabled: true,
          password: 'Jahrestagung2026',
        },
      );

      const answered = await readDraft(token);
      expect(answered.status).toBe(404);
      expect((answered.body as { message: string }).message).toBe(
        PUBLIC_FORM_NOT_FOUND_MESSAGE,
      );
      // Deleted, not merely unreachable: the token is the row's only door, so a
      // cleared one would leave a document nobody can open.
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    it('nimmt sie auch zurück, wenn der Organisationsstandard geschützt wird', async () => {
      // The form inherits *Zugriff & Sicherheit* from the organisation, so the switch
      // has to come from there too.
      await configureTenant({ allowSaveDraft: true });
      const form = await publishedForm('Entwurf-Widerruf-Organisation');
      const saved = await saveDraft(form.slug, { [NAME]: 'ABC' });
      expect(saved.status).toBe(200);
      const token = tokenOf((saved.body as { draftUrl: string }).draftUrl);
      expect((await readDraft(token)).status).toBe(200);

      await configureTenant({
        allowSaveDraft: true,
        passwordEnabled: true,
        password: 'Semesterende',
      });

      try {
        expect((await readDraft(token)).status).toBe(404);
        expect(
          await app().prisma.responseDraft.count({
            where: { formId: form.id },
          }),
        ).toBe(0);
      } finally {
        // Put the organisation back where the rest of this file expects it — in a
        // `finally`, because this is the one fixture in the file that is
        // **tenant-wide**: leaving an organisation-level access word standing would put
        // every later form of this suite behind a gate, and the resulting wall
        // of red would hide which assertion actually failed. Measured, not
        // imagined: the reproduction of the specification produced exactly
        // that. Back to the shipped state of the section: without switches
        // „nothing decided" can no longer be expressed, so the values
        // themselves are reset (review finding 10).
        await configureTenant({ passwordEnabled: false, password: '' });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The validation of a half-filled draft
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A draft is half filled **by definition** — so the Pflicht rule does not run.
   * Everything else does, and that is the half a suite must not forget: the
   * draft route may not become the way to put into a JSONB column what a
   * submission would refuse.
   */
  describe('die Prüfung eines Entwurfs', () => {
    it('nimmt einen Entwurf an, in dem keine einzige Pflichtfrage beantwortet ist', async () => {
      const form = await publishedForm('Entwurf-leer');
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      expect((await saveDraft(form.slug, {})).status).toBe(200);
      // …while the submission of the same document is refused.
      const submitted = await submit(form.slug, { answers: {} });
      expect(submitted.status).toBe(400);
    });

    it.each([
      ['gegen das Muster', { [NAME]: 'abc' }],
      ['über der Höchstlänge', { [NAME]: 'ABCDE' }],
      ['über der Obergrenze', { [SEMESTER]: 99 }],
      ['im falschen Typ', { [NAME]: 42 }],
      [
        'für eine Frage, die es nicht gibt',
        {
          '019ff600-0000-7000-8000-0000000000ff': 'x',
        },
      ],
    ])('lehnt einen Wert %s auch im Entwurf ab', async (_name, answers) => {
      const form = await publishedForm(`Entwurf-ungültig-${_name}`);
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const saved = await saveDraft(form.slug, answers);
      expect(saved.status).toBe(400);
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    /**
     * **The Pflicht check was dropped only at the top level** (a review finding) — one case per affected type, over the route, because that is
     * where it was measured: `POST …/drafts` with a half-typed Pflicht-Adresse
     * answered **400** (`zip: Pflichtfeld., city:
     * Pflichtfeld.`). Three of the four composite types read
     * `question.required` a second time *inside* their own schema, past the
     * blank/filled fork the flag stopped at.
     *
     * One test per type and not one for all three: they fail for three
     * different reasons in three different functions, and a single case would
     * report the first and hide the rest.
     *
     * *Reproduction:* remove the `enforceRequired` in the respective function
     * in `packages/shared/src/response-validation.ts` → exactly this case turns
     * red.
     */
    describe('ein halb ausgefüllter zusammengesetzter Pflichttyp', () => {
      it.each([
        [
          'eine Adresse mit nur der Straße',
          {
            [ADDRESS]: {
              street: 'Hauptstraße 1',
              zip: '',
              city: '',
              country: 'Deutschland',
            },
          },
        ],
        [
          'eine Matrix mit einer offenen Zeile',
          { [MATRIX]: { rows: { organisation: ['gut'], programm: [] } } },
        ],
        [
          'eine Tabelle mit einer wieder geleerten Zelle',
          { [TABLE]: { cells: [{ name: '' }] } },
        ],
      ])('wird gespeichert: %s', async (name, answers) => {
        const form = await publishedForm(
          `Entwurf-zusammengesetzt-${name}`,
          compositeDefinition(),
        );
        await configure(form.id, { access: true }, { allowSaveDraft: true });

        const saved = await saveDraft(form.slug, answers);
        expect(saved.status).toBe(200);
        expect(
          await app().prisma.responseDraft.count({
            where: { formId: form.id },
          }),
        ).toBe(1);

        // …and the same payload as a **submission** is still refused: the rule
        // is suspended, not abolished.
        expect((await submit(form.slug, { answers })).status).toBe(400);
      });

      /** What is there still applies — in a draft too. */
      it('lehnt eine unbekannte Matrix-Option auch im Entwurf ab', async () => {
        const form = await publishedForm(
          'Entwurf-zusammengesetzt-ungültig',
          compositeDefinition(),
        );
        await configure(form.id, { access: true }, { allowSaveDraft: true });

        const saved = await saveDraft(form.slug, {
          [MATRIX]: { rows: { organisation: ['nie-gehört'] } },
        });
        expect(saved.status).toBe(400);
        expect(
          await app().prisma.responseDraft.count({
            where: { formId: form.id },
          }),
        ).toBe(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The way out — DSGVO Art. 17
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The data subject has no account, sees no trash and reaches no editor.
   * Without this route all that was left to them was a `PUT` with empty answers
   * — and the row with `tenant_id`, form reference and timestamps stayed
   * standing.
   */
  describe('einen Entwurf löschen', () => {
    async function deleteDraft(token: string): Promise<request.Response> {
      return request(app().server)
        .delete(apiPath(`/public/drafts/${token}`))
        .set('X-Forwarded-For', ownAddress());
    }

    it('entfernt die Zeile und macht die Adresse tot', async () => {
      const { form, token } = await draftable('Entwurf-löschen');

      const removed = await deleteDraft(token);
      expect(removed.status).toBe(204);
      expect(removed.text).toBe('');

      // The row, not the status code: „deleted" is a statement about the table
      // (`CONTRIBUTING.md`).
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
      expect((await readDraft(token)).status).toBe(404);
      expect((await deleteDraft(token)).status).toBe(404);
    });

    /**
     * **The switch is no door to the outside.** A form whose
     * *Zwischenspeichern* was switched off holds the data all the same — and
     * whoever wants to delete their own must not fail at it. Reading and
     * writing on answer 409 here, deleting does not.
     */
    it('löscht auch dann, wenn Zwischenspeichern inzwischen aus ist', async () => {
      const { form, token } = await draftable('Entwurf-löschen-Schalter-aus');
      await configure(form.id, { access: true }, { allowSaveDraft: false });
      expect((await readDraft(token)).status).toBe(409);

      expect((await deleteDraft(token)).status).toBe(204);
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    it('antwortet auf ein fremdes oder unbekanntes Token mit dem einen 404', async () => {
      const { form, token } = await draftable('Entwurf-löschen-fremd');
      const answered = await deleteDraft('AAAAAAAAAAAAAAAAAAAAAA');
      expect(answered.status).toBe(404);
      expect((answered.body as { message: string }).message).toBe(
        PUBLIC_FORM_NOT_FOUND_MESSAGE,
      );
      // …and the real draft stands untouched.
      expect((await readDraft(token)).status).toBe(200);
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The quantity limit
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The rate limit bounded the **speed**, nothing bounded the **quantity**:
   * *measured on 2026-08-05* 30 drafts a minute from one address, each up to
   * 101 462 bytes of stored payload, sessionless and visible to nobody.
   *
   * The case fills the table directly instead of going over the route — {@link
   * MAX_DRAFTS_PER_FORM} requests would be a measurement of the rate limit,
   * not of the boundary. What goes over the route is the one request it is
   * about.
   */
  it('lehnt einen weiteren Entwurf ab, sobald das Formular voll ist', async () => {
    const form = await publishedForm('Entwurf-Mengengrenze');
    await configure(form.id, { access: true }, { allowSaveDraft: true });
    const version = await app().prisma.formVersion.findFirstOrThrow({
      where: { formId: form.id },
      select: { id: true },
    });

    await app().prisma.responseDraft.createMany({
      data: Array.from({ length: MAX_DRAFTS_PER_FORM }, (_unused, index) => ({
        tenantId: tenant.id,
        formId: form.id,
        formVersionId: version.id,
        token: `full-${String(index).padStart(6, '0')}`,
        answers: { [NAME]: 'ABC' },
        expiresAt: new Date(clock.now().getTime() + DAY_MS),
      })),
    });

    const refused = await saveDraft(form.slug, { [NAME]: 'ABC' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      reason: 'draft_limit',
      message: SUBMISSION_REFUSAL_MESSAGES.draft_limit,
    });
    expect(
      await app().prisma.responseDraft.count({ where: { formId: form.id } }),
    ).toBe(MAX_DRAFTS_PER_FORM);

    // The form itself stays open — the boundary hits the drafts, not the
    // registration.
    expect(
      (await submit(form.slug, { answers: { [NAME]: 'ABC', [SEMESTER]: 1 } }))
        .status,
    ).toBe(200);

    // And an existing draft can be written on: the `PUT` creates no row, so
    // the quantity limit has nothing to say there.
    const existing = await app().prisma.responseDraft.findFirstOrThrow({
      where: { formId: form.id },
      select: { token: true },
    });
    expect((await writeDraft(existing.token, { [NAME]: 'ABCD' })).status).toBe(
      200,
    );
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════
  // A draft with a file answer (an open point from the review)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **Does a draft carry an attachment through?**
   *
   * When this block came about, `ResponseDraftView` deliberately passed **no**
   * `uploadTarget`: whoever opened a draft on a second device had no upload
   * door — neither the slug-bound one of the first filling in nor the
   * token-bound one of the correction. What was measured was therefore the way
   * that was left: upload in the **first** attempt, save the reference into
   * the draft, submit out of the draft.
   *
   * 1. **within the 24 hours** — the file is claimed, the response carries it.
   *    The draft is permeable for an attachment;
   * 2. **afterwards** — condition 5 of the claim (ADR-0014 no. 13) applies, and
   *    the submission is refused with `attachment_unavailable`.
   *
   * ## What has changed since an earlier finding
   *
   * The second case was a **dead end without an exit**, and that was the actual
   * finding: the view offered a live „Entfernen" button next to a dead
   * selector, so a participant could only **lose** their attachment. With a
   * Pflicht file question the draft was afterwards not submittable at all —
   * with the attachment the claim fails, without it the Pflicht check.
   *
   * There is now a third upload door (`POST /public/drafts/<token>/files`,
   * `PublicDraftFilesController`). The two deadlines stay as they are —
   * 24 hours for an unclaimed upload, up to 30 days for the draft —, and the
   * shorter one still wins. What the door changes is the reachability of the
   * exit: remove, attach anew, submit. Both stand below as a case.
   */
  describe('ein Entwurf mit Datei-Antwort', () => {
    const FILE_PAGE = '019ff600-0000-7000-8000-0000000000c0';
    const NACHWEIS = '019ff600-0000-7000-8000-000000000021';

    function fileDefinition() {
      return {
        pages: [
          {
            id: FILE_PAGE,
            title: 'Nachweis',
            description: null,
            questions: [
              {
                id: NACHWEIS,
                type: 'file',
                label: 'Nachweis',
                hint: null,
                required: false,
                width: 'full',
                maxFiles: 2,
              },
            ],
          },
        ],
      };
    }

    /** A real PDF header plus filler — the server reads the content, not the name. */
    function pdf(size = 64): Buffer {
      const head = Buffer.from('%PDF-1.7\n');
      return Buffer.concat([
        head,
        Buffer.alloc(Math.max(0, size - head.length)),
      ]);
    }

    async function uploadFor(
      slug: string,
    ): Promise<{ ref: string; fileName: string }> {
      const answered = await request(app().server)
        .post(apiPath(`/public/forms/${slug}/files`))
        .set('X-Forwarded-For', ownAddress())
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent('nachweis.pdf'))
        .send(pdf());
      expect(answered.status).toBe(201);
      return answered.body as { ref: string; fileName: string };
    }

    /**
     * The **third** door — the same request shape as the other two, only
     * under the draft's address. Answers raw, because the cases below measure
     * the refusals too.
     */
    async function uploadForDraft(
      token: string,
      fileName = 'ersatz.pdf',
      body: Buffer = pdf(),
    ): Promise<request.Response> {
      return request(app().server)
        .post(apiPath(`/public/drafts/${token}/files`))
        .set('X-Forwarded-For', ownAddress())
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent(fileName))
        .send(body);
    }

    async function draftWithFile(title: string): Promise<{
      form: { id: string; slug: string };
      token: string;
      ref: string;
      answers: Record<string, unknown>;
    }> {
      const form = await publishedForm(title, fileDefinition());
      await configure(form.id, { access: true }, { allowSaveDraft: true });

      const uploaded = await uploadFor(form.slug);
      const answers = {
        [NACHWEIS]: {
          files: [{ ref: uploaded.ref, name: uploaded.fileName }],
        },
      };

      const saved = await saveDraft(form.slug, answers);
      expect(saved.status).toBe(200);
      return {
        form,
        token: (saved.body as { token: string }).token,
        ref: uploaded.ref,
        answers,
      };
    }

    it('trägt den Verweis über den Gerätewechsel und beansprucht die Datei beim Absenden', async () => {
      const { form, token, ref, answers } =
        await draftWithFile('Entwurf-Datei');

      // The second browser sees the reference again — only the reference,
      // because nothing is uploaded a second time.
      const resumed = await readDraft(token);
      expect(resumed.status).toBe(200);
      expect((resumed.body as { answers: unknown }).answers).toStrictEqual(
        answers,
      );

      const sent = await submit(form.slug, { answers, draftToken: token });
      expect(sent.status).toBe(200);

      const response = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { id: true },
      });
      const file = await app().prisma.file.findFirstOrThrow({
        where: { publicRef: ref },
        select: { responseId: true },
      });
      expect(file.responseId).toBe(response.id);
      // And the draft is gone — the same transaction.
      expect(
        await app().prisma.responseDraft.count({ where: { formId: form.id } }),
      ).toBe(0);
    });

    /**
     * **The finding — and its reversal by the specification.**
     *
     * Formerly exactly this submission failed with `attachment_unavailable`:
     * the 24 hours of ADR-0014 no. 15 are measured on `file.created_at`, and
     * the age is written directly into the column here, because the database
     * clock writes it and the injected clock of this suite does not reach it.
     * That was the named imposition: the draft lived thirty days, its
     * attachment one.
     *
     * Since the draft's claim (`file.draft_id`) the attachment belongs to it,
     * and the age of the upload says nothing about it any more — the
     * submission goes through, and the file changes owner.
     *
     * *Reproduction:* take the draft arm out of the condition of
     * `claimAttachments` → the old 409 is back and this case turns
     * red. The deadlines themselves are measured by
     * `test/public/draft-attachment.spec.ts`.
     */
    it('sendet ab, obwohl der Upload älter als 24 Stunden ist', async () => {
      const { form, token, ref, answers } =
        await draftWithFile('Entwurf-Datei-alt');

      await app().prisma.file.update({
        where: { publicRef: ref },
        data: {
          createdAt: new Date(Date.now() - UNCLAIMED_FILE_LIFETIME_MS - 60_000),
        },
      });

      const sent = await submit(form.slug, { answers, draftToken: token });
      expect(sent.status).toBe(200);

      const response = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { id: true },
      });
      const file = await app().prisma.file.findFirstOrThrow({
        where: { publicRef: ref },
        select: { responseId: true, draftId: true },
      });
      expect(file.responseId).toBe(response.id);
      expect(file.draftId).toBeNull();
    });

    /**
     * **a review finding of the security review: the dead end, reproduced from
     * the resume screen.**
     *
     * The door makes the way out reachable, but its justification presupposes
     * „remove → attach anew → **submit**", and nothing forces the third step:
     * `PUT /public/drafts/:token` saves the fresh reference willingly. With
     * that the state no longer sits only in the first sitting, but on the
     * screen whose whole purpose is „to come back later" — for thirty days,
     * as often as you like.
     *
     * *Measured on 2026-08-05:* upload → `PUT` → `created_at` set back by
     * 24 h + 60 s → `GET` answers 200 and went on handing out the reference,
     * without a word about its being dead → `POST …/responses` 409
     * `attachment_unavailable`.
     *
     * The read answer now resolves the references against `file` — the same
     * conditions the claim makes — and `expiresAt: null` is the one answer for
     * „would be refused now".
     *
     * **Since the specification, ageing is no longer the way there** (it says:
     * the attachment lives as long as its draft), but the row that no longer
     * exists is — a file that had already expired before the save and that the
     * purge has collected is exactly that state. The case therefore produces
     * it directly instead of turning a deadline that no longer creates it.
     *
     * *Reproduction:* replace `resolveDraftAttachments` with `[]` → the middle
     * expectation turns red, and the screen claims „attached" again.
     */
    it('sagt beim Wiederaufnehmen, dass die Anlage nicht mehr da ist', async () => {
      const { form, token, ref, answers } = await draftWithFile(
        'Entwurf-Datei-tot-sichtbar',
      );

      // The second step of the door's justification, carried out on its own:
      // the participant goes on saving without submitting.
      expect((await writeDraft(token, answers)).status).toBe(200);

      // What the purge leaves behind: no row. The reference still stands in
      // the draft's answers.
      await app().prisma.file.delete({ where: { publicRef: ref } });

      const resumed = await readDraft(token);
      expect(resumed.status).toBe(200);
      const body = resumed.body as {
        answers: Record<string, unknown>;
        attachments: { ref: string; expiresAt: string | null }[];
      };
      // The reference still stands in the answers — it *is* what the
      // participant typed, and deleting it here would be a write access to
      // somebody else's input on a read path.
      expect(body.answers).toStrictEqual(answers);
      // But it is marked as dead, and exactly the way the submission is about
      // to treat it.
      expect(body.attachments).toStrictEqual([{ ref, expiresAt: null }]);

      const sent = await submit(form.slug, { answers, draftToken: token });
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({ reason: 'attachment_unavailable' });
    });

    /**
     * The counter-case — without it the one above would only prove that
     * something turns `null`. A living attachment carries its moment, and
     * since the specification that is the deadline **of the draft**: the
     * attachment belongs to it and dies with it. (Formerly `created_at` + 24 h
     * stood here, and exactly that difference was the imposition the
     * specification ends.)
     */
    it('nennt bei einer lebenden Anlage die Frist des Entwurfs', async () => {
      const { token, ref } = await draftWithFile('Entwurf-Datei-lebt');

      const resumed = await readDraft(token);
      expect(resumed.status).toBe(200);
      const body = resumed.body as {
        attachments: { ref: string; expiresAt: string | null }[];
        expiresAt: string;
      };
      const [attachment] = body.attachments;
      expect(attachment?.ref).toBe(ref);
      expect(attachment?.expiresAt).toBe(body.expiresAt);

      // And the attachment belongs to the draft, no longer to nobody — the
      // column behind the promise.
      const row = await app().prisma.file.findFirstOrThrow({
        where: { publicRef: ref },
        select: { draftId: true },
      });
      expect(row.draftId).not.toBeNull();
    });

    /**
     * **And the resolution is no oracle**: it makes the same conditions as the
     * claim, so the file of a **foreign form** reads as dead — byte-identical
     * to a reference that never existed.
     *
     * Without this case the new query would be a door through which the holder
     * of a draft token could interrogate the storage of the other forms:
     * „is this reference alive" is a disclosure, and it may come only over
     * one's own attachments.
     *
     * *Reproduction:* take `formId` out of the `where` of
     * `resolveDraftAttachments` → the foreign reference reports a moment and
     * this case turns red.
     */
    it('meldet den Verweis eines fremden Formulars als tot, nicht als lebend', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Fremdverweis');
      const stranger = await publishedForm(
        'Entwurf-Datei-Fremdverweis-Quelle',
        fileDefinition(),
      );
      const foreign = await uploadFor(stranger.slug);

      const answers = {
        [NACHWEIS]: { files: [{ ref: foreign.ref, name: foreign.fileName }] },
      };
      expect((await writeDraft(token, answers)).status).toBe(200);

      const resumed = await readDraft(token);
      expect(
        (
          resumed.body as {
            attachments: { ref: string; expiresAt: string | null }[];
          }
        ).attachments,
      ).toStrictEqual([{ ref: foreign.ref, expiresAt: null }]);
      // And the submission says the same — the one answer for all five
      // conditions.
      const sent = await submit(form.slug, { answers, draftToken: token });
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({ reason: 'attachment_unavailable' });
    });

    /**
     * **The way out of exactly this dead end.**
     *
     * The same set-up as a line above — an attachment that no longer exists
     * and that therefore can no longer be claimed —, and afterwards the way a
     * participant would take: take away, attach anew, submit. Without the
     * draft's door it ends after the first step.
     *
     * *(The set-up used to be a backdated `created_at`. Since the
     * specification a draft's attachment no longer ages on that column, so the
     * case produces the state directly — the row is gone, as after a purge.)*
     *
     * *Reproduction:* strike `PublicDraftFilesController` from
     * `public-forms.module.ts` → the upload answers 404 and this case turns
     * red.
     */
    it('lässt den verschwundenen Anhang durch einen neuen ersetzen und geht dann durch', async () => {
      const { form, token, ref } = await draftWithFile('Entwurf-Datei-Ersatz');

      await app().prisma.file.delete({ where: { publicRef: ref } });

      // The participant takes away the attachment that has become unusable and
      // attaches a new one over the address of their draft.
      const replaced = await uploadForDraft(token);
      expect(replaced.status).toBe(201);
      const fresh = replaced.body as { ref: string; fileName: string };
      expect(fresh.ref).not.toBe(ref);

      const answers = {
        [NACHWEIS]: { files: [{ ref: fresh.ref, name: fresh.fileName }] },
      };
      expect((await writeDraft(token, answers)).status).toBe(200);

      const sent = await submit(form.slug, { answers, draftToken: token });
      expect(sent.status).toBe(200);

      const response = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { id: true },
      });
      // The new file now belongs to the response — and the old one is what it
      // was when the case began: no longer there.
      expect(
        (
          await app().prisma.file.findFirstOrThrow({
            where: { publicRef: fresh.ref },
            select: { responseId: true },
          })
        ).responseId,
      ).toBe(response.id);
      expect(await app().prisma.file.count({ where: { publicRef: ref } })).toBe(
        0,
      );
    });

    /**
     * **Where organisation and form come from: from the resolved draft**, never
     * from the request. The request carries a token and bytes and nothing else
     * — there is no place at all at which a caller could name an organisation,
     * and this case holds that it stays that way.
     */
    it('schreibt Organisation und Formular des Entwurfs auf die Zeile', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Eigentum');

      const answered = await uploadForDraft(token);
      expect(answered.status).toBe(201);

      const row = await app().prisma.file.findUniqueOrThrow({
        where: { publicRef: (answered.body as { ref: string }).ref },
        select: {
          tenantId: true,
          formId: true,
          kind: true,
          responseId: true,
          contentType: true,
        },
      });
      expect(row).toStrictEqual({
        tenantId: tenant.id,
        formId: form.id,
        kind: 'response_attachment',
        // Unclaimed, until a submission names it (no. 13).
        responseId: null,
        // Measured from the content, not from the name or the header.
        contentType: 'application/pdf',
      });
    });

    /**
     * **The isolation, measured from the forbidden side** (working rule,
     * see CONTRIBUTING.md: a test that only checks the permitted case proves nothing).
     *
     * A file created over the draft door cannot be hung on the response of
     * **another** form — not even within the same organisation, where the
     * tenant condition of the claim says nothing and condition 3 (`form_id`)
     * carries it alone.
     *
     * *Reproduction:* take `formId` out of the `WHERE` of `claimAttachments` →
     * this case turns green where it has to be red.
     */
    it('lässt die Datei eines Entwurfs nicht an die Antwort eines anderen Formulars hängen', async () => {
      const { token } = await draftWithFile('Entwurf-Datei-Herkunft');
      const stranger = await publishedForm(
        'Entwurf-Datei-Fremdformular',
        fileDefinition(),
      );

      const answered = await uploadForDraft(token);
      expect(answered.status).toBe(201);
      const file = answered.body as { ref: string; fileName: string };

      const sent = await submit(stranger.slug, {
        answers: {
          [NACHWEIS]: { files: [{ ref: file.ref, name: file.fileName }] },
        },
      });
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({ reason: 'attachment_unavailable' });

      // Nothing created, nothing claimed.
      expect(
        await app().prisma.response.count({ where: { formId: stranger.id } }),
      ).toBe(0);
      expect(
        (
          await app().prisma.file.findFirstOrThrow({
            where: { publicRef: file.ref },
            select: { responseId: true },
          })
        ).responseId,
      ).toBeNull();
    });

    /**
     * **The same refusal chain as reading and writing the draft**, read anew
     * on every access — the promise the requirement makes for the two other
     * routes and that a third door must not undercut.
     */
    it('geht zu, sobald Zwischenspeichern abgeschaltet wird', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Schalter');
      expect((await uploadForDraft(token)).status).toBe(201);

      await configure(form.id, { access: true }, { allowSaveDraft: false });

      const refused = await uploadForDraft(token);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'saving_disabled' });
    });

    it('antwortet auf einen Token, der nichts benennt, mit der einen 404', async () => {
      const refused = await uploadForDraft('A'.repeat(22));
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({
        message: PUBLIC_FORM_NOT_FOUND_MESSAGE,
      });
    });

    /**
     * And the door inherits the allowlist instead of having one of its own: it
     * calls the same `storeUpload` as its two siblings. An SVG is on neither of
     * the two lists (ADR-0014 no. 5), and the check reads the content, not the
     * name.
     */
    it('weist zurück, was auf keiner Positivliste steht', async () => {
      const { token } = await draftWithFile('Entwurf-Datei-Liste');

      const refused = await uploadForDraft(
        token,
        'logo.pdf',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      );
      expect(refused.status).toBe(415);
    });

    /**
     * **The unmeasured link of its own refusal chain: the deadline**
     * (a review finding of the security review).
     *
     * The doc comment on `openForUploadByDraftToken` names the deadline
     * expressly as part of the chain — `draftableSettings` is
     * `saving_disabled` **or** the deadline —, measured up to here was only
     * the switch.
     *
     * *Measured:* the answer is **404** and not the 409 of the switch, and
     * that is right for a reason that lies one place further on: the settings
     * write pulls `expires_at` of the existing drafts to the new deadline (a
     * review finding, the case
     * „lehnt Speichern nach Fristende ab und nimmt den Entwurf mit"). The
     * draft is thereby expired, and an expired draft is the one
     * 404 — at this door as at the read door next to it. The case holds both,
     * the status **and** the byte equality.
     *
     * *Reproduction:* take the deadline condition out of `loadDraftForUpload`
     * → the door goes on accepting bytes after the deadline and this case
     * turns red.
     */
    it('geht zu, sobald die Frist des Formulars vorbei ist', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Frist');
      expect((await uploadForDraft(token)).status).toBe(201);

      await configure(
        form.id,
        // Both sections, for the reason the case on the deadline above names:
        // an `access: false` here would put *Zwischenspeichern* back on the
        // organisation standard, and the measured refusal would then be the
        // switch instead of the deadline.
        { access: true },
        {
          allowSaveDraft: true,
          openEnabled: true,
          openAt: null,
          closeAt: new Date(Date.now() - 60_000).toISOString(),
        },
      );

      const refused = await uploadForDraft(token);
      const read = await readDraft(token);
      // Byte-identical to the read door next to it — that is the actual
      // promise: both hang on the same resolution and the same deadline.
      expect(refused.status).toBe(read.status);
      expect(refused.body).toStrictEqual(read.body);
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({
        message: PUBLIC_FORM_NOT_FOUND_MESSAGE,
      });
    });

    /**
     * **The second unmeasured link: the quantity/size path** .
     *
     * The door shares `uploadAllowance` with its siblings, but „shares" was a
     * claim about the code and not a measurement. Here is the number: a file
     * over {@link MAX_ATTACHMENT_BYTES} is refused at `refuseDeclaredLength`
     * with **413**, and that **before** a byte was read — the row in `file`
     * does not even come about.
     *
     * *Reproduction:* take `refuseDeclaredLength` and the `maxBytes` cap out of
     * `PublicUploadsService.upload` → 201 instead of 413.
     */
    it('weist über die Entwurfstür ab, was zu groß ist — vor dem ersten Byte', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Groesse');
      const before = await app().prisma.file.count({
        where: { formId: form.id },
      });

      const refused = await uploadForDraft(
        token,
        'zu-gross.pdf',
        pdf(MAX_ATTACHMENT_BYTES + 1),
      );

      expect(refused.status).toBe(413);
      expect(
        await app().prisma.file.count({ where: { formId: form.id } }),
      ).toBe(before);
    });

    /**
     * **The rate limit counts per door, not per address** (a review finding of
     * the security review) — the aggregate figure, nailed down instead of
     * described.
     *
     * The comment at the draft door claimed „one budget across every
     * draft that address is continuing"; `ThrottlerGuard.generateKey` however
     * builds the key from class ⊕ handler ⊕ tracker, i.e. **per route**.
     * That stays so (the reasoning stands at `PUBLIC_UPLOAD_RATE_LIMIT`), but
     * the number stands here now: ten per door, {@link PUBLIC_UPLOAD_DOORS} doors.
     *
     * Measured with **one** address across two doors — it takes no more to
     * tell „per door" from „per address".
     *
     * *Reproduction:* introduce a shared `generateKey` over the three upload
     * handlers → the last row becomes 429 and the case red.
     */
    it('zählt je Tür, nicht je Adresse', async () => {
      const { form, token } = await draftWithFile('Entwurf-Datei-Limit');
      // A fixed address instead of `ownAddress()` — the measurement *is* the
      // shared counter.
      const address = '198.51.100.251';
      const statuses: number[] = [];
      for (let i = 0; i <= PUBLIC_UPLOAD_RATE_LIMIT.limit; i += 1) {
        const answered = await request(app().server)
          .post(apiPath(`/public/drafts/${token}/files`))
          .set('X-Forwarded-For', address)
          .set('Content-Type', 'application/octet-stream')
          .set('X-File-Name', encodeURIComponent('ersatz.pdf'))
          .send(pdf());
        statuses.push(answered.status);
      }
      expect(statuses.filter((status) => status === 201)).toHaveLength(
        PUBLIC_UPLOAD_RATE_LIMIT.limit,
      );
      expect(statuses.at(-1)).toBe(429);

      // The same address, the same minute, another door: unspent.
      const throughTheSlug = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/files`))
        .set('X-Forwarded-For', address)
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', encodeURIComponent('nachweis.pdf'))
        .send(pdf());
      expect(throughTheSlug.status).toBe(201);

      // **And the number of doors is the multiplier, so it is counted along.**
      // From the built module, not from a list here: whoever registers a fourth
      // upload door without changing `PUBLIC_UPLOAD_DOORS` makes this line
      // red — and in doing so reads the paragraph at
      // `PUBLIC_UPLOAD_RATE_LIMIT`, which says what that means for the
      // aggregate figure.
      const registered = Reflect.getMetadata(
        'controllers',
        PublicFormsModule,
      ) as { name: string }[];
      expect(
        registered.filter((controller) =>
          controller.name.endsWith('FilesController'),
        ),
      ).toHaveLength(PUBLIC_UPLOAD_DOORS);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tenant-Isolation
  // ═══════════════════════════════════════════════════════════════════════

  it('gehört zur Organisation des Formulars, nicht zu einer, die der Aufrufer nennt', async () => {
    const { form, token } = await draftable('Entwurf-Isolation');

    const row = await app().prisma.responseDraft.findFirstOrThrow({
      where: { token },
      select: { tenantId: true, formId: true },
    });
    expect(row.tenantId).toBe(tenant.id);
    expect(row.formId).toBe(form.id);
  });
});
