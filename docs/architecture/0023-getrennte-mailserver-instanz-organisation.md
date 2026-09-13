# 23. Getrennte Mailserver — der der Instanz gehört dem Betrieb, der der Organisation ihr

- **Status:** accepted
- **Date:** 2026-08-17

## Context

[ADR-0013](0013-versandidentitaet-je-organisation.md) hat die Versandidentität
je Organisation entschieden und dabei **zwei** Zustände zugelassen: eine
Organisation sendet über ihren eigenen Mailserver, oder sie **erbt** den der
Installation. Die Vererbung war die Voreinstellung — eine leere `tenant.smtp`
hieß „erbt", und der Block der Installation war damit der Weg, über den die
Post der allermeisten Organisationen hinausging.

Diese Bequemlichkeit hat einen Preis, den ADR-0013 selbst benennt, ohne die
Folgerung zu ziehen: **der Transport der Installation ist für die Domäne der
Installation per SPF und DKIM autorisiert.** Erbt eine Organisation ihn, geht
ihre Post unter der Absenderadresse der Installation hinaus — technisch
einwandfrei, für den Empfänger aber Post von jemand anderem als dem
Absender, den er erwartet. Und die Installation haftet mit ihrem Ruf für
Nachrichten, deren Inhalt und Empfängerkreis eine fremde Organisation
bestimmt.

Dazu kommt eine zweite Frage, die die Vererbung offen ließ: **wem gehört der
Mailserver der Installation eigentlich?** Er hatte zwei Aufgaben, die nichts
miteinander zu tun haben — die Betriebsalarme des Betreibers
([ADR-0016](0016-betriebsueberwachung-und-alarmierung.md)) und die Post
erbender Organisationen. Wer ihn abschaltete, um den Betrieb umzustellen, nahm
damit unbemerkt der halben Installation den Versand weg.

**Es gibt keine laufende Installation.** Es ist also nichts zu migrieren und
nichts kompatibel zu halten — der Schnitt kann sauber sein, und ein
Alt-Dokument braucht keine Duldung.

## Decision

### 1. Keine Vererbung. Jede Organisation hat ihren eigenen Mailserver — oder keinen

`tenant.smtp` und `system_setting.smtp` halten **dasselbe Dokument**: den
nackten Block aus `mail-config.ts` (Host, Port, `secure`, `auth`, `from`), oder
SQL NULL. Die diskriminierte Union fällt weg; der Arm `source: 'system'` war
die Vererbung, und mit ihr verschwindet er.

Was bleibt, ist die Unteilbarkeit: ein Dokument, das nur `from` setzt, ist
weiterhin nicht ausdrückbar — der Grund dafür (ADR-0013 Nr. 1 und 2) ist von
dieser Entscheidung unberührt und gilt jetzt für beide Zeilen gleich.

**„Nicht eingerichtet" bleibt kein `failed`.** Eine Organisation ohne
Mailserver bekommt `WithholdIdentity`: die Zeile bleibt `queued`, verbraucht
**keinen** Versuch, und sobald jemand einen Mailserver einträgt, geht sie
hinaus. Das ist die Eigenschaft aus ADR-0013 Nr. 5, die eine frisch angelegte
Organisation arbeitsfähig hält, und sie ist an derselben Stelle geblieben — nur
heißt sie jetzt „diese Organisation hat keinen", nicht mehr „die Installation
hat keinen".

Der Grund ist ein **eigener Satz**
(`TENANT_MAIL_NOT_CONFIGURED_REASON`), weil der Leser ein anderer ist: die
Person, die ihn im Versandprotokoll ihrer Organisation liest, kann unter
*Mailversand* etwas eintragen und soll dorthin verwiesen werden — nicht auf die
Systemverwaltung, zu der sie keinen Zugang hat.

### 2. Der Mailserver der Instanz ist der des Betreibers

Er bedient, was die **Anwendung** verschickt, nicht was eine Organisation
verschickt:

- die **Betriebsalarme** (`OpsAlertService`, ADR-0016),
- die **Testmail der Systemverwaltung**
  (`SystemTestMailController`, ADR-0013 Fortschreibung 29a), und
- jede **Kontomail** — Passwort-Rücksetzung (ADR-0020 §8), die Mitteilung über
  ein administrativ gesetztes Passwort, und seit
  [ADR-0024](0024-einladung-statt-getipptem-passwort.md) die **Einladung**.

> **Nachtrag 2026-08-18.** Diese Aufzählung nannte zuerst nur die ersten
> beiden. Das war schon damals zu eng: die Kontomails reihen mit
> `trigger: 'system'` ein und nahmen deshalb immer diesen Arm. Die Einladung
> hat den Punkt sichtbar gemacht — sie trägt eine Vollmacht über ein Konto, und
> ginge sie über die Organisation, könnte deren Verwaltung sie abgreifen.

Er wird **nie** als Ersatz für einen fehlenden Mailserver einer Organisation
benutzt. `MailIdentityService.resolve` hat vom `'tenant'`-Arm keinen Weg zum
`'system'`-Arm — und das ist eine **Abwesenheit**, keine Prüfung: wer die
Vererbung zurückholen wollte, müsste eine Zeile hinzufügen, nicht eine
entfernen.

### 3. Der eine benannte Sonderfall: ein Konto ohne Organisation

Eine Kontomail (Passwort-Rücksetzung, Mitteilung über ein gesetztes Passwort)
gehört zu einer Person, und die Person gehört zu einer Organisation. Es gibt
genau einen Fall, in dem das nicht gilt: ein Konto, das **gar keiner**
Organisation angehört — typisch ein Superadmin ohne Mitgliedschaft. Für ihn
gibt es keinen Organisations-Mailserver, über den etwas gehen könnte, und ohne
einen Ausweg hätte er überhaupt keinen Weg zurück in sein Konto.

Solche Mails gehen über den Mailserver der Instanz. Das ist eine **Ausnahme mit
Namen**, kein Rückfall: sie greift, weil es keine Organisation *gibt*, nie
weil eine Organisation keinen Mailserver hat. Sie ist an
`MailIdentitySource` kommentiert und über `resolve(…, 'system')` geprüft.

> ⚠️ **Offen und ausgesprochen:** die Zeile für ein solches Konto ist heute
> nicht *einreihbar*, weil `mail_log.tenant_id` `NOT NULL` ist —
> `PasswordResetService` bricht für ein Konto ohne lebende Mitgliedschaft
> stillschweigend ab (ADR-0020 §8). Was diese Entscheidung liefert, ist die
> **Naht** samt Nachweis; wer den Weg baut, entscheidet zusätzlich, ob die
> Spalte nullable wird oder ob die Mail wie ein Betriebsalarm an der
> Warteschlange vorbei zugestellt wird.

### 4. `notification_trigger = 'system'` bleibt — mit engerer Bedeutung

Der Wert und die **Systembahn** des Workers bleiben, was sie sind: eine Bahn,
eine Identität, die der Installation. Enger ist ihre Bedeutung: `system` heißt
jetzt „diese Zeile gehört der Installation", nicht mehr „diese Zeile gehört
einer Organisation, geht aber über die Installation hinaus". `identitySourceOf`
bleibt die eine Fassung dieser Zuordnung, `MailLaneMismatchError` bleibt die
Wache dazu, und die Transport-Auswahl je Identität ist unverändert.

Was sich im Worker ändert, ist eine **Abkürzung, die verschwindet**: eine
Organisation mit leerer Spalte bekam bisher das Ergebnis der Systembahn
zurückgereicht (eine Auflösung je Lauf für alle erbenden Organisationen). Jetzt
löst jede Bahn ihre eigene Identität auf — für eine leere Spalte ohne jede
Abfrage, weil `openTenantBlock(null, …)` nichts liest.

