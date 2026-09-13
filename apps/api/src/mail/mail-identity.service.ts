import { Injectable } from '@nestjs/common';
import type { SmtpBlock } from '@formsache/shared';
import type { NotificationTrigger, Prisma } from '@prisma/client';

import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import {
  MailConfigUnreadableError,
  MailSecretsService,
} from './mail-secrets.service';
import {
  MAIL_NOT_CONFIGURED_REASON,
  TENANT_MAIL_NOT_CONFIGURED_REASON,
} from './mail-transport';

/**
 * Which sending identity applies to one `mail_log` row — **three answers, and
 * they are not two** (ADR-0013 no. 4 and no. 5).
 *
 * ## Why three arms and not „block or error"
 *
 * ADR-0013 no. 5 separates three states that look alike from the outside and
 * are not:
 *
 * | State | Answer |
 * |---|---|
 * | The mail server in charge is entered | {@link SendIdentity} |
 * | **None** is entered | {@link WithholdIdentity} |
 * | Stored block unparsable, mixed or not openable | {@link FailIdentity} |
 *
 * The second row is the one that gets folded into the third by whoever is in a
 * hurry, and folding it costs exactly the property that makes a freshly set-up
 * installation usable: nothing was attempted and nothing was
 * refused, so the row stays `queued`, burns **no** attempt, and a mail server
 * entered next week still sends it. A `failed` there would be a lie about an
 * attempt that never happened — and one that cannot be undone by fixing the
 * configuration, because `failed` is where a row stops.
 *
 * ⚠️ **Since ADR-0023 there is no fourth answer „then over the mail server of
 * the installation instead".** An organisation without its own mail server
 * inherits nothing; its rows wait. The instance block is the operator's
 * and never becomes the substitute for a missing one — see
 * {@link MailIdentitySource}.
 *
 * ## What this is not
 *
 * No retry, no backoff, no transport, no queue. This answers one question and
 * returns; **the mail worker** decides what each arm does to the row, and
 * the split is the same one that put `settings-enforcement.ts` next to
 * `public-forms.service.ts` rather than inside it. A resolution that knew
 * about attempts would have to be re-read every time the backoff changes.
 */
export type MailIdentityResolution =
  SendIdentity | WithholdIdentity | FailIdentity;

/** There is a usable block — the organisation's own, or the installation's. */
export interface SendIdentity {
  readonly kind: 'send';
  /**
   * Whose identity this is.
   *
   * Carried because the two are **not** interchangeable further down: it is
   * what a per-Organisation transport cache is keyed by (ADR-0013 no. 7), and it is
   * what a test asserts on when it wants to know that no fallback happened. A
   * caller that only needs to send may ignore it.
   */
  readonly source: 'system' | 'own';
  /** Ready to hand to a transport: the password is **open**. */
  readonly block: SmtpBlock;
}

/**
 * What a {@link SendIdentity} is **recorded** as once an attempt has happened
 * (the requirement) — the two `mail_log` columns, as a value.
 *
 * Deliberately not the block: a password has no business travelling towards a
 * table that is kept for ninety days and read in a browser. What is kept is the
 * kind of block and the address it sends from, which is what an operator asks
 * about when SPF or DKIM starts refusing.
 */
export interface AttemptedIdentity {
  readonly source: 'system' | 'own';
  /** The block's `From` address — never the organisation's display name. */
  readonly address: string;
}

/**
 * The one place a resolved identity becomes the record of an attempt.
 *
 * **One spelling for both senders.** The queue worker and „Testmail senden"
 * both resolve through {@link MailIdentityService} and both write the outcome
 * themselves; two hand-written object literals would be two answers to „was
 * steht im Protokoll", and the day one of them starts recording the display
 * name instead of the address, only one half of the application would be wrong
 * — the half nobody is looking at.
 */
export function attemptedIdentity(identity: SendIdentity): AttemptedIdentity {
  return { source: identity.source, address: identity.block.from };
}

