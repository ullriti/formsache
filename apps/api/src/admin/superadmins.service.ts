import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  Superadmin,
  SuperadminAdded,
  SuperadminList,
  SuperadminPromote,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';

import { AccountInvitationService } from '../auth/invitation/account-invitation.service';
import { invitationRefusalMessage } from '../auth/invitation/account-invitation';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { SuperadminInvitationService } from './superadmin-invitation.service';

/**
 * **The second superadministrator** (ADR-0029) — appointing and withdrawing the
 * appointment.
 *
 * ---------------------------------------------------------------------------
 * **This file uses `PrismaService` directly.** `apps/api/src/admin/**` is on the
 * allow-list in `eslint.config.js`; the entry is written out there, and the
 * argument stands here once more, where somebody who changes this code will
 * actually be looking:
 *
 * 1. **The question is installation-wide.** "Who administers this system?"
 *    cannot be asked inside any organisation: `user` carries no `tenant_id`,
 *    `is_superadmin` hangs on the account and on no membership
 *    (`SuperadminGuard`). A `TenantScope` would answer a different question.
 * 2. **Nothing comes out of the request that selects an organisation.** The
 *    list takes no parameter; the appointment takes an address, the withdrawal
 *    an id — both accounts, no organisation data.
 * 3. **Only what stands in the list goes out.** The projection below is a
 *    allow list; `password_hash` and `oidc_subject` do not stand in it and
 *    are **not read either** — see {@link pendingInvitationIds}.
 *
 * **The counter-check that makes the entry defensible** (the same one as with
 * {@link AdminRepository}): there is no method here that reads the *members* of
 * an organisation, and there must not be one. This class reads exactly those
 * rows that carry `is_superadmin` — accounts of the installation, not people of
 * an organisation. It has therefore deliberately **not** moved into
 * `AdminRepository`: its promise reads word for word "There is no method here
 * that reads an organisation's members or forms", and a `user` query in there
 * would have to be classified anew on every read.
 * ---------------------------------------------------------------------------
 */

/**
 * The refusal when no account belongs to an address.
 *
 * 404 and no benevolent silence: whoever stands here has passed the guard of
 * the system administration and may delete every organisation of this
 * installation — "does this address exist?" is, towards them, not a piece of
 * information that hides something, but the answer to a typo. The boundary that
 * may not tell one id apart from a foreign one is that of the organisation, and
 * it is drawn elsewhere (`TenantScopeGuard`).
 *
 * ⚠️ **Seit Review-Runde 3 Nr. 13 ist das der Rennfall und nicht mehr der
 * Normalfall.** „Zu dieser Adresse gibt es kein Konto" ist jetzt der
 * Auslöser einer **Einladung** ({@link SuperadminsService.invite}); hierher
 * kommt nur noch, wessen Zeile zwischen der Vorprüfung und der Transaktion
 * verschwunden ist. Der Satz bleibt trotzdem stehen und bleibt wahr: die
 * Anweisung, es noch einmal zu versuchen, ist in diesem Zustand die richtige,
 * und ein zweiter Versuch lädt dann ein.
 */
export const SUPERADMIN_ACCOUNT_NOT_FOUND_MESSAGE =
  'Zu dieser E-Mail-Adresse gibt es in dieser Installation kein Konto. ' +
  'Bitte noch einmal versuchen.';

/**
 * The refusal of the **withdrawal** towards an account that does not carry the
 * system administration — and towards an id that is none.
 *
 * A constant of its own next to {@link SUPERADMIN_ACCOUNT_NOT_FOUND_MESSAGE}
 * (a review finding): that sentence talks about an e-mail address and about
 * *appointing*, because it is the answer to a typo in the form. At the
 * withdrawal an id arrived and the action was a different one; the same sentence
 * would be a false piece of information there, and a test that expects it would
 * write it down for good.
 *
 * One sentence for "does not exist" and for "administers nothing", as
 * everywhere in this application: the resource of this route is the **list**,
 * and whoever does not stand in it is unknown to it.
 */
export const NOT_A_SUPERADMIN_MESSAGE =
  'Diese Person verwaltet das System nicht.';

/** Twice the same appointment — the list says it, the route says it once more. */
export const ALREADY_SUPERADMIN_MESSAGE =
  'Diese Person verwaltet das System bereits.';

