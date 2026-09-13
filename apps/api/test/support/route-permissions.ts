import type { INestApplication } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';

import {
  REQUIRED_PERMISSION,
  type PermissionRequirement,
} from '../../src/tenancy/require-permission.decorator';
import { GLOBAL_API_PREFIX } from '../../src/app.module';
import { OptionalTenantScopeGuard } from '../../src/tenancy/optional-tenant-scope.guard';
import { TenantScopeGuard } from '../../src/tenancy/tenant-scope.guard';
import {
  TENANT_BOUND_PREFIXES,
  type RegisteredRoute,
} from './registered-routes';

/**
 * Whether a registered route carries `@RequirePermission`/`@RequireAnyPermission`/
 * `@RequireAllPermissions` — read off the **handler function's own metadata**,
 * the same object `SetMetadata` writes to and the same object
 * `GroupPermissionGuard`/`FormRestrictionGuard` read from at request time
 * (the requirement says: „eine Route ohne `@RequirePermission` ist eine Entscheidung,
 * kein Versehen").
 *
 * ## Why this reconstructs paths instead of reading them off Express
 *
 * `registered-routes.ts` walks Express's own router for good reason — a
 * *list* of intended paths would stay green for a route nobody added to it.
 * That reasoning is about **which paths exist**, and does not apply here:
 * this file is not asked whether a path exists, only what decorates the
 * handler Nest already resolved for it. Express's compiled middleware chain
 * does not expose that handler as a function `Reflect` can read metadata off
 * — the original `descriptor.value` the decorators wrote to is closed over,
 * not attached to what Express calls. Nest's own `DiscoveryService` is the
 * only way to the function `SetMetadata` actually touched.
 *
 * The path this module computes is therefore checked, not trusted, for the
 * one property `route-permission-guard.spec.ts` actually leans on:
 * {@link tenantBoundRoutesMissingTenantScopeGuard} cross-references this
 * module's own `guardedByTenantScope` against the paths Express itself
 * serves under {@link TENANT_BOUND_PREFIXES} (`registeredRoutes()`) — every
 * one of those has to come back `guardedByTenantScope: true` here, or it is
 * reported by name. That check exists because `includesTenantScopeGuard`
 * below is a **reference** check against the `TenantScopeGuard` class: a
 * route that traded the class for an instance, a subclass, or a
 * differently-named guard that happens to resolve a tenant would drop out of
 * `guardedByTenantScope` silently otherwise — needing neither
 * `@RequirePermission` nor an entry in that spec's exception list, and the
 * `>= 20` floor in `registered-routes.ts` would not notice, because the
 * other, still correctly guarded routes keep the total well above it on
 * their own (a review finding).
 */

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

/** One HTTP handler Nest resolved, with the permission metadata on it (or none). */
export interface RoutePermission {
  readonly method: string;
  /** `/api/...`, joined and normalised the same way `RoutePathFactory` does. */
  readonly path: string;
  readonly requirement: PermissionRequirement | undefined;
  /**
   * Whether `TenantScopeGuard` runs on this route — at the controller or at
   * the method (`@UseGuards` merges both, exactly as Nest does when it builds
   * the chain it actually runs). This is what „tenant-bound" means for
   * `route-permission-guard.spec.ts`: not a literal URL prefix, but „this
   * route resolves and operates on the **active** tenant" — the same first link
   * `CONTRIBUTING.md` names (*tenant scope → group permissions →
   * form restriction*). A route with no `TenantScopeGuard` has no
   * membership to check a permission against in the first place — asking it
   * to justify the absence of `@RequirePermission` would be asking the wrong
   * question of the wrong route.
   */
  readonly guardedByTenantScope: boolean;
}

/**
 * Whether `guards` (as `@UseGuards` stores them) resolves a tenant scope.
 *
 * **Zwei Klassen, nicht eine** (Review-Runde 3 Nr. 12): seit die Testmail der
 * Systemverwaltung auch ohne Organisation geht, gibt es einen zweiten
 * Wächter, der denselben Bereich aus derselben Quelle herstellt und nur die
 * Absage weglässt (`OptionalTenantScopeGuard`). Eine Route mit ihm ist genauso
 * mandantengebunden wie eine mit dem anderen — sie **kann** auf den Daten
 * einer Organisation arbeiten —, und sie hier auszulassen hieße, sie aus dem
 * Blickfeld dieses Wächters fallen zu lassen: sie bräuchte dann weder ein
 * `@RequirePermission` noch einen Eintrag in der Ausnahmeliste, und niemand
 * würde es merken. Genau die Lücke, gegen die diese Datei gebaut ist.
 */
