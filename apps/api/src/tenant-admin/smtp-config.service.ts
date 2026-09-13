import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  parseMailIdentityConfig,
  type MailIdentityConfig,
  type MailIdentityWrite,
} from '@formsache/shared';

import {
  MailConfigUnreadableError,
  MailSecretsService,
  type SealableSmtpBlock,
  type SealedSmtpPassword,
  type SmtpPasswordWrite,
} from '../mail/mail-secrets.service';
import {
  CHANGED_SMTP_USER_MESSAGE,
  MISSING_SMTP_PASSWORD_MESSAGE,
} from '../system-settings/system-mail-admin.service';
import type { TenantScope } from '../tenancy/tenant-scope';
import { TENANT_NOT_FOUND_MESSAGE } from './oidc-config.service';

/**
 * What a save that keeps a password there is none of is told (fail closed) —
 * **the sentence the superadmin mail-settings feature already wrote**, not a second one.
 *
 * The two surfaces ask the same question of two rows, and an editor who
 * configures the installation's mail server one week and an organisation's the next must
 * not meet two different explanations of the same refusal. Re-exported so this
 * module's tests name it from here, where the route is.
 *
 * {@link CHANGED_SMTP_USER_MESSAGE} joins it for the identical reason:
 * a write that changes `auth.user` while omitting
 * `auth.password` is refused with the same sentence `eead295` gave the
 * installation's own block, not a fresh one invented for the organisation's.
 */
export { CHANGED_SMTP_USER_MESSAGE, MISSING_SMTP_PASSWORD_MESSAGE };

/**
 * What the caller is told when the stored block does not match the contract.
 *
 * Without detail, exactly as `UNREADABLE_OIDC_MESSAGE`: whoever sees it is an
 * administrator, not an attacker, and the reason belongs in the log next to the
 * tenant it happened to. The value is never repeated — a block carries a
 * password.
 */
export const UNREADABLE_SMTP_MESSAGE =
  'Die gespeicherte Mail-Konfiguration konnte nicht gelesen werden.';

/**
 * Where the password stands in the request document — **written once**.
 *
 * Since ADR-0023 the block lies in an envelope (`{ smtp: … }`), and the
 * paths Zod reports on a schema error carry this `smtp.` in front.
 * An error thrown by hand without the prefix landed beside it: the
 * interface looks for its field messages at the path, and one it does not
 * find appears only in the collective banner — the message then no longer
 * stands at the field it means.
 */
const SMTP_PASSWORD_FIELD = 'smtp.auth.password';

/**
 * The sending identity of one organisation (the requirements, ADR-0013).
 *
 * **No `PrismaService` in the constructor**, like every other domain service
 * here: the only way to the row is the `TenantScope` the guard chain hands in,
 * and that scope has no way to name a *different* Organisation at all — which is why
 * „der Mailserver einer fremden Organisation ist weder les- noch schreibbar" is
 * structural rather than checked.
 *
 * ## The whole block or none of it
 *
 * There is one write and it replaces the document. That is not convenience: an
 * own sender address on somebody else's transport is signed forgery (ADR-0013
 * no. 2), so „nur die Absenderadresse ändern" must not be expressible — not in
 * the schema, not through a second route, and not by a patch that leaves the
 * other fields as they were.
 *
 * `smtp: null` deletes the block. Since ADR-0023 that means **not** „erbt vom
 * System", but „diese Organisation verschickt nichts": its rows stay
 * `queued` (no `failed`, no attempt) until something stands here again.
 *
 * ## „Unverändert" against „geleert" — mirrored from `SystemMailAdminService`
 *
 * A write that omits `auth.password` keeps the stored **ciphertext**,
 * byte-for-byte, and a write that has nothing to keep is refused with a 400
 * naming the field. That is the same shape the superadmin mail-settings feature built for the
 * installation's block one module over, which in turn copied
 * `OidcConfigService.nextSecret` — one rule, three call sites, no second
 * opinion about what an omitted password means.
 *
 * The one deliberate difference is the **read**: `SystemMailAdminService` shows
 * an unparsable block as „nicht eingerichtet", because for the installation that
 * is an honest description — nothing is set up, so nothing goes out. For an organisation
 * it would be a lie: an unreadable block does not mean „noch keiner eingetragen"
 * (which holds a row `queued`), it means every row of this organisation goes
 * `failed` (ADR-0013 no. 4). This route
 * therefore refuses the read the way `OidcConfigService.toConfig` does, and the
 * `PUT` stays reachable so the row can be repaired by saving a complete block
 * with a fresh password over it.
 *
 * ## What „gesetzt" means is decided here, not by a schema
 *
 * `auth.passwordSet` is {@link MailSecretsService.isPasswordUsable}, so bytes
 * that do not open in *this* Organisation count as not stored — and a save cannot keep
 * them. That is the fail-closed half of the requirement: a password carried into
 * another organisation's column by a raw write makes that organisation's mail visibly
 * unconfigured and repairable, instead of quietly staying in the document
 * forever.
 */
