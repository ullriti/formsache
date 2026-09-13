import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GLOBAL_API_PREFIX } from '../../src/app.module';
import { NOT_SUPERADMIN_MESSAGE } from '../../src/auth/superadmin.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import { createTenant, createUser } from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import {
  TENANT_BOUND_PREFIXES,
  registeredRoutes,
  routesOf,
  type RegisteredRoute,
} from '../support/registered-routes';

/**
 * **The superadmin surface addresses a foreign Organisation — on a way of its own.**
 *
 * ## Why a walker and not a list
 *
 * It makes an absence load-bearing: `GET`/`PUT /api/tenant/form-defaults` carry no
 * tenant in their path, and *that* is the tenant boundary of those routes —
 * „eine Grenze, die man gar nicht adressieren kann, ist stärker als eine, die
 * man adressiert und abgewiesen bekommt". An absence is only worth something
 * while nobody adds the thing back, so it needs a guard rather than a sentence.
 *
 * A guard over a maintained list of paths would be a second piece of
 * documentation: it stays green for the path nobody added it to, which is
 * exactly the path somebody would add a `:tenantId` to. This file therefore
 * walks the routes the application **actually registered**
 * (`support/registered-routes.ts`).
 *
 * ## What the guard asks, and why it stopped asking for a name
 *
 * The first version of this file refused a parameter whose *name* mentioned a
 * Organisation (or whose preceding segment did). That is weaker than the promise: a
 * `@Get('form-defaults/:id')` on the organisation-facing controller yields
 * `/api/tenant/form-defaults/:id`, names an organisation in the only sense that matters,
 * and mentions neither word — it stayed green (review finding).
 *
 * What is asked instead is a question about the **shape**: below the two
 * prefixes, a parameter is the id of a member of a known collection
 * ({@link MEMBER_PARAMETERS}) and nothing else. That is not a list of paths —
 * it says nothing about which routes exist — and a new parameter has to be
 * admitted deliberately, one line, with the collection it belongs to named
 * next to it.
 *
 * ## Negative probes
 *
 * - `@Get('form-defaults/:id')` on the organisation-facing prefix: red — and no longer
 *   a probe „measured while writing", but the test „turns red for an organisation-facing
 *   route that addresses one organisation", which boots exactly that application.
 * - `@Get(':tenantId/form-defaults')` added to `TenantSettingsController`:
 *   the guard red, naming the path.
 * - `SuperadminGuard` removed from `AdminTenantsController`: every 403 pair
 *   red, while the „superadmin gets through" control stays green — which is
 *   what tells „der Guard fehlt" apart from „die Route fehlt".
 * - The reader in `registered-routes.ts` made to return `[]`: both guards red
 *   at the `MINIMUM_ROUTES` floor rather than green about nothing.
 */

const PASSWORD = 'test-password';

/**
 * Words that name an organisation, used **only** for the positive statements further
 * down („diese Route benennt eine Organisation, und das darf sie").
 *
 * Deliberately not the guard: a name check answers „nein" for
 * `/api/tenant/form-defaults/:id`, which names an organisation as surely as `:tenantId`
 * does. What guards the two prefixes is {@link nonMemberParametersOf}, and the
 * difference between the two functions is the finding this file was rewritten
 * for (a review finding).
 */
const TENANT_WORDS = ['tenant', 'Organisation'];

/**
 * **The shape a path below the guarded prefixes may have** — the guard's whole
 * statement, and the reason it is not a list of paths.
 *
 * A parameter there is the id of **one member of the collection named in the
 * segment before it**: `forms/:id`, `groups/:id`, `users/:userId`,
 * `members/:userId`, `notifications/:notificationId`. Nothing else is a
 * parameter's business on these routes, because everything else those routes
 * work on is resolved from the session — the organisation above all, which is the
 * absence the requirement makes load-bearing.
 *
 * Read as a rule rather than as an inventory: it does not say *which* paths
 * exist, it says what any path may look like. A route added tomorrow is green
 * if it addresses a member of one of these collections and **red otherwise** —
 * including `/api/tenant/form-defaults/:id`, the pathological case that passed
 * the earlier name-based check (there is no „tenant" in „id"). Adding a new
 * collection is one line here and a deliberate act: the entry says „diese
 * Sammlung darf adressiert werden", and no organisation is one of them.
 *
 * `id` is accepted only next to the collection it belongs to, never on its own:
 * that is what keeps the generic name from becoming the hole the whole guard
 * has.
 */
