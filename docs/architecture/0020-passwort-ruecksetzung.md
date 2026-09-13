# 20. Passwort setzen, ändern und zurücksetzen

- **Status:** accepted
- **Date:** 2026-08-14

## Context

Diese Anwendung konnte ein Passwort **vergeben** und danach nie wieder anfassen.
`POST /api/tenant/users` legte ein lokales Konto samt Kennwort an; von da an gab
es keinen Weg mehr — weder für die Person selbst noch für die Verwaltung ihrer
Organisation. `AuthController` kannte `login`, `logout`, `me` und
`sessions/revoke-others`, sonst nichts. Ein vergessenes Passwort bedeutete: ein
Konto, das niemand mehr öffnen kann, und die einzige Reparatur war das Entfernen
der Person und ein neues Konto.

Dieselbe Lücke von der anderen Seite: `tenantMemberUpdateSchema` trug **nur**
`groupId`, mit der Begründung „Name und E-Mail gehören der Person, nicht der
Organisation". Der Satz stimmt und die Schlussfolgerung war zu weit — er
beschreibt eine Grenze für *fremde* Konten, nicht ein Verbot für eigene. Ein
Tippfehler in der Adresse einer Person, die eine Organisation selbst angelegt
hatte, war unkorrigierbar.

Und ein dritter Befund derselben Familie (Befund 17): „Andere Sitzungen beenden"
stand als Knopf in der Kopfnavigation — die Handlung ist richtig, sie hatte nur
keinen Ort, an dem sie erklärbar war.

Zu entscheiden war deshalb nicht *ob*, sondern **wie** ein Passwort in diese
Anwendung zurückkommt, und zwar auf drei Wegen mit drei sehr verschiedenen
Vertrauensvoraussetzungen:

| Weg | Wer beweist was |
|---|---|
| Profil | die Person beweist ihr **altes Passwort** |
| Verwaltung | jemand mit `can_manage_users` beweist **gar nichts** über das Konto |
| „Passwort vergessen" | die Person beweist den Zugriff auf ihr **Postfach** |

Der dritte Weg wurde ausdrücklich gewünscht, gegen den Rat, ihn wegzulassen. Er
ist der sicherheitskritischste Teil dieser Änderung: er ist die einzige Route
dieser Anwendung, über die ein **Unangemeldeter** ein Konto öffnen kann.

## Decision

### 1. Drei Wege, drei Grenzen — und keine davon liegt in der Oberfläche

- **Profil** (`PUT /api/auth/profile`, `POST /api/auth/password`): die Kennung
  kommt aus der Sitzung, nie aus Pfad oder Rumpf. Die Schemata haben **kein
  Feld** für eine fremde Person, also gibt es keine Grenze zu prüfen, sondern
  eine, die nicht adressierbar ist. Das Ändern verlangt das alte Passwort —
  ohne diese Abfrage wäre ein unbeaufsichtigter Rechner mit offener Sitzung ein
  Konto, das der Nächstbeste endgültig übernimmt.
- **Verwaltung** (`PUT /api/tenant/users/:id`, `POST /api/tenant/users/:id/password`):
  hinter der vollen Guard-Kette und `can_manage_users`. Adresse und Passwort
  stehen zusätzlich unter drei Bedingungen (§2).
- **Rücksetzung** (`POST /api/auth/password-reset/request|confirm`):
  unangemeldet erreichbar, ohne CSRF-Schutz (es gibt kein Cookie zu
  missbrauchen), zweifach begrenzt, und mit einer Antwort, die nichts verrät
  (§4).

### 2. Eine Organisation entscheidet über ein Konto, solange es ihres allein ist

Adresse und Passwort eines Mitglieds sind **Anmeldeschlüssel**: wer sie setzt,
kommt in das Konto — und damit in *jede* Organisation, in der dieses Konto
arbeitet. Ohne Bedingung wäre die Mitgliederverwaltung einer beliebigen
Organisation ein Weg in jede andere.

Drei Bedingungen, in einer Fassung (`TenantUsersService.requireOwnAccount`):

1. **lokales Konto** — bei einem gebundenen SSO-Konto ist die Adresse ein Abbild
   dessen, was der Anbieter meldet (angemeldet wird über das Paar
   *(Issuer, Subject)*, ADR-0012), bei einer offenen Einladung ist sie die
   Bedingung, unter der sie eingelöst wird; sie umzuschreiben lenkte die
   Einladung auf eine andere Person um. Ein Passwort bekommt ein SSO-Konto
   ohnehin nicht — „kein Anbieterkonto mit einem zweiten, leisen Weg hinein"
   ist ADR-0012s eigene Regel;