function includesTenantScopeGuard(guards: unknown): boolean {
  return (
    Array.isArray(guards) &&
    (guards.includes(TenantScopeGuard) ||
      guards.includes(OptionalTenantScopeGuard))
  );
}

function stripEndSlash(path: string): string {
  return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
}

function addLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** `stripEndSlash(a) + addLeadingSlash(b)` — `RoutePathFactory.concatPaths`. */
function joinSegment(base: string, fragment: string): string {
  return stripEndSlash(base) + addLeadingSlash(fragment);
}

/**
 * A controller or method path as Nest's own decorators store it — always a
 * `string` in this application (no controller or route here takes the array
 * form `@Controller(['a', 'b'])`). Thrown rather than silently picking the
 * first entry, so a route that *did* start using the array form is a loud
 * failure here instead of a route this walker quietly stopped seeing.
 */
function stringPathOf(value: unknown, where: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(
    `Expected a single string path at ${where}, got ${JSON.stringify(value)} ` +
      "— this reader only handles the string form Nest's path decorators take.",
  );
}

/**
 * Every HTTP handler Nest's module graph knows about, with its permission
 * requirement (or `undefined` for none) and the full `/api/...` path.
 *
 * `DiscoveryService` is constructed directly off `ModulesContainer` rather
 * than resolved through the application's own DI container
 * (`app.get(DiscoveryService)`): `DiscoveryModule` is not imported into
 * `AppModule` — there is no production reason for the shipped application to
 * carry it — and a test should not have to change the module graph it is
 * testing in order to look at it.
 */
export function routePermissions(app: INestApplication): RoutePermission[] {
  const modulesContainer = app.get(ModulesContainer, { strict: false });
  const discovery = new DiscoveryService(modulesContainer);

  const routes: RoutePermission[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype;
    const instance: unknown = wrapper.instance;
    if (metatype === null || instance === null || instance === undefined) {
      continue;
    }

    const controllerPath = stringPathOf(
      Reflect.getMetadata(PATH_METADATA, metatype),
      `controller ${metatype.name}`,
    );

    const prototype = Object.getPrototypeOf(instance) as object;
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === 'constructor') {
        continue;
      }
      const handler: unknown = (instance as Record<string, unknown>)[
        methodName
      ];
      if (typeof handler !== 'function') {
        continue;
      }
      const methodPathRaw: unknown = Reflect.getMetadata(
        PATH_METADATA,
        handler,
      );
      const requestMethodRaw: unknown = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      );
      const requestMethod =
        typeof requestMethodRaw === 'number' ? requestMethodRaw : undefined;
      if (methodPathRaw === undefined || requestMethod === undefined) {
        // Not an HTTP handler — a helper method on the controller class.
        continue;
      }
      const methodPath = stringPathOf(
        methodPathRaw,
        `${metatype.name}.${methodName}`,
      );

      const path = stripEndSlash(
        addLeadingSlash(
          joinSegment(
            joinSegment(`/${GLOBAL_API_PREFIX}`, controllerPath),
            methodPath,
          ),
        ),
      );
      const method = METHOD_NAMES[requestMethod];
      if (method === undefined) {
        throw new Error(
          `Unknown RequestMethod ${String(requestMethod)} on ` +
            `${metatype.name}.${methodName} — teach METHOD_NAMES about it.`,
        );
      }

      // `REQUIRED_PERMISSION`'s shape is fixed by `require-permission.decorator.ts`
      // (`SetMetadata`, applied by this application's own decorators) rather
      // than by anything a request sent, so a cast is the reader's job here —
      // not a `PermissionRequirement` schema this test module would have to
      // invent a second copy of.
      const requirement = Reflect.getMetadata(REQUIRED_PERMISSION, handler) as
        PermissionRequirement | undefined;

      // Controller-level `@UseGuards` **or** method-level — either is enough
      // to put `TenantScopeGuard` into the chain this handler actually runs
      // behind, the same "either place" `GUARDS_METADATA` allows.
      const guardedByTenantScope =
        includesTenantScopeGuard(
          Reflect.getMetadata(GUARDS_METADATA, metatype),
        ) ||
        includesTenantScopeGuard(Reflect.getMetadata(GUARDS_METADATA, handler));

      routes.push({ method, path, requirement, guardedByTenantScope });
    }
  }
  return routes;
}

