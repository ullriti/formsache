import { Injectable, Logger } from '@nestjs/common';
import {
  describeMailConfigError,
  parseStoredSmtpBlock,
  type SmtpBlock,
} from '@formsache/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import {
  systemSecretContext,
  tenantSmtpContext,
} from '../common/secret-box/secret-context';

/** The one secret an SMTP block holds — see `secret-context.ts`. */
const SMTP_PASSWORD = 'smtp.password';

/**
 * A stored mail configuration that cannot be used — **for either reason**.
 *
 * The two reasons are a mixed or unparsable document (ADR-0013 no. 4) and a
 * sealed password that does not open here, and they are one
 * error class on purpose: the answer to both is the same one, „diese Zeile geht
 * `failed` mit lesbarem Grund", and a caller that had to tell them apart would
 * be a caller that could get one of them wrong.
 *
 * **The message is read by an editor** in the mail log, so it is German
 * and free of ids. It never carries a value: a block holds a password, and an
 * error message is the single most likely thing in an application to be pasted
 * into a chat.
 */
export class MailConfigUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailConfigUnreadableError';
  }
}

/** What a mixed or half-filled document is answered with. */
export const MAIL_CONFIG_UNPARSABLE_REASON =
  'Die gespeicherte Mail-Konfiguration ist unvollständig oder widersprüchlich; ' +
  'es wurde nichts gesendet.';

/** What a password that does not open is answered with. */
export const MAIL_PASSWORD_UNREADABLE_REASON =
  'Das gespeicherte SMTP-Passwort konnte nicht entschlüsselt werden; ' +
  'es wurde nichts gesendet.';

/**
 * The brand that keeps „ciphertext" and „plaintext" apart **in the type
 * system**, because they are the same `string` at runtime.
 *
 * ## The mistake it makes unspellable
 *
 * `open…` hands back a block whose `auth.password` is plaintext, and `seal…`
 * used to take a block of exactly that shape. A read-modify-write caller — the
 * *Mailversand*-Reiter, where somebody corrects a port without retyping
 * credentials — therefore had a spelling that compiles and is wrong: read the
 * stored document, change a field, hand it back to `seal…`. The password is
 * sealed **a second time**, the column holds a doubly wrapped value, and
 * nothing notices until the next mail fails to go out with „konnte nicht
 * entschlüsselt werden". There was no production caller when this was written
 * down (a review finding); the first one arrived later, which is why the
 * marker arrives with it rather than after it.
 *
 * The direction of the brand is deliberate and is the only one that works: the
 * value that comes **out of the column** is branded, and {@link
 * SealableSmtpBlock} — what goes *in* — is not merely „a block", it is a
 * block whose password says which of the two it is. So neither a
 * {@link SealedSmtpBlock} nor an opened `SmtpBlock` is assignable to the
 * parameter of {@link MailSecretsService.sealTenantBlock}, and both attempts
 * are compile errors rather than a value nobody can open again.
 *
 * ⚠️ **Vitest does not see any of this** (SWC strips types). The proof hangs off
 * `pnpm typecheck`, exactly as ADR-0013 no. 1 says for the block itself.
 */
declare const SEALED_SMTP_PASSWORD: unique symbol;

/** A password **as it stands in the column**: ciphertext, never sealed twice. */
export type SealedSmtpPassword = string & {
  readonly [SEALED_SMTP_PASSWORD]: 'smtp.password';
};

/** The credentials of a stored block, unopened — a pair or nothing. */
export interface SealedSmtpAuth {
  readonly user: string;
  readonly password: SealedSmtpPassword;
}

/**
 * A stored block, parsed and **not** opened — the marker type of ADR-0013's
 * sealing seam.
 */
export type SealedSmtpBlock = Omit<SmtpBlock, 'auth'> & {
  readonly auth: SealedSmtpAuth | null;
};

/**
 * Where a password on its way **into** the column comes from.
 *
 * Discriminated at runtime, not merely branded, because the service has to
 * *act* differently on the two: a typed password is sealed, a kept one is
 * written through untouched. A brand alone would be invisible at run time and
 * would leave the service guessing — which is the guess that produced the
 * double seal in the first place.
 */
export type SmtpPasswordWrite =
  /** Somebody just typed it. It is sealed on the way in. */
  | { readonly kind: 'typed'; readonly value: string }
  /**
   * The one already in the column, kept because the request carried none.
   *
   * It travels as ciphertext and is **not** opened on the way past: a save that
   * only changes the port has no business decrypting a password, and the
   * shorter the plaintext's life the fewer places it can escape from.
   */
  | { readonly kind: 'stored'; readonly value: SealedSmtpPassword };

/** The credentials on their way in — the pair, or nothing at all. */
export interface SmtpAuthWrite {
  readonly user: string;
  readonly password: SmtpPasswordWrite;
}

/** What {@link MailSecretsService.sealTenantBlock} accepts, and only it. */
export type SealableSmtpBlock = Omit<SmtpBlock, 'auth'> & {
  readonly auth: SmtpAuthWrite | null;
};

