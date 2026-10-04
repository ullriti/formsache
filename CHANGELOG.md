# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versionierung: [SemVer](https://semver.org/). Die Version leitet GitVersion aus
der Commit-Historie ab (ADR-0009).

Kategorien je Eintrag: **Added** · **Changed** · **Deprecated** · **Removed** ·
**Fixed** · **Security**.

## [Unreleased]

### Added

- **Datei-Upload nennt Datei und Größe, solange er läuft.** Statt „Wird
  hochgeladen…" steht in der Ausfüllmaske jetzt „„Lebenslauf.pdf" (8,1 MB)
  wird übertragen…". Bei einer schlechten Mobilverbindung ist damit erkennbar,
  *welche* Datei unterwegs ist — der Moment, in dem sonst zweimal getippt oder
  neu geladen wird. Ein echter Fortschrittsbalken ist das nicht; er würde einen
  zweiten Transportweg neben `fetch` brauchen und bleibt in ADR-0014 offen.

- **Geteilte Umfrage-Links zeigen den Formulartitel.** WhatsApp, Signal,
  Teams und andere Messenger zeigten für jede öffentliche Adresse nur
  „Formsache". Jetzt erscheinen der Formulartitel, die Organisation und die
  Einleitung der ersten Seite. Das gilt nur für ausfüllbare Formulare.
  Entwürfe, gelöschte, abgelaufene und volle Formulare bleiben bei
  „Formsache"; hinter einem Zugangswort erscheint nur der Titel. Wirkt mit der
  mitgelieferten nginx-Haustür
  ([ADR-0033](docs/architecture/0033-link-vorschau-per-ssi.md)).

- **Betriebsalarme lassen sich quittieren.** Eine Kennzahl, deren Ursache
  bekannt ist, meldete bisher bis zu ihrer Behebung alle sechs Stunden weiter —
  bei einer Platte, die erst am Freitag wächst, sind das zwölf Mails, die
  nichts Neues sagen. In *Systemverwaltung → Überwachung* steht neben jeder
  gerissenen Schwelle jetzt „Quittieren", mit einer Frist (24 Stunden, 7 oder
  30 Tage oder bis auf Weiteres) und einer kurzen Begründung. Die Ampel bleibt
  dabei rot: quittiert heißt stillgestellt, nicht behoben. Erholt sich die
  Kennzahl, verfällt die Quittierung — ein späterer Ausbruch ist ein neuer
  Vorfall und meldet sich wieder
  ([ADR-0016](docs/architecture/0016-betriebsueberwachung-und-alarmierung.md),
  Fortschreibung).

- **Bei Auswahl-Fragen lässt sich die Position von „Sonstiges" umschalten.**
  Die Option stand bisher immer am Ende der Liste. Ein neuer Schalter in den
  Fragen-Eigenschaften zeigt sie standardmäßig zuerst an, mit der Möglichkeit,
  auf „unten" zurückzuschalten — sichtbar nur, wenn „Sonstiges" überhaupt
  erlaubt ist.

### Changed

- **Die Warteschlangen-Karte der Überwachung meldet jetzt auch gescheiterte
  Nachrichten.** Ihre Ampel hing allein am Alter der ältesten wartenden Zeile;
  über „Nachrichten scheitern" kam eine Mail, während die Karte grün blieb. Alle
  Ampeln der Ansicht kommen jetzt aus derselben Auswertung, die den Alarm
  verschickt. Die Alarmmail verweist außerdem auf „Überwachung" statt auf den
  Reiter „Betrieb", den es seit der Zusammenlegung nicht mehr gibt.

- **Benachrichtigungs-Vorlagen gehören jetzt der Organisation, nicht mehr der
  Installation.** Sie werden in den Organisationseinstellungen unter
  „Vorlagen" verwaltet statt in den Systemeinstellungen, und jede Organisation
  bearbeitet ihre eigenen unabhängig von allen anderen. Bestehende
  Organisationen haben beim Umstieg eine Kopie der bisherigen, gemeinsamen
  Vorlagen erhalten; neue Organisationen starten mit denselben Standardtexten.
  Die alte systemweite Verwaltung ist entfallen
  ([ADR-0032](docs/architecture/0032-benachrichtigungs-vorlagen-je-organisation.md)).

