import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The one and only way to the `system_setting` row.
 *
 * ---------------------------------------------------------------------------
 * **This file uses `PrismaService` directly, and `apps/api/src/system-settings/**`
 * is the sixth entry on the allow-list in `eslint.config.js`.** Read that entry
 * before changing anything here.
 *
 * The reason it is defensible is not „this table has no tenant" — that would
 * make every future cross-tenant convenience query defensible too. It is the
 * three properties below, and a change that breaks any of them needs a new
 * decision rather than a new method:
 *
 * 1. **There is exactly one row**, promised by the table (`CHECK (id = 'x')`
 *    plus the primary key), so a `TenantScope` would have nothing to scope and
 *    no row selection can be influenced from outside.
 * 2. **Nothing from a request selects a row.** The id is a module constant in
 *    every query below, and the one value a request contributes to a `where` is
 *    the expected revision of {@link SystemSettingsRepository.writeFormDefaults}
 *    or {@link SystemSettingsRepository.writeAi} — a value that can only
 *    make the write **miss**, never make it hit a different row, because
 *    there is no different row.
 * 3. **The counter-check:** no domain path writes this row. Reading is done by
 *    the readers of the mail block, the base address, the legal texts and the
 *    KI block; writing belongs to the superadmin routes behind the guard —
 *    `/mail`, `/ai` and `/legal` in `system-settings.controller.ts` — and to
 *    nothing else. A service that started writing it from an
 *    organisation-facing route would be the regression that survives every
 *    test — the same warning `mail-queue.repository.ts` carries for the
 *    queue.
 *
 *    **A raw write to `smtp` is not a configuration path, and cannot be
 *    one.** `auth.password` has to be a `SecretBox` ciphertext under the
 *    context `system:smtp.password` (`MailSecretsService`); nothing outside
 *    that class can produce one by hand. A plaintext password typed straight
 *    into the column does not silently work — but it does **not** fail as
 *    readably as it looks like it should. What actually happens: `MailWorkerService.runOnce` asks
 *    `MailTransport.configured()` **before** it claims a single row, and that
 *    call resolves the *system* block regardless of which organisation's mail is
 *    next due. `box.open` throws on the broken value, `resolve()` turns that
 *    into a `MailConfigUnreadableError`, `configured()` rejects, and nothing
 *    inside `runOnce()` catches it — the rejection propagates out of the
 *    method entirely. `runTick()`'s own `try`/`catch` is the first thing that
 *    sees it, and it only logs "mail queue run failed: …". **No row is
 *    claimed, so no row can go `failed`, and none gets a `last_error`** — not
 *    even a row belonging to an organisation with a perfectly valid mail identity of
 *    its own, because `deliverOne` (which is where a per-mail identity would
 *    be resolved) is never reached. The queue simply stops making progress
 *    for **every** Organisation until the broken system block is fixed, silently
 *    apart from that one log line per tick. `PUT /admin/system-settings/mail`
 *    is still the only path that produces a value this application can open
 *    again — that half was correct — but the failure mode it prevents is a
 *    silent, installation-wide stall, not a readable `failed` on the one row
 *    that happened to be due. Fixing that stall is `apps/api/src/mail/**`'s
 *    call, not this file's.
 *
 * ---------------------------------------------------------------------------
 */

/** The fixed primary key of the single row — see `schema.prisma`. */
export const SYSTEM_SETTING_ID = 'x';

/**
 * The AI configuration as it stands in the row.
 *
 * `aiApiKey` is the **sealed** value — this repository never unseals anything,
 * exactly as it passes the SMTP password on sealed.
 */
export interface SystemAiRow {
  readonly aiEnabled: boolean;
  readonly aiProvider: string | null;
  readonly aiModel: string | null;
  readonly aiRegion: string | null;
  readonly aiApiKey: string | null;
  readonly aiRevision: number;
}

/**
 * The counter value an installation **without** a row reports — the same
 * default the column carries, so that the first write can name the lock
 * instead of making it optional.
 */
export const INITIAL_AI_REVISION = 1;

/**
 * The legal texts **with their counter** — what the superadmin page reads and
 * what the public delivery needs (ADR-0028).
 */
export interface SystemLegalRow {
  readonly legalPages: Prisma.JsonValue | null;
  readonly legalRevision: number;
}

/**
 * The counter value an installation **without** a row reports — the same
 * default the column carries.
 */
export const INITIAL_LEGAL_REVISION = 1;

