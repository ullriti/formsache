import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  smtpBlockSchema,
  type SmtpBlock,
  type SystemMailSettings,
  type SystemSmtpDisplay,
  type SystemSmtpWrite,
  type UpdateSystemMailSettingsRequest,
} from '@formsache/shared';
import { Prisma } from '@prisma/client';

import { MailSecretsService } from '../mail/mail-secrets.service';
import {
  INITIAL_MAIL_REVISION,
  SystemSettingsRepository,
  type SystemMailAdminRow,
} from './system-settings.repository';
import type { SystemMailSettingsResponse } from './system-settings-wire';

/** The answer to a save that started from a row somebody else has replaced. */
export const STALE_SYSTEM_MAIL_MESSAGE =
  'Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.';

/**
 * What a write is told when `auth.password` is omitted and there is nothing
 * stored to keep — the half of the requirement that is server state
 * rather than a schema rule (`systemSmtpWriteSchema`'s own comment).
 */
export const MISSING_SMTP_PASSWORD_MESSAGE =
  'Ohne gespeichertes Passwort muss beim Einrichten eines neuen Mailservers ein Passwort angegeben werden.';

/**
 * What a write is told when it changes `auth.user` but omits `auth.password`
 * — a requirement from security review. The stored ciphertext was sealed for the
 * *previous* user; carrying it forward under a new name would pair a login
 * nobody typed, and the mismatch would only surface at the next send.
 */
export const CHANGED_SMTP_USER_MESSAGE =
  'Beim Ändern des Benutzernamens muss auch ein neues Passwort angegeben werden.';

/**
 * Reading and writing the installation's mail server and base address — the
 * surface that used to require manual SQL and is now a proper route.
 *
 * ## What this service does that `SystemMailSettingsService` does not
 *
 * That one answers „was gilt gerade?" for the public path and the worker,
 * tolerantly, and never touches a secret — it hands the sealed block out
 * closed. This one is the **write** path and the one caller allowed to open
 * a password at all: it goes through {@link MailSecretsService}, the same
 * class the worker uses, because ADR-0013 is explicit that there is
 * exactly one place that knows the sealing context. There is no second one
 * here — only a second *instance* of that one class, wired in
 * `system-settings.module.ts` to avoid a module cycle with `MailModule`
 * (which already imports `SystemSettingsModule`); see that module's comment.
 *
 * ## The optimistic lock is `mail_revision`, its own counter
 *
 * `smtp`/`public_base_url` share `system_setting` with `form_defaults`, but
 * they do not share its lock: an earlier version of this class reused the
 * row's own `updated_at` for exactly the reason `formDefaultsRevision`'s
 * comment in `schema.prisma` rejects it for the other half of the row —
 * PostgreSQL truncates it to milliseconds, so two writes landing in the same
 * millisecond compared equal and the second overwrote the first without
 * either side ever seeing a 409. `mail_revision` closes that: a save to the
 * form standards no longer moves this lock at all, and a save to mail never
 * moves `formDefaultsRevision` — the two routes can genuinely run
 * concurrently without spurious conflicts in either direction, which the
 * shared `updated_at` could not promise.
 *
 * ## „Unverändert" vs. „geleert" — the promise this class exists to keep
 *
 * A write that omits `auth.password` means „lass das gespeicherte Passwort
 * stehen", the same three-state shape `OidcConfigService.nextSecret` reads
 * for the client secret. The stored **ciphertext** is carried forward
 * byte-for-byte in that case — never opened and re-sealed, because opening
 * it needs nothing this service has to touch, and re-sealing plaintext that
 * was never produced is not an operation that exists. Only a *new* password
 * goes through {@link MailSecretsService.sealSystemBlock}.
 *
 * That carry-forward is keyed to the **user** it was sealed for, not to the
 * block in general: a write that changes `auth.user` while omitting
 * `auth.password` is refused ({@link CHANGED_SMTP_USER_MESSAGE}) rather than
 * pairing the new name with the old ciphertext. A stored password proves
 * nothing about a login nobody typed, and the alternative — carrying it
 * forward — would only fail once, silently, at the next send.
 */
@Injectable()
export class SystemMailAdminService {
  constructor(
    private readonly repository: SystemSettingsRepository,
    private readonly secrets: MailSecretsService,
  ) {}

  read(): Promise<SystemMailSettingsResponse> {
    return this.compose();
  }

  /**
   * Replaces the block and the base address in one write.
   *
   * The lock is checked **before** anything is resolved: a stale request
   * gets the same 409 whether or not it would otherwise have parsed, which
   * keeps „jemand anderes war schneller" from depending on what was typed.
   *
   * Takes no `author` — this
   * write deliberately never sets `updated_by` (see
   * `SystemSettingsRepository.writeMail`), so there is nothing here that
   * would use one.
   */
  async replace(
    request: UpdateSystemMailSettingsRequest,
  ): Promise<SystemMailSettingsResponse> {
    const current = await this.repository.findMailForAdmin();
    const currentLock = current?.mailRevision ?? INITIAL_MAIL_REVISION;
    if (request.lock !== currentLock) {
      throw new ConflictException(STALE_SYSTEM_MAIL_MESSAGE);
    }

    const smtp = this.resolveSmtp(request.smtp, current?.smtp ?? null);

    const written = await this.repository.writeMail(currentLock, {
      smtp,
      publicBaseUrl: request.publicBaseUrl,
      // No `resolve…` step as with the block: the reply address carries no
      // secret that would have to be preserved, so the value that was sent is
      // the whole value.
      replyTo: request.replyTo,
      opsAlertEmail: request.opsAlertEmail,
    });
    if (!written) {
      // Somebody else's mail write landed between the read above and this
      // one — the same tight race `writeFormDefaults` closes for the form
      // standards, on its own counter.
      throw new ConflictException(STALE_SYSTEM_MAIL_MESSAGE);
    }

    return this.compose();
  }

