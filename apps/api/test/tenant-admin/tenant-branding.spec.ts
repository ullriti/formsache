import {
  DEFAULT_TENANT_BRANDING,
  TENANT_LOGO_REFS,
  isBrandColor,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  STALE_BRANDING_MESSAGE,
  TenantBrandingService,
} from '../../src/tenant-admin/tenant-branding.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
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
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';

/**
 * the requirements against real PostgreSQL — the two gates, the guard
 * chain and the case that has no session.
 *
 * **What this file can and cannot prove.** Both gates ask the same predicate,
 * so a save-then-read test is blind to gate 2 on its own: remove the delivery
 * check and everything here that goes through the API stays green, because the
 * save already refused what the delivery would have caught. Every gate-2 test
 * below therefore writes its value **straight into the column** with raw SQL —
 * a hand-written `UPDATE`, an older version, a restore. The unit tests in
 * `packages/shared/src/branding.test.ts` cover each gate a second time in
 * isolation.
 *
 * *Reproductions, measured while writing this file — see the report.*
 */

const PASSWORD = 'test-password';

/** A branding an admin could have configured — distinct from every default. */
const ALPHA_BRANDING = {
  name: 'Organisation BRA',
  logoRef: { kind: 'asset', ref: 'assets/beispiel-emblem.svg' },
  logoWide: false,
  stripeColors: ['#e30000', '#cad0d3', '#131313'],
  accent: '#e30000',
  headerBg: '#131313',
  canvasBg: '#e9e6df',
};

/** The other organisation's, chosen so no value can be mistaken for Alpha's. */
const BETA_COLOURS = {
  accent: '#0044cc',
  headerBg: '#003311',
  canvasBg: '#f0f4ff',
  stripe: ['#0044cc', '#003311', '#f0f4ff'],
};

/**
 * A colour that closes the declaration and starts a new one — the reason both
 * gates exist. Written straight into the column, never through the API.
 */
const CSS_INJECTION = '#fff; } body { display: none } .x {';