/**
 * The two columns of the row that have nothing to do with the settings
 * inheritance — the installation's mail server and its own address.
 *
 * **Two projections, not one, and that is data minimisation rather than
 * tidiness.** `SystemMailSettingsService.publicBaseUrl` is resolved on
 * **every** public fill-in request — the base address a link needs — while
 * `smtp` holds a sealed password that has no reason to travel through that
 * path at all. A single `findMail()` selecting both used to hand the sealed
 * block to every caller who only wanted the address; {@link SystemSmtpRow}
 * and {@link SystemBaseUrlRow} are what makes “only what was asked for” a
 * property of the query rather than a promise nobody checks — the same
 * argument {@link SystemSettingAdminRow} makes for an administrator's name.
 *
 * The **admin** surface of the superadmin mail-settings feature (`findMailForAdmin`) is the one caller
 * allowed to ask for both at once: it sits behind `SuperadminGuard`, it is
 * the page this row exists to be edited from, and showing what is stored is
 * its whole purpose.
 */
export interface SystemSmtpRow {
  /**
   * The stored system block, **still sealed** — shape `smtpBlockSchema` in
   * `@formsache/shared`, `null` for “not set up yet”.
   *
   * Handed out unopened on purpose: the key lives in `MailSecretsService`
   * (`src/mail/`), and this module holds the one way to the row. Opening it here
   * would put the two in one place, and the row reader is the file that is
   * *allowed* to reach `PrismaService`.
   */
  readonly smtp: Prisma.JsonValue | null;
}

/** The installation's own base address, or `null` — see `schema.prisma`. */
export interface SystemBaseUrlRow {
  readonly publicBaseUrl: string | null;
}

/**
 * The installation-wide default for `Reply-To`, or `null`.
 *
 * **A third narrow projection next to {@link SystemSmtpRow} and
 * {@link SystemBaseUrlRow}, for their reason:** this value is read on the
 * public fill-in path — when queueing every confirmation — and has as little
 * business travelling next to a sealed password there as the base address.
 */
export interface SystemReplyToRow {
  readonly replyTo: string | null;
}

/**
 * The mail block, the base address **and** their own lock — what the
 * superadmin's *Mailserver & Basis-Adresse* page reads.
 *
 * `mailRevision`, not `updatedAt`: an earlier version of this row used the
 * row's own timestamp as the lock. That did not hold — see
 * {@link SystemSettingsRepository.writeMail} for why a dedicated counter
 * replaced it.
 */
export interface SystemMailAdminRow {
  readonly smtp: Prisma.JsonValue | null;
  readonly publicBaseUrl: string | null;
  /** The default for `Reply-To` — next to the block, not inside it. */
  readonly replyTo: string | null;
  readonly mailRevision: number;
  /**
   * The operator's address for operating alerts.
   *
   * **Only here**, not in {@link SystemReplyToRow}: that narrow projection is
   * read on the public fill-in path, and an address travelling along there is
   * exactly the leak the three projections exist to prevent — the data
   * minimisation that justifies having three of them in the first place.
   */
  readonly opsAlertEmail: string | null;
}

/**
 * The starting value of {@link SystemMailAdminRow.mailRevision} — the column
 * default of `schema.prisma`, named once so the read of a **missing** row and
 * the write that creates it cannot disagree about it.
 *
 * A settings page loaded on a fresh installation reports this number, and the
 * write that follows names it back. That is what makes “two superadmins on an
 * empty installation” a 409 for the second rather than a silent
 * overwrite: the first write turns the number into 2, so the second no longer
 * matches anything and cannot create the row either.
 */
export const INITIAL_MAIL_REVISION = 1;

