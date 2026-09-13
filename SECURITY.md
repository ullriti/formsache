# Sicherheit

## Eine Schwachstelle melden

**Bitte nicht über ein öffentliches Issue.** Zwei Wege:

- **Private Vulnerability Reporting** auf GitHub — der bevorzugte Weg, weil
  der Verlauf beim Repository bleibt: *Security → Report a vulnerability*.
- **E-Mail** an `formsache.revolt719@passmail.com`.

Hilfreich ist alles, was das Nachstellen erlaubt: betroffene Version oder
Commit, Aufruf oder Schritte, beobachtetes und erwartetes Verhalten. Wenn du
einschätzen kannst, wer angreifen könnte und was er gewinnt, schreib es dazu —
das entscheidet meist über die Dringlichkeit.

## Was du erwarten kannst

Das Projekt wird nebenher gepflegt. Es gibt **keine zugesicherte
Reaktionszeit**; realistisch ist eine erste Rückmeldung innerhalb einiger Tage.
Ich melde mich, wenn ich den Bericht gelesen habe, sage, ob ich das Problem
nachstellen konnte, und nenne, was ich zu tun gedenke. Wenn ich etwas nicht
beheben werde, sage ich das ebenfalls — mit Begründung.

Wer eine verbindliche Reaktionszeit braucht, betreibt die Anwendung besser mit
einem eigenen Sicherheitsprozess: der Quelltext liegt offen, und ein Fix lässt
sich selbst bauen und einspielen.

## Unterstützte Versionen

Gepflegt wird der aktuelle Stand von `main` und die jeweils letzte
veröffentlichte Version. Ältere Versionen bekommen keine Rückportierungen.

## Woran dieses Projekt besonders hängt

Zwei Eigenschaften sind für die Sicherheit dieser Anwendung ausschlaggebend.
Ein Bericht dazu ist besonders willkommen:

- **Mandantentrennung.** Jeder fachliche Zugriff ist an eine Organisation
  gebunden, und zwar serverseitig in der Abfrage, nicht erst im Filter danach.
  Ein Weg, an Daten einer anderen Organisation zu kommen, ist die schwerste
  Klasse von Fehler, die dieses System haben kann.
- **Die öffentlichen Ausfüll-Endpunkte.** Sie sind ohne Anmeldung erreichbar
  und nehmen Eingaben von Fremden entgegen — einschließlich Datei-Uploads.

Daneben das Übliche: Rechteprüfung, Sitzungsbehandlung, OIDC-Anbindung,
Ablage der Geheimnisse und alles, was den Umgang mit personenbezogenen Daten
betrifft.

## Was keine Schwachstelle ist

- Befunde eines Scanners ohne einen Weg, sie auszunutzen.
- Fehlende Sicherheits-Header an einer Installation, die jemand selbst
  aufgesetzt hat — die Produktionsgestalt setzt sie, die lokale absichtlich
  nicht.
- Die Seed-Zugangsdaten. Sie sind Platzhalter für die lokale Installation und
  als solche dokumentiert; eine echte Installation legt ihren ersten
  Administrator anders an (siehe Betriebshandbuch).
