# 24. Einladung statt getipptem Passwort

- **Status:** accepted
- **Date:** 2026-08-18

## Context

Eine Person anzulegen hieß in dieser Anwendung: **jemand anderes tippt ihr
Passwort**. `tenantMemberCreateSchema` verlangte es im `local`-Arm,
`tenantFirstAdminSchema` verlangte es für die erste Administratorin einer neuen
Organisation, und `ScopedMembershipDelegate.createLocal` schrieb Konto und
Mitgliedschaft in einer Transaktion — **ohne Mail und ohne Warteschlangenzeile**.

Daraus folgten drei Zustände, die niemand gewollt hat:

1. **Die Person erfuhr nichts.** Es gab keine Nachricht, kein „für dich wurde
   ein Konto angelegt", keine Adresse, unter der sie sich anmelden könnte. Wer
   sie anlegte, musste sie anrufen — und ihr dabei das Kennwort vorlesen.
2. **Das Kennwort lief über einen zweiten Kanal**, den diese Anwendung nicht
   kennt und nicht absichern kann: Telefon, Chat, eine Mail aus einem fremden
   Postfach. Und es blieb, was es war — nichts verlangte, dass die Person es je
   änderte, und niemand konnte es prüfen.
3. **Die Verwaltung kannte es.** Ein Kennwort, das zwei Menschen kennen, ist
   keins; ein Konto, dessen Kennwort die Verwaltung gesetzt hat, gehört ihr
   mit — und mit ihm jede Organisation, in der es arbeitet.

Der OIDC-Zweig hatte dieselbe Lücke von der anderen Seite:
`createOidcInvitation` schrieb eine unbeanspruchte Einladung (ADR-0012 Nr. 3)
und schickte ebenfalls **nichts**. Die eingeladene Person konnte nicht wissen,
dass sie eingeladen war, unter welcher Adresse und über welchen Anmeldeweg.

Der Baustein für die Reparatur lag bereits vollständig da:
[ADR-0020](0020-passwort-ruecksetzung.md) hat einen einmaligen, kurzlebigen,
über die Warteschlange zugestellten Link gebaut, dessen Token in keiner Spalte
dieser Datenbank steht. Eine Einladung ist derselbe Vorgang mit einem anderen
Anlass — die Frage war nicht, *ob* dieser Mechanismus benutzt wird, sondern
**wie er erweitert wird, ohne die Zusagen zu verdünnen, für die er gebaut
wurde**.

## Decision

### 1. Das Passwortfeld verschwindet aus beiden Anlege-Masken

Der `local`-Arm von `tenantMemberCreateSchema` trägt kein `password` mehr, und
`tenantCreateSchema.admin` ebenso wenig (`tenantInvitedAdminSchema`). Die Person
bekommt eine Mail und setzt ihr Kennwort selbst über einen einmaligen Link.

Das Schema war vorher so begründet: „ein lokales Konto ohne Passwort ist dann
kein Dokument, das an der Prüfung scheitert, sondern eines, das man nicht
hinschreiben kann." Die **Form** war richtig, die **Sache** falsch. Jetzt gilt
dieselbe Form für die Umkehrung: ein getipptes fremdes Kennwort lässt sich nicht
mehr hinschreiben.

**Zwei Stellen behalten das Passwortfeld, und beide mit Grund:**

- **Die Erstinbetriebnahme** (`setupRequestSchema`, ADR-0022). Sie legt die
  *erste* Person einer Installation an, zu einem Zeitpunkt, an dem es weder
  Mailserver noch Basis-Adresse gibt — eine Einladung könnte niemand
  verschicken. Ein Superadministrator, der auf eine Mail wartet, die ohne ihn
  niemand absenden kann, wäre eine Installation, die sich selbst aussperrt. Sie
  benutzt weiterhin `tenantFirstAdminSchema`, und sie ist damit die **einzige**
  verbliebene Stelle, an der jemand ein Kennwort für ein Konto tippt — für ein
  Konto, das in diesem Augenblick sein eigenes ist.
