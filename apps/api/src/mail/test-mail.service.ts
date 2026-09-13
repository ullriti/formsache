import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  effectiveReplyTo,
  escapeHtml,
  formatDeadline,
  renderAnswerTable,
  wrapMailBody,
  type MailLabelledValue,
  type MailShell,
  type TestMailResult,
} from '@formsache/shared';

import { PublicUrlService } from '../common/public-url/public-url.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import type { TenantScope } from '../tenancy/tenant-scope';
import { MailClock } from './mail-clock';
import { deliverMail } from './mail-delivery';
import {
  MailIdentityService,
  attemptedIdentity,
  mailIdentityColumns,
  type MailIdentitySource,
} from './mail-identity.service';
import { MAIL_TIMEOUTS, type MailTimeouts } from './mail-timeouts';
import {
  MailTransport,
  SYSTEM_IDENTITY_KEY,
  type SendingIdentity,
} from './mail-transport';

/**
 * The subject the button's mail always carries.
 *
 * Fixed and never derived from a notification's template: a Testmail is not a
 * rendering of anybody's configured text, and a subject an editor can
 * recognise on sight is what keeps the mail log from reading like a
 * confirmed registration. The test of this package pins the exact string down
 * — removing the marker is the reproduction that has to turn it red.
 */
export const TEST_MAIL_SUBJECT =
  'Formsache: Testmail — der Mailversand funktioniert';

/**
 * What a Testmail proves, in one sentence — and in two versions.
 *
 * **Fixed text, and since finding 29b that is a security property and
 * not merely tidiness.** Since the recipient is freely choosable, „what does it
 * say" is the question that decides about misuse: a relay is only
 * one if the caller determines the content. Here the caller does not determine it —
 * neither the subject nor the body carries a field from the request. The four
 * variables all come from the server: the name of the organisation from the
 * database row, the sender address from the resolved block, the moment
 * from the queue's clock and the statement of which mail server was
 * used. Whoever points the route at somebody else's address can therefore send them exactly
 * one sentence, and that sentence says what it means.
 *
 * ## Why it says anything at all
 *
 * A Testmail answers two questions, and until point 20 of the second
 * review round it answered neither of them visibly: **did it arrive** (then
 * the connection to the mail server stands) and **who did it come from** (then
 * the sender address is right, and the recipient has not sorted it out). Both
 * are now in the body, together with the moment — without that, a second
 * Testmail in the mailbox cannot be told apart from the first.
 *
 * ## Two versions, one source
 *
 * `text` **always** stays set, even when `html` stands beside it: a
 * mail client without HTML would otherwise get an empty message. Both versions
 * come into being here from the same values, and the table in the middle is
 * the same function a confirmation uses for `{{antworten}}`
 * (`renderAnswerTable`) — including its defusing of every value.
 */
export function testMailBody(input: TestMailBodyInput): TestMailBody {
  const via =
    input.source === 'system'
      ? 'Mailserver der Instanz (Systemverwaltung)'
      : `Mailserver der Organisation „${input.organisation}"`;
  const facts: readonly MailLabelledValue[] = [
    { label: 'Verschickt über', value: via },
    { label: 'Absenderadresse', value: input.senderAddress },
    {
      label: 'Ausgelöst am',
      value: formatDeadline(input.triggeredAt.toISOString()),
    },
  ];

  const lead =
    input.source === 'system'
      ? 'Diese Testmail wurde in der Systemverwaltung von Formsache ausgelöst.'
      : `Diese Testmail wurde in den Mailversand-Einstellungen der Organisation „${input.organisation}" ausgelöst.`;
  const proof =
    'Dass sie angekommen ist, belegt zweierlei: die Verbindung zum ' +
    'eingetragenen Mailserver steht, und die Absenderadresse wird ' +
    'angenommen.';
  const closing =
    'Diese Nachricht bestätigt keine Anmeldung und keine Registrierung — sie ' +
    'prüft nur den Mailversand.';

  return {
    text: [
      `${lead} ${proof}`,
      '',
      renderAnswerTable(facts, 'text'),
      '',
      closing,
    ].join('\n'),
    html: [
      `<p style="margin:0 0 16px 0">${escapeHtml(lead)} ${escapeHtml(proof)}</p>`,
      renderAnswerTable(facts, 'html'),
      `<p style="margin:16px 0 0 0">${escapeHtml(closing)}</p>`,
    ].join(''),
  };
}