/**
 * The two `mail_log` columns as Prisma data — one spelling for every write, so
 * „gesendet" and „fehlgeschlagen" cannot drift into recording different things,
 * and so „Testmail senden" records what the queue records.
 *
 * **Here and not in `mail-queue.repository.ts`, although the queue is its
 * loudest caller.** That file's own header sends anyone tempted to reuse it
 * from a request-facing service to read `mail.module.ts` first — and
 * `TestMailService` *is* request-facing. Putting a pure column mapping there
 * would have made „import the queue repository" the ordinary way to record an
 * identity, which is precisely the habit that header exists to discourage.
 * This module reaches no row and holds no `PrismaService`; it is where the
 * identity is decided, so it is where the identity's spelling belongs.
 *
 * ## Why every outcome write takes an identity, and takes it required
 *
 * The columns are written „beim Senden, nicht beim Einreihen", and the only way
 * to make that hold is to put the value where the *outcome* is written and
 * nowhere else. A parameter with a default — or one a caller may omit — would
 * let the next `markFailed` slip through silently and leave a `failed` row that
 * cannot say which block refused it, which is exactly the evidence of the requirement. Required and nullable, so each call site answers out loud:
 *
 * | Place | Value |
 * |---|---|
 * | `markSent` after an attempt | the identity used |
 * | `markRetry`/`markFailed` after an attempt | the same |
 * | `markFailed` because of a broken configuration | `null` — nothing was resolved |
 * | `withholdClaimed` (no mail server) | does not write them at all — no attempt |
 *
 * `null` **clears** both rather than leaving them: a row that failed without
 * resolving an identity must not keep the one a previous attempt used, or „↻
 * Erneut" plus a broken block would leave the old block's name standing beside
 * the new failure.
 */
export function mailIdentityColumns(
  identity: AttemptedIdentity | null,
): Pick<
  Prisma.MailLogUncheckedUpdateInput,
  'senderIdentity' | 'senderAddress'
> {
  if (identity === null) {
    return { senderIdentity: null, senderAddress: null };
  }
  return { senderIdentity: identity.source, senderAddress: identity.address };
}

/**
 * Nothing is set up — no mail server is entered for whoever this row goes out
 * under.
 *
 * Since ADR-0023 that is one of two independent facts and never a mixture: an
 * organisation without a mail server (its rows wait) or an installation
 * without one (the operator's own mail waits). Neither borrows the other's.
 *
 * The row stays `queued`, keeps its attempt counter and is **not** `failed`.
 */
export interface WithholdIdentity {
  readonly kind: 'withhold';
  /** The sentence of the requirement, so the mail log says why. */
  readonly reason: string;
}

/**
 * The stored configuration cannot be used: mixed, half-filled, or a password
 * that does not open here.
 *
 * The row goes `failed` with this reason. It is **not** answered with the
 * system block — that is the whole of the requirement and of ADR-0013 no. 4: what
 * somebody meant to send under their own identity must not go out under the
 * installation's because a value was broken.
 */
export interface FailIdentity {
  readonly kind: 'fail';
  /** German, actionable, and free of ids and values — an editor reads it. */
  readonly reason: string;
}

/**
 * The identity resolution the mail queue asks once per row.
 *
 * **A file of its own next to the worker, not a method inside it**
 * (ADR-0013 „Consequences"). It reaches no `mail_log` row, claims nothing and
 * knows no `MailTransport`; what it needs is an organisation and its stored column, and
 * what it hands back is one of the three arms above.
 *
 * ## Fail closed, in both directions
 *
 * There is **no path in this class from the `'tenant'` arm to the system
 * block.** Not on a parse failure, not on a password that will not open, not
 * on an empty column — and, since this class never touches a socket, not on a
 * refused connection either: the tenant arm resolves to `send`/`own`,
 * `withhold` or `fail`, so when that transport refuses, the worker has nothing
 * to fall back to. That absence is the whole of this class's fail-closed
 * design, and it is an absence rather than a check, which is why the
 * reproduction („ein `?? systemTransport` einbauen") has to be performed
 * somewhere else to be performed at all.
 *
 * Since ADR-0023 that is no longer a subtlety for the error case but the
 * normal case: an organisation without a mail server does not inherit, it waits.
 *
 * ## A broken **system** block answers, it does not throw
 *
 * `openSystemBlock` throws `MailConfigUnreadableError` for a system row that
 * does not parse. Before this class, that exception left the worker: it was
 * raised before any row was claimed, so **no** row got a `last_error` and the
 * only trace was one line in a log nobody was watching — fail *silent*
 * (a review finding). Here it becomes a `fail` answer, so every affected row
 * says in the mail log what is wrong. Anything that is not a
 * `MailConfigUnreadableError` is still thrown: a defect is not a mail problem.
 */
