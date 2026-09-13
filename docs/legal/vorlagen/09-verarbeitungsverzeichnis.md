# Vorlage 09 — Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO)

> **Wer führt es:** **beide, getrennt.**
> - Der **Betreiber** führt zwei: eines nach Art. 30 **Abs. 1** für die
>   Verarbeitungen, bei denen er Verantwortlicher ist, und eines nach Art. 30
>   **Abs. 2** über die Verarbeitungen, die er **im Auftrag** ausführt. Das
>   zweite wird regelmäßig vergessen.
> - Jede **Organisation** führt ihr eigenes nach Art. 30 Abs. 1.
>
> **Wo:** intern. Kein Rechtstext für Besucher; vorzulegen ist es der
> Aufsichtsbehörde auf Anfrage (Art. 30 Abs. 4).
>
> ⚠️ **Die Ausnahme des Art. 30 Abs. 5 greift hier praktisch nie.** Sie setzt
> voraus, dass die Verarbeitung nur *gelegentlich* erfolgt. Ein dauerhaft
> betriebenes Formularsystem ist nicht gelegentlich — die Beschäftigtenzahl
> allein entlastet nicht.
>
> 🟢 **Was diese Vorlage von einer Mustertabelle unterscheidet:**
> `docs/kb/10-datenschutz.md` enthält die technischen Angaben bereits —
> Datenkategorien, Empfänger, Fristen, Maßnahmen — und **hält sie gegen den
> Code**: `packages/shared/src/retention-doc.test.ts` vergleicht die
> dokumentierten Fristen mit den Konstanten im Programm, in **beide**
> Richtungen. Diese Vorlage schreibt das nicht ab, sondern **verweist darauf**
> und füllt die Felder, die dort bewusst offen sind.

---

# A — Verzeichnis des Betreibers, Art. 30 Abs. 1 (eigene Verantwortlichkeit)

## A.0 Stammangaben

| Feld | Inhalt |
|---|---|
| Verantwortlicher | [[NAME]], [[ANSCHRIFT]] |
| Vertretungsberechtigte Person | [[NAME]] |
| Kontakt für Betroffenenanfragen | [[E_MAIL]] |
| Datenschutzbeauftragte Person | [[NAME_UND_KONTAKT]] **oder** „nicht bestellt, weil [[BEGRÜNDUNG]]" |
| Zuständige Aufsichtsbehörde | [[NAME]] |
| Stand | [[DATUM]] |

## A.1 Konten der Bearbeitenden

| Feld | Inhalt |
|---|---|
| Zweck | Anmeldung, Rechteprüfung, Zuordnung von Bearbeitungen zu einer Organisation |
| Betroffene | Bearbeitende und Administratoren der Organisationen und des Betreibers |
| Datenkategorien | Name, E-Mail, Argon2id-Prüfwert **oder** Kennung eines externen Anmeldedienstes, Gruppen- und Formularrechte, Zeitpunkt der letzten Anmeldung |
| Rechtsgrundlage | [[Art. 6 Abs. 1 lit. b — Nutzungsverhältnis / lit. e i. V. m. [[NORM]] / lit. f mit dem Interesse [[INTERESSE]]]] |
| Empfänger | keine außerhalb der Installation; bei SSO erfährt der Identitätsanbieter der Organisation, dass eine Anmeldung stattfand |
| Drittland | [[keins / [[LAND]] mit Grundlage [[…]]]] |
| Löschfrist | mit dem Konto; abgelaufene Sitzungen 7 Tage; Rücksetz- und Einladungslinks 7 Tage |
| Maßnahmen | Anlage 1 des AV-Vertrags → `docs/kb/10-datenschutz.md` §3 |
| ⚠️ Gemeinsame Verantwortlichkeit | ja, mit der jeweiligen Organisation (Art. 26). Vereinbarung: [[VERWEIS]] |

## A.2 Betrieb, Sicherheit und Verfügbarkeit

