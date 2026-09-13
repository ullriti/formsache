import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AdminModule } from './admin/admin.module';
import { OpsAlertModule } from './observability/ops-alert.module';
import { OpsStatusModule } from './observability/ops-status.module';
import { AiModule } from './ai/ai.module';
import { AiFormsModule } from './ai/ai-forms.module';
import { AiPromptPurgeModule } from './ai/purge/ai-prompt-purge.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/csrf.guard';
import { OidcAuthModule } from './auth/oidc/oidc-auth.module';
import { SessionPurgeModule } from './auth/purge/session-purge.module';
import { AttachmentModule } from './files/attachment.module';
import { FileStorageModule } from './files/file-storage.module';
import { FilePurgeModule } from './files/purge/file-purge.module';
import { FormTemplatesModule } from './form-templates/form-templates.module';
import { FormsModule } from './forms/forms.module';
import { GroupsModule } from './groups/groups.module';
import { MailLogModule } from './mail-log/mail-log.module';
import { MailModule } from './mail/mail.module';
import { TestMailModule } from './mail/test-mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PublicFormsModule } from './public/public-forms.module';
import { HealthModule } from './health/health.module';
import { SettingsModule } from './settings/settings.module';
import { SetupModule } from './setup/setup.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { RetentionPurgeModule } from './trash/purge/retention-purge.module';
import { TrashModule } from './trash/trash.module';
import { OidcConfigModule } from './tenant-admin/oidc-config.module';
import { SmtpConfigModule } from './tenant-admin/smtp-config.module';
import { TenantBaseUrlModule } from './tenant-admin/tenant-base-url.module';
import { TenantReplyToModule } from './tenant-admin/tenant-reply-to.module';
import { TenantBrandingModule } from './tenant-admin/tenant-branding.module';
import { TenantGroupsModule } from './tenant-admin/tenant-groups.module';
import { TenantLegalModule } from './tenant-admin/tenant-legal.module';
import { TenantUsersModule } from './tenant-admin/tenant-users.module';
import { FormPermissionModule } from './tenancy/form-permission.module';
import { TenancyModule } from './tenancy/tenancy.module';

/**
 * Every HTTP route is mounted under this prefix.
 *
 * The reason is the session cookie, and it is worth writing down: the cookie
 * is `SameSite=Lax` and host-bound, so the browser only ever sends it to the
 * origin it came from. The web app therefore proxies `/api` to the API port in
 * development, and the reverse proxy in production maps exactly the same path to
 * the API container — **without a rewrite**, so that dev and production agree
 * on what a URL looks like. Serving the API at the root would force one of the
 * two into a rewrite, and a rewritten path is where cookie paths and redirects
 * start to disagree.
 *
 * Exported rather than inlined in `main.ts` so the integration tests mount the
 * application at the same place the server does; a test that reached
 * `/auth/login` while production served `/api/auth/login` would prove nothing.
 */
export const GLOBAL_API_PREFIX = 'api';

