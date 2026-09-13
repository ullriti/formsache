# 25. Ersteinrichtung einer Organisation — derselbe Assistent, ein anderer Gegenstand

- **Status:** accepted
- **Date:** 2026-08-18

## Context

[ADR-0022](0022-erstinbetriebnahme.md) hat aus der Erstinbetriebnahme einen
**Assistenten** gemacht: sieben Schritte durch alle Systemeinstellungen, jeder
außer dem ersten überspringbar, und was offen bleibt, steht danach als Liste
offener Punkte in der Systemverwaltung. Seine Fortschreibung nennt die
Folgearbeit beim Namen und lässt sie ausdrücklich offen:

> **Folgearbeit, benannt und nicht erledigt:** der Assistent einer neu
> angelegten Organisation. Er baut auf `apps/web/src/wizard/` auf; sein
> Endbildschirm ist hier schon angekündigt (`SetupComplete`), damit niemand die
> Organisation für fertig eingerichtet hält.

Der Anlass ist derselbe wie damals, eine Ebene tiefer. Eine frisch angelegte
Organisation hat drei Standardgruppen, eine erste Administratorin und sonst
**nichts**: kein Erscheinungsbild, keinen Mailserver, keine Adressen, keine
eigenen Formular-Standards. Nichts davon steht irgendwo; man findet es, wenn es
fehlt — und der teuerste Fall ist stumm: **ohne eigenen Mailserver verschickt
eine Organisation gar nichts** (ADR-0023), Bestätigungen und
Benachrichtigungen bleiben in der Warteschlange, und niemand bekommt eine
Fehlermeldung, weil das ein zulässiger Zustand ist.

Dazu kam ein Befund, der nicht die Einrichtung betrifft, sondern eine ganze
Einstellung: **`GET`/`PUT /api/ai/tenant-settings` existierte, war geprüft — und
kam in `apps/web/src` in keiner einzigen Zeile vor.** Eine Organisation konnte
sich die KI weder abschalten noch wieder einschalten, außer jemand rief die
Route von Hand.

## Decision

### 1. Acht Schritte, alle überspringbar

Die Einrichtung führt einmal durch **alle** Einstellungen einer Organisation und
sagt bei jedem Schritt, *was ohne ihn nicht funktioniert*
(`apps/web/src/views/tenant-setup/steps.ts`; `consequence` ist ein Pflichtfeld
des Rahmen-Typs, damit ein neuer Schritt den Satz nicht vergessen kann):

| # | Schritt | Recht | Ohne ihn |
|---|---|---|---|
| 1 | Erscheinungsbild | `canManageSettings` | Die Seiten für Teilnehmer tragen das neutrale Erscheinungsbild der Installation |
| 2 | **Mailserver der Organisation** | `canManageSettings` + `canViewResponses` | **Diese Organisation verschickt nichts** |
| 3 | Basis-Adresse und Antwortadresse | `canManageSettings` + `canViewResponses` | Links in Mails zeigen auf die Adresse der Installation oder ins Leere |
| 4 | Gruppen und Rechte | `canManageUsers` | Es gilt, was die drei Standardgruppen mitbringen |
| 5 | Personen einladen | `canManageUsers` | Die Organisation bleibt bei einem einzigen Konto |
| 6 | Formular-Standards | `canManageSettings` | Es gelten die ausgelieferten Vorgaben |
| 7 | Anmeldung über SSO | `canManageSettings` + `canManageUsers` | Anmeldung mit E-Mail und Passwort, Konten werden hier verwaltet |
| 8 | KI-Formularerstellung | `canManageSettings` | Bearbeiter legen Formulare von Hand an |

⚠️ **Schritt 5 hängt ausdrücklich nicht an Schritt 2.** Eine Einladung ist eine
**Kontomail** und geht über den Mailserver der *Installation* (`trigger:
'system'`, `enqueue-invitation.ts`) — sonst bekäme ein Relay, das jemand mit
`can_manage_settings` hier einträgt, die Vollmacht über ein fremdes Konto im
Klartext. Wer den Mailserver der Organisation überspringt, kann also trotzdem
Personen einladen; hat dagegen die *Installation* keinen, sagt der Server das
beim Anlegen und legt gar nichts an. Beide Schritte sagen das an ihrer Stelle,
weil die Vermutung sonst die falsche wäre.