- **`POST /api/tenant/users/:id/password`**, der Notfallweg der
  Organisationsverwaltung (ADR-0020 §1, zweiter Weg). Er ist ein **anderer**
  Vorgang: „diese Person kommt nicht mehr hinein und hat keine Mail" oder
  „dieses Konto muss sofort ein anderes Kennwort haben". Er steht unter den drei
  Bedingungen aus ADR-0020 §2 und beendet jede Sitzung. Er wird durch diese
  Entscheidung **erweitert**, nicht ersetzt: seine Bedingung lautete
  `password_hash IS NOT NULL` und lautet jetzt `oidc_issuer IS NULL AND
  oidc_subject IS NULL` — dieselben zwei Formen bleiben ausgeschlossen, und
  zusätzlich lässt sich damit eine Person retten, deren Einladung nie angekommen
  ist. Ohne diese Lockerung wäre ein Konto ohne Passwort von niemandem mehr zu
  öffnen.

### 2. Jede neu angelegte Person bekommt eine Mail — in zwei Fassungen

| Kontosorte | Inhalt |
|---|---|
| lokal | Link zum Setzen des Passworts (die Marke, siehe Nr. 5) |
| SSO | **kein Link**; wo man sich anmeldet und **welche Schaltfläche** man dort wählt |

Die SSO-Fassung nennt den Anmeldeweg beim Namen: die Basis-Adresse der
Installation und die Aufschrift der Schaltfläche dieser Organisation
(`tenant.oidc_button_label`, aufgelöst auf `DEFAULT_OIDC_BUTTON_LABEL`). „Melde
dich über SSO an" sagt niemandem, wo er klicken soll; was die Person auf der
Seite sucht, ist dieses Wort. Dazu der Satz, den ADR-0012 Nr. 3 nötig macht: die
Adresse, die der Anmeldedienst als verifiziert meldet, muss dieselbe sein, an
die die Mail ging — sonst wird die Anmeldung mit „kein Konto" abgewiesen.

**Die erste Administratorin einer neuen Organisation** bekommt dieselbe
Einladung. Zwei Ausnahmen, beide aus demselben Satz: *ein Konto, das schon
existiert, kennt sein Passwort.*

