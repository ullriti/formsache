# Architecture Decision Records (ADRs)

ADRs halten fest, **warum** eine Architektur- oder Technologieentscheidung so
gefallen ist — und was dabei verworfen wurde. Was die Anwendung *tut*, steht in
der [Wissensbasis](../kb/README.md); *warum* sie es so tut, steht hier.

## Prozess

1. Bestehende ADRs lesen — ein neuer widerspricht keinem alten, ohne ihn
   ausdrücklich abzulösen.
2. Neue Datei aus der Vorlage
   [`0001-record-architecture-decisions.md`](0001-record-architecture-decisions.md)
   heraus, fortlaufend nummeriert: `NNNN-<kebab-titel>.md`.
3. Aufbau: `Context` → `Decision` (nummeriert, je mit Begründung **und**
   verworfenen Alternativen) → `Consequences`. Größere ADRs schließen mit einer
   Tabelle **„Was dieser ADR nicht entscheidet"** — jede Zeile mit **Adressat**,
   und wo möglich mit einem Kriterium, an dem man erkennt, dass sie fällig ist.
4. `Status` auf `accepted` setzen, sobald die Entscheidung gilt. Eine *andere*
   Entscheidung braucht einen neuen ADR, der den alten ausdrücklich ablöst.
5. **Präzisierungen und Korrekturen werden in den laufenden Text
   eingearbeitet** — wie ein ADR zu seinem Stand gekommen ist, steht in der
   Git-Historie und im [`CHANGELOG.md`](../../CHANGELOG.md), nicht als Kette
   von Nachträgen im Dokument.
6. **Eine Ausnahme, und nur diese: die Fortschreibung.** Wird ein *Teil* einer
   Entscheidung ersetzt, während der Rest weiter gilt, bekommt der ADR einen
   Abschnitt `## Fortschreibung <Datum>: <Titel>` mit `Status`, `Date` und
   einer Zeile **`Ersetzt:`**, die den Geltungsbereich benennt — welche
   Paragraphen fallen und was ausdrücklich stehen bleibt. Sind die Abschnitte
   des ADR nummeriert, trägt sie die nächste Nummer (`## 8. Fortschreibung …`).

   **Warum das die bessere Regel ist:** ein ADR, dessen Entscheidung zur Hälfte
   ersetzt wurde, wird durch das Einarbeiten unlesbar — die verworfene
   Alternative und ihre Begründung sind der halbe Wert des Dokuments, und wer
   sie überschreibt, löscht genau das. Ein eigener ADR für einen Nachtrag, der
   ohne den alten keinen Satz lang trägt, wäre das andere Extrem: zwei
   Dokumente, die man nur zusammen lesen kann. Die Fortschreibung hält beides
   zusammen und macht den Bruch **sichtbar**, statt ihn zu glätten. Sie ist
   deshalb an ihren Geltungsbereich gebunden: ohne `Ersetzt:`-Zeile ist sie
   kein Nachtrag, sondern eine neue Entscheidung — und die braucht einen neuen
   ADR (Punkt 4). Gelebt in
   [ADR-0011 §8](0011-systemweite-einstellungen.md),
   [ADR-0004](0004-mail-db-queue.md) und
   [ADR-0013](0013-versandidentitaet-je-organisation.md).

Datei **und** Index-Zeile entstehen in derselben Änderung; `scripts/check-ai-docs.sh`
prüft Ablage und Benennung.

## Index