**Schritt 5 stand nicht im Auftrag und ist trotzdem dabei.** `tenant/users` ist
die achte tenant-gebundene Einstellungsroute, und eine frisch angelegte
Organisation mit genau einem Konto ist der Normalfall, nicht der Randfall: geht
dieser eine Zugang verloren, kann nur noch der Betrieb der Installation helfen.
Ihn wegzulassen hätte den Anspruch „führt durch **alle** Einstellungen"
gebrochen.

**Anders als bei ADR-0022 ist hier kein Schritt verbindlich.** Dort legte
Schritt 1 das Konto an, von dem alle folgenden lebten; hier existieren
Organisation und Sitzung bereits, und jede Route ist eine gewöhnliche
angemeldete Einstellung. Es bleibt die Entscheidung *führend, aber
überspringbar* — mit der Liste offener Punkte als zweiter Hälfte (Nr. 4).

**Verworfen: Pflichtschritte für den Mailserver.** Dieselbe Begründung wie in
ADR-0022: eine Organisation, die man erst benutzen kann, wenn ein SMTP-Block
eingetragen ist, zwingt zu erfundenen Werten — und ein erfundener Block ist
schlimmer als keiner, weil er die Warteschlange stillstehen lässt, statt sie gar
nicht erst zu füllen.

### 2. Der Rahmen ist derselbe — und bekommt genau einen Parameter dazu

`apps/web/src/wizard/` war für diesen zweiten Assistenten gebaut (ADR-0022
Nr. 6) und trägt ihn unverändert: Schrittliste, Position als **Text**, Zustände
als **Wort**, Fokusführung beim Schrittwechsel, drei Schaltflächen in immer
derselben Anordnung.

Hinzu kam **ein** Feld: `standalone`. Die Erstinbetriebnahme steht allein auf
einer leeren Seite und ist deshalb `<main>`; dieser Assistent steht **in** der
angemeldeten Hülle, die ihre Hauptregion schon hat. Ein zweites `<main>` wäre
eine zweite Hauptregion auf derselben Seite — also genau die Sorte
Falschauskunft an eine Vorlesehilfe, gegen die dieses Gerüst sonst antritt (der
Sprunglink der Hülle zeigt auf das eine, das es gibt).

**Verworfen: den Assistenten außerhalb der Hülle rendern.** Das hätte das
`<main>`-Problem auch gelöst — und dabei die Kopfzeile mitgenommen, also den
Weg zurück ins Dashboard. Ein Ablauf ohne Ausweg ist genau das, was Nr. 3
ausschließt.

### 3. Er ist eine Adresse, und niemand wird hineingeschoben

`/admin/setup`, eine Adresse neben den fünf Reitern der
Organisationsverwaltung.

**Warum überhaupt eine — ADR-0022 Nr. 1 hat für die Erstinbetriebnahme
ausdrücklich keine vergeben.** Dort gab es nichts zu navigieren: keine Sitzung,
keine Hülle, keine zweite Seite, und eine Adresse wäre eine gewesen, die man
aufrufen kann, wenn sie nichts mehr tut. Hier ist das Gegenteil der Fall — es
gibt eine Sitzung, eine Kopfzeile, ein Dashboard und acht Einstellungsseiten,
zu denen dieser Ablauf hinführt. Er muss sich verlassen, wiederfinden, an eine
Kollegin schicken und mit dem Zurück-Knopf bedienen lassen; das kann nur eine
Adresse. Und die Frage „was zeigt sie auf einer eingerichteten Organisation?"
hat hier eine gute Antwort: dieselben Einstellungen, nur der Reihe nach.

**Es gibt keine Umleitung in diesen Ablauf.** Wer eine Organisation neu bekommt,
findet auf ihrem Dashboard eine **Einladung** (Nr. 4); wer sie nicht will,
klickt sie nicht. In jedem Schritt steht außerdem „Später einrichten". Der
Assistent darf niemanden einsperren — und ein Ablauf, aus dem man nur durch
Durchklicken herauskommt, tut genau das.