### 5. Die Oberfläche sagt die Folge, statt sie zu verschweigen

In der Organisationsverwaltung fällt die Umschaltung „System ⇄ Eigener" weg;
es bleibt ein Schalter *Mailserver eingerichtet* — dieselbe Bauform, die die
Systemverwaltung für ihren eigenen Block schon hat. Ist er aus, steht darüber
in klaren Worten, was das heißt: **diese Organisation verschickt nichts**,
Bestätigungen und Benachrichtigungen bleiben in der Warteschlange, und verloren
geht nichts.

Der Hinweis trägt `role="status"` und nicht `role="alert"`: „kein Mailserver"
ist ein zulässiger Zustand, keine Störung — aber eben auch keiner, den man erst
am ausbleibenden Posteingang bemerken soll.

Auf dem Reiter *Mailserver* der Systemverwaltung sagen die Texte jetzt, wessen
Server das ist: der **der Instanz**, für Betriebsmeldungen und die Testmail
dieser Seite. Vorher stand dort das Gegenteil („wenn eine Organisation keinen
eigenen hinterlegt hat").

### 6. Keine DDL-Migration

`tenant.smtp` ist `jsonb`; die Form des Dokuments ändert sich, die Spalte
nicht. Es gibt keine Installation, auf der ein Alt-Dokument stünde, also gibt
es auch nichts umzuschreiben. Ein hinterlassenes `{"source":"system"}` **parst
nicht** und wird als unlesbarer Block abgelehnt — nicht als „kein Mailserver"
gedeutet. Zwei Bedeutungen für einen Zustand sind genau die Doppelung, die der
saubere Schnitt vermeidet.

## Consequences

- **Eine Organisation ohne Mailserver verschickt nichts.** Das ist der Zweck
  und zugleich der Preis: eine frisch angelegte Organisation ist ohne diesen
  Eintrag stumm. Sichtbar gemacht wird das auf der Karte (Nr. 5) und im
  Versandprotokoll an jeder wartenden Zeile.
- **Der Mailserver der Instanz darf fehlen**, ohne dass eine Organisation davon
  betroffen ist. Die Startmeldung sagt das jetzt auch so: ohne ihn bleiben
  Betriebsalarme und die Testmail der Systemverwaltung aus, mehr nicht.
- **Zwei Sätze für „kein Mailserver"** statt einem. Bewusst: sie stehen an
  verschiedenen Zeilen und richten sich an verschiedene Personen mit
  verschiedenen Handlungsmöglichkeiten.
- **Im Browser belegt seit dem 2026-08-18.** `durchlauf-organisationen.spec.ts`
  Schritt 5 fährt beide Hälften an einer laufenden Anwendung: Organisation B
  mit eigenem Mailserver stellt zu, Organisation A ohne einen bleibt mit dem
  Grund in der Zeile stehen — und **der Mailserver der Installation trägt von
  beidem nichts**. Die letzte Aussage ist die Sicherheitshälfte (Nr. 2) und war
  bis dahin von keinem Fall geprüft; der Schritt maß stattdessen noch die
  Vererbung, die dieses ADR abgeschafft hat, und wartete auf ein „Zugestellt",
  das nicht mehr kommen kann. Gesehen wurde das erst an diesem Tag, weil das
  Projekt von `mobile-360x740` abhängt und solange dort etwas rot war, gar
  nicht lief.
- **Der Testaufbau musste umgestellt werden.** Eine Fixture-Organisation ohne
  Block ließe jede Warteschlangen-Suite still auf `withhold` laufen — grün wäre
  daran nichts, aber die Aussage wäre weg. `createTenant`/`createMailTenant`
  vergeben deshalb standardmäßig einen eigenen Block; `null` ist ein
  ausdrücklicher Parameter für die Suiten, die das Zurückhalten *meinen*.
- **Entschieden: eine Kontomail geht weiter über den Mailserver der
  Installation.** Die erste Absicht war die andere — eine Mail an eine Person
  **einer** Organisation über deren Mailserver, auch Rücksetzung und Einladung,
  damit der Absender zu SPF/DKIM passt. Beim Umsetzen kam der Angriffsweg unter
  Nr. 2 zutage, und daraufhin fiel die Entscheidung am 2026-08-17 ausdrücklich
  **gegen** die Umstellung: die Rücksetz-Mail bleibt bei der Installation, wie
  [ADR-0020](0020-passwort-ruecksetzung.md) §8 sie gebaut hat. Der Preis ist
  benannt: der Absender passt nicht zur Organisation, und ohne Mailserver der
  Installation kann sich niemand ein Passwort zurücksetzen. Die zwei Gründe,
  die dahin geführt haben:
  1. Die beiden Einreihstellen liegen in `apps/api/src/auth/password-reset/`
     und `apps/api/src/tenancy/tenant-scope.ts` und stempeln
     `trigger: 'system'`. Dieser Wert trägt dort **drei** Bedeutungen, nicht
     eine: den Transport, die Basis-Adresse des Links (ADR-0020 §5) und die
     Nicht-Wiederholbarkeit im Versandprotokoll (ADR-0021). Nur die erste soll
     sich ändern.
  2. ADR-0020 hat den heutigen Weg **aus einem Sicherheitsgrund** so gebaut:
     wer `can_manage_settings` einer Organisation hält, trägt deren Mailserver
     ein; ginge die Rücksetz-Mail eines Superadmins, der in dieser Organisation
     Mitglied ist, über diesen Server, bekäme dieser Relay den fertig
     gerenderten Klartext-Link. `apps/api/test/auth/password-reset-delivery.spec.ts`
     hält genau das fest. Die Umstellung kehrt diese Entscheidung um und
     bräuchte deshalb ein eigenes Sicherheits-Gate — etwa: über die
     Organisation nur für Konten ohne Superadmin-Recht und mit genau einer
     Mitgliedschaft. Wer das später aufgreift, fängt hier an.

## Alternatives considered

**Die Vererbung behalten und nur die Absenderadresse je Organisation setzen.**
Der billige Weg zu „die Mail soll von uns kommen" — und exakt die
SPF/DKIM-Fälschung, die ADR-0013 Nr. 2 ausschließt. Unverändert
ausgeschlossen.

**Die Vererbung als abwählbare Voreinstellung behalten.** „Erbt, solange nichts
eingetragen ist" ist bequem und genau deshalb gefährlich: der gefährliche
Zustand wäre der Standardzustand, und niemand träfe ihn absichtlich. Verworfen —
eine Voreinstellung, die man kennen muss, um sie zu vermeiden, ist keine.

**Ein `failed` statt `withhold` für eine Organisation ohne Mailserver.** Spart
einen Sonderfall und kostet die Eigenschaft, für die es ihn gibt: eine Zeile,
die `failed` ist, geht auch nach dem Eintragen des Mailservers nicht mehr
hinaus. Verworfen aus demselben Grund wie in ADR-0013 Nr. 5.

**Die Systembahn ersatzlos streichen.** Naheliegend, sobald keine
Organisationspost mehr über die Installation geht: die Bahn trüge dann nur noch
die Testmail der Systemverwaltung. Verworfen, weil sie die Naht für den
Sonderfall aus Nr. 3 ist und weil eine Bahn-/Zeilen-Prüfung, die es nicht mehr
gibt, sich nicht wieder einbauen lässt, wenn sie gebraucht wird.

## References

- [ADR-0004](0004-mail-db-queue.md) (die Warteschlange) ·
  [ADR-0013](0013-versandidentitaet-je-organisation.md) (was diese
  Entscheidung fortschreibt) ·
  [ADR-0016](0016-betriebsueberwachung-und-alarmierung.md) (wofür der
  Instanz-Mailserver bleibt) ·
  [ADR-0020](0020-passwort-ruecksetzung.md) (die offene Frage aus den
  *Consequences*)
