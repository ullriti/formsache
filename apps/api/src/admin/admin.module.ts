import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AccountInvitationModule } from '../auth/invitation/account-invitation.module';
import { PublicUrlModule } from '../common/public-url/public-url.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminTenantsController } from './admin.controller';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import { SuperadminInvitationService } from './superadmin-invitation.service';
import { SuperadminsController } from './superadmins.controller';
import { SuperadminsService } from './superadmins.service';

/**
 * The superadmin surface — cross-tenant overview, KPI tiles, creating an organisation
 * (the requirements, the design handoff).
 *
 * Its own routes under `/api/admin/…` behind the `SuperadminGuard`,
 * deliberately *not* a tenant parameter bolted onto `/api/tenant/…`: a boundary
 * one cannot address is stronger than one that answers 403 .
 *
 * ---------------------------------------------------------------------------
 * **This directory holds the seventh `PrismaService` allow-list entry** in
 * `eslint.config.js`, because the KPI counters and the creation of an organisation are
 * the only cross-tenant database work outside the mail worker and the purge
 * jobs. The full argument — and the counter-check that makes it defensible —
 * is at {@link AdminRepository}, where somebody changing that code will
 * actually be looking. In one line: everything *fachlich* about an organisation (users,
 * groups, restrictions, settings) goes through the `TenantScope`, and an
 * `AdminService` that read an organisation's users because Prisma was within arm's reach
 * would be the regression every test survives.
 *
 * `AdminRepository` is provided here and **not** exported, so there is no way
 * for another module to reach the unscoped client through it.
 * ---------------------------------------------------------------------------
 */
/*
 * `MailClockModule` — **not** `MailModule` — since the requirement: deleting a
 * Organisation writes `tenant.deleted_at`, and the 30 days of the retention requirement are counted from that
 * instant, so it comes from the one injected clock of this application and not
 * from `new Date()`. `TrashModule` imports the same narrow module for the same
 * timestamp and for the reason its own note gives.
 */
@Module({
  imports: [
    AuthModule,
    /**
     * The invitation of the first administrator of a new organisation
     * (ADR-0024) — the same service the member administration uses, so that
     * the deadline, the wording and the refusal do not come into being twice.
     */
    AccountInvitationModule,
    MailClockModule,
    /**
     * Der Versand der Einladung in die **Systemverwaltung** (Review-Runde 3
     * Nr. 13). Sie geht an der Warteschlange vorbei — die ist `mail_log`, und
     * jede Zeile davon gehört einer Organisation. Gebraucht werden daraus der
     * Transport, die Auflösung des Systemblocks und die Sendefristen;
     * `SuperadminInvitationService` sagt in voller Länge, warum dieser Weg
     * und nicht die Warteschlange.
     */
    MailModule,
    /** Die Basis-Adresse für den Einladungslink — nur gelesen. */
    PublicUrlModule,
    /** Der Schlüssel, aus dem der Einladungs-Token zurückgerechnet wird. */
    SecretBoxModule,
    PrismaModule,
  ],
  controllers: [AdminTenantsController, SuperadminsController],
  /*
   * `SuperadminsService` (ADR-0029) holds `PrismaService` itself and does
   * **not** go through `AdminRepository`. The reason is in that file: its
   * promise reads literally „no method that reads the users of an organisation",
   * and a `user` query inside it would have to be classified anew on every
   * reading. What is read here are accounts of the *installation* — the
   * rows with `is_superadmin`, not members.
   *
   * Like `AdminRepository`, this service is **not** exported either: there is
   * no way by which another module gets at the setting of this column.
   */
  providers: [
    AdminService,
    AdminRepository,
    SuperadminsService,
    SuperadminInvitationService,
  ],
})
export class AdminModule {}
