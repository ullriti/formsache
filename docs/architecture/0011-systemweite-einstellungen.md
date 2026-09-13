# 11. Systemweite Einstellungen als unterste Vererbungsschicht

- **Status:** superseded in Teilen — fortgeschrieben am 2026-08-14 und 2026-08-17
- **Date:** 2026-07-29

> **Fortschreibung 2026-08-17.** Der **Organisations-Standard kennt keine
> Abschnittsschalter mehr.** `tenant.form_defaults` hält ein flaches,
> vollständiges Dokument statt `{overridden, values}`; die Oberfläche zeigt die
> Felder ohne „Vorgabe ⇄ Angepasst" und ohne gesperrte Abschnitte. Eine
> Anwendung hat ab Werk Vorgabewerte — das ist üblich und braucht keinen
> Schalter. **Am Formular bleibt die abschnittsweise Übernahme**, dort trägt
> sie weiterhin. Folge: Wer einmal gespeichert hat, folgt späteren Änderungen
> der Auslieferungsvorgabe nicht mehr.

> **Fortschreibung 2026-08-14 (Review-Befunde 9 und 10).** Die unterste
> Schicht ist **wieder die Konstante**, und *Verfügbarkeit* gibt es nur noch je
> Formular. Was unten steht, beschreibt den Stand vom 2026-07-29 und bleibt
> lesbar, weil die Begründungen der Bauformen (Pflichtparameter statt
> Vorgabewert, „fehlt ist nicht unlesbar", die Allowlist) weiterhin tragen. Was
> sich geändert hat und warum, steht in [§8](#8-fortschreibung-2026-08-14-zwei-schichten-und-verfügbarkeit-nur-am-formular)
> — **diese Abschnitte gehen den älteren vor**.

## Context

Die naheliegende Vererbung für ein Formular ist zweistufig:
Organisations-Standard (`tenant.form_defaults`) über einer **Konstante**
`SYSTEM_FORM_SETTINGS` in `packages/shared`, darüber der abschnittsweise
Formular-Override (`form.settings_override`). Eine Konstante ist aber nur im
Code änderbar.

Der Betrieb verlangt mehr: der Superadmin soll **einmal** eine brauchbare
Vorlage hinterlegen, damit eine neu angelegte Organisation ohne
Einrichtungsaufwand arbeitsfähig ist — und eine spätere Änderung soll die
erbenden Organisationen erreichen. Damit wird die unterste Schicht zu
**Daten**.

Das betrifft nicht nur eine Funktion. `effectiveSettings()` ist die einzige
Stelle, an der „was gilt für dieses Formular?" beantwortet wird; durch sie geht
jede Durchsetzung (Frist, Antwortlimit, Zeitlimit, Zugangswort) und jeder
Mail-Auslöser. Der SMTP-Block des Systems, die Basis-Adresse und das
Versandbudget hängen zusätzlich daran. Deshalb steht diese Entscheidung
so früh wie möglich.

## Decision

### 1. Die Systemschicht ist eine Zeile, die Konstante bleibt der letzte Boden

Neues Modell `system_setting` mit **genau einer** Zeile. Die Einzigkeit ist eine
**Zusage der Tabelle**, nicht der Anwendung: Primärschlüssel `id CHAR(1)` plus
`CHECK (id = 'x')`. Eine zweite Zeile scheitert am Primärschlüssel, eine Zeile
mit anderem Schlüssel an der Bedingung. Prisma kann `CHECK` nicht ausdrücken —
die Migration ist deshalb mit `migrate dev --create-only` erzeugt und die
Bedingung **vor** dem ersten Anwenden hineingeschrieben worden.

**Kein Backfill, und keiner nötig.** *Keine* Zeile heißt „nichts entschieden" und
verhält sich byte-identisch zum bisherigen Verhalten, weil `SYSTEM_SETTINGS_FLOOR` genau die
bisherige Konstante ist. Dieselbe Form wie die fehlende `settings_override`-Spalte: die Abwesenheit *ist* die Bedeutung.

### 2. Die dritte Schicht ist ein Pflichtparameter, kein Vorgabewert

`effectiveSettings(systemDefaults, tenantDefaults, override)` — ebenso
`parseFormSettings(source, systemDefaults)` und
`parseFormSettingsOverride(source, systemDefaults)`.

Ein optionaler Parameter mit der Konstante als Vorgabewert wäre bequemer und
genau deshalb falsch: ein vergessener Aufrufer liefe **still** auf der Konstante
weiter, `pnpm typecheck` bliebe grün und jede Suite auch. Der wahrscheinlichste
vergessene Aufrufer ist der **öffentliche** Lesepfad, weil er als einziger keinen
Kontext mitführt. Die Zusicherung ist damit eine Bauform und hängt an
`pnpm typecheck`, nicht an einem Testfall — dieselbe Falle, die `PUBLIC_BASE_URL` gestellt hat.

**Die Konstante steckte an zwei Stellen, nicht an einer.** Neben dem Merge füllte
`fillSettings` — benutzt von der Tenant-*und* der Override-Schema-Fabrik — die
Lücken eines gespeicherten Dokuments mit ihr. Wäre nur der Merge umgestellt
worden, wären die Lücken eines **geerbten** Abschnitts schon beim Parsen aus der
Konstante ergänzt worden und hätten die Systemzeile nie erreicht; „System schlägt
durch" hätte richtig ausgesehen und nichts gemessen. Deshalb sind
`formSettingsSchemaFor(system)` und `formSettingsOverrideSchemaFor(system)`
Fabriken. Die Alternative — die Parser geben das *partielle* Dokument heraus und
nur der Merge füllt — wurde verworfen: `FormSettings` ist auf der Wire
(`tenantDefaults`, `effective`), in `availabilityOf` und auf jedem
Durchsetzungspfad vollständig zugesagt; sie partiell zu machen hätte die Frage
„und wenn dieser Schlüssel fehlt?" auf zwei Dutzend Aufrufstellen verteilt,
statt sie einmal zu beantworten.

Für ein bereits **vollständiges** Dokument (Serverantwort, fertig gemergter
Schreibvorgang) gibt es `completeFormSettingsSchema`, das keine Lücken füllt. Ein
Schema, das stillschweigend aus der Konstante ergänzt, war genau das zweite
Versteck, das dieser Meilenstein beseitigt.

### 3. Die Systemschicht führt **weder** `password` **noch** `passwordEnabled`

`SystemFormSettings = Omit<FormSettings, 'passwordEnabled' | 'password'>`, und
das System-Eingabeschema kennt die beiden Schlüssel nicht (sie sind
`unrecognized_keys`, kein ignorierter Wert).

Der Grund ist `revokesEditLinks`. Die Regel vergleicht die **effektiven** Einstellungen eines Formulars vorher und
nachher und entwertet die bereits ausgegebenen Bearbeiten-Links, sobald ein
Formular hinter das Zugangswort wandert. Käme ein Wort aus der Systemzeile,
müsste derselbe Widerruf dort greifen — für *jedes* erbende Formular *jedes*
Organisation, ausgelöst von einem Schreibvorgang, den in diesen Organisationen niemand gemacht
hat. Ohne diesen Widerruf wäre die Regel „ein `GET` ohne gültigen Nachweis
liefert keine Felddefinition" eine Ebene höher wieder falsch.

Drei Formen waren denkbar:

1. **Beide Felder abwesend** — gewählt. Die Lage entsteht gar nicht, und der Typ
   sagt es: kein Wert einer Systemzeile kann `passwordEnabled` oder `password`
   eines Formulars bewegen.
2. Nur `password` abwesend, `passwordEnabled` erlaubt — wirkt gleich, weil
   `checkSettingsConsistency` „Passwortschutz ohne Passwort" ablehnt. Es ersetzt
   aber eine Abwesenheit durch eine Fehlermeldung, die niemand erwartet, und
   macht die Zusage von einem Refinement statt von einem Typ abhängig.
3. Beide erlaubt — das Loch selbst.

Die übrigen zwei Felder des Abschnitts *Zugriff & Sicherheit* (`allowSaveDraft`,
`allowEdit`) bleiben systemweit setzbar. Der Abschnitt verschwindet nicht, nur
zwei seiner Felder.

**Ein zweiter Gewinn, der nicht geplant war:** `PublicFormsService.isLocked` liest
die beiden oberen Dokumente strikt (unlesbar ⇒ *verschlossen*), darf die
Systemschicht aber aus der **toleranten** Lesart nehmen — weil keine Systemzeile
`passwordEnabled` beeinflussen kann. Wäre sie es, wäre der Rückfall auf die
Konstante an dieser Stelle ein *fail open*.

### 4. Zwei Lesarten, drei Zustände — und „fehlt" ist nicht „unlesbar"

| Zustand der Zeile | tolerant (Anzeige) | strikt (Durchsetzung) |
|---|---|---|
| **fehlt** (nie gesetzt) | `SYSTEM_SETTINGS_FLOOR` | `SYSTEM_SETTINGS_FLOOR` |
| **da, parst nicht** / JSON `null` | `SYSTEM_SETTINGS_FLOOR`, **einmalig** protokolliert | `UnreadableSettingsError` → **503**, *fail closed* |

Die Trennlinie ist nicht „streng gegen mild". Bei **fehlt** hat niemand etwas
entschieden — der Normalzustand jeder frischen Installation; das abzulehnen
hieße, eine Anwendung auszuliefern, die erst nach dem ersten Superadmin-Besuch
arbeitet. Bei **unlesbar** hat jemand etwas entschieden und wir wissen nicht was;
das als „keine Frist, kein Limit" zu lesen, öffnet ein geschlossenes Formular in
dem Moment, in dem ein Dokument aufhört zu parsen. Es ist dieselbe
Unterscheidung, die `refuseJsonNull()` für die beiden JSONB-Spalten
trifft.

Die Protokollzeile des unlesbaren Falls wird **einmal je Prozess** geschrieben
(`reportOnce`, wie in `SettingsSecretsService` und `PublicFormsService`): der
öffentliche Lesepfad ist unauthentifiziert erreichbar, und ein Eintrag je Anfrage
wäre ein Verstärker — hier sogar einer, dessen Auslöser *alle* Organisationen zugleich
betrifft.

### 5. Kein Zwischenspeicher in diesem Paket

Die Zeile wird pro Anfrage frisch gelesen und geparst. `SYSTEM_FORM_SETTINGS` ist
`Object.freeze`d mit einer Begründung, die für eine zwischengespeicherte Zeile
wörtlich genauso gilt: eine einzige verirrte Zuweisung änderte, was „keine Frist"
für jede Organisation auf einmal heißt — still und bis zum Neustart.

Ein Zwischenspeicher wird kommen (die Schicht wird auf *jeder* öffentlichen
Anfrage gebraucht). **Er muss dann eingefroren sein und seinen Invalidierungspfad
im selben Diff mitbringen.** Ein Cache ohne Gegenstück ist ein Vertrag ohne
Gegenpartei — und den Schreibpfad, an dem die Invalidierung hängt, baut erst
eine spätere Änderung.

### 6. Mindestlänge des Zugangsworts im Eingabe-, nicht im Speicherschema

Ein Zugangswort braucht zwölf Zeichen. Geprüft wird in
`formSettingsWriteSchema`, das ausschließlich auf dem Weg **in**
die Anwendung liegt (`settings-wire.ts`). Das Speicherschema
(`formSettingsSchemaFor`, `formSettingsOverrideSchemaFor`) und die Leseseite der
Wire (`formSettingsPatchSchema`) bleiben unverändert.

Der Grund ist der Altbestand: heißt „Einstellungsdokument parst nicht"
*fail closed*. Eine Prüfung im Speicherschema würde ein heute abgelegtes kurzes
Wort nicht ablehnen — sie würde das Formular schließen, dem es gehört, und der
Organisation käme nicht mehr an die Stelle, an der er es ändern könnte.

### 7. `system_setting` gehört keiner Organisation — sechster Allowlist-Eintrag

Die Tabelle trägt bewusst kein `tenant_id`: sie *ist* die Schicht unter jeder Organisation. `apps/api/src/system-settings/**` kommt deshalb auf die
`PrismaService`-Allowlist in `eslint.config.js` — nach `mail/**` der zweite
Bereich, der organisationsübergreifend arbeitet. Tragfähig ist der Eintrag durch drei
Eigenschaften, und eine Änderung, die eine davon bricht, braucht eine neue
Entscheidung:

1. Es gibt **genau eine Zeile** (Zusage der Tabelle), also nichts zu scopen.
2. **Nichts aus einer Anfrage** erreicht eine Query — das Repository nimmt keine
   Parameter, der Schlüssel ist eine Modulkonstante.
3. **Gegenprobe:** kein fachlicher Pfad *schreibt* die Zeile. Gelesen wird sie von
   den drei Einstellungs-Lesern, geschrieben ausschließlich von der
   Superadmin-Route hinter dem Guard. Das Repository wird in
   `SystemSettingsModule` bereitgestellt und **nicht** exportiert; der einzige Weg
   hinein ist ein Service mit zwei Lesemethoden.

## Consequences

- **Positiv:** eine neue Organisation ist ohne Einrichtungsaufwand arbeitsfähig; eine
  Änderung der Systemvorgabe erreicht jedes erbende Formular, ohne dass ein
  Dokument angefasst wird. Die abschnittsweise Regel bleibt
  unverändert, die bestehenden Merge-Tests bleiben als Regression stehen.
- **Preis:** eine zusätzliche Datenbankabfrage je Anfrage, die Einstellungen
  auflöst — bis ein Cache mit Invalidierung eingelöst wird.
- **Preis:** eine geänderte Systemvorgabe wirkt **rückwirkend** auf laufende
  Anmeldungen. Das ist gewollt, muss aber vor dem Speichern mit
  einer Zahl angesagt werden.
- **Folgearbeit:** `system_setting` wächst später um den SMTP-Block des
  Systems, die Basis-Adresse und `updated_by`; beides
  sind additive Migrationen. Die mitgelieferten Benachrichtigungs-Vorlagen ziehen
  später hierher, werden aber **kopiert statt vererbt** — der
  Unterschied ist an anderer Stelle begründet und berührt diese Entscheidung nicht.
- **Unberührt:** [ADR-0003](0003-backend-nestjs-postgres-jsonb.md) (JSONB für
  Einstellungen) und [ADR-0004](0004-mail-db-queue.md) gelten weiter; diese
  Entscheidung ergänzt die Schichtung, sie ersetzt nichts.

## 8. Fortschreibung 2026-08-14: zwei Schichten, und *Verfügbarkeit* nur am Formular

- **Status:** accepted
- **Date:** 2026-08-14
- **Ersetzt:** §1 bis §5 dieser ADR, soweit sie die Formular-Einstellungen
  betreffen. Die Tabelle `system_setting` bleibt — für Mailserver,
  Basis-Adresse, KI und die Benachrichtigungs-Vorlagen —, und §7 (Allowlist)
  gilt für sie unverändert weiter.

### Kontext

Zwei Befunde eines Reviews, und sie hängen zusammen:

**Befund 9 — die Systemebene trug ihren Preis nicht.** Die Zusage von §1 war:
„der Superadmin hinterlegt einmal eine brauchbare Vorlage". Was daraus wurde,
war eine dritte Schicht, die *jede* Leseoperation der Anwendung mitschleppen
musste — als Pflichtparameter durch `effectiveSettings`, durch beide
Schema-Fabriken, durch jeden Parser, durch vier Module, die sie nur auflösten,
um sie weiterzureichen —, plus eine Datenbankabfrage je öffentlicher Anfrage,
plus ein Reichweitenzähler, der zwei Tabellen ohne Filter durchgeht, damit der
schreibende Superadmin die Zahl der betroffenen Organisationen *vor* dem
Speichern sieht. Der Nutzen dagegen: eine Vorlage, die eine Organisation beim
ersten eigenen Speichern ohnehin verlässt. Eine Installation dieser Größe hat
Dutzende Organisationen, nicht Tausende; „einmal zentral vorbelegen" wiegt den
Apparat nicht auf, und die Konstante tut dasselbe ohne ihn.

**Befund 10 — eine organisationsweite Frist ergibt keinen Sinn.** *Verfügbarkeit*
(Öffnungszeitraum, Frist, Zeit- und Teilnehmerlimit) entscheidet, ob ein
Formular offen oder geschlossen ist. Das ist eine Eigenschaft *dieses*
Formulars. Eine Vorgabe auf Organisationsebene schließt Anmeldungen, die niemand
angesehen hat, und wird beim ersten Formular, das sie nicht will, übernommen —
also von jedem. Kein Bild, das jemand von der Einstellung hat, ist
organisationsweit.

### Entscheidung

1. **Zwei Schichten.** `effectiveSettings(tenantDefaults, override)`. Was eine
   Organisation nicht entschieden hat, ist `SYSTEM_FORM_SETTINGS` — die
   Konstante, die §1 einmal ersetzen wollte. Die Spalten
   `system_setting.form_defaults`, `form_defaults_revision` und `updated_by`
   sind weg, ebenso die Routen `GET`/`PUT /admin/system-settings/form-defaults`,
   der Reiter *Formular-Standards*, `SettingsReach` und `SystemFormSettings`.
   Damit hat diese Anwendung **keinen** organisationsübergreifenden
   Schreibvorgang mehr.
2. **Kein Verfügbarkeits-Abschnitt auf der Organisationsebene.**
   `SettingsSection` sind vier: `access`, `confirm`, `display`, `budget`. Die
   sieben Schlüssel von *Verfügbarkeit* (`AVAILABILITY_KEYS`) gehören dem
   Formular und haben keinen Schalter — es gibt nichts, wovon sie erben
   könnten. Die Zusage ist eine **Bauform**, kein Kommentar:
   `TenantFormSettings = Omit<FormSettings, AvailabilityKey>` und das
   Speicherschema der Organisation kennt die Schlüssel nicht, sodass eine von
   Hand geschriebene Zeile mit `closeAt` *nicht parst*, statt eine Frist zu
   setzen, die niemand sieht und niemand ändern kann.
3. **Der Pflichtparameter von §2 fällt weg, seine Begründung nicht.** Er
   existierte, damit kein Aufrufer still auf der Konstante weiterläuft. Wenn die
   Konstante die Wahrheit *ist*, gibt es nichts, worauf man still zurückfallen
   könnte — die Falle ist geschlossen, nicht bewacht. Aus den Fabriken
   `formSettingsSchemaFor(system)`/`formSettingsOverrideSchemaFor(system)`
   werden wieder Konstanten.
4. **§3 bleibt gültig und wird gegenstandslos.** Die Systemschicht durfte kein
   Zugangswort tragen, damit `revokesEditLinks` nicht von einem Schreibvorgang
   ausgelöst werden kann, den in den betroffenen Organisationen niemand gemacht
   hat. Es gibt diese Schicht nicht mehr; beide Argumente einer Widerrufsregel
   können sich nur noch innerhalb einer Organisation bewegen.
5. **Ein zweites Tor entfällt: `copyToSubmitter`** (Review-Befund 24). Die
   Einstellung *Nach dem Absenden → Bestätigung an Teilnehmer senden* stand vor
   der Teilnehmer-Mail und konnte eine eingerichtete, aktive Benachrichtigung
   verschlucken. Das Symptom war die Oberfläche: drei Stellen mussten erklären,
   dass hier etwas eingerichtet ist, das trotzdem nicht verschickt wird. Wer
   eine Benachrichtigung an die ausfüllende Person einrichtet, hat entschieden,
   dass sie verschickt wird; wer das nicht will, schaltet sie dort ab, wo sie
   steht.

### Was die Migration leisten muss — und was sie belegt

`20260814120000_two_layer_form_settings`. Die Anforderung ist absolut: **kein
Formular ändert sein Verhalten.** *Verfügbarkeit* entscheidet über offen und
geschlossen, `copyToSubmitter` über Post an Fremde; eine verlorene geerbte
Frist öffnet stillgelegte Formulare oder schließt laufende Anmeldungen.

Deshalb wandert **erst** alles, was geerbt war, dorthin, wo es künftig gelesen
wird, und **dann** fällt die alte Ebene weg:

1. Benachrichtigungen an die ausfüllende Person, deren effektiver Schalter aus
   stand, werden deaktiviert (`active = false`) — „aus" bleibt „aus", jetzt
   sichtbar in der Liste statt versteckt in einem anderen Abschnitt einer
   anderen Seite.
2. Die effektive *Verfügbarkeit* jedes Formulars — Formular, sonst
   Organisation, sonst Systemzeile, sonst Vorgabe — wird in das Formular
   geschrieben, und alte Verfügbarkeitswerte in nicht übernommenen Abschnitten
   werden entfernt, damit kein Wert gilt, der nie galt.
3. Jeder Schlüssel, den die Systemzeile abweichend von der Vorgabe gesetzt
   hatte, wandert in die Organisationen, die ihn geerbt haben; ihr Abschnitt
   wird dort auf „Angepasst" gestellt.
4. Die Vorlagen (`form_template.content`) verlieren dieselben zwei Schlüssel.
5. Erst danach fallen die drei Spalten.

Belegt wurde das nicht zugesichert, sondern gemessen: ein eigener Test stellte
den Zustand *vor* der Migration wieder her (die Spalten inbegriffen), rechnete
mit einer im Test ausgeschriebenen Fassung der **alten** Dreischichtregel aus,
was galt, fuhr die Migrationsdatei Anweisung für Anweisung und verglich Feld für
Feld mit dem, was die **neuen** geteilten Funktionen aus den migrierten Zeilen
lasen.

### Konsequenzen

- **Positiv:** eine Schicht weniger in jedem Lesepfad, eine Datenbankabfrage
  weniger je öffentlicher Anfrage, vier Module ohne die Abhängigkeit, die sie
  nur weiterreichten — und kein Schreibvorgang mehr, dessen Wirkungsbereich
  „alle Organisationen" ist.
- **Preis:** eine installationsweite Vorbelegung gibt es nicht mehr. Wer sie
  will, ändert `SYSTEM_FORM_SETTINGS` und liefert aus — eine bewusste
  Code-Änderung statt einer Einstellung, die im Betrieb rückwirkend Formulare
  schließen kann.
- **Preis:** die gespeicherten Dokumente werden einmalig umgeschrieben. Das ist
  der Grund, warum die Migration die Beweislast trägt und nicht ein
  Release-Hinweis.
- **Unberührt:** `system_setting` selbst, §7 (Allowlist) und §6 (Mindestlänge
  des Zugangsworts im Eingabeschema).
