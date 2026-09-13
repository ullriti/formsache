import { defineConfig, devices } from '@playwright/test';

import { apiBaseUrl, isCi, webBaseUrl } from './e2e/env';

/**
 * The two viewports the suite measures in. They are **projects**, not
 * `setViewportSize` calls inside a test, so the report says which width proved
 * what — "mobile-360x740 › kein horizontaler Scrollbalken" is evidence, a
 * green run of one project named `chromium` is not.
 */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const MOBILE_VIEWPORT = { width: 360, height: 740 } as const;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? 'github' : 'list',
  // Migration and seed before the first test — a login against an unseeded
  // database would fail for a reason that has nothing to do with the app.
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: webBaseUrl,
    // Locally `retries` is 0, so `on-first-retry` would never produce anything
    // for the run that actually failed. Kept on failure instead.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // One login for the whole suite; see `auth.setup.ts` for the rate-limit
      // arithmetic behind that.
      name: 'setup',
      testMatch: /\/auth\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
    {
      // Smoke coverage: the app is served, the API dev path answers. Runs
      // signed out and needs no session.
      name: 'smoke',
      // `smoke-suite-coverage` is the guard that every spec file below is
      // claimed by some project. It runs here because it needs neither a
      // session nor a database, so an unclaimed file fails the run in its
      // first seconds instead of after the slow projects — and it had to be
      // named into this list like everything else, which is the point.
      // `a11y-view-list` belongs here for exactly the same reason as
      // `smoke-suite-coverage` above it: it reads the source of the router and
      // counts it against the checklist of the axe run — no browser, no
      // session, no database. A forgotten view therefore shows up in the first
      // seconds and not only after the axe run of both widths has walked past
      // it green.
      // `mobile-click-guard` belongs here for the same
      // reason: it reads the source of the mobile specs and looks for
      // `setChecked` — no browser, no session, no database. A case that
      // resorts to it again shows up in the first seconds instead of only
      // then, when a dead zone should have found it.
      testMatch:
        /\/(smoke|smoke-suite-coverage|api-dev|a11y-view-list|mobile-click-guard)\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop-1280x800',
      // `tenant-switch` runs here only, not in both viewports: it signs in for
      // itself (what a login produces is the point here), and a second run would
      // spend another attempt of the rate-limit budget on a flow whose mobile
      // half is already covered by `shell-mobile`.
      // `builder-drag` carries its own mobile block via `test.use`, so it runs
      // in this project only — the drag it proves is the same code in both
      // viewports, and running it twice would double the slowest spec of the
      // suite for no additional evidence.
      // `core-flow` likewise: it writes a form, a published version and a
      // response into the shared database, and running the same chain twice
      // would double that residue without proving anything the desktop run
      // does not. Its public half opens its own session-less context, whose
      // viewport is therefore independent of this project anyway.
      // `public-form-rows` for the same reason, and one more: it measures both
      // viewports itself, in two session-less contexts, so the project's own
      // width decides nothing it asserts.
      // `tenant-form-defaults` runs here **only**, and that is a correctness
      // requirement rather than a budget one: it writes to the organisation's shared
      // standards row and puts the original value back afterwards. With
      // `fullyParallel` and two projects, two workers would edit the same row,
      // one would take the 409 of the optimistic lock, and the restore would
      // write back an „original" that never was. `form-settings` next door
      // touches only its own forms and therefore runs in both.
      // `public-form-settings` runs here alone for the
      // same reason as `core-flow`: each of its cases writes a form, a
      // published version and — in the confirmation cases — a response, and
      // nothing it asserts is a measurement of width. Its public half opens
      // its own session-less context anyway, so this project's viewport
      // decides nothing about it.
      // `public-form-password` runs here alone for the same
      // reason: each of its cases writes a form and a published version, its
      // public half opens its own session-less context, and nothing it asserts
      // is a measurement of width.
      // The `\/` is load-bearing since `public-form-settings` joined the list:
      // without it the alternative `form-settings` matches that file too, as a
      // substring, and the mobile project below would pick it up as well.
      // `response-edit` runs here only, for the same reason
      // as `core-flow`: it writes a form, a published version and a response
      // into the shared database, and nothing it asserts is a measurement of
      // width — the edit view is the fill-in view, whose responsive half is
      // already covered by `public-form-rows`.
      // `notifications` runs here **only** and carries
      // its own mobile block via `test.use`, exactly like `builder-drag`: its
      // desktop cases write forms, published versions and notifications, and
      // none of them is a measurement of width. The one case that *is* — the
      // „Aktuelles Formular" section of the off-canvas sheet — sets its own
      // 360 px viewport inside the file, where the reason for the width stands
      // next to the assertion.
      // `mail-log` likewise runs here alone, and for
      // `core-flow`'s reason: one chain of form, version, response and two
      // `mail_log` rows, whose public half opens its own session-less context
      // anyway. Running it twice would double that residue and prove nothing
      // the desktop run does not.
      // `system-settings` runs here **only**, and for the
      // same reason as `tenant-form-defaults` one layer up: it writes to the
      // installation-wide `system_setting` singleton and restores it
      // afterwards, so a second worker touching the same row at the same time
      // is a correctness bug, not a budget one. Its own mobile case sets a
      // 360 px viewport inside the file, exactly like `builder-drag` and
      // `notifications`.
      // `tenant-admin` runs here **only**, and
      // that is correctness rather than budget, exactly like
      // `tenant-form-defaults`: every case writes shared state of one organisation —
      // its branding row, its groups, its members — and a second worker
      // repainting the same header or editing the same group would take the
      // 409 of the optimistic lock and then restore an „original" that never
      // was. Nothing it asserts is a measurement of width; its public half
      // opens session-less contexts of its own anyway.
      // `superadmin-overview` likewise: it creates a organisation, which is
      // installation-wide residue, and its assertions are about which controls
      // a row offers rather than about a viewport.
      // `form-members` (the draft half) runs here alone because it
      // writes two forms and drives the router's `popstate` path; the width
      // decides nothing it measures.
      // The `\/` is load-bearing for `form-members`: without it the
      // alternative would also match `tenant-form-defaults` — and, the other
      // way round, `tenant-admin` must not swallow `tenant-admin`-shaped names
      // that belong elsewhere. Check any addition with
      // `npx playwright test --list`.
      // `tenant-mail` runs here **only**,
      // for the same correctness reason as `tenant-admin` next to it: every
      // case writes `tenant.smtp` of Musterstadt, and a second worker mid-save
      // on that same column would make the „System" case's final assertion
      // measure whichever run finished last. Nothing it asserts is a
      // measurement of width.
      // `public-form-honeypot` runs here alone, for the same
      // reason as `public-form-password` next to it: each of its cases writes a
      // form and a published version into the shared database, its public half
      // opens its own session-less context, and nothing it asserts is a
      // measurement of width — a decoy of zero size is zero pixels wide at 360
      // and at 1280 alike. The `\/` matters here as elsewhere: without it,
      // `public-form-rows` and `public-form-settings` would not be told apart
      // from a hypothetical `…-honeypot-rows`.
      // `question-types` runs here alone: it writes a
      // form, a published version and a response per case, its public half
      // opens its own session-less context, and nothing it asserts is a
      // measurement of width. Its touch half is `question-types-mobile`, a
      // separate file rather than a shared one, exactly as `shell-mobile`
      // stands apart from `shell-desktop` — the alternation below would
      // otherwise pick up `question-types-mobile.spec.ts` too, since the
      // group requires the alternative to be immediately followed by
      // `\.spec\.ts$` and `-mobile` sits in between, it does not.
      // `conditional-logic` runs here **and** carries its
      // own 360 px block via `test.use`, exactly like `builder-drag` and
      // `notifications` next to it: every case writes its own form, none of
      // it is a measurement of width beyond the one block that already sets
      // its own viewport, and doubling the desktop cases in the mobile
      // project would prove nothing the 360 px block does not already show.
      // `trash` runs here alone: its round-trip case
      // deletes and restores one form via the real API/route, leaving no
      // residue beyond the ordinary `newForm` kind every other spec already
      // accepts, and its 409 case drives `page.route` rather
      // than a viewport — nothing it asserts is a measurement of width. The
      // touch/mobile half is `trash-mobile`, its own file for the same
      // reason `question-types-mobile` is: a shared file would need the
      // `-mobile` alternative excluded from this pattern instead.
      // `dashboard-delete` (the surface side: „× Löschen")
      // runs here for the same reasons as `trash`: a real round trip through
      // one form this spec creates and restores, no width measurement in it.
      // `trash-purge` likewise — its one real case deletes
      // only a form it created itself, and its „Papierkorb leeren" case is
      // `page.route`-mocked on purpose (see the file's own docblock): the
      // real route would empty the *whole* Organisation's trash, which this
      // parallel project shares with `trash` and `dashboard-delete`.
      // `preview-test-mode` runs here **and**
      // carries its own 360 px block via `test.use`, exactly like
      // `builder-drag`, `notifications` and `conditional-logic`: both of its
      // cases write a form (the desktop one additionally a published version,
      // a notification, one real answer and one `mail_log` row), and each
      // purges its own form again. Running the file twice would double that
      // chain without proving anything the 360 px block does not — and that
      // block is the one place where the width decides something, because
      // below 1180 px the subheader this file clicks does not exist at all.
      // `superadmin-deleted-tenants` runs here alone too:
      // every mutating request it makes is intercepted (its own docblock —
      // the only row it could otherwise reach is the seeded Dachorganisation tenant this
      // whole suite depends on), so nothing here is a measurement of width
      // either. Its mobile half is `superadmin-deleted-tenants-mobile`.
      // `a11y` is one of the few files that runs in **both**
      // width projects, and that is the whole point of it: the requirement says
      // „Desktop und 360 px", so the report has to name the width that proved
      // each view — „mobile-360x740 › Dashboard" is evidence, one green
      // project is not.
      //
      // Its `beforeAll` builds one form, publishes it, submits an answer and
      // parks a draft, so it does write; `test.describe.configure({ mode:
      // 'default' })` inside the file keeps that at **one** chain per project
      // instead of one per worker, and its `afterAll` purges the form again
      // (`DELETE /api/forms/:id` then `…/permanent`, the sequence
      // `preview-test-mode` uses). What is left after a run is the answer's
      // and the draft's rows going with the form, and nothing Organisation-wide — it
      // touches no shared singleton, so unlike `tenant-admin` or
      // `system-settings` it may run beside everything else.
      //
      // The `\/` and the trailing `\.spec\.ts$` are load-bearing as
      // everywhere else in this list: they are what keeps this alternative
      // from also matching `a11y-view-list.spec.ts`, which belongs to `smoke`
      // and must not run twice per width — it reads a file and counts, and a
      // second viewport would decide nothing about it.
      //
      // **The following four files** run here, and they run
      // here **alone** — none of them is a statement about width:
      //
      // - `announcements` measures live regions and accessible
      //   descriptions. A `role="status"` region has no pixel size.
      // - `keyboard-flow` drives the core flow exclusively with
      //   `keyboard.press`. The mobile half — off-canvas sheet and
      //   properties sheet — sets its 360 px **inside the file** via
      //   `test.use`, the way `builder-drag` and `notifications` do it: there
      //   the reason for the width stands next to the assertion, and a second
      //   project would double the slow desktop half.
      // - `rendered-contrast` reads computed colours out of the browser.
      //   Contrast is a property of the colour, not of the viewport; for that
      //   the file builds one form under each of **two** organisations and
      //   clears both away again.
      // - `reduced-motion` sets `prefers-reduced-motion: reduce` via
      //   a `test.use` of its own and measures computed transition durations.
      //
      // All four write only their own forms and delete them physically
      // again; none of them touches an installation- or organisation-wide
      // singleton, so they may run beside everything else.
      //
      // **`betroffenenauskunft` runs here and only here.** The path
      // of an information request — search, read the detail, export, delete,
      // delete physically — is not a statement about width, and a second run
      // would be a second download together with a second log line without
      // additional evidence. The file builds its own form, fills it in publicly
      // once and clears exactly that one response away physically again; it
      // touches no organisation- or installation-wide singleton.
      //
      // **`publish-legal-hint` runs here alone**, and the reason is the shared
      // row rather than the width: both of its cases read the state of
      // Musterstadt's `tenant.legal_pages` through the publish preview, and
      // that row must stay `NULL` for them to mean anything — the same empty
      // state `mobile-targets`'s open item and `confirmPublishNotice` measure.
      // It therefore writes nothing to it, restores nothing and may run beside
      // everything that leaves it alone as well; what it must not do is run
      // twice, because the second run would be a second pair of forms in that
      // organisation for evidence the first already carries. Which sentence a
      // permission produces is no statement about width either — the hint says
      // the same words at 360 px.
      //
      // Since 2026-08-20 the file carries a **360 px block of its own** via
      // `test.use`, exactly like `builder-drag`, `notifications`,
      // `conditional-logic` and `preview-test-mode` above: the one thing about
      // this dialog that *is* a statement about width — whether the two hint
      // boxes fit the narrow column and whether the centre of each control
      // still belongs to that control — brings its own viewport, so the reason
      // for the width stands next to the assertion. Claiming the whole file
      // for the mobile project instead would run its three desktop cases a
      // second time, which is two more forms and a second login out of a
      // bucket at nine of ten.
      //
      // It signs in for **one** of its two identities: the seed's `editor` of
      // Musterstadt is the only account that publishes and may not read the
      // legal texts, and no parked session can stand in for it. That is the
      // ninth login of the bucket, counted in `auth.setup.ts`.
      testMatch:
        /\/(auth-flow|login-rejection|shell-desktop|tenant-switch|builder-drag|core-flow|public-form-rows|public-form-settings|public-form-password|public-form-honeypot|response-edit|form-settings|form-members|tenant-form-defaults|tenant-admin|tenant-mail|superadmin-overview|notifications|mail-log|system-settings|question-types|conditional-logic|trash|dashboard-delete|trash-purge|betroffenenauskunft|superadmin-deleted-tenants|preview-test-mode|publish-legal-hint|announcements|keyboard-flow|skip-link|rendered-contrast|reduced-motion|card-spacing|a11y)\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
    {
      name: 'mobile-360x740',
      // `form-settings` runs here as well: what is required is the proof
      // „im Desktop- **und** im Mobil-Projekt (360 px)", and the single-column
      // layout is only a measurement when something measures it at 360 px.
      // `\/`-anchored, see the desktop project: an unanchored `form-settings`
      // also matches `public-form-settings.spec.ts`, which belongs to desktop
      // alone.
      //
      // `tenant-admin-mobile`, `superadmin-overview-mobile`,
      // `form-members-mobile`, `tenant-mail-mobile` and
      // `system-mail-settings-mobile` (the requirement) are the mobile half
      // of five views that ran on desktop width only — the fourth of four
      // small rests left behind, deferred and then forgotten. Each is its **own** file rather
      // than its desktop sibling added here: `tenant-admin.spec.ts`,
      // `tenant-mail.spec.ts` and `system-settings.spec.ts` (the `mail` tab)
      // all run `mode: 'serial'` against shared installation- or Organisation-wide
      // rows, and `fullyParallel` would run that serial suite a second time,
      // concurrently, against the very row each says must not see two
      // workers at once; `superadmin-overview.spec.ts` creates one organisation per
      // run that nothing deletes, so a second project would double that
      // residue — the same accumulation rate that used to put `durchlauf-organisationen`
      // behind an opt-in, before that file got its own cleanup; this
      // one is still open and unrelated. And `form-members.spec.ts`'s
      // one case is specifically about an in-app route change, which a
      // duplicate run would not add evidence for. Each new file's own docblock
      // gives its reason in full; none of the five writes anything at all
      // beyond `form-members-mobile`'s own form.
      //
      // `question-types-mobile` is the touch half of
      // `question-types`: filling Matrix and Tabelle with `.tap()` under real
      // CDP touch input, and the one claim that only exists at 360 px — both
      // grids scroll inside their own `.field__scroll`/`.q-preview__scroll`
      // container instead of the page. A separate file, not a case added to
      // the desktop one, for the same reason `shell-mobile` stands apart from
      // `shell-desktop`.
      //
      // `trash-mobile` is the same split again: reachability
      // through the off-canvas sheet, the no-overflow measurement, and one
      // `.tap()` on „Wiederherstellen" — served entirely through `page.route`,
      // so it writes nothing real and adds no residue of its own, the same
      // zero-residue shape `superadmin-overview-mobile` settled on and
      // explains in full.
      //
      // `superadmin-deleted-tenants-mobile` is the same
      // split again for the new section: reachability through the off-canvas
      // sheet, the no-overflow measurement, one `.tap()` on
      // „Wiederherstellen" — `page.route`-served throughout, zero residue.
      //
      // `responses-mobile` and `mail-log-mobile` close
      // the last of the four small gaps: both views had
      // **no** 360 px assertion, and both carry a box with
      // `overflow: auto`. That is the reason why they were not simply added to
      // the call list of `expectNoHorizontalScroll`: that helper
      // expressly excludes scrolling boxes, so for the two
      // tables it would be green whether they hand their content out or cut it
      // off. Both files call it for the **frame** of the view and
      // `expectSideScrollerReachable` beside it for the table — the second
      // measurement is the one that can go red there at all.
      //
      // `mail-log-mobile` is `page.route`-served like `trash-mobile`: no
      // residue, and a guaranteed wide table. `responses-mobile` on the other
      // hand builds a real form, because the width of the responses table comes
      // from the form — it leaves behind the ordinary `newForm` kind that
      // `core-flow` and `mail-log` leave behind in the desktop project as well,
      // and its own file says so at the top.
      //
      // `a11y` is the second half of „Desktop **und** 360
      // px" — the same file as in the desktop project above, deliberately, and
      // the reasoning for both halves stands there.
      //
      // `mobile-reachable` and `mobile-paths` are
      // the area beside the individual cases. Both run **only** here,
      // because both are a statement about 360 px: the one drives every view
      // from `a11y/views.ts` and measures width and touch target, the other
      // the new paths from 0.1, A, B, C and D through the mobile navigation.
      // `mobile-reachable` builds the same one form as `a11y` (its own
      // preparation, see `mobile/fixture.ts`) and clears it away again;
      // `mobile-paths` is `page.route`-served apart from one form setup of its
      // own. `mobile-targets` measures rendered box sizes and
      // writes nothing. `card-spacing` runs in **both** widths and writes
      // nothing either: it measures the vertical gaps of the session-less
      // cards (sign-in, password link, invitation), and 360 px is the width at
      // which a missing `gap` hurts most.
      testMatch:
        /\/(auth-flow|shell-mobile|form-settings|tenant-admin-mobile|superadmin-overview-mobile|form-members-mobile|tenant-mail-mobile|system-mail-settings-mobile|question-types-mobile|trash-mobile|superadmin-deleted-tenants-mobile|responses-mobile|mail-log-mobile|mobile-reachable|mobile-switches|mobile-paths|mobile-targets|card-spacing|a11y)\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: MOBILE_VIEWPORT,
        hasTouch: true,
      },
    },
    {
      // A whole walk through the application, not a unit of coverage.
      //
      // **No longer opt-in.** It used to be excluded from the default
      // run and only reachable through a second script, because each pass left
      // two organisations behind and nothing could delete one — against a fresh database
      // the suite was green twice in a row, but at roughly seven accumulated
      // Organisationen it started failing, in two *different* specs, which is what
      // shared residue looks like from the outside. A way got built
      // to delete a organisation (`DELETE /api/admin/tenants/:id`), and the
      // file's own `afterAll` now uses it on both of the organisations it created —
      // including when an earlier Schritt of the same run failed, which is
      // exactly the run that most needed the cleanup. The reason to keep it
      // out of the everyday run is gone with the residue.
      //
      // **It is still its own project, and that project still depends on
      // every other one — this half never had anything to do with residue.**
      // The file writes the installation-wide `system_setting` singleton
      // (mail server, base address, form standards) and re-scopes the
      // *shared* superadmin session — `PUT /api/session/tenant` writes the
      // session row, so every context using the parked cookie moves with it.
      // Both are global state, so it may not run beside anything, on any
      // project. Playwright has no „exclusive" flag; what it has is project
      // dependencies, and naming the other four here makes this one start
      // only after all of them have finished — it is therefore last and
      // alone, which a merge into an existing project's `testMatch` could not
      // give it: `fullyParallel` would then let it race the very specs whose
      // shared session and singleton it rewrites.
      //
      // **There is exactly one entry point.** `pnpm e2e` names this project as
      // its fifth `--project`, and there is no second script beside it: a
      // second entry point would only be a way for the two to disagree.
      name: 'durchlauf-organisationen',
      testMatch: /\/durchlauf-organisationen\.spec\.ts$/,
      dependencies: ['setup', 'smoke', 'desktop-1280x800', 'mobile-360x740'],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
    {
      // The second whole walk, built after the pattern of `durchlauf-organisationen` above
      // and for its reasons.
      //
      // **Its own project, and last of all**, on the same two grounds that one
      // states: it writes the installation-wide `system_setting` singleton (the
      // Basis-Adresse, cleared and re-typed through the surface so that
      // `SEED_PUBLIC_BASE_URL` decides nothing about this run) and it re-scopes
      // the **shared** superadmin session through `PUT /api/session/tenant`,
      // which writes the session row every context using the parked cookie
      // reads. Neither may happen beside another spec.
      //
      // `durchlauf-organisationen` is named among its dependencies as well, so the two the acceptance run
      // runs never overlap: both rewrite that same singleton and that same
      // session, and „last and alone" has to mean last of everything.
      //
      // **Residue per run, measured on 2026-08-05 after a full `pnpm e2e`:**
      // one soft-deleted Organisation — the `tenant` row with `deleted_at`, its four
      // `group` rows, the one membership of the superadmin who created it, and
      // its sealed OIDC client secret — plus four `mail_log` rows, all four
      // with recipient, subject and body blanked (the delivery
      // record stays, the person does not). The Superadmin-Übersicht offers no
      // permanent delete for a organisation (only *Wiederherstellen*), so all
      // of that leaves with the 30-day retention and not with the run.
      // Everything else this run creates — forms, answers, drafts, templates,
      // files, the SSO account — lives inside that one organisation and is physically
      // gone when `afterAll` finishes: it deletes the template, empties the
      // trash, takes the SSO person out through *Person entfernen*
      // (which deletes their account) and then **measures** what
      // is left over the routes belonging to the tables it touched.
      //
      // That measurement is the part that was missing. Until a review caught
      // it, the only closing assertion was "the count of **live** organisations is what it
      // was before" — and this comment said "none by construction" on the
      // strength of it. Measured after a **green** run: both forms, two
      // answers carrying names and addresses, four `mail_log` rows, all still
      // there. A count of live organisations cannot see any of that; the assertion in
      // `durchlauf-funktionsumfang.spec.ts` now does.
      name: 'durchlauf-funktionsumfang',
      testMatch: /\/durchlauf-funktionsumfang\.spec\.ts$/,
      dependencies: [
        'setup',
        'smoke',
        'desktop-1280x800',
        'mobile-360x740',
        'durchlauf-organisationen',
      ],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
    {
      // The third whole walk, built after the pattern of the two above and for
      // their reasons.
      //
      // **Its own project, and last of all**, but on a *different* ground than
      // its two predecessors: this run touches no installation-wide singleton
      // and creates no organisation. What it needs to be alone for is **Schritt 8**,
      // which pages through the organisation's shared form list and asserts that page
      // two shows other cards than page one — a spec creating or deleting a
      // form beside it would reshuffle exactly the list under measurement.
      // It also fills the list up to the page size on purpose, which every
      // dashboard assertion elsewhere would then have to live with.
      //
      // `durchlauf-organisationen` and `durchlauf-funktionsumfang` are named among its dependencies as well,
      // so the three the acceptance run runs never overlap: both of those rewrite the
      // installation's Basis-Adresse and re-scope the shared superadmin
      // session, and „last and alone" has to mean last of everything.
      //
      // **Residue per run: none by measurement, not by assumption.** Unlike
      // `durchlauf-funktionsumfang` this file works inside the seeded Organisation and marks every
      // form it creates with its own stamp; its `afterAll` puts all of them in
      // the trash, deletes each **physically** (which takes the
      // attachment's bytes and the person in `mail_log` with it) and then
      // measures — forms, trash, templates, `mail_log`, the attachment's
      // own address, the draft's token, members, live organisations and the AI quota
      // route — against one object. The measurement is what decides;
      // the reason it exists in this shape is written at the top of the spec.
      name: 'durchlauf-ki-und-export',
      testMatch: /\/durchlauf-ki-und-export\.spec\.ts$/,
      dependencies: [
        'setup',
        'smoke',
        'desktop-1280x800',
        'mobile-360x740',
        'durchlauf-organisationen',
        'durchlauf-funktionsumfang',
      ],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
    {
      /*
        **The first-time setup, and therefore last of all and alone.**

        This project **empties the database** (`reset-data`) in order to produce
        the one state nobody else can reach: an
        installation without a single account. `global-setup.ts` seeds before
        every run, and from there on `setupRequired` is `false` for the whole
        suite — the assistant from ADR-0022 was represented in the axe
        checklist with **Schritt 1** until 2026-08-18 and beyond that was
        driven by no case at all.

        Emptying invalidates every parked session. It therefore depends on
        **all** the remaining projects and only begins once nobody else wants
        anything from the database any more — the same construction and the same
        reason as with the three `durchlauf-*` projects above, only one step
        later.

        Its `afterAll` restores the initial state immediately
        (`reset-data` + `seed`). Were it to break off before that, the next
        `global-setup` run would set it up again anyway — the restoration is
        courtesy towards the next human being, not a precondition of the
        next run.
      */
      name: 'durchlauf-erstinbetriebnahme',
      testMatch: /\/durchlauf-erstinbetriebnahme\.spec\.ts$/,
      dependencies: [
        'setup',
        'smoke',
        'desktop-1280x800',
        'mobile-360x740',
        'durchlauf-organisationen',
        'durchlauf-funktionsumfang',
        'durchlauf-ki-und-export',
      ],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT },
    },
  ],
  // Both resolution paths of @formsache/shared are exercised here (ADR-0007):
  // the web app is served from the *built* ESM artifact, the API runs through
  // the *dev* transformer. Servers are only started when nothing is already
  // listening, so the suite also runs against a running local stack.
  webServer: [
    {
      // Builds first, so `pnpm e2e` works on a fresh clone without a prior
      // `pnpm -r build`.
      command: 'pnpm -r build && pnpm --filter @formsache/web preview',
      url: webBaseUrl,
      reuseExistingServer: !isCi,
      // Five minutes, because this budget covers a **cold** build of the whole
      // workspace, not just the server start: `prisma generate`, two `tsc`
      // passes and `vite build`. Locally that is seconds — `dist/` is usually
      // warm — and on a fresh CI runner it took just over the three minutes
      // this used to allow. The failure reads "Timed out waiting 180000ms from
      // config.webServer", which says nothing about the build being the slow
      // part. The CI job additionally builds beforehand, so in practice only
      // the incremental rebuild happens here.
      timeout: 300_000,
      // Server output goes to the terminal instead of being swallowed. A
      // server that fails to start otherwise produces exactly one line —
      // "Timed out waiting … from config.webServer" — which says that
      // *something* did not answer and nothing about what.
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Guards the dev path: esbuild-based loaders cannot emit the decorator
      // metadata NestJS needs for constructor injection, and the failure is
      // invisible at boot — it only shows up as a 500 per request.
      command: 'pnpm --filter @formsache/api dev',
      url: `${apiBaseUrl}/api/health`,
      reuseExistingServer: !isCi,
      // Starts in a second or two, but it starts *while* the build above is
      // saturating the runner's two cores.
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