| Nr. | Titel | Status |
|-----|-------|--------|
| 0001 | [Record architecture decisions (ADRs)](0001-record-architecture-decisions.md) | accepted |
| 0002 | [Frontend: React 19 + Vite + TypeScript (statt Angular)](0002-frontend-react.md) | accepted |
| 0003 | [Backend: NestJS + PostgreSQL/Prisma, Formulare & Antworten als JSONB](0003-backend-nestjs-postgres-jsonb.md) | accepted |
| 0004 | [E-Mail-Versand über DB-basierte Queue (kein Redis/Broker)](0004-mail-db-queue.md) | accepted |
| 0005 | [Auth: Session-Cookies, lokale Nutzer (Argon2id), Standard-OIDC je Tenant](0005-auth-sessions-oidc.md) | accepted |
| 0006 | [Monorepo-Verwaltung mit pnpm-Workspaces](0006-pnpm-workspaces.md) | accepted |
| 0007 | [`packages/shared` wird aus der Quelle konsumiert, nicht als Artefakt](0007-shared-package-consumption.md) | accepted |
| 0008 | [Test-Datenbanken kommen aus Testcontainers — oder aus einem laufenden Server](0008-test-database-provider.md) | accepted |
| 0009 | [CI prüft jeden Push, GitVersion setzt die Version, zwei schlanke Images tragen sie](0009-ci-versioning-and-images.md) | accepted |
| 0010 | [Eigenes Routing über die History-API statt einer Router-Bibliothek](0010-frontend-routing.md) | accepted |
| 0011 | [Systemweite Einstellungen als unterste Vererbungsschicht](0011-systemweite-einstellungen.md) | accepted |
| 0012 | [OIDC-Kontobindung an *(Issuer, Subject)* — nie an das Subject allein](0012-oidc-kontobindung.md) | accepted |
| 0013 | [Versandidentität je Organisation — unteilbar und *fail closed*](0013-versandidentitaet-je-organisation.md) | accepted |
| 0014 | [Datei-Upload — eine Naht, zwei Listen, zwei Wege](0014-datei-upload.md) | accepted |
| 0015 | [KI-Formularerstellung — eine Naht, zwei Anbieter, ein Freitext auf Zeit](0015-ki-formularerstellung.md) | accepted |
| 0016 | [Betriebsüberwachung und Alarmierung — von innen zählen, von außen fragen](0016-betriebsueberwachung-und-alarmierung.md) | accepted |
| 0017 | [Sicherung und Wiederherstellung — ein Skript im Repo, die Probe in der CI](0017-sicherung-und-wiederherstellung.md) | accepted |
| 0018 | [Abhängigkeitspflege — Dependabot hebt, der Bericht misst, die Erreichbarkeit entscheidet](0018-abhaengigkeitspflege.md) | accepted |
| 0019 | [Ein Produktzeichen, das der Software gehört — und keiner Organisation](0019-produktzeichen.md) | accepted |
| 0020 | [Passwort setzen, ändern und zurücksetzen](0020-passwort-ruecksetzung.md) | accepted |
| 0021 | [Ein eigenes Recht für die Einstellungen eines Formulars](0021-recht-formular-einstellungen.md) | accepted |
| 0022 | [Erstinbetriebnahme — eine Seite, ein Befehl, eine Transaktion](0022-erstinbetriebnahme.md) | accepted (fortgeschrieben 2026-08-18: ein Assistent statt einer Maske) |
| 0023 | [Getrennte Mailserver — der der Instanz gehört dem Betrieb, der der Organisation ihr](0023-getrennte-mailserver-instanz-organisation.md) | accepted |
| 0024 | [Einladung statt getipptem Passwort](0024-einladung-statt-getipptem-passwort.md) | accepted |
| 0025 | [Ersteinrichtung einer Organisation](0025-ersteinrichtung-einer-organisation.md) | accepted |
| 0026 | [Fremdwerte in einer Mail der Instanz — einzeilig, an zwei Toren](0026-fremdwerte-in-einer-systemmail.md) | accepted |
| 0027 | [Der Link ins System in jeder Mail — die Fußzeile folgt der Identität](0027-link-ins-system-in-jeder-mail.md) | accepted |
| 0028 | [Rechtstexte — zwei Herkünfte, sechs Seiten, ein Renderer](0028-rechtstexte.md) | accepted (fortgeschrieben 2026-08-24: Barrierefreiheit gestrichen, Felder mit Beispiel und Abschnitt) |
| 0029 | [Der zweite Superadministrator — eine Oberfläche statt einer Datenbanksitzung](0029-zweiter-superadministrator.md) | accepted |
| 0030 | [Englische URL-Pfade — ein harter Schnitt ohne Weiterleitung](0030-englische-url-pfade.md) | accepted |
| 0031 | [Lizenzliste nach Dependabot-PRs — ein privilegierter Workflow, eng gezäumt](0031-dependabot-lizenz-fixup.md) | accepted |