| Feld | Inhalt |
|---|---|
| Zweck | Schutz vor Überlastung und automatisiertem Missbrauch, Störungsbeseitigung, Betriebsnachweis |
| Betroffene | alle, die die Anwendung aufrufen |
| Datenkategorien | IP-Adresse **nur im Arbeitsspeicher** (IPv6 auf /64 reduziert), Anfrage-Kennung, Fehlercodes, Läufe der Hintergrundaufgaben |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. f i. V. m. Art. 32 DSGVO |
| Empfänger | keine |
| Drittland | keins |
| Löschfrist | IP-Adressen: ≤ 2 Minuten (Formularaufruf, Absendung, Kennworteingabe), ≤ 1 Stunde (Upload-Kontingent). Nicht in der Datenbank, nicht im Protokoll |
| Belege | `apps/api/src/common/client-address.ts`, `address-form-tracker.ts`, `packages/shared/src/file-limits.ts`, Test `test/observability/log-hygiene.spec.ts` |
| ⚠️ Nicht erfasst | die Zugriffsprotokolle des **vorgelagerten Zugangsservers**. Deren Inhalt und Frist: [[ANGABE]] — das ist eine eigene Zeile dieses Verzeichnisses, wenn dort IP-Adressen anfallen |

## A.3 Datensicherung

| Feld | Inhalt |
|---|---|
| Zweck | Wiederherstellbarkeit nach Art. 32 Abs. 1 lit. c DSGVO |
| Betroffene | alle in der Installation erfassten Personen |
| Datenkategorien | vollständiger Abzug von Datenbank und Dateiablage, verschlüsselt |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. f i. V. m. Art. 32 |
| Empfänger | [[SPEICHERORT / DIENSTLEISTER]] |
| Drittland | [[keins / …]] |
| Löschfrist | `BACKUP_KEEP_DAYS` = [[WERT]] Tage |
| ⚠️ Anzumerken | Löschungen im laufenden Betrieb erreichen bestehende Sicherungen nicht; vollständige Wirkung nach spätestens [[WERT]] Tagen. Bei einer Wiederherstellung wird die Löschung wiederholt |

## A.4 Betriebsalarm

| Feld | Inhalt |
|---|---|
| Zweck | Benachrichtigung bei Ausfällen und ausbleibenden Hintergrundläufen |
| Betroffene | die Person hinter der Alarmadresse |
| Datenkategorien | Alarmadresse, Betreff, Kennzahlen. **Keine Personen in den Laufzeilen** |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. f |
| Löschfrist | [[ANGABE]] |

## A.5 KI-Formularerstellung

⚠️ **Diesen Eintrag auch dann führen, wenn die Funktion aus ist** — dann mit dem
Vermerk „derzeit keine Verarbeitung; das Einschalten ist der Auslöser".
Vollständige Feldbelegung: `docs/kb/10-datenschutz.md` §1.7. Offen bleiben:

| Feld | Inhalt |
|---|---|
| Anbieter, Modell, Region | [[…]] |
| Rechtsgrundlage | [[Art. 6 Abs. 1 lit. f mit dem Interesse [[…]]]] |
| Drittlandübermittlung und ihre Grundlage | [[…]] |
| AV-Vertrag mit dem Anbieter | liegt vor seit [[DATUM]] |
| Kontingent je Organisation | [[…]] |

🔴 Die fünf Vorbedingungen aus `docs/kb/10-datenschutz.md` §4.1 sind **vor** dem
Hinterlegen des Schlüssels zu erfüllen. Dieser Eintrag ist die dritte davon.

---

# B — Verzeichnis des Betreibers, Art. 30 Abs. 2 (Auftragsverarbeitung)

Ein Eintrag **je Auftraggeber**, also je Organisation. Die technischen Felder
sind für alle gleich und stehen in `docs/kb/10-datenschutz.md` §§1.3–1.6 sowie
in Anlage 3 des Auftragsverarbeitungsvertrags.

