import { z } from 'zod';

import { tenantCreateSchema, tenantFirstAdminSchema } from './tenant-admin.ts';

/**
 * Wire contract of the **first-time setup** (ADR-0022) — `GET /api/setup` and
 * `POST /api/setup`.
 *
 * The one route of this application that creates a **superadministrator**
 * without anybody having signed in. It exists exactly as long as the
 * installation has **zero rows in `user`**; after that it answers like a route
 * that does not exist. The whole reason is the one an operator otherwise
 * cannot resolve at all: the seed is a tool of development
 * (`apps/api/prisma/seed.ts` refuses under `NODE_ENV=production` with the
 * default passwords), and the second documented way was hand work in the
 * database — „but the user does not sign in to the DB".
 *
 * ## Two things that deliberately do **not** stand here
 *
 * 1. **No field for `isSuperadmin`.** Neither in the request nor anywhere
 *    else: that this one place produces a superadministrator is a property of
 *    the server, not a statement of the caller. `tenantCreateSchema` makes the
 *    same decision for „+ Neue Organisation", and `admin.repository.ts` writes
 *    the column there field by field, so that it cannot travel along out of a
 *    payload. The exception is the route, not the schema.
 * 2. **No answer with content.** `POST /api/setup` answers **204**, without a
 *    body — there is therefore no response schema here. No session token, no
 *    identifier, no name. Whoever has set up then signs in perfectly normally,
 *    and that the credentials just set do work is thereby proven right away.
 */

/**
 * What `GET /api/setup` answers — **a boolean, and nothing else.**
 *
 * ## Why this is no disclosure
 *
 * „No information about whether the installation is already set up that goes
 * beyond what the sign-in page gives away anyway" — that is exactly what this
 * field is measured against. The start page of a not-yet-set-up installation
 * **shows** the setup instead of the sign-in; whoever calls the address
 * therefore sees the answer regardless of whether this route exists. It is
 * thereby the same statement in machine-readable form, not an additional one.
 *
 * What it explicitly does **not** carry: no number (how many accounts,
 * organisations, forms), no name, no address, no hint at a configuration.
 * „There is somebody already" and „there is nobody yet" are the two only
 * states of this answer.
 *
 * The field name says „is setup necessary" and not „are there users": the
 * question of the interface is the first one, and the second would be
 * information about the data holdings that happens to have the same answer
 * today.
 */
export const setupStateSchema = z.strictObject({
  setupRequired: z.boolean(),
});
export type SetupState = z.infer<typeof setupStateSchema>;

export function parseSetupState(source: unknown): SetupState {
  return setupStateSchema.parse(source);
}

/**
 * What `POST /api/setup` takes in: the first superadministrator and —
 * **skippable** — a first organisation.
 *
 * ## Both halves are derived from `tenantCreateSchema`, not copied out
 *
 * `admin` is literally the block that „+ Neue Organisation" already uses
 * (address normalised and bounded, name bounded, password between
 * `PASSWORD_MIN` and `PASSWORD_HASH_INPUT_MAX`), and `tenant` are the two
 * identity fields of the same form. Two spellings of the same rule would be
 * exactly the sort of duplication where later the one half is stricter than
 * the other — and with a password minimum „the other" simply means „weaker".
 * That the rule for the **first** account is the same as for every further one
 * is the statement here, not the frugality.
 *
 * ## `tenant: null` means „skipped", and that is a valid end state
 *
 * A superadministrator **without a membership** is permitted, and the data
 * model carries it by itself: `user` has no `tenant_id`, and `SuperadminGuard`
 * runs without `TenantScopeGuard`. Whoever wants to just operate an
 * installation for now and create the organisations later should not have to
 * buy that with a throwaway organisation.
 *
 * The field is therefore **`nullable`, not `optional`**: skipping is a
 * decision that stands in the document, not a forgotten key. A caller who
 * simply left `tenant` out would never have said what they wanted.
 */
export const setupRequestSchema = z.strictObject({
  // `tenantFirstAdminSchema` and not `tenantCreateSchema.shape.admin`: there
  // the block has been `nullable` since review finding 7 („myself"), and that
  // makes no sense here — at the first-time setup nobody is signed in who
  // could be meant. It is the same block, only without that one freedom.
  admin: tenantFirstAdminSchema,
  tenant: tenantCreateSchema.pick({ shortName: true, name: true }).nullable(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;