@Module({
  imports: [
    HealthModule,
    /**
     * The first-run setup (ADR-0022) — the two routes that only exist
     * as long as the installation has **zero rows in `user`**.
     *
     * Named before `AuthModule`, because it lies before it in time: without a
     * first account the sign-in is a door without a key. It is registered
     * **always** and regardless of the data on hand — the 404 is the
     * answer of the route itself, not the absence of its registration.
     * A module that only came into an empty installation would mean „the application
     * starts with a different route table depending on the database", and every
     * test about the 404 would then run against a route that does not exist at all.
     */
    SetupModule,
    AuthModule,
    TenancyModule,
    GroupsModule,
    FormsModule,
    /**
     * The trash — named here although `FormsModule` already
     * imports it for the four write routes that live on `FormsController`.
     * It carries a controller of its own (`GET /api/trash`), and a controller
     * that reaches the router only because another module happens to import
     * its module is a route with no visible registration.
     */
    TrashModule,
    /** Vorlagen & Blöcke — the mechanism, without content. */
    FormTemplatesModule,
    /**
     * The AI seam (ADR-0015) — the seam, without a route.
     *
     * Named here although nothing injects it yet, because a module that
     * reaches the graph only once somebody imports it is a binding with no
     * visible registration. Listing it now also means the provider factory
     * runs at every startup: an installation with a half-written AI
     * configuration finds out at boot rather than at the first call — which is
     * the whole point of the check in `apiEnvSchema`.
     *
     * ⚠️ `PublicFormsModule` must **never** import it. The
     * proof of that is the module-shape test, not the lint:
     * ESLint sees direct import strings, not the transitive DI chain.
     */
    AiModule,
    /**
     * The route in front of it (the requirements) — `POST /api/ai/forms` and
     * `GET /api/ai/quota`, behind the chain *session → Organisation → `can_build` →
     * availability*.
     *
     * Registered **always**, even without a configured provider: the 404 is the
     * answer of the route itself (`AiFeatureGuard`), not the absence of its
     * registration. A module that only came into the graph with a key set
     * would mean „the application starts with a different route table depending
     * on the environment" — and every test about the 404 would then run against
     * a route that does not exist at all, instead of against the one that shall exist.
     */
    AiFormsModule,
    SettingsModule,
    /**
     * The bottom layer of the settings inheritance — named here although
     * three other modules already import it for their reads.
     *
     * It now carries a **controller**, and a controller that
     * reaches the router only because some other module happens to import its
     * module is a route with no visible registration: whoever removed the last
     * of those imports would silently unmount the superadmin settings surface.
     * Listing it makes the application's own surface the thing that decides.
     */
    SystemSettingsModule,
    PublicFormsModule,
    // Registered empty ahead of time so the parallel work on this foundation
    // could add providers to their own module instead of all editing this
    // file. All three are filled now: `MailModule` carries the
    // transport, the queue worker and the 90-day purge, `NotificationsModule`
    // the notification CRUD and `MailLogModule` the mail log —
    // the last of the three deliberately without `PrismaModule`, because
    // every read there goes through `ScopedMailLogDelegate`.
    MailModule,
    NotificationsModule,
    MailLogModule,
    /**
     * Registered **empty** ahead of time — the same move made for the module
     * above, and for the same reason.
     *
     * Several pieces of work run in parallel on this foundation. If each
     * registered its own module when it was finished, all of them would edit
     * this one file, and „zwei Agenten in derselben Datei" is the most
     * expensive mistake this project has made. The modules therefore exist
     * and are wired **now**; each piece of work fills the file it owns and
     * touches nothing here.
     *
     * The order is the order the work landed in: branding, the OIDC
     * configuration and the login it enables, users and groups, the
     * per-form restriction and the superadmin surface, then the
     * organisation's own sending identity.
     */
    TenantBrandingModule,
    OidcConfigModule,
    SmtpConfigModule,
    // The dial-and-answer route next to the block it dials — its own module so its throttle bucket and its
    // `PrismaModule` import are visible next to the route that needs them,
    // not folded into `SmtpConfigModule`'s.
    TestMailModule,
    // The write path was missing until this module was added — its own module for
    // the reason ADR-0013 no. 3 gives the column its own route: the base
    // address is not part of the indivisible SMTP block, so it is not part
    // of `SmtpConfigModule` either.
    TenantBaseUrlModule,
    TenantReplyToModule,
    // The legal texts of an Organisation (ADR-0028) — provider details and
    // data protection notices, their own tab next to the five that already
    // exist.
    TenantLegalModule,
    OidcAuthModule,
    TenantUsersModule,
    TenantGroupsModule,
    FormPermissionModule,
    AdminModule,
    // the requirement: the operating status of the installation (ADR-0016).
    OpsStatusModule,
    // the requirement: the guard over the thresholds (ADR-0016).
    OpsAlertModule,
    /**
     * The storage seam (ADR-0014).
     *
     * Registered here although nothing injects it yet, and that is what makes
     * the promise of ADR-0014 no. 2 true: the adapter checks its directory in
     * `onModuleInit`, so a volume that did not come up stops the start instead
     * of surfacing as a 500 during the one hour a registration is open. A
     * module that only appeared once the upload route existed would leave that
     * check unarmed until then.
     */
    FileStorageModule,
    /**
     * The attachment retrieval — its own module next to
     * the seam rather than inside it, because `FileStorageModule` provides one
     * token on purpose and the public path imports it (ADR-0014 no. 11b).
     */
    AttachmentModule,
    /**
     * The purge of orphaned attachments — outside the
     * seam as well, and for a second reason on top of the one above: it is the
     * only module in `src/files/` that holds `PrismaService` directly, which is
     * why it lives in `files/purge/` and why the allow-list of
     * `eslint.config.js` names that directory rather than `files/**`.
     *
     * Registered here although nothing injects it, exactly like the seam: the
     * job arms itself in `onModuleInit`, so an application that only started
     * purging once some other module happened to import it would be an
     * installation quietly keeping abandoned uploads for ever.
     */
    FilePurgeModule,
    /**
     * The 30-day purge of the trash — outside
     * `TrashModule` for the same two reasons `FilePurgeModule` sits outside the
     * storage seam: it is the second module that holds `PrismaService` without
     * a `TenantScope`, which is why it lives in `trash/purge/` and why the
     * allow-list of `eslint.config.js` names that directory rather than
     * `trash/**`; and `TrashModule` is imported by `FormsModule`, so anything
     * provided there is injectable from a route.
     *
     * Registered here although nothing injects it, exactly like the other two
     * jobs: it arms itself in `onModuleInit`, and a purge that only started
     * once some other module happened to import it would be an installation
     * quietly keeping deleted forms, answers and Organisationen for ever — while its
     * trash went on promising the opposite.
     */
    RetentionPurgeModule,
    /**
     * The 30-day purge of the AI free texts —
     * the third job of this kind, and outside `AiModule` for the same two
     * reasons: it holds `PrismaService` without a `TenantScope` (hence
     * `ai/purge/**` on the allow-list instead of `ai/**`), and `AiModule`
     * deliberately provides only the seam and the counter.
     *
     * Registered here although nothing injects it, like the other two: it
     * arms itself in `onModuleInit`. **And expressly regardless of
     * `AI_PROVIDER`** — an installation that removes the key has thereby
     * revoked no deletion promise, it has only stopped producing new
     * texts; a purge that switched itself off along with the feature would
     * leave lying exactly those texts nobody needs any more.
     */
    AiPromptPurgeModule,
    /**
     * The clean-up run over dead session rows (a review finding) — the
     * fourth of this kind, and the only one whose absence a comment in the
     * schema covered up for half a year: `@@index([expiresAt])` carried
     * the line „supports the purge job that removes expired sessions", and
     * the job did not exist.
     *
     * Registered here although nothing injects it, like the three above: it
     * arms itself in `onModuleInit`. Outside `AuthModule`, because a
     * timer there would run along in every test that needs a sign-in.
     */
    SessionPurgeModule,
  ],
  providers: [
    /**
     * CSRF protection is **global**, not per route.
     *
     * That direction is the whole guarantee: a mutating route added next year
     * is covered because it exists, not because its author remembered a
     * decorator. The exemptions have to be written down instead — and writing
     * one down is a visible decision in a diff, which is what `@CsrfExempt()`
     * is for.
     */
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