2. **keine zweite Organisation** — dieselbe Linie, die `deleteHomelessAccount`
   schon zieht („was niemandem mehr gehört, geht mit");
3. **nicht die Systemverwaltung** — sonst wäre jede Organisation, in der ein
   Superadmin Mitglied ist, ein Weg zur Installation.

Der **Name** unterliegt keiner davon: er gewährt nichts. Ein Tippfehler im Namen
einer Person, die in zwei Organisationen arbeitet, wäre sonst von niemandem mehr
zu berichtigen.

Geprüft wird nur, was sich **wirklich ändert**. `PUT` trägt alle drei Felder
(eine Aussage über den Zielzustand, keine Liste von Änderungen); wer dieselbe
Adresse zurückschickt, bekommt keine Absage für eine Änderung, die er nicht
vornimmt — dieselbe Regel, die die Rolle seit einem früheren Befund hat.

### 3. **Jede** Passwortänderung beendet **jede** Sitzung — auf allen drei Wegen

In derselben Transaktion wie das Setzen der Änderung
(`ScopedMembershipDelegate.setPassword`, `ProfileService.changePassword`,
`PasswordResetService.redeem`). Ein Sitzungstoken kennt kein Passwort und liefe
bis zu 720 Stunden weiter (`SESSION_TTL_HOURS`) — ein Passwortwechsel, der die
Sitzungen stehen lässt, ist kein Widerruf, sondern ein zweiter Schlüssel neben
dem alten. Zwei getrennte Aufrufe hätten ein Fenster dazwischen und, schlimmer,
einen zweiten Aufrufer, der den zweiten vergessen kann.

**Die eigene Änderung im Profil ebenso** (nachgetragen 2026-08-15; die erste
Fassung dieses Abschnitts nahm sie ausdrücklich aus). Das Argument dafür war
„der häufige Fall ist der turnusmäßige Wechsel, und fünf abgemeldete Geräte
wären eine Überraschung". Es wiegt den teuren Fall nicht auf: **wer eine
Übernahme bemerkt, ändert als Erstes sein Passwort** — und erreichte damit
nichts, weil das Token des Einbrechers weiterlief. Die Überraschung ist
verschmerzbar und erklärbar, die stehengelassene Sitzung nicht. Der Widerruf
nimmt die **eigene** Sitzung mit; die Anfrage bekommt danach eine frische
ausgestellt, damit die Person nicht durch ihre eigene Vorsichtsmaßnahme
ausgesperrt wird. Was sie sieht, ist die Zahl der beendeten Sitzungen.

Der Knopf „Andere Sitzungen beenden" bleibt daneben stehen, mit seiner eigenen
Bestätigung — das ist der Ort, an den Befund 17 ihn verschoben hat. Er ist jetzt
das Werkzeug für „ohne Passwortwechsel aufräumen" statt die einzige Stelle, an
der überhaupt etwas beendet wird.

### 4. „Passwort vergessen" verrät nicht, ob es das Konto gibt

Vier Maßnahmen, und die vierte ist die, die man vergisst:

1. **Ein Statuscode.** `204`, kein Rumpf — für „gibt es", „gibt es nicht",
   „meldet sich per SSO an", „gehört keiner lebenden Organisation an" und für
   eine überschrittene Adressbegrenzung. Es gibt kein Antwortschema, weil es
   nichts zu antworten gibt.
2. **Fehler werden verschluckt**, nicht durchgereicht: ein 500 könnte nur auf
   dem Treffer-Zweig entstehen und wäre damit genau die Auskunft, die alles
   andere vermeidet. Was bleibt, ist eine Protokollzeile mit der **Fehlerklasse**
   — ohne Adresse, ohne Meldung des Treibers.
3. **Ein Laufzeitboden** von 400 ms auf **jedem** Zweig
   (`PASSWORD_RESET_FLOOR_MS`). Ohne ihn bliebe der Unterschied zwischen „zwei
   Zeilen schreiben" und „nichts tun" messbar; die gleiche Antwort mit einer
   messbar anderen Laufzeit ist keine gleiche Antwort. Kein Zufallsrauschen —
   das lässt sich wegmitteln, ein Boden nicht.
4. **Die Adressbegrenzung antwortet nicht.** Drei Mails je Adresse und Stunde;
   ist das Kontingent verbraucht, geschieht nichts und die Route antwortet wie
   sonst. Ein `429` an dieser Stelle käme nur für Adressen, die jemand oft genug
   angefragt hat — ein Messgerät.

Das **Einlösen** kennt genau eine Absage (`PASSWORD_RESET_INVALID_MESSAGE`) für
unbekannt, abgelaufen, verbraucht und SSO-Konto; und es hasht das neue Passwort
**vor** dem Nachschlagen, damit ein ungültiges Token nicht an der Antwortzeit zu
erkennen ist.

### 5. Das Token steht in keiner Spalte dieser Datenbank

Der Wert im Link ist `HMAC-SHA256(Unterschlüssel, id)` über die Kennung der
`password_reset`-Zeile; gespeichert wird nur sein SHA-256. Er ist damit aus
Zeile **plus** Installationsschlüssel (`SECRET_BOX_KEY` über HKDF, wie die
Startzeichen der öffentlichen Route) wiederherstellbar — und aus der Zeile
allein nicht.

**Der Grund ist nicht Eleganz, sondern eine konkrete Angriffsfläche.** Die Mail
geht über die Warteschlange (ADR-0004), deren Rumpf beim Einreihen eingefroren
und später **angezeigt** wird: `mailLogDetailSchema` trägt `bodyText`, und das
Versandprotokoll zeigt ihn hinter `can_manage_form_settings` +
`can_view_responses` ([ADR-0021](0021-recht-formular-einstellungen.md); bis
dahin war es das organisationsweite `can_manage_settings`). Stünde der Link dort, wäre diese **Leseansicht ein Weg zu
jedem lokalen Konto**, dessen Rücksetz-Mail in der Organisation gelandet ist —
an `can_manage_users` vorbei und vor der Systemverwaltung nicht haltmachend.

Weil das Token wiederherstellbar ist, trägt der gespeicherte Rumpf nur eine Marke
(`PASSWORD_RESET_LINK_MARK`), und die Adresse entsteht erst im Versandschritt
(`QueuedBodyRenderer`) — dieselbe Bauform, die der `{{bearbeiten}}`-Link schon
hat, samt der Schwärzung für die Detailansicht.

Was das kostet und bringt:

| Was leckt | reiner Zufallswert, Hash gespeichert | dieses Verfahren |
|---|---|---|
| Datenbankabzug | Token nicht ableitbar | Token nicht ableitbar |
| Signierschlüssel | — | nutzlos ohne Zeilen-Kennungen |
| beides | Token nicht ableitbar | Token ableitbar (nur offene Zeilen, max. 1 h) |
| `mail_log`-Leseansicht | **Token im Klartext** | nichts |

Die dritte Zeile ist der Preis, die vierte der Gewinn — und die vierte beschreibt
eine Ansicht, die dieses Produkt hat, während die dritte einen Angreifer
beschreibt, der Datenbank *und* Umgebung hält und damit ohnehin Sitzungen
ausstellen kann.

Folge davon: `password_reset.id` hat **keine `@default`-Vorgabe**. Hash und
Kennung müssen aus einer Hand kommen; eine von der Datenbank vergebene Kennung
ergäbe eine Zeile, deren Hash zu einem anderen Wert gehört — still unbrauchbar
statt laut falsch.

### 6. Einmal einlösbar, und jede Passwortänderung entwertet alles Offene

Das Einlösen setzt `used_at` in derselben Anweisung, die `used_at IS NULL` und
`expires_at > now` verlangt: zwei gleichzeitige Einlösungen sind ein Zähler von 1
und einer von 0, nie zwei Erfolge. Beim Einlösen werden **alle** Sitzungen der
Person beendet und alle weiteren offenen Links entwertet; dieselbe Entwertung
läuft bei der eigenen Passwortänderung und beim administrativen Setzen
(`invalidateOpenTokens` in `password-reset-invalidation.ts` — **eine Fassung,
vier Aufrufer**, immer in derselben Transaktion wie die Passwortänderung).

Die Anweisung steht in einem abhängigkeitsfreien Modul und nicht als Export der
Dienstklasse: der vierte Aufrufer ist `ScopedMembershipDelegate.setPassword` in
`tenant-scope.ts`, und der schrieb sie eine Zeit lang von Hand ab, obwohl kein
Zyklus dazu zwang (ein Review-Befund). Ein Import aus der Dienstdatei hätte
funktioniert und dafür deren gesamte Abhängigkeiten in den Importgraphen fast
jedes Anfragewegs gezogen — dieselbe Bauform, aus der `mail-log-erasure.ts`
neben `tenant-scope.ts` steht.

Ein **neuer** angeforderter Link entwertet die älteren derselben Person: der
zuletzt angeforderte gilt.

### 7. Frist eine Stunde, Aufbewahrung sieben Tage — im Lauf der Sitzungen

`PASSWORD_RESET_TTL_MINUTES = 60`, `PASSWORD_RESET_RETENTION_DAYS = 7` — dieselbe
Zahl wie `SESSION_RETENTION_DAYS` und bewusst keine zweite: die Zeile trägt
denselben Personenbezug und beantwortet dieselbe nachgelagerte Frage. Der
Aufräumlauf ist der der Sitzungen (`session_purge`), **kein zweiter `JobKind`**:
ein Rücksetz-Link ist ein Anmeldeartefakt wie eine Sitzung, und eine zweite
Kachel im Betriebsstatus beantwortete keine Frage, die die vorhandene nicht schon
beantwortet. Der Eintrag steht in der Fristentabelle von
[`docs/kb/10-datenschutz.md`](../kb/10-datenschutz.md), die
`retention-doc.test.ts` gegen die Konstanten hält.

### 8. Die Mail geht über die Warteschlange, unter der ältesten Organisation

`mail_log.tenant_id` ist NOT NULL, also braucht die Zeile eine Organisation. Es
ist die der **ältesten** Mitgliedschaft — die, in der das Konto entstanden ist —,
weil irgendeine zu wählen eine Münze wäre. Der Text ist fest und deutsch, keine
Vorlage: eine Mail, deren Wortlaut eine Organisation bestimmt, wäre ein Weg,
jemandem im Namen der Installation etwas zu schreiben, das nach Systemnachricht
aussieht. Kann der Link beim Zustellen nicht gebildet werden (keine
Basis-Adresse, Link abgelaufen), **scheitert der Versuch** statt eine Mail ohne
Link zuzustellen — sichtbar schlägt still.

## Alternatives considered

**„Passwort vergessen" weglassen.** Der ursprüngliche Rat. Ein selbstgehostetes
System mit wenigen Organisationen kommt weit damit, dass die Verwaltung ein
Passwort neu setzt (§1, zweiter Weg). Verworfen auf ausdrückliche Entscheidung —
und der Preis ist genau die Angriffsfläche, die §4 und §5 schließen. Was der
Verzicht *nicht* geleistet hätte: für die einzige Person, die keine Verwaltung
über sich hat — den Superadmin einer frischen Installation —, gibt es sonst
keinen Weg zurück.

**Ein zustandsloses, signiertes Token (Django-Bauart).** Signatur über
Kennung + aktuellem Passworthash, keine Tabelle. Elegant und mit einem
eingebauten „einmal": sobald das Passwort steht, passt die Signatur nicht mehr.
Verworfen, weil es die eigentliche Angriffsfläche **nicht** schließt — das Token
stünde weiterhin im Klartext in `mail_log.body_text` — und weil „einmal
einlösbar" dann eine Ableitung wäre statt einer Bedingung im `WHERE`, die man
lesen kann.

**Das rohe Token verschlüsselt in der Zeile ablegen** (Secret-Box, wie die
OIDC-Client-Secrets), damit der Versand es lesen kann. Gleichwertig sicher,
aber es legt einen **umkehrbaren** Wert in die Datenbank, den es sonst nirgends
gäbe, und braucht eine zweite Anweisung, die ihn nach dem Versand löscht — eine
Anweisung, die jemand vergessen kann. Die HMAC-Ableitung braucht sie nicht.

**Die Rücksetz-Zeile aus dem Versandprotokoll ausblenden**, statt das Token
herauszuhalten. Wäre in derselben Bauform gegangen wie `NOT_IN_TRASH` — eine
Bedingung im `WHERE` des einzigen Zugangs. Verworfen aus zwei Gründen: das
Klartext-Token läge dann bis zu 90 Tage in der Spalte und hinge an genau einer
`where`-Bedingung, und die Zeile verschwände auch für den Betreiber, der
nachsehen will, warum die Rücksetz-Mail nicht ankam. Mit der Marke bleibt die
Zeile sichtbar und trägt nur ein Etikett.

**Die Adressänderung ganz verbieten** (Zustand vor dieser Änderung). Verworfen:
sie macht eine Organisation unfähig, ihren eigenen Tippfehler zu berichtigen,
und die drei Bedingungen aus §2 treffen die Grenze genauer als ein pauschales
Nein.

**Die eigene Passwortänderung lässt die anderen Sitzungen stehen** — die erste
Fassung von §3. Begründung: der häufige Fall ist der turnusmäßige Wechsel, und
fünf abgemeldete Geräte sind eine Überraschung. Verworfen im Sicherheitsgate:
die Überraschung kostet einen erneuten Anmeldevorgang, die stehengelassene
Sitzung kostet den Widerruf. Wer eine Übernahme bemerkt, greift zum
Passwortwechsel und zu nichts anderem — ein Wechsel, der den Einbrecher
angemeldet lässt, beantwortet genau die Frage nicht, für die er benutzt wird.
Der Knopf „Andere Sitzungen beenden" deckt den turnusmäßigen Fall weiterhin ab,
und zwar ohne Passwortwechsel.

**Eine Sitzungsliste im Profil**, statt nur der Zahl beendeter Sitzungen.
Verworfen: welche Geräte jemand benutzt, wäre ein Bewegungsprofil, das diese
Anwendung nicht führt (`sessionRevocationSchema` trägt bewusst nur `revoked`).

**Das Einlösen meldet gleich an.** Bequem und falsch: wer den Link geklickt hat,
hat sein Postfach bewiesen und sonst nichts. Die Anmeldung mit dem frisch
gesetzten Passwort ist der Schritt, den auch die Person bemerkt, die den Link
nicht angefordert hat.

## Consequences

**Geschlossen:**

- Ein Rücksetz-Link ist über keine Leseansicht dieser Anwendung erreichbar (§5).
- Kein Antwortunterschied — Code, Rumpf, Laufzeit — zwischen einer Adresse, die
  es gibt, und einer, die es nicht gibt (§4).
- Kein zweifaches Einlösen, kein Einlösen nach Ablauf, kein überlebender Link
  nach einer Passwortänderung (§6).
- Keine Organisationsgrenze, die über die Mitgliederverwaltung überschritten
  werden kann: ein Konto, das anderswo arbeitet, ist dort nicht setzbar (§2).
- Kein Weg zur Systemverwaltung über eine Organisation (§2).
- Kein SSO-Konto bekommt ein Passwort — auf keinem der drei Wege (§2, §4).
- Kein Passwortwechsel, der eine übernommene Sitzung stehen lässt (§3, §6) —
  auf **allen drei** Wegen, die eigene Änderung im Profil eingeschlossen.

**Offen und benannt:**

- **Der Laufzeitboden schützt nur, solange er über der echten Arbeit liegt.**
  Eine Anforderung, die unter Last länger braucht, ragt darüber hinaus und wird
  wieder messbar. Kleiner würde der Rest nur, wenn die Mail vollständig aus dem
  Anfragepfad wanderte — dann verschwindet jeder Fehler still.
- **Beide Zähler leben im Prozess.** Eine zweite Instanz verdoppelt beide
  Kontingente, ein Neustart setzt sie zurück — dieselbe benannte Grenze, die
  `login-rate-limit.ts` schon trägt.
- **Die Ablehnung „dieses Konto arbeitet auch anderswo" ist selbst eine
  organisationsübergreifende Auskunft.** Sie ist der Preis dafür, dass die
  Absage erklärbar und reparierbar ist; *welche* Organisation es ist, steht
  nicht dabei.
- **Ein Schlüsselwechsel (`SECRET_BOX_KEY`) entwertet alle offenen Links.**
  Kein Verlust — sie gelten eine Stunde —, aber es steht hier, damit niemand es
  für einen Fehler hält.
- **Die eigene E-Mail-Adresse ändert man nicht selbst.** Ohne Bestätigung der
  neuen Adresse wäre es ein Weg, sich auszusperren; mit Bestätigung ein zweiter
  Mailweg mit eigener Token-Frage. Eine eigene Entscheidung, wenn sie ansteht.
- **Der Betriebsstatus nennt den Rücksetz-Purge nicht eigens** — er läuft unter
  „Tote Sitzungen" (§7).
- **Dass jemand eine Rücksetzung angefordert hat, steht im Versandprotokoll.**
  Nicht der Link (§5), aber Empfänger, Betreff und Zeitpunkt — wie bei jeder
  anderen Mail dieser Organisation. Das ist der Zweck des Protokolls und keine
  Ausnahme; wer es lesen darf, sieht ohnehin, an wen die Organisation schreibt.
  Der 90-Tage-Purge und das endgültige Löschen greifen unverändert.
