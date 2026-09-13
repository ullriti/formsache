import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AI_REGION_DEFAULT, parseSessionUser } from '@formsache/shared';

import { AiSettingsService } from '../../src/system-settings/ai-settings.service';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  configureAi,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import { RECORDED_DRAFT } from './recorded-answers';

/**
 * **The move: the AI configuration lives in the row, not in the environment**
 * (ADR-0015 with the addendum from 2026-08-11).
 *
 * Four promises, and each has a reproduction that turns it red:
 *
 * | Promise | Broken by | What then turns red |
 * |---|---|---|
 * | The key lies **sealed** in the column | writing it in plaintext | „findet den Schlüssel nicht im Klartext" |
 * | The three layers are **monotone** | turning the conjunction into an or | „System aus, Organisation an → 404" |
 * | The quota belongs to the superadmin | opening the route for organisation admins | „hebt sein eigenes Kontingent an → 403" |
 * | The region is an **enum** with default `eu` | turning it into `z.string().url()` | „lehnt eine fremde Region ab" |
 *
 * ⚠️ **Why the promises are measured at the route and not at the service.**
 * UI states are convenience; enforcement happens server-side. Earlier
 * this exact shape was once real: **204 instead of 403, and the column was
 * written.** A test that only checks the rendering would not have seen that.
 */

const SETUP_TIMEOUT_MS = 120_000;
const KEY = 'ZZKANARIE-SETTINGS-KEY';

