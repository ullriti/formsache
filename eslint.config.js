// Flat ESLint config for the whole monorepo.
// There is exactly one entry point, `pnpm lint` at the root: it covers the
// three workspaces plus e2e/ and the root config files. A per-workspace script
// would silently leave those last two unchecked.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { formsachePlugin } from './tools/eslint-rules/index.js';

/**
 * `@formsache/test-idp` is test infrastructure, and `apps/api/src/**` is the runtime.
 *
 * The package is a `devDependency` of `@formsache/api`, so an import of it from
 * `src/` is the classic „runtime import of a dev dependency": it works on every
 * developer machine and dies in the container, where `pnpm deploy --prod`
 * leaves it out. What makes this one worse than the usual instance of that
 * family is that **no gate sees it** — `apps/api/tsconfig.json` maps
 * `@formsache/test-idp` to the package source for the whole workspace, not only for
 * `test/`, so `pnpm typecheck` is green; `pnpm -r test` runs with the dev tree,
 * so it is green; and `pnpm -r build` compiles `src/` alone, so it is green
 * too. The first red thing would be a started image.
 *
 * The rule is spelled once and applied to every config object that sets
 * `no-restricted-imports` for a path under `apps/api/src/` — in flat config the
 * later object *replaces* the rule rather than adding to it, so a fence that
 * lived in only one of them would have a hole exactly where the other applies.
 */