- `admin: null` („mich selbst eintragen") — das angemeldete Superadmin-Konto
  wird verknüpft, es geht **keine** Einladung hinaus;
- eine getippte Adresse, die schon ein Konto hat — sie wird verknüpft und nicht
  umgeschrieben (die Regel gab es schon), und deshalb auch nicht eingeladen.

### 3. Der Versand geht über den Mailserver der **Instanz**

`trigger: 'system'`, wie die Rücksetzung — und aus demselben Grund, nur
schärfer. Wer `can_manage_settings` einer Organisation hält, trägt deren
Mailserver ein; ginge die Einladung darüber, bekäme dieses Relay den fertig
gerenderten Klartext-Link, also die **Vollmacht über ein Konto**, das dieser
Person nicht gehört. [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md)
hat diese Entscheidung für die Rücksetzung am 2026-08-17 ausdrücklich bestätigt;
bei einer Einladung wiegt sie schwerer, weil sie **jedes** neue Konto betrifft
und nicht nur das, dessen Passwort gerade vergessen wurde.

Das ist eine bewusste Entscheidung mit einem benannten Preis: der Absender passt
nicht zur Organisation (SPF/DKIM der Installation), und **ohne Mailserver der
Instanz kann niemand eingeladen werden** — siehe Nr. 7.

### 4. Eine Frist von sieben Tagen, und eine eigene Konstante

`ACCOUNT_INVITATION_TTL_DAYS = 7`, neben `PASSWORD_RESET_TTL_MINUTES = 60`.
Nicht dieselbe Zahl, weil es nicht derselbe Anlass ist:

| | Rücksetzung | Einladung |
|---|---|---|
| wer löst aus | die Person selbst, gerade eben | jemand anderes, ohne Ankündigung |
| wann wird geklickt | in den nächsten Minuten | wenn die Person das nächste Mal ins Postfach sieht |
| was kostet ein Ablauf | eine neue Anforderung, selbst erledigt | eine Bitte an die Verwaltung |

Eine Stunde wäre für eine Einladung, die freitagnachmittags in ein Postfach
fällt, praktisch immer abgelaufen — und der Ausweg wäre nicht „noch einmal
anfordern", sondern „jemanden bitten", also genau der Weg, den diese Änderung
abschafft. Sieben Tage decken ein volles Wochenende und eine Brückentag-Woche ab
und lassen einen Link, der in einem geteilten oder archivierten Postfach liegen
bleibt, trotzdem nicht über ein Semester gültig sein.

Die globale Konstante wurde **nicht** verbogen: eine Rücksetzung gilt weiterhin
eine Stunde. Zwei Anlässe, zwei Zahlen, zwei Begründungen an zwei Namen.

Die **Aufbewahrung** ist dieselbe (`PASSWORD_RESET_RETENTION_DAYS = 7`,
`session_purge`): eine tote Einladungszeile trägt denselben Personenbezug und
beantwortet dieselbe nachgelagerte Frage wie eine tote Rücksetzzeile.

### 5. Dieselbe Tabelle, eine Art-Spalte — kein zweiter Mechanismus

`password_reset.kind` (`reset` | `invitation`), Vorgabe `reset`.

**Die Alternative wäre eine zweite Tabelle gewesen, und sie scheitert an einer
Zusage, die über beide Sorten laufen muss.** `invalidateOpenTokens` entwertet
bei *jeder* Passwortänderung **alles Offene** (ADR-0020 §6, eine Fassung, vier
Aufrufer). Mit einer Spalte ist das genau die Anweisung, die es heute ist —
`WHERE user_id = ? AND used_at IS NULL`, ohne `kind`. Mit zwei Tabellen wären es
zwei Anweisungen, und die zweite ist die, die jemand vergisst. Ein
Einladungslink, der eine Passwortänderung überlebt, ist der Zweitschlüssel, den
eine Passwortänderung beseitigen soll.

Dasselbe gilt für jede weitere Zusage der Zeile: einmal einlösbar über `used_at`
im `WHERE`, Token als HMAC über die Zeilen-Kennung, `mail_log_id` für den
Versandschritt, derselbe Aufräumlauf. Eine zweite Tabelle hieße, all das ein
zweites Mal zu schreiben.

Was die Sorte **tatsächlich** unterscheidet, sind drei Dinge, und keines davon
ist eine Erlaubnis: die Frist, der Text der Mail und die Adresse, unter der die
Oberfläche einlöst. **Das Einlösen selbst liest die Spalte nicht** — es gibt
keinen Weg, der für die eine Sorte erlaubt wäre und für die andere nicht.

Die Vorgabe ist `reset` und nicht „keine": `reset` ist die engere Sorte (kurze
Frist), eine vergessene Angabe fällt also auf die vorsichtige Seite. Geschrieben
wird sie trotzdem überall ausdrücklich.

Migration `20260818090000_account_invitations`. Bestehende Migrationen bleiben
unberührt.

### 6. `tryIssue` fragt jetzt nach dem **Anbieter**, nicht nach dem Passwort

Die Bedingung lautete `password_hash IS NOT NULL AND oidc_subject IS NULL` und
lautet jetzt `oidc_issuer IS NULL AND oidc_subject IS NULL` — an beiden Enden:
beim Ausstellen (`PasswordResetService.tryIssue`) und im `WHERE` des Einlösens
(`confirm`).

Was `password_hash IS NOT NULL` geleistet hat, war der Ausschluss der
unbeanspruchten SSO-Einladung — **mittelbar**, weil die kein Passwort hat. Das
tut `oidc_issuer IS NULL` unmittelbar und schärfer: es trifft auch eine Zeile,
die (entgegen jedem heutigen Schreibweg) beides trüge. Was die Bedingung
weiterhin verhindert, verhindert sie unverändert:

- **kein Rücksetz-Link für ein SSO-gebundenes Konto** — `oidc_subject IS NULL`;
- **kein Rücksetz-Link für eine unbeanspruchte SSO-Einladung** —
  `oidc_issuer IS NULL`, also kein zweiter, leiser Weg in ein Konto, das ein
  Anbieter beansprucht (ADR-0012);