**Verworfen: nach dem Anlegen automatisch dorthin springen.** Es klingt
freundlich und ist es nicht: die Person, die eine Organisation anlegt, ist oft
die Superadministratorin, die gleich die nächste anlegen will — und sie fände
sich in einem achtschrittigen Formular wieder, das sie nicht bestellt hat.

### 4. Auf dem Dashboard steht **entweder** eine Einladung **oder** die Liste — nie beides

Was der Assistent offenlässt, steht danach auf dem Dashboard dieser
Organisation, bis es erledigt ist (`views/tenant-setup/open-items.ts`,
`TenantOpenItems.tsx`). Die Bauform ist die der Installation, und der Kern ist
geteilt: `views/open-items/OpenItemsList.tsx` trägt den Punkt und seine
Darstellung, die beiden Ableitungsmodule stellen die Fragen an ihren jeweiligen
Zustand.

**Die Unterscheidung „neu" gegen „läuft" wird aus dem Zustand gelesen: eine
Organisation ohne ein einziges Formular ist neu.**

- **Neu und es fehlt etwas** → die Einladung in den Assistenten.
- **Läuft und es fehlt etwas** → nur die Liste. Einer Organisation, die seit
  Monaten Formulare betreibt, einen Einrichtungsassistenten vorzusetzen, wäre
  aufdringlich und obendrein falsch: sie *ist* eingerichtet, ihr fehlt ein
  einzelner Punkt, und den erledigt man an seiner Einstellung.
- **Nichts fehlt** → nichts. Kein „✓ alles erledigt".

⚠️ **Abgeleitet wird aus den tatsächlichen Dokumenten, nicht aus einem
„übersprungen"-Merker** — dieselbe Regel wie ADR-0022 Nr. 5, und aus demselben
Grund: ein Merker liefe in beide Richtungen auseinander, sobald jemand die
Einstellung anderswo nachträgt oder wieder entfernt. Er beschreibt eine
Vergangenheit; gefragt ist die Gegenwart.

Auf die Liste kommt **nur**, ohne das etwas nicht funktioniert: kein Mailserver,
ein unlesbar gespeicherter Mailblock, keine Gruppe mit dem Recht „Bearbeiten".
Erscheinungsbild, Antwortadresse, SSO, KI und Formular-Standards stehen nicht
darauf, obwohl der Assistent sie führt — ohne sie funktioniert alles, nur eben
anders.

**Die eigene Basis-Adresse steht ebenfalls nicht darauf, und das ist die eine
unbefriedigende Zeile dieses ADR.** Fehlt sie, gilt die der Installation — und
*ob die gesetzt ist*, kann eine Organisation nicht sehen: die Systemzeile gehört
dem Superadmin. „Keine eigene Basis-Adresse" wäre also in der überwiegenden Zahl
der Installationen ein Punkt ohne Bedeutung, und die Liste verlöre genau die
Eigenschaft, die sie brauchbar macht. Was fehlt, ist eine Auskunft des Servers,
welche Adresse tatsächlich gilt (siehe *Was dieser ADR nicht entscheidet*).

### 5. Verschiedene Rechte: sichtbar überspringen statt 403 erzeugen

Die acht Schritte hängen an **verschiedenen** Rechten — das ist keine
Nachlässigkeit der Routen, sondern ihre Aussage: Farben ändern ist nicht
dasselbe wie Rollen vergeben. Wer nur einen Teil hält, bekommt die anderen
Schritte **nicht als Formular**, sondern mit dem Satz, welches Recht fehlt und
dass der Schritt übersprungen wird.

Drei Möglichkeiten standen zur Wahl, und die dritte ist die gewählte:

1. **Das Formular zeigen und die 403 abwarten.** Die schlechteste: ein Formular,
   das lädt, aussieht wie ein Formular und beim Speichern absagt.
2. **Den Schritt gar nicht durchlaufen.** Bequemer — aber die Schrittliste nennt
   ihn ohnehin, und wer ihn dort sieht und nie erreicht, weiß nicht warum.