const noTestIdpInApiRuntime = {
  group: ['@formsache/test-idp', '@formsache/test-idp/*'],
  message:
    '`@formsache/test-idp` is test infrastructure and a devDependency: it is absent from the runtime image, and importing it from apps/api/src/ passes typecheck, test and build before failing at container start. It belongs in apps/api/test/ (or e2e/).',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Only the design handoff is exempt — it is a verbatim copy of the
      // prototype, not our code (look and behaviour are adopted, the runtime
      // code is not). The rest of docs/ stays linted.
      'docs/specs/0001-formularsystem/design-handoff/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  js.configs.recommended,

  // Type-aware linting for all TypeScript sources. `projectService`
  // picks the nearest tsconfig.json per file, so config files that are listed
  // in a workspace tsconfig are covered as well.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` is not an escape hatch. Foreign data enters as `unknown`
      // and is parsed by a Zod schema.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // The design tokens are the single source for colours. A literal in a
  // component is invisible to the runtime tenant override, so it is an error
  // here — the token layer itself (`src/styles/tokens.css`) is CSS and is
  // covered by its own guard test instead.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    plugins: { formsache: formsachePlugin },
    rules: {
      'formsache/no-hardcoded-colors': 'error',
    },
  },

  // Hook correctness, found in review. Nothing enforced the Rules of
  // Hooks before this: `FieldInput.tsx` called `useId()` **behind** an early
  // `return` — harmless today only because every branch of that component
  // happens to call it the same number of times, which is exactly the kind
  // of invariant a linter should hold and a reviewer should not have to.
  //
  // Scoped to `apps/web/src/**`, the only place a hook can occur, and to two
  // rules rather than the plugin's own `recommended` preset. Since v7 that
  // preset also carries the React Compiler's speculative diagnostics
  // (`purity`, `refs`, `set-state-in-effect`, `set-state-in-render`,
  // `immutability`, `globals`, …), which assume a codebase written *for* the
  // compiler. Measured by pointing the full preset at `apps/web/src` once:
  // **12** pre-existing findings, none of them a hook-order bug —
  // `react-hooks/set-state-in-effect` (8×: `AppShell.tsx`, `AppHeader.tsx`,
  // `BuilderView.tsx`, `NotificationsView.tsx`, `NotificationEditor.tsx`,
  // `use-server-draft.ts`, `use-pointer-drag.ts` — a `setState` called
  // synchronously inside an effect, which is this codebase's ordinary
  // "sync local state from a prop/subscription on mount or change" pattern),
  // `react-hooks/refs` (3×: `PageList.tsx`, `QuestionCanvas.tsx`,
  // `BuilderView.tsx` — a ref read while rendering, inside the pointer-drag
  // machinery ADR-0002 asks this project to hand-build) and one real
  // `react-hooks/exhaustive-deps` (`use-focus-trap.ts`, a cleanup that reads
  // a ref value that may have changed by the time it runs — worth its own
  // look, but unrelated to this finding). Adopting the compiler bundle is a
  // separate decision with its own review of those twelve call sites, not a
  // side effect of closing this one. `rules-of-hooks` and `exhaustive-deps`
  // are the two rules that predate that bundling and are what this finding
  // is actually about; `exhaustive-deps` stays a warning, its long-standing
  // default, because a dependency array is sometimes deliberately
  // incomplete and a hard error would make every such case fight the linter
  // instead of being reviewed on its own terms.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Tests need colour fixtures — branding values to validate, and a literal
  // that proves the guard actually bites. They render nothing to a user, so
  // the rule would only be in the way here.
  //
  // `src/test/**` is included for the same reason: those modules are fixtures
  // and helpers, not UI. Without it a fixture has to smuggle its branding past
  // the rule (`brandColor('cea967')` did exactly that), which teaches the next
  // fixture to work around a linter instead of being covered by it.
  {
    files: [
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
      'apps/web/src/test/**/*.ts',
      'apps/web/src/test/**/*.tsx',
    ],
    rules: {
      'formsache/no-hardcoded-colors': 'off',
    },
  },

  // NestJS modules are decorator-only classes by design; the "extraneous
  // class" rule would otherwise reject every module.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowWithDecorator: true },
      ],
    },
  },

  // The base fence for the API runtime — see {@link noTestIdpInApiRuntime}.
  // **No `ignores`**: the two blocks below narrow their own subjects for
  // reasons of their own (which directory may hold Prisma, which may decrypt),
  // and neither of those reasons entitles a file to reach for the test
  // provider. `apps/api/src/auth/**` in particular is exempt from the Prisma
  // rule and is precisely where an OIDC import would be written.
  //
  // The two later blocks repeat this pattern instead of inheriting it, because
  // flat config replaces `no-restricted-imports` rather than merging it.
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noTestIdpInApiRuntime] }],
    },
  },

  // The tenant scope must come from the guard chain, never from a
  // caller-supplied parameter, and the design that delivers it works by
  // keeping an unscoped Prisma client out of reach:
  // `GroupsService` has no client in its constructor, `GroupsModule` imports no
  // database access, and the only way to a `group` row is the `TenantScope` the
  // guard hands in (`src/tenancy/tenant-scope.ts`).
  //
  // Nothing so far *enforced* that. A future feature module could simply import
  // `PrismaModule` and query without a tenant — and the difference between "a
  // reviewer notices" and "the build notices" is exactly what a security
  // boundary should not depend on. This rule makes it the build.
  //
  // The allow-list is the infrastructure that legitimately owns database
  // access: the Prisma module itself, the seed, the tenant scope, and the auth
  // module, whose queries deliberately precede any tenant scope (`user` and
  // `session` carry no `tenant_id` — see `schema.prisma`). A new entry here is
  // a decision to review, which is the point.
  //
  // `src/public/` is the fourth entry, and it is the one
  // worth pausing over: the public fill-in routes have **no session**, so
  // there is no membership to derive a `TenantScope` from — a participant is
  // not a member of anything. What binds those queries instead is the public
  // slug: 128 bits of CSPRNG, unique across the installation, and the form it
  // resolves to supplies its own `tenant_id` for the row that is written. The
  // tenant is therefore still never a parameter the caller controls, which is
  // the property this rule exists to protect. The reasoning is repeated at
  // `public/public-forms.service.ts`, where someone changing that code will
  // actually be looking.
  //
  // `src/mail/` is the fifth entry (ADR-0004). The mail
  // worker and the 90-day purge work **across tenants by design** — the queue
  // is an installation resource, not a organisation's datum — and claiming a row needs
  // `$queryRaw` for `SELECT … FOR UPDATE SKIP LOCKED`, which a `TenantScope`
  // cannot express and should not. There is no request behind either job, no
  // caller and no tenant parameter; the row selection is `status` and
  // `next_attempt_at`, never an input from outside.
  //
  // **That sentence stopped being the whole truth, and this is the
  // honest version.** „Testmail senden"  put a *request-facing* controller into this directory —
  // `test-mail.controller.ts`, behind a session and the full guard chain — so
  // „kein Request, kein Aufrufer" no longer covers everything the entry lets
  // through. Moving it to `src/tenant-admin/`, next to `smtp-config.controller.ts`
  // under the same path prefix, is the shape this list would prefer and is
  // deliberately left open rather than done half: that directory is off the
  // list, so the move only works once the write has a `TenantScope` delegate to
  // go through, and `mail_log` has none — the reading side of the
  // mail log owns `ScopedMailLogDelegate` and there is no existing row
  // for a testmail to be scoped to.
  //
  // Until then the entry covers a second, narrower case, and it is defensible
  // on its own terms rather than on the worker's:
  //
  //   1. **the tenant is never a caller's parameter.** `TestMailService` writes
  //      exactly one row and binds it to `scope.tenant.find()`'s own id — the
  //      Organisation of the session's membership, resolved by `TenantScopeGuard`. The
  //      route has no `:tenantId` and its request body is `strictObject({})`;
  //   2. **one table, one row, one direction.** It inserts into `mail_log` and
  //      updates that same row by primary key. It reads no other organisation's rows,
  //      and nothing it reads reaches a payload — the response carries the
  //      recipient the session already knows, a status and a category;
  //   3. **the counter-check still holds.** `src/mail-log/` stays off this
  //      list, so every *read* of the mail log keeps going through the
  //      one tenant boundary that table has.
  //
  // **The counter-check is what makes the entry defensible**, and it is why
  // `src/mail-log/` is deliberately *not* on this list: the reading side of the
  // mail log goes strictly through `ScopedMailLogDelegate`. Two
  // callers, two ways in — only that split gives the tenant-boundary test of
  // the mail log something to prove. A `MailLogService` that reached for the worker's
  // repository because it was within arm's length would be the regression every
  // test survives, and it would land on the one table whose *only* tenant
  // boundary is that delegate: `mail_log` carries no composite foreign key on
  // `(form_id, tenant_id)`, so unlike with `response` the database would not
  // catch a forgotten binding. The same
  // reasoning is repeated at `src/mail/mail.module.ts` and at the delegate
  // itself, where somebody changing that code will actually be looking.
  //
  // `src/system-settings/` is the sixth entry (ADR-0011).
  // `system_setting` is — after the queue side of `mail_log` — the second table
  // of this application that belongs to **no organisation**: it *is* the layer below
  // every organisation, so scoping it to one would be a contradiction rather than a
  // safeguard. Three properties make the entry defensible, and a change that
  // breaks any of them needs a new decision:
  //
  //   1. the table holds **exactly one row**, promised by `CHECK (id = 'x')`
  //      plus the primary key, so there is nothing to scope;
  //   2. **nothing from a request selects a row** — the id is a module constant
  //      in every query, and the only value a request contributes to a `where`
  //      is the expected revision of the write, which can make that
  //      write miss but cannot make it hit a different row;
  //   3. **the counter-check:** no domain path writes the row. Reading is done
  //      by the three settings readers, writing belongs to the
  //      superadmin-guarded system-settings route and to nothing else. The repository is provided inside
  //      `SystemSettingsModule` and deliberately **not** exported, so the only
  //      way in is a service with two read methods and one write behind that
  //      guard.
  //
  // **The directory gained a second, wider reader, and it is not
  // covered by the three properties above:** the reach counter
  // („Gilt sofort für N organisations und M Formulare") reads `tenant` and `form`
  // across the whole installation. It carries its argument in its own file,
  // `system-settings/settings-reach.repository.ts`, and the load-bearing part
  // is that **only numbers leave it** — it reduces the documents to eight
  // integers before anything else sees them, so a reader that cannot hand out a
  // row cannot leak one. Everything *fachlich* stays on the `TenantScope`; a
  // service that reached for that repository because it was within arm's length
  // would be the regression every test survives.
  //
  // The same block is repeated at `system-settings/system-settings.repository.ts`,
  // where somebody changing that code will actually be looking.
  //
  // `src/admin/` is the seventh entry: the guard-chain rule above and the
  // rule that a cross-tenant read must leak nothing of the tenant it touches.
  // It holds the superadmin overview, and its two reads are cross-tenant **by
  // definition**: „wie viele Organisationen, Formulare, Antworten und Nutzer
  // gibt es?" cannot be asked inside one organisation, and „lege eine
  // Organisation an" happens before there is a row a `TenantScope` could be
  // built from. That is the same category as the reach counter and the mail
  // worker's queue — the three cross-tenant readers this application admits to
  // having, and the list is meant to stay that short.
  //
  // Three properties make the entry defensible, and a change that breaks any of
  // them needs a new decision:
  //
  //   1. **only counters and identity leave.** `TENANT_OVERVIEW_SELECT` is an
  //      allow list and does not carry `form_defaults` — which holds a
  //      sealed access word — nor the OIDC issuer, client id or encrypted
  //      secret. A reader that never selects a secret cannot leak one;
  //   2. **nothing from a request selects a organisation** except the `:tenantId` of
  //      the detail route, and *that* is the point rather than a leak: the
  //      superadmin surface has to address a foreign Organisation,
  //      which is why it is a separate prefix instead of a parameter on
  //      `/api/tenant/…`;
  //   3. **the counter-check.** Everything *fachlich* about a organisation — users,
  //      groups, per-form restrictions, settings — stays strictly on the
  //      `TenantScope`, including the tenant administration in
  //      `src/tenant-admin/`, which is deliberately **not** on this list. An
  //      `AdminService` that read a organisation's users because Prisma was within
  //      arm's reach would be the regression every test survives.
  //
  // The same block is repeated at `admin/admin.repository.ts` and, shorter, at
  // `admin/admin.module.ts`.
  //
  // `src/common/public-url/` is the eighth entry. `PublicUrlService` reads
  // the installation's own address across every organisation
  // (`system_setting`, the sixth entry's table) and the one
  // column that belongs to a organisation, `tenant.public_base_url`. The read that
  // needs it cannot go through a `TenantScope` for the same reason the mail
  // worker cannot: the mail worker has no session behind it at all — that is
  // the whole point of this entry, spelled out in `public-url.service.ts`
  // — and the public submission path has a slug, not a membership. Two
  // properties make the entry defensible, the same shape as the fourth:
  //
  //   1. **the tenant id is never a caller's choice.** It arrives as
  //      `form.tenantId` (the form the caller is submitting against, resolved
  //      by its public slug) or as the organisation of the response row a worker just
  //      claimed by primary key — never as a parameter a request supplies on
  //      its own;
  //   2. **only one column leaves.** `TenantBaseUrlRepository` selects
  //      `public_base_url` and nothing else — no users, no groups, no
  //      `form_defaults`, no OIDC secret. A reader that cannot hand out
  //      anything but a string or `null` cannot leak a organisation's other data
  //      even if the id it was given were wrong.
  //
  // The same block is repeated at `common/public-url/tenant-base-url.repository.ts`,
  // where somebody changing that code will actually be looking.
  //
  // `src/files/purge/` is the ninth entry (ADR-0014 no. 15,
  // „Der öffentliche Pfad" Punkt 2, which foresees exactly this one). The purge
  // of orphaned attachments works **across tenants by design** — no request, no
  // caller, no tenant parameter — so there is no session to build a
  // `TenantScope` from in the first place. That is the reason, and it is the
  // same one the mail worker sits on this list for. (That the job also needs
  // `$queryRaw` for `SELECT … FOR UPDATE` is true and beside the point:
  // „needs raw SQL" is not a ticket onto this list.)
  //
  // Three properties make the entry defensible, and a change that breaks any of
  // them needs a new decision:
  //
  //   1. **only keys leave the query.** The `SELECT` reads `id` and nothing
  //      else — no `file_name`, no `public_ref`, no `answers`. A job that
  //      cannot read a payload cannot hand one out;
  //   2. **nothing from a request selects a row.** The predicate is `kind`,
  //      `response_id IS NULL` and `created_at`, all three of them the
  //      application's own columns;
  //   3. **the counter-check.** `apps/api/src/files/**` — the attachment
  //      retrieval of no. 11(b) — is deliberately **not** on this list and
  //      reads through the `TenantScope` delegate the guard chain hands in.
  //      That is why the entry is `files/purge/**` and not `files/**`, the
  //      same cut the eighth entry makes by being `common/public-url/**`
  //      rather than `common/**`.
  //
  // The same block is repeated at `files/purge/file-purge.service.ts`.
  //
  // `src/trash/purge/` is the tenth entry — the decision here is for it to
  // stand „im Diff, nicht im Bericht". The
  // 30-day purge of the trash has to find the due rows of **every** Organisation,
  // and a `TenantScope` is one organisation — so there is no scope to build the
  // enumeration on, exactly as with the two jobs above. On top of that it is
  // the one place that must reach a table with **no `tenant_id` at all**:
  // §10 no. 68 has it delete the accounts a purged Organisation leaves homeless, and
  // `user` can be reached by no scope and by no cascade.
  //
  // Four properties make the entry defensible, and a change that breaks any of
  // them needs a new decision:
  //
  //   1. **only keys leave the listings.** `id`, `tenant_id`, `form_id`,
  //      `user_id`, plus the `deleted_at` the run's cursor pages by — no title,
  //      no `answers`, no `email`, no `name`. A job that cannot read a payload
  //      cannot hand one out;
  //   2. **nothing from a request selects a row.** The predicate is
  //      `deleted_at` against a cut-off derived from the injected clock, and
  //      nothing else. There is no caller, no session and no parameter;
  //   3. **every deletion has exactly one definition.** organisations, forms and
  //      answers go through `PermanentDeletionService` — the session-free half
  //      of permanent deletion — with a scope minted from the id just listed, so „Bytes vor
  //      Zeilen" and „ist das fällig" keep exactly one answer; the account
  //      deletion is `tenancy/homeless-account.ts`, shared verbatim with
  //      „Person entfernen", so „wer wird nie gelöscht" keeps exactly one
  //      answer too.
  //
  //      **This point used to read „it deletes nothing itself", and that was
  //      false:** this module is what *runs*
  //      `user.deleteMany`, the most destructive statement of the package —
  //      once per candidate after a organisation is purged, and once more as a
  //      installation-wide reconciliation at the end of every run, which is
  //      what makes an interrupted run resumable. The entry has
  //      to be defensible with that said out loud, and the property that
  //      carries it is „one definition per deletion", not „no deletion";
  //   4. **the counter-check.** `apps/api/src/trash/**` — the trash routes
  //      an editor reaches — is deliberately **not** on this list and works
  //      strictly through the `TenantScope` the guard chain hands in. That is
  //      why the entry is `trash/purge/**` and not `trash/**`, the same cut the
  //      ninth entry makes by being `files/purge/**`.
  //
  // The same block is repeated at `trash/purge/retention-purge.service.ts`.
  //
  // `src/ai/purge/` is the eleventh entry (ADR-0015 no. 8, which names this path in the ADR itself). The 30-day purge of
  // the KI-Freitexte has to reach the due rows of **every** Organisation — no request,
  // no caller, no tenant parameter — so there is no session to build a
  // `TenantScope` from, the same reason the three jobs above sit here.
  //
  // Three properties make the entry defensible, and a change that breaks any of
  // them needs a new decision:
  //
  //   1. **nothing leaves the query at all.** The job runs a single `UPDATE`
  //      and reads back a **count**. It never selects `prompt`, so the one
  //      column this application declares personal cannot travel through the
  //      one component that is allowed to see every organisation's rows;
  //   2. **nothing from a request selects a row.** The predicate is
  //      `created_at` against a cut-off derived from the injected clock, plus
  //      „is there still a text" — the application's own columns and nothing
  //      else;
  //   3. **the counter-check.** `apps/api/src/ai/**` without `purge` — the
  //      AI usage counter and everything a route reaches — is deliberately **not**
  //      on this list and goes through `ScopedAiUsageDelegate`, i.e. the
  //      `TenantScope` the guard chain hands in. That is why the entry is
  //      `ai/purge/**` and not `ai/**`, the same cut the ninth and tenth
  //      entries make.
  //
  // The same block is repeated at `ai/purge/ai-prompt-purge.service.ts`.
  //
  // `src/setup/` is the twelfth entry (ADR-0022) — the
  // first-time setup, and the only one on this list that carries a route
  // **anybody** may call and that writes a row.
  //
  // The reason is the same as with the readiness and the job entry, only
  // sharper: there is no organisation here, because there is **nobody at
  // all**. A `TenantScope` arises from a membership, a membership from a
  // session, a session from an account — and that the table `user` is empty is
  // the precondition of these routes. A scope would have nothing to refer to.
  //
  // Four properties make the entry defensible, and whoever breaks one of them
  // needs a new decision:
  //
  //   1. **nothing out of a request selects a row.** The read query has no
  //      parameter („is there any user row at all"), the writing one only
  //      creates. There is no identifier a caller could name, and no
  //      `:tenantId` in the path;
  //   2. **nothing leaves the queries.** The one answer is a boolean, the
  //      other is empty (204). What is read are identifiers only — no
  //      address, no name, no number, no secret;
  //   3. **the condition stands in the same transaction as the write.**
  //      „There are zero rows in `user`" is checked behind an advisory lock and
  //      written in the same block (`setup/first-superadmin.ts`), so that two
  //      simultaneous requests do not create two superadministrators. A check
  //      *before* it would be a second place that looks the same and
  //      guarantees nothing;
  //   4. **the counter-check.** This directory has exactly two routes, and
  //      both stop existing as soon as the installation has a user. There is
  //      no method here that reads an organisation, a form or a response, and
  //      there must not be one. Whoever creates something here that answers a
  //      *set-up* installation is no longer building a first-time setup — and
  //      needs the way through a scope for it like everybody else.
  //
  // The same block stands in `setup/setup.service.ts`, where somebody who
  // changes this code actually looks.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/prisma/**',
      'apps/api/src/auth/**',
      'apps/api/src/tenancy/**',
      'apps/api/src/public/**',
      'apps/api/src/mail/**',
      'apps/api/src/system-settings/**',
      'apps/api/src/admin/**',
      'apps/api/src/common/public-url/**',
      'apps/api/src/files/purge/**',
      'apps/api/src/trash/purge/**',
      'apps/api/src/ai/purge/**',
      'apps/api/src/setup/**',
      // The readiness route (ADR-0016 §1). The entry is the
      // narrowest of this list and is to stay that way — it carries **one**
      // statement, `SELECT 1`, in `ReadinessService`.
      //
      // Three properties make it defensible, and whoever breaks one of them
      // needs a new decision:
      //   1. **there is no organisation here.** The question is not „may this
      //      tenant see this", but „can this *process* work" —
      //      a `TenantScope` would have nothing to refer to;
      //   2. **nothing leaves the query.** `SELECT 1` reads no column of a
      //      domain table; the answer of the route is a boolean;
      //   3. **nothing out of the request selects a row.** There is no
      //      parameter.
      // As soon as counting happens here (queue, storage, runs), that belongs
      // **not** in this module but in the operations status behind the
      // superadmin guard — if only because an outside observer
      // calls this route 1 440 times a day.
      'apps/api/src/health/**',
      // The bookkeeping over the background runs (ADR-0016 §2).
      //
      // `job_run` is **no** domain table: it has no `tenant_id`, and that is
      // no omission but the assurance. The five runs it keeps the books on
      // work across all organisations (for exactly that reason they stand on
      // this list themselves already); a row that recorded *whose* data a
      // clean-up run deleted would be the opposite of what the run exists
      // for.
      //
      // Three properties make the entry defensible:
      //   1. **there is no organisation whose boundary would have to be
      //      kept.** A `TenantScope` would have nothing to refer to — what is
      //      counted are runs, not data;
      //   2. **nothing out of a request selects a row.** Writing happens from
      //      a scheduler, reading takes the most recent row per kind of run;
      //   3. **the row carries no persons and no names** — kind, points in
      //      time, a number and the **error class**, never the message
      //      . A test measures exactly that.
      'apps/api/src/observability/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // Repeated, not inherited: this object replaces the base fence for
            // every file it matches.
            noTestIdpInApiRuntime,
            {
              group: ['**/prisma/prisma.service', '**/prisma/prisma.module'],
              message:
                'Domain modules must not reach PrismaService directly — take a TenantScope from TenantScopeGuard instead. If this module genuinely owns database access, add it to the allow-list in eslint.config.js and say why.',
            },
          ],
        },
      ],
    },
  },

  // The public fill-in path must not be able to decrypt.
  //
  // Before the access-word check existed, this was a fact about the import
  // graph and needed no rule: `PublicFormsService` held no `SecretBoxService`,
  // the two parsers it reads settings through *redact* the access word instead of
  // opening it, and „a path that cannot decrypt cannot leak" was therefore true
  // however the file was edited later.
  //
  // The access-word check cannot be built without opening the word somewhere, and the shape chosen
  // was one named service whose whole surface is a predicate
  // (`settings/access-word.service.ts`): it takes a form and a string and
  // answers `true` or `false`, and there is no method on it that hands anybody a
  // plaintext. What that costs is that `PublicFormsModule` now imports a module
  // which transitively provides `SecretBoxService` — so the *graph* no longer
  // proves the property on its own, and the worklog named the consequence: „jede
  // künftige Änderung an `bySlug` wäre einen Tastendruck davon entfernt".
  //
  // This rule puts the file-local half of that proof back. It cannot see
  // transitive DI reachability — nobody does that by accident — but it does stop
  // the one-keystroke version: an `import { SecretBoxService }` in a public file
  // is now a build error rather than something a reviewer has to notice.
  //
  // Two things are deliberately **not** in the list. `signing.service`, because
  // the start token and the access proof are signed there under HKDF
  // subkeys and it holds no cipher; and `secret-box.module`, which
  // `PublicFormsModule` imports for exactly that signer. The rule names the
  // services that can turn a stored value back into a plaintext — or hand one
  // out — and nothing else: a broader pattern would be one somebody has to work
  // around, and a rule people work around is not a rule.
  {
    files: ['apps/api/src/public/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            // Repeated, not inherited — see the base fence above.
            noTestIdpInApiRuntime,
            {
              group: [
                '**/secret-box/secret-box.service',
                '**/settings/settings-secrets.service',
                // Every further opener belongs here on the day it is written.
                // These two were added after the fact — `OidcSecretsService`
                // and `MailSecretsService`, at different points — and in
                // between, the file-local half of the proof simply did not
                // cover them.
                //
                // **The sentence that used to stand here — „Neither is
                // reachable through DI today (`PublicFormsModule` imports
                // neither module)" — stopped being true once the public module
                // started importing `MailModule` for `MailClock`, and
                // `MailModule` exports `MailSecretsService`.** That import is
                // the reason this rule exists at all — a review caught it.
                // It imports `MailClockModule` now, which exports one token, so
                // the graph argument holds again — but it held once before too,
                // and that is exactly why it is not the one being relied on.
                '**/tenant-admin/oidc-secrets.service',
                '**/mail/mail-secrets.service',
                // Not openers themselves, but the two files that **hand out**
                // what an opener produced, which is the same leak one step
                // later. `MailIdentityService` answers with a `SendIdentity`
                // whose `block` carries the SMTP password **in the clear**
                // (`mail-identity.service.ts`), and `MailTransport` is the
                // interface that takes one. Both were exported by `MailModule`
                // and therefore injectable here until the `MailClockModule` fix, and neither
                // was on this list — the rule named „can decrypt" where the
                // property is „can see a plaintext".
                '**/mail/mail-identity.service',
                '**/mail/mail-transport',
              ],
              message:
                'The public fill-in path must not be able to decrypt. Ask AccessWordService, whose whole surface is a boolean — and if a new question genuinely needs the key, put it behind a predicate there and say so in the review.',
            },
            // The second half of the same fence (ADR-0014,
            // „Der öffentliche Pfad", Punkt 1): **the public path holds an
            // interface, not a filesystem.**
            //
            // The whole claim of the storage seam is that no code outside it
            // knows *where* a file lies — and building a path in
            // the public path *is* the traversal hole, in the shape of an
            // import. `node:crypto` stays allowed: `edit-token.ts` needs it.
            //
            // **Eight patterns for four modules, and that is not padding.**
            // `import { readFile } from 'fs'` is the same module as
            // `'node:fs'` to Node, but ESLint compares strings: a group that
            // only names the prefixed spelling is a fence with a gate beside
            // it, and the gate looks like a style difference in a diff.
            {
              group: [
                'fs',
                'node:fs',
                'fs/promises',
                'node:fs/promises',
                'path',
                'node:path',
                'child_process',
                'node:child_process',
              ],
              message:
                'The public fill-in path holds a FileStorage, not a filesystem (ADR-0014 Nr. 1). Building a path here is the traversal hole in the shape of an import. Lifting this ban needs a sentence in the review saying why.',
            },
            {
              // The third half of the fence:
              // **the public path does not know the AI.**
              //
              // Nothing under `src/ai/` belongs in a route strangers reach
              // without a session: the seam holds a provider key, the counter
              // spends a organisation's money, and the free text is the datum §10
              // no. 81 promises physical deletion for. The whole directory
              // rather than a list of services, because there is no file in it
              // a public route has a use for — a narrower pattern would be one
              // somebody has to work around, and a rule people work around is
              // not a rule.
              //
              // ⚠️ **This is the smaller half of the proof, on purpose.**
              // ESLint compares import strings; it cannot see that
              // `PublicFormsModule` reaches `AiUsageService` through a module
              // it imports for something else — which is exactly how the
              // `MailClock` import handed out three mail services „für die Uhr". The half that
              // measures the assembled graph is
              // `apps/api/test/ai/module-shape.spec.ts`; this entry stops the
              // one-keystroke version.
              group: ['**/ai/*', '**/ai/**'],
              message:
                'The public fill-in path does not know the AI (ADR-0015). The seam holds a provider key and the counter spends a organisation’s budget; neither belongs behind a route without a session.',
            },
            {
              // The adapter by name, so reaching past the seam is a build
              // error rather than something a reviewer has to notice.
              group: ['**/files/local-file-storage'],
              message:
                'Take the FileStorage token from FileStorageModule; the concrete adapter is the one file that knows about paths (ADR-0014 Nr. 1).',
            },
          ],
        },
      ],
    },
  },

  // Plain JavaScript (this config file, tooling helpers) is not type-checked.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
);