| Feld | Inhalt |
|---|---|
| Auftragsverarbeiter | [[NAME_DES_BETREIBERS]], [[ANSCHRIFT]] |
| Vertreter, Datenschutzbeauftragter | [[…]] |
| **Je Verantwortlichem** | Name, Anschrift und Kontakt jeder Organisation → [[LISTE ODER VERWEIS]] |
| Kategorien der Verarbeitungen | Speicherung, Ordnung, Auslesen, Übermittlung an die vom Verantwortlichen bestimmten Empfänger, Auswertung, Export, Löschung von Formularantworten samt Anlagen, Entwürfen und Versandprotokoll |
| Drittlandübermittlung | [[keine / für die KI-Funktion: [[…]] mit Grundlage [[…]]]] |
| Maßnahmen nach Art. 32 | Anlage 1 des AV-Vertrags → `docs/kb/10-datenschutz.md` §3 |
| Unterauftragsverarbeiter | Anlage 2 des AV-Vertrags |

---

# C — Verzeichnis einer Organisation, Art. 30 Abs. 1

Eine Zeile **je Formular**, nicht je Formularsystem. „Formularverwaltung" ist
keine Verarbeitungstätigkeit; „Anmeldung zur Jahrestagung" ist eine.

## C.0 Stammangaben

| Feld | Inhalt |
|---|---|
| Verantwortliche | [[NAME_DER_ORGANISATION]], [[ANSCHRIFT]] |
| Vertretungsberechtigte Person | [[…]] |
| Datenschutzbeauftragte Person | [[…]] oder „nicht bestellt" |
| Zuständige Aufsichtsbehörde | [[…]] |
| Stand | [[DATUM]] |

## C.1 Eintrag je Formular

| Feld | Inhalt |
|---|---|
| Bezeichnung | [[NAME_DES_FORMULARS]] |
| Zweck | [[konkret — nicht „Verwaltung"]] |
| Betroffene | Ausfüllende; **mittelbar jede in einem Freitext-, Tabellen- oder Veranstaltungsfeld genannte Person** |
| Datenkategorien | [[die tatsächlich gestellten Fragen, Feld für Feld]] |
| ⚠️ **Besondere Kategorien (Art. 9)** | [[nein / ja: [[WELCHE]], Grundlage Art. 9 Abs. 2 lit. [[…]]]] — siehe die drei Alltagsfälle in `docs/legal/README.md` 7.1 |
| Rechtsgrundlage | [[Art. 6 Abs. 1 lit. …]] |
| Empfänger | [[eigene Bearbeitende / weitere Stellen]] · [[NAME_DES_BETREIBERS]] als Auftragsverarbeiter · der Betreiber des verwendeten Mailservers |
| Drittland | [[keins / …]] |
| **Löschfrist** | [[Dauer oder Kriterium]] — ⚠️ **die Anwendung löscht Antworten nicht von selbst**; die Frist muss die Organisation einhalten |
| Maßnahmen | Anlage 1 des AV-Vertrags |
| Art. 14 einschlägig? | [[nein / ja — dann Berufung auf Art. 14 Abs. 5 lit. b dokumentieren und die Information in den Datenschutzhinweisen öffentlich bereithalten]] |

## C.2 Technische Fristen, die für jedes Formular gleich gelten

Nicht abschreiben, verweisen: `docs/kb/10-datenschutz.md` §2.1. Kurzfassung:
Papierkorb 30 Tage · Entwürfe 30 Tage · unbeanspruchte Anlagen 24 Stunden ·
Versandprotokoll 90 Tage.

---

## Was dieses Verzeichnis nicht ist

⚠️ **`docs/kb/10-datenschutz.md` ist nicht das Verzeichnis.** Es sagt das
selbst — „Was hier steht, ist die Sicht der Anwendung" — und es hat recht. Es
ist die geprüfte **Zulieferung**: Datenkategorien, Empfänger, Fristen und
Maßnahmen, die aus der Software folgen und von einem Test gegen den Code
gehalten werden. Was fehlt, sind die Felder, die nur der Verantwortliche
kennt. Genau die stehen oben.

**Der Vorteil dieser Aufteilung:** eine Änderung an der Software ändert
`10-datenschutz.md` und wird von einem Test erzwungen; eine Änderung an einem
Formular ändert Abschnitt C. Keine der beiden Seiten muss die andere pflegen —
und die häufigste Todesursache eines Verarbeitungsverzeichnisses, das stille
Veralten, trifft nur den Teil, den ohnehin ein Mensch pflegen muss.
