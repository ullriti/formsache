import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PublicUrlService } from '../../src/common/public-url/public-url.service';
import { PUBLIC_FORM_NOT_FOUND_MESSAGE } from '../../src/public/public-forms.service';
import { SUBMISSION_REFUSAL_MESSAGES } from '../../src/public/public-forms.service';
import { StartTokenService } from '../../src/public/start-token.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { captureStdio } from '../mail/stdio-capture';
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
 * The requirement — **„Bearbeiten nach Absenden" opens exactly one response, and
 * only one's own.**
 *
 * Everything here goes at the public endpoints past the browser, and every
 * refusal is checked by **counting `response` rows around it**: a refusal that
 * still wrote a row, or an edit that wrote a second one, would look identical
 * from the outside.
 *
 * ## What this file has to prove, in the requirement's own words
 *
 * 1. a foreign/guessed token → **404, byte-identical to the unknown one**;
 * 2. the token after `closeAt` → refused;
 * 3. the token with `allowEdit: false` → refused **even though it is valid**,
 *    because the setting is read on *every* access and not at issuing time;
 * 4. an edit produces **no second row** and does **not** count again against the
 *    response limit;
 * 5. the schema stand stays the one of the original submission;
 * 6. the time of the change is kept **separately**.
 *
 * ## Two things about the setup
 *
 * **`TRUST_PROXY_HOPS: 1` plus a distinct `X-Forwarded-For` per request**, like
 * the submission gate next door: the write routes allow 30 requests a minute per
 * address, and a suite that spent them on fixtures would be measuring the rate
 * limit rather than the gate.
 *
 * **No session anywhere in the participant's half.** The editor session below
 * exists only to build fixtures through the real routes.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff400-0000-7000-8000-0000000000a0';
const NAME = '019ff400-0000-7000-8000-000000000001';
/** Only in the *second* version — the field an old answer must not be asked for. */
const SEMESTER = '019ff400-0000-7000-8000-000000000002';

