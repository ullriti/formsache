import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';

import {
  INSTANCE_MAIL_FROM,
  configureInstanceMailServer,
  expectDashboard,
  expectLoginView,
  signIn,
  submitLogin,
} from './app-flows';
import { instanceMailPort } from './instance-mail';
import {
  authStateFile,
  seedTenantAdmin,
  tenantAdminStateFile,
} from './seed-account';

/**
 * Signs in **once per identity** and parks the browser state for the specs.
 *
 * The reason is the rate limit on `POST /api/auth/login`: ten attempts per
 * minute and IP, and every project of this suite calls it from the same
 * loopback address (`apps/api/src/auth/login-rate-limit.ts`). Letting each
 * layout test sign in for itself would spend the whole bucket on setup and
 * turn a rerun into a 429 — which looks exactly like a broken login.
 *
 * **The budget, counted rather than remembered**: these two, the
 * two `auth-flow` runs (one per viewport, each of which must really go through
 * the form), the rejected password in `login-rejection`, the member login in
 * `tenant-switch` — which cannot reuse a parked state, because what matters here is
 * what the *login* of a two-membership account produces —, the organisation-Admin of
 * `system-settings`, who must be seen being refused *and* logging out, and the
 * person `tenant-admin` creates for itself, whose whole subject is a right
 * being taken away from a session that is already open — and, since 2026-08-20,
 * the `editor` of Musterstadt in `publish-legal-hint`. **Nine of ten.**
 *
 * That ninth one is the case the sentence below always meant to allow: it does
 * not merely need *a* session, it needs the one identity no parked state can
 * be — `can_build` **without** `can_manage_settings`, the permission pair the
 * hint before publishing is split along (ADR-0028, open item 3). Both states
 * parked here are `admin` groups and hold every permission there is, so under
 * either of them that case would be green for the wrong reason.
 *
 * Nine is not two runs' worth, and it was not five runs' worth before either:
 * a second `pnpm e2e` inside the same minute exceeds the bucket, and
 * `submitLogin` reports that as a budget problem of the run rather than as a
 * login defect. If a tenth login is ever needed, the limit is not the thing to
 * raise — a spec that merely needs *a* session takes one of the two states
 * parked here.
 *
 * The specs that consume a parked state never log out — a logout would revoke
 * the shared session under everyone else running in parallel. The flows that
 * *do* log out sign in for themselves.
 */
setup(
  'sign in once, store the superadmin session and give the installation its mail server',
  async ({ page }) => {
    await signIn(page);

    mkdirSync(dirname(authStateFile), { recursive: true });
    await page.context().storageState({ path: authStateFile });

    /*
     * **And the mail server of the instance** (ADR-0024).
     *
     * Since 2026-08-18 no account comes into being without an invitation and
     * no invitation without it: `POST /admin/members` and „+ Neuer
     * Tenant" otherwise answer 422 and create **nothing**. Every file that
     * creates a person would thereby hang on a precondition that the seed
     * does not set.
     *
     * It is entered here and not per file, because `system_setting` is an
     * installation-wide single row and `playwright.config.ts` runs
     * `fullyParallel` — three files of the same project writing it to
     * three ports would be a race. The whole reasoning, including the
     * reason for the *one* catch-all server, stands in `e2e/instance-mail.ts`.
     *
     * A real recipient and not a dead port: the invitation must really be
     * delivered, otherwise there is no link a run could open.
     *
     * **Not in a `setup` of its own**: that would need a second sign-in
     * out of the budget of ten, or a parked session that only comes into
     * being at this moment. Here the session lies open already.
     *
     * The two acceptance runs afterwards enter their *own* mail server
     * and measure by it which server received what — they deliberately
     * overwrite this entry and restore it at the end.
     */
    await configureInstanceMailServer(page, {
      port: instanceMailPort(),
      from: INSTANCE_MAIL_FROM,
    });
  },
);

/**
 * The second identity: `admin` of Musterstadt, explicitly **not** the superadmin.
 *
 * Its organisation is the one that has never saved its form standards, which is what
 * the requirements need to be observable at all (see the note in
 * `system-settings.spec.ts`), and it is an organisation whose colours, groups and
 * members the suite may change without touching the Dachorganisation every other spec runs
 * under.
 */
setup(
  'sign in once and store the organisation-Admin session',
  async ({ page }) => {
    await page.goto('/');
    await expectLoginView(page);

    const status = await submitLogin(page, seedTenantAdmin);
    expect(
      status,
      'Login with the seeded Organisation-Admin must succeed. A 401 here usually means ' +
        'the database was seeded earlier with a different ' +
        'SEED_TENANT_ADMIN_PASSWORD — the seed deliberately does not reset an ' +
        'existing password.',
    ).toBe(200);
    await expectDashboard(page);

    mkdirSync(dirname(tenantAdminStateFile), { recursive: true });
    await page.context().storageState({ path: tenantAdminStateFile });
  },
);