@Injectable()
export class MailIdentityService {
  constructor(
    private readonly systemSettings: SystemMailSettingsService,
    private readonly secrets: MailSecretsService,
  ) {}

  /**
   * The identity of one row, resolved.
   *
   * The organisation's stored column is a **parameter** rather than something this
   * class fetches: the queue already joins `tenant` when it claims a row
   * (`MailQueueRepository.claim`), and a second read per mail would be one
   * query per row for a value that was already in hand — as well as a second
   * moment at which „welcher Organisation?" is answered, which is the drift
   * `CONTRIBUTING.md` warns about. The **system** block is read here, and only
   * on the `'system'` arm; it must be fresh, because a superadmin who enters a
   * mail server expects the next run to use it (no cache, ADR-0011).
   *
   * **`smtp` is `Prisma.JsonValue | null`, not `unknown`.**
   * `unknown` would accept `undefined` — the shape `tenant?.smtp` produces, or a
   * `select` that forgets the column — and this method reads a missing value the
   * same as a genuine NULL, i.e. „diese Organisation hat keinen Mailserver".
   * Since ADR-0023 that no longer misdirects a mail, it silently *withholds*
   * one: the row waits forever with a reason that is not true, and nothing
   * turns red because nothing was attempted. Prisma's `Tenant.smtp` (`Json?`)
   * is `JsonValue | null` on a hit and never `undefined`, so this parameter is
   * widened that far and no further — a forgotten or optional column becomes a
   * `pnpm typecheck` failure at the call site instead of a queue that quietly
   * stops.
   */
  async resolve(
    tenant: {
      readonly id: string;
      readonly smtp: Prisma.JsonValue | null;
    },
    source: MailIdentitySource,
  ): Promise<MailIdentityResolution> {
    if (source === 'system') {
      // **A system mail does not see the organisation's column at all.** No
      // fallback, no „in case the organisation has one" — the branch ends
      // here, before `tenant.smtp` is read. See
      // {@link MailIdentitySource} for the attack this closes, and for
      // the one special case this branch has carried since ADR-0023.
      return this.systemIdentity();
    }

    if (storedSmtpMissing(tenant)) {
      // **The check sits here, at the bottleneck, not at a caller.** It used to
      // stand in `MailWorkerService` — which was true of the one caller that
      // existed and false of the second the moment the Testmail arrived: a new
      // caller does not inherit a guard that lives in somebody else's method.
      throw new MailIdentityColumnMissingError(
        'mail identity resolution got no tenant smtp column — refusing to send',
      );
    }

    let block: SmtpBlock | null;
    try {
      block = this.secrets.openTenantBlock(tenant.smtp, tenant.id);
    } catch (error: unknown) {
      return refusal(error);
    }

    if (block === null) {
      // **No fallback to the block of the installation** (ADR-0023). This
      // organisation has entered no mail server, so nothing goes out from
      // it — the row stays `queued`, without an attempt and without a
      // consumed attempt, and the reason says who has something to do.
      //
      // The line below it is the actual assurance of this class and
      // it is an **absence**: there is no way from here to
      // `systemIdentity()`. Whoever builds one in builds the inheritance back in.
      return { kind: 'withhold', reason: TENANT_MAIL_NOT_CONFIGURED_REASON };
    }

    // Field by field, so nothing but the five fields of a block travels into a
    // value that is handed to a transport — and so adding a field to the block
    // is a compile error here rather than a key that silently rides along.
    return {
      kind: 'send',
      source: 'own',
      block: {
        host: block.host,
        port: block.port,
        secure: block.secure,
        auth: block.auth,
        from: block.from,
      },
    };
  }