  private async compose(): Promise<SystemMailSettingsResponse> {
    const row = await this.repository.findMailForAdmin();
    return {
      values: this.toDisplay(row),
      lock: row?.mailRevision ?? INITIAL_MAIL_REVISION,
    };
  }

  private toDisplay(row: SystemMailAdminRow | null): SystemMailSettings {
    if (row === null) {
      return {
        smtp: null,
        publicBaseUrl: null,
        replyTo: null,
        opsAlertEmail: null,
      };
    }
    return {
      smtp: this.toSmtpDisplay(row.smtp),
      publicBaseUrl: row.publicBaseUrl,
      replyTo: row.replyTo,
      opsAlertEmail: row.opsAlertEmail,
    };
  }

  /**
   * The stored block, projected for display — **tolerant**, like every other
   * settings read on this superadmin surface:
   * this page is the one place a broken document can be repaired, and a 500
   * here would lock the installation out of doing that. A block that does not
   * parse is shown as „nicht eingerichtet"; saving a fresh, complete one
   * overwrites it.
   */
  private toSmtpDisplay(
    stored: Prisma.JsonValue | null,
  ): SystemSmtpDisplay | null {
    const block = this.parsedOrNull(stored);
    if (block === null) {
      return null;
    }
    return {
      host: block.host,
      port: block.port,
      secure: block.secure,
      authUser: block.auth?.user ?? null,
      from: block.from,
    };
  }

  /**
   * Turns a write into the JSON `smtp` takes — `Prisma.DbNull` for „entfernt",
   * otherwise a sealed block built from the request and, where the password
   * was omitted, from the previously stored ciphertext.
   */
  private resolveSmtp(
    write: SystemSmtpWrite | null,
    storedJson: Prisma.JsonValue | null,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (write === null) {
      return Prisma.DbNull;
    }

    if (write.auth === null) {
      return this.secrets.sealSystemBlock({
        host: write.host,
        port: write.port,
        secure: write.secure,
        auth: null,
        from: write.from,
      });
    }

    if (write.auth.password !== undefined) {
      return this.secrets.sealSystemBlock({
        host: write.host,
        port: write.port,
        secure: write.secure,
        auth: { user: write.auth.user, password: write.auth.password },
        from: write.from,
      });
    }

    // The password was omitted: keep the stored ciphertext, but only for the
    // user it was sealed for. Pairing a *new* username with the *old*
    // ciphertext would not be „unverändert" — it stores a login that was
    // never typed and never worked, and the mismatch only surfaces on the
    // next send, from `mail_log.last_error` (a requirement from security review).
    const storedAuth = this.storedAuth(storedJson);
    if (storedAuth === null) {
      throw fieldError('smtp.auth.password', MISSING_SMTP_PASSWORD_MESSAGE);
    }
    if (storedAuth.user !== write.auth.user) {
      throw fieldError('smtp.auth.password', CHANGED_SMTP_USER_MESSAGE);
    }
    // Not routed through `sealSystemBlock`: `storedAuth.password` is already a
    // ciphertext, and that method's contract is a *plaintext* block — sealing
    // it again would double-encrypt a value nobody ever opened.
    return toJson({
      host: write.host,
      port: write.port,
      secure: write.secure,
      auth: { user: write.auth.user, password: storedAuth.password },
      from: write.from,
    });
  }

  /**
   * The stored `auth` pair, still sealed, or `null` when there is none to
   * keep — no row, no `smtp`, a relay without a login, or a document that
   * does not even parse. All four answer the same way here: a write that
   * omits the password has nothing to fall back on, and the caller refuses
   * it by naming the field, exactly as a genuinely half-filled block would.
   */
  private storedAuth(
    storedJson: Prisma.JsonValue | null,
  ): { readonly user: string; readonly password: string } | null {
    const block = this.parsedOrNull(storedJson);
    return block?.auth ?? null;
  }

  private parsedOrNull(storedJson: Prisma.JsonValue | null): SmtpBlock | null {
    if (storedJson === null) {
      return null;
    }
    const result = smtpBlockSchema.safeParse(storedJson);
    return result.success ? result.data : null;
  }
}

/**
 * A 400 in the shape `parseRequest` produces, so the page can put the message
 * next to the field regardless of whether the schema or this service refused.
 */
function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({
    message: 'Die Anfrage ist ungültig.',
    issues: [{ path, message }],
  });
}

/**
 * Hands a mail document to Prisma as JSON — the same narrow cast
 * `mail-secrets.service.ts` uses for the same reason: the object comes from
 * this service's own fields, holds nothing but strings, numbers, booleans
 * and nulls, and the cast is confined to this one function.
 */
function toJson(document: unknown): Prisma.InputJsonValue {
  return document as Prisma.InputJsonValue;
}