function question(id: string, label: string) {
  return {
    id,
    type: 'text',
    label,
    hint: null,
    required: true,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function definition(questionIds: readonly string[] = [NAME]) {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: questionIds.map((id) =>
          question(id, id === NAME ? 'Name' : 'Semester'),
        ),
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

/**
 * Everything a byte-comparison of two answers must ignore — the same one-entry
 * list `password-gate.spec.ts` and `auth.spec.ts` use, and short for the same
 * reason: the rate limiter runs with `setHeaders: false`, and `etag` is
 * deliberately **not** excused. A header derived from the body is one more way
 * for two answers to differ, and requiring that it does not costs nothing.
 */
/*
 * `x-request-id` was added later and is **random per request**. It is up for
 * debate here and not in the application: the assurance of this file
 * is that two answers reveal **nothing about their occasion** — not that
 * they are equal byte for byte. A random number reveals nothing; it
 * only distinguishes two retrievals, which a timestamp would do as well.
 */
const VOLATILE_HEADERS = new Set(['date', 'x-request-id']);

function stableHeaders(response: request.Response): Record<string, string> {
  const headers = z.record(z.string(), z.unknown()).parse(response.headers);
  const stable: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!VOLATILE_HEADERS.has(name.toLowerCase())) {
      stable[name.toLowerCase()] = JSON.stringify(value);
    }
  }
  return stable;
}

describe('Bearbeiten nach Absenden', () => {
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
      // The installation's own address is a **row**, not
      // `PUBLIC_BASE_URL` of the environment. A suite
      // that asserts on absolute links has to put one there — which is also
      // what makes „if it is missing, there is no link" a state of its own.
      systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
      env: { TRUST_PROXY_HOPS: 1 },
    });
    // The application's **own** signer, so a token minted here is one this
    // server would accept.
    startTokens = testApp.app.get(StartTokenService);

    tenant = await createTenant(testApp.prisma, 'EDIT');
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
    questionIds: readonly string[] = [NAME],
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
        definition: definition(questionIds),
        revision: form.revision,
      });
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, slug: form.publicSlug };
  }

  /** Publishes a further version of an existing form. */
  async function republish(
    formId: string,
    title: string,
    questionIds: readonly string[],
  ): Promise<void> {
    const current = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { revision: true },
    });
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(editor))
      .send({
        title,
        definition: definition(questionIds),
        revision: current.revision,
      });
    const published = await request(app().server)
      .post(apiPath(`/forms/${formId}/publish`))
      .set(authedMutation(editor))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);
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

  /** One submission, from an address of its own. */
  async function submit(
    slug: string,
    answers: Record<string, unknown> = { [NAME]: 'Anton' },
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress())
      .send({ answers });
  }

  async function readEdit(token: string): Promise<request.Response> {
    return request(app().server)
      .get(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress());
  }

  async function writeEdit(
    token: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app().server)
      .put(apiPath(`/public/responses/${token}`))
      .set('X-Forwarded-For', ownAddress())
      .send(body);
  }

  async function rowsOf(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  /** The one answer that leads nowhere — the token of an editable answer. */
  async function editableAnswer(
    title: string,
    questionIds: readonly string[] = [NAME],
  ): Promise<{ form: { id: string; slug: string }; token: string }> {
    const form = await publishedForm(title, questionIds);
    await configure(form.id, { access: true }, { allowEdit: true });

    const answers: Record<string, unknown> = {};
    for (const id of questionIds) {
      answers[id] = id === NAME ? 'Anton' : 'WS 2026/27';
    }
    const submitted = await submit(form.slug, answers);
    expect(submitted.status).toBe(200);

    const editUrl = (submitted.body as { editUrl: string | null }).editUrl;
    expect(editUrl).not.toBeNull();
    return { form, token: tokenOf(editUrl ?? '') };
  }

  function tokenOf(editUrl: string): string {
    const token = editUrl.slice(editUrl.lastIndexOf('/') + 1);
    expect(token).not.toBe('');
    return token;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The link itself — a server function, not a browser one
  // ═══════════════════════════════════════════════════════════════════════

  describe('the link', () => {
    /**
     * **The address is built from configuration, not from the request.**
     *
     * That is the whole of the first half of this work item: `PUBLIC_BASE_URL`
     * is what the link starts with, so a `Host` header an outsider writes cannot
     * decide where a confirmation mail points. The base
     * used by the test app is a host that does not resolve, which is what makes
     * this assertion say something: a link assembled from the request would
     * start with `127.0.0.1`.
     */
    it('is absolute and starts at PUBLIC_BASE_URL, not at the request host', async () => {
      const { token } = await editableAnswer('Bearbeitbar');

      const answered = await request(app().server)
        .get(apiPath(`/public/responses/${token}`))
        .set('X-Forwarded-For', ownAddress())
        .set('Host', 'angreifer.invalid');
      expect(answered.status).toBe(200);

      const again = await writeEdit(token, { answers: { [NAME]: 'Anton B.' } });
      expect(again.status).toBe(200);
      const editUrl = (again.body as { editUrl: string }).editUrl;

      expect(editUrl).toBe(`${TEST_PUBLIC_BASE_URL}/a/${token}`);
      expect(editUrl).not.toContain('angreifer.invalid');
      expect(editUrl).not.toContain('127.0.0.1');
    });

    /**
     * At least 128 bits, from the same alphabet as the `public_slug` — the
     * requirement's own comparison. Not a signature and not an id: the token must
     * carry nothing that names the answer, the form or the organisation.
     *
     * **Alphabet, length and „the two are different" are not enough**, and
     * that was this test's whole content until the review gate said so: a padded
     * counter (`AAAAAAAAAAAAAAAAAAAA01`) satisfies all three and is guessable in
     * a hundred tries. The decoded length is asserted here as the floor under
     * the character count — 22 characters of a *shorter* alphabet decode to
     * fewer bytes — and that is all it does.
     *
     * **Said plainly, because it was measured:** this test does **not** catch
     * the padded counter. Twenty-two base64url characters always decode to
     * sixteen bytes, whatever produced them, so the assertion below stays green
     * against a counter (reproduced). The one that goes red is the
     * distribution probe in the next case, and that is where the claim „from
     * a CSPRNG" actually rests.
     */
    it('is a random value of at least 128 bits, like the public_slug', async () => {
      const first = await editableAnswer('Zufall A');
      const second = await editableAnswer('Zufall B');

      for (const token of [first.token, second.token]) {
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        // base64url of 16 bytes is 22 characters; ≥ 22 keeps this a floor
        // rather than a second definition of the format.
        expect(token.length).toBeGreaterThanOrEqual(22);
        // The floor under the character count: 22 characters of a narrower
        // alphabet would decode to fewer than 16 bytes.
        expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(
          16,
        );
      }
      expect(first.token).not.toBe(second.token);

      // Nothing about the row is recoverable from the address.
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: first.form.id },
        select: { id: true, formId: true, tenantId: true },
      });
      expect(first.token).not.toContain(row.id);
      expect(first.token).not.toContain(row.formId);
      expect(first.token).not.toContain(row.tenantId);
    });

    /**
     * The coarse distribution probe that goes with the test above.
     *
     * Twenty tokens from **one** form, so the fixture cannot supply the variety
     * itself. Two claims, both weak on purpose — this is a sanity check on the
     * source, not a statistical test:
     *
     * - all twenty are distinct (a counter passes this, which is why it is not
     *   alone);
     * - **no two share their first four characters** — 24 bits, so the chance
     *   of a genuine collision among 20 CSPRNG values is about one in 10⁵,
     *   while every sequential or time-derived scheme collides on the *whole*
     *   prefix immediately.
     */
    it('draws twenty tokens with no shared prefix', async () => {
      const form = await publishedForm('Zwanzig Zufälle');
      await configure(form.id, { access: true }, { allowEdit: true });

      const tokens: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const submitted = await submit(form.slug, {
          [NAME]: `Anton ${String(index)}`,
        });
        expect(submitted.status).toBe(200);
        tokens.push(tokenOf((submitted.body as { editUrl: string }).editUrl));
      }

      expect(new Set(tokens).size).toBe(tokens.length);
      const prefixes = tokens.map((token) => token.slice(0, 4));
      expect(new Set(prefixes).size).toBe(prefixes.length);
    });

    /**
     * The offer follows the setting. **This is not the enforcement** — that is
     * the point of the next describe block — it is what keeps the confirmation
     * page from promising something the form does not do.
     */
    it('is withheld from the confirmation when „Bearbeiten nach Absenden" is off', async () => {
      const form = await publishedForm('Ohne Bearbeiten');
      // **Switched off, not unset** (review finding 16): the default of the
      // application has been „on" since 2026-08-17. A case that relied on the
      // default would from now on check the opposite.
      await configure(form.id, { access: true }, { allowEdit: false });
      const submitted = await submit(form.slug);

      expect(submitted.status).toBe(200);
      expect((submitted.body as { editUrl: unknown }).editUrl).toBeNull();
    });

    /**
     * …and the row carries a token anyway. That is deliberate and it is what
     * makes „the setting is evaluated on every access" a statement
     * with two directions: switching the setting **on** later must reach the
     * registrations that already arrived.
     */
    it('mints a token even for a form that does not offer editing yet', async () => {
      const form = await publishedForm('Später erlaubt');
      expect((await submit(form.slug)).status).toBe(200);

      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { editToken: true },
      });
      expect(row.editToken).not.toBeNull();

      // Switched on afterwards — and the answer that predates the switch opens.
      await configure(form.id, { access: true }, { allowEdit: true });
      expect((await readEdit(row.editToken ?? '')).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // „only one's own" — the 404 and its byte-identity
  // ═══════════════════════════════════════════════════════════════════════

  describe('a token that is not one (404)', () => {
    /**
     * **Byte-identical, not „both are 404".**
     *
     * Status, body *and* the stable headers — `content-length` and `etag`
     * included. A test that compared only the status would pass a server that
     * answered „this response exists, but…" in one case and „unknown" in the
     * other, which turns the address into a way of asking whether an answer
     * exists.
     */
    it('answers a guessed token byte-identically to a malformed one', async () => {
      // Well-formed but never minted — 22 characters from the right alphabet.
      const guessed = await readEdit('AAAAAAAAAAAAAAAAAAAAAA');
      const malformed = await readEdit('nicht-mal-die-richtige-form-%21');

      expect(guessed.status).toBe(404);
      expect(malformed.status).toBe(guessed.status);
      expect(guessed.text).toBe(malformed.text);
      expect(guessed.text).toContain(PUBLIC_FORM_NOT_FOUND_MESSAGE);
      expect(stableHeaders(guessed)).toStrictEqual(stableHeaders(malformed));
      expect(guessed.headers['content-length']).toBe(
        malformed.headers['content-length'],
      );
      expect(guessed.headers.etag).toBe(malformed.headers.etag);
    });

    /**
     * The further shapes of „nothing to edit", each compared against the
     * guessed token. They take **different branches** in the service, which is
     * exactly why they are listed: a branch that answered differently would be a
     * way of learning that a token is real.
     *
     * `%00` is in the list because it used to be a 500 on the read route — a
     * percent escape is decoded before the application sees it, and PostgreSQL
     * refuses U+0000 inside `text`. A 500 where everything else answers 404 is
     * the same oracle in a new place.
     */
    it.each([
      ['an answer in the Papierkorb', 'deleted'],
      ['a form in the Papierkorb', 'deleted-form'],
      ['a form whose publication is gone', 'draft-form'],
      ['a NUL byte', 'nul'],
      ['a NUL byte inside a plausible token', 'nul-inside'],
      ['a token far past the length bound', 'overlong'],
      ['a character outside the base64url alphabet', 'foreign-alphabet'],
    ] as const)('answers %s byte-identically too', async (_name, kind) => {
      const probeToken = await tokenFor(kind);
      const guessed = await readEdit('AAAAAAAAAAAAAAAAAAAAAA');
      const probe = await readEdit(probeToken);

      expect(probe.status).toBe(404);
      expect(probe.status).toBe(guessed.status);
      expect(probe.text).toBe(guessed.text);
      expect(stableHeaders(probe)).toStrictEqual(stableHeaders(guessed));
    });

    /** The write route refuses in exactly the same way. */
    it('refuses the write with the same 404 and writes nothing', async () => {
      const { form, token } = await editableAnswer(
        'Fremdes Token schreibt nicht',
      );
      const before = await rowsOf(form.id);

      const written = await writeEdit('AAAAAAAAAAAAAAAAAAAAAA', {
        answers: { [NAME]: 'Fremd' },
      });
      expect(written.status).toBe(404);
      expect(written.text).toContain(PUBLIC_FORM_NOT_FOUND_MESSAGE);
      expect(await rowsOf(form.id)).toBe(before);

      // …and the real answer is untouched.
      const still = await readEdit(token);
      expect(
        (still.body as { answers: Record<string, unknown> }).answers,
      ).toEqual({ [NAME]: 'Anton' });
    });

    /**
     * **Somebody else's token opens somebody else's answer and nothing more.**
     *
     * The sharper half of „only one's own": two answers to the *same* form, each
     * with its own token, and neither token reaches the other row. A single-row
     * fixture could not tell „the token selects a row" from „there is only one".
     */
    it('opens exactly the one answer it was minted for', async () => {
      const form = await publishedForm('Zwei Antworten');
      await configure(form.id, { access: true }, { allowEdit: true });

      const first = await submit(form.slug, { [NAME]: 'Anton' });
      const second = await submit(form.slug, { [NAME]: 'Bertram' });
      const firstToken = tokenOf((first.body as { editUrl: string }).editUrl);
      const secondToken = tokenOf((second.body as { editUrl: string }).editUrl);
      expect(firstToken).not.toBe(secondToken);

      expect(
        (
          (await readEdit(firstToken)).body as {
            answers: Record<string, string>;
          }
        ).answers,
      ).toEqual({ [NAME]: 'Anton' });
      expect(
        (
          (await readEdit(secondToken)).body as {
            answers: Record<string, string>;
          }
        ).answers,
      ).toEqual({ [NAME]: 'Bertram' });

      // And a write through one does not touch the other.
      expect(
        (
          await writeEdit(firstToken, {
            answers: { [NAME]: 'Anton der Ältere' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          (await readEdit(secondToken)).body as {
            answers: Record<string, string>;
          }
        ).answers,
      ).toEqual({ [NAME]: 'Bertram' });
    });

    /** The probes above, each built through the route that produces it. */
    async function tokenFor(
      kind:
        | 'deleted'
        | 'deleted-form'
        | 'draft-form'
        | 'nul'
        | 'nul-inside'
        | 'overlong'
        | 'foreign-alphabet',
    ): Promise<string> {
      if (kind === 'nul') {
        return '%00';
      }
      if (kind === 'nul-inside') {
        return 'AbCd%00Ef123456';
      }
      if (kind === 'overlong') {
        return 'A'.repeat(500);
      }
      if (kind === 'foreign-alphabet') {
        // `+` and `/` belong to plain base64, not to base64url — a token that
        // looks almost right must not take a different branch from one that
        // does not.
        return 'AAAA%2BAAA%2FAAAAAAAAAA';
      }

      const { form, token } = await editableAnswer(`Probe ${kind}`);
      if (kind === 'deleted') {
        await app().prisma.response.updateMany({
          where: { formId: form.id },
          data: { deletedAt: new Date() },
        });
      }
      if (kind === 'deleted-form') {
        await app().prisma.form.update({
          where: { id: form.id },
          data: { deletedAt: new Date() },
        });
      }
      if (kind === 'draft-form') {
        await app().prisma.form.update({
          where: { id: form.id },
          data: { status: 'draft' },
        });
      }
      return token;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The refusal chain of the edit route
  // ═══════════════════════════════════════════════════════════════════════

  describe('the refusal chain', () => {
    async function expectRefused(
      token: string,
      formId: string,
      reason: keyof typeof SUBMISSION_REFUSAL_MESSAGES,
      body: Record<string, unknown> = { answers: { [NAME]: 'Geändert' } },
    ): Promise<void> {
      const before = await rowsOf(formId);

      const read = await readEdit(token);
      expect(read.status).toBe(409);
      expect(read.body).toMatchObject({
        reason,
        message: SUBMISSION_REFUSAL_MESSAGES[reason],
      });

      const written = await writeEdit(token, body);
      expect(written.status).toBe(409);
      expect(written.body).toMatchObject({
        reason,
        message: SUBMISSION_REFUSAL_MESSAGES[reason],
      });

      expect(await rowsOf(formId)).toBe(before);
    }

    /**
     * **The third bullet of the requirement, and the one a careless test proves
     * backwards.**
     *
     * The token is minted while `allowEdit` is on — it is a *valid* token — and
     * the setting is switched off afterwards. A test that only checked the
     * setting before issuing would show the opposite of what the requirement says:
     * that the decision is made once. It is made on **every** access, on the
     * read and on the write alike.
     */
    it('refuses a perfectly valid token once „Bearbeiten" is switched off', async () => {
      const { form, token } = await editableAnswer('Erst erlaubt, dann nicht');
      expect((await readEdit(token)).status).toBe(200);

      await configure(form.id, { access: true }, { allowEdit: false });

      await expectRefused(token, form.id, 'editing_disabled');
    });

    /** The same for a form that never allowed it — the token exists regardless. */
    it('refuses a token for a form that never offered editing', async () => {
      const form = await publishedForm('Nie erlaubt');
      // **Switched off, not unset** (review finding 16): „Bearbeiten nach
      // Absenden" is on ex works, and „never allowed" is from now on a
      // decision of this form instead of the absence of one.
      await configure(form.id, { access: true }, { allowEdit: false });
      expect((await submit(form.slug)).status).toBe(200);
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { editToken: true },
      });

      await expectRefused(row.editToken ?? '', form.id, 'editing_disabled');
    });

    /**
     * **The deadline, second bullet.** The answer was handed in while the form
     * was open; the window closes afterwards, and the link stops working —
     * „über ihn kann er seine Antwort **bis zum Fristende** ändern".
     */
    it('refuses the token after closeAt', async () => {
      const { form, token } = await editableAnswer('Frist');
      expect((await readEdit(token)).status).toBe(200);

      await configure(
        form.id,
        { access: true },
        {
          allowEdit: true,
          openEnabled: true,
          openAt: '2026-01-01T00:00:00.000Z',
          closeAt: '2026-01-02T00:00:00.000Z',
        },
      );

      await expectRefused(token, form.id, 'closed');
    });

    it('refuses the token before openAt', async () => {
      const { form, token } = await editableAnswer('Noch nicht');
      await configure(
        form.id,
        { access: true },
        {
          allowEdit: true,
          openEnabled: true,
          openAt: '2099-01-01T00:00:00.000Z',
          closeAt: '2099-02-01T00:00:00.000Z',
        },
      );

      await expectRefused(token, form.id, 'not_yet_open');
    });

    /**
     * **The response limit is deliberately *not* in this chain**, and that is a
     * decision worth a test rather than a comment.
     *
     * The form is filled to its limit; the participant who is already inside can
     * still correct their answer. Judging an edit by the limit would refuse a
     * correction to a registration that was in time because other people
     * registered afterwards — and the seat this answer occupies is its own.
     */
    it('lets an edit through even when the form is full', async () => {
      const form = await publishedForm('Voll');
      await configure(
        form.id,
        { access: true },
        { allowEdit: true, maxResponsesEnabled: true, maxResponses: 1 },
      );

      const submitted = await submit(form.slug, { [NAME]: 'Anton' });
      expect(submitted.status).toBe(200);
      const token = tokenOf((submitted.body as { editUrl: string }).editUrl);

      // The form is full: a second submission is refused.
      const refused = await submit(form.slug, { [NAME]: 'Bertram' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'limit_reached' });

      // The edit is not.
      expect((await readEdit(token)).status).toBe(200);
      const written = await writeEdit(token, {
        answers: { [NAME]: 'Anton B.' },
      });
      expect(written.status).toBe(200);
      expect(await rowsOf(form.id)).toBe(1);
    });

    /**
     * **The time limit does apply** — the setting says „Zeitlimit pro
     * Ausfüllung", and an edit is one. The read mints a fresh start token, so
     * the honest path is unaffected; a stale one is refused exactly as on a
     * first submission.
     */
    it('refuses an edit whose attempt ran out of time', async () => {
      const { form, token } = await editableAnswer('Zeitlimit');
      await configure(
        form.id,
        { access: true },
        { allowEdit: true, timeLimitEnabled: true, timeLimitMin: 5 },
      );

      const slug = form.slug;
      const stale = startTokens.issue(slug, new Date(Date.now() - 6 * 60_000));
      const before = await rowsOf(form.id);

      const written = await writeEdit(token, {
        answers: { [NAME]: 'Zu spät' },
        startToken: stale,
      });
      expect(written.status).toBe(409);
      expect(written.body).toMatchObject({ reason: 'time_limit' });
      expect(await rowsOf(form.id)).toBe(before);

      // A fresh one — the token the read just minted — goes through.
      const fresh = (await readEdit(token)).body as {
        form: { startToken: string };
      };
      const ok = await writeEdit(token, {
        answers: { [NAME]: 'Rechtzeitig' },
        startToken: fresh.form.startToken,
      });
      expect(ok.status).toBe(200);
    });

    /**
     * **The password gate is deliberately *not* in this chain**, and the
     * decision is written down in `PublicFormsService.byEditToken`: the token is
     * only ever issued to somebody who already passed the gate (the password gate is
     * one link of the submission chain), it is a strictly stronger capability, and later work put
     * the link in a mail that carries no access word.
     *
     * The test states the consequence rather than hiding it: a protected form's
     * edit link works **without** a proof — and the answers it opens are the
     * ones the holder wrote.
     */
    it('opens a protected form’s answer without asking for the word again', async () => {
      const form = await publishedForm('Geschützt');
      await configure(
        form.id,
        { access: true },
        {
          allowEdit: true,
          passwordEnabled: true,
          password: 'Jahrestagung2026',
        },
      );

      // The gate, once — the only way to submit at all.
      const granted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/access`))
        .set('X-Forwarded-For', ownAddress())
        .send({ password: 'Jahrestagung2026' });
      expect(granted.status).toBe(200);
      const proof = (granted.body as { accessToken: string }).accessToken;

      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set('X-Form-Access', proof)
        .send({ answers: { [NAME]: 'Anton' } });
      expect(submitted.status).toBe(200);
      const token = tokenOf((submitted.body as { editUrl: string }).editUrl);

      // No proof anywhere near these two.
      expect((await readEdit(token)).status).toBe(200);
      expect(
        (await writeEdit(token, { answers: { [NAME]: 'Anton B.' } })).status,
      ).toBe(200);
    });

    /**
     * Fail closed, exactly as on the submission: an unreadable settings document
     * refuses with 503 rather than degrading to „no deadline, no limit, no
     * password" — which here would additionally mean „editing allowed".
     *
     * The row is written **straight into the column**, because the API cannot
     * produce it — and that is the point: the writer is a different version.
     */
    it('refuses with 503 when the settings cannot be read', async () => {
      const { form, token } = await editableAnswer('Unlesbar');
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "settings_override" = jsonb_build_object(
           'overridden', jsonb_build_object(
             'access', false, 'confirm', false, 'display', false
           ),
           'values', jsonb_build_object('einstellungAusM9', true)
         ) WHERE "id" = $1::uuid`,
        form.id,
      );

      const before = await rowsOf(form.id);
      expect((await readEdit(token)).status).toBe(503);
      expect(
        (await writeEdit(token, { answers: { [NAME]: 'X' } })).status,
      ).toBe(503);
      expect(await rowsOf(form.id)).toBe(before);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // What an edit is: one row, its own version, two timestamps
  // ═══════════════════════════════════════════════════════════════════════

  describe('an edit', () => {
    it('changes the answer without creating a second row', async () => {
      const { form, token } = await editableAnswer('Eine Zeile');
      expect(await rowsOf(form.id)).toBe(1);

      const written = await writeEdit(token, {
        answers: { [NAME]: 'Anton der Ältere' },
      });
      expect(written.status).toBe(200);

      expect(await rowsOf(form.id)).toBe(1);
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
      });
      expect(row.answers).toEqual({ [NAME]: 'Anton der Ältere' });
    });

    /**
     * **It does not count again against the response limit.** The limit is 2,
     * one seat is taken, and three edits later there is still exactly one seat
     * taken and one free — an edit that re-counted would have filled the form.
     */
    it('does not count again against the response limit', async () => {
      const form = await publishedForm('Limit');
      await configure(
        form.id,
        { access: true },
        { allowEdit: true, maxResponsesEnabled: true, maxResponses: 2 },
      );

      const submitted = await submit(form.slug, { [NAME]: 'Anton' });
      const token = tokenOf((submitted.body as { editUrl: string }).editUrl);

      for (const value of ['Anton A.', 'Anton B.', 'Anton C.']) {
        expect(
          (await writeEdit(token, { answers: { [NAME]: value } })).status,
        ).toBe(200);
      }

      expect(await rowsOf(form.id)).toBe(1);
      // The second seat is still free.
      expect((await submit(form.slug, { [NAME]: 'Bertram' })).status).toBe(200);
      expect(await rowsOf(form.id)).toBe(2);
    });

    /**
     * **The schema stand stays the one of the original submission** .
     *
     * The form gains a required question in version 2. The old answer is still
     * rendered against version 1 — and can still be saved, without the field
     * that did not exist when it was handed in. The alternative would demand a
     * „Semester" of somebody who registered before there was one.
     */
    it('renders and validates against the version the answer was given to', async () => {
      const { form, token } = await editableAnswer('Fassungen');
      await republish(form.id, 'Fassungen', [NAME, SEMESTER]);

      const read = await readEdit(token);
      expect(read.status).toBe(200);
      const payload = read.body as {
        form: {
          version: number;
          definition: { pages: { questions: unknown[] }[] };
        };
      };
      expect(payload.form.version).toBe(1);
      expect(payload.form.definition.pages[0]?.questions).toHaveLength(1);

      // Saved without the new required question — because it is not part of
      // this answer's version.
      const written = await writeEdit(token, {
        answers: { [NAME]: 'Anton B.' },
      });
      expect(written.status).toBe(200);

      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        include: { formVersion: true },
      });
      expect(row.formVersion.version).toBe(1);

      // …and a value for the *newer* question is refused, because version 1
      // does not know it. This is the other direction of the same rule.
      const smuggled = await writeEdit(token, {
        answers: { [NAME]: 'Anton', [SEMESTER]: 'WS 2026/27' },
      });
      expect(smuggled.status).toBe(400);
    });

    /**
     * **The time of the change is kept separately** — the last sentence of the
     * requirement. `submitted_at` is what an organisation reconciles its registration list
     * against; moving it on a typo correction would push a registration past a
     * deadline it met.
     */
    it('keeps submittedAt and records editedAt beside it', async () => {
      const { form, token } = await editableAnswer('Zeitpunkte');

      const before = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { submittedAt: true, editedAt: true },
      });
      expect(before.editedAt).toBeNull();

      expect(
        (await writeEdit(token, { answers: { [NAME]: 'Anton B.' } })).status,
      ).toBe(200);

      const after = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { submittedAt: true, editedAt: true },
      });
      expect(after.submittedAt.toISOString()).toBe(
        before.submittedAt.toISOString(),
      );
      expect(after.editedAt).not.toBeNull();
      expect(after.editedAt?.getTime()).toBeGreaterThanOrEqual(
        before.submittedAt.getTime(),
      );

      // …and it travels, so the participant can see which is which.
      const read = (await readEdit(token)).body as {
        submittedAt: string;
        editedAt: string | null;
      };
      expect(read.submittedAt).toBe(before.submittedAt.toISOString());
      expect(read.editedAt).toBe(after.editedAt?.toISOString());
    });

    /** The server validates, whatever the browser let through. */
    it('refuses an answer that does not satisfy the snapshot', async () => {
      const { form, token } = await editableAnswer('Pflichtfeld');
      const before = await rowsOf(form.id);

      const written = await writeEdit(token, { answers: { [NAME]: '' } });
      expect(written.status).toBe(400);
      expect(await rowsOf(form.id)).toBe(before);

      // …and the stored answer is unchanged.
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
      });
      expect(row.answers).toEqual({ [NAME]: 'Anton' });
    });

    /** The envelope, not the answers — the same shape the submission refuses. */
    it('refuses a body that is not a submission at all', async () => {
      const { token } = await editableAnswer('Kaputte Hülle');
      expect((await writeEdit(token, { antworten: {} })).status).toBe(400);
    });

    /**
     * **Two tabs, one link** (the analogue of the parallel case
     * elsewhere for the response limit).
     *
     * Structurally nothing can go wrong — the write is an `updateMany` on the
     * row the token names, never a `create` — and *last write wins* is the
     * documented behaviour. That is an argument, not evidence: the same
     * argument was available for the response limit, where `count()` + `insert`
     * passed sequentially and overbooked under load. Two writes at once, and
     * the assertion is the one that would break first: still exactly one row.
     */
    it('keeps one row when two tabs save the same link at once', async () => {
      const { form, token } = await editableAnswer('Zwei Tabs');

      const [first, second] = await Promise.all([
        writeEdit(token, { answers: { [NAME]: 'Anton aus Tab 1' } }),
        writeEdit(token, { answers: { [NAME]: 'Anton aus Tab 2' } }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await rowsOf(form.id)).toBe(1);

      // Last write wins, and „last" is whichever the database served second —
      // the test does not claim which, only that the row holds one of the two
      // whole answers rather than a mixture.
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { answers: true, editToken: true },
      });
      expect([
        { [NAME]: 'Anton aus Tab 1' },
        { [NAME]: 'Anton aus Tab 2' },
      ]).toContainEqual(row.answers);
      // …and the capability survived both: an edit does not re-mint the token.
      expect(row.editToken).toBe(token);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The payload itself — a closed list, like the other public one
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **What this payload gives to strangers is a closed list**
   * (a security review finding).
   *
   * `GET /public/forms/:slug` has had this (`public-forms.spec.ts`,
   * „the closed list itself"). This route is **just as public and just as
   * sessionless** — it is reached with a token and nothing else, and it is
   * deliberately past the access word — and it had no such probe: the client
   * schema pins what the *browser parses*, not what the server puts on the
   * wire, because Zod drops the rest in silence. Every server-derived field
   * that joins the payload (upload references; `eventSeats`)
   * arrives here too, and did so unremarked.
   *
   * The two literals below are the expectation and have to be — a list derived
   * from the answer would agree with whatever the server sends. What is derived
   * is the *actual* side, so a new field makes the two disagree and somebody has
   * to justify sending it to a stranger.
   */
  describe('the payload of the edit route', () => {
    /** Object keys of a member, sorted — `[]` if it is not an object. */
    function keysOf(value: unknown): string[] {
      return typeof value === 'object' && value !== null
        ? Object.keys(value).sort()
        : [];
    }

    it('carries exactly the documented keys, top level and form', async () => {
      const { token } = await editableAnswer('Geschlossene Liste');

      const answered = await readEdit(token);
      expect(answered.status).toBe(200);
      const body = JSON.parse(answered.text) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual([
        'answers',
        'editedAt',
        'form',
        'submittedAt',
      ]);
      // The embedded form is the same document `GET /public/forms/:slug`
      // delivers, so it is held to the same twelve keys — `locked` included,
      // the discriminator that makes the union readable.
      expect(keysOf(body.form)).toEqual([
        'availability',
        // The requirement — and on **this** route it is always `false`: an
        // answer that is already filed has no draft to save, so the edit view
        // must not offer the button even where the form allows saving. The
        // value is asserted below, not only its presence.
        'canSaveDraft',
        'definition',
        'display',
        'eventSeats',
        'locked',
        // **The privacy notice of this form** (ADR-0028 no. 4) — the
        // one key of this list that was written expressly to be read by
        // the participating person. It does not bind them and
        // wards off nothing; it is the information that Art. 13 Abs. 1 DSGVO
        // demands „zum Zeitpunkt der Erhebung", and withholding it would not be
        // data minimisation, but the breach of duty itself. `null`
        // means „nichts hinterlegt".
        'privacyNotice',
        'startToken',
        'tenant',
        // The time limit (finding 32). A correction is a filling-in like
        // every other: it mints a fresh start proof one line
        // higher and is refused with `time_limit` if it takes too
        // long — so the number belongs on the screen that shows it.
        'timeLimitMin',
        'title',
        'version',
      ]);
      expect((body.form as Record<string, unknown>).canSaveDraft).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The revocation — what makes the password gate true again
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **The edit route hands out the whole field definition without asking for the
   * access word.** That is defensible only while every token in circulation was
   * issued *behind* the gate — and it is not automatic:
   *
   * 1. a form is open and unprotected, somebody submits and gets a token;
   * 2. the organisation switches the password on afterwards, the usual reason being
   *    that the link has leaked;
   * 3. that token would still open an unauthenticated `GET` carrying
   *    `form.definition` in full, plus a fresh start token and an
   *    unauthenticated `PUT`.
   *
   * without qualification that a `GET` without a proof
   * delivers **no** field definition. So the write that raises the gate takes
   * the older capabilities with it: switching the access word on, or changing
   * it, clears `response.edit_token` for that form in the same transaction as
   * the settings.
   *
   * The four cases below are the whole rule — the two that revoke, the one that
   * must not, and the blast radius.
   */
  describe('switching the access word on revokes the links already out', () => {
    /** The word that turns a form of this suite into a protected one. */
    const WORD = 'Jahrestagung2026';

    /** Settings of a form with the access section taken over. */
    async function access(
      formId: string,
      values: Record<string, unknown>,
    ): Promise<void> {
      await configure(formId, { access: true }, { allowEdit: true, ...values });
    }

    /**
     * The case from the finding, end to end and through the real routes.
     *
     * The refusal is compared against a token that was never minted, because
     * „revoked" has to be indistinguishable from „never existed": a 404 that
     * differed in body, length or `etag` would turn the address into a way of
     * asking whether somebody registered before the word was set.
     */
    it('turns a token minted before the gate into the plain 404', async () => {
      const { form, token } = await editableAnswer(
        'Erst offen, dann geschützt',
      );
      // Still open at this point — the capability works.
      expect((await readEdit(token)).status).toBe(200);

      await access(form.id, { passwordEnabled: true, password: WORD });

      const read = await readEdit(token);
      const unknown = await readEdit('AAAAAAAAAAAAAAAAAAAAAA');
      expect(read.status).toBe(404);
      expect(read.text).toBe(unknown.text);
      expect(stableHeaders(read)).toStrictEqual(stableHeaders(unknown));

      // The write half, and it is the half that would change data.
      const written = await writeEdit(token, { answers: { [NAME]: 'Fremd' } });
      const unknownWrite = await writeEdit('AAAAAAAAAAAAAAAAAAAAAA', {
        answers: { [NAME]: 'Fremd' },
      });
      expect(written.status).toBe(404);
      expect(written.text).toBe(unknownWrite.text);
      expect(stableHeaders(written)).toStrictEqual(stableHeaders(unknownWrite));

      // The answer itself is untouched — revoked is not deleted.
      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { answers: true, editToken: true },
      });
      expect(row.answers).toEqual({ [NAME]: 'Anton' });
      expect(row.editToken).toBeNull();
    });

    /**
     * The second half of the rule, and the one a „only when switching on"
     * implementation would fail: an organisation changes the word **because** the old one
     * leaked, and „the word is gone" has to mean „the links are gone" too.
     */
    it('revokes again when the word is changed while the gate stands', async () => {
      const form = await publishedForm('Wortwechsel');
      await access(form.id, { passwordEnabled: true, password: WORD });

      const granted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/access`))
        .set('X-Forwarded-For', ownAddress())
        .send({ password: WORD });
      expect(granted.status).toBe(200);

      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set(
          'X-Form-Access',
          (granted.body as { accessToken: string }).accessToken,
        )
        .send({ answers: { [NAME]: 'Anton' } });
      expect(submitted.status).toBe(200);
      const token = tokenOf((submitted.body as { editUrl: string }).editUrl);
      expect((await readEdit(token)).status).toBe(200);

      await access(form.id, {
        passwordEnabled: true,
        password: 'Jahrestagung2027',
      });

      expect((await readEdit(token)).status).toBe(404);
      expect(
        (await writeEdit(token, { answers: { [NAME]: 'X' } })).status,
      ).toBe(404);
    });

    /**
     * **Switching the protection off revokes nothing**, and this is the case
     * that keeps the rule from being „every change to this section throws
     * everything away". There is nothing left to protect, and taking every
     * participant's link away in order to *loosen* a restriction would be a data
     * loss nobody asked for.
     */
    it('leaves the links alone when the protection is switched off', async () => {
      const form = await publishedForm('Schutz wieder aus');
      await access(form.id, { passwordEnabled: true, password: WORD });

      const granted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/access`))
        .set('X-Forwarded-For', ownAddress())
        .send({ password: WORD });
      const submitted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set(
          'X-Form-Access',
          (granted.body as { accessToken: string }).accessToken,
        )
        .send({ answers: { [NAME]: 'Anton' } });
      const token = tokenOf((submitted.body as { editUrl: string }).editUrl);

      await access(form.id, { passwordEnabled: false, password: '' });

      expect((await readEdit(token)).status).toBe(200);
      expect(
        (await writeEdit(token, { answers: { [NAME]: 'Anton B.' } })).status,
      ).toBe(200);
    });

    /**
     * **An answer in the trash is revoked with the rest** — the case that
     * makes the missing `deletedAt` in `updateSettingsOverride`'s `where` a
     * decision rather than an oversight (a security review finding).
     *
     * That `where` is `{ formId, tenantId }` and deliberately says nothing about
     * `deleted_at`. Until the trash could be restored, that was a statement about an unreachable
     * state: no route put `response.deleted_at` back to `null`, so a deleted
     * answer never came back to use a link. Since the trash restores, it is
     * the **only** thing standing between „the word is gone, the links are gone"
     * and a token that outlives the revocation by spending the interval in the
     * trash — and „only touch the living answers" is precisely what a
     * later reader would tidy the `where` into.
     *
     * *Reproduction, measured on 2026-08-03:* adding `deletedAt: null` to that
     * `where` answers **200** here, on a form the organisation protected in between,
     * with the full field definition and a fresh start token — and leaves every
     * other case in this file green.
     */
    it('revokes a link whose answer sat in the Papierkorb while the word moved', async () => {
      const { form, token } = await editableAnswer('Im Papierkorb geschützt');
      const answer = await app().prisma.response.findFirstOrThrow({
        where: { formId: form.id },
        select: { id: true },
      });

      // 1. Away it goes — the state the revocation must not skip.
      expect(
        (
          await request(app().server)
            .delete(apiPath(`/forms/${form.id}/responses/${answer.id}`))
            .set(authedMutation(editor))
        ).status,
      ).toBe(204);

      // 2. The organisation raises the gate while it is away, the usual reason being a
      //    leaked link.
      await access(form.id, { passwordEnabled: true, password: WORD });

      // 3. …and back it comes, with everything it had.
      expect(
        (
          await request(app().server)
            .post(apiPath(`/forms/${form.id}/responses/${answer.id}/restore`))
            .set(authedMutation(editor))
        ).status,
      ).toBe(204);

      const read = await readEdit(token);
      const unknown = await readEdit('AAAAAAAAAAAAAAAAAAAAAA');
      expect(read.status).toBe(404);
      expect(read.text).toBe(unknown.text);
      expect(
        (await writeEdit(token, { answers: { [NAME]: 'Fremd' } })).status,
      ).toBe(404);

      // Revoked, not deleted: the answer is back and readable by the organisation.
      const row = await app().prisma.response.findUniqueOrThrow({
        where: { id: answer.id },
        select: { answers: true, editToken: true, deletedAt: true },
      });
      expect(row.deletedAt).toBeNull();
      expect(row.answers).toEqual({ [NAME]: 'Anton' });
      expect(row.editToken).toBeNull();
    });

    /**
     * **The blast radius is one form.** A revocation that cleared the column by
     * tenant — or, worse, without a `where` on the tenant at all — would pass
     * every test above and quietly cut every participant of the organisation loose.
     */
    it('touches only the answers of the form whose word moved', async () => {
      const shielded = await editableAnswer('Unbeteiligt');
      const target = await editableAnswer('Betroffen');

      await access(target.form.id, { passwordEnabled: true, password: WORD });

      expect((await readEdit(target.token)).status).toBe(404);
      expect((await readEdit(shielded.token)).status).toBe(200);

      const row = await app().prisma.response.findFirstOrThrow({
        where: { formId: shielded.form.id },
        select: { editToken: true },
      });
      expect(row.editToken).toBe(shielded.token);
    });

    /**
     * **The same rule one level up.** A form that has *not* taken *Zugriff &
     * Sicherheit* over is protected by the organisation's word, so switching the
     * protection on in the tenant standards raises the gate for all of them —
     * and their edit links have to go the same way. A form that took the section
     * over is not affected by the tenant write and keeps its links; it is
     * revoked by its own save, which the cases above cover.
     *
     * In an **organisation of its own**, because it writes the shared standards row: the
     * fixtures of this file inherit from `tenant`, and leaving it protected
     * would decide the outcome of every test that runs afterwards.
     */
    it('revokes through the tenant standards, for the forms that inherit', async () => {
      const ownTenant = await createTenant(app().prisma, 'EDIT3');
      const user = await createUser(app().prisma, {
        email: 'editor3@example.org',
        password: PASSWORD,
        tenants: [ownTenant],
      });
      const session = await openSession(testApp, user.id, ownTenant.id);

      /** A published, editable form in that organisation. */
      const build = async (
        title: string,
        overridden: Record<string, boolean>,
        values: Record<string, unknown>,
      ): Promise<{ id: string; token: string }> => {
        const created = await request(app().server)
          .post(apiPath('/forms'))
          .set(authedMutation(session))
          .send({ title });
        const form = created.body as {
          id: string;
          revision: number;
          publicSlug: string;
        };
        const saved = await request(app().server)
          .put(apiPath(`/forms/${form.id}`))
          .set(authedMutation(session))
          .send({ title, definition: definition(), revision: form.revision });
        await request(app().server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(session))
          .send({ revision: (saved.body as { revision: number }).revision });

        const row = await app().prisma.form.findUniqueOrThrow({
          where: { id: form.id },
          select: { settingsRevision: true },
        });
        const standards = await app().prisma.tenant.findUniqueOrThrow({
          where: { id: ownTenant.id },
          select: { formDefaultsRevision: true },
        });
        const settings = await request(app().server)
          .put(apiPath(`/forms/${form.id}/settings`))
          .set(authedMutation(session))
          .send({
            overridden: {
              access: false,
              confirm: false,
              display: false,
              budget: false,
              ...overridden,
            },
            values,
            revision: row.settingsRevision,
            tenantRevision: standards.formDefaultsRevision,
          });
        expect(settings.status).toBe(200);

        const submitted = await submit(form.publicSlug);
        expect(submitted.status).toBe(200);
        return {
          id: form.id,
          token: tokenOf((submitted.body as { editUrl: string }).editUrl),
        };
      };

      // „Bearbeiten nach Absenden" has to be on for both, and it is a key of
      // the very section under test — so the standard carries it, and the
      // form that takes the section over carries its own copy.
      const standards = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: ownTenant.id },
        select: { formDefaultsRevision: true },
      });
      const opened = await request(app().server)
        .put(apiPath('/tenant/form-defaults'))
        .set(authedMutation(session))
        .send({
          // The organisation sets the one value that is at stake — switches
          // no longer exist at this level (review finding 10).
          values: { allowEdit: true },
          revision: standards.formDefaultsRevision,
        });
      expect(opened.status).toBe(200);

      const inheriting = await build('Erbt von der Organisation', {}, {});
      const own = await build(
        'Eigener Abschnitt',
        { access: true },
        {
          allowEdit: true,
        },
      );
      expect((await readEdit(inheriting.token)).status).toBe(200);
      expect((await readEdit(own.token)).status).toBe(200);

      const before = await app().prisma.tenant.findUniqueOrThrow({
        where: { id: ownTenant.id },
        select: { formDefaultsRevision: true },
      });
      const protectedNow = await request(app().server)
        .put(apiPath('/tenant/form-defaults'))
        .set(authedMutation(session))
        .send({
          values: { allowEdit: true, passwordEnabled: true, password: WORD },
          revision: before.formDefaultsRevision,
        });
      expect(protectedNow.status).toBe(200);

      // The inheriting form is behind the gate now — and its link is gone.
      expect((await readEdit(inheriting.token)).status).toBe(404);
      // The one with its own section never moved, so neither did its link.
      expect((await readEdit(own.token)).status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tenant isolation — the token resolves its own Organisation, never the caller's
  // ═══════════════════════════════════════════════════════════════════════

  it('answers with the organisation of the token, never with another one', async () => {
    const other = await createTenant(app().prisma, 'EDIT2');
    const otherUser = await createUser(app().prisma, {
      email: 'editor2@example.org',
      password: PASSWORD,
      tenants: [other],
    });
    const otherEditor = await openSession(testApp, otherUser.id, other.id);

    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(otherEditor))
      .send({ title: 'Fremde Organisation' });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };
    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(otherEditor))
      .send({
        title: 'Fremde Organisation',
        definition: definition(),
        revision: form.revision,
      });
    await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(otherEditor))
      .send({ revision: (saved.body as { revision: number }).revision });

    const tenantRow = await app().prisma.form.findUniqueOrThrow({
      where: { id: form.id },
      select: { settingsRevision: true },
    });
    const standards = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: other.id },
      select: { formDefaultsRevision: true },
    });
    await request(app().server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(otherEditor))
      .send({
        overridden: {
          access: true,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { allowEdit: true },
        revision: tenantRow.settingsRevision,
        tenantRevision: standards.formDefaultsRevision,
      });

    const submitted = await submit(form.publicSlug);
    const token = tokenOf((submitted.body as { editUrl: string }).editUrl);

    const read = (await readEdit(token)).body as {
      form: { tenant: { shortName: string } };
    };
    expect(read.form.tenant.shortName).toBe('EDIT2');

    const stored = await app().prisma.response.findFirstOrThrow({
      where: { editToken: token },
      select: { tenantId: true },
    });
    expect(stored.tenantId).toBe(other.id);
    expect(stored.tenantId).not.toBe(tenant.id);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // A database hiccup after the commit must not become a 500 (a review finding)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * **`PublicUrlService.responseEditUrl` became a database read**
   * — an organisation's own address, then the installation's — and both `submit()`
   * and `updateByEditToken()` call it **after** `storeWithinLimit`/
   * `storeEditWithMails` have already committed. Before that, the address was
   * configuration held in memory and this call could not fail; now it can,
   * and an uncaught failure here would turn an *accepted, stored* answer
   * into a 500 the participant reads as „it did not work" and resends
   * against — the exact double registration the confirmation promise
   * exists to prevent.
   *
   * A provider override rather than a database fault, because the fault this
   * case is about sits **downstream of the commit that must stay intact**: a
   * schema break wide enough to fail `PublicUrlService`'s own queries would
   * also fail the unrelated `include: { tenant: true }` reads `load()` and
   * `loadForEdit()` run first, which would test the wrong thing entirely. A
   * provider that only `PublicUrlService`'s two call sites go through is the
   * narrower, honest fault — the same reason `transport`/`clock` are provider
   * overrides in `create-test-app.ts` rather than a broken SMTP server.
   *
   * Its own application, sharing this file's throwaway database, because the
   * override replaces a provider for the **whole** app — every other case in
   * this file needs the real `PublicUrlService`.
   */
  describe('the link survives a database hiccup after the answer is stored', () => {
    /** Every call fails — `oidcCallbackUrl`/`appUrl` are not used by this
     * route at all, so they are never expected to be called; failing them
     * too would surface a wrong call site loudly instead of silently. */
    const broken: PublicUrlService = {
      responseEditUrl: () =>
        Promise.reject(new Error('simulated database hiccup')),
      oidcCallbackUrl: () =>
        Promise.reject(new Error('not used by this route')),
      appUrl: () => Promise.reject(new Error('not used by this route')),
      // `PublicUrlService` also carries `resolveBaseUrl`; this
      // route does not call it directly, but a structurally complete double
      // is what keeps this cast honest rather than merely convenient.
      resolveBaseUrl: () => Promise.reject(new Error('not used by this route')),
      // `unknown` first, never `any`: a hand-built double of an
      // injectable class structurally lacks its private members, which is
      // the one thing a cast has to paper over here.
    } as unknown as PublicUrlService;

    it('answers editUrl: null instead of 500 on submit — the response is stored anyway', async () => {
      const brokenApp = await createTestApp({
        databaseUrl: database?.url ?? '',
        systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
        env: { TRUST_PROXY_HOPS: 1 },
        publicUrl: broken,
      });
      try {
        const brokenTenant = await createTenant(brokenApp.prisma, 'C6HICCUP1');
        const brokenUser = await createUser(brokenApp.prisma, {
          email: 'c6hiccup1@example.org',
          password: PASSWORD,
          tenants: [brokenTenant],
        });
        const brokenEditor = await openSession(
          brokenApp,
          brokenUser.id,
          brokenTenant.id,
        );

        const created = await request(brokenApp.server)
          .post(apiPath('/forms'))
          .set(authedMutation(brokenEditor))
          .send({ title: 'Aussetzer beim Absenden' });
        const form = created.body as {
          id: string;
          revision: number;
          publicSlug: string;
        };
        const saved = await request(brokenApp.server)
          .put(apiPath(`/forms/${form.id}`))
          .set(authedMutation(brokenEditor))
          .send({
            title: 'Aussetzer beim Absenden',
            definition: definition(),
            revision: form.revision,
          });
        const published = await request(brokenApp.server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(brokenEditor))
          .send({ revision: (saved.body as { revision: number }).revision });
        expect(published.status).toBe(200);

        const submitted = await request(brokenApp.server)
          .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
          .set('X-Forwarded-For', ownAddress())
          .send({ answers: { [NAME]: 'Anton' } });

        // The fix under test: no 500, `editUrl: null` instead.
        expect(submitted.status).toBe(200);
        expect((submitted.body as { editUrl: unknown }).editUrl).toBeNull();

        // …and the answer really is stored — the assurance that matters more
        // than the link.
        const stored = await brokenApp.prisma.response.count({
          where: { formId: form.id },
        });
        expect(stored).toBe(1);
      } finally {
        await brokenApp.close();
      }
    }, 60_000);

    it('answers editUrl: null instead of 500 on an edit — the correction is stored anyway', async () => {
      const brokenApp = await createTestApp({
        databaseUrl: database?.url ?? '',
        systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
        env: { TRUST_PROXY_HOPS: 1 },
        publicUrl: broken,
      });
      try {
        const brokenTenant = await createTenant(brokenApp.prisma, 'C6HICCUP2');
        const brokenUser = await createUser(brokenApp.prisma, {
          email: 'c6hiccup2@example.org',
          password: PASSWORD,
          tenants: [brokenTenant],
        });
        const brokenEditor = await openSession(
          brokenApp,
          brokenUser.id,
          brokenTenant.id,
        );

        const created = await request(brokenApp.server)
          .post(apiPath('/forms'))
          .set(authedMutation(brokenEditor))
          .send({ title: 'Aussetzer beim Bearbeiten' });
        const form = created.body as {
          id: string;
          revision: number;
          publicSlug: string;
        };
        const saved = await request(brokenApp.server)
          .put(apiPath(`/forms/${form.id}`))
          .set(authedMutation(brokenEditor))
          .send({
            title: 'Aussetzer beim Bearbeiten',
            definition: definition(),
            revision: form.revision,
          });
        const published = await request(brokenApp.server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(brokenEditor))
          .send({ revision: (saved.body as { revision: number }).revision });
        expect(published.status).toBe(200);

        // `allowEdit` on, so the write route is reachable at all — the token
        // itself is read straight from the row, because `submit()`'s own
        // confirmation already answers `editUrl: null` under this override.
        const row = await brokenApp.prisma.form.findUniqueOrThrow({
          where: { id: form.id },
          select: { settingsRevision: true, tenantId: true },
        });
        const tenantRow = await brokenApp.prisma.tenant.findUniqueOrThrow({
          where: { id: row.tenantId },
          select: { formDefaultsRevision: true },
        });
        const settingsResponse = await request(brokenApp.server)
          .put(apiPath(`/forms/${form.id}/settings`))
          .set(authedMutation(brokenEditor))
          .send({
            overridden: {
              access: true,
              confirm: false,
              display: false,
              budget: false,
            },
            values: { allowEdit: true },
            revision: row.settingsRevision,
            tenantRevision: tenantRow.formDefaultsRevision,
          });
        expect(settingsResponse.status).toBe(200);

        const submitted = await request(brokenApp.server)
          .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
          .set('X-Forwarded-For', ownAddress())
          .send({ answers: { [NAME]: 'Anton' } });
        expect(submitted.status).toBe(200);
        const stored = await brokenApp.prisma.response.findFirstOrThrow({
          where: { formId: form.id },
          select: { editToken: true },
        });
        expect(stored.editToken).not.toBeNull();

        const edited = await request(brokenApp.server)
          .put(apiPath(`/public/responses/${stored.editToken ?? ''}`))
          .set('X-Forwarded-For', ownAddress())
          .send({ answers: { [NAME]: 'Anton B.' } });

        expect(edited.status).toBe(200);
        expect((edited.body as { editUrl: unknown }).editUrl).toBeNull();

        const after = await brokenApp.prisma.response.findFirstOrThrow({
          where: { formId: form.id },
          select: { answers: true },
        });
        expect(after.answers).toEqual({ [NAME]: 'Anton B.' });
      } finally {
        await brokenApp.close();
      }
    }, 60_000);

    /**
     * **A review finding.** The log line this fault takes used to name neither
     * the organisation nor the underlying error — an organisation whose link fails on every
     * submission produced the same sentence 10 000 times with nothing to
     * distinguish it from a one-off. The tenant id now goes in, and a
     * non-`Error` throw (a string, here) no longer becomes `undefined`.
     */
    it('names the tenant and the cause in the log line, even for a non-Error throw', async () => {
      const stringThrowing: PublicUrlService = {
        responseEditUrl: () =>
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test is exactly a non-Error throw
          Promise.reject('kaputte Verbindung'),
        oidcCallbackUrl: () =>
          Promise.reject(new Error('not used by this route')),
        appUrl: () => Promise.reject(new Error('not used by this route')),
        resolveBaseUrl: () =>
          Promise.reject(new Error('not used by this route')),
      } as unknown as PublicUrlService;

      const brokenApp = await createTestApp({
        databaseUrl: database?.url ?? '',
        systemMail: { publicBaseUrl: TEST_PUBLIC_BASE_URL },
        env: { TRUST_PROXY_HOPS: 1 },
        publicUrl: stringThrowing,
      });
      try {
        const brokenTenant = await createTenant(brokenApp.prisma, 'C6HICCUP3');
        const brokenUser = await createUser(brokenApp.prisma, {
          email: 'c6hiccup3@example.org',
          password: PASSWORD,
          tenants: [brokenTenant],
        });
        const brokenEditor = await openSession(
          brokenApp,
          brokenUser.id,
          brokenTenant.id,
        );

        const created = await request(brokenApp.server)
          .post(apiPath('/forms'))
          .set(authedMutation(brokenEditor))
          .send({ title: 'Aussetzer mit String-Throw' });
        const form = created.body as {
          id: string;
          revision: number;
          publicSlug: string;
        };
        const saved = await request(brokenApp.server)
          .put(apiPath(`/forms/${form.id}`))
          .set(authedMutation(brokenEditor))
          .send({
            title: 'Aussetzer mit String-Throw',
            definition: definition(),
            revision: form.revision,
          });
        const published = await request(brokenApp.server)
          .post(apiPath(`/forms/${form.id}/publish`))
          .set(authedMutation(brokenEditor))
          .send({ revision: (saved.body as { revision: number }).revision });
        expect(published.status).toBe(200);

        const capture = captureStdio();
        try {
          const submitted = await request(brokenApp.server)
            .post(apiPath(`/public/forms/${form.publicSlug}/responses`))
            .set('X-Forwarded-For', ownAddress())
            .send({ answers: { [NAME]: 'Anton' } });
          expect(submitted.status).toBe(200);
          expect((submitted.body as { editUrl: unknown }).editUrl).toBeNull();

          const logged = capture.text();
          expect(logged).toContain(brokenTenant.id);
          expect(logged).toContain('kaputte Verbindung');
          expect(logged).not.toContain('undefined');
        } finally {
          capture.restore();
        }
      } finally {
        await brokenApp.close();
      }
    }, 60_000);
  });
});
