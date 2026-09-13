import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SecretBoxService } from '../../src/common/secret-box/secret-box.service';
import { SigningService } from '../../src/common/secret-box/signing.service';
import { AccessProofService } from '../../src/public/access-proof.service';
import { StartTokenService } from '../../src/public/start-token.service';
import {
  ACCESS_PROOF_HEADER,
  PublicFormsController,
} from '../../src/public/public-forms.controller';
import { PUBLIC_ACCESS_RATE_LIMIT } from '../../src/public/public-forms.rate-limit';
import {
  PUBLIC_FORM_NOT_FOUND_MESSAGE,
  SUBMISSION_REFUSAL_MESSAGES,
} from '../../src/public/public-forms.service';
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
import {
  compareInterleaved,
  expectSameOrderOfTime,
} from '../support/timing-comparison';

/**
 * **The password protection as a security boundary.**
 *
 * Every request below goes straight at the public endpoints, past any browser:
 * that is the requirement's own framing — „der Schutz muss halten, wenn niemand
 * die Oberfläche benutzt". The fill-in view is tested separately and proves
 * nothing about this.
 *
 * ## Two things about the setup
 *
 * **`TRUST_PROXY_HOPS: 1` plus an `X-Forwarded-For` per request.** The gate
 * allows ten attempts a minute per address *and form*
 * (`public-forms.rate-limit.ts`), and the sixth bullet's suite alone spends
 * more than that. Every helper below therefore takes an address, and the two
 * tests that are *about* the limit choose theirs on purpose — which is also
 * how bullet 5 („die Drosselung darf keine Waffe sein") is testable at all.
 *
 * **No session anywhere.** The editor session exists only to build fixtures
 * through the real routes; a participant has no account.
 */

const PASSWORD = 'test-password';
const WORD = 'Jahrestagung2026';
const PAGE = '019ff400-0000-7000-8000-0000000000a0';
const NAME = '019ff400-0000-7000-8000-000000000001';