/** Where {@link testMailBody} takes its four variables from. */
export interface TestMailBodyInput {
  /**
   * Which block was checked — it is in the text, because otherwise a Testmail
   * does not answer what it is supposed to answer.
   */
  readonly source: MailIdentitySource;
  /** The name of the organisation in whose mail log the row stands. */
  readonly organisation: string;
  /** The `From` address of the block that was used — never the display name. */
  readonly senderAddress: string;
  /** The queue's clock, not `new Date()` — see {@link TestMailService.send}. */
  readonly triggeredAt: Date;
}

/** Both versions of a Testmail; `text` is never absent. */
export interface TestMailBody {
  readonly text: string;
  readonly html: string;
}

/**
 * „Testmail senden".
 *
 * ## The four promises, and where each one lives in this file
 *
 * 1. **The recipient is exactly one address, and this class never assembles
 *    it.** The only thing that ever goes into `mail_log.recipient` or to the
 *    transport is the parameter `recipientEmail` — decided by the controller:
 *    the address from the validated request, otherwise the one from the
 *    session. There is no second source a recipient could come
 *    from, and **no place that splits a string into several addresses**
 *    — that is the same property `resolveRecipients`
 *    (`mail-template.ts`) carries for the public path, and the reason why
 *    the free recipient does not become a distribution list.
 *
 *    Until finding 29b that was „always the address from the session". What has
 *    changed and why is written at the docblock of `TestMailController` —
 *    here it only says that this class decides nothing about the question.
 * 2. **It goes the real path.** `resolve()` asks the very
 *    {@link MailIdentityService} the queue asks, the send goes through the
 *    very delivery step the worker sends through (`deliverMail` in
 *    `mail-delivery.ts` — one implementation since the test-mail review, not a copy
 *    that drifts), and a genuine attempt writes a genuine `mail_log` row.
 * 3. **It is marked.** {@link TEST_MAIL_SUBJECT} and {@link testMailBody} are
 *    fixed text this class writes, never a rendered notification — the row
 *    cannot be read as a confirmed registration.
 * 4. **It uses the stored block, never a typed one.** There is no parameter
 *    here for a block at all — {@link send} takes a `TenantScope` and a
 *    recipient, and the only place a block comes from is
 *    `scope.tenant.find()`, i.e. the column. Nothing this class does could
 *    accept one on the way in even if a caller wanted to hand it one; the
 *    controller's request schema (`testMailRequestSchema` in `@formsache/shared`)
 *    closes the other half by refusing a body that carries transport fields
 *    at all.
 *
 * ## Two arms never reach a transport, on purpose
 *
 * `withhold` (nothing configured, neither own nor system) and `fail` (the
 * stored block is unreadable) both answer without a connection, without a
 * `mail_log` row and with the exact sentence the worker itself would write
 * for a real notification in the same state — never a network error, because
 * none was attempted (ADR-0013 no. 5).
 *
 * ## The failure reason is a category, not a transcript — **on this route
 * always, whichever block was used**
 *
 * ADR-0013's own „Consequences" names this exact route as the cheapest way to
 * turn a host into a port scanner: it dials on demand and answers **in the same
 * response**, so a literal `ECONNREFUSED` against a timeout tells an open port
 * from a closed one. That is why the reason style is `'category'` here without
 * looking at `identity.source`.
 *
 * It used to look (a review finding of the test-mail review): the system arm handed
 * `describeMailError` through, which redacts user and password but **not host
 * and port**. Any organisation's admin, on a button, would have read
 * `connect ECONNREFUSED 10.8.0.12:587` or a `535` naming the
 * installation's internal relay. The distinction „eigener Block kategorisiert,
 * System wörtlich" is a rule about `mail_log.last_error`, where the reader is
 * the *operator* of that host (`queueReasonStyle` in `mail-delivery.ts`); the
 * Consequences grant no exception for this route, and this route's reader is
 * whoever pressed the button.
 */
