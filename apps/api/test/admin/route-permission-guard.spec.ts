import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GLOBAL_API_PREFIX } from '../../src/app.module';
import { TenantScopeFactory } from '../../src/tenancy/tenant-scope';
import { TenantScopeGuard } from '../../src/tenancy/tenant-scope.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import { createTestApp, type TestApp } from '../support/create-test-app';
import {
  registeredRoutes,
  routesOf,
  TENANT_BOUND_PREFIXES,
} from '../support/registered-routes';
import {
  routePermissions,
  tenantBoundPrefixes,
  tenantBoundRoutesMissingTenantScopeGuard,
  type RoutePermission,
} from '../support/route-permissions';

/**
 * **A route without `@RequirePermission` is a decision, not an oversight**.
 *
 * `GroupPermissionGuard` passes any route that carries no
 * `@RequirePermission`/`@RequireAnyPermission`/`@RequireAllPermissions` — by
 * its own doc, deliberately: "a handler that needs none says so by not
 * asking". That is the right default for a route with **no** guard at all
 * (unreachable for lack of a scope), and the wrong one to leave unwatched for
 * a route that **does** run behind `TenantScopeGuard` — every member of
 * *some* Organisation reaches it, and "nobody typed `@RequirePermission` yet" and
 * "this is deliberately open to any member" produce the exact same, silent
 * absence.
 *
 * ## The shape, after `admin-routes.spec.ts`
 *
 * That file already walks routes the application **actually registered**
 * rather than a maintained list, for the reason its own doc gives: a list
 * stays green for the path nobody added to it. This file borrows the shape
 * for the same reason, aimed at a different question — not "does this path
 * name an organisation" but "does this handler decide about `@RequirePermission`".
 *
 * `registered-routes.ts`'s Express walk cannot answer that question — the
 * handler Express calls is a closure Nest built, not the function
 * `SetMetadata` wrote to (see `support/route-permissions.ts`'s doc). This file
 * therefore uses `DiscoveryService` instead, and **checks its own path
 * reconstruction against reality** rather than trusting it silently: the
 * floor test below fails loudly if the walk ever found nothing, which is what
 * a broken reconstruction looks like from here.
 *
 * ## The exception list is an equality, not a ceiling
 *
 * {@link JUSTIFIED_EXCEPTIONS} is compared to the *live* set of undecorated,
 * tenant-scoped routes with `toStrictEqual` on two sorted arrays — not with
 * `toContain` or a superset check. A route that stops needing its entry (the
 * decorator was added, or the route was deleted) leaves a stale key with
 * nothing to justify, and the equality catches that exactly as loudly as a
 * new, uncovered route: „eine Route, die verschwindet, macht den Test
 * genauso rot wie eine neue ungedeckelte".
 *
 * ## Negative probes, measured while writing this file
 *
 * - `@RequirePermission('canManageUsers')` removed from
 *   `TenantGroupsController.remove` (`tenant-admin/groups.controller.ts`):
 *   red — `DELETE /api/tenant/groups/:id` joins the undecorated set and has
 *   no entry in {@link JUSTIFIED_EXCEPTIONS}.
 * - The `'GET /api/groups'` entry deleted from {@link JUSTIFIED_EXCEPTIONS}:
 *   red — the live route is still undecorated (`GroupsController` never
 *   claimed a permission for it, on purpose, see the entry's own reason), so
 *   it now has no counterpart in the list and the equality fails.
 * - `routesOf`/`routePermissions`'s walk made to return `[]`: the floor test
 *   fails first, rather than the equality passing about nothing.
 */

