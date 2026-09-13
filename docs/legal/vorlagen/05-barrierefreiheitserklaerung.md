# Vorlage 05 — Erklärung zur Barrierefreiheit

> 🚫 **Diese Vorlage wird von der Anwendung nicht mehr ausgeliefert**
> (Review-Runde 4 Nr. 4): „Barrierefreiheit Erklärung streichen wir komplett
> ersatzlos. Das optionale können wir uns erstmal sparen." Seite, Formular und
> Fußzeilen-Verweis sind fort. Die Vorlage bleibt hier, weil die **Pflicht**
> davon unberührt ist — wen § 12b BGG trifft, den trifft er, ganz gleich was
> diese Software anbietet.
>
> **Wer füllt das aus:** der Betreiber der Installation.
> **Wo erscheint es:** außerhalb von Formsache — auf der eigenen Website des
> Betreibers, oder als **eigener Text** in einer der beiden verbliebenen
> Rechtstextseiten. Die Seite selbst muss barrierefrei sein.
> **Rechtsgrundlage:**
> - **öffentliche Stellen des Bundes:** § 12b BGG i. V. m. §§ 3, 4, 12 BITV 2.0
> - **öffentliche Stellen eines Landes:** das jeweilige
>   Landesgleichstellungsgesetz und die Landes-BITV — mit **eigener**
>   Durchsetzungs- bzw. Schlichtungsstelle
> - **Unternehmen:** § 14 BFSG (seit 28.06.2025), soweit anwendbar — siehe
>   `docs/legal/README.md` Abschnitt 3.4; im Regelfall bei dieser Software
>   **nicht** anwendbar
>
> ⚠️ **Auch wenn keine Pflicht besteht: abgeben.** Diese Software hat eine
> ungewöhnlich gute Ausgangslage, und die Erklärung ist der Ort, an dem eine
> Barriere gemeldet werden kann. Ein Feedback-Weg ist mehr wert als eine
> Konformitätsbehauptung.
>
> 🔴 **Und der wichtigste Hinweis: „teilweise vereinbar" ist die richtige
> Vorgabe**, solange kein manueller Test nach dem BITV-Prüfverfahren
> durchgeführt wurde. Warum: siehe den Abschnitt *Was die automatisierte
> Prüfung nicht abdeckt* am Ende dieser Datei. „Vollständig vereinbar"
> anzukreuzen, weil eine Testsuite grün ist, ist eine unrichtige Erklärung.

---

# Erklärung zur Barrierefreiheit

