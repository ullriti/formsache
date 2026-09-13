import type { INestApplication } from '@nestjs/common';
import { expect } from 'vitest';
import { z } from 'zod';

import type { TestApp } from './create-test-app';

/**
 * Every route the **running application** actually serves — read off Express's
 * own router, not off a list somebody maintains.
 *
 * That distinction is the whole value of this file. A curated list of paths
 * would be a second piece of documentation: it stays green for the path nobody
 * added it to, which is precisely the path a guard is supposed to catch. What
 * is walked here is the table Nest handed to Express when the module graph was
 * assembled, so a controller added next year is in it because it exists.
 *
 * The shape is Express-specific and that is accepted: the alternative — Nest's
 * `DiscoveryService` plus `PATH_METADATA` reflection — reconstructs what Nest
 * *intended* to register, and „intended" is one indirection away from „serves".
 * The parsing below fails loudly rather than degrading, so a future Express
 * that renames `router.stack` turns the guards red instead of vacuous.
 */

/** One registered route: an upper-case method and the full path, `/api` included. */
export interface RegisteredRoute {
  readonly method: string;
  /** As Express holds it, with parameters as `:name` segments. */
  readonly path: string;
}

/**
 * The router layers, parsed rather than cast.
 *
 * `passthrough()` on the layer, because most layers are middleware and carry no
 * `route` at all — those are dropped, not rejected.
 */
const layerSchema = z.object({
  route: z
    .object({
      path: z.string(),
      methods: z.record(z.string(), z.boolean()),
    })
    .optional(),
});

const stackSchema = z.array(layerSchema);

/**
 * One property of something that may or may not have properties.
 *
 * `Reflect.get` rather than a cast, and it earns its place: an Express 5 router
 * is a **function** with a `stack`, so neither `z.object` nor a
 * `Record<string, unknown>` assertion reaches it — the first refuses a
 * function, and the second is the kind of claim this file exists not to make.
 */
function propertyOf(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined;
  }
  return Reflect.get(value, key);
}

/**
 * A floor under {@link registeredRoutes}, so an empty walk cannot pass for a
 * clean one.
 *
 * The application serves dozens of routes; anything close to zero means the
 * reader stopped working, and a guard over an empty list is green about
 * nothing. The number is deliberately far below the real count — this is a
 * tripwire, not an inventory that has to be maintained.
 */
const MINIMUM_ROUTES = 20;

/**
 * What {@link registeredRoutes} walks — the same reader, without the floor.
 *
 * Separate because a guard is only worth what its own reproduction is worth,
 * and that reproduction boots an application with **one** route in it (see
 * „registers no route …" in `test/admin/admin-routes.spec.ts`). The floor
 * exists for the shipped application and would turn a deliberate one-route
 * probe into a failure about nothing. Every caller that walks the real
 * application uses {@link registeredRoutes} instead.
 */
export function routesOf(app: INestApplication): RegisteredRoute[] {
  const instance: unknown = app.getHttpAdapter().getInstance();
  const stack = propertyOf(propertyOf(instance, 'router'), 'stack');
  const parsed = stackSchema.safeParse(stack);
  if (!parsed.success) {
    throw new Error(
      'Express no longer exposes `app.router.stack`; the route guards of ' +
        'the requirement would silently pass. Fix the reader, do not delete it.',
    );
  }

  return parsed.data.flatMap((layer) => {
    const route = layer.route;
    if (route === undefined) {
      return [];
    }
    return Object.entries(route.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => ({ method: method.toUpperCase(), path: route.path }));
  });
}

/** The routes of the **shipped** application, with the floor above applied. */
export function registeredRoutes(app: TestApp): RegisteredRoute[] {
  const routes = routesOf(app.app);
  expect(routes.length).toBeGreaterThanOrEqual(MINIMUM_ROUTES);
  return routes;
}

/**
 * The prefixes whose tenant boundary **is** the absence of a `:tenantId`
 * parameter — shared between `admin/admin-routes.spec.ts`
 * (the boundary itself) and `admin/route-permission-guard.spec.ts` (that every
 * route under it decides, rather than forgets, its own permission), the
 * latter by way of `route-permissions.ts`'s
 * `tenantBoundRoutesMissingTenantScopeGuard`, which is built on this same
 * constant rather than a copy of it. One array rather than two, so „welche
 * Präfixe sind Organisation-gebunden" cannot answer differently in the two guards
 * that both ask it.
 *
 * See `admin-routes.spec.ts`'s own doc on the constant for why it stops here
 * and does not reach `/api/admin/` or `/api/auth/oidc/start/:tenantId` — both
 * legitimately name an organisation in the path, which is the opposite promise.
 *
 * `/api/responses/` is the third entry, added later: the attachment
 * download addresses a **file**, names no organisation, and reads
 * through the `TenantScope` the chain builds. Listing it is what makes „diese
 * Route ist Organisation-gebunden" a property the guards check rather than a sentence
 * in a controller comment — and it is deliberately `/api/responses/`, not
 * `/api/public/responses/`, which is the sessionless path and has no scope.
 *
 * `/api/trash` is the fourth, added later, and it is the entry **without**
 * a trailing slash on purpose: the trash of the active Organisation is one route at
 * exactly that path, and its whole tenant boundary is that there is no way to
 * name another organisation's — the requirement's fourth proof. A route added under it
 * later („leeren", „endgültig löschen") is covered by the same prefix,
 * which is the point of listing it now rather than when it grows.
 */
export const TENANT_BOUND_PREFIXES = [
  '/api/tenant/',
  // **Without a trailing slash since a review finding.** `'/api/forms/'` left
  // `GET /api/forms` and `POST /api/forms` out — the form list and the
  // creation, that is, two of the most organisation-bound routes there are.
  '/api/forms',
  '/api/responses/',
  '/api/trash',
  // The four that a review named as missing. They have all carried the guard
  // since they came into being; what was missing was the watcher over them.
  // That this list is today not narrower than reality is checked by
  // `tenantBoundPrefixes()` in `route-permissions.ts` — the derivation from the
  // controllers, against which this list has been held ever since.
  '/api/mail-log',
  '/api/groups',
  '/api/form-templates',
  '/api/ai',
  // The test mail at system level (finding 29a). It lies under `/api/admin/`,
  // where nothing else carries a tenant scope — and carries one anyway, because
  // its evidence is a `mail_log` row and that belongs to an organisation.
  // The scope decides **only** the filing there, not the selected
  // block; `system-test-mail.controller.ts` spells that out. Exactly that path
  // and not `/api/admin/`: the read and write routes of the
  // system settings next to it are deliberately scope-free, and a prefix that
  // took them along would claim the opposite.
  //
  // ⚠️ **Seit Review-Runde 3 Nr. 12 mit dem *optionalen* Wächter**: die Route
  // lässt jetzt auch ohne Organisation durch und protokolliert dann nicht.
  // Sie bleibt hier stehen, und das ist keine Nachlässigkeit — sie stellt
  // weiterhin einen Bereich her, wenn es einen gibt, und
  // `includesTenantScopeGuard` (`route-permissions.ts`) kennt seit derselben
  // Runde beide Klassen.
  '/api/admin/system-settings/mail/test',
];
