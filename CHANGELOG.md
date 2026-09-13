# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versionierung: [SemVer](https://semver.org/). Die Version leitet GitVersion aus
der Commit-Historie ab (ADR-0009).

Kategorien je Eintrag: **Added** · **Changed** · **Deprecated** · **Removed** ·
**Fixed** · **Security**.

## [Unreleased]

### Changed

- **Das Release-Modell steht fest:** jeder Push auf `main`, der die Pipeline
  grün durchläuft, ist eine stabile Fassung, und die Pipeline schreibt sie als
  Tag `vX.Y.Z` zurück. Vorher war mangels Versionsquelle jede Fassung eine
  Vorabfassung (`1.0.0-2`) — die rollenden Marken `latest`, `x` und `x.y`
  entstanden nie, obwohl `docker-compose.prod.yml` auf `latest` zurückfällt
  ([ADR-0009](docs/architecture/0009-ci-versioning-and-images.md),
  [Betrieb](docs/kb/09-betrieb.md#woher-eine-fassung-kommt)).