[[NAME_DES_BETREIBERS]] ist bemüht, diese Anwendung im Einklang mit
[[GESETZESGRUNDLAGE — z. B. „§ 12a des Behindertengleichstellungsgesetzes
(BGG) in Verbindung mit der Barrierefreie-Informationstechnik-Verordnung
(BITV 2.0)"]] barrierefrei zugänglich zu machen.

Diese Erklärung gilt für [[GELTUNGSBEREICH — die Adresse der Installation, z. B.
„die unter https://formulare.beispiel.de erreichbare Anwendung einschließlich
aller öffentlich zugänglichen Formularseiten"]].

## Stand der Vereinbarkeit mit den Anforderungen

Diese Anwendung ist mit [[GESETZESGRUNDLAGE]]
**[[teilweise vereinbar / vollständig vereinbar / nicht vereinbar]]**.

Die Bewertung stützt sich auf [[GRUNDLAGE — siehe Auswahl unten]].

⚠️ **Bitte genau eine der folgenden Formulierungen wählen und die anderen
löschen.** Die Angabe muss zutreffen; sie ist der Kern dieser Erklärung.

**Variante A — nur automatisierte Prüfung durchgeführt (ehrlich, und der
Regelfall vor dem ersten manuellen Test):**

> Die Bewertung stützt sich auf eine automatisierte Prüfung der Anwendung. Bei
> jedem Entwicklungsstand werden [[ANZAHL, derzeit 37]] Ansichten der Anwendung
> mit dem Prüfwerkzeug `axe-core` gegen die Regelsätze WCAG 2.0 Stufe A und AA
> sowie WCAG 2.1 Stufe A und AA geprüft; die Anwendung wird nur ausgeliefert,
> wenn diese Prüfung ohne Beanstandung durchläuft. Ergänzend wird automatisiert
> geprüft, dass Sprungmarken zum Hauptinhalt vorhanden sind, dass die Anwendung
> vollständig mit der Tastatur bedienbar ist, dass Statusänderungen
> Hilfstechnologien angekündigt werden, dass die Einstellung „Bewegung
> reduzieren" beachtet wird und dass die dargestellten Farbkontraste
> eingehalten werden.
>
> **Eine automatisierte Prüfung ersetzt keine manuelle Bewertung.** Sie erfasst
> nach allgemeiner Erfahrung nur einen Teil der tatsächlichen Barrieren. Ein
> manueller Test nach dem BITV-Prüfverfahren
> ⟪NUR WENN GEPLANT⟫ist für [[ZEITRAUM]] vorgesehen⟪ENDE⟫
> ⟪NUR WENN NICHT GEPLANT⟫wurde bislang nicht durchgeführt⟪ENDE⟫.
> Aus diesem Grund lautet die Bewertung „teilweise vereinbar".

**Variante B — manueller Test durchgeführt:**

> Die Bewertung stützt sich auf eine am [[DATUM]] von [[PRUEFSTELLE]]
> durchgeführte Prüfung nach [[PRUEFVERFAHREN, z. B. „dem BITV-Prüfverfahren"]].
> Der Prüfbericht ist unter [[ADRESSE]] abrufbar. Ergänzend wird die Anwendung
> bei jedem Entwicklungsstand automatisiert gegen WCAG 2.1 AA geprüft.

## Nicht barrierefreie Inhalte

> ⚠️ **Dieser Abschnitt ist Pflicht** (§ 12b Abs. 2 Nr. 1 BGG) und darf nicht
> leer bleiben, wenn die Bewertung „teilweise vereinbar" lautet. Eine Erklärung
> ohne benannte Einschränkungen bei gleichzeitiger Angabe „teilweise vereinbar"
> ist in sich widersprüchlich. Die folgenden Punkte sind **Vorschläge, die für
> diese Software regelmäßig zutreffen** — jeder ist zu prüfen und entweder zu
> übernehmen, anzupassen oder zu streichen.

Die nachstehend aufgeführten Inhalte sind aus den jeweils genannten Gründen
nicht oder nicht vollständig barrierefrei.

### 1. Von Organisationen erstellte Formularinhalte

Über diese Anwendung stellen eigenständige Organisationen eigene Formulare
bereit. Fragetexte, Beschriftungen, Erläuterungen und Hilfetexte stammen von
diesen Organisationen. Die Anwendung stellt sicher, dass jedes Eingabefeld eine
programmatisch verknüpfte Beschriftung erhält; ob diese Beschriftung
**verständlich** ist, ob Erläuterungen in einfacher Sprache verfasst sind und
ob die Reihenfolge der Fragen sinnvoll ist, liegt bei der jeweiligen
Organisation.

*Grund:* unverhältnismäßige Belastung im Sinne von [[§ 12a Abs. 6 BGG /
entsprechende Landesregelung]] — eine inhaltliche Vorabprüfung jedes fremden
Formulars ist nicht leistbar.

*Was wir stattdessen tun:* [[MASSNAHME — z. B. „Die Organisationen werden auf
die Anforderungen hingewiesen und erhalten eine Handreichung." ODER „Bislang
nichts."]]

*Alternativer Zugang:* Wenden Sie sich an die Organisation, die das Formular
anbietet; ihre Kontaktdaten stehen in der Fußzeile des Formulars. Sie ist
verpflichtet, Ihnen einen zugänglichen Weg anzubieten.

### 2. Hochgeladene Dokumente und Bilder

Von Organisationen hochgeladene Logos tragen als Alternativtext den Namen der
Organisation. Von teilnehmenden Personen hochgeladene Dateien werden nicht
geprüft.

### 3. [[WEITERE_EINSCHRAENKUNG]]

*Beschreibung:* [[…]]
*Grund:* [[…]]
*Alternativer Zugang:* [[…]]

### Wenn nichts einzuschränken ist

⟪NUR WENN DIE BEWERTUNG „VOLLSTÄNDIG VEREINBAR" LAUTET UND EIN MANUELLER TEST
DAS BELEGT⟫
Es sind keine Inhalte bekannt, die nicht barrierefrei sind.
⟪ENDE⟫

## Datum der Erstellung und der letzten Überprüfung

Diese Erklärung wurde am [[DATUM_DER_ERSTELLUNG]] erstellt.
Sie wurde zuletzt am [[DATUM_DER_LETZTEN_UEBERPRUEFUNG]] überprüft.

> ⚠️ Eine jährliche Überprüfung ist vorgesehen; ein Datum, das mehrere Jahre
> zurückliegt, entwertet die Erklärung.

## Barrieren melden — Feedback und Kontakt

Sie sind auf eine Barriere gestoßen? Etwas ist für Sie nicht nutzbar? Sie
brauchen eine Information in einer zugänglichen Form?

**Bitte melden Sie sich — wir antworten.**

[[NAME_DER_ANSPRECHSTELLE]]
E-Mail: [[E_MAIL]]
Telefon: [[TELEFON]]
⟪NUR WENN VORHANDEN⟫Gebärdentelefon / Schriftdolmetschdienst: [[ANGABE]]⟪ENDE⟫
Postanschrift: [[ANSCHRIFT]]

Wir bemühen uns, innerhalb von [[FRIST, z. B. „zwei Wochen"]] zu antworten.

> ⚠️ **Der Feedback-Weg muss selbst barrierefrei sein** (§ 12b Abs. 2 Nr. 2
> BGG). Ein reines Kontaktformular genügt nicht; mindestens ein zweiter Weg —
> E-Mail oder Telefon — muss offenstehen. Und die Zusage einer Antwortfrist
> ist nur dann sinnvoll, wenn sie eingehalten wird.

## Durchsetzungsverfahren

Wenn Sie mit unserer Antwort nicht zufrieden sind oder Sie keine Antwort
erhalten haben, können Sie sich an die Schlichtungsstelle wenden:

[[NAME_DER_SCHLICHTUNGSSTELLE]]
[[ANSCHRIFT]]
[[E_MAIL]]
[[TELEFON]]
[[WEBADRESSE]]

> ⚠️ **Hier steht der häufigste Fehler dieser Vorlage.** Die zuständige Stelle
> hängt davon ab, ob der Betreiber eine öffentliche Stelle des **Bundes** oder
> eines **Landes** ist:
> - Bund: die Schlichtungsstelle nach § 16 BGG bei der oder dem Beauftragten
>   der Bundesregierung für die Belange von Menschen mit Behinderungen
> - Land: die Durchsetzungs- bzw. Schlichtungsstelle des jeweiligen Landes —
>   **jedes Land hat eine eigene**
>
> Die falsche Stelle zu nennen, macht die Erklärung wertlos, weil sie den
> Rechtsweg verstellt. Bitte vor der Veröffentlichung mit der Website der
> zuständigen Stelle abgleichen; ich kann den aktuellen Stand der Anschriften
> nicht zusichern.

⟪NUR WENN DER BETREIBER KEINE ÖFFENTLICHE STELLE IST⟫
Für [[NAME_DES_BETREIBERS]] besteht kein gesetzliches Durchsetzungsverfahren
nach dem Behindertengleichstellungsgesetz. Wir nehmen Ihre Rückmeldung
gleichwohl ernst und beantworten sie.
⟪NUR WENN DAS BFSG ANWENDBAR IST⟫
Zuständige Marktüberwachungsbehörde nach dem BFSG:
[[NAME_UND_ANSCHRIFT_DER_MARKTUEBERWACHUNGSBEHOERDE]].
⟪ENDE⟫
⟪ENDE⟫

---

## Was die automatisierte Prüfung nicht abdeckt

> Nicht Teil der Erklärung — Hintergrund für den Betreiber, damit die
> Bewertung oben ehrlich ausfällt.

**Was tatsächlich geprüft wird** (Stand dieser Analyse):

| Prüfung | Umfang | Ort |
|---|---|---|
| `axe-core` gegen `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` | 37 Ansichten plus Überlagerungen und Dialoge | `e2e/a11y/scan.ts`, `e2e/a11y/views.ts` |
| Vollständigkeit der Prüfliste | jede Adresse des Routers **muss** eine Ansicht in der Prüfliste haben, sonst schlägt der Test fehl | `e2e/a11y-view-list.spec.ts` |
| Sprungmarke zum Hauptinhalt | eigener Durchlauf | `e2e/skip-link.spec.ts` |
| Tastaturbedienung | eigener Durchlauf | `e2e/keyboard-flow.spec.ts` |
| Ankündigungen an Hilfstechnologien | eigener Durchlauf | `e2e/announcements.spec.ts` |
| `prefers-reduced-motion` | eigener Durchlauf | `e2e/reduced-motion.spec.ts` |
| Gerenderte Farbkontraste | eigener Durchlauf | `e2e/rendered-contrast.spec.ts` |
| Bedienung auf kleinen Bildschirmen, Zielgrößen | mehrere Durchläufe | `e2e/mobile-*.spec.ts` |

Das ist deutlich mehr, als die meisten Anwendungen vorweisen können. **Und es
reicht trotzdem nicht für „vollständig vereinbar".**

**Was kein automatisiertes Werkzeug prüfen kann:**

- ob ein Alternativtext den Inhalt **sinngemäß** wiedergibt (`alt="Logo"` ist
  formal korrekt und inhaltlich wertlos)
- ob die Lesereihenfolge der **inhaltlichen** Reihenfolge entspricht
- ob eine Fehlermeldung verständlich sagt, **was zu tun ist**
- ob eine Beschriftung ihr Feld tatsächlich beschreibt
- Verständlichkeit, Leichte Sprache, Gebärdensprachvideos (BITV 2.0 § 4)
- ob eine Zeitbegrenzung (`timeLimitMin`) für Menschen ausreicht, die langsamer
  eingeben — WCAG 2.2.1 verlangt eine Verlängerungsmöglichkeit; die Anwendung
  vergibt bei jedem Neuladen zwar neue Zeit, weist aber nicht darauf hin
- **die Formularinhalte selbst**, die die Prüfliste gar nicht kennt

**Empfehlung:** einen manuellen BITV-Test durch eine dafür ausgebildete Stelle
beauftragen, bevor „vollständig vereinbar" behauptet wird — und die
Zeitbegrenzung (WCAG 2.2.1) gesondert bewerten.