- **keine Enumeration** — an der Antwort hat sich nichts geändert: ein
  Statuscode, kein Rumpf, derselbe Laufzeitboden auf jedem Zweig, dieselbe
  Adressbegrenzung (ADR-0020 §4). Die Bedingung sitzt hinter dem Boden, nicht
  davor.

Was **dazukommt**, ist gewollt: eine Person, deren Einladung abgelaufen ist,
kann sich über „Passwort vergessen" selbst weiterhelfen. Der Beweis ist derselbe
wie immer — der Zugriff auf ihr Postfach —, und was sie setzt, ist ihr *erstes*
Passwort statt eines neuen.

Das Einlösen trägt dieselben Zusagen wie eine Rücksetzung, weil es **derselbe
Code** ist: einmalig (`used_at` in derselben Anweisung), entwertet alle offenen
Token derselben Person, widerruft alle Sitzungen.

### 7. Ohne Mailserver der Instanz entsteht **kein Konto**

Der Anlege-Weg prüft **vorher** und antwortet mit 422 und einem Satz, der sagt,
wo es zu beheben ist (`INVITATION_NO_MAIL_SERVER_MESSAGE`,
`INVITATION_NO_BASE_URL_MESSAGE`). Die Oberfläche zeigt ihn an der Stelle, an
der jemand gerade steht — im Anlegen-Block der Mitgliederverwaltung und im
Formular „+ Neue Organisation".

