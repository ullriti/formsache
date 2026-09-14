# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versionierung: [SemVer](https://semver.org/). Die Version leitet GitVersion aus
der Commit-Historie ab (ADR-0009).

Kategorien je Eintrag: **Added** · **Changed** · **Deprecated** · **Removed** ·
**Fixed** · **Security**.

## [Unreleased]

### Changed

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