/**
 * Sealing and opening the **third** database secret of this application
 * (ADR-0013 no. 6) — for both levels, in one file.
 *
 * ## Why one service for the system row and for an organisation
 *
 * They are the same secret in two places, and the thing that must never drift
 * is *which context each is sealed under*. Two services would be two answers to
 * that question, and the second one to be written would look at the first for
 * guidance — which is how `access.password` nearly ended up with one context
 * built two ways (`secret-context.ts`). Here the two contexts are three lines
 * apart and cannot be read without seeing both.
 *
 * The installation's password is bound to {@link systemSecretContext} — a
 * holder with **no id**, because `system_setting` belongs to no organisation — and a
 * organisation's to {@link tenantSmtpContext}, naming that organisation. So a value sealed for
 * one never opens in the other, in either direction, and neither opens as an
 * OIDC client secret or as a form's access word.
 *
 * ## Sealed on the way in, opened on the way out, plaintext in between
 *
 * Exactly the shape `SettingsSecretsService` has for the access word: everything
 * between `open…` and `seal…` is plaintext, so a block copied from one holder
 * to another carries a *password*, not a ciphertext that would then be
 * unopenable in its new place.
 *
 * ## What this service does **not** do
 *
 * It does not read a row and it does not build a transport. It is handed a
 * stored document and hands back a value, which is what lets the identity
 * resolution be a pure function next to the worker rather than
 * inside it.
 */
@Injectable()
export class MailSecretsService {
  /** Where the *reason* goes; a caller only ever learns that it failed. */
  private readonly logger = new Logger(MailSecretsService.name);

  /**
   * Which „cannot be opened"-lines have already been written, so each is
   * written **once per process lifetime** — the same set and the same reason as
   * in `SettingsSecretsService` and `OidcSecretsService`.
   *
   * It matters here as much as there: the worker retries a failing row under
   * the backoff, so a broken block would otherwise write a line per
   * attempt, per row, forever. Keyed by the finished message, which is built
   * from a context — a holder, an id out of the database and a fixed field name
   * — and is therefore bounded by the number of broken rows.
   */
  private readonly reported = new Set<string>();

  constructor(private readonly box: SecretBoxService) {}

  /**
   * The installation's own mail server, opened — or `null` for „noch nicht
   * eingerichtet".
   *
   * `null` is a first-class answer and **not** a failure (ADR-0013 no. 5): the
   * queue leaves such rows `queued` with the same reason, because nothing
   * was attempted and nothing refused. That is the property which lets an
   * installation come up before anybody has sorted out a mail server, and it is
   * why this method cannot simply throw on everything that is not a block.
   */
  openSystemBlock(stored: unknown): SmtpBlock | null {
    const block = this.parsed(() => parseStoredSmtpBlock(stored));
    if (block === null) {
      return null;
    }
    return this.openPassword(block, systemSecretContext(SMTP_PASSWORD));
  }

  /** The installation's block on the way into `system_setting.smtp`. */
  sealSystemBlock(block: SmtpBlock): Prisma.InputJsonValue {
    return toJson(this.sealPassword(block, systemSecretContext(SMTP_PASSWORD)));
  }

  /**
   * An organisation's own mail server, opened — or `null` for „noch keiner
   * eingetragen" (ADR-0023).
   *
   * **`null` is not „erbt vom System" any more.** Until ADR-0023 an empty
   * column meant „diese Organisation sendet über den Block der Installation";
   * it now means the organisation sends nothing at all until somebody enters a
   * mail server, and the caller answers that with `withhold` rather than with
   * somebody else's transport ({@link MailIdentityService}). Same value, same
   * spelling, opposite consequence — which is why every reader of this method
   * was revisited rather than left compiling.
   *
   * Everything that is not NULL is parsed strictly. A mixed or half-filled
   * document is refused rather than partially used, which is the *fail closed*
   * of ADR-0013 no. 4: a stored block with an alien transport and an own sender
   * address is signed forgery, and a document that expresses half of it is a
   * state the application cannot produce and does not interpret.
   */
  openTenantBlock(stored: unknown, tenantId: string): SmtpBlock | null {
    const block = this.parsed(() => parseStoredSmtpBlock(stored));
    if (block === null) {
      return null;
    }
    return this.openPassword(block, tenantSmtpContext(tenantId, SMTP_PASSWORD));
  }

  /**
   * An organisation's stored block, **parsed and not opened** — or `null`.
   *
   * What the *Mailversand*-Reiter reads: it shows host, port and user, and for
   * the password only whether one is stored ({@link isPasswordUsable}). Opening
   * it to answer that would put a plaintext into a request that has no use for
   * one.
   *
   * A mixed or half-filled document is refused here as well — the parse is the
   * same one the send path makes, so the surface cannot show a state the worker
   * would refuse (ADR-0013 no. 4).
   */
  storedTenantBlock(stored: unknown): SealedSmtpBlock | null {
    // The one cast in this file, and it only narrows: `parseStoredSmtpBlock`
    // types the password as the `string` it is at runtime, and the brand
    // records *where that string came from* — a fact no schema can carry.
    // Everything this method can hand back came out of the column, which is
    // precisely what {@link SealedSmtpPassword} means.
    return this.parsed(() =>
      parseStoredSmtpBlock(stored),
    ) as SealedSmtpBlock | null;
  }

