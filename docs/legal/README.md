# Rechtstexte — Analyse, Bauform und Vorlagen

- [Vorbemerkung: was dieses Dokument ist und was nicht](#vorbemerkung-was-dieses-dokument-ist-und-was-nicht)
- [1. Der Befund in einem Absatz](#1-der-befund-in-einem-absatz)
- [2. Die drei Rollen — und wer wofür Verantwortlicher ist](#2-die-drei-rollen--und-wer-wofür-verantwortlicher-ist)
- [3. Welches Dokument ist nötig, und wer schuldet es](#3-welches-dokument-ist-nötig-und-wer-schuldet-es)
- [4. Was ausdrücklich **nicht** nötig ist](#4-was-ausdrücklich-nicht-nötig-ist)
- [5. Die Bauform](#5-die-bauform)
- [6. Was der Code tatsächlich tut — die geprüfte Tatsachengrundlage](#6-was-der-code-tatsächlich-tut--die-geprüfte-tatsachengrundlage)
- [7. Kritische Befunde](#7-kritische-befunde)
- [8. Die Vorlagen](#8-die-vorlagen)
- [9. Wo ich unsicher bin](#9-wo-ich-unsicher-bin)
- [10. Macht die mitgelieferte Vorlage angreifbar?](#10-macht-die-mitgelieferte-vorlage-angreifbar)

---

## Vorbemerkung: was dieses Dokument ist und was nicht

> ⚠️ **Ich bin ein Sprachmodell und kein zugelassener Rechtsanwalt.** Dieses
> Dokument ist keine Rechtsberatung im Sinne des RDG, es begründet kein
> Mandatsverhältnis, und es ersetzt keine anwaltliche Prüfung.
>
> ⚠️ **Mein Wissensstand endet.** Er reicht bis Mai 2026. Alles, was danach in
> Kraft getreten, geändert oder von einem Gericht anders entschieden worden
> ist, kenne ich nicht. Recht in diesem Bereich bewegt sich schnell: DDG, TDDDG
> und BFSG sind alle jünger als drei Jahre, und zur Auslegung von § 25 TDDDG,
> zum BFSG-Anwendungsbereich und zur Drittlandübermittlung an KI-Anbieter ist
> vieles noch nicht ausjudiziert.
>
> ⚠️ **Vor Inbetriebnahme ist eine anwaltliche Prüfung unverzichtbar** — und
> zwar durch den **Betreiber**, für seine konkrete Konstellation. Was hier
> steht, ist Vorarbeit: die Analyse der Datenflüsse aus dem Quelltext, die
> Zuordnung der Rollen und Vorlagentexte mit gekennzeichneten Platzhaltern. Die
> Entscheidung, welche Rechtsgrundlage gilt, ob eine Stelle öffentlich ist und
> ob ein Formular besondere Kategorien personenbezogener Daten erhebt, kann nur
> treffen, wer den Fall kennt.
>
> **Insbesondere ungeprüft ist die Vorlage für den Auftragsverarbeitungsvertrag**
> ([`06-auftragsverarbeitungsvertrag.md`](vorlagen/06-auftragsverarbeitungsvertrag.md)).
> Ein AV-Vertrag ist ein Vertrag; ein Vertrag aus einer Vorlage, den niemand
> geprüft hat, ist ein Risiko und keine Erleichterung.

**Stand dieser Analyse:** 2026-08-18, gegen den Branch
`claude/zweite-review-runde-4jtwkw`. Jede Tatsachenaussage über das Verhalten
der Software ist gegen den Quelltext geprüft und nennt die Datei; wo ich nur
die Dokumentation gelesen habe, steht es dabei.

---

## 1. Der Befund in einem Absatz

Formsache ist rechtlich **keine Anwendung mit einem Impressum**, sondern eine
Anwendung mit **zwei Rechtsschichten übereinander**: der Betreiber betreibt
einen digitalen Dienst und ist dafür Diensteanbieter; die Organisation erhebt
darüber Daten und ist dafür Verantwortliche. Die Teilnehmenden sehen beides
gleichzeitig auf einer Seite und können es nicht auseinanderhalten. Deshalb ist
die richtige Bauform **nicht** eine Impressumsseite, die der Betreiber füllt,
sondern **zwei Sätze rechtlicher Seiten mit zwei Herkünften**, die auf jeder
öffentlichen Seite nebeneinander verlinkt und **als zu wem gehörig beschriftet**
sind. Alles andere führt entweder dazu, dass die Organisation ihre
Informationspflicht nach Art. 13 DSGVO nicht erfüllt (weil dort nur der
Betreiber steht), oder dazu, dass der Betreiber seine Anbieterkennzeichnung
nicht erfüllt (weil dort nur die Organisation steht).

Die gute Nachricht, und sie ist unerwartet deutlich: **die Software macht das
technisch leicht**, weil sie außerordentlich sparsam ist. Auf dem öffentlichen
Ausfüllpfad setzt sie **kein einziges Cookie**, benutzt **weder `localStorage`
noch `sessionStorage`**, lädt **keine einzige Ressource von einem Dritten**
(Schriften liegen im Bündel, CSP ist `default-src 'self'`), speichert **keine
IP-Adresse in der Datenbank** und **protokolliert keine**. Ein Cookie-Banner
wäre hier nicht nur unnötig, sondern falsch.

---

## 2. Die drei Rollen — und wer wofür Verantwortlicher ist

Das ist die wichtigste Frage des Auftrags, und sie hat keine einheitliche
Antwort: **die Rollen wechseln je nach Datenkategorie.** Wer eine einzige
Antwort sucht („der Betreiber ist Auftragsverarbeiter"), baut die Seiten falsch.

### 2.1 Die Zuordnung, Kategorie für Kategorie

| Datenkategorie | Verantwortlicher (Art. 4 Nr. 7) | Auftragsverarbeiter (Art. 28) | Begründung |
|---|---|---|---|
| **Antworten auf ein Formular** (`response.answers`) | **die Organisation** | der Betreiber | Die Organisation entscheidet allein über Zweck (welche Meldung) und Mittel im rechtlich maßgeblichen Sinn (welche Felder, welche Frist, wer sie sieht). Der Betreiber kennt die Inhalte nicht und darf sie nicht für eigene Zwecke nutzen. |
| **Anlagen zu Antworten** (`file`) | **die Organisation** | der Betreiber | dasselbe; die Organisation entscheidet, ob sie einen Upload verlangt |
| **Zwischengespeicherte Entwürfe** (`response_draft`) | **die Organisation** | der Betreiber | die Organisation schaltet *Zwischenspeichern* frei (`allowSaveDraft`) |
| **Versandprotokoll** (`mail_log`) | **die Organisation** | der Betreiber | der Rumpf trägt Antwortinhalte; die Organisation schreibt die Benachrichtigung |
| **Bearbeiter-Konten** (`user`, `membership`, `session`) | **strittig — siehe 2.2** | — | der Betreiber stellt das Anmeldesystem, die Organisation entscheidet, wen sie einlädt |
| **Betriebsdaten der Installation** (Sicherungen, `job_run`, `ops_alert`, Anfrage-IDs, Rate-Limit-Zähler im Arbeitsspeicher) | **der Betreiber** | — | eigener Zweck: Betriebssicherheit und Verfügbarkeit, Art. 6 Abs. 1 lit. f bzw. lit. c i. V. m. Art. 32 |
| **KI-Freitext** (`ai_usage.prompt`) | **die Organisation** (der Bearbeiter tippt ihn) — **und** der Betreiber, soweit er Anbieter, Modell und Region wählt | der KI-Anbieter ist Unterauftragsverarbeiter des Betreibers | siehe 7.6 — hier ist die Rollenkette am schwächsten begründet |

### 2.2 Die unbequeme Stelle: die Bearbeiter-Konten

Für die Konten der Bearbeiter lässt sich **weder** „Betreiber ist
Verantwortlicher" **noch** „Organisation ist Verantwortliche" sauber
durchhalten:

- Der **Betreiber** entscheidet über das Anmeldeverfahren, die Passwort-Politik
  (Argon2id), die Sitzungsdauer (`SESSION_TTL_HOURS`), die Aufbewahrung toter
  Sitzungen (7 Tage) und darüber, dass Einladungen über **seinen** Mailserver
  gehen (ADR-0024 Nr. 3) — auf seiner Domäne, mit seinem SPF/DKIM.
- Die **Organisation** entscheidet, wen sie einlädt, welche Rechte sie vergibt
  und wann sie ein Konto entfernt. Sie konfiguriert ihren eigenen
  Identitätsanbieter (OIDC je Tenant, ADR-0012).

Das ist die klassische Konstellation für **gemeinsame Verantwortlichkeit nach
Art. 26 DSGVO**. ⚠️ **Empfehlung: nicht offenlassen.** Art. 26 Abs. 1 verlangt
eine *Vereinbarung*, in der die Aufgabenverteilung transparent festgelegt ist,
und Art. 26 Abs. 2 verlangt, dass „das Wesentliche der Vereinbarung" den
betroffenen Personen zur Verfügung gestellt wird. Praktisch: ein Abschnitt in
den Nutzungsbedingungen zwischen Betreiber und Organisation
([`07`](vorlagen/07-nutzungsbedingungen-organisationen.md), § 8) und ein
Abschnitt in der Datenschutzerklärung des Betreibers
([`03`](vorlagen/03-datenschutzerklaerung-betreiber.md), Abschnitt 5).

Die Alternative — Betreiber als reiner Auftragsverarbeiter auch für die Konten
— halte ich für schwer haltbar, solange die Einladungsmail unter seiner Domäne
und mit festem Systemtext hinausgeht, den keine Organisation ändern kann
(ADR-0024 Nr. 10, ADR-0026 Nr. 1). Wer den Text bestimmt, bestimmt den Zweck
dieser einen Verarbeitung mit.

### 2.3 Die Folge für die Bauform

Aus 2.1 folgt unmittelbar: **die Datenschutzerklärung des Betreibers kann die
Informationspflicht der Organisation nach Art. 13 DSGVO nicht erfüllen.** Sie
kann es nicht einmal ansatzweise, denn sie kann die Pflichtangaben nach
Art. 13 Abs. 1 lit. a (Name des Verantwortlichen), lit. c (Zwecke und
Rechtsgrundlage) und Abs. 2 lit. a (Speicherdauer, soweit fachlich bestimmt)
für ein fremdes Formular gar nicht kennen.

Umgekehrt kann die Datenschutzerklärung der Organisation nicht die Verarbeitung
abdecken, die der Betreiber für eigene Zwecke vornimmt (Sicherungen,
Rate-Limits, Betriebsüberwachung).

**Also: zwei Erklärungen, nicht eine.** Das ist keine Bequemlichkeit, das ist
der Grund, warum die Bauform in Abschnitt 5 so aussieht, wie sie aussieht.

---

## 3. Welches Dokument ist nötig, und wer schuldet es

### 3.1 Impressum / Anbieterkennzeichnung

**Rechtsgrundlage:** § 5 DDG (Digitale-Dienste-Gesetz). Das DDG hat das TMG zum
**14.05.2024** abgelöst; § 5 TMG ist inhaltlich als § 5 DDG fortgeführt. Das
entspricht meinem Kenntnisstand und ist die Grundlage der Vorlagen. Zusätzlich
und **weiter reichend**: § 18 Abs. 1 MStV (Medienstaatsvertrag).

⚠️ **Der Unterschied zwischen beiden ist hier praktisch entscheidend**, und er
wird meistens übersehen:

- **§ 5 DDG** gilt für *geschäftsmäßige, in der Regel gegen Entgelt angebotene*
  digitale Dienste. Ein Verein, der Formulare für seine Mitglieder bereitstellt,
  und eine Behörde, die eine Bestandsmeldung entgegennimmt, fallen **möglicherweise
  nicht** darunter. „Geschäftsmäßig" wird allerdings weit ausgelegt (nachhaltige
  Tätigkeit, Entgeltlichkeit nicht erforderlich), sodass die meisten Betreiber
  im Zweifel doch erfasst sind.
- **§ 18 Abs. 1 MStV** gilt für **alle** Telemedien, „die nicht ausschließlich
  persönlichen oder familiären Zwecken dienen". Er verlangt Namen und Anschrift
  und bei juristischen Personen den Vertretungsberechtigten — leicht erkennbar,
  unmittelbar erreichbar und ständig verfügbar.

**Fazit: eine Anbieterkennzeichnung ist praktisch immer nötig**, notfalls über
§ 18 MStV, auch wenn § 5 DDG nicht greift. Die Vorlage
[`01`](vorlagen/01-impressum-betreiber.md) ist deshalb so gebaut, dass der
Pflichtteil (§ 18 MStV) vom Zusatzteil (§ 5 DDG, Register, USt-IdNr.,
Aufsichtsbehörde) getrennt ist.

**Wer schuldet es:** der **Diensteanbieter** — wer den Dienst unter der
aufgerufenen Adresse anbietet.

⚠️ **Und das ist nicht immer der Betreiber.** `tenant.public_base_url` existiert
(`apps/api/prisma/schema.prisma`, ADR-0013 Nr. 3): eine Organisation kann unter
**ihrer eigenen** Adresse erreichbar sein. Dann ist unter dieser Adresse *sie*
die Diensteanbieterin, und *ihr* Impressum ist das geschuldete. Läuft alles
unter der Adresse der Installation, ist es das des Betreibers. **Weil die
Software beides zulässt, muss die Bauform beides tragen** — siehe 5.3.

### 3.2 Datenschutzerklärung nach Art. 13 DSGVO

**Rechtsgrundlage:** Art. 13 DSGVO (Erhebung bei der betroffenen Person),
Art. 12 Abs. 1 (präzise, transparent, leicht zugänglich, klare und einfache
Sprache).

**Wer schuldet sie — die Kernfrage des Auftrags:**

| Für welche Verarbeitung | Wer schuldet | Wo sie erscheinen muss |
|---|---|---|
| Antworten, Anlagen, Entwürfe, Benachrichtigungen zu **einem Formular** | **die Organisation** | auf dem öffentlichen Formular, **vor** dem Absenden erreichbar |
| Betrieb der Anwendung (Auslieferung, Rate-Limits, Sicherungen, Überwachung, Mailversand als solcher) | **der Betreiber** | überall, wo die Anwendung erreichbar ist |
| Bearbeiter-Konten | **beide, gemeinsam** (2.2) | in beiden Erklärungen, mit Verweis aufeinander |

⚠️ **Der Zeitpunkt ist Teil der Pflicht.** Art. 13 Abs. 1 sagt „zum Zeitpunkt
der Erhebung". Ein Link, den man erst auf der Bestätigungsseite sieht, ist zu
spät. Der Link gehört auf **jede** öffentliche Seite (`/f/<slug>`,
`/e/<token>`, `/a/<token>`), auch auf die gesperrte Vorstufe hinter dem
Zugangswort — dort wird zwar noch nichts erhoben, aber die Seite ist Teil des
Vorgangs.

### 3.3 Art. 14 DSGVO — und ja, er greift hier

**Rechtsgrundlage:** Art. 14 DSGVO (Daten, die *nicht* bei der betroffenen
Person erhoben wurden).

Das wird bei Formularsystemen fast immer vergessen, und es greift hier
nachweislich: `docs/kb/10-datenschutz.md` §1.3 nennt als Betroffene
ausdrücklich „mittelbar jede Person, die sie in einem Freitextfeld nennt". Die
Anwendung bietet `textarea`, `table` (bis 20 Zeilen mit frei definierten
Spalten) und `event` — die Bauform für „Begleitpersonen", „Angehörige",
„Ansprechpartner". Eine Sterbefallmeldung nennt naturgemäß Dritte.

**Wer schuldet es:** die **Organisation**. Sie muss die genannten Dritten
informieren — binnen eines Monats (Art. 14 Abs. 3 lit. a) — **oder** sich auf
eine Ausnahme berufen, praktisch fast immer auf Art. 14 Abs. 5 lit. b
(unverhältnismäßiger Aufwand). ⚠️ **Diese Berufung muss dokumentiert und
begründet sein, und sie verlangt als Ausgleich, dass die Informationen
öffentlich bereitgestellt werden** — genau dafür gibt es in der Vorlage
[`04`](vorlagen/04-datenschutzhinweise-organisation.md) den Abschnitt
*„Wenn Sie Angaben zu anderen Personen machen"*. Ohne ihn ist die Ausnahme nicht
tragfähig.

### 3.4 Barrierefreiheitserklärung

> ⚠️ **Seit Review-Runde 4 Nr. 4 liefert die Anwendung diese Seite nicht mehr
> aus.** Die Anweisung lautete: „Barrierefreiheit Erklärung streichen wir
> komplett ersatzlos. Das optionale können wir uns erstmal sparen." Seite,
> Vorlage im Code, Fußzeilen-Verweis, Assistentenschritt und die Spalte im
> gespeicherten Dokument sind fort.
>
> Dieser Abschnitt und die Vorlage
> [`05`](vorlagen/05-barrierefreiheitserklaerung.md) bleiben stehen, weil sie
> weiterhin richtig sind: wen § 12b BGG trifft, den trifft er unabhängig
> davon, was diese Software anbietet. Ein Betreiber in dieser Lage hinterlegt
> die Erklärung außerhalb von Formsache — oder trägt sie als **eigenen Text**
> in eine der beiden verbliebenen Seiten ein. Seit 2026-09-07 gibt es dafür
> auch den dritten Weg: eine der Seiten als **Verweis** auf die Adresse
> hinterlegen, unter der die Erklärung schon steht
> ([ADR-0028 Fortschreibung](../architecture/0028-rechtstexte.md)).

Hier sind **zwei Regime** zu unterscheiden, und die Frage „wen trifft es"
beantwortet sich nach dem **Betreiber**, nicht nach der Software.

**a) Öffentliche Stellen — § 12a/§ 12b BGG und BITV 2.0**

Wenn der Betreiber eine öffentliche Stelle des **Bundes** ist: § 12a BGG
verpflichtet zur Barrierefreiheit, § 12b BGG verlangt eine **Erklärung zur
Barrierefreiheit** mit gesetzlich vorgegebenem Inhalt, und die BITV 2.0
konkretisiert den Maßstab (im Wesentlichen EN 301 549 / WCAG 2.1 AA). Ist der
Betreiber eine öffentliche Stelle eines **Landes**, gilt das jeweilige
Landesgleichstellungsgesetz mit eigener Landes-BITV — inhaltlich meist parallel,
aber mit **eigener Schlichtungsstelle**. Das ist ein Platzhalter in der Vorlage,
kein Detail: die falsche Durchsetzungsstelle zu nennen macht die Erklärung
wertlos.

Pflichtinhalte nach § 12b BGG (in [`05`](vorlagen/05-barrierefreiheitserklaerung.md)
abgebildet): Stand der Vereinbarkeit, Benennung **nicht** barrierefreier Inhalte
mit Begründung, Datum der Erstellung/Überprüfung und Prüfverfahren,
Feedback-Mechanismus (barrierefrei erreichbar!), Hinweis auf das
Durchsetzungsverfahren.

**b) Unternehmen — BFSG, seit 28.06.2025**

Das Barrierefreiheitsstärkungsgesetz gilt seit dem **28.06.2025**. Ob es
Formsache trifft, ist eine **Einzelfallfrage und im Regelfall zu verneinen**:

- Erfasst sind u. a. „Dienstleistungen im elektronischen Geschäftsverkehr"
  (§ 1 Abs. 3, § 2 Nr. 26 BFSG). Das setzt einen **Vertragsschluss mit einem
  Verbraucher über eine Website** voraus. Eine Bestandsmeldung, eine
  Sterbefallmeldung oder eine kostenlose Anmeldung zur Jahrestagung durch ein
  Mitglied ist typischerweise **kein** Verbrauchervertrag im elektronischen
  Geschäftsverkehr.
- ⚠️ **Aber:** eine **kostenpflichtige** Veranstaltungsanmeldung an Verbraucher
  über ein Formular kann sehr wohl darunterfallen. Formsache hat zwar keine
  Bezahlfunktion (`docs/kb/00-overview.md`, „Kein Ziel"), aber ein Formular
  kann trotzdem der Ort des Vertragsschlusses sein.
- **Kleinstunternehmen** (< 10 Beschäftigte **und** ≤ 2 Mio. € Jahresumsatz/
  -bilanzsumme) sind bei Dienstleistungen nach § 3 Abs. 3 BFSG ausgenommen.

**Meine Empfehlung, unabhängig von der Pflicht:** die Erklärung trotzdem
abgeben. Die Software hat eine ungewöhnlich gute Ausgangslage — 37 Ansichten
werden in der E2E-Suite mit `axe-core` gegen `wcag2a`, `wcag2aa`, `wcag21a`,
`wcag21aa` geprüft (`e2e/a11y/scan.ts`, `e2e/a11y/views.ts`), es gibt Tests für
Skip-Link, Tastaturführung, Ankündigungen, `prefers-reduced-motion` und
gerenderten Kontrast. Wer das hat, sollte es sagen dürfen. ⚠️ **Aber ehrlich**:
siehe 7.9 — automatisierte Prüfung ist kein Konformitätsnachweis, und die
Vorlage sagt das ausdrücklich.

### 3.5 Auftragsverarbeitungsvertrag, Art. 28 DSGVO

**Zwei Ebenen, beide nötig:**

1. **Betreiber ↔ jede Organisation.** Der Betreiber verarbeitet die
   Antwortdaten im Auftrag. Art. 28 Abs. 3 verlangt einen Vertrag oder ein
   anderes Rechtsinstrument. **Ohne ihn verarbeitet jede Organisation rechtswidrig
   und der Betreiber haftet mit.** → Vorlage
   [`06`](vorlagen/06-auftragsverarbeitungsvertrag.md).
2. **Betreiber ↔ seine Dienstleister**, als Unterauftragsverarbeiter
   (Art. 28 Abs. 4): Hoster, Betreiber des SMTP-Relays, ggf. KI-Anbieter. Diese
   Verträge muss der Betreiber selbst schließen; die Anwendung kann davon
   nichts wissen. Die Liste gehört als **Anlage 2** in den AVV, damit die
   Organisationen sie kennen (Art. 28 Abs. 2: Genehmigung/Widerspruchsrecht).

**Der Ertrag, den wir aus dem Code liefern können und der sonst geraten wird:
die TOM-Anlage nach Art. 32.** `docs/kb/10-datenschutz.md` §3 ist eine Tabelle,
in der **jede Zeile die Datei nennt, die sie hält**. Das ist mehr, als die
meisten AV-Verträge in ihrer TOM-Anlage stehen haben, und es ist überprüfbar.
Anlage 1 der Vorlage übernimmt es und markiert die zwei Zeilen, die dem
Betreiber gehören und nicht dem Code (TLS-Abschluss, EU-Hosting).

⚠️ **Der AV-Vertrag mit dem KI-Anbieter ist Vorbedingung, nicht Nacharbeit.**
Das steht schon in ADR-0015 Nr. 13 und in `10-datenschutz.md` §4.1 — dort steht
es richtig, und ich habe nichts hinzuzufügen außer: die Anwendung kann es nicht
prüfen, das Setzen des Schlüssels *ist* die Erklärung.

### 3.6 Verzeichnis von Verarbeitungstätigkeiten, Art. 30 DSGVO

**Wer schuldet was:**

- **Der Betreiber**, zweifach: nach Art. 30 **Abs. 1** für die Verarbeitungen,
  bei denen er Verantwortlicher ist (Betriebsdaten, Konten), und nach Art. 30
  **Abs. 2** ein Verzeichnis der Verarbeitungen, die er **im Auftrag** ausführt.
  Das zweite wird regelmäßig vergessen.
- **Jede Organisation** nach Art. 30 Abs. 1 für ihre Formulare.

Die Ausnahme des Art. 30 Abs. 5 (< 250 Beschäftigte) greift hier **praktisch
nie**, weil sie voraussetzt, dass die Verarbeitung nur gelegentlich erfolgt —
ein dauerhaft betriebenes Formularsystem ist nicht gelegentlich.

⚠️ **`docs/kb/10-datenschutz.md` ist nicht das Verzeichnis.** Das Dokument sagt
das selbst („Was hier steht, ist die Sicht der Anwendung"), und es hat recht.
Es ist die **Zulieferung** für das Verzeichnis: die Datenkategorien, Empfänger
und Fristen, die aus der Software folgen. Was fehlt, sind die Felder, die nur
der Verantwortliche kennt. → Vorlage
[`09`](vorlagen/09-verarbeitungsverzeichnis.md), die genau diese Lücke füllt und
für den Rest auf die Wissensbasis verweist, statt sie ein zweites Mal zu
schreiben.

### 3.7 Urheberrecht und Lizenzen

**Was in eine Urheberrechts-/Lizenzanzeige gehört:**

1. **Die MIT-Lizenz von Formsache im Wortlaut.** `LICENSE`: „Copyright (c) 2026
   Tilo Ullrich". Die MIT-Lizenz verlangt, dass Copyright-Vermerk und
   Lizenztext „in all copies or substantial portions of the Software"
   enthalten sind. Ob das reine Hosten eine „Kopie" im Lizenzsinn ist, ist
   umstritten; da das Frontend-Bündel an jeden Browser ausgeliefert wird,
   ist die Anzeige jedenfalls sicherer und kostet nichts.
2. **PT Serif, ParaType Free Font License** — und das ist der Punkt, an dem
   es **nicht** optional ist. Die beiden `.woff2`-Dateien werden an **jeden
   Browser jedes Teilnehmenden** ausgeliefert (`apps/web/src/styles/fonts.css`,
   `apps/web/src/assets/fonts/`). Das ist eine Verbreitung, und die PTFFL
   verlangt, dass ihr Copyright-Vermerk mitgeht. Die Lizenzdatei liegt im Repo
   (`apps/web/src/assets/fonts/LICENSE.txt`), aber sie geht mit dem Bündel
   **nicht** mit — sie steht in keinem ausgelieferten Artefakt. **Das ist eine
   echte, heute offene Lücke.** Siehe 7.10.
3. **Die Abhängigkeiten des Frontend-Bündels.** Alles, was `vite build` in
   `dist/` schreibt, wird verbreitet. MIT/BSD/ISC verlangen den Vermerk,
   Apache-2.0 zusätzlich die Weitergabe der `NOTICE`-Datei (Ziff. 4 lit. d).
   Empfehlung: eine `THIRD-PARTY-NOTICES`-Datei aus der Lockdatei erzeugen und
   über die Lizenzseite ausliefern.

**Was dort falsch wäre — und häufig steht:**

| Falsche Angabe | Warum sie falsch ist |
|---|---|
| „© [Betreiber] — Alle Rechte vorbehalten" über der ganzen Seite | Die Software gehört ihm nicht, sie steht unter MIT; die Schrift gehört ParaType; die Formularinhalte gehören der Organisation; die Antworten den Teilnehmenden. Ein pauschaler Vorbehalt ist eine Falschangabe über fremde Rechte. |
| Der Betreiber als „Anbieter der Software Formsache" | Er betreibt eine Installation. ADR-0019 trennt genau das: die Software heißt Formsache und ist überall dieselbe; die Installation heißt, wie der Betreiber sie nennt. |
| Entfernen des Copyright-Vermerks aus `LICENSE` | verstößt gegen die MIT-Lizenz und ist zugleich eine Urheberrechtsverletzung. |
| „Formsache®" oder eine Verwendung des Zeichens, die eine Billigung des Urhebers nahelegt | Die MIT-Lizenz erteilt **keine Markenrechte**. Ein Betreiber darf sagen, dass er Formsache einsetzt; er darf nicht auftreten, als sei sein Angebot das Produkt oder von dessen Urheber unterstützt. |
| Ein Urheberrechtsvermerk über den **Formularinhalten** der Organisation | Die Formulierungen der Fragen stammen von der Organisation. Ob sie überhaupt Werkhöhe erreichen, ist meist zweifelhaft — ein Vermerk darüber wäre eine Anmaßung. |

---

## 4. Was ausdrücklich **nicht** nötig ist

> Ein Dokument zu viel ist auch ein Fehler: es kostet Pflege, es veraltet, und
> ein Cookie-Banner ohne Cookies untergräbt die Glaubwürdigkeit aller anderen
> Angaben.

### 4.1 Kein Cookie-Banner, keine Einwilligung nach § 25 TDDDG — **geprüft, nicht vermutet**

§ 25 TDDDG (bis 14.05.2024 § 25 TTDSG) verlangt eine Einwilligung für das
Speichern von Informationen in der Endeinrichtung und den Zugriff darauf.
Ausnahme nach Abs. 2 Nr. 2: unbedingt erforderlich, damit ein vom Nutzer
ausdrücklich gewünschter Dienst bereitgestellt werden kann.

**Auf dem öffentlichen Ausfüllpfad wird der Tatbestand gar nicht erst erfüllt:**

| Prüfung | Befund | Beleg |
|---|---|---|
| Cookies auf öffentlichen Routen? | **keine.** `Set-Cookie` wird ausschließlich in `auth.controller.ts` und `oidc-login.controller.ts` gesetzt; alle Routen in `apps/api/src/public/` sind `@CsrfExempt` und setzen nichts | `apps/api/src/auth/`, `apps/api/src/public/` |
| `localStorage` / `sessionStorage`? | **keine Verwendung im gesamten Frontend** außer in Tests | Suche über `apps/web/src` |
| Zugangsnachweis nach dem Passwort-Tor? | bewusst nur im React-Zustand — „Not in `localStorage` and not in a cookie, deliberately" | `apps/web/src/views/PublicFormView.tsx:45`, Test `PublicFormView.test.tsx:2203` |
| Zeitlimit-Zustand? | im **signierten Token in der Nutzlast**, nicht im Browser | `apps/api/src/public/start-token.service.ts` |
| Ressourcen von Dritten (Schriften, CDN, Analytics, Karten, Einbettungen)? | **keine.** CSP: `default-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'` | `apps/web/index.html` |
| Schriften | im Bündel, ausdrücklich **wegen** der IP-Adressen der Teilnehmenden vom CDN geholt | `apps/web/src/styles/fonts.css`, `apps/web/src/assets/fonts/README.md` |

**Für angemeldete Bearbeiter** gibt es zwei Cookies: das Sitzungs-Cookie
(`httpOnly`, `SameSite=Lax`, `Secure` in Produktion) und das lesbare
CSRF-Token-Cookie. Beide sind für den ausdrücklich gewünschten Dienst
„angemeldete Sitzung" unbedingt erforderlich → § 25 Abs. 2 Nr. 2 TDDDG, **keine
Einwilligung**. Sie gehören in die Datenschutzerklärung, nicht in ein Banner.

⚠️ **Wenn ein Betreiber später Reichweitenmessung, ein Karten-Widget, ein
externes Schriften-CDN oder eine eingebettete Videoquelle einbaut, kippt dieser
Befund sofort.** Die CSP macht das nicht unmöglich, sie macht es nur sichtbar:
wer eine fremde Quelle aufnimmt, muss `index.html` anfassen. Das ist der
richtige Ort für einen Warnhinweis, und die Vorlage
[`03`](vorlagen/03-datenschutzerklaerung-betreiber.md) sagt es dort, wo der Satz
sonst falsch würde.

### 4.2 Keine Nutzungsbedingungen für Teilnehmende

Für das Ausfüllen eines Formulars ohne Konto gibt es nichts zu vereinbaren:
kein Vertragsschluss über die Plattform, kein Nutzerkonto, keine Vergütung,
keine nutzergenerierten Inhalte im Sinne einer Veröffentlichung. Eine
„AGB"-Seite für Teilnehmende wäre Ballast und würde die eine Seite verwässern,
die sie wirklich lesen sollen — die Datenschutzhinweise.

**Was stattdessen nötig ist**, und zwar in **das Formular** und nicht auf eine
eigene Seite: die fachlichen Bedingungen der Organisation (Teilnahmegebühr,
Rücktritt, Frist). Dafür gibt es die Fragetypen `info` und die Bestätigungsseite
(`confirmMsg`).

Nutzungsbedingungen zwischen **Betreiber und Organisation** sind dagegen sinnvoll
— aber als Vertrag, nicht als Webseite → [`07`](vorlagen/07-nutzungsbedingungen-organisationen.md).

### 4.3 Keine Widerrufsbelehrung, keine Verbraucherinformationen nach § 312d BGB

Die Software hat keine Bezahlfunktion (`docs/kb/00-overview.md`, „Kein Ziel").
Ohne entgeltlichen Vertrag über die Plattform greifen die
fernabsatzrechtlichen Pflichten nicht. ⚠️ Schließt eine **Organisation** über
ein Formular einen entgeltlichen Vertrag mit Verbrauchern (kostenpflichtige
Tagung), treffen **sie** diese Pflichten — und sie muss die Informationen in ihr
Formular schreiben. Das gehört in die Nutzungsbedingungen als Pflicht der
Organisation, nicht in eine Seite der Plattform.

### 4.4 Kein „Recht auf Datenübertragbarkeit"-Portal, kein Selbstbedienungs-Auskunftsweg

Art. 20 DSGVO greift nur bei Einwilligung oder Vertrag **und** automatisierter
Verarbeitung. Für Meldungen an eine Behörde (Art. 6 Abs. 1 lit. e) greift er
gar nicht. Und da Teilnehmende **kein Konto** haben, wäre ein
Selbstbedienungsweg ohnehin ein Identifizierungsproblem, kein Komfortproblem —
`docs/kb/09-betrieb.md` beschreibt den richtigen Weg (über die Organisation,
Formular für Formular). Nicht bauen.

### 4.5 Kein eigenes Impressum je Formular

Ein Formular ist kein eigenes Telemedium. Die Anbieterkennzeichnung gehört auf
die Ebene der Organisation bzw. des Betreibers, nicht auf jede
`/f/<slug>`-Adresse. **Der Link** gehört auf jede Seite — die Seite selbst nicht
je Formular.

---

## 5. Die Bauform

### 5.1 Der Grundsatz

> **Zwei Herkünfte, sechs Seiten, ein Mechanismus — und keine erfundene Angabe.**

Alles, was nur der Betreiber wissen kann, kommt aus den **Systemeinstellungen**.
Alles, was nur eine Organisation wissen kann, kommt aus ihren
**Organisationseinstellungen**. Fest im Code steht nur, was für jede
Installation und jede Organisation gleich gilt: die technische Beschreibung der
Plattform (Fristen, Empfänger, keine Cookies) und der Lizenztext.

### 5.2 Die Seiten, und wer sie füllt

| Seite | Adresse (Vorschlag) | Gefüllt von | Wo hinterlegt |
|---|---|---|---|
| Impressum des Betreibers | `/imprint` | Betreiber | `system_setting` |
| Datenschutzerklärung des Betreibers | `/privacy` | Betreiber, auf Basis von [`03`](vorlagen/03-datenschutzerklaerung-betreiber.md) | `system_setting` |
| Lizenzen und Urheberrecht | `/licences` | **fest im Code** | Quelltext + erzeugte Drittlizenzdatei |
| Anbieterangaben der Organisation | `/o/<kurzname>/imprint` | Organisation | `tenant` |
| Datenschutzhinweise der Organisation | `/o/<kurzname>/privacy` | Organisation, auf Basis von [`04`](vorlagen/04-datenschutzhinweise-organisation.md) | `tenant` |

**Warum die Organisationsseiten unter einem eigenen Pfadsegment liegen und
nicht unter `/f/<slug>/privacy`:** Ein Slug ist ein Zugangsmerkmal
(CSPRNG, base64url — dieselbe Klasse wie `edit_token`). Ein Rechtsdokument
unter einer nicht erratbaren Adresse widerspricht „ständig verfügbar" und
„leicht zugänglich" (§ 18 MStV, Art. 12 Abs. 1 DSGVO), und es verknüpft ein
Dokument mit einer Zugangsberechtigung, die es nicht braucht. `shortName` ist
bereits `@unique` und ist der richtige Schlüssel.

**Zusätzlich empfohlen: ein formularspezifischer Zusatz.** Ein Feld
*Datenschutzhinweis zu diesem Formular* in den Formular-Einstellungen (Recht:
`can_manage_form_settings`, ADR-0021), das **oberhalb** des allgemeinen Textes
der Organisation eingeblendet wird. Grund: Zweck und Rechtsgrundlage sind nach
Art. 13 Abs. 1 lit. c **je Verarbeitung** anzugeben, und eine
Sterbefallmeldung und eine Tagungsanmeldung derselben Organisation haben
verschiedene. Ein einziger Organisationstext, der beides abdecken soll, wird
entweder unrichtig oder unlesbar.

### 5.3 Was auf der öffentlichen Seite steht — die Fußzeile

Heute hat keine öffentliche Ansicht eine Fußzeile (geprüft: kein `<footer>` in
`apps/web/src`). `PublicFormView.tsx` rendert `<main className="public">` mit
`TenantHeader` und sonst nichts.

**Vorschlag:** eine `PublicLegalFooter`-Komponente unter **jeder** öffentlichen
Ansicht — Formular, gesperrte Vorstufe, Verfügbarkeitshinweis, Entwurf,
Bearbeiten-Ansicht, Bestätigungsseite. Inhalt, in dieser Reihenfolge und mit
**dieser Beschriftung**:

```
Verantwortlich für dieses Formular
⟨Name der Organisation⟩
  · Anbieterangaben   · Datenschutzhinweise
Betrieb dieser Plattform
⟨Name der Installation⟩
  · Impressum   · Datenschutz   · Lizenzen
```

Eine Abweichung vom ursprünglichen Vorschlag, aus Review-Runde 3:

- **Der Name steht in einer eigenen Zeile** (Nr. 8). Die Beschriftung ist
  versal gesetzter Kleindruck; ein Name, der mit Doppelpunkt daran hängt,
  passt auf keiner Breite in dieselbe Zeile, und was umbricht, bricht mitten
  im Namen um.

Der vierte Verweis, *Barrierefreiheit*, stand hier bis Review-Runde 4 in
Klammern — er erschien erst, wenn eine Erklärung hinterlegt war. Er ist mit
seiner Seite fort (3.4). Alle drei verbliebenen stehen damit unbedingt: 5.4
gilt unverändert, der Verweis steht immer, gerade weil das Versäumnis so
behebbar bleibt.

⚠️ **Die Beschriftung ist die eigentliche Leistung, nicht der Link.** Zwei
Impressen ohne Zuordnung sind schlechter als eines: die teilnehmende Person
kann dann nicht erkennen, an wen sie sich mit einem Auskunftsersuchen wenden
muss — und Art. 13 Abs. 1 lit. a verlangt genau diese Erkennbarkeit. Deshalb
nicht „Impressum | Impressum", sondern „Verantwortlich für dieses Formular"
gegen „Betrieb dieser Plattform".

**Reihenfolge: Organisation zuerst.** Sie ist die Verantwortliche für die
Daten, die gleich erhoben werden; der Betreiber ist für die teilnehmende Person
der Nebenschauplatz. Läuft die Installation unter der Adresse der Organisation
(`tenant.public_base_url`), ist sie zusätzlich die Diensteanbieterin — die
Reihenfolge stimmt dann doppelt.

### 5.4 Wenn ein Feld leer bleibt — die Frage, an der sich die Bauform entscheidet

Drei Möglichkeiten, und zwei davon sind falsch:

| Verhalten | Bewertung |
|---|---|
| **Kein Link, wenn nichts hinterlegt ist** | ❌ **Falsch.** Der Mangel wird unsichtbar. Der Betreiber merkt nie, dass er etwas vergessen hat, die Organisation auch nicht, und die teilnehmende Person hat keinen Anhaltspunkt, an wen sie sich wendet. Ein fehlendes Impressum ist mit oder ohne Link ein Verstoß — nur mit Link ist er behebbar. |
| **Ein erfundener oder generischer Text** | ❌ **Falsch, und schlimmer als nichts.** Eine erfundene Anbieterangabe ist eine Falschangabe; eine generische Datenschutzerklärung („Wir verwenden Cookies…") ist unrichtig **und** untergräbt alle richtigen Angaben daneben. Das ist die Grenze aus dem Auftrag, und sie gilt auch für Fallback-Texte. |
| **Link vorhanden, Seite sagt die Wahrheit** | ✅ **Richtig.** |

**Konkret für die leere Seite:**

- **Anbieterangaben:** „Für dieses Angebot sind bislang keine Anbieterangaben
  hinterlegt." Dazu — und das ist der Teil, der dem Leser wirklich hilft — die
  Angaben, die die Anwendung **wahrheitsgemäß** kennt: der Name der
  Organisation bzw. der Installation und, falls hinterlegt, die Antwortadresse.
- **Datenschutzhinweise der Organisation:** „⟨Organisation⟩ hat noch keine
  eigenen Datenschutzhinweise hinterlegt." **plus** den technischen Teil, den
  die Plattform für jede Organisation gleich und nachweisbar sagen kann:
  Speicherorte, Löschfristen, Empfängerkreise, keine Cookies, keine Dritten,
  kein Drittlandtransfer — das ist Abschnitt B der Vorlage
  [`04`](vorlagen/04-datenschutzhinweise-organisation.md) und er ist **immer
  wahr**, unabhängig davon, ob jemand etwas ausgefüllt hat. Dazu die
  Kontaktadresse des Betreibers als Notausgang für ein Auskunftsersuchen.

⚠️ **Der Einwand dagegen, und warum ich ihn nicht teile:** „Ein Hinweis auf die
eigene Lücke schreckt Teilnehmende ab." Ja — und das ist richtig so. Wer ohne
Datenschutzhinweise ein Formular veröffentlicht, hat eine Lücke; sie vor der
betroffenen Person zu verbergen macht sie nicht kleiner, sondern verlagert den
Schaden auf sie. Der Druck gehört auf die Organisation, und dort setzt der
nächste Absatz an.

> **Abweichung seit 2026-09-05, für die halb ausgefüllte Seite.** Der Betreiber
> hat für die **teilweise** ausgefüllte Seite anders entschieden: dort entfällt
> öffentlich die Zeile mit der offenen Angabe, und der Warnhinweis darüber
> entfällt mit ihr. Die **leere** Seite bleibt genau so, wie dieser Abschnitt
> sie beschreibt, und der Druck auf die verantwortliche Stelle bleibt an den drei
> Orten aus 5.5. Begründung und Abwägung stehen in der
> [Fortschreibung 2026-09-05 von ADR-0028](../architecture/0028-rechtstexte.md).

### 5.5 Wo die Anwendung den Mangel anzeigen soll

Nicht mit einer Pflichteingabe. Das Repository hat dieselbe Frage zweimal
entschieden (ADR-0022 §1, ADR-0025 §1) und beide Male gegen den Zwang: *„eine
Installation, die man erst betreiben kann, wenn ein Mailserver eingetragen ist,
zwingt zu erfundenen Werten"*. Für einen Rechtstext gilt das doppelt — ein
erfundenes Impressum ist der genau falsche Endzustand.

**Stattdessen, dem Haus-Idiom folgend:**

1. **Je ein Schritt in den beiden Assistenten.** Ein achter Schritt
   *Rechtliche Angaben* in der Erstinbetriebnahme (`apps/web/src/views/setup/steps.ts`,
   ADR-0022) und ein neunter in der Ersteinrichtung einer Organisation
   (`apps/web/src/views/tenant-setup/steps.ts`, ADR-0025). Beide Rahmen haben
   `consequence` als **Pflichtfeld** des Schritt-Typs — der Satz schreibt sich
   also fast von selbst:
   - Betreiber: *„Ohne diese Angaben zeigen Impressum und Datenschutzerklärung
     der Installation, dass nichts hinterlegt ist."*
   - Organisation: *„Ohne diese Angaben erfüllt kein Formular dieser
     Organisation die Informationspflicht nach Art. 13 DSGVO."*
2. **Ein Hinweis beim Veröffentlichen.** `apps/web/src/views/builder/PublishNotice.tsx`
   existiert bereits und ist der Ort, an dem jemand kurz vor der Öffentlichkeit
   steht. Ein Hinweis (kein Block) dort ist wirksamer als jede Einstellungsseite.
3. **Eine Zeile im Betriebsstatus des Superadministrators.** Der Status nach
   ADR-0016 Nr. 3 zeigt bereits, was fehlt; „Rechtstexte nicht hinterlegt" ist
   dieselbe Sorte Befund wie „kein Mailserver".

### 5.6 Wie der Text gespeichert und gerendert wird — sicherheitsrelevant

⚠️ **Hier liegt die Falle dieses Vorhabens.** Ein Rechtstext ist ein Freitext,
den ein Bearbeiter schreibt und der auf einer **von Fremden aufgerufenen** Seite
landet. Das ist genau das Muster, für das ADR-0026 („Fremdwerte in einer
Systemmail") die Regel aufgestellt hat, und die naheliegende Bequemlichkeit
— „lass HTML zu, Rechtstexte brauchen Absätze und Links" — wäre ein
Cross-Site-Scripting-Kanal auf dem öffentlichen Pfad.

**Empfehlung, drei Regeln:**

1. **Speichern als Klartext**, mit einer Obergrenze (Vorschlag: 20 000 Zeichen),
   validiert über ein Zod-Schema in `packages/shared` wie jeder andere Wert.
2. **Rendern als Text**, niemals über `dangerouslySetInnerHTML`. Das Repository
   hat diese Regel bereits und hält sie an drei Stellen ein
   (`SandboxedHtmlFrame.tsx`, `NotificationPreview.tsx`,
   `ConfirmationPreview.tsx`) — hier gilt sie unverändert.
3. **Wenn Struktur gebraucht wird** (Absätze, Listen, Links — und sie wird
   gebraucht): eine **enge Positivliste**, im Stil der Positivliste für
   Dateitypen (ADR-0014 Nr. 5), also Absatz, Aufzählung, Betonung, Überschrift
   zweiter Ordnung und Link — und beim Link ausschließlich `http:`, `https:` und
   `mailto:`, geprüft nach dem Parsen, nie über eine Zeichenkettenprüfung.
   `externalUrlSchema` in `packages/shared/src/form-settings.ts` macht genau
   diese Prüfung bereits für die Weiterleitungsadresse und ist die Vorlage.

**Und eine vierte, die leicht vergessen wird:** die Rechtstextseiten dürfen
`no-store` **nicht** erben. Sie tragen nichts Personenbezogenes und sollen
cachebar sein; „ständig verfügbar" nach § 18 MStV ist ein Argument dafür, nicht
dagegen.

### 5.7 Was **nicht** gebaut werden soll

- **Kein Einwilligungshäkchen „Ich habe die Datenschutzhinweise gelesen"** vor
  dem Absenden. Es ist keine Einwilligung im Sinne des Art. 6 Abs. 1 lit. a
  (die Rechtsgrundlage ist eine andere), es erfüllt die Informationspflicht
  nicht besser als ein Link, und es erzeugt den falschen Eindruck, die
  Verarbeitung stünde zur Disposition. Wo eine Organisation echte Einwilligung
  braucht (Foto-Veröffentlichung, Werbung), baut sie ein `checkbox`-Feld mit
  eigenem Text — das ist der richtige Ort und der Builder kann es heute.
- **Kein Cookie-Banner** (4.1).
- **Kein Sprachumschalter** für die Rechtstexte, solange die Oberfläche
  einsprachig deutsch ist (`AGENTS.md`). Das ist eine Folge dieser
  Voraussetzung und keine Ablehnung für immer: mit der Internationalisierung
  ([#59](https://github.com/ullriti/formsache/issues/59)) fällt sie
  weg und die Frage stellt sich neu. Der Einwand bleibt dabei stehen —
  zweisprachige Rechtstexte, die auseinanderlaufen, sind ein bekanntes
  Haftungsmuster, und eine übersetzte Vorlage ist keine Übersetzung, sondern
  eine neue Rechtsprüfung.
- **Keine automatische Übernahme von Betreiberangaben in Organisationsfelder.**
  Vorbelegen heißt hier: die Organisation gibt die Adresse des Betreibers als
  ihre eigene aus, ohne es zu merken.

---

## 6. Was der Code tatsächlich tut — die geprüfte Tatsachengrundlage

Die Vorlagen behaupten nichts, was hier nicht steht. Diese Tabelle ist die
Quelle für die Datenschutzhinweise; wer die Software ändert, prüft sie mit.

### 6.1 Was von einer teilnehmenden Person verarbeitet wird

| Datum | Wo | Wie lange | Beleg |
|---|---|---|---|
| Antworten (was die Organisation gefragt hat) | `response.answers` (JSONB) | **keine automatische Frist** — bis die Organisation löscht, dann 30 Tage Papierkorb, dann physisch | `TRASH_RETENTION_DAYS`, `retention-purge.service.ts` |
| Zeitpunkt der Absendung, Formularfassung | `response` | mit der Antwort | `schema.prisma` |
| Bearbeiten-Token | `response.edit_token` | **unbefristet**, solange die Antwort besteht und *Bearbeiten* an ist | `schema.prisma` |
| Anlagen (PDF, PNG, JPG, je ≤ 10 MiB, ≤ 10 je Antwort) | Dateiablage + `file` | mit der Antwort; **unbeansprucht 24 Stunden** | `UNCLAIMED_FILE_LIFETIME_MS`, `file-purge.service.ts` |
| Zwischengespeicherter Entwurf samt Anlagen | `response_draft` | **30 Tage**, oder früher mit der Frist des Formulars | `draft-retention.ts`, `draft.spec.ts` |
| Versandprotokoll: Empfängeradresse, Betreff, **eingefrorener Rumpf** | `mail_log` | **90 Tage** physisch; personenbezogene Spalten sofort beim endgültigen Löschen der Antwort | `MAIL_LOG_RETENTION_DAYS`, `mail-log-erasure.ts` |
| **IP-Adresse** | **nur im Arbeitsspeicher**, für Rate-Limits; IPv6 auf /64 reduziert | ≤ 2 Minuten (Zugangstor, Absenden), ≤ 1 Stunde (Upload-Kontingent) | `client-address.ts`, `address-form-tracker.ts` (`REMEMBER_MS`), `file-limits.ts` (`UPLOAD_WINDOW_MS`) |
| IP-Adresse in der Datenbank | **nein** — kein Modell führt eine Spalte dafür | `schema.prisma` |
| IP-Adresse im Protokoll | **nein** — Protokollzeilen tragen Codes, Klassen und Zahlen, geprüft durch einen Test | `json-logger.ts`, `test/observability/log-hygiene.spec.ts` |
| Bildmetadaten (EXIF/XMP/IPTC bei JPEG, `eXIf`/`tEXt`/`zTXt`/`iTXt` bei PNG) | **werden beim Hochladen entfernt** | `10-datenschutz.md` §1.5 |
| Metadaten in **PDF** | ⚠️ **bleiben unangetastet** | ebenda |

### 6.2 Wer die Daten zu sehen bekommt

- **Innerhalb der Organisation:** Bearbeiter mit `can_view_responses`, gefiltert
  durch die Formular-Restriktion (`FormRestrictionGuard`).
- ⚠️ **Ausnahme, die in die Hinweise gehört:** das **Versandprotokoll ist
  organisationsweit**, nicht formularbezogen. ADR-0021 („Offen und benannt")
  sagt es selbst: *„ein `editor` kann den Filter abwählen und die Zeilen aller
  Formulare sehen, auf die er nicht gesperrt ist."* Und der Rumpf trägt
  Antwortinhalte. Die Aussage „nur Bearbeiter **dieses** Formulars" wäre also
  **unrichtig**; die Vorlage sagt deshalb „berechtigte Bearbeiter der
  Organisation".
- **Außerhalb:** der Betreiber des Mailservers, den die Organisation eingetragen
  hat (oder der der Installation), soweit eine Benachrichtigung Antwortinhalte
  trägt. **Anlagen gehen nicht per Mail hinaus.**
- **Sonst niemand.** Kein Drittlandtransfer, solange die KI aus ist.

### 6.3 Was zwischen Organisationen passiert

Nichts. Die Mandantentrennung wird in der Guard-Kette durchgesetzt
(`TenantScopeGuard`, jede fachliche Abfrage mit `tenant_id` in der Bedingung)
und durch Integrationstests belegt, die den **unerlaubten** Zugriff scheitern
sehen (`test/tenancy/tenant-isolation.spec.ts`). Das ist eine Aussage, die man
in einen AV-Vertrag schreiben kann, ohne rot zu werden.

### 6.4 Was passiert, wenn die KI eingeschaltet ist

- Hinaus geht **nur** der Freitext des Bearbeiters und eine Sprachkennung —
  belegt durch Kanarienvogel-Tests (`test/ai/payload-canaries.spec.ts`). Keine
  Antwort-, Teilnehmer- oder Organisationsdaten.
- Dazu, was ein HTTP-Client mitschickt: SDK-Kennung, Paketversion,
  Protokollversion. Das Anthropic-SDK sendet zusätzlich Betriebssystem,
  Architektur und Node-Version von sich aus; **der Adapter schließt diese drei
  aus** (ADR-0015 Nr. 13).
- **Region:** `eu` ist Vorgabe. Für **Mistral** hält der EU-Endpunkt
  (`api.eu.mistral.ai`, festgenagelt in `test/ai/key-confinement.spec.ts`). Für
  **Anthropic ist EU-Verarbeitung nicht zugesichert** → Drittlandübermittlung
  mit eigener Grundlage.
- Der Freitext liegt bei uns und wird nach **30 Tagen** physisch auf `NULL`
  gesetzt; der Personenbezug der Nutzungszeile fällt nach **365 Tagen**.

**Teilnehmende sind davon nicht betroffen** — die KI erzeugt Entwürfe aus dem
Freitext eines Bearbeiters, nicht aus Antworten. Das gehört ausdrücklich in die
Hinweise, weil „KI" sonst genau das Gegenteil vermuten lässt.

---

## 7. Kritische Befunde

> Die unangenehmen. Sie standen nicht im Auftrag, gehören aber hierher.

### 7.1 🔴 Besondere Kategorien nach Art. 9 DSGVO — der Builder kennt sie nicht

Der Builder erhebt, was jemand hineinzieht. Drei Alltagsfälle sind **fast
zwangsläufig Art.-9-Daten**, und keiner davon sieht danach aus:

- **„Verpflegung: vegetarisch / vegan / halal / koscher"** bei einer
  Tagungsanmeldung → religiöse Überzeugung, ggf. Gesundheitsdaten.
- **„Barrierefreier Zugang / Assistenzbedarf"** → Gesundheitsdaten.
- **Eine Sterbefallmeldung** — Verstorbene sind zwar nicht von der DSGVO
  erfasst (ErwG 27), **die genannten Angehörigen aber sehr wohl**, und die
  Angaben zum Sterbefall können Gesundheitsdaten der Hinterbliebenen enthalten.

Die Anwendung bietet dafür **nichts**: keine Kennzeichnung einer Frage als
besondere Kategorie, keinen Einwilligungsmechanismus mit den erhöhten
Anforderungen des Art. 9 Abs. 2 lit. a (ausdrücklich, für festgelegte Zwecke),
keine strengere Löschfrist, keine engere Rechtevergabe für solche Felder. Und
`docs/kb/10-datenschutz.md` §1.3 sagt zutreffend, aber untertreibend: *„Die
Datenminimierung liegt im Formular, nicht im Code."* — Datenminimierung ja,
**Art. 9 nein**: der ist keine Frage des Maßes, sondern der Zulässigkeit
überhaupt.

**Empfehlung:** kurzfristig ein Hinweis im Builder, sobald ein Feld eine
typische Art-9-Formulierung trägt (nicht blockierend), und ein Abschnitt in den
Nutzungsbedingungen, der die Verantwortung dafür ausdrücklich der Organisation
zuweist ([`07`](vorlagen/07-nutzungsbedingungen-organisationen.md), § 5).
Mittelfristig ein eigener ADR: *„Wie eine Frage sagt, dass sie eine besondere
Kategorie erhebt."*

### 7.2 🔴 Der Dateiupload nimmt genau die Dokumente entgegen, die am heikelsten sind

`docs/kb/10-datenschutz.md` §1.5 nennt als Zweck der Anlagen: *„Nachweise zu
einer Meldung — Bescheinigung, Urkunde, Scan"*. Das ist ehrlich, und es ist
genau der Punkt: eine Bescheinigung ist typischerweise ein ärztliches Attest,
ein Schwerbehindertenausweis, eine Sterbeurkunde oder ein Nachweis über
Sozialleistungen. 10 MiB PDF, keine Inhaltsprüfung, PDF-Metadaten unangetastet.

Die Anwendung tut hier alles technisch Richtige (Positivliste an der Signatur,
`Content-Disposition: attachment`, `nosniff`, Bildmetadaten entfernt, 24-Stunden-
Frist für unbeanspruchte Dateien) — aber die **rechtliche** Konsequenz ist, dass
über diesen Weg Art.-9-Daten in die Installation kommen, ohne dass irgendetwas
im System das erkennt. Gehört in die Hinweise (Vorlage `04`, Abschnitt B.3) und
in die Nutzungsbedingungen.

### 7.3 🟠 Der Bearbeiten-Link ist ein unbefristeter Zugangsschlüssel im Postfach

`/a/<token>` öffnet die Antwort — vollständig, zum Ansehen und Ändern.
`response.edit_token` hat **keine Ablaufspalte**; der Link lebt, solange die
Antwort lebt und *Bearbeiten erlauben* eingeschaltet bleibt. Die Mail liegt im
Postfach, wird weitergeleitet, landet in einem geteilten Vereinspostfach.

Die Anwendung schützt die Adresse gut (`<meta name="referrer" content="no-referrer">`
in `apps/web/index.html`, ausdrücklich dafür), aber gegen Weiterleitung schützt
nichts. **Das gehört ehrlich in die Datenschutzhinweise** (Vorlage `04`,
Abschnitt B.6) — nicht als Ausrede, sondern als Hinweis, den die betroffene
Person zum Handeln braucht.

**Empfehlung an das Produkt:** eine Frist für den Bearbeiten-Link erwägen
(etwa: bis zur Frist des Formulars, sonst 90 Tage) — als ADR, nicht nebenbei.

### 7.4 🟠 Das Versandprotokoll ist organisationsweit und trägt Antwortinhalte

Siehe 6.2. ADR-0021 benennt es selbst als offenen Punkt. Rechtlich heißt das:
die Zusicherung „nur wer das Formular betreut, sieht die Antworten" ist für den
Weg über das Protokoll **nicht** haltbar. Das ist keine Katastrophe — es ist
eine Grenze, die in den Hinweisen und im AV-Vertrag richtig beschrieben werden
muss, statt beschönigt zu werden.

### 7.5 🟠 Minderjährige — kein Mechanismus, und der Anwendungsfall liegt nahe

Eine Anmeldung zu einer Jugendveranstaltung wird von Minderjährigen ausgefüllt.
Art. 8 DSGVO (Einwilligung eines Kindes, in Deutschland ab 16) hat keinen
Mechanismus in der Software: keine Altersabfrage, keine Einholung der
elterlichen Einwilligung, und Art. 12 Abs. 1 verlangt für Informationen an
Kinder eine **besonders klare und einfache Sprache**.

Relevant wird das nur, wo die Rechtsgrundlage die Einwilligung ist — bei
Vertrag oder öffentlicher Aufgabe nicht. Aber die Entscheidung darüber trifft
die Organisation, und heute weist nichts sie darauf hin. Gehört in die
Nutzungsbedingungen (§ 5) und in die Vorlage `04` als markierter Optionsblock.

### 7.6 🟠 Die Rollenkette bei der KI ist die schwächste im ganzen System

Wenn ein Bearbeiter einer Organisation einen Freitext tippt, der einen Namen
enthält, und dieser Text zu Anthropic in die USA geht:

- Wer ist Verantwortlicher? Die Organisation (ihr Bearbeiter tippt) — aber sie
  hat den Anbieter **nicht ausgewählt**, kann die Region nicht ändern (die
  Einstellung ist systemweit, `system_setting`) und erfährt vom Vertrag mit
  dem Anbieter nichts.
- Der Betreiber wählt Anbieter, Modell und Region und schließt den AV-Vertrag.
  Damit bestimmt er über ein wesentliches Mittel der Verarbeitung — was gegen
  eine reine Auftragsverarbeiterrolle spricht.
- Die 30-Tage-Frist für den Freitext ist im Code festgelegt und von keiner
  Organisation änderbar. Auch das ist eine Entscheidung über Mittel.

**Empfehlung:** die KI-Nutzung im AV-Vertrag ausdrücklich als
Unterauftragsverarbeitung führen, mit dem Anbieter und der Region **namentlich**
in Anlage 2, und der Organisation ein Widerspruchsrecht einräumen (Art. 28
Abs. 2). Der Schalter `tenant.ai_enabled` existiert bereits — er ist damit nicht
nur ein Kostenhebel, sondern das technische Gegenstück zu diesem Recht.
⚠️ **Und: solange Anthropic gewählt ist, gehört „Drittlandübermittlung in die
USA" ausdrücklich in die Datenschutzerklärung des Betreibers**, mit
Übermittlungsgrundlage (Angemessenheitsbeschluss EU-US Data Privacy Framework —
falls der Anbieter zertifiziert ist — oder Standardvertragsklauseln nebst
Transfer-Folgenabschätzung). Das kann die Anwendung nicht wissen; die Vorlage
`03` hat dafür einen bedingten Block.

### 7.7 🟡 Löschung erreicht die Sicherungen nicht — richtig dokumentiert, muss aber auch nach außen

`docs/kb/10-datenschutz.md` §2 sagt es klar: *„Physisch heißt: aus der lebenden
Zeile"* — MVCC-Tupelversionen bis zum `VACUUM`, WAL und Sicherungen sind nicht
erfasst; eine Sicherung altert mit `BACKUP_KEEP_DAYS` aus.

Das ist die richtige technische Entscheidung und die übliche Praxis. **Es muss
aber in der Antwort auf ein Löschersuchen stehen** (Art. 17 in Verbindung mit
Art. 12 Abs. 3/4), nicht nur in einer internen Wissensbasis. Vorlage `04`,
Abschnitt C, sagt es in einem Satz, den man einer betroffenen Person zumuten
kann.

### 7.8 🟡 Ein Rechtstext-Feld ist ein XSS-Kanal auf den öffentlichen Pfad

Siehe 5.6. Ich schreibe es hier noch einmal als Befund, weil es der wahrscheinlichste
Fehler bei der Umsetzung dieses Auftrags ist: „Rechtstexte brauchen Formatierung"
→ HTML zulassen → `dangerouslySetInnerHTML` → eine gespeicherte
Cross-Site-Scripting-Lücke auf genau der Seite, die Fremde aufrufen. Die CSP
(`script-src 'self'`) fängt viel ab, aber `style-src 'unsafe-inline'` steht
offen und ein `javascript:`-Link im Text ebenfalls.

### 7.9 🟡 „WCAG 2.1 AA geprüft" ist nicht dasselbe wie „WCAG 2.1 AA konform"

`axe-core` findet je nach Untersuchung nur etwa ein Drittel der tatsächlichen
Barrieren. Nicht automatisiert prüfbar sind unter anderem: die Sinnhaftigkeit
von Alternativtexten, die logische Reihenfolge, Verständlichkeit
(Leichte Sprache), Gebärdensprachvideos, und — hier besonders — **die von
Organisationen erstellten Formularinhalte**, die die Prüfliste gar nicht kennt.
Ein Formular mit einer Frage „Bitte hier ankreuzen" ohne beschreibendes Label
ist nicht barrierefrei, egal wie gut die Software ist.

Die Vorlage [`05`](vorlagen/05-barrierefreiheitserklaerung.md) sagt das
ausdrücklich und trägt „teilweise vereinbar" als **Vorgabe** — wer „vollständig
vereinbar" ankreuzt, ohne einen manuellen BITV-Test durchgeführt zu haben,
gibt eine unrichtige Erklärung ab.

### 7.10 🟡 Die Schriftlizenz wird heute nicht mitausgeliefert

`apps/web/src/assets/fonts/LICENSE.txt` liegt im Repository, wird aber von
`vite build` nicht nach `dist/` übernommen (die Datei wird von keinem Modul
importiert). Ausgeliefert werden die beiden `.woff2`-Dateien an jeden Browser.
Die ParaType Free Font License verlangt, dass ihr Vermerk mit den Dateien geht.

**Kleinstmögliche Behebung:** die Lizenzseite `/licences`
([`08`](vorlagen/08-urheberrecht-und-lizenzhinweise.md)) ausliefern und den
PTFFL-Text dort im Wortlaut aufnehmen. Das schließt die Lücke und kostet keine
Bauänderung außer der Seite, die ohnehin gebaut wird.

**Geschlossen.** Die Seite steht (`apps/web/src/views/legal/LicencesView.tsx`)
und bindet beide Lizenzdateien über `?raw` im Wortlaut ein — die des Repositorys
und die neben den Schriftdateien. Seit Review-Runde 3 Nr. 14 steht dort
zusätzlich die **Liste der Drittkomponenten**, erzeugt aus der Sperrdatei
(`tools/licences.ts`), mit Fassung, Kennung, Urheber und dem Wortlaut jeder
Lizenz. Damit ist auch der zweite Teil dieser Lücke zu — „MIT" zu nennen genügt
der MIT-Lizenz nicht, sie verlangt die fremde Copyright-Zeile mitzuliefern.

⚠️ Der Absatz, der das bis dahin **öffentlich** einräumte („wird derzeit nicht
ausgeliefert; sie ist ein offener Punkt"), ist mit der Lücke verschwunden. Eine
Selbstanzeige auf einer Seite, die jede teilnehmende Person aufrufen kann, war
der falsche Ort dafür — dieser hier ist der richtige.

### 7.11 🟡 Der Weiterleitungslink nach dem Absenden führt zu einem Dritten

`redirectEnabled` / `redirectUrl` (`packages/shared/src/form-settings.ts`)
schickt die teilnehmende Person nach dem Absenden auf eine beliebige
http(s)-Adresse. `no-referrer` verhindert, dass die Formularadresse mitgeht —
gut. Aber die IP-Adresse der teilnehmenden Person geht an den Dritten, und die
Organisation entscheidet darüber, ohne dass irgendetwas sie darauf hinweist.
Gehört als bedingter Satz in Vorlage `04` (Abschnitt B.7) und als Hinweis
neben das Feld in den Formular-Einstellungen.

**Gebaut am 2026-08-20, und eine Ebene tiefer als hier vorgeschlagen**
(ADR-0028 Nr. 5): Der Satz **mit der Zieladresse** steht jetzt im
Datenschutzhinweis **des Formulars** und wird dort aus `redirectEnabled` /
`redirectUrl` abgeleitet — er erscheint genau dann, wenn eine Weiterleitung
eingerichtet ist, und niemand füllt ein Feld dafür aus. In Vorlage `04` bleibt
der Abschnitt als allgemeiner Hinweis stehen, aber **ohne** Adresse: auf Ebene
der Organisation hat die Frage keine eindeutige Antwort, weil mehrere Formulare
verschiedene Ziele haben.

### 7.12 🟡 „Kein Self-Service-Signup" ist ein Datenschutzvorteil — er sollte nicht verloren gehen

`docs/kb/00-overview.md`: *„Self-Service-Signup gibt es bewusst nicht."* Das
hält den Kreis der Verantwortlichen klein und überschaubar und ist die
Voraussetzung dafür, dass der Betreiber mit **jeder** Organisation einen
AV-Vertrag schließen kann. Würde jemand Signup nachrüsten, bräche das ganze
Konstrukt aus Abschnitt 2 zusammen — dann gäbe es Verantwortliche, mit denen
kein Vertrag besteht. Verdient einen Satz in den Nutzungsbedingungen und
einen Gedanken, bevor es jemand ändert.

---

## 8. Die Vorlagen

Alle Platzhalter in der Form `[[GROSS_MIT_UNTERSTRICHEN]]`. Ein Text mit einem
verbliebenen `[[…]]` ist **nicht veröffentlichungsreif** — das ist absichtlich
so auffällig, dass es beim Korrekturlesen anspringt.

Bedingte Abschnitte sind mit `⟪NUR WENN … ⟫ … ⟪ENDE⟫` markiert und **müssen
ganz entfernt werden**, wenn die Bedingung nicht zutrifft.

| Datei | Wer füllt sie | Wohin |
|---|---|---|
| [`01-impressum-betreiber.md`](vorlagen/01-impressum-betreiber.md) | Betreiber | `/imprint` |
| [`02-anbieterangaben-organisation.md`](vorlagen/02-anbieterangaben-organisation.md) | Organisation | `/o/<kurzname>/imprint` |
| [`03-datenschutzerklaerung-betreiber.md`](vorlagen/03-datenschutzerklaerung-betreiber.md) | Betreiber | `/privacy` |
| [`04-datenschutzhinweise-organisation.md`](vorlagen/04-datenschutzhinweise-organisation.md) | Organisation (Teil A), fest (Teil B/C) | `/o/<kurzname>/privacy` |
| [`05-barrierefreiheitserklaerung.md`](vorlagen/05-barrierefreiheitserklaerung.md) | Betreiber | außerhalb der Anwendung — siehe 3.4 |
| [`06-auftragsverarbeitungsvertrag.md`](vorlagen/06-auftragsverarbeitungsvertrag.md) | Betreiber ↔ Organisation | Vertrag, keine Webseite |
| [`07-nutzungsbedingungen-organisationen.md`](vorlagen/07-nutzungsbedingungen-organisationen.md) | Betreiber | Vertrag, keine Webseite |
| [`08-urheberrecht-und-lizenzhinweise.md`](vorlagen/08-urheberrecht-und-lizenzhinweise.md) | **fest im Code** | `/licences` |
| [`09-verarbeitungsverzeichnis.md`](vorlagen/09-verarbeitungsverzeichnis.md) | Betreiber und Organisation, je eigenes | intern |

### 8.1 Die Reihenfolge der Umsetzung

1. **`08` zuerst** — sie hängt an nichts, ist fest im Code und schließt die
   Lizenzlücke aus 7.10.
2. **`03` und `01`** — ohne Datenschutzerklärung und Impressum des Betreibers
   darf die Installation nicht öffentlich erreichbar sein.
3. **`06` und `07`** — bevor die erste fremde Organisation aufgeschaltet wird.
4. **`04` und `02`** — bevor das erste Formular veröffentlicht wird.
5. **`05`** — vor dem Produktivgang, wenn der Betreiber öffentliche Stelle
   ist; sonst zeitnah danach. Die Anwendung liefert diese Seite seit
   Review-Runde 4 nicht mehr aus (3.4), die Pflicht besteht davon unabhängig
   weiter.
6. **`09`** — begleitend; das Verzeichnis ist nie fertig.

---

## 9. Wo ich unsicher bin

Ausdrücklich benannt, damit niemand die Sicherheit des Tons für Sicherheit in
der Sache hält:

| Frage | Meine Einschätzung | Warum unsicher |
|---|---|---|
| **Greift § 5 DDG oder nur § 18 MStV?** | im Zweifel beide bedienen | „geschäftsmäßig" ist ein Streitpunkt bei Vereinen und Behörden; die Vorlage löst es durch Bedienen des strengeren Maßstabs, was rechtlich sicher, aber möglicherweise mehr als nötig ist |
| **Trifft das BFSG den Betreiber?** | im Regelfall nein | Der Anwendungsbereich „Dienstleistung im elektronischen Geschäftsverkehr" ist neu und wenig ausjudiziert; bei kostenpflichtigen Anmeldungen an Verbraucher würde ich es bejahen |
| **Ist die Rollenverteilung bei den Bearbeiter-Konten gemeinsame Verantwortlichkeit?** | ja, überwiegend | Es gibt eine vertretbare Gegenauffassung (reine Auftragsverarbeitung mit Weisung). Die Entscheidung hat Folgen für Vertrag **und** Erklärung und gehört anwaltlich getroffen |
| **Reicht die Anzeige zweier Impressen nebeneinander für § 18 MStV / § 5 DDG?** | ja, mit klarer Beschriftung | „leicht erkennbar" bei zwei nebeneinanderstehenden Angaben ist meines Wissens nicht gerichtlich entschieden; die Beschriftung ist der Punkt, an dem es kippen könnte |
| **Ist Anthropic DPF-zertifiziert?** | **weiß ich nicht** | Der Zertifizierungsstatus einzelner Unternehmen ändert sich; er ist auf der DPF-Liste zu prüfen, **bevor** ein Schlüssel gesetzt wird. Ich behaupte hier nichts |
| **Bestand des EU-US Data Privacy Framework** | zum Stand meines Wissens in Kraft | Es ist beklagt worden; ein Wegfall würde jede Anthropic-Nutzung sofort auf SCC + Transfer-Folgenabschätzung zurückwerfen |
| **EU AI Act** | für diese Funktion voraussichtlich geringe Pflichten | Die KI erzeugt einen Formularentwurf für einen Bearbeiter, der weiß, dass er sie benutzt — kein Hochrisikosystem, keine Interaktion mit Unwissenden nach Art. 50 Abs. 1. Aber ich habe das nicht vertieft geprüft, und die Umsetzung in nationales Recht kenne ich nicht vollständig |
| **Ob § 25 TDDDG durch den signierten Start-Token berührt wird** | nein | Der Token liegt in der Antwortnutzlast und im Arbeitsspeicher der Seite, wird also nicht *in der Endeinrichtung gespeichert*. Ich halte das für eindeutig, aber die Auslegung von „Speichern von Informationen in der Endeinrichtung" ist bei In-Memory-Zuständen nicht abschließend geklärt |
| **Landesrecht** | nicht geprüft | Bei einer öffentlichen Stelle eines Landes gelten Landes-DSG, LBGG und Landes-BITV mit eigener Schlichtungsstelle. Die Vorlagen haben dafür Platzhalter, aber keine Inhalte |
| **Kirchliches Datenschutzrecht** | nicht geprüft | Bei kirchlichen Trägern gelten **DSG-EKD** oder **KDG** statt der DSGVO-Ausführungsgesetze, mit eigenen Aufsichtsinstanzen und teils abweichenden Fristen. Bei einer „Dachorganisation und ihren Mitgliedsorganisationen" ist das ein realistischer Fall — bitte prüfen, bevor die Vorlagen benutzt werden |

**Und eine Selbstkritik zum Verfahren:** Ich habe den Quelltext an den Stellen
gelesen, die für die Datenflüsse maßgeblich sind, aber ich habe die Anwendung
nicht ausgeführt und keine Netzwerkaufzeichnung gemacht. Die Aussage „es geht
keine Anfrage an einen Dritten" stützt sich auf CSP, Quelltextsuche und die
Dokumentation — nicht auf eine Messung. **Vor der Veröffentlichung der
Datenschutzerklärung sollte genau das gemessen werden**: eine Sitzung im
Browser, Netzwerkreiter offen, Formular ausfüllen, absenden, und die Liste der
Gegenstellen mit Abschnitt 6 vergleichen. Das ist eine Stunde Arbeit und der
einzige Weg, aus einer plausiblen Aussage eine belegte zu machen.

---

## 10. Macht die mitgelieferte Vorlage angreifbar?

Die Frage kam wörtlich so (Review-Runde 4 Nr. 9):

> *„Mache ich mich durch die Bereitstellung der Vorlage nicht angreifbar falls
> darin etwas fehlen sollte? Impressum/Anbieterangaben sind ja übersichtlich
> aber Datenschutz ist schwierig…"*

Sie ist berechtigt, und die ehrliche Antwort zerfällt in **drei verschiedene
Risiken**, die man nicht zusammen beantworten kann, weil sie verschiedene
Personen treffen. Für alle drei gilt die Vorbemerkung ganz oben: hier schreibt
kein Anwalt.

### 10.1 Als Autor der Software, gegenüber fremden Betreibern

**Das kleinste der drei Risiken — aber das mit der schärfsten Kante.**

Wer Software samt Textvorlagen unter der **MIT-Lizenz** weitergibt, liefert sie
ausdrücklich „AS IS", ohne Gewährleistung und unter Ausschluss der Haftung. Das
steht in `LICENSE` und deckt die mitgelieferten Texte mit ab: sie sind Teil des
Werks. Ein Betreiber, dessen Datenschutzerklärung unvollständig ist, hat daraus
keinen vertraglichen Anspruch — es gibt keinen Vertrag.

Was bleibt, sind zwei Kanten:

1. **Das RDG.** Eine Rechtsdienstleistung ist nach § 2 Abs. 1 RDG eine
   Tätigkeit in **konkreter fremder** Angelegenheit, die eine rechtliche
   Prüfung des Einzelfalls erfordert. Ein Generator, der aus Antworten einen
   Text zusammensetzt, ist das nach der Rechtsprechung des BGH zu einem
   Vertragsgenerator (Urteil vom 09.09.2021 – I ZR 113/20, *smartlaw*)
   **nicht**: er wendet ein vorgefertigtes Schema an und prüft keinen
   Einzelfall. Was in demselben Verfahren dagegen beanstandet wurde, war die
   **Werbung** — die Zusage „rechtssicher" und „individuell wie vom Anwalt"
   war irreführend im Sinne des UWG.
2. **Wettbewerbsrecht.** Genau daraus folgt die einzige Regel, die dieses
   Projekt sich selbst auferlegt:

> ⚠️ **Nirgends „rechtssicher", „geprüft", „DSGVO-konform" oder
> „abmahnsicher".** Weder in der Oberfläche, noch im README, noch in einer
> Ankündigung. Eine Vorlage ist ein **ausformulierter Entwurf**; das Wort
> „geprüft" behauptet eine Prüfung, für die jemand einstehen müsste. Der
> Hinweis „Keine Rechtsberatung" steht seit Review-Runde 4 in beiden
> Rechtstext-Reitern der Anwendung selbst, nicht nur hier.

Der Satz „sie ist geprüft" stand bis dahin in der Oberfläche. Er ist ersetzt —
das ist die konkrete Antwort auf diese Frage.

### 10.2 Als Betreiber einer Installation, gegenüber Teilnehmenden

**Das größte der drei Risiken — und die Vorlage ändert daran nichts.**

Ist die eigene Datenschutzerklärung unvollständig, haftet der Betreiber. Art. 13
und 14 DSGVO verlangen die Information, Art. 83 Abs. 5 lit. b stellt einen
Verstoß unter den oberen Bußgeldrahmen, und daneben stehen Abmahnung und
Unterlassungsanspruch. **Ob der Text aus einer Vorlage stammt oder selbst
geschrieben ist, spielt für diese Haftung keine Rolle.** „Ich habe eine Vorlage
benutzt" ist keine Verteidigung.

Die Vorlage senkt dieses Risiko trotzdem, und zwar in genau einer Richtung: sie
lässt weniger vergessen, weil jede Pflichtangabe ein **Feld** ist statt einer
Stelle im Fließtext, die man übersieht — und weil die Seite so lange
„unvollständig" heißt, wie eines davon leer ist. Was sie nicht kann, ist die
Entscheidungen treffen: welche Rechtsgrundlage gilt, ob die Stelle öffentlich
ist, ob ein Formular besondere Kategorien erhebt.

⚠️ **Das Impressum ist wirklich der einfachere Fall**, und die Frage benennt
das richtig. § 5 DDG und § 18 MStV zählen abschließend auf, was hineingehört;
die Vorlage bildet diese Liste ab. Die Datenschutzerklärung dagegen beschreibt
**Verarbeitungen**, und die kennt nur, wer die Installation betreibt: welcher
Hoster, welcher Maildienstleister, welche Aufbewahrungsfristen, welche weiteren
Auftragsverarbeiter. Deshalb sind das Felder und keine Vorgaben, und deshalb
steht Abschnitt 6 dieses Dokuments — die geprüfte Tatsachengrundlage — daneben:
Was die **Software** tut, ist nachlesbar und ausformuliert; was der **Betrieb**
tut, weiß nur der Betrieb.

### 10.3 Gegenüber den Organisationen auf der eigenen Installation

**Das Risiko, an das man zuletzt denkt.**

Wer fremden Organisationen eine Vorlage für *deren* Datenschutzhinweise
hinstellt, und eine von ihnen veröffentlicht damit etwas Unvollständiges, steht
näher an der Sache als ein anonymer Softwareautor: es besteht ein
Vertragsverhältnis (Nutzungsbedingungen, Vorlage
[`07`](vorlagen/07-nutzungsbedingungen-organisationen.md), und ein
Auftragsverarbeitungsvertrag, Vorlage
[`06`](vorlagen/06-auftragsverarbeitungsvertrag.md)).

Die Absicherung gehört deshalb **in diese Verträge** und nicht in einen
Oberflächentext:

- die Organisation ist Verantwortliche für die Inhalte ihrer Formulare und für
  ihre eigenen Rechtstexte — das steht bereits in `07`;
- die bereitgestellte Vorlage ist ein Entwurf, keine Rechtsberatung, und ihre
  Prüfung obliegt der Organisation;
- der Betreiber schuldet die **technische** Aussage (Teil B der Vorlage `04`,
  fest im Code) und für diese steht er auch ein — sie ist überprüfbar.

Diese Aufteilung ist keine Ausrede, sondern die tatsächliche Lage: der Betrieb
kann nicht wissen, wozu eine fremde Organisation ein Formular verwendet.

### 10.4 Was daraus konkret zu tun ist

| | Maßnahme | Stand |
|---|---|---|
| 1 | Kein „geprüft"/„rechtssicher" in der Oberfläche | **erledigt** (Review-Runde 4 Nr. 9) |
| 2 | „Keine Rechtsberatung" sichtbar an beiden Rechtstext-Reitern | **erledigt** |
| 3 | MIT-Haftungsausschluss bleibt unangetastet | steht in `LICENSE` |
| 4 | Verantwortungsaufteilung in `06` und `07` vertraglich | Vorlagen liegen vor, Abschluss ist Sache des Betreibers |
| 5 | Anwaltliche Prüfung **der eigenen** Erklärung vor dem Produktivgang | Sache des Betreibers — siehe Vorbemerkung |

**Die kürzeste Antwort auf die Frage:** Angreifbar macht nicht die Vorlage,
sondern eine **Zusage über** die Vorlage. Solange nirgends steht, sie sei
geprüft oder rechtssicher, ist ein mitgelieferter Entwurf rechtlich nicht
riskanter als ein leeres Textfeld — und praktisch deutlich weniger riskant,
weil er weniger vergessen lässt.