@Injectable()
export class TestMailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identities: MailIdentityService,
    private readonly transport: MailTransport,
    /**
     * The queue's calendar, because the reservation below is read by the
     * *worker* — see {@link send}. Two clocks would mean a row that this
     * service considers reserved and the worker considers due.
     */
    private readonly clock: MailClock,
    @Inject(MAIL_TIMEOUTS) private readonly timeouts: MailTimeouts,
    /**
     * The bottom level of the `Reply-To` chain.
     *
     * The service is used here by the transport and by
     * `MailIdentityService` anyway; what is new is a question put to it, not
     * a new way to the row.
     */
    private readonly systemSettings: SystemMailSettingsService,
    /**
     * The base address for the footer — which of the two is decided by
     * `source` (see {@link shellFor}).
     */
    private readonly publicUrls: PublicUrlService,
  ) {}

  /**
   * @param source Which block is checked — **a mandatory argument, no
   *   default**, for the same reason
   *   {@link MailIdentitySource} is one: a default of `'tenant'`
   *   would have quietly turned the system variant into the organisation variant, and
   *   the result would have been a green Testmail that checked the wrong
   *   mail server. The value goes unchanged to
   *   `MailIdentityService.resolve`; it is **not** derivable from what
   *   the organisation has stored — that is precisely where the difference lies
   *   between „ich will den Mailserver dieser Organisation prüfen" and „ich
   *   will den der Instanz prüfen".
   */
  /**
   * **Die Testmail der Systemverwaltung ohne Organisation**
   * (Review-Runde 3 Nr. 12): *„Testmail sollte auch ohne Orga gehen. Dann
   * halt nicht protokolliert."*
   *
   * ## Was vorher im Weg stand — und was daran wirklich die Bedingung war
   *
   * Die Route hing an `TenantScopeGuard`, und die Begründung dafür war nie
   * die Berechtigung (die entscheidet `SuperadminGuard`), sondern **die
   * Zeile**: `mail_log.tenant_id` ist `NOT NULL`, jede Zeile dieses Protokolls
   * gehört einer Organisation. Ein Superadministrator ohne Mitgliedschaft
   * bekam deshalb 403 — und das war ausgerechnet der Zustand während der
   * Erstinbetriebnahme, also genau dann, wenn man den Mailserver zum ersten
   * Mal prüfen will.
   *
   * ## Warum die Spalte trotzdem `NOT NULL` bleibt
   *
   * Weil sie die Mandantentrennung des Versandprotokolls trägt. Sie nullbar
   * zu machen hieße, jede Abfrage über `mail_log` um einen Fall zu erweitern,
   * den niemand sieht, und die eine Zusage aufzuweichen, an der die Trennung
   * hängt — für einen einzigen Knopf. Der Preis wäre um Größenordnungen
   * höher als der Nutzen.
   *
   * ## Also: kein Protokolleintrag, und das wird gesagt
   *
   * Diese Methode schickt und schreibt **nichts**. Der Verlust ist echt und
   * benannt: der Versuch ist hinterher nirgends nachlesbar, es gibt kein
   * „↻ Erneut", und die Fehlermeldung ist das, was die Antwort sagt. Die
   * Oberfläche schreibt genau das an den Knopf (`TestMailCard`), statt es zu
   * verschweigen.
   *
   * ⚠️ **Nur für den Systemblock.** Eine Testmail ohne Organisation über den
   * Block *einer* Organisation gibt es nicht und kann es nicht geben — ohne
   * Organisation gibt es keinen solchen Block. Deshalb hat diese Methode
   * keinen `source`-Parameter; sie ist der Systemzweig und sonst nichts.
   */
  async sendWithoutTenant(recipientEmail: string): Promise<TestMailResult> {
    const identity = await this.identities.systemBlock();
    if (identity.kind !== 'send') {
      return { recipientEmail, status: 'failed', reason: identity.reason };
    }

    const triggeredAt = this.clock.now();
    const body = testMailBody({
      source: 'system',
      // Kein Name einer Organisation, weil es keine gibt. Der Baustein
      // verlangt einen String; für den Systemzweig liest er ihn nicht
      // (siehe `testMailBody`), und ein erfundener Name stünde sonst in
      // einer Mail.
      organisation: '',
      senderAddress: identity.block.from,
      triggeredAt,
    });
    const base = await this.publicUrls.installationBaseUrl();
    const wrapped = wrapMailBody(
      { text: body.text, html: body.html },
      base === null ? {} : { link: { owner: 'installation', url: base } },
    );

    /*
      Die Antwortadresse kommt allein aus der Systemzeile — die Kette
      Organisation → Installation hat hier nur ihre untere Hälfte.
    */
    const replyTo = effectiveReplyTo(
      await this.systemSettings.replyToDefaults(null),
    ).address;

    const outcome = await deliverMail({
      transport: this.transport,
      timeouts: this.timeouts,
      mail: {
        to: recipientEmail,
        subject: TEST_MAIL_SUBJECT,
        text: wrapped.text,
        ...(wrapped.html === undefined ? {} : { html: wrapped.html }),
        // **Kein `fromName`.** Der Anzeigename gehört der Organisation
        // (`OutgoingMail.fromName`), und hier gibt es keine. Die Mail geht
        // unter der blanken Absenderadresse des Systemblocks hinaus — das ist
        // die wahre Angabe.
        ...(replyTo === null ? {} : { replyTo }),
      },
      identity: { key: SYSTEM_IDENTITY_KEY, block: identity.block },
      // Wie im Zweig mit Organisation: immer eine Kategorie, nie der Wortlaut
      // — siehe den Klassenkopf („The failure reason is a category …").
      reasonStyle: 'category',
    });

    return outcome.kind === 'failed'
      ? { recipientEmail, status: 'failed', reason: outcome.reason }
      : { recipientEmail, status: 'sent', reason: null };
  }

  async send(
    scope: TenantScope,
    recipientEmail: string,
    source: MailIdentitySource,
  ): Promise<TestMailResult> {
    // `find()` and not the narrower `scope.tenant.smtp()` — a deliberate
    // decision, not the leftover the test-mail review took it for. Three
    // columns are read here, not one: `smtp` resolves the identity, `id` binds
    // every statement below, and `name` is the display name of the `From`
    // header and the organisation's name in the body. `smtp()` exists for
    // `SmtpConfigService`, which really does want the single column.
    //
    // What the projection would cost is the guard the review itself names:
    // `find()` is a typed `findUnique` **without** `select`, so a column that
    // disappeared from the model is a `pnpm typecheck` error here, while a
    // `select` list silently keeps compiling with one entry fewer — and a lost
    // `smtp` resolves to „kein Mailserver" (ADR-0023), i.e. this
    // organisation's testmail answering „nicht eingerichtet" for a block that
    // is in fact stored, with nothing red.
    // Weighed against that: nothing of the row leaves this service. Only
    // `name` is ever put into a mail, `oidc_client_secret` and `form_defaults`
    // are read into a local and dropped, and the row never touches a payload —
    // so the wide read is a wider *query*, not a wider disclosure.
    const tenant = await scope.tenant.find();
    if (tenant === null) {
      // Unreachable through the normal guard chain — `TenantScopeGuard` only
      // ever builds a scope from a membership that points at a row that
      // exists — but typed honestly rather than asserted away.
      throw new NotFoundException('Dieser Organisation existiert nicht mehr.');
    }

    // Explicit and from the caller, never guessed: a Testmail checks **the
    // block the button names**; inferring it from what is
    // stored would mean checking the one thing and answering the other
    // (ADR-0020 on the mandatory argument).
    //
    // `'system'` only comes from the superadmin route
    // (`SystemTestMailController`) and does not see `tenant.smtp` at all —
    // `resolve` ends for this value before the column is read
    // ({@link MailIdentitySource}).
    const identity = await this.identities.resolve(
      { id: tenant.id, smtp: tenant.smtp },
      source,
    );

    if (identity.kind !== 'send') {
      // Nothing was attempted, so there is nothing to categorise and nothing
      // to log: `identity.reason` is already one of the fixed sentences
      // `MailIdentityService` hands the real queue for the same state.
      return { recipientEmail, status: 'failed', reason: identity.reason };
    }

    const sending: SendingIdentity = {
      key: identity.source === 'system' ? SYSTEM_IDENTITY_KEY : tenant.id,
      block: identity.block,
    };
    const subject = TEST_MAIL_SUBJECT;
    /*
     * **The Testmail carries the effective `Reply-To` too**  — and
     * so the button that is on this tab anyway checks exactly the
     * field that stands beside it.
     *
     * Only two levels, because there is no notification here: the organisation,
     * then the installation. The same function, the same order — the
     * chain is one, not one per sending path. That is also why the two levels are
     * not assembled here but by
     * `SystemMailSettingsService.replyToDefaults`, which the public
     * sending path asks in just the same way.
     */
    const replyTo = effectiveReplyTo(
      await this.systemSettings.replyToDefaults(tenant),
    ).address;

    // **The row is committed before anything dials** (a review finding of the
    // test-mail review). It used to be one interactive transaction around the insert,
    // the send and the status write — the shape `MailWorkerService.deliverOne`
    // has, borrowed without its reason. The worker's transaction exists to
    // hold `FOR UPDATE SKIP LOCKED` on a row that is **already committed**;
    // here the row is *created* inside it, and that turns the same shape into
    // two faults:
    //
    //   1. a failing `update` — or a process that dies after a successful
    //      `send()` — rolls the insert back too, so the mail is out and there
    //      is no `mail_log` line at all: exactly the state the evidence
    //      rules out. Committed first, the worst case is a line that stays
    //      `queued`, which is the at-least-once posture of ADR-0004 and
    //      self-healing;
    //   2. a silent host would hold a database connection per keystroke for
    //      the whole send budget. Ten presses a minute across a few admins
    //      empty the Prisma pool and the *whole API* stalls — the fault the
    //      neighbouring package had just removed from the worker
    //      (`MAIL_WORKER_TENANT_LANES`).
    const stampedAt = this.clock.now();
    // **After the resolution and with its result**: the sender address in the
    // body is the one of the *used* block, not the one stored
    // somewhere — that is the difference this mail is meant to
    // prove. The moment comes from the same clock the row is
    // stamped with, so that „Ausgelöst am" and `created_at` are not two
    // calendars.
    const body = testMailBody({
      source,
      organisation: tenant.name,
      senderAddress: identity.block.from,
      triggeredAt: stampedAt,
    });
    /*
     * The same shell every delivered mail of this application carries — in
     * **both** versions, with one call. `text` stays beside it and
     * is never empty.
     *
     * **The third call of `wrapMailBody`, and like the operational alarm one
     * with a reason**: this route enqueues *and* delivers in the same call, so it does
     * not go through the worker and therefore not through `QueuedBodyRenderer`.
     * What is stored below is the body **without** the shell, as with every other
     * row; the detail view of the mail log puts it on when displaying,
     * through the same `QueuedBodyRenderer` the worker uses.
     *
     * ⚠️ **Before the `create`, and that is not cosmetics** (a review finding).
     * {@link shellFor} reads the base address, so it can throw. Between the
     * committed row and the writing of its result, however,
     * nothing may throw any more: `deliverMail` catches everything and returns an outcome,
     * and up to here the wrapping was pure as well. A throw **after**
     * the `create` would give the person who triggered it a 500, while the worker claims the
     * committed row after `claimTransactionMs` and delivers the
     * Testmail minutes later after all — through a different shell than
     * this one. Up here the resolution costs nothing and adds no new source of
     * error to the section below.
     */
    const wrapped = wrapMailBody(
      { text: body.text, html: body.html },
      await this.shellFor(source, tenant),
    );
    const row = await this.prisma.mailLog.create({
      data: {
        tenantId: tenant.id,
        recipient: recipientEmail,
        subject,
        bodyText: body.text,
        // **The HTML body is recorded too**, so that the detail view
        // of the mail log shows what went out — it renders the same
        // column through the same shell (`QueuedBodyRenderer`). What is stored
        // is the body **without** the shell, as with every other row: the shell
        // comes into being at delivery and carries today's colour.
        bodyHtml: body.html,
        // Recorded at enqueue time as with every other row — here enqueueing
        // and sending fall into the same call anyway, but the column
        // has the same meaning for both writers.
        replyTo,
        status: 'queued',
        // **The queue's clock, not the column's `now()` default** (a review
        // finding).
        //
        // The public path stamps `created_at` from {@link MailClock},
        // because the sending budget cuts its window with the same calendar. A
        // testmail written with the database's default would leave one column
        // with two writers and two clocks — and three readers that compare
        // across them: the 90-day purge computes its cut-off from this
        // clock, the mail log sorts by this column, and the row's own
        // `uuid(7)` is ordered by yet another instant. In production the two
        // agree to the millisecond and nothing shows; wherever the queue's
        // clock is moved on purpose — which is the only way this can be
        // proven at all — a testmail lands outside the window every other
        // reader thinks it is in.
        createdAt: stampedAt,
        // **Reserved for the length of one attempt.** A `queued` row with no
        // `next_attempt_at` is due *now*, so the worker could claim and send
        // this very line while the send below is still in flight — a duplicate
        // testmail, and an `update` that then waits on the worker's row lock
        // with a pool connection in hand, which is fault 2 again by another
        // route. `claimTransactionMs` is the budget one delivery attempt may
        // occupy and, by the invariant of `mail-timeouts.ts`, outlasts
        // `sendMs`. Both exits below clear it.
        nextAttemptAt: new Date(
          stampedAt.getTime() + this.timeouts.claimTransactionMs,
        ),
        // `trigger` says **under whose identity this row went out** —
        // exactly the attribution `identitySourceOf` makes for every other
        // row. For the system variant `'system'` is therefore not cosmetics:
        // if somebody later presses „↻ Erneut" in the mail log, the
        // worker picks the block by this column, and a system testmail
        // filed as `submit` would go over the organisation's block on the
        // second attempt — i.e. over a different one from the one that was checked.
        //
        // For the organisation variant it stays at the column default
        // (`submit`), for the reason the test-mail review named as an open
        // point: „this row is a Testmail" would be a third value,
        // and that reaches into the wire contract
        // (`notificationTriggerSchema` in `@formsache/shared`) and into the
        // label table of `apps/web/src/views/MailLogView.tsx`.
        ...(source === 'system' ? { trigger: 'system' as const } : {}),
      },
    });

    const outcome = await deliverMail({
      transport: this.transport,
      timeouts: this.timeouts,
      mail: {
        to: recipientEmail,
        subject,
        text: wrapped.text,
        ...(wrapped.html === undefined ? {} : { html: wrapped.html }),
        fromName: tenant.name,
        ...(replyTo === null ? {} : { replyTo }),
      },
      identity: sending,
      // Always a category on this route, whatever the source — see the class
      // doc („The failure reason is a category …").
      reasonStyle: 'category',
    });

    if (outcome.kind === 'failed') {
      await this.prisma.mailLog.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          attempts: 1,
          lastError: outcome.reason,
          nextAttemptAt: null,
          // The identity this attempt used (the requirement) — written with
          // the outcome, exactly like the worker's, and for the same reason:
          // the row above was committed *before* anything dialled, so it went
          // in without one. „Über welchen Mailserver ging die Testmail" is the
          // very question this button exists to answer.
          ...mailIdentityColumns(attemptedIdentity(identity)),
        },
      });
      return { recipientEmail, status: 'failed', reason: outcome.reason };
    }

    await this.prisma.mailLog.update({
      where: { id: row.id },
      data: {
        status: 'sent',
        attempts: 1,
        sentAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
        ...mailIdentityColumns(attemptedIdentity(identity)),
      },
    });
    return { recipientEmail, status: 'sent', reason: null };
  }

  /**
   * The frame around the Testmail — **whose brand, whose address**.
   *
   * **Colour and name only for the organisation variant.** The row of a
   * system testmail does lie in the mail log of an organisation
   * (`mail_log.tenant_id` is NOT NULL, ADR-0013 continuation 29a), but the mail
   * itself belongs to the installation — dressing it in the colours of some
   * organisation would be exactly the mixing ADR-0023 resolves.
   *
   * The same separation applies to the base address in the footer, and it is
   * the same rule `QueuedBodyRenderer.footerLinkFor` fastens to
   * `identitySourceOf`: `'system'` links to
   * `installationBaseUrl()`, `'tenant'` to the chain of this organisation.
   * A system testmail that pointed at `tenant.public_base_url` would lead the
   * superadmin who triggered it to a host the administration
   * of an organisation has set.
   *
   * If no address is stored, the footer stays without a link. Letting a Testmail
   * fail over that would be particularly wrong: it is the button somebody
   * sets up a fresh installation with in the first place.
   */
  private async shellFor(
    source: MailIdentitySource,
    tenant: {
      readonly id: string;
      readonly name: string;
      readonly accentColor: string;
    },
  ): Promise<MailShell> {
    if (source === 'system') {
      const base = await this.publicUrls.installationBaseUrl();
      return base === null
        ? {}
        : { link: { owner: 'installation', url: base } };
    }
    const base = await this.publicUrls.resolveBaseUrl(tenant.id);
    return {
      accent: tenant.accentColor,
      organisation: tenant.name,
      ...(base === null
        ? {}
        : { link: { owner: 'organisation' as const, url: base } }),
    };
  }
}