/** Shape of the branding payload — parsed, not asserted about here. */
interface BrandingBody {
  name: string;
  shortName: string;
  logoRef: { kind: string; ref: string } | null;
  logoWide: boolean;
  stripeColors: string[];
  accent: string;
  headerBg: string;
  canvasBg: string;
  logoChoices: string[];
  revision: number;
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

describe('tenant branding', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  /** The organisation under test. */
  let alpha: TenantFixture;
  /** A second organisation — a suite where every tenant owns one row proves nothing. */
  let beta: TenantFixture;
  let alphaAdmin: string;
  let betaAdmin: string;
  /**
   * A member of Alpha who holds **all four other** permissions and only lacks
   * `can_manage_settings`. A member with no permissions at all would prove that
   * *some* guard fires — the trap the requirements name outright.
   */
  let alphaWithoutSettings: string;
  /** A published form of **Beta**, for the case that has no session. */
  let betaSlug: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'BRA');
    beta = await createTenant(testApp.prisma, 'BRB');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'branding-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    const betaUser = await createUser(testApp.prisma, {
      email: 'branding-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'branding-almost@example.org',
      groupName: 'fast-alles',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageUsers: true,
        canManageSettings: false,
        canManageFormSettings: false,
      },
    });

    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);
    alphaWithoutSettings = await openSession(testApp, restricted.id, alpha.id);

    betaSlug = await publishForm(betaAdmin, 'Bestandsmeldung');
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Builds and publishes a form through the real routes; answers its slug. */
  async function publishForm(token: string, title: string): Promise<string> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({
        title,
        definition: {
          pages: [
            {
              id: '019ff200-0000-7000-8000-0000000000a0',
              title: 'Seite 1',
              questions: [
                {
                  id: '019ff200-0000-7000-8000-000000000001',
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
        },
        revision: form.revision,
      });

    await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(token))
      .send({ revision: (saved.body as { revision: number }).revision });

    return form.publicSlug;
  }

  async function readBranding(token: string): Promise<BrandingBody> {
    const response = await request(app().server)
      .get(apiPath('/tenant/branding'))
      .set('Cookie', cookieHeader(token));
    expect(response.status).toBe(200);
    return response.body as BrandingBody;
  }

  /** The current lock, read from the row — half the callers may not read it. */
  async function currentRevision(tenant: TenantFixture): Promise<number> {
    const row = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { brandingRevision: true },
    });
    return row.brandingRevision;
  }

  /**
   * The columns as PostgreSQL holds them — the one thing the API by definition
   * cannot show, and therefore the only way to say „der abgewiesene Schreib-
   * zugriff hat keine Zeile geändert".
   */
  async function storedColumns(tenant: TenantFixture) {
    return app().prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      select: {
        name: true,
        logoRef: true,
        logoWide: true,
        stripeColors: true,
        accentColor: true,
        headerColor: true,
        canvasColor: true,
        brandingRevision: true,
      },
    });
  }

  /** Writes a value into a colour column the way nothing but psql can. */
  async function poison(
    tenant: TenantFixture,
    columns: Partial<
      Record<
        'accent_color' | 'header_color' | 'canvas_color' | 'logo_ref',
        string
      >
    >,
  ): Promise<void> {
    for (const [column, value] of Object.entries(columns)) {
      await app().prisma.$executeRawUnsafe(
        `UPDATE "tenant" SET "${column}" = $1 WHERE "id" = $2::uuid`,
        value,
        tenant.id,
      );
    }
  }

  /** Puts the organisation back on a branding the API itself would accept. */
  async function restore(
    tenant: TenantFixture,
    colours: {
      accent: string;
      headerBg: string;
      canvasBg: string;
      stripe: string[];
      logoRef: string | null;
    },
  ): Promise<void> {
    await app().prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        accentColor: colours.accent,
        headerColor: colours.headerBg,
        canvasColor: colours.canvasBg,
        stripeColors: colours.stripe,
        logoRef: colours.logoRef,
      },
    });
  }

  // -------------------------------------------------------------------------
  // The guard chain (the specification: session → tenant scope → group permission)
  // -------------------------------------------------------------------------

  describe('who may reach the route', () => {
    it('refuses a request without a session', async () => {
      const response = await request(app().server).get(
        apiPath('/tenant/branding'),
      );

      expect(response.status).toBe(401);
    });

    it('answers 200 for an admin of the organisation', async () => {
      const body = await readBranding(alphaAdmin);

      expect(body.shortName).toBe('BRA');
    });

    it('refuses reading to a member who holds every other permission', async () => {
      // The pair: the same route, the same organisation, one flag apart.
      const response = await request(app().server)
        .get(apiPath('/tenant/branding'))
        .set('Cookie', cookieHeader(alphaWithoutSettings));

      expect(response.status).toBe(403);
      expect((response.body as { message: string }).message).toBe(
        MISSING_PERMISSION_MESSAGE,
      );
    });

    it('refuses writing to that member — and changes no row', async () => {
      const before = await storedColumns(alpha);

      const response = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaWithoutSettings))
        .send({
          ...ALPHA_BRANDING,
          name: 'Von der falschen Person',
          revision: before.brandingRevision,
        });

      expect(response.status).toBe(403);
      // Not „it did not work" — the row, column by column, including the lock.
      expect(await storedColumns(alpha)).toEqual(before);
    });

    it('has no route that names another organisation', async () => {
      // The structural half of the isolation claim (repeated
      // here because it is the reason there is nothing to refuse): the address
      // carries no tenant, so Alpha's admin cannot ask for Beta at all. What
      // they get is always their own active Organisation.
      const alphaBody = await readBranding(alphaAdmin);
      const betaBody = await readBranding(betaAdmin);

      expect(alphaBody.shortName).toBe('BRA');
      expect(betaBody.shortName).toBe('BRB');
      expect(
        await request(app().server)
          .get(apiPath(`/tenant/${beta.id}/branding`))
          .set('Cookie', cookieHeader(alphaAdmin)),
      ).toHaveProperty('status', 404);
    });
  });

  // -------------------------------------------------------------------------
  // Gate 1 — saving
  // -------------------------------------------------------------------------

  describe('gate 1 — saving', () => {
    it('stores a branding an admin configured', async () => {
      const revision = await currentRevision(alpha);

      const response = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaAdmin))
        .send({ ...ALPHA_BRANDING, revision });

      expect(response.status).toBe(200);
      const body = response.body as BrandingBody;
      expect(body.accent).toBe('#e30000');
      expect(body.logoRef).toEqual({
        kind: 'asset',
        ref: 'assets/beispiel-emblem.svg',
      });
      expect(body.revision).toBe(revision + 1);

      const stored = await storedColumns(alpha);
      expect(stored.accentColor).toBe('#e30000');
      expect(stored.stripeColors).toEqual(ALPHA_BRANDING.stripeColors);
    });

    it.each([
      ['#fff', 'a three-digit literal — only the six-digit form is accepted'],
      ['#cea967ff', 'an alpha channel on an organisation colour'],
      ['red', 'a keyword'],
      ['var(--color-accent)', 'a substitution'],
      [CSS_INJECTION, 'a second declaration behind the first'],
    ])('refuses %s as the accent, naming the field', async (accent) => {
      const before = await storedColumns(alpha);

      const response = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaAdmin))
        .send({
          ...ALPHA_BRANDING,
          accent,
          revision: before.brandingRevision,
        });

      expect(response.status).toBe(400);
      const body = response.body as { issues: { path: string }[] };
      // „die Meldung nennt das Feld" — a page with seven colour pickers and a
      // bare „ungültig" tells an admin nothing.
      expect(body.issues.map((issue) => issue.path)).toEqual(['accent']);
      expect(await storedColumns(alpha)).toEqual(before);
    });

    it('refuses an unsafe colour inside the stripe, with its index', async () => {
      const before = await storedColumns(alpha);

      const response = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaAdmin))
        .send({
          ...ALPHA_BRANDING,
          stripeColors: ['#e30000', CSS_INJECTION, '#131313'],
          revision: before.brandingRevision,
        });

      expect(response.status).toBe(400);
      expect(
        (response.body as { issues: { path: string }[] }).issues.map(
          (issue) => issue.path,
        ),
      ).toEqual(['stripeColors.1']);
      expect(await storedColumns(alpha)).toEqual(before);
    });

    it.each([
      'javascript:alert(1)',
      'https://fremd.example/logo.png',
      'assets/../../etc/passwd',
    ])(
      'refuses the Logo %s — neither a shipped asset nor a file reference',
      async (ref) => {
        const before = await storedColumns(alpha);

        const response = await request(app().server)
          .put(apiPath('/tenant/branding'))
          .set(authedMutation(alphaAdmin))
          .send({
            ...ALPHA_BRANDING,
            logoRef: { kind: 'asset', ref },
            revision: before.brandingRevision,
          });

        expect(response.status).toBe(400);
        expect(
          (response.body as { issues: { path: string }[] }).issues.map(
            (issue) => issue.path,
          ),
        ).toEqual(['logoRef.ref']);
        expect(await storedColumns(alpha)).toEqual(before);
      },
    );

    it('refuses a second write that started from the same revision', async () => {
      const revision = await currentRevision(alpha);

      const first = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaAdmin))
        .send({ ...ALPHA_BRANDING, name: 'Zuerst gespeichert', revision });
      expect(first.status).toBe(200);

      const second = await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(alphaAdmin))
        .send({ ...ALPHA_BRANDING, name: 'Danach gespeichert', revision });

      expect(second.status).toBe(409);
      expect((second.body as { message: string }).message).toBe(
        STALE_BRANDING_MESSAGE,
      );
      // The decision the counter exists for: the loser's document is *not*
      // written. Without it, „Danach" would silently replace „Zuerst" and
      // nothing on either page would say so.
      expect((await storedColumns(alpha)).name).toBe('Zuerst gespeichert');
    });
  });

  // -------------------------------------------------------------------------
  // Gate 2 — delivering
  // -------------------------------------------------------------------------

  describe('gate 2 — delivering', () => {
    it('does not deliver a colour written past the API to the session', async () => {
      await poison(alpha, { accent_color: CSS_INJECTION });

      const response = await request(app().server)
        .get(apiPath('/auth/me'))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(response.status).toBe(200);
      // The whole text, not the field that was expected: a value nested
      // somewhere else in the payload would pass a field check.
      expect(response.text).not.toContain('display: none');
      expect(response.text).not.toContain(CSS_INJECTION);

      const body = response.body as {
        memberships: { tenant: { branding: { accent: string } } }[];
      };
      expect(body.memberships[0]?.tenant.branding.accent).toBe(
        DEFAULT_TENANT_BRANDING.accent,
      );

      await restore(alpha, {
        ...ALPHA_BRANDING,
        stripe: ALPHA_BRANDING.stripeColors,
        // The column, not the union the wire carries: `restore` writes
        // straight into `logo_ref`.
        logoRef: ALPHA_BRANDING.logoRef.ref,
      });
    });

    it('does not deliver it to the editing admin either', async () => {
      await poison(alpha, {
        header_color: CSS_INJECTION,
        canvas_color: 'url(https://evil.example/x)',
      });

      const body = await readBranding(alphaAdmin);

      expect(body.headerBg).toBe(DEFAULT_TENANT_BRANDING.headerBg);
      expect(body.canvasBg).toBe(DEFAULT_TENANT_BRANDING.canvasBg);
      for (const value of [body.accent, body.headerBg, body.canvasBg]) {
        expect(isBrandColor(value)).toBe(true);
      }

      await restore(alpha, {
        ...ALPHA_BRANDING,
        stripe: ALPHA_BRANDING.stripeColors,
        // The column, not the union the wire carries: `restore` writes
        // straight into `logo_ref`.
        logoRef: ALPHA_BRANDING.logoRef.ref,
      });
    });

    it.each([
      ['javascript:alert(1)', 'a script URL on a page members trust'],
      [
        'https://fremd.example/logo.png',
        'an outbound call from inside an organisation’s own page',
      ],
    ])('does not deliver the Logo %s ', async (logoRef) => {
      await poison(beta, { logo_ref: logoRef });

      const response = await request(app().server).get(
        apiPath(`/public/forms/${betaSlug}`),
      );

      expect(response.status).toBe(200);
      expect(
        (response.body as { tenant: { logoRef: null } }).tenant.logoRef,
      ).toBeNull();
      // Not merely absent from the field — absent from the payload, so nothing
      // downstream can find it and put it into an `src`.
      expect(response.text).not.toContain(logoRef);

      await restore(beta, {
        accent: BETA_COLOURS.accent,
        headerBg: BETA_COLOURS.headerBg,
        canvasBg: BETA_COLOURS.canvasBg,
        stripe: BETA_COLOURS.stripe,
        logoRef: 'assets/beispiel-signet.svg',
      });
    });

    it('does not deliver a poisoned colour to the public page', async () => {
      await poison(beta, { accent_color: CSS_INJECTION });

      const response = await request(app().server).get(
        apiPath(`/public/forms/${betaSlug}`),
      );

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('display: none');
      expect(
        (response.body as { tenant: { branding: { accent: string } } }).tenant
          .branding.accent,
      ).toBe(DEFAULT_TENANT_BRANDING.accent);

      await restore(beta, {
        accent: BETA_COLOURS.accent,
        headerBg: BETA_COLOURS.headerBg,
        canvasBg: BETA_COLOURS.canvasBg,
        stripe: BETA_COLOURS.stripe,
        logoRef: 'assets/beispiel-signet.svg',
      });
    });
  });

  // -------------------------------------------------------------------------
  // The case a signed-in tester never sees
  // -------------------------------------------------------------------------

  describe('the public page has no session', () => {
    it('shows the colours of the organisation of the *form*, not of the caller', async () => {
      // Alpha and Beta are on deliberately different colours, and the request
      // carries **Alpha's** session cookie while asking for **Beta's** form.
      // A payload built from the session's Organisation would answer Alpha's red here;
      // the public route has no session to build from, and this is the
      // server-side half of the E2E case that belongs elsewhere.
      await request(app().server)
        .put(apiPath('/tenant/branding'))
        .set(authedMutation(betaAdmin))
        .send({
          name: 'Organisation BRB',
          logoRef: { kind: 'asset', ref: 'assets/beispiel-signet.svg' },
          logoWide: true,
          stripeColors: BETA_COLOURS.stripe,
          accent: BETA_COLOURS.accent,
          headerBg: BETA_COLOURS.headerBg,
          canvasBg: BETA_COLOURS.canvasBg,
          revision: await currentRevision(beta),
        })
        .expect(200);

      const withAlphaSession = await request(app().server)
        .get(apiPath(`/public/forms/${betaSlug}`))
        .set('Cookie', cookieHeader(alphaAdmin));
      const withoutSession = await request(app().server).get(
        apiPath(`/public/forms/${betaSlug}`),
      );

      const branding = (body: unknown) =>
        (body as { tenant: { branding: Record<string, unknown> } }).tenant
          .branding;

      expect(branding(withAlphaSession.body).accent).toBe(BETA_COLOURS.accent);
      expect(branding(withAlphaSession.body).headerBg).toBe(
        BETA_COLOURS.headerBg,
      );
      // …and a caller with no session at all sees byte-identically the same.
      expect(branding(withoutSession.body)).toEqual(
        branding(withAlphaSession.body),
      );
      // Alpha's own colour must appear nowhere in Beta's page.
      expect(withAlphaSession.text).not.toContain(ALPHA_BRANDING.accent);
    });
  });

  // -------------------------------------------------------------------------
  // What the payload is, and what it is not
  // -------------------------------------------------------------------------

  describe('the payload of the tab', () => {
    it('carries exactly these fields — a allow list', async () => {
      const body = await readBranding(alphaAdmin);

      expect(keysOf(body)).toEqual([
        'accent',
        'canvasBg',
        'headerBg',
        'logoChoices',
        'logoRef',
        'logoWide',
        'name',
        'revision',
        'shortName',
        'stripeColors',
      ]);
    });

    it('offers the shipped Logo, and lists only those', async () => {
      const body = await readBranding(alphaAdmin);

      // The choice travels, so the view cannot hold a second list. `logoChoices` stays the **shipped** set even now that the upload feature adds
      // the upload: an uploaded Logo is not a choice picked from a list, it
      // is the file the organisation sent to `POST /tenant/branding/logo`, and it
      // reaches this payload as `logoRef` instead.
      expect(body.logoChoices).toEqual([...TENANT_LOGO_REFS]);
    });

    it('never carries the organisation’s OIDC secret next to its colours', async () => {
      // The two halves of one tab are two routes on purpose.
      const body = await readBranding(alphaAdmin);

      expect(JSON.stringify(body)).not.toMatch(/oidc|secret|client/i);
    });
  });

  // -------------------------------------------------------------------------
  // The service itself, on the one path HTTP cannot reach
  // -------------------------------------------------------------------------

  describe('an organisation that disappears mid-request', () => {
    it('answers 404 rather than a conflict or a 500', async () => {
      const service = app().app.get(TenantBrandingService);
      // `findWithLogoFile`, not `find`: this service reads the
      // row **with the organisation's own Logo files** (ADR-0014 no. 12), because a
      // `logo_ref` that names an upload has to be proven by the tenant
      // relation rather than by a comparison afterwards.
      const scope = {
        tenant: { findWithLogoFile: () => Promise.resolve(null) },
      };

      await expect(
        // The scope is the only handle this service has, so a vanished Organisation is
        // reachable only by handing it one whose row is gone — which is what a
        // delete between the guard chain and the write looks like.
        service.read(scope as never),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
