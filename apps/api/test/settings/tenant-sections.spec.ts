import {
  SYSTEM_FORM_SETTINGS,
  TENANT_SETTINGS_FLOOR,
  type TenantFormSettings,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * **The form standards of an organisation** — the proofs a *running* system
 * needs, against real PostgreSQL.
 *
 * The unit half is `packages/shared/src/form-settings.test.ts`; here stands
 * what an installation does — on the public filling path and in the stored
 * row.
 *
 * ## Why proof 1 is measured on the public payload
 *
 * The standards of an organisation reach a filling person through
 * `GET /api/public/forms/:slug`, and this path carries no session and no
 * context of its own — an earlier review named it as the one that gets
 * forgotten. A test on the settings page alone would be green for an
 * implementation in which the editor sees other values than the filling
 * person.
 *
 * ## Negative samples, measured on writing
 *
 * | rule removed | red |
 * |---|---|
 * | the patch overwrites the whole document instead of continuing it | "a second write leaves standing what it does not name" |
 * | `overridden` allowed again in the write schema | "refuses a request with switches" |
 * | *Verfügbarkeit* back at the organisation | "an organisation has no deadline" |
 */

const PASSWORD = 'test-password-b10';
const PAGE = '019ffa00-0000-7000-8000-0000000000a0';
const NAME = '019ffa00-0000-7000-8000-000000000001';
/**
 * A deadline in the past — the one *Verfügbarkeit* value a participant can
 * observe, because the requirement lets a verdict travel and never the configuration.
 */
const CLOSED_LONG_AGO = '2020-01-01T00:00:00.000Z';

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

/**
 * What the public payload carries of the settings that matter here.
 *
 * The two sections a participant can actually observe:
 * *Darstellung* as three flags, and *Verfügbarkeit* as a **verdict** — never as
 * the configuration behind it. That is why the proofs below use `closesAt` and
 * `state` rather than a stored deadline: the wire deliberately does not carry
 * one, and a test that wanted it would be asking for the thing the requirement removed.
 */
interface PublicPayload {
  readonly display: {
    readonly showProgress: boolean;
    readonly showPageNumbers: boolean;
    readonly showRequiredHint: boolean;
  };
  readonly availability: {
    readonly state: string;
    readonly closesAt: string | null;
  };
}

interface TenantDefaultsBody {
  /** Complete, always — one document, not a pair of switches. */
  readonly values: TenantFormSettings;
  readonly revision: number;
}

describe('die Formular-Standards einer Organisation', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  let Organisation: TenantFixture;
  let admin: string;
  /** A published form of `Organisation` that inherits everything from it. */
  let slug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    Organisation = await createTenant(testApp.prisma, 'SECA');
    const user = await createUser(testApp.prisma, {
      email: 'admin@sections.example',
      password: PASSWORD,
      tenants: [Organisation],
    });
    admin = await openSession(testApp, user.id, Organisation.id);

    slug = await publishedForm('Anmeldung Jahrestagung');
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** A published form of `Organisation`, through the real routes; returns its slug. */
  async function publishedForm(title: string): Promise<string> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(admin))
      .send({ title });
    const form = created.body as { id: string; revision: number };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(admin))
      .send({ title, definition: definition(), revision: form.revision });
    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(admin))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return (created.body as { publicSlug: string }).publicSlug;
  }

  /** What a participant sees — no session, no context. */
  async function publicPayload(): Promise<PublicPayload> {
    const response = await request(app().server).get(
      apiPath(`/public/forms/${slug}`),
    );
    expect(response.status).toBe(200);
    return response.body as PublicPayload;
  }

  async function readStandards(): Promise<TenantDefaultsBody> {
    const response = await request(app().server)
      .get(apiPath('/tenant/form-defaults'))
      .set('Cookie', cookieHeader(admin));
    expect(response.status).toBe(200);
    return response.body as TenantDefaultsBody;
  }

  /** A patch on the stored document — the route carries no more. */
  async function writeStandards(
    values: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const { revision } = await readStandards();
    return request(app().server)
      .put(apiPath('/tenant/form-defaults'))
      .set(authedMutation(admin))
      .send({ values, revision });
  }

  /** The stored column, untouched by any parser. */
  async function storedDefaults(): Promise<Prisma.JsonValue> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: Organisation.id },
      select: { formDefaults: true },
    });
    return row.formDefaults;
  }

  /**
   * Back to the shipped values.
   *
   * **Written, not deleted**: without switches there is no "nothing
   * decided" any more that could be restored — an organisation that has saved
   * once carries its set. What the cases afterwards have to find is
   * therefore the default values, explicitly written down.
   */
  async function resetStandards(): Promise<void> {
    const response = await writeStandards({ ...TENANT_SETTINGS_FLOOR });
    expect(response.status).toBe(200);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Proof 1 — the load-bearing one: one section set, three still inheriting,
  // measured on the payload a participant gets.
  // ═════════════════════════════════════════════════════════════════════════

  it('reaches a form that inherits — publicly', async () => {
    // The organisation decides two display flags.
    const taken = await writeStandards({
      showProgress: false,
      showPageNumbers: false,
    });
    expect(taken.status).toBe(200);

    try {
      const before = await publicPayload();
      // The form was never touched, so what it shows is the organisation's.
      expect(before.display.showProgress).toBe(false);
      expect(before.display.showPageNumbers).toBe(false);
      // …and a key the organisation never named is the shipped default.
      expect(before.display.showRequiredHint).toBe(
        SYSTEM_FORM_SETTINGS.showRequiredHint,
      );

      // **A second write leaves standing what it does not name.** That
      // is the patch promise of the route: a `PUT` that replaced the whole
      // document would turn every saving of one page into a reset of all the
      // fields that happened not to be on the screen.
      const moved = await writeStandards({ showRequiredHint: false });
      expect(moved.status).toBe(200);

      const after = await publicPayload();
      expect(after.display.showRequiredHint).toBe(false);
      expect(after.display.showProgress).toBe(false);
    } finally {
      await resetStandards();
    }
  });

  it('shows the editor exactly what the public payload shows', async () => {
    const taken = await writeStandards({ showProgress: false });
    expect(taken.status).toBe(200);

    try {
      const standards = await readStandards();
      const payload = await publicPayload();

      // What the organisation has decided …
      expect(standards.values.showProgress).toBe(false);
      expect(payload.display.showProgress).toBe(standards.values.showProgress);
      // … and what it has never touched: the shipped value, written out in
      // the document instead of as a gap that every user interface would have
      // to fill itself.
      expect(standards.values.confirmTitle).toBe(
        SYSTEM_FORM_SETTINGS.confirmTitle,
      );
      // Complete, not "as far as it was saved".
      expect(new Set(Object.keys(standards.values))).toStrictEqual(
        new Set(Object.keys(TENANT_SETTINGS_FLOOR)),
      );
    } finally {
      await resetStandards();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Proof 2 — „Verfügbarkeit" is not a matter of the organisation
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Review finding 10, measured at the route: the organisation cannot set a
   * deadline, and in such a way that it is noticed — 400 with the field name,
   * not a value that silently disappears.
   *
   * The counter-check stands next to it: **the form** sets the same deadline,
   * and it reaches the filling person.
   */
  it('refuses a deadline in the organisation’s standards and keeps it on the form', async () => {
    const { revision } = await readStandards();
    const refused = await request(app().server)
      .put(apiPath('/tenant/form-defaults'))
      .set(authedMutation(admin))
      .send({
        values: { openEnabled: true, closeAt: CLOSED_LONG_AGO },
        revision,
      });

    expect(refused.status).toBe(400);
    expect(refused.text).toContain('closeAt');
    // None of it has landed in the column — checked at the column, because
    // a refused write that wrote anyway would look the same from
    // outside.
    expect(JSON.stringify(await storedDefaults())).not.toContain('closeAt');

    // …and the same at the form: there it applies, without switches.
    const form = await app().prisma.form.findFirstOrThrow({
      where: { publicSlug: slug },
      select: { id: true, settingsRevision: true },
    });
    const organisation = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: Organisation.id },
      select: { formDefaultsRevision: true },
    });
    const written = await request(app().server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(admin))
      .send({
        // At the **form** the switches still exist — below them lies the
        // organisation, and the switch means it.
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { openEnabled: true, closeAt: CLOSED_LONG_AGO },
        revision: form.settingsRevision,
        tenantRevision: organisation.formDefaultsRevision,
      });
    expect(written.status).toBe(200);

    const payload = await publicPayload();
    expect(payload.availability.state).toBe('closed');
    expect(payload.availability.closesAt).toBe(CLOSED_LONG_AGO);

    // Taken back so that the cases afterwards find an open form.
    const reopened = await request(app().server)
      .put(apiPath(`/forms/${form.id}/settings`))
      .set(authedMutation(admin))
      .send({
        overridden: {
          access: false,
          confirm: false,
          display: false,
          budget: false,
        },
        values: { openEnabled: false, closeAt: null },
        revision: form.settingsRevision + 1,
        tenantRevision: organisation.formDefaultsRevision,
      });
    expect(reopened.status).toBe(200);
    expect((await publicPayload()).availability.state).toBe('open');
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Proof 3 — what is stored is a complete document
  // ═════════════════════════════════════════════════════════════════════════

  it('stores a complete document, and a later patch moves only what it names', async () => {
    const taken = await writeStandards({ mailBudgetLimit: 7 });
    expect(taken.status).toBe(200);

    // Complete in the column, without a wrapper: no `overridden`, no `values`
    // (review finding 10). The access to the row is the load-bearing half —
    // a response that looks complete says nothing about what is stored.
    const stored = await storedDefaults();
    expect(stored).not.toHaveProperty('overridden');
    expect(stored).not.toHaveProperty('values');
    expect(stored).toMatchObject({
      mailBudgetLimit: 7,
      confirmTitle: SYSTEM_FORM_SETTINGS.confirmTitle,
    });

    // And the second write leaves the 7 standing.
    const second = await writeStandards({ showProgress: false });
    expect(second.status).toBe(200);
    const body = second.body as TenantDefaultsBody;
    expect(body.values.mailBudgetLimit).toBe(7);
    expect(body.values.showProgress).toBe(false);

    await resetStandards();
  });

  /**
   * **The default of the application is reachable again** — by writing it down.
   *
   * Without switches "back to the default" is no longer a state of its own but
   * the same value once more. What must not happen in the process: that a
   * value which happens to be the shipped one is treated differently from any
   * other.
   */
  it('takes the shipped value back as an ordinary write', async () => {
    expect((await writeStandards({ mailBudgetLimit: 7 })).status).toBe(200);

    const back = await writeStandards({
      mailBudgetLimit: SYSTEM_FORM_SETTINGS.mailBudgetLimit,
    });
    expect(back.status).toBe(200);
    expect((back.body as TenantDefaultsBody).values.mailBudgetLimit).toBe(
      SYSTEM_FORM_SETTINGS.mailBudgetLimit,
    );

    await resetStandards();
  });

  /**
   * The access word is **sealed** and bound to its place
   * (`tenantDefaultsContext`), so „abgeschaltet" has to mean the ciphertext is
   * gone from the row — not merely that a switch says it does not count. A
   * leftover blob is a secret nobody can open and nobody can find.
   */
  it('leaves no ciphertext behind when the access word is cleared', async () => {
    const word = 'organisationsweites-zugangswort';
    const guarded = await writeStandards({
      passwordEnabled: true,
      password: word,
    });
    expect(guarded.status).toBe(200);

    const sealed = JSON.stringify(await storedDefaults());
    // Sealed, not stored in clear  …
    expect(sealed).not.toContain(word);
    // … and there *is* something sealed, so the assertion after the clearing
    // is about a value that existed.
    expect(sealed).toContain('passwordEnabled');

    const cleared = await writeStandards({
      passwordEnabled: false,
      password: '',
    });
    expect(cleared.status).toBe(200);

    const after = await storedDefaults();
    // The key is still there — the document is complete —, but it carries
    // nothing any more: no ciphertext that nobody can open any more.
    expect(after).toMatchObject({ passwordEnabled: false, password: '' });
    expect(JSON.stringify(after)).not.toContain('sealed');

    const read = await readStandards();
    expect(read.values.passwordEnabled).toBe(false);
    expect(read.values.password).toBe('');

    await resetStandards();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // The wire
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * **A request with switches is refused** (review finding 10).
   *
   * `overridden` existed until 2026-08-17, and a client that still sends it
   * believes in a layer this application no longer has. That belongs said —
   * 400 with the field name — and not silently thrown away: otherwise this
   * client would save values for years in the belief that it thereby decides
   * which sections apply.
   */
  it('refuses a write that still names the section switches', async () => {
    const taken = await writeStandards({
      passwordEnabled: true,
      password: 'noch-ein-zugangswort',
      mailBudgetLimit: 12,
    });
    expect(taken.status).toBe(200);
    const before = await storedDefaults();

    const { revision } = await readStandards();
    const legacy = await request(app().server)
      .put(apiPath('/tenant/form-defaults'))
      .set(authedMutation(admin))
      .send({
        overridden: {
          access: true,
          confirm: true,
          display: true,
          budget: true,
        },
        values: { mailBudgetLimit: 13 },
        revision,
      });

    expect(legacy.status).toBe(400);
    // And the row is untouched — a refused write that wrote anyway would
    // look the same from outside.
    expect(await storedDefaults()).toStrictEqual(before);

    await resetStandards();
  });

  /**
   * A tenant standard is not a document a stranger may read, and this change
   * where the word sits inside it. The redaction has to have moved with it.
   */
  it('never lets the organisation’s access word reach the public payload', async () => {
    const word = 'oeffentlich-verbotenes-wort';
    const guarded = await writeStandards({
      passwordEnabled: true,
      password: word,
    });
    expect(guarded.status).toBe(200);

    try {
      const response = await request(app().server).get(
        apiPath(`/public/forms/${slug}`),
      );
      // The form is behind the gate now, so the answer is the password prompt
      // rather than the definition — and either way the word
      // is not in it.
      expect(response.text).not.toContain(word);
    } finally {
      await resetStandards();
    }
  });

  it('keeps an organisation that never saved on the shipped defaults', async () => {
    // The absence *is* the meaning, and it survives a read: `{}` in the
    // column must not become a saved set just because somebody has opened the
    // page (no backfill).
    const fresh = await createTenant(app().prisma, 'SECC');
    const user = await createUser(app().prisma, {
      email: 'admin@fresh-sections.example',
      password: PASSWORD,
      tenants: [fresh],
    });
    const session = await openSession(app(), user.id, fresh.id);

    const read = await request(app().server)
      .get(apiPath('/tenant/form-defaults'))
      .set('Cookie', cookieHeader(session));
    expect(read.status).toBe(200);
    // Answered completely — from the shipped default, not from the
    // column.
    expect((read.body as TenantDefaultsBody).values).toStrictEqual(
      TENANT_SETTINGS_FLOOR,
    );

    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { formDefaults: true },
    });
    expect(row.formDefaults).toStrictEqual({});
  });
});