**Warum nichts entsteht, statt es entstehen zu lassen und zu melden.** Ein Konto
ohne Passwort, dessen Einladung nie hinausging, ist die schlechteste aller
Varianten — der Auftrag sagt es, und hier kommt ein zweites Argument dazu: die
Mitgliederliste **kann** diesen Zustand nicht zeigen. `tenantMemberSchema` trägt
kein „hat schon ein Passwort", und es aufzunehmen hieße, den Passworthash in die
Projektion der Mitgliederliste zu holen, die ihn ausdrücklich nicht kennt
(`MEMBER_VIEW_SELECT`: „deriving the badge from `passwordHash !== null` would
mean reading the hash to render a label"). Der stille Zustand bliebe also
still. Nichts zu schreiben ist die reparierbare Richtung: der Mailserver wird
eingetragen, zwei Felder werden erneut ausgefüllt, fertig.

Geprüft wird `system_setting.smtp IS NOT NULL` — **ob einer eingetragen ist**,
nicht ob er sich öffnen lässt. Einen gespeicherten, aber unlesbaren Block
aufzuschlüsseln kostete je Anlege-Anfrage einen Schlüsselzugriff und
diagnostizierte einen installationsweiten Ausfall, der an jeder Mail ohnehin
sichtbar wird (ADR-0012 Nr. 7, dieselbe Richtung). Die Basis-Adresse wird
mitgeprüft, weil eine Einladung ohne Adresse, zu der sie führt, keine ist.

**Die eine Ausnahme steht in der Transaktion, nicht davor:** „+ Neue
Organisation" reicht den *Plan* hinein und lehnt erst ab, wenn tatsächlich ein
Konto angelegt werden müsste. Eine Adresse, die schon ein Konto hat, und
`admin: null` verschicken nichts — und dürfen deshalb auch ohne Mailserver
funktionieren.

### 8. Eine Einladung lässt sich erneut verschicken

`POST /api/tenant/users/:id/invitation`, hinter `can_manage_users` und der
vollen Guard-Kette, **204 ohne Rumpf**.

Es gibt kein Feld für einen Empfänger. Die Mail geht an die **gespeicherte**
Adresse, gelesen in derselben Transaktion, die die Zeile einreiht — eine Route,
an die man eine Adresse schicken könnte, wäre ein Weg, die Vollmacht über ein
fremdes Konto in ein selbstgewähltes Postfach zu leiten.

Drei Bedingungen, und die erste steht in derselben Transaktion wie das
Einreihen (`Serializable`, kein Lesen-dann-Schreiben):

1. **noch nicht eingerichtet** — ein lokales Konto ohne Passwort oder eine
   unbeanspruchte SSO-Einladung. Ein Konto mit Passwort und ein gebundenes
   SSO-Konto bekommen `INVITATION_ALREADY_SET_UP_MESSAGE`. Eine Einladung an ein
   funktionierendes Konto wäre keine Einladung mehr, sondern eine zweite
   Vollmacht;
2. **Mitglied dieser Organisation** — `unknown` ist dieselbe 404 wie für ein
   Mitglied einer fremden Organisation;
3. **nicht die Systemverwaltung** — dieselbe Linie wie `requireOwnAccount`.

Ein neuer Link entwertet die älteren derselben Person: der zuletzt verschickte
gilt.

Der Knopf steht in der Oberfläche bei **jedem** Mitglied, und der Server
entscheidet — dieselbe Bauform, die die Adressänderung eine Sektion höher schon
hat („die Felder stehen offen da, und der Server antwortet mit seinem eigenen
Satz"). Der Grund ist Nr. 7: die Liste weiß nicht, ob ein Konto sein Passwort
gesetzt hat, und sie soll es nicht wissen.

### 9. Zwei Adressen, ein Token, eine Einlöse-Route

`/password/<token>` und `/invitation/<token>` öffnen **dieselbe Seite** mit
**anderen Worten** und rufen **dieselbe Route** auf
(`POST /api/auth/password-reset/confirm`).

„Neues Passwort vergeben" ist für jemanden, der noch nie eines hatte, der
falsche Satz — er sucht dann nach dem alten und hält den Link für kaputt. Die
Seite braucht die Auskunft also, und sie darf sie nicht vom Server holen: eine
Route „was ist das für ein Token?" gibt es aus gutem Grund nicht (ADR-0020, kein
`GET` auf ein Token — ein Prüfgerät für geratene Werte ohne die
Argon2id-Bremse). Also kommt sie aus der **Adresse**, die der Versandschritt aus
der Art-Spalte baut.

Dass jemand die Adresse von Hand umschreiben kann, ändert nichts: er bekommt
dieselbe Seite mit anderen Worten und vom Server dieselbe Antwort. Die Adresse
bestimmt die Überschrift, nie die Vollmacht.

### 10. Fester Systemtext, keine bearbeitbare Vorlage

Im Muster von `password-reset-mail.ts` und `passwordSetNoticeBody`, und **nicht**
in `notification-templates.ts`. Die Begründung steht dort und gilt hier doppelt:
eine Mail, deren Wortlaut eine Organisation bestimmt, wäre ein Weg, im Namen der
Installation zu schreiben — und diese Mail trägt eine Vollmacht über ein Konto.
Ein Satz wie „bitte bestätige zuerst hier" neben dem echten Link wäre in einer
bearbeitbaren Vorlage eine Zeile Arbeit.

Gestaltet wird sie über die vorhandene Hülle: `{text, html}`, `text` immer
gesetzt, im HTML nur `<p style="margin:…">`, `escapeHtml()` und
`renderAnswerTable(...)`. **Eingehüllt wird hier nichts** — die Zeile geht über
`mail_log`, und `QueuedBodyRenderer.render` setzt `wrapMailHtml` beim Zustellen,
nachdem es die Marke gefüllt hat.

### 11. Der CHECK `user_has_credentials` weicht `user_local_or_oidc`

Eine frisch eingeladene lokale Person hat weder Passwort noch Issuer noch
Subject — die vierte Form von `user`, und sie verletzte den alten CHECK
(„Passwort **oder** Subject **oder** Issuer").

Ersatzlos zu streichen wäre der bequeme Weg. Stattdessen tritt an seine Stelle
die Bedingung, auf die sich die Anwendung ohnehin schon verlässt, ohne dass sie
irgendwo stand:

```sql
password_hash IS NULL OR oidc_issuer IS NULL
```

„Ein Konto ist lokal **oder** an einen Anbieter gebunden, nie beides." Genau
diese Kombination — ein Anbieterkonto mit einem zweiten, leisen Weg hinein — ist
das, was ADR-0012 ausschließt, und sie war bis hierher eine *dokumentierte
Voraussetzung* statt einer erzwungenen: der Docblock an `toView` nennt sie beim
Namen und sagt, dass die Datenbank sie nicht hält. Jetzt hält sie sie.

**Was dabei verloren geht, steht hier, damit es niemand für ein Versehen hält:**
„jede Zeile kann sich irgendwie anmelden" ist keine Zusage der Datenbank mehr.
Sie war auch vorher keine vollständige — eine unbeanspruchte SSO-Einladung
erfüllte den alten CHECK und konnte sich trotzdem nicht anmelden —, und sie
lässt sich in einem Tabellen-CHECK gar nicht ausdrücken: „hat Zugangsdaten
**oder** eine offene Einladung" reicht über `password_reset` hinüber. Was die
Eigenschaft trägt, sind die Schreibwege, und beide schreiben Konto,
Mitgliedschaft, Einladungszeile und Mail in **einer** Transaktion.

## Alternatives considered

**Das Konto trotzdem anlegen, wenn kein Mailserver da ist, und es melden.**
Verworfen (Nr. 7): der Zustand wäre in der Mitgliederliste nicht darstellbar,
ohne den Passworthash in eine Projektion zu holen, die ihn bewusst nicht kennt.
Ein Hinweis, den nur die Person sieht, die gerade auf „Hinzufügen" geklickt hat,
ist nach dem nächsten Seitenwechsel weg — und übrig bliebe ein Konto, von dem
niemand weiß, dass es tot ist. Nichts zu schreiben ist die Variante, die man
vollständig zurücknehmen kann.

**Eine zweite Tabelle `account_invitation`.** Verworfen (Nr. 5): sie
verdoppelte jede Zusage der Rücksetzzeile, und die wichtigste — „jede
Passwortänderung entwertet alles Offene" — wäre danach zwei Anweisungen statt
einer.

**Die globale Frist auf sieben Tage anheben.** Verworfen (Nr. 4): eine
Rücksetzung wird binnen Minuten geklickt, und ein Link, der eine Woche in einem
Archiv liegt, ist ein Dauerzugang. Zwei Anlässe brauchen zwei Zahlen; eine
Konstante, die für beide gilt, ist für einen von beiden falsch.

**`tryIssue` unverändert lassen und der Einladung einen eigenen Einlöseweg
geben.** Verworfen: zwei Wege, ein Passwort zu setzen, sind zwei Stellen für
„nur lokale Konten", „einmal einlösbar" und „alle Sitzungen enden". Die
Bedingung zu **schärfen** war billiger als sie zu kopieren — und sie ist dabei
strenger geworden, nicht laxer (Nr. 6).

**Ein Feld `invitationPending` auf `tenantMemberSchema`,** damit der Knopf
„Einladung erneut senden" nur dort steht, wo er etwas bedeutet. Verworfen: es
ließe sich nur aus dem Passworthash ableiten (den `MEMBER_VIEW_SELECT` bewusst
nicht liest) oder aus der Existenz einer offenen Einladungszeile — und die
zweite Ableitung driftet: fordert eine eingeladene Person selbst eine
Rücksetzung an, wird ihre Einladungszeile entwertet, das Feld sagte „fertig
eingerichtet", und das Konto hätte weiterhin kein Passwort. Ein Knopf, den der
Server beantwortet, ist ehrlicher als ein Feld, das manchmal lügt.

**Die Einladung über den Mailserver der Organisation.** Verworfen (Nr. 3), und
zwar dieselbe Entscheidung, die ADR-0023 für die Rücksetzung getroffen hat: wer
die Einstellungen einer Organisation verwaltet, dürfte sonst deren Mailserver
auf ein eigenes Relay stellen und Einladungslinks abgreifen. Wer das später
aufgreifen will, fängt bei ADR-0023 *Consequences* an — die Bedingungen, unter
denen es ginge, stehen dort.

**Die Einlöseseite als zweite Ansicht.** Verworfen: dieselben zwei Felder,
dieselbe Absage, dieselbe Route, derselbe „nicht anmelden"-Ausgang. Was sich
unterscheidet, sind vier Sätze, und die stehen jetzt als `Record` nebeneinander
— ein neuer Fall muss alle vier beantworten, während eine Ternärkette einen
davon still auf dem Wortlaut des anderen Falls stehen ließe.

## Consequences

**Geschlossen:**

- Niemand tippt mehr das Kennwort einer anderen Person — außer bei der
  Erstinbetriebnahme (das eigene) und auf dem Notfallweg der Verwaltung, der
  eine eigene Route mit eigenen Bedingungen ist.
- Eine neu angelegte Person erfährt, dass es ihr Konto gibt, unter welcher
  Adresse sie sich anmeldet und über welchen Weg — lokal wie per SSO.
- Ein Einladungslink ist über keine Leseansicht dieser Anwendung erreichbar: er
  trägt dieselbe Marke wie ein Rücksetz-Link und entsteht erst beim Zustellen
  (ADR-0020 §5).
- Kein Einladungslink überlebt eine Passwortänderung — dieselbe eine Anweisung,
  die es für Rücksetz-Links tut.
- Kein zweifaches Einlösen, kein Einlösen nach Ablauf, keine Sitzung, die ein
  Einlösen überlebt.
- Keine Einladung über den Mailserver einer Organisation.
- Kein Konto, dessen Einladung nie hinausging.
- Eine Kombination „Passwort **und** Issuer" ist jetzt von der Datenbank
  ausgeschlossen und nicht mehr nur dokumentiert.

**Offen und benannt:**

- **Ohne Mailserver der Instanz kann keine Organisation Personen anlegen.** Das
  ist der Preis von Nr. 3 und dieselbe Abhängigkeit, die „Passwort vergessen"
  seit ADR-0020 hat — jetzt trifft sie einen Weg, den man täglich benutzt. Die
  Absage sagt, wo es zu beheben ist, aber die Person davor kann es meist nicht
  selbst.
- **„Jede Zeile kann sich irgendwie anmelden" ist keine Datenbankzusage mehr**
  (Nr. 11). Eine abgelaufene, nie eingelöste Einladung ist eine `user`-Zeile
  ohne jede Anmeldemöglichkeit, und sie belegt die installationsweit eindeutige
  Adresse — derselbe offene Punkt, den ADR-0012 für die SSO-Einladung schon
  benennt. Der Ausweg ist derselbe: entfernen (`deleteHomelessAccount` nimmt sie
  mit, sobald die letzte Mitgliedschaft geht) oder erneut einladen.
- **Ein Schlüsselwechsel (`SECRET_BOX_KEY`) entwertet alle offenen
  Einladungen** — wie bei den Rücksetz-Links, nur eine Woche lang statt einer
  Stunde. Kein Verlust, aber es steht hier, damit niemand es für einen Fehler
  hält.
- **Dass jemand eingeladen wurde, steht im Versandprotokoll der Organisation.**
  Nicht der Link, aber Empfänger, Betreff und Zeitpunkt — wie bei jeder anderen
  Mail. Das ist der Zweck des Protokolls, und es ist die Stelle, an der man
  nachsieht, warum eine Einladung nicht angekommen ist.
- **Die Mitgliederliste zeigt eine noch nicht eingelöste lokale Einladung als
  „Lokal"** (Nr. 7, `deriveAccountKind` liest den Hash nicht). Wer wissen will,
  ob jemand schon drin war, sieht im Versandprotokoll nach oder drückt auf
  „Einladung erneut senden" und liest die Antwort.

## References

- [ADR-0020](0020-passwort-ruecksetzung.md) (der Mechanismus, den diese
  Entscheidung erweitert) ·
  [ADR-0012](0012-oidc-kontobindung.md) (warum ein Anbieterkonto kein Passwort
  bekommt, und die SSO-Einladung) ·
  [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md) (warum eine
  Kontomail über die Installation geht) ·
  [ADR-0022](0022-erstinbetriebnahme.md) (die eine Stelle, die ihr Passwortfeld
  behält) · [ADR-0004](0004-mail-db-queue.md) (die Warteschlange)
