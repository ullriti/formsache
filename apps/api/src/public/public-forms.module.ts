import { Module } from '@nestjs/common';

import { PublicUrlModule } from '../common/public-url/public-url.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { SecretBoxModule } from '../common/secret-box/secret-box.module';
import { FileStorageModule } from '../files/file-storage.module';
import { ConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { MailClockModule } from '../mail/mail-clock.module';
import { AccessWordModule } from '../settings/access-word.module';
import { AccessProofService } from './access-proof.service';
import { PublicDraftsController } from './public-drafts.controller';
import {
  PublicDraftFilesController,
  PublicEditFilesController,
  PublicFilesController,
} from './public-files.controller';
import { PublicUploadsService } from './public-uploads.service';
import { PublicFormsController } from './public-forms.controller';
import { PublicFormsService } from './public-forms.service';
import { PublicLegalController } from './public-legal.controller';
import { PublicLegalService } from './public-legal.service';
import { PublicLogoController } from './public-logo.controller';
import { PublicLogoService } from './public-logo.service';
import { PublicResponsesController } from './public-responses.controller';
import { StartTokenService } from './start-token.service';

/**
 * The public fill-in surface (the requirements).
 *
 * **This module imports `PrismaModule`, which the feature modules must not** —
 * and the exception is deliberate rather than an oversight of the lint rule.
 * The rule keeps an unscoped client away from code that *has* a tenant scope
 * available; here there is none to have, because a participant is not a member
 * of anything. What binds the query instead is the slug, and the reasoning is
 * written out in `public-forms.service.ts`.
 *
 * The rate limit comes from `RateLimitModule`, which is the **only** place
 * `ThrottlerModule.forRoot` is called — see the note there; registering a
 * second one here silently disabled the login's limit.
 *
 * **`SecretBoxModule` is imported for the *signer*, not for the cipher**
 * . `StartTokenService` and `AccessProofService` take
 * `SigningService`, which holds subkeys derived one-way from `SECRET_BOX_KEY`
 * and nothing else.
 *
 * **`AccessWordModule` is a deliberate change, and it is worth reading
 * twice.** Until it was added, no module reachable from here could decrypt
 * anything, so „the public path cannot open an access word" was a fact about
 * the import graph. Checking a password needs the key, so that is no longer
 * true as stated: this module now reaches `SecretBoxService` transitively.
 *
 * What replaces it is narrower and still checkable in two constructor lists.
 * `AccessWordModule` exports **one** service, whose whole surface is a
 * predicate — it answers `true` or `false` and has no method that returns a
 * plaintext. `SettingsSecretsService`, the service that *does* hand out words,
 * is provided inside that module and not exported. And `PublicFormsService`
 * still reads settings through the redacting parsers of `settings-document.ts`
 * and `settings-enforcement.ts`, so the payload-building path cannot see a word
 * even by accident.
 */
@Module({
  imports: [
    // Only for `FILE_PURGE_INTERVAL_MS`: the upload quota's waiting room has to
    // wait for the purge that empties it (a review). One token, no
    // services — the import graph of this module stays a fact, see below.
    ConfigModule,
    PrismaModule,
    RateLimitModule,
    SecretBoxModule,
    AccessWordModule,
    // For the installation-wide `Reply-To` default and the base address
    // (`SystemMailSettingsService`) — **no longer** for a settings level: that
    // one no longer exists (ADR-0011, amendment 2026-08-14).
    SystemSettingsModule,
    // The requirement: the confirmation carries an **absolute** edit link, and the
    // server therefore has to know its own address. Configuration, never the
    // request's `Host` — see `common/public-url/public-url.service.ts`.
    PublicUrlModule,
    // The requirement — the queue's calendar, and **provably** nothing else.
    //
    // The sending budget counts `mail_log` rows over a sliding window and has
    // to read the same calendar the worker and the purge read, or „im letzten
    // Zeitfenster" means two different things depending on who asks
    // (`mail/mail-clock.ts`).
    //
    // This used to be `MailModule`, with a comment saying „für `MailClock` und
    // sonst nichts" — true of the intent and false of the graph (a review
    // finding). `MailModule` also exports `MailSecretsService`, which
    // opens a sealed SMTP password, `MailIdentityService`, whose `SendIdentity`
    // carries that password in the clear, `MailTransport` and `MAIL_TIMEOUTS`;
    // all four were injectable from here, i.e. from the surface a stranger
    // reaches without a session. `MailClockModule` provides and exports one
    // token, so „der öffentliche Pfad kann nichts entschlüsseln" is a fact
    // about the import graph again (`CONTRIBUTING.md`) rather
    // than a sentence in a comment.
    //
    // What it still does not bring in is the queue itself: `MailWorkerService`
    // and `MailQueueRepository` were never exported, so the public path writes
    // its rows through the ordinary `tx.mailLog` of the transaction that stores
    // the answer and cannot reach the cross-tenant claim query.
    MailClockModule,
    // The requirement — **one binding, one exported token**, and that is why
    // this import is safe to write (ADR-0014 „Der öffentliche Pfad", Punkt 4).
    //
    // It is the same sentence `MailClockModule` above carries, and it is here
    // because a review proved that the sentence is not enough on its own: what
    // makes it true is the *shape* of the module — the adapter, the purge and
    // the attachment download deliberately live outside it — and what keeps it
    // true is the test that reads its `exports` from the module metadata
    // (`test/files/module-shape.spec.ts`). The public path holds a
    // `FileStorage` and a key; the one file that knows a file has a path is the
    // adapter, and `eslint.config.js` makes importing it from here a build
    // error rather than something a reviewer has to notice.
    FileStorageModule,
  ],
  controllers: [
    PublicFormsController,
    PublicResponsesController,
    // The requirement — the two token-borne routes of *Zwischenspeichern*. Its
    // first save sits on `PublicFormsController`, where the slug is; these two
    // carry the draft's own address and nothing else.
    PublicDraftsController,
    PublicFilesController,
    PublicEditFilesController,
    // An addition made afterwards — the third upload door, that of a resumed
    // draft. Without it a participant on the second device can take their
    // attachment away and attach no new one.
    PublicDraftFilesController,
    // The requirement — the **other** half of the retrieval, the one that is
    // public on purpose (ADR-0014 no. 11a). It sits here rather than next to
    // the attachment download because it is a route without a session, which
    // is the property this whole module is built around.
    PublicLogoController,
    // The legal pages (ADR-0028) — here and not with the system settings,
    // because they carry the same property this whole module is built around: no
    // session, no tenant scope, no group permission. A legal page behind a
    // sign-in would be no legal page (§ 18 Abs. 1 MStV: „ständig verfügbar";
    // Art. 13 Abs. 1 DSGVO: „zum Zeitpunkt der Erhebung").
    PublicLegalController,
  ],
  providers: [
    PublicFormsService,
    StartTokenService,
    AccessProofService,
    PublicUploadsService,
    PublicLogoService,
    PublicLegalService,
  ],
})
export class PublicFormsModule {}