/**
 * **The last superadministrator stays** — the counterpart to `lastAdminMessage`
 * (`tenant-admin/users.service.ts`) one level up.
 *
 * The same shape: an exported message, thrown as a 409, measured in the
 * integration test via exactly this constant instead of via a copied-out
 * sentence. Unlike there it is **no** function call with `'remove' |
 * 'downgrade'`: there is only one action here. `is_superadmin` is a boolean, no
 * ranking — there is nothing one could downgrade to.
 *
 * The reason is the same as with the last administrator of an organisation, one
 * degree sharper: an organisation without an administrator can be supplied with
 * one again by the system administration. An **installation** without a
 * superadministrator can be supplied by nobody any more — `POST /api/setup`
 * demands *zero* rows in `user` (ADR-0022 §3), and the command beside it demands
 * the same. The way back would lead through the database, and precisely that is
 * the state this interface is built against.
 */
export const LAST_SUPERADMIN_MESSAGE =
  'Diese Person ist die letzte Superadministratorin oder der letzte ' +
  'Superadministrator dieser Installation. Die Ernennung lässt sich erst ' +
  'zurücknehmen, wenn es eine zweite gibt — sonst käme niemand mehr an die ' +
  'Systemverwaltung.';

/**
 * **An account that is a member nowhere would lose its place with the
 * appointment** — and a place is, in this application, the condition for an
 * account to remain in existence at all.
 *
 * `deleteHomelessAccounts` (`tenancy/homeless-account.ts`) deletes every
 * `user` row with `isSuperadmin: false` and `memberships: { none: {} }` —
 * irrevocably, in the next cleanup run, without anybody triggering it. Whoever
 * withdraws the appointment from a superadministrator without a membership
 * thereby deletes their account; only not now and not visibly. Exactly the
 * kind of remote effect an interface may not offer.
 *
 * The refusal is therefore an **instruction** and not a "does not work": take
 * the person into an organisation first. Whoever really wants to be rid of the
 * account has for that the way via the organisation it is a member of — the
 * confirmation prompt that says what is lost stands there.
 */
export const SUPERADMIN_WITHOUT_TENANT_MESSAGE =
  'Diese Person ist in keiner Organisation Mitglied. Ohne die Ernennung ' +
  'hätte ihr Konto keinen Ort mehr und würde beim nächsten Aufräumlauf ' +
  'gelöscht — nimm sie zuerst in eine Organisation auf.';

/**
 * The key of the pre-lock for "how many superadministrators are there?".
 *
 * **The second lock of this application**, and formed according to the rule
 * that `SETUP_LOCK` (`setup/first-superadmin.ts`) sets up: first value the
 * namespace of the application (`0x666f726d` — "form"), second value the serial
 * number. `xact`, not `session`: it is released on commit **and** on rollback.
 *
 * ⚠️ It hangs on **`READ COMMITTED`**, the default of PostgreSQL and of
 * Prisma — the same footnote as there: only that way does the count *after* the
 * lock see what the predecessor committed.
 */
export const SUPERADMIN_LOCK = {
  namespace: 0x666f_726d,
  id: 2,
} as const;

/**
 * What the list reads of an account — an **allow list**, so that a column
 * added to `user` later has to be entered here first before it can get into a
 * response.
 *
 * `passwordHash` and `oidcSubject` are missing on purpose and are not read for
 * the derivation of `invitationPending` either (see
 * {@link pendingInvitationIds}). `memberships` with `take: 1`: what is asked is
 * "is there one at all", not "how many" — a number would be one piece of
 * information more than the decision needs.
 */
const SUPERADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  memberships: {
    // **Only living organisations.** A membership in a deleted organisation
    // disappears with it when the trash is purged after 30 days — and the
    // account would afterwards be exactly the homeless residue that
    // {@link SUPERADMIN_WITHOUT_TENANT_MESSAGE} is meant to prevent. What is
    // mirrored is therefore the *consequence* of `deleteHomelessAccounts`, not
    // its literal `where`.
    where: { tenant: { deletedAt: null } },
    take: 1,
    select: { id: true },
  },
} satisfies Prisma.UserSelect;

type SuperadminRow = Prisma.UserGetPayload<{
  select: typeof SUPERADMIN_SELECT;
}>;