  /**
   * The block of the **installation** — the operator's mail server.
   *
   * Who gets it stands at {@link MailIdentitySource}: the operational alarms,
   * the test mail of the system administration and the one named special case.
   * An organisation never gets it (ADR-0023).
   *
   * One method instead of several copies, because every one of these paths
   * owes the same three answers: the block, „nicht eingerichtet" (`withhold`,
   * no attempt, no `failed`) and „unlesbar" (`fail`).
   */
  /**
   * Der Block der Installation, **ohne dass es dafür eine Organisation
   * braucht** (Review-Runde 3 Nr. 12).
   *
   * `resolve(tenant, 'system')` ist dasselbe, nur mit einem Parameter, den
   * dieser Zweig gar nicht liest — und genau daraus wurde eine Bedingung, die
   * es nie gab: die Testmail der Systemverwaltung verlangte eine aktive
   * Organisation, weil `resolve` eine wollte. Wer hier steht, hat nichts zu
   * bieten, das eine Organisation wäre, und braucht auch nichts.
   *
   * Öffentlich, damit `TestMailService` sie ohne Umweg aufrufen kann;
   * `resolve` ruft dieselbe Methode und bleibt der Weg für alles, was eine
   * Zeile einer Organisation verschickt.
   */
  systemBlock(): Promise<MailIdentityResolution> {
    return this.systemIdentity();
  }

  private async systemIdentity(): Promise<MailIdentityResolution> {
    let block: SmtpBlock | null;
    try {
      block = this.secrets.openSystemBlock(
        await this.systemSettings.storedSmtp(),
      );
    } catch (error: unknown) {
      return refusal(error);
    }
    if (block === null) {
      // „Nicht eingerichtet" — not a fault, and deliberately not a `fail`.
      return { kind: 'withhold', reason: MAIL_NOT_CONFIGURED_REASON };
    }
    return { kind: 'send', source: 'system', block };
  }
}

/**
 * Under whose identity a row **may** go out — a mandatory argument
 * of {@link MailIdentityService.resolve} (ADR-0020).
 *
 * ## The attack this closes
 *
 * Previously `resolve` always read the `smtp` column of the organisation the
 * row belongs to. For a form confirmation that is exactly right (ADR-0013).
 * For the **reset mail** it was a privilege escalation, and one that went
 * straight past `can_manage_users`:
 *
 * 1. Somebody with `can_manage_settings` enters an SMTP host of their own
 *    under *Mailversand* — a right the organisation grants regularly.
 * 2. They request „Passwort vergessen" **unauthenticated** for the address of
 *    a superadmin. The reset mail is queued under the oldest living
 *    membership of that account — in a typical installation
 *    exactly this organisation.
 * 3. The worker hands its relay the fully rendered mail **with the
 *    plaintext link**. No click by the victim needed.
 *
 * ADR-0020 expressly keeps `can_manage_settings` away from that account
 * (`requireOwnAccount` demands `can_manage_users` *and* an account that
 * belongs to this organisation alone). Over the wire the boundary did not
 * stand until here.
 *
 * ## What `'system'` has meant since ADR-0023 — and what it no longer means
 *
 * The value was once two things: „the identity of the installation" **and** the
 * exit that every inheriting organisation took. The second half is gone. What
 * remains is the mail server of the **operator**, and it has exactly three
 * recipients:
 *
 * 1. the **operational alarms** (`OpsAlertService`, ADR-0016) — they belong to
 *    the installation and to no organisation;
 * 2. the **test mail of the system administration** (`SystemTestMailController`)
 *    — it checks exactly this block, and were it derivable from what an
 *    organisation has stored, it would check the wrong one;
 * 3. ⚠️ **the one special case: an account that belongs to no organisation.**
 *    Typically a superadmin without a membership. For them there is no
 *    organisation mail server an account mail could go over, and without
 *    this exit they would have no way back into their account at all. That
 *    is an **exception with a name**, not a fallback: it takes effect because
 *    there is no organisation, never because an organisation has no mail server.
 *
 * What `'system'` expressly is **no longer**: the substitute for a
 * missing mail server of an organisation. An organisation without its own
 * block sends nothing (`withhold`), and that is reported visibly in the
 * organisation administration instead of going quietly over somebody else's
 * SPF/DKIM.
 *
 * ## Why a mandatory argument and not a default
 *
 * A `source` with the default `'tenant'` would be the forgetful construction
 * that this project has already had as a finding twice („eine Option, die ein
 * Aufrufer weglassen kann"). This way **every** call site answers the question
 * out loud, and a new kind of mail cannot skip it.
 */