const JUSTIFIED_EXCEPTIONS: Readonly<Record<string, string>> = {
  'GET /api/groups':
    'Liest nur, was TenantScopeGuard bereits gewährt — Name, Farbe und Rang ' +
    'der Gruppen der aktiven Organisation. Kein Recht wird geprüft, weil keines ' +
    'verbraucht wird: dieselben Werte stehen ohnehin überall dort, wo eine ' +
    'Rolle angezeigt wird (Mitgliederliste, Formular-Restriktion, ' +
    'Benachrichtigungs-Empfänger), keinem einzigen davon geht durch diese ' +
    'Route mehr auf als schon aus der eigenen Mitgliedschaft folgt.',
  'GET /api/groups/:id':
    'Dieselbe Begründung wie „GET /api/groups", für die Einzelansicht — eine ' +
    'fremde Gruppe bleibt ohnehin unerreichbar (404, GROUP_NOT_FOUND_MESSAGE, ' +
    'dieselbe Tenant-Grenze wie bei jedem anderen `findById` dieser ' +
    'Anwendung), das ist keine Frage der Gruppenrechte.',
  'POST /api/admin/system-settings/mail/test':
    'Die Testmail auf Systemebene (Befund 29a). Über *ob* sie darf, ' +
    'entscheidet `SuperadminGuard` — ein Gruppenrecht einer Organisation darf ' +
    'hier ausdrücklich nichts bewirken, sonst prüfte (und beträte) wer eine ' +
    'Organisation verwaltet den Mailserver der ganzen Installation; das ist ' +
    'dieselbe Grenze, die `SystemSettingsController` für Lesen und Schreiben ' +
    'dieser Zeile zieht. Der Tenant-Wächter hängt nur deshalb daran, weil ' +
    '`mail_log.tenant_id` NOT NULL ist: der Scope sagt, in wessen ' +
    'Versandprotokoll der Versuch abgelegt wird, nicht welcher Block ' +
    "angewählt wird — den nennt der feste Wert `'system'` im Controller. " +
    'Seit Review-Runde 3 Nr. 12 ist es der **optionale** Wächter: ohne ' +
    'Organisation geht die Mail trotzdem hinaus, dann eben ohne ' +
    'Protokollzeile. Die Route bleibt deshalb in dieser Liste — sie stellt ' +
    'weiterhin einen Bereich her, wenn es einen gibt. ' +
    'Ein `@RequirePermission` hier wäre die falsche Frage an die falsche ' +
    'Ebene und würde die Route für einen Superadmin sperren, dessen ' +
    'Mitgliedschaft das Recht nicht trägt.',
};

/**
 * `TenantScopeGuard`-guarded routes without `@RequirePermission`, minus the
 * ones {@link JUSTIFIED_EXCEPTIONS} names — the guard's whole predicate, and
 * shared between the real application and the throwaway probe below so both
 * are judged the same way.
 */
function offendersAmong(routes: readonly RoutePermission[]): string[] {
  return routes
    .filter((route) => route.guardedByTenantScope)
    .filter((route) => route.requirement === undefined)
    .map((route) => `${route.method} ${route.path}`)
    .filter((key) => !(key in JUSTIFIED_EXCEPTIONS));
}

/**
 * The pathological route the reproduction needs: a handler behind
 * `TenantScopeGuard` — the one guard {@link routePermissions} looks for to
 * decide „Organisation-gebunden" — carrying no `@RequirePermission` and named
 * nowhere in {@link JUSTIFIED_EXCEPTIONS}.
 *
 * `TenantScopeGuard` alone, not the full `SessionGuard, TenantScopeGuard`
 * chain a real controller uses: this probe is never sent a request (only
 * walked by {@link routePermissions}, which reads metadata off the class),
 * so `SessionGuard`'s own dependency chain would be extra machinery this
 * reproduction does not need to carry. What is under test is the *reading*,
 * not the chain's runtime behaviour — that half is `group-permission.guard.ts`'s
 * own suite.
 *
 * Registered on a throwaway application below and walked by the same reader
 * as the real one, so „a new unguarded route turns this red" is measured
 * rather than promised — the same technique `admin-routes.spec.ts` uses for
 * its own pathological probe.
 */
@Controller('tenant/probe')
@UseGuards(TenantScopeGuard)
class UnguardedProbeController {
  @Get()
  read(): Record<string, never> {
    return {};
  }
}

/**
 * The pathological route this exists to catch: a handler under a
 * {@link TENANT_BOUND_PREFIXES}-matching path (`/api/tenant/...`), guarded at
 * runtime by an **instance** of `TenantScopeGuard` rather than the class
 * `@UseGuards` ordinarily receives.
 *
 * `includesTenantScopeGuard` (`route-permissions.ts`) checks `guards.includes
 * (TenantScopeGuard)` — reference equality with the class — so this route
 * comes back `guardedByTenantScope: false` from {@link routePermissions}
 * even though it is, at runtime, exactly as tenant-scoped as one written the
 * ordinary way. Nothing here needs `TenantScopeFactory` to actually resolve
 * anything: this probe is never sent a request, only walked by
 * `routePermissions` and `routesOf`, so a stub argument is enough for the
 * instance to exist.
 */