  /**
   * Whether a stored password opens **in this organisation** — „gesetzt" in the sense
   * of the requirement.
   *
   * The same posture `OidcSecretsService.isUsable` takes, and for the same
   * reason: a value carried into this row by a raw write is not a password this
   * Organisation has, so it counts as absent. That is the fail-closed reading — the tab
   * says „nicht gesetzt", the save refuses to keep a password there is none of,
   * and the row is repairable by typing a new one.
   */
  isPasswordUsable(password: SealedSmtpPassword, tenantId: string): boolean {
    try {
      this.box.open(password, tenantSmtpContext(tenantId, SMTP_PASSWORD));
      return true;
    } catch {
      // Not reported: this is a question, not a failure, and it is asked on
      // every read of the tab.
      return false;
    }
  }

  /**
   * An organisation's mail server on the way into `tenant.smtp`.
   *
   * `Prisma.DbNull` for „kein Mailserver", because **NULL is the one spelling
   * of that state**: a document that said so in JSON would be a second
   * spelling, and the second one is the one a future query forgets.
   *
   * **It does not take what `open…` or {@link storedTenantBlock} hand
   * back** — see {@link SealedSmtpPassword} for the double seal that shape
   * invited. A caller says which password it means, and „the one already in the
   * column" is written through untouched rather than sealed again.
   */
  sealTenantBlock(
    block: SealableSmtpBlock | null,
    tenantId: string,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (block === null) {
      return Prisma.DbNull;
    }
    // Field by field rather than a spread, the discipline `tenant-scope.ts`
    // states for its writes: an interface is nothing at run time, so a caller's
    // object that carried an extra key would otherwise reach the column — and
    // `strictObject` would then refuse the document on the way back out.
    return toJson({
      host: block.host,
      port: block.port,
      secure: block.secure,
      from: block.from,
      auth:
        block.auth === null
          ? null
          : {
              user: block.auth.user,
              password: this.passwordFor(block.auth.password, tenantId),
            },
    });
  }

  /**
   * Runs a shared parse and turns its `ZodError` into the one error this
   * service has.
   *
   * The `ZodError` is **not** chained: Zod prints the value it choked on, and
   * that value is a mail configuration. What survives is the field name, which
   * is what makes the line actionable (`describeMailConfigError`).
   */
  private parsed<T>(parse: () => T): T {
    try {
      return parse();
    } catch (cause: unknown) {
      if (!(cause instanceof z.ZodError)) {
        throw cause;
      }
      // The field names go to the log, not to the editor: „port fehlt" is a
      // server fact, and the mail log says what to do, not what broke.
      this.reportOnce(
        `Stored mail configuration does not parse: ${describeMailConfigError(cause)}`,
      );
      throw new MailConfigUnreadableError(MAIL_CONFIG_UNPARSABLE_REASON);
    }
  }

  private openPassword<T extends SmtpBlock>(block: T, context: string): T {
    if (block.auth === null) {
      // A relay without a login is a supported operating mode — the `.env`
      // always allowed one, and dropping it silently would be an unannounced
      // regression.
      return block;
    }
    try {
      return {
        ...block,
        auth: {
          user: block.auth.user,
          password: this.box.open(block.auth.password, context),
        },
      };
    } catch {
      // Neither the sealed value nor a plaintext reaches the log — only the
      // context, which is a holder, an id and a field name (`CONTRIBUTING.md`).
      // `SecretBoxError`'s own message is dropped rather than chained: this code
      // must not depend on somebody keeping those messages free of their input.
      this.reportOnce(`Stored secret at ${context} cannot be opened.`);
      throw new MailConfigUnreadableError(MAIL_PASSWORD_UNREADABLE_REASON);
    }
  }

  /** The stored ciphertext, or a freshly typed password sealed. */
  private passwordFor(password: SmtpPasswordWrite, tenantId: string): string {
    if (password.kind === 'stored') {
      return password.value;
    }
    return this.box.seal(
      password.value,
      tenantSmtpContext(tenantId, SMTP_PASSWORD),
    );
  }

  private sealPassword<T extends SmtpBlock>(block: T, context: string): T {
    if (block.auth === null) {
      return block;
    }
    return {
      ...block,
      auth: {
        user: block.auth.user,
        password: this.box.seal(block.auth.password, context),
      },
    };
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}

/**
 * Hands a mail document to Prisma as JSON.
 *
 * The documents come from the shared schemas and hold nothing but strings,
 * numbers, booleans and nulls; the cast is confined to this one function rather
 * than repeated at each write.
 */
function toJson(document: unknown): Prisma.InputJsonValue {
  return document as Prisma.InputJsonValue;
}