function definition() {
  return {
    pages: [
      {
        // Deliberately not a word that also occurs in a form *title*: the test
        // below searches the raw locked payload for it, and „Anmeldung" is a
        // substring of „Jahrestagung-Anmeldung", so the search would have been
        // green for the wrong reason.
        id: PAGE,
        title: 'Seitenueberschrift-hinter-dem-Wort',
        questions: [
          {
            id: NAME,
            type: 'text',
            label: 'Zunamen-hinter-dem-Wort',
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

/**
 * Everything a byte-comparison of two answers must ignore.
 *
 * The same short list `test/auth/auth.spec.ts` uses for the login's
 * enumeration proof, and short for the same reason: the rate limiter runs with
 * `setHeaders: false`, so no `X-RateLimit-*` counts down between two requests
 * and has to be excused here.
 *
 * **The list is one entry long, and `etag` is deliberately not in it.** The
 * comment here used to claim the opposite — that `etag` was excused because it
 * is derived from the body and comparing it would be circular. It is not
 * excused, and that is the stricter reading: a header derived from the body is
 * one more way for two answers to differ, and it costs nothing to require that
 * it does not. Circular it would only be if it were the *only* thing compared.
 */
/*
 * `x-request-id` came later and is **random per request**. It is up for debate
 * here and not in the application: the assurance of this file
 * is that two answers give away **nothing about their occasion** — not that
 * they are byte for byte the same. A random number gives nothing away; it
 * only distinguishes two retrievals, which a timestamp would do too.
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

describe('the password gate ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let tenant: TenantFixture;
  let editor: string;
  let proofs: AccessProofService;
  /** The signer of the start token — so „too old“ is testable without waiting. */
  let startTokens: StartTokenService;

  /** A published, password-protected form and its address. */
  let guarded: { id: string; slug: string };
  /** A published form **without** a password — the control. */
  let open: { id: string; slug: string };

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({
      databaseUrl: database.url,
      env: { TRUST_PROXY_HOPS: 1 },
    });

    // The application's **own** signer, so a proof minted in a test is one this
    // server would accept — a second implementation here could keep passing
    // after the real one changed, which is the one thing a test of a signature
    // must not do.
    proofs = testApp.app.get(AccessProofService);
    startTokens = testApp.app.get(StartTokenService);

    tenant = await createTenant(testApp.prisma, 'PWD');
    const user = await createUser(testApp.prisma, {
      email: 'editor@example.org',
      password: PASSWORD,
      tenants: [tenant],
    });
    editor = await openSession(testApp, user.id, tenant.id);

    guarded = await publishedForm('Jahrestagung-Anmeldung');
    await configure(
      guarded.id,
      { access: true },
      { passwordEnabled: true, password: WORD },
    );
    open = await publishedForm('Ohne Zugangswort');
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

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

  /** The public read, optionally carrying a proof. */
  async function read(
    slug: string,
    proof?: string,
    address = ownAddress(),
  ): Promise<request.Response> {
    const call = request(app().server)
      .get(apiPath(`/public/forms/${slug}`))
      .set('X-Forwarded-For', address);
    return proof === undefined ? call : call.set(ACCESS_PROOF_HEADER, proof);
  }

  /** One attempt at the gate, from a nameable address. */
  async function attempt(
    slug: string,
    body: Record<string, unknown>,
    address = ownAddress(),
  ): Promise<request.Response> {
    return request(app().server)
      .post(apiPath(`/public/forms/${slug}/access`))
      .set('X-Forwarded-For', address)
      .send(body);
  }

  /** A passed gate, asserted, returning the proof. */
  async function unlock(slug: string, word = WORD): Promise<string> {
    const response = await attempt(slug, { password: word });
    expect(response.status).toBe(200);
    const granted = (response.body as { accessToken?: unknown }).accessToken;
    expect(typeof granted).toBe('string');
    return typeof granted === 'string' ? granted : '';
  }

  async function submit(
    slug: string,
    proof?: string,
  ): Promise<request.Response> {
    const call = request(app().server)
      .post(apiPath(`/public/forms/${slug}/responses`))
      .set('X-Forwarded-For', ownAddress());
    const withProof =
      proof === undefined ? call : call.set(ACCESS_PROOF_HEADER, proof);
    return withProof.send({ answers: { [NAME]: 'Anton' } });
  }

  async function rowsOf(formId: string): Promise<number> {
    return app().prisma.response.count({ where: { formId } });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1 — the questions arrive only once the check has been passed
  // ═══════════════════════════════════════════════════════════════════════

  describe('1 — the questions are delivered only after the gate', () => {
    /**
     * The load-bearing test of the whole requirement. „Ohne diese Anforderung wäre
     * der Schutz ein Vorhang vor einer offenen Tür": the question is not whether
     * the browser shows a prompt but whether the questions ever crossed the
     * wire.
     *
     * Asserted on the **raw text**, not on parsed members: a definition nested
     * under a key nobody expected would pass a key check and fail this.
     */
    it('answers a locked form with title, Organisation and nothing else', async () => {
      const response = await read(guarded.slug);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body as object).sort()).toEqual([
        'locked',
        'tenant',
        'title',
      ]);
      expect(response.body).toMatchObject({
        locked: true,
        title: 'Jahrestagung-Anmeldung',
        tenant: { name: 'Organisation PWD' },
      });

      // The questions themselves — id, label and the page they sit on.
      expect(response.text).not.toContain(NAME);
      expect(response.text).not.toContain(PAGE);
      expect(response.text).not.toContain('Zunamen-hinter-dem-Wort');
      expect(response.text).not.toContain('Seitenueberschrift-hinter-dem-Wort');
      expect(response.text).not.toContain('definition');
      // …and no start token either: the attempt has not begun.
      expect(response.text).not.toContain('startToken');
    });

    it('answers the same form with the questions once the word was given', async () => {
      const response = await read(guarded.slug, await unlock(guarded.slug));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ locked: false });
      expect(response.text).toContain(NAME);
      expect(
        (response.body as { definition: { pages: unknown[] } }).definition
          .pages,
      ).toHaveLength(1);
    });

    /**
     * The other half of bullet 1, and the half a client cannot be trusted with:
     * **a submission without a proof is refused**, with no row written.
     *
     * Counted before and after rather than looked at, as the whole of this
     * suite is.
     */
    it('refuses a submission that carries no proof, and writes nothing', async () => {
      const before = await rowsOf(guarded.id);
      const response = await submit(guarded.slug);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        reason: 'password_required',
        message: SUBMISSION_REFUSAL_MESSAGES.password_required,
      });
      expect(await rowsOf(guarded.id)).toBe(before);
    });

    it('accepts the submission that carries a valid proof', async () => {
      const before = await rowsOf(guarded.id);
      const response = await submit(guarded.slug, await unlock(guarded.slug));

      expect(response.status).toBe(200);
      expect(await rowsOf(guarded.id)).toBe(before + 1);
    });

    /**
     * The control that keeps every test above from being satisfied by a server
     * that simply refuses everything: a form **without** a password is neither
     * locked nor gated.
     */
    it('leaves a form without an access word alone', async () => {
      const shown = await read(open.slug);
      expect(shown.status).toBe(200);
      expect(shown.body).toMatchObject({ locked: false });

      const before = await rowsOf(open.id);
      expect((await submit(open.slug)).status).toBe(200);
      expect(await rowsOf(open.id)).toBe(before + 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2 — no oracle in the error message
  // ═══════════════════════════════════════════════════════════════════════

  describe('2 — no oracle in the answer', () => {
    /** A form that was never published, and one in the trash. */
    let draftSlug = '';
    let deletedSlug = '';

    beforeAll(async () => {
      const draft = await request(app().server)
        .post(apiPath('/forms'))
        .set(authedMutation(editor))
        .send({ title: 'Nie veröffentlicht' });
      draftSlug = (draft.body as { publicSlug: string }).publicSlug;

      const deleted = await publishedForm('Wird gelöscht');
      await configure(
        deleted.id,
        { access: true },
        { passwordEnabled: true, password: WORD },
      );
      await app().prisma.form.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });
      deletedSlug = (
        await app().prisma.form.findUniqueOrThrow({
          where: { id: deleted.id },
          select: { publicSlug: true },
        })
      ).publicSlug;
    }, 60_000);

    /**
     * **Byte-identical, not „both are 404".**
     *
     * Status, body *and* the stable headers — `content-length` and `etag`
     * included. A test that compared only the status would pass a server that
     * answered „Passwort falsch" in one case and „Formular unbekannt" in the
     * other, which is exactly the oracle this bullet closes: it would turn the
     * gate into a way of asking whether an address is real.
     */
    it('answers a wrong word byte-identically to an unknown address', async () => {
      const wrongWord = await attempt(guarded.slug, { password: 'falsch' });
      const unknown = await attempt('gibtesnichtgibtesnicht', {
        password: 'falsch',
      });

      expect(wrongWord.status).toBe(404);
      expect(unknown.status).toBe(wrongWord.status);
      expect(wrongWord.text).toBe(unknown.text);
      expect(wrongWord.text).toContain(PUBLIC_FORM_NOT_FOUND_MESSAGE);
      expect(stableHeaders(wrongWord)).toStrictEqual(stableHeaders(unknown));
      // Spelled out as well, because it is the pair a body comparison alone
      // would not catch if the bodies were built differently but printed alike.
      expect(wrongWord.headers['content-length']).toBe(
        unknown.headers['content-length'],
      );
      expect(wrongWord.headers.etag).toBe(unknown.headers.etag);
    });

    /**
     * The three further shapes of „nothing to unlock", each compared against the
     * unknown address. They take different branches in the service, which is
     * precisely why they are listed: a branch that answered differently would be
     * a way of learning that an address exists.
     */
    it.each([
      ['a form that has no access word', () => open.slug],
      ['a form that was never published', () => draftSlug],
      ['a form in the Papierkorb', () => deletedSlug],
    ])('answers %s byte-identically too', async (_name, slugOf) => {
      const unknown = await attempt('gibtesnichtgibtesnicht', {
        password: WORD,
      });
      const probe = await attempt(slugOf(), { password: WORD });

      expect(probe.status).toBe(404);
      expect(probe.status).toBe(unknown.status);
      expect(probe.text).toBe(unknown.text);
      expect(stableHeaders(probe)).toStrictEqual(stableHeaders(unknown));
    });

    /**
     * A slug nobody could type answers the same way as well — the `%00` probe
     * that used to be a 500 on the read route. Carried over to the gate because
     * this route now takes the same parameter, and a 500 here would be the same
     * oracle in a new place.
     */
    it.each([
      ['a NUL byte', '%00'],
      ['a NUL byte inside a plausible address', 'AbCd%00Ef123456'],
      ['a character outside the base64url alphabet', 'AbCd.Ef'],
    ])('answers %s like an unknown address', async (_name, encoded) => {
      const unknown = await attempt('gibtesnichtgibtesnicht', {
        password: WORD,
      });
      const probe = await attempt(encoded, { password: WORD });

      expect(probe.status).toBe(404);
      expect(probe.status).toBe(unknown.status);
      expect(probe.text).toBe(unknown.text);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3 — no oracle about the clock
  // ═══════════════════════════════════════════════════════════════════════

  describe('3 — no oracle on the clock', () => {
    /**
     * **The route, not the service** — and that is the whole job of this test.
     *
     * The invariant itself („jede Quelle kostet eine AES-GCM-Entschlüsselung und
     * zwei MACs") is pinned down without a database in
     * `src/settings/access-word.service.spec.ts`, the way the login pins its own
     * down in `auth.service.spec.ts`. What a unit test over `matches()` cannot
     * see is the one branch that lives **outside** it: `PublicFormsService.unlock`
     * answers an unknown slug by calling `matches(ABSENT_FORM, offered)` before
     * it throws, and deleting that call leaves every unit assertion green while
     * an unknown address becomes measurably cheaper than a real one — a way of
     * asking whether a slug exists, which is exactly what bullet 2 closes.
     *
     * So this measures the two requests against each other in **operations**,
     * through the real HTTP stack: a wrong word on a real protected form, and
     * the same word at an address that leads nowhere. Equal counts, not „both do
     * something".
     */
    it('spends the same operations on an unknown address as on a wrong word', async () => {
      const box = app().app.get(SecretBoxService);
      const signing = app().app.get(SigningService);
      const opens = vi.spyOn(box, 'open');
      const signs = vi.spyOn(signing, 'sign');

      const count = async (slug: string): Promise<[number, number]> => {
        opens.mockClear();
        signs.mockClear();
        await attempt(slug, { password: 'Jahrestagung2027' });
        return [
          opens.mock.calls.length,
          signs.mock.calls.filter(
            ([purpose]) => purpose === 'public.access-word',
          ).length,
        ];
      };

      try {
        const real = await count(guarded.slug);
        const nowhere = await count('gibtesnichtgibtesnicht');

        expect(nowhere).toStrictEqual(real);
        // …and it is not „both did nothing": the decryption and both MACs ran.
        expect(real).toStrictEqual([1, 2]);
      } finally {
        opens.mockRestore();
        signs.mockRestore();
      }
    });

    /**
     * The wall clock, kept because the requirement names it — and **its reach is
     * stated rather than implied**.
     *
     * The measurement itself, the number of pairs and the factor live in
     * `test/support/timing-comparison.ts`, shared with the login's timing proof
     * in `auth.spec.ts`: the two are the same argument about two code paths,
     * and as two hand-written copies they had already started to drift.
     *
     * **What it catches:** a path that does categorically different work — an
     * early return that skips the decryption for one class of input, a whole
     * extra round trip.
     * **What it does not catch:** the byte-by-byte comparison itself. Replacing
     * `timingSafeEqual` with `===` leaves this green, and the test above is what
     * covers that. Nor anything small: a request here costs ≈5 ms, of which the
     * compared work is microseconds, and two medians measured under CI load
     * drift by up to 3.6 ms on their own. Saying so is the point: a green
     * wall-clock test is not evidence of constant time. At a factor of three it
     * is evidence that the two paths do not differ by a whole request's worth
     * of work — no more than that.
     */
    it('spends the same order of time on a near miss as on a wild guess', async () => {
      const measure = async (word: string): Promise<number> => {
        const started = performance.now();
        // Each attempt from an address of its own, or the ten-a-minute limit
        // would be what this measures.
        await attempt(guarded.slug, { password: word });
        return performance.now() - started;
      };

      expectSameOrderOfTime(
        await compareInterleaved(
          () => measure('Jahrestagung2027'),
          () => measure('zzzzzzzzzzzzzzz'),
        ),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4 and 5 — throttled, but not a weapon
  // ═══════════════════════════════════════════════════════════════════════

  describe('4 and 5 — throttled per address and form, never form-wide', () => {
    /**
     * The limit exists and is the route's own, not the inherited default.
     *
     * Spent from **one** address on **one** form, which is the bucket
     * `accessAttemptTracker` builds.
     */
    it('refuses further attempts from the same address on the same form', async () => {
      const form = await publishedForm('Gedrosselt');
      await configure(
        form.id,
        { access: true },
        { passwordEnabled: true, password: WORD },
      );
      const address = ownAddress();

      for (
        let attemptNo = 0;
        attemptNo < PUBLIC_ACCESS_RATE_LIMIT.limit;
        attemptNo += 1
      ) {
        expect(
          (await attempt(form.slug, { password: 'falsch' }, address)).status,
        ).toBe(404);
      }

      const throttled = await attempt(
        form.slug,
        { password: 'falsch' },
        address,
      );
      expect(throttled.status).toBe(429);

      /*
       * …and the **right word from the same address is throttled too**, which
       * is what makes this a rate limit rather than a wrong-answer counter.
       * Without this line the test would pass on an implementation that only
       * counted failures — and that implementation would let an attacker probe
       * for free by alternating.
       */
      expect(
        (await attempt(form.slug, { password: WORD }, address)).status,
      ).toBe(429);
    });

    /**
     * **Bullet 5, and the reason this file exists in the shape it does.**
     *
     * A test that used one address could say nothing about a form-wide lock: it
     * would look identical whether the counter is keyed by address or by form.
     * So the attempts are spent from address A until it is refused, and then B
     * walks up to the gate and gets in with the right word.
     *
     * What it forbids is concrete: „ein Hebel, mit dem ein Dritter die
     * Jahrestagung-Anmeldung einer ganzen Organisation abschalten kann."
     */
    it('lets another address in while the first one is locked out', async () => {
      const form = await publishedForm('Nicht abschaltbar');
      await configure(
        form.id,
        { access: true },
        { passwordEnabled: true, password: WORD },
      );
      const attacker = ownAddress();
      const mitglied = ownAddress();

      for (
        let attemptNo = 0;
        attemptNo < PUBLIC_ACCESS_RATE_LIMIT.limit;
        attemptNo += 1
      ) {
        await attempt(form.slug, { password: 'falsch' }, attacker);
      }
      expect(
        (await attempt(form.slug, { password: 'falsch' }, attacker)).status,
      ).toBe(429);

      const granted = await attempt(form.slug, { password: WORD }, mitglied);
      expect(granted.status).toBe(200);
      // …and the questions arrive for them.
      const shown = await read(
        form.slug,
        (granted.body as { accessToken: string }).accessToken,
        mitglied,
      );
      expect(shown.body).toMatchObject({ locked: false });
    });

    /**
     * The second dimension of bullet 4, in the other direction: an address that
     * used up its attempts on **one** form still reaches the gate of another.
     *
     * Without it, „je Adresse und je Formular" would be satisfied by a
     * per-address counter — and a participant who fumbled the word of the
     * Bestandsmeldung would arrive at the Jahrestagung registration already
     * spent.
     */
    it('keeps the buckets of two forms apart for the same address', async () => {
      const first = await publishedForm('Erstes Formular');
      const second = await publishedForm('Zweites Formular');
      for (const form of [first, second]) {
        await configure(
          form.id,
          { access: true },
          { passwordEnabled: true, password: WORD },
        );
      }
      const address = ownAddress();

      for (
        let attemptNo = 0;
        attemptNo < PUBLIC_ACCESS_RATE_LIMIT.limit;
        attemptNo += 1
      ) {
        await attempt(first.slug, { password: 'falsch' }, address);
      }
      expect(
        (await attempt(first.slug, { password: 'falsch' }, address)).status,
      ).toBe(429);

      expect(
        (await attempt(second.slug, { password: WORD }, address)).status,
      ).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6 — the word never stands in a URL
  // ═══════════════════════════════════════════════════════════════════════

  describe('6 — the word is never in a URL', () => {
    /**
     * There is no route that takes the word anywhere but in a body — asserted
     * by trying the two shapes somebody would reach for, rather than by reading
     * the controller.
     */
    it('does not accept the word as a query parameter', async () => {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${guarded.slug}/access?password=${WORD}`))
        .set('X-Forwarded-For', ownAddress())
        .send({});

      // 400: the body is what is parsed, and it carried nothing.
      expect(response.status).toBe(400);
      // And nothing was unlocked by it.
      expect((await read(guarded.slug)).body).toMatchObject({ locked: true });
    });

    it('does not accept the word as a path segment', async () => {
      const response = await request(app().server)
        .post(apiPath(`/public/forms/${guarded.slug}/access/${WORD}`))
        .set('X-Forwarded-For', ownAddress())
        .send({});

      expect(response.status).toBe(404);
    });

    /**
     * The route table itself, read from the application: no public route
     * declares a parameter that could carry the word.
     *
     * This is the guard against the *next* change rather than against this one —
     * a `GET /:slug/access/:password` added later would fail here even if
     * somebody remembered to delete the two tests above.
     */
    it('declares no route parameter beyond the slug', () => {
      expect(publicRoutePaths().sort()).toStrictEqual(
        [
          'GET public/forms/:slug',
          'POST public/forms/:slug/access',
          'POST public/forms/:slug/responses',
          // The requirement — *Zwischenspeichern*. It declares `:slug` and
          // nothing else: the answers travel in the body, and the address it
          // hands back is a **new** capability rather than anything the caller
          // put into the URL.
          'POST public/forms/:slug/drafts',
        ].sort(),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The proof: signed, form-bound, short-lived
  // ═══════════════════════════════════════════════════════════════════════

  describe('the proof is signed, form-bound and short-lived', () => {
    /**
     * **Not transferable to another form** — the sentence the requirement ends
     * on, and the one an unsigned or unbound token would fail.
     *
     * Two forms, both protected, both with the *same* word: so the test cannot
     * pass by accident on „the words differ". The proof of the first opens the
     * first and not the second.
     */
    it('does not open a second form, not even one with the same word', async () => {
      const other = await publishedForm('Andere Organisation, gleiches Wort');
      await configure(
        other.id,
        { access: true },
        { passwordEnabled: true, password: WORD },
      );

      const proof = await unlock(guarded.slug);

      expect((await read(guarded.slug, proof)).body).toMatchObject({
        locked: false,
      });
      expect((await read(other.slug, proof)).body).toMatchObject({
        locked: true,
      });

      const before = await rowsOf(other.id);
      const refused = await submit(other.slug, proof);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'password_required' });
      expect(await rowsOf(other.id)).toBe(before);
    });

    /**
     * **The signature is checked, the content is not believed.** A self-made
     * proof, a proof whose instant was rewritten and a random string all fail —
     * and they fail *identically*, so the refusal is no oracle on the MAC.
     */
    it.each([
      ['a self-made proof', 'p1.abcdefgh.selbstgebaut'],
      ['a proof with no signature at all', 'p1.abcdefgh.'],
      ['an unknown format version', 'p9.abcdefgh.irgendwas'],
      ['a random string', 'völliger-unsinn'],
    ])('refuses %s', async (_name, forged) => {
      const shown = await read(guarded.slug, forged);
      expect(shown.body).toMatchObject({ locked: true });

      const before = await rowsOf(guarded.id);
      const refused = await submit(guarded.slug, forged);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'password_required' });
      expect(await rowsOf(guarded.id)).toBe(before);
    });

    /**
     * A **genuine** proof whose instant was edited afterwards. It differs from
     * the forgeries above in that everything about it is ours except the one
     * number somebody wanted to change — which is exactly the attack a signature
     * over the body exists to stop.
     */
    it('refuses a genuine proof whose instant was rewritten', async () => {
      const genuine = await unlock(guarded.slug);
      const parts = genuine.split('.');
      // A minute later than it says — enough to matter, small enough that a
      // sloppy check might wave it through.
      const rewritten = [
        parts[0],
        (Number.parseInt(parts[1] ?? '0', 36) + 60_000).toString(36),
        parts[2],
      ].join('.');

      expect((await read(guarded.slug, rewritten)).body).toMatchObject({
        locked: true,
      });
    });

    /**
     * **Short-lived.** The proof is minted through the application's own signer
     * with an instant of our choosing, so „older than an hour" is testable
     * without waiting an hour — the same trick `submission-gate.spec.ts` uses
     * for the start token.
     */
    it('stops opening the form after an hour', async () => {
      const fresh = proofs.issue(
        guarded.slug,
        new Date(Date.now() - 59 * 60_000),
      );
      const stale = proofs.issue(
        guarded.slug,
        new Date(Date.now() - 61 * 60_000),
      );

      expect((await read(guarded.slug, fresh)).body).toMatchObject({
        locked: false,
      });
      expect((await read(guarded.slug, stale)).body).toMatchObject({
        locked: true,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The framing: a hurdle, not an authorisation
  // ═══════════════════════════════════════════════════════════════════════

  describe('the word is a hurdle, never an authorisation', () => {
    /**
     * **The heart of the framing.** „Frist, Antwortlimit und Zeitlimit dürfen
     * nie durch das Wort ersetzt werden" — so a participant holding a perfectly
     * valid proof still meets a closed form.
     *
     * Without this test the whole requirement could be satisfied by an
     * implementation that treats the proof as a pass, and the failure would only
     * show up when an organisation found registrations arriving after the deadline.
     */
    it('refuses a submission to a closed form even with a valid proof', async () => {
      const form = await publishedForm('Geschlossen und geschützt');
      await configure(
        form.id,
        { access: true },
        {
          openEnabled: true,
          closeAt: '2020-01-01T00:00:00.000Z',
          passwordEnabled: true,
          password: WORD,
        },
      );

      const proof = await unlock(form.slug);
      // The gate opened — the questions are delivered…
      expect((await read(form.slug, proof)).body).toMatchObject({
        locked: false,
        availability: { state: 'closed' },
      });

      // …and the submission is refused anyway.
      const before = await rowsOf(form.id);
      const refused = await submit(form.slug, proof);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'closed' });
      expect(await rowsOf(form.id)).toBe(before);
    });

    /**
     * **The order of the chain, and the direction the two tests around it left
     * open.**
     *
     * The pair above and below shows that a *valid* proof does not buy past the
     * deadline or the limit. This shows the other direction: the gate is checked
     * **before** them, so somebody without the word learns only that there is a
     * gate — never „geschlossen", „noch nicht geöffnet" or „voll", which is the
     * state of an organisation's registration and is exactly what the read path withholds
     * from a caller who has not passed.
     *
     * It is the test the suite was missing. Moving the password-gate block behind the
     * `state !== 'open'` check made a protected *and* closed form answer `closed`
     * to a stranger — and nothing went red, because all four
     * `password_required` assertions ran against forms that happened to be open.
     */
    it('answers a stranger at a closed protected form with password_required, not closed', async () => {
      const form = await publishedForm('Geschlossen, und das geht keinen an');
      await configure(
        form.id,
        { access: true },
        {
          openEnabled: true,
          closeAt: '2020-01-01T00:00:00.000Z',
          passwordEnabled: true,
          password: WORD,
        },
      );

      const before = await rowsOf(form.id);
      const refused = await submit(form.slug);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        reason: 'password_required',
        message: SUBMISSION_REFUSAL_MESSAGES.password_required,
      });
      expect(await rowsOf(form.id)).toBe(before);
    });

    /**
     * **The third of the three the framing names, and the one that had no test
     * at all.** „Frist, Antwortlimit und **Zeitlimit** dürfen nie durch das Wort
     * ersetzt werden" — `grep -n timeLimit` over this file came back empty.
     *
     * The start token is minted through the application's own signer with an
     * instant of our choosing, the same trick `submission-gate.spec.ts` uses:
     * „older than the limit" is then testable without waiting out the limit.
     */
    it('refuses a submission whose attempt ran out of time, proof or no proof', async () => {
      const form = await publishedForm('Zeitlimit und Zugangswort');
      await configure(
        form.id,
        { access: true },
        {
          timeLimitEnabled: true,
          timeLimitMin: 10,
          passwordEnabled: true,
          password: WORD,
        },
      );

      const proof = await unlock(form.slug);
      const before = await rowsOf(form.id);

      // Eleven minutes ago — one past a limit of ten.
      const stale = startTokens.issue(
        form.slug,
        new Date(Date.now() - 11 * 60_000),
      );
      const refused = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set(ACCESS_PROOF_HEADER, proof)
        .send({ answers: { [NAME]: 'Anton' }, startToken: stale });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        reason: 'time_limit',
        message: SUBMISSION_REFUSAL_MESSAGES.time_limit,
      });
      expect(await rowsOf(form.id)).toBe(before);

      // The control that keeps this from being satisfied by a server which
      // refuses every submission to this form: a fresh token goes through.
      const accepted = await request(app().server)
        .post(apiPath(`/public/forms/${form.slug}/responses`))
        .set('X-Forwarded-For', ownAddress())
        .set(ACCESS_PROOF_HEADER, proof)
        .send({
          answers: { [NAME]: 'Anton' },
          startToken: startTokens.issue(form.slug),
        });
      expect(accepted.status).toBe(200);
      expect(await rowsOf(form.id)).toBe(before + 1);
    });

    /**
     * The response limit, likewise. One place, taken by an answer that went
     * through the gate — the next holder of a valid proof is refused.
     */
    it('refuses a submission to a full form even with a valid proof', async () => {
      const form = await publishedForm('Voll und geschützt');
      await configure(
        form.id,
        { access: true },
        {
          maxResponsesEnabled: true,
          maxResponses: 1,
          passwordEnabled: true,
          password: WORD,
        },
      );

      expect((await submit(form.slug, await unlock(form.slug))).status).toBe(
        200,
      );

      const before = await rowsOf(form.id);
      const refused = await submit(form.slug, await unlock(form.slug));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'limit_reached' });
      expect(await rowsOf(form.id)).toBe(before);
    });
  });
});

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

function metadataPath(target: object): string {
  const value: unknown = Reflect.getMetadata(PATH_METADATA, target);
  return typeof value === 'string' ? value : '';
}

/**
 * Every route the public controller declares, as „METHOD path" — read out of
 * Nest's own decorator metadata, the same way `test/auth/csrf.spec.ts` reads
 * the exemption list.
 *
 * Off the metadata rather than out of the source, because the assertion is
 * about what the application *registers*: a `@Get(':slug/access/:password')`
 * added later shows up here whether or not anybody remembers this file.
 */
function publicRoutePaths(): string[] {
  const scanner = new MetadataScanner();
  const prototype = PublicFormsController.prototype as object;
  const base = metadataPath(PublicFormsController);
  const found: string[] = [];

  for (const name of scanner.getAllMethodNames(prototype)) {
    const handler = (prototype as Record<string, unknown>)[name];
    if (typeof handler !== 'function') {
      continue;
    }
    const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof method !== 'number') {
      continue;
    }
    const own = metadataPath(handler);
    const path = own === '' ? base : `${base}/${own}`;
    found.push(`${METHOD_NAMES[method] ?? String(method)} ${path}`);
  }
  return found;
}
