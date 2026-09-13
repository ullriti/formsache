import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSessionUser } from '@formsache/shared';

import { AI_NOT_AVAILABLE_MESSAGE } from '../../src/ai/ai-feature.guard';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import { NO_TENANT_SCOPE_MESSAGE } from '../../src/tenancy/tenant-scope.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  configureAi,
  createTestApp,
  type AiFixture,
  type TestApp,
} from '../support/create-test-app';
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import { RecordedFormGenerator } from '../support/recorded-form-generator';
import { RECORDED_DRAFT } from './recorded-answers';

/**
 * **The AI is an editor feature, and without a key it does not exist**
 * (the requirements).
 *
 * ## The order is the subject of this file
 *
 * One rule says „without a key **404**", the other says „without a session **401**" — and both
 * apply to the same route. Without a written-down order this looks like a
 * contradiction, and somebody repairs the wrong one: *session → organisation →
 * permission → availability*. That is why **every** refusal case runs here
 * **twice** — once against an installation with configured AI and once against
 * one without. Someone not logged in gets 401 in both.
 *
 * *Reproduction:* pull `AiFeatureGuard` to the front in `@UseGuards(...)` → the
 * 401 and 403 cases of the **unconfigured** application answer 404, and thereby
 * the status code tells a stranger whether this installation pays for an AI.
 *
 * ## Why every case sees the *forbidden* access fail
 *
 * A test that only checks the permitted access proves nothing.
 * The counter-check stands beside it nonetheless — the permitted call **must**
 * get through, otherwise all refusals would be green even when the route is
 * simply broken.
 */

const SETUP_TIMEOUT_MS = 180_000;

/** What the configured installation „has" as a provider. */
const CONFIGURED = {
  provider: 'anthropic',
  apiKey: 'test-key-not-a-real-one',
} as const;

const PROMPT = { prompt: 'Ein Formular für die Bestandsmeldung' };