const MEMBER_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  forms: ['id', 'formId'],
  users: ['userId'],
  members: ['userId'],
  groups: ['id', 'groupId'],
  notifications: ['notificationId'],
  // The attachment download route: `GET /api/responses/files/:ref`. `:ref`
  // is the `public_ref` of one `file` row, i.e. exactly
  // the member id of the collection named before it, and it names no organisation: the
  // Organisation comes from the session's scope, and the row is read through it.
  files: ['ref'],
  // `DELETE /api/forms/:id/responses/:responseId` and its restore route.
  // `:responseId` is the id of one `response` row of the
  // form named before it — a member id, and no organisation: the organisation comes from the
  // session's scope, the form is resolved through it, and the statement that
  // writes `deleted_at` carries both `formId` and `tenantId` in its `where`.
  responses: ['responseId'],
  // `PUT /api/forms/:formId/templates/:id` — „Aus diesem Formular
  // aktualisieren". `:id` is the id of one `form_template` row and names no
  // Organisation: the organisation comes from the session's scope, the row is read through it
  // (`requireTemplate`), and the statement that overwrites it carries
  // `tenant_id` in its own `where`. The form named before it is resolved the
  // same way, which is why this route sits under `forms/:formId` at all — the
  // fourth link of the guard chain applies to the source it copies from.
  templates: ['id'],
  // A review finding: with `/api/mail-log` and `/api/form-templates` two
  // collections newly fall under this rule that have long carried the guard.
  // `:id` is in each case the identifier of **one** row, read through the scope
  // of the session — no organisation in the path.
  'mail-log': ['id'],
  'form-templates': ['id'],
};

/**
 * The two prefixes whose tenant boundary **is** the absence of a parameter —
 * and the whole scope of this guard.
 *
 * Deliberately not „nirgends im ganzen Baum", and that is not a softening. The
 * promise the requirement makes is about the organisation-facing domain routes: those resolve
 * their Organisation from a membership the session actually holds, so a parameter there
 * would be a second, weaker way to name one. Other prefixes make no such
 * promise and must not, because two routes of this application legitimately
 * name an organisation in their path:
 *
 * - `GET /api/admin/tenants/:tenantId` — the superadmin surface, which exists
 *   *in order to* address a foreign Organisation;
 * - `GET /api/auth/oidc/start/:tenantId` — the SSO button on the login page
 *   . There is no session there yet from which an organisation could be
 *   derived, so the organisation has to be in the address.
 *
 * A wider guard plus an exemption list would be the shape this file exists to
 * avoid: a list stays green for the *next* path nobody adds to it, and an
 * exemption that lives beside the route rather than on it is a rule somebody
 * has to remember. Narrowing the scope to what the requirement actually promises
 * makes both routes simply not the subject — no entry, nothing to maintain.
 *
 * Shared with `route-permission-guard.spec.ts` as {@link TENANT_BOUND_PREFIXES}
 * (`support/registered-routes.ts`) — one array, not two that could disagree.
 */
const GUARDED_PREFIXES = TENANT_BOUND_PREFIXES;

function namesATenant(word: string): boolean {
  const lower = word.toLowerCase();
  return TENANT_WORDS.some((needle) => lower.includes(needle));
}

/**
 * The parameter segments of `path` that name an organisation, or an empty list — the
 * **weak** reading, and used only where a route is asserted to name one.
 *
 * Returned rather than a boolean so a failure can say *which* segment — a red
 * test that only says „irgendwo" costs the next reader the walk this function
 * already did.
 */
function tenantSegmentsOf(path: string): string[] {
  const segments = path.split('/');
  return segments.filter((segment, index) => {
    if (!segment.startsWith(':')) {
      return false;
    }
    const previous = segments[index - 1] ?? '';
    return namesATenant(segment) || namesATenant(previous);
  });
}

/**
 * The parameters of `path` that are **not** the member id of a known collection
 * — the guard's predicate (see {@link MEMBER_PARAMETERS}).
 *
 * Returned as `<collection>/<parameter>` pairs rather than as bare names,
 * because that pair *is* the thing that has to be justified: „`:id` ist neu"
 * says nothing, „`form-defaults/:id` ist neu" says everything.
 */
function nonMemberParametersOf(path: string): string[] {
  const segments = path.split('/');
  return segments.flatMap((segment, index) => {
    if (!segment.startsWith(':')) {
      return [];
    }
    const collection = segments[index - 1] ?? '';
    const allowed = MEMBER_PARAMETERS[collection] ?? [];
    return allowed.includes(segment.slice(1))
      ? []
      : [`${collection}/${segment}`];
  });
}