- **Die Anmeldeseite nennt die Organisation und wird ab zwei Angeboten zur
  Auswahl.** `oidcButtonLabel` ist wahlfrei und fiel für jede Organisation ohne
  eigene Beschriftung auf denselben Satz zurück — eine Installation mit
  mehreren solchen Organisationen zeigte wortgleiche Schaltflächen, die sich
  nur in ihrer Adresse unterschieden. Der Organisationsname stand bereits in
  der Antwort und führt die Schaltfläche jetzt an. Bei nur einer Organisation
  bleibt es bei der Schaltfläche; ab der zweiten treten eine Auswahlliste und
  eine einzelne Schaltfläche an ihre Stelle. Beides ist Anzeige: gewählt wird
  der `tenantId` der Startadresse, und ob eine Organisation SSO anbietet,
  entscheidet unverändert der Server.

- **Die Auswahl ist auf die Organisation dieser Adresse vorbelegt.** Führt eine
  Organisation eine eigene Basis-Adresse und wird die Anmeldeseite unter genau
  dieser aufgerufen, steht sie im Auswahlfeld schon vorn. Der Abgleich läuft
  serverseitig; es reist nur ein Ja/Nein je Organisation, keine Adresse. Tragen
  zwei Organisationen dieselbe Adresse — die Spalte hat keinen Unique-Index —,
  ist nichts vorbelegt: „zwei Treffer" beantwortet nicht, welche gemeint ist.
  Die Vorbelegung entscheidet nichts und ist frei änderbar.

- **Das Release-Modell steht fest:** jeder Push auf `main`, der die Pipeline
  grün durchläuft, ist eine stabile Fassung, und die Pipeline schreibt sie als
  Tag `vX.Y.Z` zurück. Vorher war mangels Versionsquelle jede Fassung eine
  Vorabfassung (`1.0.0-2`) — die rollenden Marken `latest`, `x` und `x.y`
  entstanden nie, obwohl `docker-compose.prod.yml` auf `latest` zurückfällt
  ([ADR-0009](docs/architecture/0009-ci-versioning-and-images.md),
  [Betrieb](docs/kb/09-betrieb.md#woher-eine-fassung-kommt)).

### Fixed

- **e2e: „ohne Anmeldung"-Zusicherungen wurden von einer angemeldeten Person
  gemessen.** `browser.newContext()` ohne Argument übernimmt den
  `storageState` der Datei; der „Gast" war damit der Bearbeiter. 53 Stellen
  in 14 Dateien und der geteilte Helfer `redeemInvitation` nutzen jetzt
  `newGuestContext(browser)`, der den leeren Zustand ausdrücklich übergibt; ein
  Fall in `core-flow.spec.ts` misst über `/api/auth/me` (200 geerbt, 401 Gast).
  Betrifft nur die Testsuite, nicht die Anwendung.

- **Der Panel-Knopf des Builders auf schmalen Bildschirmen heißt nach seinem
  Inhalt.** Unterhalb von 1180 px stand dort immer „Eigenschaften", auch wenn
  keine Frage ausgewählt war und das Sheet die Fragetyp-Auswahl zeigte. Ohne
  Auswahl heißen Knopf und Sheet jetzt „Frage hinzufügen", mit Auswahl weiter
  „Eigenschaften".

- **Bei „Veranstaltung"-Fragen lässt sich die Teilnehmerzahl wieder auf leer
  zurücksetzen.** Der Zahlen-Stepper und die Pfeiltasten konnten wegen der
  unteren Grenze des Eingabefelds nicht bis 0 herunter — wer aus Versehen
  einmal hochgestellt hatte, kam über das Feld selbst nicht mehr zurück auf
  „keine Anmeldung". 0 zählt weiterhin nicht als Antwort, nur der Weg dorthin
  war blockiert.

- **Der Hinweistext unter „Adresse zu Ihrer Antwort" ist entfernt.** Er
  stimmte in der Sache nicht und war neben der Überschrift ohnehin
  überflüssig.