export type MailIdentitySource = 'tenant' | 'system';

/**
 * Which identity a log row may carry — derived from **one**
 * column, at one place.
 *
 * The mapping „`trigger = system` ⟹ system identity" stands here and not in
 * an `if` in the worker, so that it has one version: the worker asks, the
 * lane check asks the same, the mail log asks it for „↻ Erneut",
 * and a fourth caller will get the same answer.
 *
 * ⚠️ **The narrower meaning since ADR-0023.** `trigger = 'system'` now means
 * „this row belongs to the installation", no longer „this row belongs to an
 * organisation but goes out over the installation". Everything an
 * organisation sends goes over that organisation's own mail server — there is
 * no row left that sends an organisation out over somebody else's SPF/DKIM
 * because it has no block of its own.
 */
export function identitySourceOf(
  trigger: NotificationTrigger,
): MailIdentitySource {
  return trigger === 'system' ? 'system' : 'tenant';
}

/**
 * The claimed row (or whatever a caller assembled) arrived **without** the
 * organisation's `smtp` column.
 *
 * A defect and not a mail problem, hence an exception rather than a `fail` arm:
 * `null` is „diese Organisation hat keinen Mailserver" and a missing value
 * resolves to the *same* answer, so a projection that dropped the column would
 * stop an organisation's queue dead — every row `queued` for ever, with a
 * reason that is false, and **nothing red**, because nothing was attempted and
 * `withhold` is a supported state. Its own class so the mail worker can tell it
 * from every ordinary lane failure and let it end the run.
 */
export class MailIdentityColumnMissingError extends Error {}

/**
 * Whether the caller's tenant carries no usable `smtp` value.
 *
 * **Both shapes, and the second is the common one.** A `delete row.smtp` leaves
 * the key out; `{ ...row, smtp: undefined }` — the spread somebody writes to
 * „clear" a field — leaves the key in place with `undefined` in it, and a check
 * on the key alone waves that straight through into „diese Organisation hat
 * keinen Mailserver".
 *
 * Takes `unknown` on purpose: the declared type of `resolve` says the column is
 * always there, and this is the check for the day that declaration turns out to
 * have been a promise rather than a proof (a `$queryRaw` types its own result).
 * A `=== undefined` against the declared type would be flagged as impossible and
 * removed, which is precisely how the property would get lost.
 */
function storedSmtpMissing(tenant: unknown): boolean {
  if (typeof tenant !== 'object' || tenant === null || !('smtp' in tenant)) {
    return true;
  }
  return tenant.smtp === undefined;
}

/**
 * A refusal of `MailSecretsService`, turned into the `fail` arm — and anything
 * else re-thrown.
 *
 * The distinction is the point: „die gespeicherte Konfiguration ist kaputt" is
 * a state of the data and belongs in `mail_log.last_error` where somebody can
 * act on it; a `TypeError` is a defect and must keep behaving like one, or the
 * first real bug in this path would be recorded as a hundred failed mails with
 * a plausible German sentence next to them.
 */
function refusal(error: unknown): FailIdentity {
  if (error instanceof MailConfigUnreadableError) {
    return { kind: 'fail', reason: error.message };
  }
  throw error;
}