/**
 * **The tenant-bound prefixes, derived from the controllers instead of maintained**
 * (a review finding).
 *
 * ## What the finding was
 *
 * {@link TENANT_BOUND_PREFIXES} was a **list by hand** and covered four of
 * nine prefixes: `'/api/forms/'` **with** the slash left `GET /api/forms`
 * out, and `/api/mail-log`, `/api/groups`, `/api/form-templates` and
 * `/api/ai` were missing entirely. No open hole — all five controllers carried
 * the guard —, but **nothing held the state**: the check below is a
 * superset check, and a set that is too narrow cannot make it red.
 * A list whose incompleteness has no consequences does not get maintained.
 *
 * ## What it is derived from now
 *
 * From the same source out of which the application builds its chain: the
 * `@UseGuards` **at the controller**. If a controller carries `TenantScopeGuard`,
 * its path is tenant-bound — and every route below it must carry the guard.
 * A new controller is thereby covered from its first line, without
 * anybody touching a list.
 *
 * ⚠️ **Method-level guards deliberately do not count here.** A prefix is a
 * statement about *all* routes below it; a guard at a single method
 * says nothing about its neighbours. The route itself is untouched by that — it
 * still counts as tenant-bound in {@link routePermissions}.
 */
export function tenantBoundPrefixes(app: INestApplication): string[] {
  const modulesContainer = app.get(ModulesContainer, { strict: false });
  const discovery = new DiscoveryService(modulesContainer);

  const prefixes = new Set<string>();
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype;
    if (metatype === null) {
      continue;
    }
    if (
      !includesTenantScopeGuard(Reflect.getMetadata(GUARDS_METADATA, metatype))
    ) {
      continue;
    }
    const controllerPath = stringPathOf(
      Reflect.getMetadata(PATH_METADATA, metatype),
      `controller ${metatype.name}`,
    );
    prefixes.add(
      stripEndSlash(
        addLeadingSlash(joinSegment(`/${GLOBAL_API_PREFIX}`, controllerPath)),
      ),
    );
  }
  return [...prefixes].sort();
}

/**
 * Every Express-registered route under {@link TENANT_BOUND_PREFIXES} that
 * this module's own Discovery walk ({@link routePermissions}) does not also
 * report as `guardedByTenantScope: true` — the counter-check the doc atop
 * this file promises (a review finding).
 *
 * `includesTenantScopeGuard` is a reference check against the
 * `TenantScopeGuard` **class**. A route whose `@UseGuards` names an
 * *instance* of it, a subclass, or an unrelated guard that happens to resolve
 * a tenant is therefore invisible to `routePermissions`'s
 * `guardedByTenantScope` — it needs no `@RequirePermission` and no entry in
 * `route-permission-guard.spec.ts`'s exception list to pass that spec's own
 * equality, because that spec never considers it tenant-scoped to begin with.
 * `registered-routes.ts` cannot be fooled the same way: it reads the paths
 * Express actually serves, independent of which guard class decorates the
 * handler. Comparing the two sets — every Express path under the two
 * tenant-bound prefixes against this module's own `guardedByTenantScope`
 * set — is what turns that silent loss into a failing assertion instead of a
 * route the `>= 20` floor cannot tell is missing.
 *
 * Keys are `"METHOD /path"`, matching {@link routePermissions}'s own paths —
 * Nest and Express are built from the same path strings, so the two line up
 * without a second normalisation step.
 */
export function tenantBoundRoutesMissingTenantScopeGuard(
  registered: readonly RegisteredRoute[],
  discovered: readonly RoutePermission[],
  /**
   * The prefixes against which is checked — since a review **derived**
   * ({@link tenantBoundPrefixes}) instead of maintained. The default value stays the
   * list by hand, so that every existing caller measures unchanged what it
   * measured before; whoever passes the derived set measures more.
   */
  prefixes: readonly string[] = TENANT_BOUND_PREFIXES,
): string[] {
  const guardedKeys = new Set(
    discovered
      .filter((route) => route.guardedByTenantScope)
      .map((route) => `${route.method} ${route.path}`),
  );
  return registered
    .filter((route) => prefixes.some((prefix) => route.path.startsWith(prefix)))
    .map((route) => `${route.method} ${route.path}`)
    .filter((key) => !guardedKeys.has(key));
}
