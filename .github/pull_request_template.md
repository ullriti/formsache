<!--
Titel: dieselbe Conventional-Commits-Konvention wie ein Commit-Subject
(„feat(api): …"). Beim Squash-Merge wird der Titel zur Commit-Nachricht, und
GitVersion leitet die Version genau daraus ab — ein Titel ohne Typ verschiebt
die Version falsch.

Ausfüllen, was zutrifft, den Rest löschen. Fakten statt Adjektive:
„167 API-Tests, 13 E2E" sagt mehr als „Tests grün".
-->

## Was

<!-- Was ist nach diesem Pull Request anders — ein paar Sätze. -->

## Warum

<!-- Welches Problem das löst; verknüpftes Issue, ADR oder Fehlerbericht. -->

## Nutzersichtbare Änderungen

<!--
Alles, was Nutzer, Betrieb oder API-Aufrufer merken: Verhalten, Oberfläche,
REST-API, Konfiguration, nötige Migrations- oder Deployment-Schritte.

„Keine — interner Umbau" ist eine gültige Antwort, aber sie gehört
hingeschrieben statt weggelassen. Neue Pflicht-Umgebungsvariablen und
verschobene Endpunkte sind nutzersichtbare Änderungen.
-->

## Wie geprüft

<!--
Welche Befehle gelaufen sind, mit Ergebnis:
pnpm -r build · pnpm -r test · pnpm typecheck · pnpm lint · pnpm format:check ·
pnpm e2e

Ein Befehl, der nicht laufen konnte, wird benannt — mit Grund, nie
stillschweigend ausgelassen.

Bei Zusagen zu Mandantentrennung, Rechten, Auth oder Nebenläufigkeit belegt ein
grüner Test für sich genommen nichts. Beschreibe den Verstoß, den du das Gate
absichtlich hast **rot** machen sehen.
-->

## Sicherheitsrelevant

<!--
Berührte Bereiche: Auth, Sitzungen, OIDC, Gruppenrechte, Mandantentrennung,
öffentliche Ausfüll-Endpunkte, Uploads, Geheimnisse, personenbezogene Daten und
Löschfristen, neue Abhängigkeiten.

Bewusst akzeptierte Restrisiken gehören ebenfalls hierher.
-->

## Offene Punkte

<!-- Bewusst außerhalb des Umfangs, bekannte Lücken, Folge-Issues. -->

## Checkliste

- [ ] Prüfbefehle grün — oder die Lücke oben benannt
- [ ] Neues Verhalten hat Tests, ein Bugfix einen Regressionstest
- [ ] Commits und Titel nach Conventional Commits, keine Geheimnisse im Diff