describe('die KI-Konfiguration in den Systemeinstellungen', () => {
  let database: TestDatabase;
  let app: TestApp;
  let tenant: TenantFixture;
  let superadminSession: string;
  let tenantAdminSession: string;
  let builderSession: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    // ⚠️ **The double is not a convenience here but a duty.** Without
    // it `AiFormGeneratorFactory` binds the real adapter, and `generateStatus`
    // **really** calls `api.anthropic.com` for the configured cases —
    // measured in a review, two outgoing requests per run, with the
    // canary key in the header. The case stayed green nevertheless, because
    // `not.toBe(404)` is satisfied by any network egress: it measured the
    // network stack, not the guard.
    app = await createTestApp({
      databaseUrl: database.url,
      aiGenerator: new RecordedFormGenerator({
        ok: true,
        draft: RECORDED_DRAFT,
        usage: null,
      }),
    });

    const prisma = app.prisma;
    tenant = await createTenant(prisma, 'KIUMZUG');

    const superadmin = await createUser(prisma, {
      email: 'super@kiumzug.example.org',
      password: 'passwort-fuer-den-test',
      isSuperadmin: true,
      tenants: [tenant],
    });
    superadminSession = await openSession(app, superadmin.id, tenant.id);

    const admin = await createUser(prisma, {
      email: 'admin@kiumzug.example.org',
      password: 'passwort-fuer-den-test',
      tenants: [tenant],
    });
    tenantAdminSession = await openSession(app, admin.id, tenant.id);
    builderSession = tenantAdminSession;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await (app as TestApp | undefined)?.close();
    await (database as TestDatabase | undefined)?.release();
  });

  const settingsPath = apiPath('/admin/system-settings/ai');
  const readSettings = () =>
    request(app.server)
      .get(settingsPath)
      .set({ Cookie: cookieHeader(superadminSession) });
  const writeSettings = (body: unknown) =>
    request(app.server)
      .put(settingsPath)
      .set(authedMutation(superadminSession))
      .send(body as object);

  // -------------------------------------------------------------------------
  // The row, the sealed key, and no second source.
  // -------------------------------------------------------------------------

  /**
   * **The key does not stand in plaintext in the column.**
   *
   * Read raw, not through Prisma types: what counts is what lies on the disk
   * — and thus also what ends up in a backup.
   *
   * *Reproduction:* omit the `seal()` in `AiSettingsService.nextKey` →
   * this case turns red, and a provider key would lie in every `pg_dump`.
   */
  it('legt den Schlüssel versiegelt ab — roh gelesen steht er nicht da', async () => {
    await writeSettings({
      enabled: true,
      provider: 'anthropic',
      model: null,
      region: 'eu',
      apiKey: KEY,
      lock: 1,
    }).expect(200);

    const rows = await app.prisma.$queryRaw<
      { ai_api_key: string | null }[]
    >`SELECT "ai_api_key" FROM "system_setting" WHERE "id" = 'x'`;
    const stored = rows[0]?.ai_api_key ?? '';
    expect(stored).not.toBe('');
    expect(stored).not.toContain(KEY);
    // And the display does not carry it either — it only says *that* there is one.
    const shown = await readSettings().expect(200);
    expect(JSON.stringify(shown.body)).not.toContain(KEY);
    expect(shown.body).toMatchObject({ values: { apiKeySet: true } });
  });

  /**
   * **The feature comes and goes without a restart** — that is the gain of the
   * move, and without this case it would be unproven.
   *
   * Earlier, "switching the AI on" was a deployment. Here it is a `PUT`, and
   * the session payload of the same running application changes along with it.
   */
  it('schaltet die Funktion im laufenden Betrieb ein und wieder aus', async () => {
    await configureAi(app, {});
    expect(await availabilityOf(builderSession)).toBe(false);

    await configureAi(app, { provider: 'anthropic', apiKey: KEY });
    expect(await availabilityOf(builderSession)).toBe(true);

    await configureAi(app, {
      provider: 'anthropic',
      apiKey: KEY,
      enabled: false,
    });
    expect(await availabilityOf(builderSession)).toBe(false);
  });

  /**
   * **The own counter, not `updatedAt`** . Two writes
   * starting from the same state: the second gets a **409**.
   *
   * *Reproduction:* take the lock out of the `where` of `writeAi` → this
   * case gets 200, and the second writer overwrites the first without
   * anyone learning of it.
   */
  it('antwortet 409, wenn zwei Schreibvorgänge vom selben Stand ausgehen', async () => {
    const before = await readSettings().expect(200);
    const lock = (before.body as { lock: number }).lock;
    const body = {
      enabled: true,
      provider: null,
      model: null,
      region: 'eu' as const,
      lock,
    };

    await writeSettings(body).expect(200);
    await writeSettings(body).expect(409);
  });

  /**
   * **The model of a *foreign* provider is rejected — by the server**
   * (review follow-up on the selection list, 2026-08-12).
   *
   * The selection list was at first pure surface: `AI_MODEL_CHOICES` had
   * not a single caller in `apps/api`. A `PUT` with
   * `{provider: 'mistral', model: 'claude-opus-5'}` went through with **200**,
   * `resolveAiConfig` handed the Anthropic identifier to the Mistral adapter,
   * and its answer landed in `aiFailureKindSchema`'s catch-all case
   * `unavailable` — indistinguishable from a bad afternoon of the
   * provider. CONTRIBUTING.md says about this: *the server always validates itself*.
   *
   * ⚠️ **The second case is the more important one.** It sees the *allowed* case
   * succeed, which a rule that is too strict would have struck down along with it: an
   * identifier that stands in **no** list — a legacy identifier from the free-text era
   * or a discontinued model — must still be storable, otherwise
   * the deprecation plan of a foreign service could invalidate a row
   * that has long been lying in the database.
   *
   * *Reproduction:* take the `superRefine` out of `updateSystemAiSettingsRequestSchema`
   * → the first case gets 200. Let it check against the *own* list
   * instead of against the foreign ones → the second gets 400.
   */
  it('lehnt eine Modellkennung des anderen Anbieters ab und lässt eine unbekannte durch', async () => {
    const attempt = async (model: string, status: number) => {
      const before = await readSettings().expect(200);
      await writeSettings({
        enabled: true,
        provider: 'mistral',
        model,
        region: 'eu' as const,
        apiKey: KEY,
        lock: (before.body as { lock: number }).lock,
      }).expect(status);
    };

    await attempt('claude-opus-5', 400);
    await attempt('mistral-large-latest', 200);
    // In neither the Mistral nor the Anthropic list: an identifier that the
    // provider discontinued as of 2026-08-31 (measured against `GET /v1/models`).
    // Exactly such a one stands in an installation from the free-text era — it
    // must go through, otherwise this rebuild would take its running model away.
    await attempt('mistral-medium-2508', 200);
  });

  // -------------------------------------------------------------------------
  // The region is a choice, never an address.
  // -------------------------------------------------------------------------

  /**
   * *Reproduction:* swap the enum for `z.string().url()` → this case
   * gets 200, and the data-protection promise from ADR-0015 no. 13 would be a
   * text field.
   */
  it.each(['https://api.example.org', 'EU', 'eu-central-1', ''])(
    'lehnt %p als Region ab',
    async (region) => {
      const before = await readSettings().expect(200);
      await writeSettings({
        enabled: true,
        provider: null,
        model: null,
        region,
        lock: (before.body as { lock: number }).lock,
      }).expect(400);
    },
  );

  /**
   * **If the row is missing, `eu` applies** — not "empty" and not
   * "the first region found".
   *
   * Measured against the **fresh** installation, that is, before anybody has
   * saved anything: for that the row is deleted here instead of newly written.
   */
  it('liest eine Installation ohne Zeile als eu', async () => {
    await app.prisma.systemSetting.deleteMany({});
    const response = await readSettings().expect(200);
    expect(response.body).toMatchObject({
      values: { region: AI_REGION_DEFAULT, provider: null, apiKeySet: false },
    });
    expect(AI_REGION_DEFAULT).toBe('eu');
  });

  // -------------------------------------------------------------------------
  // Three layers, and they can only take away.
  // -------------------------------------------------------------------------

  /**
   * **System on, organisation off → 404 for this organisation.**
   *
   * Measured at the route, not at the rendering.
   */
  it('lässt eine Organisation sich selbst abschalten', async () => {
    await configureAi(app, { provider: 'anthropic', apiKey: KEY });
    expect(await generateStatus(builderSession)).not.toBe(404);

    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: false })
      .expect(200);

    expect(await generateStatus(builderSession)).toBe(404);
    expect(await availabilityOf(builderSession)).toBe(false);

    // Back again, so that the own switch is not a one-way street — and because
    // exactly that would be the trap if this route stood behind `AiFeatureGuard`.
    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: null })
      .expect(200);
    expect(await generateStatus(builderSession)).not.toBe(404);
  });

  /**
   * **System off → no organisation can switch itself on.**
   *
   * *Reproduction:* turn `aiAvailableForTenant` into an or → this case
   * gets 200, and an organisation would give itself a feature the installation
   * does not have.
   */
  it('lässt eine Organisation sich nichts geben, was die Installation nicht hat', async () => {
    await configureAi(app, {});
    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: true })
      .expect(200);

    // The column is true — and the feature does not exist nevertheless.
    const row = await app.prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { aiEnabled: true },
    });
    expect(row?.aiEnabled).toBe(true);
    expect(await generateStatus(builderSession)).toBe(404);

    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: null })
      .expect(200);
  });

  /**
   * **The quota belongs to the superadmin** —
   * measured **again** here on the rebuilt seam: an assurance that
   * is not repeated after a rebuild is an assertion from the rebuild on.
   */
  it('lässt einen Organisationsadmin sein eigenes Kontingent nicht anheben', async () => {
    const response = await request(app.server)
      .put(apiPath(`/admin/tenants/${tenant.id}/ai-quota`))
      .set(authedMutation(tenantAdminSession))
      .send({ monthlyCallLimit: 5_000 });

    expect(response.status).toBe(403);
    const row = await app.prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { aiMonthlyCallLimit: true },
    });
    // Not only the answer — the column too. The shape that once was
    // real: 204 instead of 403, **and written**.
    expect(row?.aiMonthlyCallLimit).not.toBe(5_000);
  });

  /**
   * **`systemAvailable` answers the question that an organisation cannot answer
   * about itself** — the assistant of a newly created
   * organisation (ADR-0025).
   *
   * `aiFormsAvailable` of the session is already the **and** from both
   * layers: `false` there means either „die Installation hat keine KI"
   * or „diese Organisation hat sich abgeschaltet". The page on which one
   * switches oneself back on has to know the difference — otherwise it would offer
   * a choice that has no effect.
   *
   * *Reproduction:* in `AiTenantSettingsController.systemAvailable` pass
   * the own switch through (`available(row?.aiEnabled ?? null)`) → the
   * third case turns red, and a switched-off organisation would get „diese
   * Installation hat keine KI" to read, although the installation has one.
   */
  it('sagt der Organisation, ob die Installation überhaupt eine KI hat', async () => {
    const read = () =>
      request(app.server)
        .get(apiPath('/ai/tenant-settings'))
        .set({ Cookie: cookieHeader(tenantAdminSession) })
        .expect(200);

    await configureAi(app, {});
    expect((await read()).body).toMatchObject({ systemAvailable: false });

    await configureAi(app, { provider: 'anthropic', apiKey: KEY });
    expect((await read()).body).toMatchObject({ systemAvailable: true });

    // The organisation's own switch must not colour the information about the
    // installation — otherwise it would be tautological.
    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: false })
      .expect(200);
    expect((await read()).body).toEqual({
      enabled: false,
      systemAvailable: true,
    });

    await request(app.server)
      .put(apiPath('/ai/tenant-settings'))
      .set(authedMutation(tenantAdminSession))
      .send({ enabled: null })
      .expect(200);
  });

  /**
   * **And the information is not a second door to the superadmin page.**
   *
   * A `boolean` travels, no provider, no model, no region and no
   * `apiKeySet` — `tenantAiSwitchSchema` is a `strictObject`, but the
   * answer is compared **raw** here: a server that sends more along
   * would be noticed by a schema test in the browser and by this one as well.
   */
  it('trägt zur Verfügbarkeit nichts als ein Ja oder Nein', async () => {
    await configureAi(app, {
      provider: 'anthropic',
      apiKey: KEY,
      model: 'claude-opus-5',
      region: 'us',
    });

    const response = await request(app.server)
      .get(apiPath('/ai/tenant-settings'))
      .set({ Cookie: cookieHeader(tenantAdminSession) })
      .expect(200);

    expect(Object.keys(response.body as object).sort()).toEqual([
      'enabled',
      'systemAvailable',
    ]);
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });

  /** The traits of the session payload — the menu switch that the shell reads. */
  async function availabilityOf(session: string): Promise<boolean> {
    const response = await request(app.server)
      .get(apiPath('/auth/me'))
      .set({ Cookie: cookieHeader(session) })
      .expect(200);
    return parseSessionUser(response.body).aiFormsAvailable;
  }

  /**
   * The status of the generation route. Without a provider double, a
   * call that is let through ends in an error — therefore **only** whether
   * the availability guard says 404 or not is checked.
   */
  async function generateStatus(session: string): Promise<number> {
    const response = await request(app.server)
      .post(apiPath('/ai/forms'))
      .set(authedMutation(session))
      .send({ prompt: 'Ein Formular für die Bestandsmeldung' });
    return response.status;
  }
});

/**
 * **The environment does not stay silent when it still carries something.**
 *
 * A `describe` of its own, because this case needs no database: it measures
 * the service, not the route.
 *
 * *Reproduction:* empty out `onApplicationBootstrap` → this case turns red, and
 * an installation would run with **two** sources for the same value, of which
 * one wins invisibly.
 */
describe('die Startwarnung über zurückgebliebene Umgebungsvariablen', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it('nennt jede der fünf, die noch gesetzt ist — und nie ihren Wert', () => {
    process.env.AI_PROVIDER = 'anthropic';
    process.env.AI_ANTHROPIC_API_KEY = KEY;

    const warned: string[] = [];
    const service = Object.create(
      AiSettingsService.prototype,
    ) as AiSettingsService;
    Object.defineProperty(service, 'logger', {
      value: { warn: (message: string) => warned.push(message) },
    });
    service.onApplicationBootstrap();

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('AI_PROVIDER');
    expect(warned[0]).toContain('AI_ANTHROPIC_API_KEY');
    expect(warned[0]).toContain('Systemeinstellungen');
    // Never the value itself: one of the five is an API key.
    expect(warned[0]).not.toContain(KEY);
  });
});
