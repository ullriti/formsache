import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  accountInvitationPath,
  insertPasswordResetLink,
  wrapMailBody,
} from '@formsache/shared';

import { SigningService } from '../common/secret-box/signing.service';
import { PublicUrlService } from '../common/public-url/public-url.service';
import { deliverMail } from '../mail/mail-delivery';
import { MailIdentityService } from '../mail/mail-identity.service';
import { MAIL_TIMEOUTS, type MailTimeouts } from '../mail/mail-timeouts';
import { MailTransport, SYSTEM_IDENTITY_KEY } from '../mail/mail-transport';
import { recoverPasswordResetToken } from '../auth/password-reset/password-reset-token';
import type { AccountInvitation } from '../auth/invitation/account-invitation';

/**
 * **Die Einladung in die Systemverwaltung — verschickt, ohne einer
 * Organisation zu gehören** (Review-Runde 3 Nr. 13).
 *
 * ## Der Anlass
 *
 * *„… dort würde ich ja auch gerne jemanden einladen, der in keiner Orga
 * ist."* `POST /admin/superadmins` konnte bis dahin nur **ernennen**, wer
 * schon ein Konto hat — und ein Konto entsteht in dieser Anwendung immer
 * zusammen mit einer Mitgliedschaft. Wer die zweite Person für die
 * Systemverwaltung wollte, musste sie erst in irgendeine Organisation
 * aufnehmen. Das ist eine Mitgliedschaft, die niemand wollte, in einer
 * Organisation, die damit nichts zu tun hat.
 *
 * ## Warum diese eine Mail an der Warteschlange vorbeigeht
 *
 * Weil sie in ihr keinen Platz hat. Die Warteschlange **ist** `mail_log`, und
 * `mail_log.tenant_id` ist `NOT NULL`: jede Zeile gehört einer Organisation.
 * Eine Einladung in die Systemverwaltung gehört keiner — sie in die
 * Organisation des Einladenden zu legen hieße, deren Verwaltung die Adresse
 * einer Person zu zeigen, die mit ihr nichts zu tun hat.
 *
 * Drei Möglichkeiten, vollständig:
 *
 * | | Ansatz | Bewertung |
 * |---|---|---|
 * | **(a)** | **`mail_log.tenant_id` nullbar machen** | **Verworfen** — für einen Knopf. Die Spalte trägt die Mandantentrennung des Versandprotokolls; nullbar bräuchte sie eine eigene Spur im Worker (`MAIL_WORKER_TENANT_LANES` ist rohes SQL über `tenant_id`), eine Migration, eine Antwort in jeder Leseansicht und einen eigenen ADR. Dieselbe Abwägung, mit der die Testmail ohne Organisation ihren Protokolleintrag verliert statt die Spalte. |
 * | **(b)** | **In die Organisation des Einladenden legen** | **Verworfen.** Die Zeile trägt die Adresse der eingeladenen Person, und wer in jener Organisation das Versandprotokoll liest, hat mit ihr nichts zu tun. Eine kleine, echte Preisgabe über die Mandantengrenze hinweg. |
 * | **(c)** | **Unmittelbar über den Systemblock verschicken**, wie der Betriebsalarm | **Gewählt.** |
 *
 * **(c) ist kein neuer Weg**, sondern der, den `OpsAlertService` seit ADR-0016
 * geht: eine Mail der **Installation** an den Betreiber, ohne Organisation,
 * ohne Protokollzeile, über `MailTransport` unmittelbar. Was hier dazukommt,
 * ist die Einlösung des Links — und auch die ist keine zweite Wahrheit,
 * sondern dieselbe Funktion, die der Worker benutzt
 * ({@link recoverPasswordResetToken} und `accountInvitationPath`).
 *
 * ## Der Preis, benannt
 *
 * Keine Warteschlange heißt: **kein Wiederholen und kein Nachlesen.** Ein
 * stummer Mailserver ergibt hier keinen Eintrag mit `failed`, sondern eine
 * Absage in der Antwort. Damit daraus kein Konto entsteht, das niemand
 * einlösen kann, nimmt `SuperadminsService.invite` es wieder zurück — der
 * zweite Versuch ist derselbe Knopf, und die Adresse ist danach wieder frei.
 * Ein „Einladung erneut senden" auf der Zeile gibt es deshalb **nicht**: es
 * wäre ein zweiter Weg zu demselben Ziel für einen Zustand, den es hier gar
 * nicht mehr gibt.
 *
 * ⚠️ **Und der Grund, warum es überhaupt tragbar ist:** diese Mail geht an
 * **eine** Adresse, die ein Superadministrator gerade getippt hat, höchstens
 * ein paar Mal im Leben einer Installation. Sie ist kein Massenversand, sie
 * blockiert keine Anfrage länger als eine Testmail, und sie hat dieselbe
 * Rate-Begrenzung wie die Route, auf der sie steht.
 */