/** Every route under the guarded prefixes whose parameters break that shape. */
function offendersAmong(routes: readonly RegisteredRoute[]): string[] {
  return routes
    .filter((route) =>
      GUARDED_PREFIXES.some((prefix) => route.path.startsWith(prefix)),
    )
    .filter((route) => nonMemberParametersOf(route.path).length > 0)
    .map(
      (route) =>
        `${route.method} ${route.path} → ${nonMemberParametersOf(route.path).join(', ')}`,
    );
}

/**
 * An organisation named on an organisation-facing route — **the pathological path itself**, not a
 * description of one.
 *
 * `/api/tenant/form-defaults/:id` is the route the review named: it addresses
 * one organisation's standards from the organisation-facing prefix, and the name-based check
 * this file used to run was green for it, because there is no „tenant" in „id".
 * It is registered on a throwaway application below and walked by the same
 * reader as the real one, so the reproduction is the guard failing rather than
 * a sentence promising it would.
 */
@Controller('tenant/form-defaults')
class PathologicalProbeController {
  @Get(':id')
  read(): Record<string, never> {
    return {};
  }
}

/** A path with its parameters filled in, so it can actually be called. */
function callable(path: string): string {
  return path.replace(
    /:[^/]+/g, // A syntactically valid uuid that names nothing. The guards under test run
    // *before* any lookup, so what matters is that the value parses — a 404
    // instead of a 403 would be the very confusion this design rules out.
    '00000000-0000-4000-8000-000000000000',
  );
}