describe('die KI-Route: Kette, Rechte und Verfügbarkeit', () => {
  let database: TestDatabase;

  /** The application **with** AI set up. */
  let configured: TestApp;
  /** The same application **without** — the default state of `createTestApp`. */
  let unconfigured: TestApp;
  /** And a third one: key present, `AI_ENABLED=false`. */
  let switchedOff: TestApp;

  let generator: RecordedFormGenerator;

  let tenant: TenantFixture;
  let otherTenant: TenantFixture;
  /** `can_build` — is allowed to. */
  let builderSession: string;
  /** Everything except `can_build` — is not allowed to. */
  let viewerSession: string;
  /** Member of an *other* organisation, without a membership in the first. */
  let strangerId: string;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    generator = new RecordedFormGenerator({
      ok: true,
      draft: RECORDED_DRAFT,
      usage: null,
    });

    configured = await createTestApp({
      databaseUrl: database.url,
      ai: { ...CONFIGURED },
      aiGenerator: generator,
    });
    unconfigured = await createTestApp({
      databaseUrl: database.url,
      // No `env` — the default of the test application is „no AI", and that is
      // the state this rule measures.
      aiGenerator: generator,
    });
    switchedOff = await createTestApp({
      databaseUrl: database.url,
      ai: { ...CONFIGURED, enabled: false },
      aiGenerator: generator,
    });

    const prisma = configured.prisma;
    tenant = await createTenant(prisma, 'KIROUTE');
    otherTenant = await createTenant(prisma, 'KIFREMD');

    const builder = await createUser(prisma, {
      email: 'bearbeiter@kiroute.example.org',
      password: 'passwort-fuer-den-test',
      tenants: [tenant],
    });
    builderSession = await openSession(configured, builder.id, tenant.id);

    const viewer = await createRestrictedMember(prisma, tenant, {
      email: 'nurlesen@kiroute.example.org',
      groupName: 'Auswertung',
      // **All other permissions**, only not `canBuild`: a member that holds
      // nothing at all would only prove that *some* guard fires.
      permissions: {
        canBuild: false,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: true,
        canManageUsers: true,
      },
    });
    viewerSession = await openSession(configured, viewer.id, tenant.id);

    const stranger = await createUser(prisma, {
      email: 'fremd@kifremd.example.org',
      password: 'passwort-fuer-den-test',
      tenants: [otherTenant],
    });
    strangerId = stranger.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // `as … | undefined`: the declarations above are definite, but a run in an
    // environment with no database never reaches them — and an unguarded
    // teardown would then report a second, unrelated failure on top of the
    // real one.
    const apps = [configured, unconfigured, switchedOff] as (
      TestApp | undefined
    )[];
    for (const app of apps) {
      await app?.close();
    }
    await (database as TestDatabase | undefined)?.release();
  });

  const generate = (app: TestApp, headers: Record<string, string>) =>
    request(app.server).post(apiPath('/ai/forms')).set(headers).send(PROMPT);

  /**
   * **The configuration is a state, not a start-up option.**
   *
   * Formerly three applications with three `env` blocks stood here side by side,
   * and that worked because the answer was fixed at start-up. Since the move
   * into the settings row all three share **one** installation — they read the
   * same row, hence also the same answer. Three simultaneously different
   * configurations do not exist any more, and that is as it should be: it *is*
   * one installation.
   *
   * The state is therefore set per case. That is stricter than before, because
   * it additionally measures what the move brings in: the feature comes and goes
   * **without a restart**.
   */
  const useAi = (fixture: AiFixture): Promise<void> =>
    configureAi(configured, fixture);
  const NO_AI: AiFixture = {};
  const SWITCHED_OFF: AiFixture = { ...CONFIGURED, enabled: false };

  // -------------------------------------------------------------------------
  // The chain, against both installations each time.
  // -------------------------------------------------------------------------

  it.each([
    { name: 'mit eingerichteter KI', ai: CONFIGURED, app: () => configured },
    { name: 'ohne eingerichtete KI', ai: NO_AI, app: () => unconfigured },
  ])('ohne Sitzung: 401 — $name', async ({ ai, app }) => {
    await useAi(ai);
    const response = await generate(app(), {});
    expect(response.status).toBe(401);
  });

  it.each([
    { name: 'mit eingerichteter KI', ai: CONFIGURED, app: () => configured },
    { name: 'ohne eingerichtete KI', ai: NO_AI, app: () => unconfigured },
  ])('ohne `can_build`: 403 — $name', async ({ ai, app }) => {
    await useAi(ai);
    const response = await generate(app(), authedMutation(viewerSession));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      message: MISSING_PERMISSION_MESSAGE,
    });
  });

  /**
   * **The tenant boundary, in the form this route can have it at all.**
   *
   * The route carries **no** `:tenantId` and **no** `:id` — the organisation is the
   * active one of the session, resolved from the *memberships*, never from a
   * parameter. „404 across the tenant boundary" therefore has no spelling here;
   * what does exist is the attempt to work with a session whose claimed
   * organisation is covered by no membership — and that is **403**, because
   * `TenantScopeGuard` builds no scope at all (its own reasoning: 401 would send
   * a valid user back to the login, where nothing changes). The organisation is
   * **not named** in the process, in neither of the two cases — that is the
   * indistinguishability at stake.
   *
   * *Reproduction:* let `TenantScopeGuard` take over the organisation from
   * `session.active_tenant_id` unchecked → this case gets 200 and the foreign
   * organisation has lost a quota.
   */
  it('mit einer Sitzung, die eine fremde Organisation beansprucht: 403, ohne die Organisation zu nennen', async () => {
    await useAi(CONFIGURED);
    const session = await openSession(configured, strangerId, tenant.id);
    const response = await generate(configured, authedMutation(session));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ message: NO_TENANT_SCOPE_MESSAGE });
    expect(JSON.stringify(response.body)).not.toContain(tenant.id);
    expect(JSON.stringify(response.body)).not.toContain(tenant.shortName);
  });

  // -------------------------------------------------------------------------
  // Without a key the feature does not exist.
  // -------------------------------------------------------------------------

  /**
   * **404, not 503.** The difference is not cosmetics: 503
   * means „ist gerade kaputt", invites a retry and promises a return that does
   * not exist.
   */
  it('ohne konfigurierten Anbieter: 404, und die Antwort ist keine 503', async () => {
    await useAi(NO_AI);
    const response = await generate(
      unconfigured,
      authedMutation(builderSession),
    );
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ message: AI_NOT_AVAILABLE_MESSAGE });
  });

  it('ohne konfigurierten Anbieter antwortet auch die Verbrauchsanzeige 404', async () => {
    await useAi(NO_AI);
    const response = await request(unconfigured.server)
      .get(apiPath('/ai/quota'))
      .set({ Cookie: cookieHeader(builderSession) });
    expect(response.status).toBe(404);
  });

  /**
   * **The switch, measured at the route and not at the button.**
   * Key **present**, `AI_ENABLED=false`.
   *
   * *Reproduction:* let the switch only hide the interface (that is, remove
   * `AI_ENABLED` from `resolveAiConfig`) → this case gets 200, and the „switched
   * off" installation keeps paying.
   */
  it('mit Schlüssel, aber abgeschaltetem Systemschalter: 404', async () => {
    await useAi(SWITCHED_OFF);
    const before = generator.attempts;
    const response = await generate(
      switchedOff,
      authedMutation(builderSession),
    );
    expect(response.status).toBe(404);
    // And nothing went out — a 404 after the call would be expensive.
    expect(generator.attempts).toBe(before);
  });

  /**
   * **The application starts without AI** — measured by the fact that
   * `unconfigured` exists at all and its *other* routes answer.
   *
   * Unlike with a missing storage configuration (ADR-0014): the AI is SHOULD,
   * the upload is MUST.
   *
   * *Reproduction:* add the key as a mandatory variable in `env.ts` →
   * `createTestApp` without `AI_*` throws at start-up, and this case goes red
   * before it checks anything.
   */
  it('startet ohne jede KI-Konfiguration und bedient ihre übrigen Routen', async () => {
    await useAi(NO_AI);
    const response = await request(unconfigured.server)
      .get(apiPath('/auth/me'))
      .set({ Cookie: cookieHeader(builderSession) });

    expect(response.status).toBe(200);
    // And the session payload says „gibt es hier nicht" — the same resolution
    // the 404 above comes from (this case needs exactly this field in order to
    // make the menu entry *absent* instead of greyed out).
    expect(parseSessionUser(response.body).aiFormsAvailable).toBe(false);
  });

  it('meldet die Funktion in der Sitzungsnutzlast, wenn sie eingerichtet ist', async () => {
    await useAi(CONFIGURED);
    const response = await request(configured.server)
      .get(apiPath('/auth/me'))
      .set({ Cookie: cookieHeader(builderSession) });

    expect(response.status).toBe(200);
    expect(parseSessionUser(response.body).aiFormsAvailable).toBe(true);
  });

  it('meldet sie als abwesend, wenn der Schalter sie abschaltet', async () => {
    await useAi(SWITCHED_OFF);
    const response = await request(switchedOff.server)
      .get(apiPath('/auth/me'))
      .set({ Cookie: cookieHeader(builderSession) });

    expect(response.status).toBe(200);
    expect(parseSessionUser(response.body).aiFormsAvailable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The counter-check: the permitted access gets through.
  // -------------------------------------------------------------------------

  /**
   * Without this case all refusals above would be green even when the route does
   * not work at all — the mistake the requirements describe with
   * „stayed green, *because* nothing was ever created".
   */
  it('lässt einen Bearbeiter mit `can_build` durch — und legt dabei kein Formular an', async () => {
    await useAi(CONFIGURED);
    const formsBefore = await configured.prisma.form.count({
      where: { tenantId: tenant.id },
    });

    const response = await generate(configured, authedMutation(builderSession));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    // The title is a **proposal** of the model, not a created form
    // (ADR-0015 no. 11): *adopting* it goes through `POST /api/forms`.
    expect(response.body).toMatchObject({ title: RECORDED_DRAFT.title });
    expect(
      await configured.prisma.form.count({ where: { tenantId: tenant.id } }),
    ).toBe(formsBefore);
  });

  /**
   * And the usage is the **one of the own organisation** — the boundary this
   * route really has (the rule: the organisation *sees* its usage).
   */
  /*
   * ⚠️ **Here stood „shows the organisation its own usage, not that of another
   * one" — and the case checked nothing.** `toMatchObject({ used:
   * expect.any(Number) })` says nothing about the value, and the „other"
   * organisation makes **never** an AI call in this whole file: its row count was
   * `0`, regardless of whether the route is tenant-scoped at all.
   *
   * Deleted instead of repaired, because the promise is covered **for real**
   * elsewhere: `test/ai/usage-isolation.spec.ts` gets both organisations some
   * usage and sees that ALPHA gets nothing of BETA's numbers. Two cases for one
   * promise, one of which is empty, are worse than one.
   */

  /**
   * **The organisation's own switch has a chain too** (a review finding).
   *
   * `GET`/`PUT /api/ai/tenant-settings` had only been run with a user who holds
   * **all** permissions. CONTRIBUTING.md demands the case that fails — and it was
   * missing, although behind the route lies a switch that turns the feature off
   * for a whole organisation.
   *
   * ⚠️ The route deliberately does **not** stand behind `AiFeatureGuard`
   * (otherwise a switched-off organisation would never get out again) — the
   * chain is therefore *session → organisation → permission*, and
   * `canManageSettings` is the permission.
   */
  describe('der eigene KI-Schalter der Organisation', () => {
    const TENANT_SETTINGS = apiPath('/ai/tenant-settings');

    it('ohne Sitzung: 401 auf beiden Wegen', async () => {
      expect(
        (await request(configured.server).get(TENANT_SETTINGS)).status,
      ).toBe(401);
      const written = await request(configured.server)
        .put(TENANT_SETTINGS)
        .send({ enabled: false });
      expect([401, 403]).toContain(written.status);
    });

    it('ohne `can_manage_settings`: 403 — und die Spalte bleibt', async () => {
      const before = await configured.prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { aiEnabled: true },
      });

      // ⚠️ The `viewer` of this file holds **all** permissions except
      // `canBuild` — for this route they are therefore authorised. What is needed
      // is the opposite: somebody who may build and may **not** manage settings.
      // That is exactly the trap that proves something: whoever got through here
      // would get through with proper permissions.
      const settingsBlind = await createRestrictedMember(
        configured.prisma,
        tenant,
        {
          email: 'nur-bauen@kiroute.example.org',
          groupName: 'nur-bauen',
          permissions: {
            canBuild: true,
            canViewResponses: true,
            canExport: true,
            canManageSettings: false,
            canManageFormSettings: false,
            canManageUsers: true,
          },
        },
      );
      const session = await openSession(
        configured,
        settingsBlind.id,
        tenant.id,
      );

      const refused = await request(configured.server)
        .put(TENANT_SETTINGS)
        .set(authedMutation(session))
        .send({ enabled: false });

      expect(refused.status).toBe(403);

      /**
       * **The reading too** (ADR-0025).
       *
       * The case was missing as long as the answer only carried the own switch —
       * since it additionally says whether the *installation* has an AI, that is
       * information about the installation, and it must not slip past a guard
       * that applies to writing.
       */
      const denied = await request(configured.server)
        .get(TENANT_SETTINGS)
        .set({ Cookie: cookieHeader(session) });
      expect(denied.status).toBe(403);

      // Not only the answer — the column too. The shape: 204 instead of
      // 403, **and written**.
      const after = await configured.prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { aiEnabled: true },
      });
      expect(after?.aiEnabled).toBe(before?.aiEnabled ?? null);
    });
  });
});