@Injectable()
export class SystemSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The installation's mail block alone, or `null` when nobody has written
   * the row.
   *
   * `null` and “a row whose `smtp` is empty” mean the same thing here
   * and are deliberately not told apart: neither is a fault, both are “not set
   * up yet” (ADR-0013 no. 5). That is different from
   * `form_defaults`, where an unreadable document has to be distinguishable
   * from a missing one — there a wrong reading opens a closed form, here it
   * delays a mail.
   */
  findSmtp(): Promise<SystemSmtpRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: { smtp: true },
    });
  }

  /**
   * The installation's legal texts and their counter (ADR-0028).
   *
   * A projection of its **own** next to {@link findMailForAdmin}, for the
   * reason {@link SystemSmtpRow} spells out for the mail page: this read runs
   * on the **public** path as well — every legal text page and every footer
   * asks for it —, and what a stranger triggers fetches exactly the columns
   * they get to see, and none beside them.
   */
  findLegal(): Promise<SystemLegalRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: { legalPages: true, legalRevision: true },
    });
  }

  /**
   * Writes the legal texts under their **own** counter.
   *
   * Built word for word like {@link writeTemplates}, and that is deliberate: a
   * fourth pattern for the same problem would be the fourth opportunity to
   * close the tight race between reading and writing differently.
   */
  async writeLegal(
    expectedRevision: number,
    legalPages: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const updated = await this.prisma.systemSetting.updateMany({
      where: { id: SYSTEM_SETTING_ID, legalRevision: expectedRevision },
      data: { legalPages, legalRevision: { increment: 1 } },
    });
    if (updated.count === 1) {
      return true;
    }
    if (expectedRevision !== INITIAL_LEGAL_REVISION) {
      return false;
    }
    const created = await this.prisma.systemSetting.createMany({
      data: {
        id: SYSTEM_SETTING_ID,
        legalPages,
        legalRevision: expectedRevision + 1,
      },
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /**
   * Whether the AI feature is **set up** — without touching the key.
   *
   * ⚠️ **The one query of this row that runs on the public path and talks about
   * a secret.** It does so without fetching it: `aiApiKey` stands in the
   * **condition**, never in the projection, so the sealed value does not leave
   * the database for this caller at all. What comes out is a boolean —
   * precisely the information the privacy policy needs (“does this installation
   * use an AI?”) and none beside it.
   *
   * `null` means “no row”, and therefore no AI either.
   */
  findAiPresence(): Promise<{
    readonly aiEnabled: boolean;
    readonly aiProvider: string | null;
    readonly aiModel: string | null;
  } | null> {
    return this.prisma.systemSetting.findFirst({
      where: { id: SYSTEM_SETTING_ID, aiApiKey: { not: null } },
      select: { aiEnabled: true, aiProvider: true, aiModel: true },
    });
  }

  /** The installation's base address alone, or `null` — see {@link findSmtp}. */
  findBaseUrl(): Promise<SystemBaseUrlRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: { publicBaseUrl: true },
    });
  }

  /** The default for `Reply-To` alone, or `null` — see {@link findSmtp}. */
  findReplyTo(): Promise<SystemReplyToRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: { replyTo: true },
    });
  }

  /**
   * Both, plus the lock that guards them — the superadmin's own page. See
   * {@link SystemMailAdminRow} for why this is the one caller
   * allowed to ask for both together.
   */
  findMailForAdmin(): Promise<SystemMailAdminRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: {
        smtp: true,
        publicBaseUrl: true,
        replyTo: true,
        opsAlertEmail: true,
        mailRevision: true,
      },
    });
  }

  /**
   * Replaces `smtp` and `public_base_url`, if the caller started from the
   * state it is in — **two statements rather than an `upsert`, because a
   * missing row is a state the lock has to cover too.** Prisma's `upsert` takes
   * a unique `where` and would gladly overwrite whatever revision it finds; the
   * update below matches the id **and** the revision, so a stale write matches
   * no row. Only then is a creation attempted, and only for the one
   * `expectedRevision` a fresh installation can legitimately report
   * ({@link INITIAL_MAIL_REVISION}).
   *
   * The creation goes through `createMany({ skipDuplicates: true })` — an
   * `INSERT … ON CONFLICT DO NOTHING`, decided by PostgreSQL rather than by
   * reading and then writing. Two superadmins saving a fresh installation at
   * the same moment therefore produce one row and one 409, with no window
   * between the check and the insert and no exception to classify.
   *
   * **`mail_revision`, not `updated_at`.** An earlier version of this method
   * took the row's own timestamp as the lock, reasoning that no migration
   * belonged to this package. Two things were wrong with that: PostgreSQL
   * truncates `updated_at` to milliseconds, so two writes landing in the same
   * millisecond compared equal and the second silently overwrote the first —
   * exactly the failure `formDefaultsRevision`'s own comment in
   * `schema.prisma` names as the reason a counter exists at all, one field
   * over. `mail_revision` is that counter for this half of the row.
   *
   * `smtp` takes `Prisma.DbNull` for “removed” — `Json?` columns need it
   * spelled out, the same way `MailSecretsService.sealTenantBlock` writes
   * it for an organisation that reverts to the system identity.
   */
  async writeMail(
    expectedRevision: number,
    data: {
      readonly smtp: Prisma.InputJsonValue | typeof Prisma.DbNull;
      readonly publicBaseUrl: string | null;
      /**
       * The default for `Reply-To` — an ordinary `text`, no `Json?`, so `null`
       * needs no `Prisma.DbNull` here. It stands in the same statement as the
       * block, because it lies under the same counter and comes from the same
       * page — but as a field of its own, not inside `smtp`.
       */
      readonly replyTo: string | null;
      /**
       * The operator's address for operating alerts. Under the same
       * counter as the three fields above, because it comes from the same page
       * — and without this write path the watchdog would reach nobody.
       */
      readonly opsAlertEmail: string | null;
    },
  ): Promise<boolean> {
    const updated = await this.prisma.systemSetting.updateMany({
      where: { id: SYSTEM_SETTING_ID, mailRevision: expectedRevision },
      data: {
        smtp: data.smtp,
        publicBaseUrl: data.publicBaseUrl,
        replyTo: data.replyTo,
        opsAlertEmail: data.opsAlertEmail,
        mailRevision: { increment: 1 },
      },
    });
    if (updated.count === 1) {
      return true;
    }

    if (expectedRevision !== INITIAL_MAIL_REVISION) {
      // A row exists and has moved on — or it does not exist and this caller
      // never saw the page that would have told them so. Either way: 409.
      return false;
    }

    const created = await this.prisma.systemSetting.createMany({
      data: {
        id: SYSTEM_SETTING_ID,
        smtp: data.smtp,
        publicBaseUrl: data.publicBaseUrl,
        replyTo: data.replyTo,
        opsAlertEmail: data.opsAlertEmail,
        // The same number an update would have produced, so “has saved once
        // before” is one state and not two.
        mailRevision: expectedRevision + 1,
      },
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  /**
   * **The AI configuration — all six columns, including the sealed key** .
   *
   * ⚠️ Unlike with {@link findSmtp} and {@link findBaseUrl} there is **one**
   * projection here and not two, and that is a trade-off, not carelessness.
   * There the data minimisation separates two *callers* — the public fill-in
   * path needs the base address and has nothing to do with a sealed password.
   * Here every caller has the same question (“is there a feature, and with
   * what?”), and **two** projections would mean two resolutions: one that reads
   * the key, and one that only checks its presence. That is exactly the mistake
   * ADR-0015 no. 9 rules out with „eine Funktion, zwei Verbraucher" — two paths
   * that can quietly disagree with each other.
   *
   * The key stays locked up nonetheless: `AiSettingsService` unseals it, passes
   * it on to the adapter and **never** to another caller; the availability
   * question gets a `boolean` back. Evidenced by
   * `test/ai/key-confinement.spec.ts`.
   */
  findAi(): Promise<SystemAiRow | null> {
    return this.prisma.systemSetting.findUnique({
      where: { id: SYSTEM_SETTING_ID },
      select: {
        aiEnabled: true,
        aiProvider: true,
        aiModel: true,
        aiRegion: true,
        aiApiKey: true,
        aiRevision: true,
      },
    });
  }

  /**
   * Writes the AI configuration under its **own** counter.
   *
   * The same construction as {@link writeMail}: `updateMany` with the expected
   * counter value in the `where`, and when nothing has been matched, either a
   * 409 or — at the initial value — the creation of the row. The reason for the
   * counter of its own instead of `updatedAt` stands at the column itself.
   *
   * `apiKey` is already sealed when it arrives here; this repository knows no
   * plaintext and no `SecretBoxService`.
   */
  async writeAi(
    expectedRevision: number,
    data: {
      readonly aiEnabled: boolean;
      readonly aiProvider: string | null;
      readonly aiModel: string | null;
      readonly aiRegion: string;
      readonly aiApiKey: string | null;
    },
  ): Promise<boolean> {
    const updated = await this.prisma.systemSetting.updateMany({
      where: { id: SYSTEM_SETTING_ID, aiRevision: expectedRevision },
      data: { ...data, aiRevision: { increment: 1 } },
    });
    if (updated.count === 1) {
      return true;
    }
    if (expectedRevision !== INITIAL_AI_REVISION) {
      return false;
    }
    const created = await this.prisma.systemSetting.createMany({
      data: {
        id: SYSTEM_SETTING_ID,
        ...data,
        aiRevision: expectedRevision + 1,
      },
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