@Injectable()
export class SuperadminsService {
  /**
   * **The log of the highest granting of rights in this application.**
   *
   * An audit log as a table does not exist in this application (ADR-0029 §6);
   * what does exist is the line that `AdminService` writes for the deletion of
   * an organisation — and the appointment is at least as grave: it gives
   * somebody access to every organisation of this installation.
   *
   * **Two ids and nothing else.** Who acts, whom it concerns — never a name,
   * never an address (`CONTRIBUTING.md`: no personal data in logs). The point in
   * time comes from Nest's own stamp.
   */
  private readonly logger = new Logger(SuperadminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Baut die Einladung, bevor irgendetwas geschrieben wird (ADR-0024) —
     * derselbe Dienst, den die Mitgliederverwaltung einer Organisation
     * benutzt, damit Frist, Wortlaut und Absage nicht zweimal entstehen.
     */
    private readonly invitations: AccountInvitationService,
    /** Und verschickt sie, an der Warteschlange vorbei — siehe dort, warum. */
    private readonly invitationMail: SuperadminInvitationService,
  ) {}

  /**
   * Who carries the system administration — the whole list.
   *
   * Sorted by name, then address: the list is short and is read, not searched,
   * and an order by creation date would be one that nobody can explain. The
   * address as the second key, so that two identical names have a fixed order.
   */
  async list(): Promise<SuperadminList> {
    const rows = await this.prisma.user.findMany({
      // Not tenant-scoped, and it may not be: `user` carries no `tenant_id`,
      // and what is asked is precisely the installation-wide property.
      where: { isSuperadmin: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: SUPERADMIN_SELECT,
    });

    const pending = await this.pendingInvitationIds();
    return { superadmins: rows.map((row) => toView(row, pending)) };
  }

  /**
   * **Appoint as superadministrator.**
   *
   * The route is the granting of rights, not a field in a document: the caller
   * sends an address, `is_superadmin: true` stands literally in the code. There
   * is no way on which a request document reaches this column — the same line
   * that ADR-0022 §6 draws for `first-superadmin.ts`, only with a guard in front
   * of it instead of an empty table.
   *
   * **Whoever appoints is already a superadministrator** — that is decided by
   * `SuperadminGuard` at the controller, and this service does not ask after it
   * once more. "Nobody appoints themselves" follows from that: the only account
   * the caller could enter here without already being allowed to is their own —
   * and that one carries the property already, so the route answers
   * {@link ALREADY_SUPERADMIN_MESSAGE}.
   *
   * **No pre-lock.** It would hold a promise that this direction cannot break:
   * the appointment *increases* the number of superadministrators, and the only
   * promise that hangs on this number is "at least one".
   *
   * What it needs nevertheless is the **condition in the `where` of the
   * statement that acts** — the same form that `deleteHomelessAccount` writes
   * out: an `update` on a row that a concurrent request has deleted in the
   * meantime would be a `P2025` and thereby a 500 for a state the application
   * knows. `updateMany` with `isSuperadmin: false` simply does not match it, and
   * the zero says so.
   */
  async promote(
    request: SuperadminPromote,
    actorId: string,
  ): Promise<SuperadminAdded> {
    /*
      **Zu dieser Adresse gibt es noch kein Konto: dann wird eingeladen**
      (Review-Runde 3 Nr. 13). Der Zweig steht **vor** der Transaktion, weil
      er eine eigene ist — und weil die Einladung gebaut sein will, bevor
      irgendetwas geschrieben wird (ADR-0024): kann die Installation keine
      verschicken, entsteht auch kein Konto.

      Die Prüfung „gibt es das Konto?" fällt damit zweimal, hier und in der
      Transaktion unten. Das ist kein Versehen: der zweite Blick steht unter
      dem Schutz derselben Anweisung, die schreibt, und das Rennen zweier
      gleichzeitiger Aufrufe verliert am `@unique` von `user.email` — nicht an
      einer Prüfung davor.
    */
    if (
      (await this.prisma.user.findUnique({
        where: { email: request.email },
        select: { id: true },
      })) === null
    ) {
      return this.invite(request, actorId);
    }

    const promoted = await this.prisma.$transaction(async (tx) => {
      const found = await tx.user.findUnique({
        where: { email: request.email },
        select: { ...SUPERADMIN_SELECT, isSuperadmin: true },
      });

      if (found === null) {
        throw new NotFoundException(SUPERADMIN_ACCOUNT_NOT_FOUND_MESSAGE);
      }
      if (found.isSuperadmin) {
        throw new ConflictException(ALREADY_SUPERADMIN_MESSAGE);
      }

      const { count } = await tx.user.updateMany({
        where: { id: found.id, isSuperadmin: false },
        // One field, literally — the same precaution as in
        // `admin.repository.ts` and `first-superadmin.ts`: nothing comes out of
        // `request` but the address with which the row was found.
        data: { isSuperadmin: true },
      });

      if (count === 0) {
        // Between reading and writing somebody else has touched this row. Both
        // possibilities — already appointed, or the account is gone — end in the
        // same instruction: look at it again.
        throw new ConflictException(ALREADY_SUPERADMIN_MESSAGE);
      }

      // Out of `found` and not out of a second query: what changed is exactly
      // the one column that does not stand in this response anyway.
      return found;
    });

    this.logger.log(`user ${promoted.id} granted superadmin (user ${actorId})`);

    return {
      ...toView(promoted, await this.pendingInvitationIds()),
      invited: false,
    };
  }

  /**
   * **Eine Person einladen, die noch kein Konto hat** (Review-Runde 3 Nr. 13).
   *
   * ## Das fünfte Konto ohne Mitgliedschaft — und warum es keines ist
   *
   * `homeless-account.ts` zählt die Stellen auf, an denen ein Konto entsteht,
   * und sagt: immer zusammen mit einer Mitgliedschaft. Diese hier ist die
   * Ausnahme, und sie ist genau die, für die der Aufräumlauf schon eine
   * Bedingung trägt: `deleteHomelessAccount` schreibt `isSuperadmin: false`
   * wörtlich in sein `where`. **„Keine Organisation" ist der Normalzustand
   * eines Superadministrators, nicht seine Heimatlosigkeit** — der Satz steht
   * dort seit ADR-0029, und diese Methode ist der erste Aufrufer, der sich
   * darauf verlässt.
   *
   * Das Konto ist damit weder unsichtbar noch verwaist: es steht in genau der
   * Liste, in die es gehört, und die Zeile sagt „In keiner Organisation
   * Mitglied" samt der Folge daraus.
   *
   * ## Erst planen, dann schreiben
   *
   * `AccountInvitationService.plan` prüft Mailserver **und** Basis-Adresse und
   * sagt beides mit einem eigenen Satz. Ohne diese Reihenfolge entstünde bei
   * einer Installation ohne Mailserver ein Konto ohne Passwort, von dem
   * niemand weiß — und dessen Adresse installationsweit belegt wäre.
   *
   * ## Und warum das Verschicken **hinter** der Transaktion steht
   *
   * Weil ein Netzwerkzug nicht in eine Transaktion gehört: er hielte eine
   * Verbindung des Pools für die ganze Sendefrist (derselbe Fehler, den
   * `TestMailService` beim Namen nennt).
   *
   * Der Preis wäre ein Konto, dessen Einladung nicht hinausging — und weil es
   * auf diesem Weg **keine Warteschlange** gibt, die es später nachholte,
   * bleibt es nicht stehen: schlägt der Versand fehl, nimmt diese Methode das
   * eben angelegte Konto wieder zurück (siehe unten), und die Antwort sagt
   * das. Der zweite Versuch ist derselbe Knopf; ein „Einladung erneut
   * senden" auf der Zeile gibt es hier deshalb nicht.
   */
  private async invite(
    request: SuperadminPromote,
    actorId: string,
  ): Promise<SuperadminAdded> {
    const plan = await this.invitations.plan({
      accountKind: 'local',
      personName: request.name,
      // **Keine Organisation, und der Wortlaut weiß das.** `mailSafeTenantName`
      // lässt den Satz „für die Organisation …" dann weg, statt eine zu
      // erfinden (`account-invitation-mail.ts`).
      tenantName: null,
    });
    if (plan.kind !== 'ready') {
      throw new UnprocessableEntityException(invitationRefusalMessage(plan));
    }
    const invitation = plan.invitation;
    const token = invitation.token;
    if (token === null) {
      // Unerreichbar: `accountKind: 'local'` mintet immer einen. Laut statt
      // still, wie überall in dieser Datei.
      throw new Error('a local invitation without a token');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        // Feld für Feld, nie per Spread — dieselbe Vorsichtsmaßnahme wie in
        // `admin.repository.ts` und `first-superadmin.ts`. `passwordHash`
        // bleibt auf seiner `null`-Vorgabe, **weil nichts es setzt**: das
        // Konto kann sich nicht anmelden, bis die Einladung eingelöst ist.
        data: {
          email: request.email,
          name: request.name,
          isSuperadmin: true,
        },
        select: SUPERADMIN_SELECT,
      });
      await tx.passwordResetToken.create({
        data: {
          // Die Kennung kommt mit — sie **ist** die signierte Nachricht
          // (`password-reset-token.ts`).
          id: token.id,
          kind: 'invitation',
          userId: user.id,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
          // **Keine `mailLogId`.** Diese Mail geht an der Warteschlange
          // vorbei, es gibt also keine Zeile, an der sie hinge — die
          // Begründung in voller Länge steht an
          // `SuperadminInvitationService`.
        },
      });
      return user;
    });

    this.logger.log(
      `user ${created.id} invited as superadmin (user ${actorId})`,
    );

    // Die Adresse aus der **geschriebenen** Zeile, nicht aus der Anfrage —
    // dieselbe Regel wie in `enqueueInvitation`.
    const failure = await this.invitationMail.deliver(
      invitation,
      created.email,
    );
    if (failure !== null) {
      /*
        **Ging die Einladung nicht hinaus, wird das Konto zurückgenommen.**

        Das ist die Fortsetzung derselben Regel, mit der ADR-0024 die
        Reihenfolge festlegt („erst planen, dann schreiben"): ein Konto ohne
        zugestellte Einladung ist das schlechteste aller Ergebnisse — die
        Person weiß nichts davon, die Verwaltung auch nicht, und die Adresse
        ist installationsweit belegt. Auf **diesem** Weg gibt es zudem keine
        Warteschlange, die es später nachholte.

        Erlaubt ist das nur, weil dieses Konto in dieser Sekunde entstanden
        ist und nichts an ihm hängt: keine Mitgliedschaft, keine Sitzung, kein
        Formular. Die Bedingungen stehen trotzdem im `where` und nicht in
        einem `if` davor — dieselbe Bauform wie in `deleteHomelessAccount`:
        wäre in der Zwischenzeit irgendetwas dazugekommen, trifft die
        Anweisung nicht, und das Konto bleibt stehen.

        ⚠️ **Der Link kann trotzdem verschickt worden sein** — ein Zeitablauf
        nach der Annahme durch den Mailserver sieht von hier aus wie ein
        Fehlschlag. Er zeigt dann auf ein Konto, das es nicht mehr gibt, und
        das Einlösen antwortet „ungültig". Das ist die richtige Richtung.
      */
      await this.prisma.user.deleteMany({
        where: {
          id: created.id,
          isSuperadmin: true,
          passwordHash: null,
          oidcSubject: null,
          memberships: { none: {} },
        },
      });
      this.logger.warn(
        `superadmin invitation rolled back, mail not delivered (user ${actorId})`,
      );
      throw new UnprocessableEntityException(
        `Die Einladung konnte nicht verschickt werden: ${failure} Das Konto ` +
          'wurde deshalb nicht angelegt — bitte den Mailserver der Instanz ' +
          'prüfen und es danach erneut versuchen.',
      );
    }

    return { ...toView(created, new Set([created.id])), invited: true };
  }

  /**
   * **Withdraw the appointment.**
   *
   * Check and write stand in **one** transaction with a pre-lock in front of it
   * ({@link SUPERADMIN_LOCK}) — for the same reason for which
   * `createFirstSuperadmin` does it: "how many are there?" and "take the
   * appointment from one of them" are two statements, and between two statements
   * a second request fits. Without the queue two simultaneous withdrawals would
   * each see two superadministrators, both would let through, and the
   * installation would stand there without one — precisely the state this
   * interface is built against. An integration test runs the two in parallel.
   *
   * **The caller may downgrade themselves, as long as they are not the last
   * one.** That is the rule of the member administration one level up, word for
   * word (`TenantMembersTab`, `MemberRow`): an interface that forbids more than
   * the server lies about the rule — and it locks in the one state nobody wants,
   * namely that one can leave one's own seat only via somebody else. What
   * catches the loss is the confirmation prompt in the interface, not an
   * additional prohibition here.
   */
  async demote(userId: string, actorId: string): Promise<void> {
    if (!isUuid(userId)) {
      // The floor under the query: an id that is none gets the same 404 as an
      // unknown one, instead of letting Prisma throw a type error (the same form
      // as `AdminService.requireTenantId`).
      throw new NotFoundException(NOT_A_SUPERADMIN_MESSAGE);
    }

    await this.prisma.$transaction(async (tx) => {
      // The queue. From here on this block is the only one that counts and writes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMIN_LOCK.namespace}::int4, ${SUPERADMIN_LOCK.id}::int4)`;

      const target = await tx.user.findUnique({
        where: { id: userId },
        select: { ...SUPERADMIN_SELECT, isSuperadmin: true },
      });

      if (target?.isSuperadmin !== true) {
        // The resource of this route is the *list*, and whoever does not stand
        // in it is unknown to it — the account that does exist and merely
        // administers nothing as well. The message therefore names exactly that
        // and not an e-mail address: an id arrived here, and the action was the
        // withdrawal.
        throw new NotFoundException(NOT_A_SUPERADMIN_MESSAGE);
      }

      /*
        **Is there anybody besides this person?** — and not "how many are
        there". A count *including* the target has to be compared against 1 by
        the reader, and a `<= 1` next to a word like "remaining" invites the
        "correction" to `< 1` — which lifts exactly the promise this line
        stands for (a review finding). Asking the question in the `where` makes
        the comparison into what it is: **zero others.**
      */
      const others = await tx.user.count({
        where: { isSuperadmin: true, id: { not: userId } },
      });
      if (others === 0) {
        throw new ConflictException(LAST_SUPERADMIN_MESSAGE);
      }
      if (target.memberships.length === 0) {
        throw new ConflictException(SUPERADMIN_WITHOUT_TENANT_MESSAGE);
      }

      /*
        **The membership condition stands in the `where` of the statement that
        acts** — the `if` above it stays standing only for the message (a
        review finding). `homeless-account.ts` writes the rule out, and it
        holds here for exactly the same reason as there: the pre-lock queues
        the callers of **this** function, but the membership is deleted by
        somebody else entirely.

        The interleaving that would otherwise stay open (`READ COMMITTED`,
        every statement with its own snapshot):

        1. here: lock, read — X has a living membership, there is more than one
           superadministrator;
        2. alongside: an organisation administrator with `can_manage_users`
           removes X from their last organisation. `deleteHomelessAccount` does
           **not** match X, because at this moment X still carries the
           appointment. Commit;
        3. here: `isSuperadmin: false`. Commit.

        Afterwards X is a non-superadmin **without any membership** — the
        `where` of `deleteHomelessAccounts`, and the cleanup run hangs on a
        timer. The account would disappear along with its sessions and form
        permissions, triggered by an action that did not mean it. With the
        condition in the `where` the statement simply no longer matches this
        row.

        The zero covers two cases, and both are the same piece of information:
        the last membership is gone between reading and writing, or the account
        itself is. In both cases the appointment is *not* withdrawn — and that
        is exactly what the message says.

        ⚠️ **What is not closed by this either, and why that is no loss.** If
        the concurrent request clears the membership away only *after* this
        statement and *before* the commit, then the statement still matches,
        and its `deleteHomelessAccount` still sees the appointment — the
        account afterwards stands there without either and falls to the
        reconciliation. But that is the **union of two intended actions**: here
        the system right was given up, there the last membership, and the
        confirmation prompt there announces exactly this outcome („ist dies
        ihre letzte Organisation und verwaltet sie das System nicht, wird auch
        ihr Konto gelöscht"). The difference to the state without the condition
        above is the one that matters: there an account could die **without**
        anybody having triggered the combination of both actions.
      */
      const { count } = await tx.user.updateMany({
        where: {
          id: userId,
          isSuperadmin: true,
          memberships: { some: { tenant: { deletedAt: null } } },
        },
        data: { isSuperadmin: false },
      });

      if (count === 0) {
        throw new ConflictException(SUPERADMIN_WITHOUT_TENANT_MESSAGE);
      }
    });

    // After the write, never before — the same rule that `AdminService` sets up
    // for the deletion of an organisation: a line about a withdrawal that then
    // fails at the count would be the log of something that did not happen.
    this.logger.log(`user ${userId} revoked superadmin (user ${actorId})`);
  }

  /**
   * The ids of the accounts nobody has ever signed in to.
   *
   * **A second query instead of a second column**, and that is the whole
   * purpose: the condition "no password and no `oidc_subject`" is evaluated in
   * the database: the hash and the subject do not leave it, this process never
   * holds them in memory, and no later change to a mapper can carry them into a
   * response. The price is a second access to a table from which this route
   * reads a handful of rows.
   */
  private async pendingInvitationIds(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.user.findMany({
      where: { isSuperadmin: true, passwordHash: null, oidcSubject: null },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }
}

/** One row onto the wire form — the only place where that happens. */
function toView(row: SuperadminRow, pending: ReadonlySet<string>): Superadmin {
  return {
    userId: row.id,
    email: row.email,
    name: row.name,
    hasMembership: row.memberships.length > 0,
    invitationPending: pending.has(row.id),
  };
}