@Controller('tenant/instance-guard-probe')
@UseGuards(new TenantScopeGuard({} as TenantScopeFactory))
class InstanceGuardedProbeController {
  @Get()
  read(): Record<string, never> {
    return {};
  }
}

describe('every tenant-scoped route decides about @RequirePermission', () => {
  let testApp: TestApp;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /**
   * The control that keeps the guard from being vacuous — the same role
   * `MINIMUM_ROUTES` plays in `registered-routes.ts`. If `routePermissions`
   * stopped seeing anything — a renamed metadata key, a Nest upgrade that
   * changes how `DiscoveryService` resolves controllers — this fails loudly
   * instead of the equality below passing about nothing.
   */
  it('finds a populated set of tenant-scoped routes', () => {
    const tenantScoped = routePermissions(app().app).filter(
      (route) => route.guardedByTenantScope,
    );
    expect(tenantScoped.length).toBeGreaterThanOrEqual(20);
  });

  it(
    'requires every tenant-scoped route to carry @RequirePermission, or to ' +
      'be named — with a reason — in the exception list',
    () => {
      const offenders = offendersAmong(routePermissions(app().app));
      expect(offenders).toStrictEqual([]);
    },
  );

  /**
   * The equality half: every name in {@link JUSTIFIED_EXCEPTIONS} still
   * refers to a route that (a) exists and (b) is still undecorated. A stale
   * entry — the route was deleted, or somebody added
   * `@RequirePermission` and forgot to remove the exception — is exactly as
   * wrong as a missing one, and this is what catches it (`toStrictEqual`,
   * not `toContain`, on both directions at once via set equality).
   */
  it('carries no stale entry in the exception list', () => {
    const routes = routePermissions(app().app);
    const liveUndecoratedKeys = new Set(
      routes
        .filter((route) => route.guardedByTenantScope)
        .filter((route) => route.requirement === undefined)
        .map((route) => `${route.method} ${route.path}`),
    );

    expect(Object.keys(JUSTIFIED_EXCEPTIONS).sort()).toStrictEqual(
      [...liveUndecoratedKeys].sort(),
    );
  });

  /**
   * **The reproduction, run rather than described.** A second application,
   * one controller, behind the same guard chain a real tenant-scoped
   * controller uses and with no `@RequirePermission` anywhere on it — walked
   * by the same reader and judged by the same predicate as the shipped
   * application. Reverting the fix (dropping a `@RequirePermission` from any
   * real controller, or striking an entry from {@link JUSTIFIED_EXCEPTIONS})
   * is exactly this failure, reached a different way; this test is the one
   * that shows the failure is real rather than merely plausible.
   */
  it('turns red for a tenant-scoped route with no @RequirePermission and no justification', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UnguardedProbeController],
      // A stub, never invoked: no request reaches this probe, but Nest's
      // route registration resolves every guard class named in
      // `@UseGuards` as a provider while it builds the pipeline, whether or
      // not a request ever exercises it.
      providers: [{ provide: TenantScopeFactory, useValue: {} }],
    }).compile();
    const probe = moduleRef.createNestApplication();
    probe.setGlobalPrefix(GLOBAL_API_PREFIX);
    await probe.init();

    try {
      expect(offendersAmong(routePermissions(probe))).toStrictEqual([
        'GET /api/tenant/probe',
      ]);
    } finally {
      await probe.close();
    }
  });

  /**
   * **The promised counter-check itself** (review finding):
   * every route Express actually serves under `TENANT_BOUND_PREFIXES` has to
   * come back `guardedByTenantScope: true` from {@link routePermissions}, or
   * this file's whole predicate is judging the wrong set of routes to begin
   * with — quietly narrower than „every tenant-scoped route", which is what
   * the describe block's own title claims.
   */
  it(
    'sees guardedByTenantScope agree with Express for every route under the ' +
      'tenant-bound prefixes',
    () => {
      const missing = tenantBoundRoutesMissingTenantScopeGuard(
        registeredRoutes(app()),
        routePermissions(app().app),
        // **The union of both sources** (a review finding): the list by hand
        // is the *intention* (if somebody takes the guard off the controller,
        // its prefix stays here and the routes under it turn red), the
        // derivation is the *reality* (a new controller is covered from its
        // first line). Taking only one of the two loses one half of the
        // finding each.
        [...TENANT_BOUND_PREFIXES, ...tenantBoundPrefixes(app().app)],
      );
      expect(missing).toStrictEqual([]);
    },
  );

  /**
   * **The derived set covers the list by hand** (a review finding).
   *
   * `TENANT_BOUND_PREFIXES` is thereby no longer a definition but an
   * assurance: if somebody takes `TenantScopeGuard` off the `FormsController`,
   * `/api/forms` drops out of the derived set — and **this** case turns red,
   * while the check above it would stay green (it only checks what was
   * derived, after all).
   *
   * What is compared are **routes, not strings**. `/api/tenant/` is a prefix
   * over several controllers (`/api/tenant/branding`, `/api/tenant/users`, …)
   * and stands in no derivation itself — a string comparison would have turned
   * red here and would have meant nothing.
   */
  it('deckt jede Route, die Liste von Hand erfasste', () => {
    const routes = registeredRoutes(app());
    const derived = tenantBoundPrefixes(app().app);

    const under = (prefixes: readonly string[]): Set<string> =>
      new Set(
        routes
          .filter((route) =>
            prefixes.some((prefix) => route.path.startsWith(prefix)),
          )
          .map((route) => `${route.method} ${route.path}`),
      );

    const byHand = under(TENANT_BOUND_PREFIXES);
    const byDerivation = under(derived);

    // Floor: an empty set would be equal on both sides.
    expect(byHand.size).toBeGreaterThan(20);

    expect(
      [...byHand].filter((key) => !byDerivation.has(key)),
      'Die Liste von Hand erfasst Routen, die kein Controller mit ' +
        'TenantScopeGuard trägt — entweder fehlt der Guard, oder die Liste ' +
        'nennt ein Präfix, das es nicht mehr gibt.',
    ).toStrictEqual([]);

    expect(
      [...byDerivation].filter((key) => !byHand.has(key)),
      'Ein Controller trägt TenantScopeGuard, sein Präfix fehlt aber in ' +
        'TENANT_BOUND_PREFIXES — genau die Lücke, die dieser Test gefunden hat ' +
        '(vier von neun). Eine Zeile dort ist die Antwort.',
    ).toStrictEqual([]);
  });

  /**
   * **And it covers more** — exactly the five the list by hand was missing (a
   * review finding). Without this case „abgeleitet" would be a claim: a
   * derivation that happened to find the same four would pass the check above
   * just as well.
   */
  it('deckt die fünf Präfixe, die der Liste von Hand fehlten', () => {
    const derived = tenantBoundPrefixes(app().app);

    expect(derived).toEqual(
      expect.arrayContaining([
        '/api/forms',
        '/api/mail-log',
        '/api/groups',
        '/api/form-templates',
      ]),
    );
    // The fifth carries a guard of its own in addition (`AiFeatureGuard`) and
    // is therefore named separately instead of hidden in the list above.
    expect(derived).toContain('/api/ai');
  });

  /**
   * **The reproduction of the counter-check, run rather than described.** A
   * tenant-bound route guarded by an *instance* of `TenantScopeGuard` instead
   * of the class: `offendersAmong` never sees it — it needs neither
   * `@RequirePermission` nor a {@link JUSTIFIED_EXCEPTIONS} entry, because
   * `routePermissions` never reports it as tenant-scoped in the first place —
   * and the `>= 20` floor above does not notice either, because every other
   * tenant-scoped route in the shipped application is still guarded the
   * ordinary way. Only the check above catches it, by asking Express instead
   * of the Discovery walk whether the route is there at all.
   */
  it('turns red when a tenant-bound route trades the TenantScopeGuard class for an instance', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InstanceGuardedProbeController],
    }).compile();
    const probe = moduleRef.createNestApplication();
    probe.setGlobalPrefix(GLOBAL_API_PREFIX);
    await probe.init();

    try {
      expect(
        tenantBoundRoutesMissingTenantScopeGuard(
          routesOf(probe),
          routePermissions(probe),
        ),
      ).toStrictEqual(['GET /api/tenant/instance-guard-probe']);
    } finally {
      await probe.close();
    }
  });
});