describe('the superadmin routes are their own way in ', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;
  /** `admin` in the active Organisation — all five permissions, no superadmin flag. */
  let tenantAdmin: string;
  let superadmin: string;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    const tenant = await createTenant(testApp.prisma, 'ROUT');
    const admin = await createUser(testApp.prisma, {
      email: 'Organisation-admin@routes.example',
      password: PASSWORD,
      tenants: [tenant],
    });
    tenantAdmin = await openSession(testApp, admin.id, tenant.id);

    const root = await createUser(testApp.prisma, {
      email: 'root@routes.example',
      password: PASSWORD,
      tenants: [tenant],
      isSuperadmin: true,
    });
    superadmin = await openSession(testApp, root.id, tenant.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  function adminRoutes(): RegisteredRoute[] {
    return registeredRoutes(app()).filter((route) =>
      route.path.startsWith('/api/admin/'),
    );
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Structurally: no organisation is addressable on the ordinary routes
  // ═════════════════════════════════════════════════════════════════════════

  it('registers no route below /api/tenant/ or /api/forms/ that addresses anything but a known member', () => {
    expect(offendersAmong(registeredRoutes(app()))).toStrictEqual([]);
  });

  /**
   * **The reproduction, run rather than described** — and the reason the guard
   * stopped asking whether a parameter *sounds* like an organisation.
   *
   * A second application, one controller, the pathological route of the review:
   * `@Get('form-defaults/:id')` on the organisation-facing prefix. It is walked with
   * the same reader and judged by the same predicate as the shipped
   * application, so „ein neuer Pfad wird rot" is measured here instead of
   * promised. With `MEMBER_PARAMETERS` widened by a bare `id`, this test is the
   * one that goes red.
   */
  it('turns red for an organisation-facing route that addresses one organisation', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PathologicalProbeController],
    }).compile();
    const probe = moduleRef.createNestApplication();
    // The prefix the shipped application runs under, so the path this walks is
    // the path the requirement talks about rather than a look-alike.
    probe.setGlobalPrefix(GLOBAL_API_PREFIX);
    await probe.init();

    try {
      expect(offendersAmong(routesOf(probe))).toStrictEqual([
        'GET /api/tenant/form-defaults/:id → form-defaults/:id',
      ]);
    } finally {
      await probe.close();
    }
  });

  /**
   * The control that keeps the guard above from being vacuous.
   *
   * If the walker returned nothing under those prefixes — a renamed router
   * field, a changed global prefix — the first test would be green while
   * measuring an empty set. This one says the prefixes are populated, and the
   * one below says that a tenant parameter *is* something this check can see.
   */
  it('walks a populated set of routes under both guarded prefixes', () => {
    for (const prefix of GUARDED_PREFIXES) {
      const under = registeredRoutes(app()).filter((route) =>
        route.path.startsWith(prefix),
      );
      expect(under.length).toBeGreaterThan(0);
    }
  });

  it('refuses every parameter that is not a member of a known collection', () => {
    // The predicate itself, on the shapes it has to catch. Without this the
    // guard above would also be green for a predicate that answers „nein" to
    // everything — and the last two lines are what keep it from being green for
    // one that answers „ja" to everything.
    expect(
      nonMemberParametersOf('/api/tenant/:tenantId/form-defaults'),
    ).toEqual(['tenant/:tenantId']);
    // The one the *name* check let through: „id" mentions no organisation, and the
    // segment before it mentions none either.
    expect(nonMemberParametersOf('/api/tenant/form-defaults/:id')).toEqual([
      'form-defaults/:id',
    ]);
    expect(nonMemberParametersOf('/api/forms/:formId/tenant/:id')).toEqual([
      'tenant/:id',
    ]);
    // …and the shapes that are the ordinary business of these routes.
    expect(nonMemberParametersOf('/api/forms/:id/settings')).toEqual([]);
    expect(nonMemberParametersOf('/api/forms/:formId/members/:userId')).toEqual(
      [],
    );
  });

  it('recognises a tenant parameter when there is one', () => {
    // The weak reading, kept because the two positive statements below need
    // it: „diese Route benennt eine Organisation" is what they assert, and that is a
    // question about the name.
    expect(
      tenantSegmentsOf('/api/tenant/:tenantId/form-defaults'),
    ).toStrictEqual([':tenantId']);
    expect(tenantSegmentsOf('/api/forms/:formId/settings')).toStrictEqual([]);
  });

  it('addresses an organisation on the superadmin surface instead', () => {
    // The other half of the requirement: the boundary is not „niemand darf einen
    // Organisation benennen", it is „nicht auf die Organisation-eigenen Routen". A surface that
    // named none either would satisfy the guard above and satisfy nothing else.
    const naming = adminRoutes().filter(
      (route) => tenantSegmentsOf(route.path).length > 0,
    );
    expect(naming.length).toBeGreaterThan(0);
  });

  /**
   * …and the second route that legitimately names an organisation, so the narrow scope
   * of {@link GUARDED_PREFIXES} is asserted rather than merely explained.
   *
   * `GET /api/auth/oidc/start/:tenantId` is unauthenticated by
   * design: the SSO button sits on the login page, where there is no session to
   * derive an organisation from. Naming it here means that if somebody later widened the
   * guard to the whole tree, this test would say **which** route that broke and
   * why it is allowed — instead of the next author quietly adding an exemption.
   */
  it('lets the login path name an organisation, because there is no session there yet', () => {
    const start = registeredRoutes(app()).filter(
      (route) => route.path === '/api/auth/oidc/start/:tenantId',
    );
    expect(start.length).toBe(1);
    expect(tenantSegmentsOf(start[0]?.path ?? '')).toStrictEqual([':tenantId']);
    // It is outside the two guarded prefixes — which is the whole reason it
    // needs no exemption.
    expect(
      GUARDED_PREFIXES.some((prefix) => start[0]?.path.startsWith(prefix)),
    ).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Behaviourally: 403 for an organisation's own admin, on every route
  // ═════════════════════════════════════════════════════════════════════════

  it('refuses an organisation admin on every registered /api/admin/ route with 403', async () => {
    const routes = adminRoutes();
    // Every route of the prefix, not a hand-picked one: the surface grows, and
    // a route added without the guard is exactly what this has to catch.
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      // The method comes off the route table, so the call is written through
      // the index rather than as `.get(...)` — every method the surface
      // registers is exercised, including ones added later.
      const agent = request(app().server);
      const method = route.method.toLowerCase() as 'get';
      const response = await agent[method](callable(route.path))
        .set(authedMutation(tenantAdmin))
        .send({});

      expect(
        `${route.method} ${route.path} → ${String(response.status)}`,
        // 403 and **not** 404: the caller is signed in and the route is no
        // secret — every installation has it and it is in the OpenAPI surface.
        // A 404 would be a riddle instead of an answer.
      ).toBe(`${route.method} ${route.path} → 403`);
      expect(response.text).toContain(NOT_SUPERADMIN_MESSAGE);
    }
  });

  /**
   * The control for the pair above: with the guard removed, the 403s would go
   * away *and* this would stay green — which is what tells „der Guard fehlt"
   * apart from „die Route fehlt". An organisation admin holds all five group
   * permissions, `can_manage_settings` and `can_manage_users` included, so the
   * refusal above is about the superadmin flag and nothing else.
   */
  it('lets a superadmin through the same route', async () => {
    const response = await request(app().server)
      .get('/api/admin/tenants')
      .set('Cookie', cookieHeader(superadmin));

    expect(response.status).toBe(200);
  });
});