@Injectable()
export class SmtpConfigService {
  private readonly logger = new Logger(SmtpConfigService.name);

  /** Bounded by the number of broken rows, not by traffic — see the service. */
  private readonly reported = new Set<string>();

  constructor(private readonly secrets: MailSecretsService) {}

  /** The block as the *Mailversand*-Reiter reads it. */
  async ofTenant(scope: TenantScope): Promise<MailIdentityConfig> {
    return this.toConfig(await this.storedOf(scope), scope.tenantId);
  }

  /**
   * Replaces the block.
   *
   * The stored document is read **before** the write and consulted for exactly
   * one thing: the password a request without one wants to keep. A save that
   * carries a password never looks at what was there — which is what lets an
   * administrator repair an unreadable block by typing fresh credentials, the
   * same case `OidcConfigService.replaceOfTenant` orders its steps for.
   */
  async replaceOfTenant(
    scope: TenantScope,
    request: MailIdentityWrite,
  ): Promise<MailIdentityConfig> {
    const stored = await this.storedOf(scope);
    const written = await scope.tenant.updateSmtp(
      this.secrets.sealTenantBlock(
        this.nextBlock(request, stored, scope.tenantId),
        scope.tenantId,
      ),
    );
    if (!written) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }

    // Read back rather than echoed: the answer then describes what is *in the
    // column*, `passwordSet` included, and a sealing that somehow did not take
    // is visible immediately instead of at the next send.
    return this.toConfig(await this.storedOf(scope), scope.tenantId);
  }

  /**
   * The `tenant.smtp` column of the session's Organisation — and only that column
   * (a review finding): `TenantScope.tenant.smtp()` is a projection, not
   * `find()`, so this read (twice per `PUT`, see {@link replaceOfTenant})
   * does not carry `oidc_client_secret` and the rest of the row along for a
   * single JSONB field.
   */
  private async storedOf(scope: TenantScope): Promise<unknown> {
    const tenant = await scope.tenant.smtp();
    if (tenant === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return tenant.smtp;
  }

  /**
   * The stored block as the wire contract describes it — **and parsed against
   * that contract before it leaves.**
   *
   * `parseMailIdentityConfig` is the second gate, the one
   * `OidcConfigService.toConfig` also applies: the column is JSONB and a
   * hand-edited row can hold anything. Refusing with a 500 keeps the read
   * honest; the `PUT` stays reachable, so the tab can repair the row by saving
   * a complete block over it.
   */
  private toConfig(stored: unknown, tenantId: string): MailIdentityConfig {
    let block;
    try {
      block = this.secrets.storedTenantBlock(stored);
    } catch (error: unknown) {
      if (!(error instanceof MailConfigUnreadableError)) {
        throw error;
      }
      // The reason is already in the log, written once by `MailSecretsService`;
      // this line names the organisation, which is what makes it findable. Neither the
      // document nor any value of it is repeated.
      this.reportOnce(
        `Stored mail identity of tenant ${tenantId} does not match the wire contract.`,
      );
      throw new InternalServerErrorException(UNREADABLE_SMTP_MESSAGE);
    }

    if (block === null) {
      // „Noch keiner eingetragen" (ADR-0023) — no error state, and
      // expressly no longer „erbt vom System": this Organisation
      // sends nothing until something stands here, and the card says so.
      return parseMailIdentityConfig({ smtp: null });
    }
    return parseMailIdentityConfig({
      smtp: {
        host: block.host,
        port: block.port,
        secure: block.secure,
        from: block.from,
        auth:
          block.auth === null
            ? null
            : {
                user: block.auth.user,
                // Never the value, and never „es steht etwas in der Spalte":
                // whether it opens **here** is the question.
                passwordSet: this.secrets.isPasswordUsable(
                  block.auth.password,
                  tenantId,
                ),
              },
      },
    });
  }

  /** The document that is about to be sealed into the column. */
  private nextBlock(
    request: MailIdentityWrite,
    stored: unknown,
    tenantId: string,
  ): SealableSmtpBlock | null {
    if (request.smtp === null) {
      // Deleting the mail server is a permitted action with a visible
      // consequence: afterwards this Organisation sends nothing any more, and
      // the card says so before saving.
      return null;
    }
    return {
      host: request.smtp.host,
      port: request.smtp.port,
      secure: request.smtp.secure,
      from: request.smtp.from,
      auth:
        request.smtp.auth === null
          ? null
          : {
              user: request.smtp.auth.user,
              password: this.nextPassword(request.smtp.auth, stored, tenantId),
            },
    };
  }

  /**
   * The two states of the password on a write, resolved once.
   *
   * A string replaces it; **absent** means „lass das gespeicherte stehen",
   * which is the ordinary case — the page never held the password, so it cannot
   * send it back (`mailIdentityWriteSchema`), and somebody correcting a port
   * has no reason to retype credentials they may not even have.
   *
   * The kept password travels as **ciphertext**, exactly as
   * `OidcConfigService.nextSecret` writes the stored bytes back unchanged. It is
   * not opened and re-sealed: a save that changes a port has no business
   * decrypting a password, and the type says which of the two this is
   * (`SmtpPasswordWrite`), so it cannot be sealed a second time by accident.
   *
   * **Mirrored from `SystemMailAdminService.resolveSmtp`, following the same
   * review finding:** a write that omits the password is only allowed to
   * keep the stored ciphertext for the **user it was sealed for**. Pairing a
   * *changed* `auth.user` with the *old* ciphertext would store a login
   * nobody typed — it would parse, it would seal, and it would fail only at
   * the next send, with nothing in this request that said why. Until this
   * package, the only place that refused it was the web client
   * (`MailIdentityCard`'s `usernameChangedWithoutNewPassword`), which is
   * comfort, not a boundary (`CONTRIBUTING.md`) — a request built past that
   * client reached this method and was accepted.
   */
  private nextPassword(
    auth: { readonly user: string; readonly password?: string | undefined },
    stored: unknown,
    tenantId: string,
  ): SmtpPasswordWrite {
    if (auth.password !== undefined) {
      return { kind: 'typed', value: auth.password };
    }
    const storedAuth = this.storedAuth(stored, tenantId);
    if (storedAuth === null) {
      // Fail closed. The alternative — storing the block with no credentials —
      // would be an own transport that silently authenticates as nobody, and
      // the first anybody heard of it would be a `failed` row.
      throw fieldError(SMTP_PASSWORD_FIELD, MISSING_SMTP_PASSWORD_MESSAGE);
    }
    if (storedAuth.user !== auth.user) {
      throw fieldError(SMTP_PASSWORD_FIELD, CHANGED_SMTP_USER_MESSAGE);
    }
    return { kind: 'stored', value: storedAuth.password };
  }

  /**
   * The stored `auth` pair, still sealed, or `null` when there is none to
   * keep — no `smtp` document, a relay without a login, a document that does
   * not parse, or a password that does not open in **this** Organisation.
   *
   * A block that does not parse answers `null` rather than refusing the whole
   * save: the write is the way *out* of a broken row, and a caller who has to
   * repair one has to be able to — with a fresh password, which is the only
   * thing they can honestly supply.
   */
  private storedAuth(
    stored: unknown,
    tenantId: string,
  ): { readonly user: string; readonly password: SealedSmtpPassword } | null {
    let block;
    try {
      block = this.secrets.storedTenantBlock(stored);
    } catch {
      return null;
    }
    if (block?.auth == null) {
      return null;
    }
    return this.secrets.isPasswordUsable(block.auth.password, tenantId)
      ? { user: block.auth.user, password: block.auth.password }
      : null;
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
 * A 400 in the shape `parseRequest` produces, so the tab can put the message
 * next to the field regardless of whether the schema or the server refused.
 *
 * Spelled out here as well as in `oidc-config.service.ts` — five lines against
 * an import that would tie the SMTP route's error shape to the login route's
 * internals. What must not drift is the *shape*, and that is
 * `parseRequest`'s, which both of them copy.
 */
function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({
    message: 'Die Anfrage ist ungültig.',
    issues: [{ path, message }],
  });
}
