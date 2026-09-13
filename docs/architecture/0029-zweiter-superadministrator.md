# ADR-0029: Der zweite Superadministrator — eine Oberfläche statt einer Datenbanksitzung

- **Status:** accepted
- **Datum:** 2026-08-19
- **Beantwortet:** die offene Entscheidung aus
  [ADR-0022](0022-erstinbetriebnahme.md) („Ob eine Installation je einen
  **zweiten** Superadministrator über eine Oberfläche bekommen soll").
  **Unberührt** bleibt dort alles andere — insbesondere §3 (die Bedingung in
  derselben Transaktion), §4 (der Befehl) und die Zusage von §6, dass
  `is_superadmin` **kein Feld eines Anfragedokuments** ist.

## Kontext

Eine Installation bekam ihren ersten Superadministrator auf einem von zwei
Wegen: dem Einrichtungsassistenten (`POST /api/setup`) oder
`scripts/create-superadmin.sh`. **Beide verlangen null Zeilen in `user`**
(ADR-0022 §3) — und diese Bedingung ist keine Nachlässigkeit, sondern die
Sicherung, die verhindert, dass eine laufende Installation über eine
ungeschützte Route einen weiteren Vollzugriff ausgibt.

Die Folge war ein **Einzelpunkt des Ausfalls**. Verliert der eine
Superadministrator seinen Zugang — Passwort weg, Konto gesperrt, Person
ausgeschieden —, dann gibt es keinen Weg zurück, den die Anwendung kennt:

- Der Assistent zeigt sich nicht mehr (es gibt Konten).
- Der Befehl weigert sich (aus demselben Grund).
- „Passwort vergessen" hilft nur, wenn das Postfach noch erreichbar ist.
- Eine Oberfläche zum Ernennen gab es **nicht**, und `is_superadmin` war über
  keine Route setzbar.

Was blieb, war `psql`: ein `UPDATE "user" SET is_superadmin = true` von Hand,
auf einer Produktionsdatenbank, unter Zeitdruck. ADR-0022 hat diesen Weg für
die *Ersteinrichtung* ausdrücklich als „kein Weg" verworfen — für die
Wiederherstellung war er trotzdem der einzige.

**Der Nutzer hat entschieden: Oberfläche bauen.**

Zu entscheiden war damit nicht *ob*, sondern: wo sie sitzt, was sie zeigt, und
welche Absagen sie kennt. Denn dies ist die **weiteste Rechteerteilung dieser
Anwendung** — ein Superadministrator sieht jede Organisation, legt sie an und
löscht sie.

## Entscheidung

### 1. Ein siebter Reiter der Systemverwaltung, kein Abschnitt eines bestehenden

`/admin/system/superadmins`, Beschriftung *Superadmins*, **angehängt** an
die sechs vorhandenen — dieselbe Rücksicht, die *Vorlagen*, *KI* und
*Rechtstexte* schon bekommen haben: ein Link oder ein Testfall, der „den
fünften Reiter" zählt, bleibt heil.

Verworfen wurde die naheliegende Alternative, ihn als Abschnitt in den Reiter
*Organisationen* zu hängen — dorthin, wo „Gelöschte Organisationen" schon
steht. Der Grund ist keine Ästhetik: **was hier verwaltet wird, hängt an keiner
Organisation.** `is_superadmin` steht auf dem Konto und auf keiner
Mitgliedschaft (`SuperadminGuard` liest es von `auth.user`, nicht vom
`membership`), und ein Abschnitt unter der Liste der Organisationen behauptete
das Gegenteil. Genau diese Verwechslung — Systemrecht als besondere Rolle *in*
einer Organisation — ist die, gegen die `SuperadminGuard` seinen längsten
Absatz schreibt.

⚠️ **Ein Reiter mehr heißt: zwei Listen in `e2e/` zählen mit.**
`system-settings.spec.ts` hält die Reiterleiste gegen seine eigene Tabelle
`TABS` (die Zählung ist der Sinn des Falls: sie fängt den Reiter, den keine
Schleife kennt), und `a11y/views.ts` wird gegen `routerRouteKinds()` gezählt —
eine Routen-Sorte ohne Eintrag lässt den axe-Lauf still über eine Ansicht
weniger laufen. Beide sind mit diesem Reiter nachgezogen; der Hinweis steht
außerdem in `SystemAdminView.tsx` neben `TAB_ORDER`, wo der achte entstehen
wird.

### 2. Die Wache ist die vorhandene — es gibt keine zweite

`SessionGuard` → `SuperadminGuard`, dieselbe Kette wie
`AdminTenantsController` und `SystemSettingsController`. **Kein
`TenantScopeGuard`** (ein Superadministrator einer frischen Installation ist
Mitglied von nichts — und genau der muss den zweiten ernennen können), **kein
`GroupPermissionGuard`** (`can_manage_users` vergibt eine Organisation an ihre
eigenen Leute; es hier gelten zu lassen hieße: wer *eine* Organisation
verwaltet, verschafft sich Zugriff auf **alle**).

**Verworfen: eine eigene Wache „darf ernennen".** Sie wäre eine zweite Antwort
auf „wer verwaltet dieses System", und die falsche von beiden fiele erst auf,
wenn sie jemanden durchgelassen hat. Es gibt in dieser Anwendung genau eine
Eigenschaft, die die Systemverwaltung öffnet, und das soll so bleiben.

**„Niemand ernennt sich selbst" folgt daraus** — wer die Route erreicht, ist
bereits Superadministrator, und das eigene Konto zu nennen beantwortet sie mit
„verwaltet das System bereits". Gesucht wurde trotzdem nach einem Weg daran
vorbei; es gibt drei Stellen, an denen einer entstehen könnte, und alle drei
sind zu:

| Möglicher Weg | Warum er zu ist |
|---|---|
| Ein Rechtefeld im Rumpf | `superadminPromoteSchema` ist ein `strictObject` mit genau **einem** Feld; ein mitgeschicktes `isSuperadmin` ist ein 400 (Unit- und Integrationstest). |
| Ein Rumpf am Entzug | `DELETE` nimmt keinen; das Ziel steht im Pfad. |
| Die anderen Schreibwege auf `user` | Schreiben Feld für Feld statt per Spread (`admin.repository.ts`, `tenancy/tenant-scope.ts`), und kein Schema in `packages/shared` hat ein Feld dafür — ADR-0022 §6, unverändert gültig. |

### 3. Eine Adresse wird getippt, keine Person aus einer Liste gewählt

`POST /api/admin/superadmins` mit `{ email }`. Die naheliegende Bauform — ein
Auswahlfeld mit allen Personen — ist verworfen, und das ist die
folgenreichste Entscheidung dieses ADR: **sie wäre ein
organisationsübergreifendes Personenverzeichnis.** Die Superadmin-Oberfläche
liest heute nichts Fachliches einer Organisation; `AdminRepository` schreibt
diese Zusage wörtlich aus („keine Methode, die die Nutzer einer Organisation
liest, und es darf keine geben"). Ein Personen-Auswahlfeld hätte sie gebrochen,
für eine Bequemlichkeit.

Eine E-Mail-Adresse ist zudem das, was ein Mensch von einer anderen Person
ohnehin kennt. Normalisiert wird sie mit `emailAddressSchema` — derselben
Schreibweise, mit der die Anmeldung ihre Zeile findet; ein eigener
`trim().toLowerCase()`-Aufruf wäre eine zweite Fassung derselben Regel, und ein
Weg, der *anders* normalisiert, findet die Zeile des anderen nicht.

**Der Preis ist benannt:** ein Tippfehler bekommt 404 mit „zu dieser Adresse
gibt es kein Konto", und das ist gegenüber dem Aufrufer eine Auskunft darüber,
welche Adressen es auf der Installation gibt. Vertretbar, weil derselbe
Aufrufer jede Organisation dieser Installation löschen darf; die Grenze, die
eine Kennung nicht von einer fremden unterscheiden darf, ist die der
*Organisation*, und sie wird woanders gezogen (`TenantScopeGuard`).

**Die Route legt kein Konto an.** Ein Konto entsteht in dieser Anwendung immer
zusammen mit einer Mitgliedschaft — `homeless-account.ts` zählt die vier
Stellen auf, an denen eine `user`-Zeile entsteht, und leitet daraus eine
tragende Eigenschaft ab. Eine fünfte Stelle, die ein Konto ohne Organisation
erzeugte, wäre ein Konto, das der Aufräumlauf in dem Moment mitnimmt, in dem
jemand die Ernennung zurücknimmt (siehe Nr. 5).

### 4. Der letzte Superadministrator bleibt — dieselbe Sperre wie beim letzten Administrator einer Organisation

`LAST_SUPERADMIN_MESSAGE` ist die Entsprechung zu `lastAdminMessage`
(`tenant-admin/users.service.ts`) eine Ebene höher: eine exportierte Meldung,
geworfen als **409**, im Integrationstest über genau diese Konstante gemessen
statt über einen abgeschriebenen Satz. Kein Funktionsaufruf mit `'remove' |
'downgrade'` wie dort — `is_superadmin` ist ein Boolean und keine Rangliste, es
gibt nichts, wohin man herabstufen könnte.

Die Begründung ist die dortige, **eine Stufe schärfer**: eine Organisation ohne
Administrator kann die Systemverwaltung wieder mit einem versorgen. Eine
Installation ohne Superadministrator kann **niemand** mehr versorgen — die
beiden Wege aus ADR-0022 verlangen eine leere `user`-Tabelle. Der Weg zurück
führte über `psql`, also genau in den Zustand, gegen den diese Oberfläche
gebaut ist.

**Prüfung und Schreibvorgang stehen in einer Transaktion, mit einer
Vorsperre.** „Wie viele gibt es?" und „nimm einem die Ernennung" sind zwei
Anweisungen, und zwischen zwei Anweisungen passt eine zweite Anfrage: ohne die
Reihe sähen zwei gleichzeitige Entzüge je zwei Superadministratoren, beide
kämen durch, und danach gäbe es keinen. `SUPERADMIN_LOCK` ist die **zweite**
`pg_advisory_xact_lock` dieser Anwendung und nach der Regel gebildet, die
`SETUP_LOCK` aufstellt (Namensraum stehen lassen, laufende Nummer erhöhen);
sie hängt an derselben Fußnote — `READ COMMITTED`.

**Verworfen: `Serializable`** — aus demselben Grund wie in ADR-0022 §3: die
Kollision käme als Fehler 40001 zurück und müsste von Hand in eine Absage
übersetzt und wiederholt werden. Ein Wiederholungspfad, den man selten läuft,
ist einer, den niemand geprüft findet.

**Verworfen: den Selbstentzug ganz zu verbieten.** Er ist erlaubt, solange es
eine zweite Person gibt — Wort für Wort die Regel, die `MemberRow` für die
Rolle in einer Organisation ausschreibt: *„eine Seite, die mehr verbietet als
der Server, lügt über die Regel, und sie sperrt den einen Zustand ein, den
niemand will — der eigene Sitz ließe sich nur noch über jemand anderen
verlassen."* Wer aus Vorsicht kurz ernannt wurde, soll das Recht selbst wieder
abgeben können.

Das kostet nichts, denn es fällt mit Nr. 4 zusammen: **wer schreibt, ist selbst
Superadministrator.** Ist das Ziel jemand anderes, gibt es also außer ihm
mindestens noch den Aufrufer — die Zählung fragt deshalb „gibt es **andere**?"
und vergleicht gegen null, statt eine Gesamtzahl gegen eins zu halten. Ein
`<= 1` neben einer Zahl, die das Ziel mitzählt, ist die Sorte Bedingung, die
ein späterer Leser „korrigiert" (ein Review-Befund). Der einzige Weg zur
letzten Ernennung führt über das eigene Konto — „der letzte entfernt sich
selbst" und „der letzte wird entfernt" sind dieselbe Anfrage, und sie ist
abgewiesen.

### 5. Ein Konto ohne Organisation behält seine Ernennung — sonst löscht sie ein Aufräumlauf

Die Absage, die beim Bauen dazukam und ohne die diese Oberfläche **Daten
zerstört hätte**:
`deleteHomelessAccounts` (`tenancy/homeless-account.ts`) löscht jede
`user`-Zeile mit `isSuperadmin: false` **und** `memberships: { none: {} }` —
unwiderruflich, im nächsten Aufräumlauf, ohne dass jemand es auslöst. Die
Bedingung `isSuperadmin: false` steht dort ausdrücklich, weil „keine
Organisation" für einen Superadministrator der Normalzustand ist und nicht
seine Heimatlosigkeit.

Wer also einem Superadministrator **ohne** Mitgliedschaft die Ernennung
entzieht, löscht damit sein Konto — nur eben nicht jetzt und nicht sichtbar.
Das ist genau der frisch eingerichtete Superadministrator einer Installation,
die ihre erste Organisation übersprungen hat (ADR-0022 §2 nennt das einen
gültigen Endzustand).

Der Entzug wird deshalb mit 409 abgewiesen, und die Meldung ist eine
**Anweisung** statt eines „geht nicht": *nimm die Person zuerst in eine
Organisation auf.* Die Liste zeigt den Zustand vorher an (`hasMembership`),
damit die Absage vorhersehbar ist und nicht überrascht.

**Verbindlich ist die Bedingung im `where` der Anweisung, die schreibt** — das
`if` davor steht nur für die Meldung (ein Review-Befund am ersten Entwurf, an
dem sie **nur** im `if` stand). Die Vorsperre aus Nr. 4 reiht die Aufrufer
*dieser* Route; die Mitgliedschaft löscht aber jemand ganz anderes — eine
Organisations-Administratorin mit `can_manage_users` über *Person entfernen*,
ohne jedes Systemrecht. Fällt das unter `READ COMMITTED` zwischen das Lesen und
das Schreiben, dann läuft `deleteHomelessAccount` dort noch an der Ernennung
vorbei, die hier eine Anweisung später verschwindet — und übrig bliebe genau
die Zeile, die `deleteHomelessAccounts` beim nächsten Lauf löscht. Es ist
dieselbe Regel, die `homeless-account.ts` für sich selbst ausschreibt: *„Beide
stehen in der `where`-Bedingung der Anweisung, die handelt, nicht in einem `if`
davor."*

**Strenger als das wörtliche `where` des Aufräumlaufs, mit Absicht:** gezählt
werden nur Mitgliedschaften in **lebenden** Organisationen. Eine Mitgliedschaft
in einer gelöschten Organisation vergeht mit ihr, wenn der Papierkorb nach 30
Tagen leert — das Konto wäre danach derselbe heimatlose Rest, nur mit
Verzögerung. Gespiegelt wird die **Folge** von `deleteHomelessAccounts`, nicht
sein Wortlaut.

**Verworfen: das Konto beim Entzug gleich mitzulöschen.** Das wäre eine
zweite, versteckte Bedeutung für einen Knopf, auf dem „Ernennung zurücknehmen"
steht — und die zerstörendste Handlung der Anwendung an ihrer unauffälligsten
Stelle. Wer das Konto loswerden will, hat den Weg über die Organisation, in der
es Mitglied ist; dort steht die Rückfrage, die sagt, was verloren geht.

### 6. Sitzungen werden nicht widerrufen — sie tragen das Recht gar nicht

Die Frage, die bei einer Rechteentziehung immer zu stellen ist: läuft eine
offene Sitzung mit dem alten Recht weiter?

**Nein, und dafür ist nichts zu tun.** `SessionGuard` löst bei *jeder* Anfrage
die `user`-Zeile neu auf (`SessionService.authenticate`), und
`SuperadminGuard` liest `is_superadmin` von dort — nicht aus einem Anspruch,
der beim Anmelden in die Sitzung gestempelt wurde. Ernennung und Entzug wirken
deshalb auf die **nächste Anfrage** derselben, längst offenen Sitzung. Ein
Integrationstest fährt genau das in beide Richtungen: dieselbe Sitzung bekommt
403, dann 200, dann wieder 403.

**Verworfen: die Sitzungen der betroffenen Person beim Entzug zu beenden.** Es
wäre Theater mit Nebenwirkung: das Recht ist ohnehin weg, und der Widerruf
gilt nicht je Organisation (`SessionService.revokeAllOf` beendet **jede**
Sitzung). Er würfe jemanden aus der Arbeit in seinen Organisationen, um ein
Recht zu entziehen, das schon entzogen ist.

Was tatsächlich veraltet, ist der Zwischenspeicher der Oberfläche: `GET
/auth/me` liefert `isSuperadmin`, und daran hängt der Navigationseintrag. Beide
Schreibvorgänge machen deshalb `SESSION_QUERY_KEY` ungültig — dieselbe
Begründung, die `api/admin.ts` für das Anlegen und Löschen einer Organisation
gibt. Der Eintrag ist Höflichkeit, die Grenze ist die Wache.

### 7. Protokolliert wird in der Log-Zeile, nicht in einer Tabelle

Ein Audit-Log als Tabelle hat diese Anwendung nicht. Was sie hat, ist die
Zeile, die `AdminService` für die zerstörendste Handlung schreibt („wer hat
diese Organisation gelöscht, und wann"), und die Ernennung steht dem in nichts
nach. Also dieselbe Bauform: `Logger`, **zwei Kennungen und sonst nichts** —
wer handelt, wen es betrifft. Nie ein Name, nie eine Adresse (`CONTRIBUTING.md`:
keine personenbezogenen Daten in Logs); der Zeitpunkt kommt aus Nests eigenem
Stempel, damit es keine zweite Uhr gibt.

Geschrieben wird **nach** dem Erfolg, nie davor — die Regel, die `AdminService`
für dieselbe Sorte Zeile aufstellt: ein Protokoll über einen Entzug, der dann
an der Zählung scheitert, wäre das Protokoll von etwas, das nicht passiert ist.

**Verworfen: eine `audit_log`-Tabelle für diesen einen Anlass.** Ein
Audit-Log, das genau eine Handlung kennt, ist keins — es ist eine Tabelle, die
den falschen Eindruck erweckt, alles Wichtige stünde darin. Entweder es gibt
eines für alle rechtewirksamen Handlungen (Rollenwechsel, Rechteänderungen an
Gruppen, Formularfreigaben), oder es gibt keines; das ist eine eigene
Entscheidung mit eigenem Aufbewahrungs- und Datenschutzteil, und sie steht
unten in der Tabelle.

## Konsequenzen

- Eine Installation kann **zwei oder mehr** Superadministratoren haben, und der
  Weg dorthin ist eine Seite statt einer Datenbanksitzung. Der Einzelpunkt des
  Ausfalls ist auflösbar, **bevor** er zuschlägt.
- `is_superadmin` ist ab jetzt über eine Route **setzbar** — die erste seit
  ADR-0022. Die Zusage von §6 gilt trotzdem unverändert weiter, denn sie war
  nie „diese Spalte wird nie geschrieben", sondern **„kein Anfragedokument
  erreicht diese Spalte"**: der Wert steht wörtlich im Code, und was der
  Aufrufer schickt, ist eine Adresse.
- Es gibt eine **zweite** Vorsperre. Wer eine dritte braucht, erhöht die
  laufende Nummer und lässt den Namensraum stehen — die Regel steht an
  `SETUP_LOCK`.
- `apps/api/src/admin/**` liest jetzt auch `user`-Zeilen. Die Zusage von
  `AdminRepository` bleibt wörtlich unangetastet, weil der neue Dienst neben
  ihm steht und nicht in ihm: gelesen werden die Zeilen **mit**
  `is_superadmin` — Konten der Installation, keine Mitglieder einer
  Organisation.
- **Zwei Absagen desselben Status, zwei Sätze.** Der Entzug antwortet auf ein
  Konto, das die Systemverwaltung nicht trägt, mit „Diese Person verwaltet das
  System nicht" — nicht mit dem Satz der Ernennung, der von einer
  E-Mail-Adresse redet. Eine 404 an einer Route zu erklären, indem man den
  Wortlaut einer anderen ausleiht, ist eine falsche Auskunft, und ein Test, der
  sie erwartet, schreibt sie fest (ein Review-Befund).
- Der Reiter zeigt zwei Dinge, die es sonst nirgends zu sehen gibt: dass ein
  Konto in **keiner** Organisation ist, und dass es sich **noch nie
  angemeldet** hat. Beide sind Auskünfte über die Installation an die
  Systemverwaltung — und beide entscheiden etwas: die erste, ob der Entzug
  möglich ist; die zweite, wer diese Ernennung tatsächlich in der Hand hält
  (wer den Einladungslink hat, verwaltet damit das System).
- Die Liste offener Punkte der Installation macht dafür eine **vierte** Abfrage
  (`useSuperadmins`) — je eine läuft ohnehin auf *Mailserver*,
  *Organisationen*, *Rechtstexte* und *Superadmins*; vier zusätzliche Umläufe
  entstehen auf *Überwachung*, *Vorlagen* und *KI*. Siehe den Nachtrag unten.
- **`accountKind` wird hier bewusst nicht benutzt.** `deriveAccountKind` liest
  nur die beiden OIDC-Spalten und nennt eine noch nicht eingelöste *lokale*
  Einladung `'local'` — für eine Rollenliste tragbar, für die höchste
  Rechteerteilung nicht. Der Reiter fragt stattdessen direkt: kein Passwort
  **und** kein `oidc_subject`. Die Bedingung wird in der Datenbank ausgewertet;
  Hash und Subject verlassen sie nicht.

### Nachtrag 2026-08-19 — „nur eine Person verwaltet das System" steht auf der Liste

Diese Frage stand unten in der Tabelle und ist entschieden: **der Punkt kommt
auf die Liste offener Punkte der Installation** (`single-superadmin`,
`apps/web/src/views/system-settings/open-items.ts`), und er steht dort an erster
Stelle.

**Bezahlt wurde dafür mit einer Regel, und das ist der eigentliche Vorgang.**
Die Liste trug in ihrem Kopf die Regel von ADR-0022 §5 — „auf die Liste kommt
nur, ohne das etwas nicht funktioniert" —, und mit einem Superadministrator
funktioniert alles. Einen Punkt hinzuzufügen, der eine über ihm gedruckte Regel
bricht, wäre schlechter gewesen als kein Punkt. Also ist die Regel zuerst neu
gefasst worden (ADR-0022, Fortschreibung 2026-08-19): der Maßstab bleibt *ein
gültiger Endzustand oder keiner* und wird über zwei Fragen geprüft, deren
zweite — *wäre ein Ausfall ohne ihn nicht mehr behebbar?* — ausdrücklich eng
gehalten ist.

Dieser Punkt ist heute der einzige, der sie beantwortet. Der Ausfall, dessen
Rückweg er ist: das eine Konto verliert seinen Zugang, und danach führt kein
Weg zurück — die Einrichtungsseite zeigt sich nicht mehr, sobald Konten
existieren, `scripts/create-superadmin.sh` verweigert aus demselben Grund
(ADR-0022 §3), und „Passwort vergessen" hilft nur, solange das Postfach
erreichbar ist. Was bleibt, ist ein Eingriff in der Datenbank — genau der
Zustand, gegen den dieser ADR gebaut wurde.

⚠️ **Die Regel gilt nur für die Liste der Installation.** Die Liste einer
Organisation (ADR-0025) kennt keinen Fall des zweiten Zweigs: eine Organisation
ohne Administrator kann die Systemverwaltung wieder mit einem versorgen (§4
argumentiert genau so). Sie ist deshalb unverändert geblieben.

## Fortschreibung 2026-08-21 (Review-Runde 3 Nr. 13)

### Wer eingeladen werden kann, muss in keiner Organisation sein

Der Wunsch: *„Mir kam der Gedanke bei ‚Person zur Systemverwaltung
hinzufügen': dort würde ich ja auch gerne jemanden einladen, der in keiner
Orga ist."*

Bis hierher konnte `POST /admin/superadmins` nur **ernennen**, wer schon ein
Konto hat, und die Begründung dafür stand am Controller: ein Konto entstehe in
dieser Anwendung immer zusammen mit einer Mitgliedschaft, und eine fünfte
Stelle, die eines ohne Organisation erzeugte, sei eines, das der Aufräumlauf
beim nächsten Entzug mitnimmt.

**Der Grund war von Anfang an keiner.** `deleteHomelessAccount` trägt
`isSuperadmin: false` wörtlich in seinem `where`, und §5 dieses ADR schreibt
dazu: „keine Organisation" ist der **Normalzustand** eines
Superadministrators, nicht seine Heimatlosigkeit. Das Konto, um das es geht,
ist genau der Fall, für den die Bedingung dort steht.

Die Route nimmt deshalb jetzt Name **und** Adresse. Gibt es zu der Adresse
kein Konto, entsteht eines mit `is_superadmin` und **ohne** Mitgliedschaft,
und die Person wird eingeladen (ADR-0024). Der Name ist ein **Pflichtfeld**
und bei einem vorhandenen Konto ohne Wirkung: ein optionales Feld, dessen
Vorhandensein entscheidet, ob ein Konto entsteht, wäre die gefährlichste Art
von Bequemlichkeit.

### Diese eine Mail geht an der Warteschlange vorbei

Die Warteschlange **ist** `mail_log`, und `mail_log.tenant_id` ist `NOT NULL`:
jede Zeile gehört einer Organisation. Eine Einladung in die Systemverwaltung
gehört keiner.

| | Ansatz | Bewertung |
|---|---|---|
| **(a)** | `mail_log.tenant_id` nullbar machen | **Verworfen.** Die Spalte trägt die Mandantentrennung des Versandprotokolls; nullbar bräuchte sie eine eigene Spur im Worker (`MAIL_WORKER_TENANT_LANES` ist rohes SQL über `tenant_id`), eine Migration, eine Antwort in jeder Leseansicht und einen eigenen ADR — für einen Knopf. |
| **(b)** | In die Organisation des Einladenden legen | **Verworfen.** Die Zeile trüge die Adresse einer Person, die mit jener Organisation nichts zu tun hat, und deren Verwaltung liest das Versandprotokoll. |
| **(c)** | Unmittelbar über den Systemblock verschicken, wie ein Betriebsalarm | **Gewählt.** |

**(c) ist kein neuer Weg**, sondern der von `OpsAlertService` seit ADR-0016:
eine Mail der Installation, ohne Organisation, ohne Protokollzeile, über
`MailTransport` unmittelbar. Der Einladungslink entsteht dabei aus derselben
Funktion, die die Warteschlange benutzt (`recoverPasswordResetToken`), und
steht wie dort in keiner Spalte.

⚠️ **Der Preis, und wie er bezahlt wird.** Kein Wiederholen und kein
Nachlesen. Geht die Einladung nicht hinaus, **nimmt der Server das Konto
wieder zurück** und antwortet 422 mit dem Grund. Das ist die Fortsetzung der
Reihenfolge, die ADR-0024 festlegt: ein Konto ohne zugestellte Einladung wäre
eines, das niemand einlösen kann, mit einer installationsweit belegten
Adresse. Ein „Einladung erneut senden" gibt es deshalb auf dieser Zeile
**nicht** — der zweite Versuch ist derselbe Knopf.

Belegt in `apps/api/test/admin/superadmin-invitation.spec.ts` (Konto ohne
Mitgliedschaft, Mail wirklich hinaus, keine `mail_log`-Zeile, und der
Rückbau, wenn der Mailserver ablehnt) und in
`apps/api/test/admin/superadmins.spec.ts` (ohne Mailserver entsteht kein
Konto).

## Was dieser ADR nicht entscheidet

| Frage | Adressat | Woran man merkt, dass sie fällig ist |
|---|---|---|
| Ob eine **Mail** hinausgeht, wenn jemand ernannt oder herabgestuft wird | Sicherheit | Eine unbemerkte Ernennung. Heute steht sie nur in der Log-Zeile und in der Liste — die betroffene Person erfährt es nicht von der Anwendung. Dagegen steht, dass eine Installation ohne eigenen Mailserver (ADR-0023 lässt das zu) die Mail schlucken würde und der Eindruck der Benachrichtigung trüge. Fällig, sobald der Mailserver der Instanz Pflicht ist oder ein Betreiber es verlangt. |
| Ob es ein **Audit-Log als Tabelle** geben soll — für alle rechtewirksamen Handlungen | Betrieb / Datenschutz | Jemand fragt „wer hat wann welches Recht vergeben" und die Antwort steht nur in Logdateien, die rotieren. Das ist eine eigene Entscheidung mit eigener Aufbewahrungsfrist; ein Log für **eine** Handlung wäre schlechter als keins. |
| Ob ein Superadministrator jemanden **aus einer fremden Organisation** entfernen können soll, um ein Konto vor Nr. 5 zu retten | Produkt | Ein Konto sitzt in einer Organisation, an die niemand mehr herankommt. Heute ist die Antwort: die Organisation hat ihre eigene Verwaltung, und der Superadmin öffnet keine fachliche Route — der Preis dieser Trennung, und er ist der richtige. |
| Ob die Ernennung **befristet** sein können soll („für vier Stunden") | Sicherheit | Jemand ernennt für einen Wartungsabend und vergisst den Entzug. Fällig, sobald die Liste in einer Installation wächst, ohne dass jemand sagen kann warum. |