3. **Den Schritt zeigen, mit dem Grund, und weitergehen.** Die Zählung
   („Schritt 4 von 8") bleibt die der Liste, und der Grund steht dort, wo die
   Frage entsteht.

Ein Schritt, den diese Rolle nicht darf, steht in der Schrittliste **von Anfang
an als „übersprungen"** und nicht als „offen": er wird es nie werden, und eine
Liste mit offenen Punkten, die in dieser Sitzung niemand erledigen kann, lädt
zum Aufgeben ein.

⚠️ **Das ist Darstellung, keine Grenze.** Durchgesetzt wird jede Regel an der
Route, jedes Mal; `requires` in `steps.ts` spiegelt nur, was die Wachen ohnehin
entscheiden. Wer die Liste dort ändert, ändert kein Recht — er ändert nur, ob
jemand vor eine verschlossene Tür läuft.

### 6. Die fehlende Oberfläche: der KI-Schalter einer Organisation

`AiTenantSettingsController` gibt es seit ADR-0015; er ist die dritte der drei
Schichten (*kann die Installation? · darf diese Organisation? · will diese
Organisation?*), er ist mit Rechte-Tests belegt — und er hatte **keine
Oberfläche**. Dieser ADR baut sie, und zwar an **zwei** Orten:

- als achter Schritt des Assistenten, und
- als **fünfter Reiter** der Organisationsverwaltung (`/admin/ai`).

Der Reiter ist kein Beiwerk. Eine Einstellung, die man genau einmal im Leben
einer Organisation sieht, ist keine Einstellung — dieselbe Begründung, die
ADR-0022 dem Reiter *Vorlagen* der Systemverwaltung gegeben hat.

**Ein Auswahlfeld mit drei Stellungen und kein Umschalter**, weil es drei
Antworten gibt: *wie die Installation* (`null`), *eingeschaltet*,
*ausgeschaltet*. Ein Umschalter hätte im Moment des ersten Klicks aus dem Erben
eine feste Entscheidung gemacht, und die Organisation hinge danach an einem
Wert, der einmal richtig war (die Begründung steht seit ADR-0015 an
`tenantAiSwitchSchema`).

#### Der Wire-Contract bekommt ein Feld: `systemAvailable`

Die Antwort von `GET`/`PUT /api/ai/tenant-settings` trägt jetzt neben `enabled`
ein zweites, **nur lesbares** Feld: ob die Installation die Funktion überhaupt
hat.

Der Grund ist, dass die Frage sonst unbeantwortbar ist. `aiFormsAvailable` der
Sitzungsnutzlast ist bereits das **Und** aus beiden Schichten
(`SessionFeaturesService`), also heißt `false` dort entweder „die Installation
hat keine KI" oder „diese Organisation hat sich abgeschaltet" — und die Seite,
auf der man sich wieder einschaltet, ist genau die, die den Unterschied kennen
muss. Ohne ihn böte der Assistent eine Wahl an, die nichts bewirkt, oder er
verschwiege, warum sie nichts bewirkt.

Zwei Eigenschaften halten das eng:

- **Es reist ein `boolean`** — kein Anbieter, kein Modell, keine Region, kein
  `apiKeySet`. Die Superadmin-Route bleibt verschlossen, und ein
  Integrationstest vergleicht die Schlüssel der Antwort.
- **Es ist die Installation ohne den Schalter dieser Organisation**
  (`available(null)`). Mit dem eigenen Schalter durchgereicht wäre die Auskunft
  tautologisch: eine abgeschaltete Organisation läse „diese Installation hat
  keine KI", obwohl die Installation eine hat.

Ist es `false`, **entfällt der Schritt** — sichtbar, mit dem Grund, und ohne ein
Auswahlfeld, dessen Stellung folgenlos wäre. Der Reiter zeigt die Wahl trotzdem:
eine Organisation darf ihre Antwort vorab geben, und die Installation kann die
Funktion später bekommen.

### 7. Geteilt wird der Baustein, nicht der Ablauf

Jeder Schritt zeigt **dieselben Karten**, die der zugehörige Reiter zeigt, und
schreibt dasselbe Dokument über dieselbe Route. Dafür sind die Reiter aufgeteilt
worden — dieselbe Aufteilung, die `SystemMailCards` für die Instanz-Seite schon
hatte:

| Anzeige (reine Felder) | Zustand (laden, tippen, speichern) |
|---|---|
| `TenantAppearanceCards` | `use-tenant-branding.ts` |
| `MailIdentityFields` | `use-tenant-smtp.ts` |
| `TenantAddressCards` | `use-tenant-addresses.ts` |
| `TenantFormDefaultsCards` | `use-tenant-form-defaults.ts` |
| `TenantOidcFields` | `use-tenant-oidc.ts` |
| `TenantAiFields` | `use-tenant-ai.ts` |

Der Grund ist nicht Sparsamkeit: ein Schritt des Assistenten soll aussehen wie
die Einstellung, zu der er führt — nicht *ähnlich*. Zwei Abschriften wären zwei
Orte, an denen ein Kontrast-Hinweis fehlt, ein Passwortfeld sein „unverändert"
verliert oder eine Absage anders lautet.

**Der Hauptknopf heißt „Speichern und weiter" — außer bei Gruppen und
Personen.** Dort heißt er „Weiter", und die Karten behalten ihre eigenen
Speicherknöpfe. Der Unterschied ist keine Kosmetik: eine Gruppe ist ein eigenes
Dokument mit eigener Speicherleiste, eine Einladung ein `POST`, der sofort
geschieht, eine Rollenänderung ein `PUT` je Zeile. Ein „Speichern und weiter"
über einer Liste müsste behaupten, es wisse, welche von zehn Zeilen zu schreiben
sind — und wäre in dem Moment falsch, in dem jemand zwei davon angefasst hat.
Die Schritte sagen das in einem Satz über der Liste, statt es den Leser
herausfinden zu lassen.

## Consequences

- Eine frisch angelegte Organisation ist **arbeitsfähig oder weiß, was ihr
  fehlt** — beides, nicht eines von beiden.
- `apps/web/src/wizard/` trägt jetzt zwei Assistenten und hat dabei **ein** Feld
  dazubekommen. Die Zusage aus ADR-0022 Nr. 6, dass das Gerüst kein Assistent
  mit einem Parameter für den zweiten ist, hat gehalten.
- Die Reiter der Organisationsverwaltung sind **fünf**. Der neue (*KI*) ist die
  erste Oberfläche zu einer Route, die es seit ADR-0015 gibt.
- `tenantAiSwitchSchema` hat ein zweites Feld. Es ist eine Auskunft **über die
  Installation** an eine Organisation — die einzige dieser Art, und sie trägt
  nichts als ein Ja oder Nein.
- Das Dashboard einer Organisation stellt für Rollen mit `canManageSettings`
  bzw. `canManageUsers` bis zu zwei zusätzliche Abfragen. Für alle anderen
  keine: der Vorfilter ist Anzeige, nicht Grenze, spart aber die 403en, die
  niemandem nützen.
- Sechs Reiter-Ansichten sind in Anzeige und Zustand geteilt worden. Wer eine
  von ihnen ändert, ändert damit auch den zugehörigen Schritt des Assistenten —
  **das ist der Zweck** und muss nicht jedes Mal beide Male bedacht werden.

## Was dieser ADR nicht entscheidet

| Frage | Adressat | Woran man merkt, dass sie fällig ist |
|---|---|---|
| Ob `GET /tenant/base-url` die **tatsächlich geltende** Adresse mitliefern soll (eigene → System → keine) | Backend | Sobald jemand „Basis-Adresse fehlt" auf die Liste offener Punkte einer Organisation nehmen will (Nr. 4). Heute kann die Organisation die Systemvorgabe nicht sehen, also wäre der Punkt eine Behauptung; mit der Auskunft wäre er eine Tatsache — und der Schritt könnte gleich zeigen, welche Adresse ohne eigene gälte. |
| ~~Ob der Assistent **wiederaufnehmbar** sein soll~~ **Entschieden am 2026-08-19: nein** — dieselbe Entscheidung wie für die Erstinbetriebnahme ([ADR-0022](0022-erstinbetriebnahme.md)), aus demselben Grund: der Ersatz ist abgeleiteter Zustand, ein Merker wäre eine zweite Wahrheit. | erledigt | Jemand bricht mittendrin ab und vermisst den Stand. Heute ist der Ersatz vollwertig: jeder Schritt ist eine gewöhnliche Einstellungsseite, und was fehlt, steht auf dem Dashboard. Ein gespeicherter Fortschritt wäre der Merker, den Nr. 4 ausschließt. |
| Ob eine Organisation ohne Formulare, der **nichts** fehlt, trotzdem eine Einladung bekommen soll | Produkt | Jemand legt eine Organisation an, trägt den Mailserver sofort ein und findet die übrigen sieben Schritte nie. Dagegen steht, dass eine Einladung ohne offenen Punkt eine Zeile ist, die nichts behauptet. |
| Ob „Personen einladen" vor „Gruppen und Rechte" stehen sollte | Produkt | Eine Rückmeldung, dass man beim Einladen die Rolle vermisst, die man erst danach anlegt. Heute stehen die Gruppen zuerst, weil die Rollenauswahl beim Einladen aus ihnen besteht. |
| Ob der Assistent auch **Formularvorlagen** anbieten soll | Produkt | Eine Organisation, die nach der Einrichtung vor einem leeren Dashboard steht. Vorlagen sind keine Einstellung — sie gehören in den Builder, und dieser Ablauf endet bewusst vor dem ersten Formular. |

## Fortschreibung 2026-08-21 (Review-Runde 3)

### Jeder offene Punkt führt zu **seiner** Einstellung

*„Keine Rechtstexte dieser Organisation hinterlegt: Wenn ich dann auf
Einrichtung starten klicke, dann sollte ich jeweils immer beim richtigen
Schritt landen bzw. vermutlich noch besser: direkt in den
Tenant-Einstellungen. Die erste Einrichtung ist ja de facto abgeschlossen."*

Der Befund traf eine **Doppelung**: die Einladung auf dem Dashboard einer neuen
Organisation hatte eine zweite, abgeschriebene Fassung der Punkte, und in der
fehlte je Zeile der Sprungknopf. Wer las, welche Einstellung fehlt, kam
trotzdem nur bei Schritt 1 (Erscheinungsbild) heraus.

Beide Rahmen benutzen jetzt dieselbe Liste (`OpenItemsList` mit einem
`footer`), und damit trägt **jede** Zeile ihren Weg zur Einstellung — das ist
der Weg, den der Befund selbst als den besseren benennt. Der Assistent bleibt
als Angebot darunter stehen, für den Fall, für den er gedacht ist: einmal
geführt durch *alles*, auch durch das, was hier nicht steht, weil ohne es
nichts fehlt.

### Die Basis-Adresse ist vorbelegt

*„Auch bei Org-Einrichtung sollte per Default die Basis-Adresse ermittelt
werden."* Sie ist es jetzt, mit derselben Bauform wie im Assistenten der
Installation: nur was leer ist wird vorbelegt, der Wert steht sichtbar da und
ein Satz sagt, woher er kommt und warum man ihn prüfen soll.

⚠️ **Mit einem Unterschied, der im Satz steht**: hier ist das Feld freiwillig.
Leer heißt nicht „keine Adresse", sondern „die der Installation gilt" — und
das ist für die meisten Organisationen das Richtige, weil eine spätere
Änderung an der Installation dann mitwandert. Wer die Vorbelegung übernimmt,
entscheidet sich für eine zweite Wahrheit, die er pflegen muss.

### Die Schrittliste navigiert

Wie bei der Erstinbetriebnahme ([ADR-0022](0022-erstinbetriebnahme.md),
Fortschreibung 2026-08-21) — hier **ohne Ausnahme**: kein Schritt dieses
Assistenten ist einmalig. Auch ein Schritt, den die eigene Rolle nicht darf,
bleibt anspringbar; er zeigt dann den Satz, welches Recht fehlt, und das ist
genau die Auskunft, die jemand sucht, der ihn in der Liste sieht.