@Injectable()
export class SuperadminInvitationService {
  /**
   * Nur der Ausgang, nie eine Adresse und nie ein Name
   * (`CONTRIBUTING.md`: keine personenbezogenen Daten in Protokollen).
   */
  private readonly logger = new Logger(SuperadminInvitationService.name);

  constructor(
    private readonly identities: MailIdentityService,
    private readonly transport: MailTransport,
    @Inject(MAIL_TIMEOUTS) private readonly timeouts: MailTimeouts,
    private readonly publicUrls: PublicUrlService,
    private readonly signing: SigningService,
  ) {}

  /**
   * Verschickt die eben geschriebene Einladung.
   *
   * @param recipient Die Adresse aus der geschriebenen Zeile — **nicht** die
   *   aus der Anfrage. Dieselbe Regel wie in `enqueueInvitation`: so kann es
   *   nicht die von vorher sein.
   * @returns `null`, wenn sie hinausging, sonst der Grund als **Kategorie**.
   *   Wörtlich wäre hier so falsch wie auf der Testmail-Route: der Leser ist
   *   der Mensch, der den Knopf gedrückt hat, und `connect ECONNREFUSED
   *   10.8.0.12:587` ist eine Auskunft über das innere Netz des Betriebs
   *   (ADR-0013 „Consequences").
   */
  async deliver(
    invitation: AccountInvitation,
    recipient: string,
  ): Promise<string | null> {
    const identity = await this.identities.systemBlock();
    if (identity.kind !== 'send') {
      return identity.reason;
    }

    const base = await this.publicUrls.installationBaseUrl();
    if (base === null) {
      // Unerreichbar über die Route: `AccountInvitationService.plan` hat sie
      // vor dem Schreiben verlangt. Ehrlich getippt statt weggeworfen — die
      // Alternative wäre ein `!`, das eines Tages nicht mehr stimmt.
      return 'Die Basis-Adresse der Installation ist nicht eingetragen.';
    }
    if (invitation.token === null) {
      // Ebenso: die Einladung in die Systemverwaltung ist immer die eines
      // lokalen Kontos — es gibt keinen Anmeldedienst der Installation.
      return 'Zu dieser Einladung gehört kein Link.';
    }

    /*
      **Die Marke wird hier gefüllt, nicht gespeichert.** Der Wortlaut der
      Einladung trägt `PASSWORD_RESET_LINK_MARK` (ADR-0020): der Link steht in
      keiner Spalte, und weil diese Mail gar nicht gespeichert wird, entsteht
      er nur im Speicher dieses Aufrufs. Der Token wird aus der Zeilen-Kennung
      **zurückgerechnet** — dieselbe Funktion, die `QueuedBodyRenderer` für die
      Warteschlange benutzt.
    */
    const url = `${base}${accountInvitationPath(
      recoverPasswordResetToken(this.signing, invitation.token.id),
    )}`;
    const slot = { present: true, url } as const;
    const wrapped = wrapMailBody(
      {
        text: insertPasswordResetLink(
          invitation.bodyText,
          'text',
          slot,
          'real',
        ),
        html: insertPasswordResetLink(
          invitation.bodyHtml,
          'html',
          slot,
          'real',
        ),
      },
      // Die Hülle der **Installation**: kein Name und keine Farbe einer
      // Organisation, denn es ist keine beteiligt (dieselbe Begründung wie
      // beim Betriebsalarm).
      { link: { owner: 'installation', url: base } },
    );

    const outcome = await deliverMail({
      transport: this.transport,
      timeouts: this.timeouts,
      mail: {
        to: recipient,
        subject: invitation.subject,
        text: wrapped.text,
        ...(wrapped.html === undefined ? {} : { html: wrapped.html }),
        ...(invitation.replyTo === null ? {} : { replyTo: invitation.replyTo }),
      },
      identity: { key: SYSTEM_IDENTITY_KEY, block: identity.block },
      reasonStyle: 'category',
    });

    if (outcome.kind === 'failed') {
      this.logger.warn(
        `superadmin invitation could not be delivered (${outcome.reason})`,
      );
      return outcome.reason;
    }
    return null;
  }
}
