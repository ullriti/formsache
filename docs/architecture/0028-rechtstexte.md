# ADR-0028: Rechtstexte — zwei Herkünfte, sechs Seiten, ein Renderer

- **Status:** accepted
- **Datum:** 2026-08-19
- **Grundlage:** [`docs/legal/README.md`](../legal/README.md) — die
  medienrechtliche Analyse mit den neun Vorlagen. Sie ist maßgeblich; dieser
  ADR hält nur fest, wie sie gebaut wurde.

## Kontext

Formsache ist rechtlich **keine Anwendung mit einem Impressum**, sondern eine
mit **zwei Rechtsschichten übereinander**: der Betrieb bietet einen digitalen
Dienst an und ist dafür Diensteanbieter (§ 5 DDG, § 18 Abs. 1 MStV); die
Organisation erhebt darüber Daten und ist dafür Verantwortliche (Art. 4 Nr. 7,
Art. 13 DSGVO). Teilnehmende sehen beides gleichzeitig auf einer Seite und
können es nicht auseinanderhalten.

Daraus folgt die Kernaussage der Analyse, und sie ist der Grund für fast alles
hier: **die Datenschutzerklärung des Betriebs kann die Informationspflicht
einer Organisation nach Art. 13 DSGVO nicht erfüllen.** Sie kennt weder Zweck
noch Rechtsgrundlage noch Aufbewahrungsfrist eines fremden Formulars.
Umgekehrt kann die Erklärung einer Organisation die Verarbeitungen nicht
abdecken, die der Betrieb für eigene Zwecke vornimmt.

Vor dieser Änderung hatte **keine einzige** öffentliche Ansicht eine Fußzeile.

## Entscheidung

### 1. Zwei Sätze Seiten, zwei Spalten, zwei Wachen

| Seite | Adresse | Gefüllt von | Wo hinterlegt |
|---|---|---|---|
| Impressum | `/imprint` | Betrieb | `system_setting.legal_pages` |
| Datenschutzerklärung | `/privacy` | Betrieb | dieselbe Spalte |
| Erklärung zur Barrierefreiheit | `/barrierefreiheit` | Betrieb | dieselbe Spalte — **gestrichen**, siehe Fortschreibung 2026-08-24 |
| Lizenzen und Urheberrecht | `/licences` | **fest im Code** | — |
| Anbieterangaben | `/o/<kurzname>/imprint` | Organisation | `tenant.legal_pages` |
| Datenschutzhinweise | `/o/<kurzname>/privacy` | Organisation | dieselbe Spalte |

Dazu kam am 2026-08-19 ein **siebter** Text, der keine eigene Seite ist: der
Datenschutzhinweis **eines Formulars** (`form.privacy_notice`). Er steht im
ersten Block der Fußzeile über dem Weg zur Datenschutzseite der Organisation,
hängt am Recht `can_manage_form_settings` und benutzt dieselbe Bauform —
Begründung und Folgen unter „Offene Punkte" Nr. 4.

Zwei Spalten und nicht eine mit einem Unterscheidungsmerkmal: die eine gehört
dem Superadministrator (`SuperadminGuard`), die andere jeder Organisation
(`can_manage_settings`), und beide tragen einen **eigenen** optimistischen
Zähler — dieselbe Bauform wie `mail_revision`, `ai_revision` und
`notification_templates_revision`, aus demselben Grund (`updated_at` wird auf
Millisekunden gekürzt; zwei Schreibvorgänge in derselben Millisekunde
verglichen sich gleich).

**Der Kurzname und nicht der Slug** eines Formulars: ein Slug ist ein
Zugangsmerkmal aus dem CSPRNG, und ein Rechtsdokument unter einer nicht
erratbaren Adresse widerspricht „ständig verfügbar" (§ 18 MStV) und „leicht
zugänglich" (Art. 12 Abs. 1 DSGVO).

### 2. Die Fußzeile: beschriftet, immer, unter jeder öffentlichen Ansicht

```
Verantwortlich für dieses Formular: ⟨Organisation⟩
  · Anbieterangaben  · Datenschutzhinweise
Betrieb dieser Plattform: ⟨Betreiber⟩
  · Impressum  · Datenschutz  · Barrierefreiheit  · Lizenzen
  (Barrierefreiheit gestrichen — Fortschreibung 2026-08-24)
```

**Die Beschriftung ist die Leistung, nicht der Link.** Zwei Impressen ohne
Zuordnung sind schlechter als eines: die teilnehmende Person kann dann nicht
erkennen, an wen sie sich mit einem Auskunftsersuchen wenden muss, und
Art. 13 Abs. 1 lit. a verlangt genau diese Erkennbarkeit.

Die Doppelung ist nicht redundant, sondern der Fall `tenant.public_base_url`:
läuft eine Organisation unter eigener Adresse, ist **sie** dort
Diensteanbieterin. Nur die beschriftete doppelte Anzeige stimmt unter beiden
Adressen.

Sie steht unter Formular, gesperrter Vorstufe, Verfügbarkeitshinweis,
Bestätigungsseite, Bearbeiten-Ansicht und fortgesetztem Entwurf — und als
`<footer>` mit `<nav aria-label="Rechtliche Angaben">`, weil sie Navigation
ist und einen Namen braucht.

### 3. Zwei Wege, und der Zustand steht im Datenmodell

Ein Rechtstext-Dokument ist:

```ts
{ mode: 'template' | 'custom', fills: {…}, conditions: {…}, custom: '' }
```

- **`template`** — die ausgelieferte Vorlage gilt, und ausgefüllt werden ihre
  Platzhalter. Die Oberfläche bietet sie als **Felder** an, nicht als
  Fließtext mit `[[…]]` zum Suchen. Das ist der Regelweg: schnell, der Text
  bleibt der geprüfte, und kein Platzhalter kann übersehen werden.
- **`custom`** — wer eine anwaltlich geprüfte Fassung hat, schreibt sie hin.

**Beide Hälften bleiben immer stehen.** `fills` und `custom` liegen
nebeneinander, unabhängig vom Modus; ein Wechsel hin und zurück verliert
nichts. Die Alternative — beim Umschalten das jeweils andere leeren — wäre
stiller Datenverlust genau in dem Moment, in dem jemand etwas ausprobiert.

Der Modus ist eine **Spalte** und keine Heuristik über den gespeicherten Text.
Eine Heuristik („enthält der Text noch Vorlagensätze?") wäre bei jedem
Teilzitat falsch.

### 4. Drei Zustände, und „unvollständig" ist keiner davon „fertig"

`legalPageStatus` kennt `empty`, `incomplete`, `ready`. **Ein Text mit einem
verbliebenen `[[PLATZHALTER]]` gilt nirgends als fertig** — weder in der Liste
offener Punkte noch auf der öffentlichen Seite. Auf der Seite steht dann ein
Warnhinweis, und jede offene Angabe erscheint als benannte, markierte Lücke
(„Angabe fehlt: Postleitzahl"). Ein `[[…]]` verlässt `renderLegalPage` nie.

Gezählt werden nur Platzhalter aus **aktiven** Blöcken: eine natürliche Person
wird nicht nach ihrem Registergericht gefragt.

### 5. Leere Felder: Link immer, Seite sagt die Wahrheit

Kein fehlender Link (das machte den Mangel unsichtbar) und kein Ersatztext
(das wäre eine Falschangabe). Die leere Seite nennt den Mangel **und** die
Angaben, die die Anwendung wahrheitsgemäß kennt — den Namen der Organisation,
den Weg zum Betrieb als Notausgang für ein Auskunftsersuchen. Bei den
Datenschutzhinweisen einer Organisation kommt der **feste** Teil hinzu: er
beschreibt das Verhalten der Software, ist für jede Organisation gleich und
ist wahr, unabhängig davon, ob jemand etwas eingetragen hat.

### 6. Druck über Assistenten und Hinweise, nie über Pflichtfelder

Konsistent mit ADR-0022 §1 und ADR-0025 §1: *„eine Installation, die man erst
betreiben kann, wenn ein Mailserver eingetragen ist, zwingt zu erfundenen
Werten."* Für einen Rechtstext gilt das doppelt — ein erfundenes Impressum ist
der genau falsche Endzustand. Stattdessen:

1. Ein Schritt in beiden Einrichtungsassistenten, mit `consequence`.
2. Ein Eintrag in beiden Listen offener Punkte, **aus dem tatsächlichen
   Zustand** abgeleitet und nicht aus einem „übersprungen"-Merker.
3. Ein Hinweis im `PublishNotice` — er hält den Dialog an, aber er sperrt das
   Veröffentlichen nicht.

### 7. Der XSS-Kanal: Klartext speichern, Blöcke ausliefern

Ein Rechtstext-Feld ist ein Freitext, den ein Bearbeiter schreibt und der auf
einer von **Fremden** aufgerufenen Seite landet — die Lage aus ADR-0026, nur
ohne dessen Rettungsanker (dort ist der Fremdwert einzeilig).

1. **Gespeichert wird Klartext.** Keine Auszeichnungssprache in der Spalte.
2. **Ausgeliefert werden Blöcke, keine Zeichenketten.** `renderLegalPage`
   erzeugt einen Baum aus `LegalBlock`; die Antwort enthält kein Feld, das
   Markup transportieren könnte, und der Renderer
   (`views/legal/LegalText.tsx`) hat nichts, was er in
   `dangerouslySetInnerHTML` reichen könnte.
3. **Struktur nur aus einer engen Positivliste** (`legal-text.ts`): Absatz,
   Überschrift zweiter und dritter Ordnung, Aufzählung, Tabelle, Betonung,
   Link. Beim Link ausschließlich `http:`, `https:`, `mailto:` und die eigenen
   Pfade dieser Anwendung, **nach dem Parsen** geprüft (`new URL`) — dieselbe
   Bauform wie `safeExternalUrl`. Ein Ziel, das durchfällt, wird sichtbarer
   Text und nie ein Link.
4. Alles außerhalb der Liste ist **Text**, keine Absage: `<script>` wird
   angezeigt, nicht abgewiesen. Das ist die einzige Auslegung, die nicht davon
   abhängt, dass eine Absageliste vollständig ist.
5. Steuerzeichen und unsichtbare Formatzeichen (Bidi-Marken, „Trojan Source")
   fallen schon **an der Spalte** — dieselbe Zwei-Tore-Bauform wie ADR-0026.

**Ein Parser für beide Verbraucher** — die ausgelieferte Vorlage und den
eigenen Text einer Organisation. Zwei wären zwei Positivlisten, und die zweite
wäre die, die abdriftet. Der Preis ist benannt: die Vorlage darf nichts
benutzen, was ein Fremdtext nicht auch dürfte.

### 8. Bedingte Blöcke: eine wird abgeleitet, der Rest wird gefragt

`⟪NUR WENN …⟫` der Vorlagen wird zu `⟪WENN:schluessel⟫`. Die Frage, ob sich
das aus der Konfiguration auflösen lässt, ist **meistens mit nein** zu
beantworten: „nur wenn juristische Person", „nur wenn eingetragen", „nur wenn
öffentliche Stelle" sind Tatsachen über den Betreiber, die keine Einstellung
kennt — sie zu raten wäre eine erfundene Angabe.

**Genau eine wird abgeleitet: die KI.** `SystemLegalService.aiActive()` liest
den tatsächlichen Zustand, und die Ableitung **überschreibt** ein gesetztes
Häkchen. Der Grund läuft in beide Richtungen: wer die KI abschaltet und den
Absatz stehen lässt, beschriebe eine Verarbeitung, die nicht stattfindet; wer
sie einschaltet und das Häkchen vergisst, verschwiege eine
Drittlandübermittlung.

Die Abfrage fasst den Schlüssel nicht an: `ai_api_key` steht in der
**Bedingung**, nie in der Projektion.

### 9. Die Vorlagentexte liegen im Code

`packages/shared/src/legal-templates.ts` trägt den veröffentlichungsfähigen
Rumpf der Vorlagen 01–05. Eine Vorlage, die nur in `docs/` liegt, existiert für
den Betreiber einer Installation nicht — er hat eine Einstellungsseite.
`docs/legal/vorlagen/` bleibt die anwaltliche Fassung mit ihren Begründungen;
was hier liegt, ist die Auslieferung davon. Auf dem Weg normalisiert:

- die Hinweisblöcke an den Ausfüllenden wurden zu `hint` am Feld,
- Platzhalter mit Erläuterung im Namen (`[[GESETZESGRUNDLAGE — z. B. …]]`)
  wurden zu sauberen Schlüsseln plus `hint`,
- gleichnamige Platzhalter mit verschiedener Bedeutung bekamen verschiedene
  Namen,
- was die Anwendung weiß (Adressen der Rechtstextseiten, Name der
  Organisation, Name des Betriebs) wurde zu `APP_`-Platzhaltern, die niemand
  tippt.

Der Name des Betriebs kommt aus dem Platzhalter des Impressums und **nicht**
aus einer zweiten Spalte: ADR-0019 trennt Software und Installation, und eine
zweite Stelle wäre die, die abdriftet.

### 10. `/licences` ist fest im Code — und schließt eine offene Lücke

Dort stehen fremde Urheberrechte. „Ein Betreiber, der einen fremden
Copyright-Vermerk bearbeiten könnte, könnte ihn auch entfernen."

Die Seite importiert `LICENSE` und `apps/web/src/assets/fonts/LICENSE.txt`
über `?raw` — also **byteweise die Datei**, nicht eine abgetippte Kopie. Damit
schließt sie die Lücke aus `docs/legal/README.md` 7.10: die ParaType Free Font
License verlangt, dass ihr Vermerk mit den Schriftdateien geht („it must be
easily viewed by users"), und bis hierher wurde sie von `vite build` nicht
nach `dist/` übernommen, weil kein Modul sie importierte. Jetzt tut eines das.

## Folgen

**Gut:**

- Die Informationspflicht nach Art. 13 DSGVO ist erfüllbar, ohne dass eine
  Organisation Zugriff auf die Systemzeile braucht.
- Ein Mangel ist **sichtbar** statt unsichtbar — an vier Stellen: auf der
  Seite selbst, in beiden Listen offener Punkte und beim Veröffentlichen. Die
  letzte erreicht seit dem 2026-08-19 jeden, der veröffentlichen darf, und
  nicht mehr nur, wer die Einstellungen verwaltet (Offene Punkte Nr. 3).
- Der öffentliche Pfad bleibt so sparsam, wie die Analyse ihn vorgefunden hat:
  eine zusätzliche `GET`-Anfrage für den Namen des Betriebs, kein Cookie,
  keine Drittressource.

**Teuer:**

- Zwei Rechtstext-Dokumente sind zwei Dinge, die veralten können.
- Die Vorlagentexte im Code sind eine **zweite Fassung** derer in `docs/` —
  eine bewusste Doppelung mit einem Grund (siehe 9), und eine, die auseinander
  laufen kann. Wer eine Vorlage in `docs/legal/vorlagen/` ändert, ändert
  `legal-templates.ts` mit.
- Die Rechtstexte behaupten Tatsachen über das Verhalten der Software (keine
  Cookies, 30 Tage Entwurfsfrist, 90 Tage Versandprotokoll). **Wer die
  Software ändert, prüft sie mit.**

**Und ein Nebenbefund, der nicht die Rechtstexte betrifft, sondern die
Messung:** diese Seiten sind die **ersten Ansichten dieser Anwendung mit Links
im Fließtext**. Die beiden Mobil-Sonden in `e2e/mobile/operable.ts` waren auf
Bedienelemente mit eigener Fläche gebaut und meldeten am 2026-08-18 acht
Befunde, von denen keiner ein Mangel war:

| Was gemeldet wurde | Was tatsächlich vorlag |
|---|---|
| sechs Links unter 24 px (WCAG 2.5.8) | die **Inline-Ausnahme** des Kriteriums — ein Link in einem Satz, dessen Höhe die Zeilenhöhe des Satzes ist, ist konform; ihn zu vergrößern risse den Absatz auseinander |
| eine tote Zone an „Lizenzen und Urheberrecht" | der Link **bricht um**; `getBoundingClientRect` liefert die Vereinigung der drei Zeilenkästen, und deren Mitte fiel in die Lücke *zwischen* den Zeilen |
| drei tote Zonen an „veröffentlichte Seite" | der Link steht in einem **geschlossenen `<details>`**; Chromium legt dessen Inhalt aus, ohne ihn darzustellen — `getBoundingClientRect` meldete einen Phantomkasten, `checkVisibility()` sagte `false` |

Alle drei sind in der Sonde behoben und dort mit den gemessenen Zahlen
begründet. Festgehalten wird das hier, weil die Frage „sind diese winzigen
Links ein Konformitätsproblem?" an den Rechtstexten aufkommt und die Antwort
— nein, 2.5.8 nimmt sie ausdrücklich heraus — dorthin gehört, wo sie gestellt
wird.

## Offene Punkte

Ausdrücklich benannt statt stillschweigend gelassen:

1. ~~**`no-store` gilt auch für diese Seiten.**~~ **Entschieden am
   2026-08-18: es bleibt dabei, ohne Ausnahme.** `docs/legal/README.md` 5.6
   schlug vor, sie cachebar auszuliefern — sie tragen nichts
   Personenbezogenes, und „ständig verfügbar" spricht dafür. Dagegen steht,
   was der Riegel ist: er sitzt als **erster** Handler vor dem Body-Parser,
   damit ihn auch eine Antwort trägt, die gar keinen Controller erreicht, und
   begründet sich als „eine pauschale Regel, die gelegentlich zu streng ist,
   schlägt eine Liste, die gelegentlich zu locker ist". Diese Route wäre der
   erste Eintrag einer solchen Liste. Gewonnen wäre ein gesparter Netzabruf
   für ein paar Kilobyte Text; aufgegeben wäre die Eigenschaft, dass **jede**
   Antwort dieser API unbedingt frisch ist.
2. **`THIRD-PARTY-NOTICES` wird nicht erzeugt.** Abschnitt 3 der Lizenzseite
   sagt das ausdrücklich, statt eine Liste zu behaupten. Der Erzeugungsschritt
   im Bau gehört zu ADR-0018 und nicht hierher.
3. ~~**Der Hinweis beim Veröffentlichen erreicht nicht jeden.**~~
   **Geschlossen am 2026-08-19.** Er erreicht ihn jetzt — in **zwei Stufen**,
   mit der Wache dazwischen.

   *Der Befund war:* `GET /tenant/legal` verlangt `can_manage_settings`; eine
   Bearbeiterin mit `can_build` allein sah den Hinweis nicht. Ihn für alle
   sichtbar zu machen bräuchte eine engere Auskunft („sind die Rechtstexte
   vollständig?") mit eigener Wache.

   *Die Bauform stand seit Nr. 4*: dort ist genau eine solche Auskunft für den
   Hinweis **eines Formulars** gebaut (`publishPreviewSchema.privacyNotice`,
   hinter `can_build`, eine Ampel statt des Textes).

   **Die Serverhälfte ist am 2026-08-19 gebaut**, dieselbe Bauform auf die
   beiden Seiten der Organisation angewandt:
   `publishPreviewSchema.organisationLegal` trägt **eine** Ampel über
   `TENANT_LEGAL_PAGES` — schlechtester Zustand gewinnt —, berechnet in
   `FormsService.publishPreview` aus `scope.tenant.legal()`, also aus den
   Rechtstexten der Organisation *dieses* Formulars. Belegt in
   `apps/api/test/legal/organisation-legal-publish-hint.spec.ts`.

   **Die Anzeige ist am 2026-08-19 nachgezogen**, und sie ist der Punkt, an
   dem die beiden Stufen zusammenspielen:

   - **Stufe 1 — *dass* etwas fehlt.** `PublishNotice` liest
     `preview.organisationLegal`. Die Vorschau steht hinter `can_build`, also
     hinter dem Recht, das veröffentlicht; der Abschnitt erscheint deshalb für
     **jede** Person, die den Knopf drücken kann, und `needsPublishNotice`
     hält den Dialog daran an. Genannt wird keine Seite — das Feld trägt
     bewusst keine.
   - **Stufe 2 — *was* fehlt.** `useOpenLegalPageNames`
     (`views/builder/use-open-legal-page-names.ts`) fragt zuerst die
     Berechtigung und stellt `GET /tenant/legal` nur, wenn
     `can_manage_settings` vorliegt. Steht die Antwort, wächst dem Abschnitt
     ein „Betroffen: …" mit den Seitennamen und der Weg dorthin zu; fehlt die
     Berechtigung, bleibt die Liste leer und der Satz nennt stattdessen, wer
     es beheben kann. Kein 403 je Builder-Aufruf für ein Dokument, das diese
     Person ohnehin nicht ändern dürfte.

   Damit steht die Wache dort, wo sie hingehört — vor dem **Dokument**, nicht
   vor der Auskunft, dass es unfertig ist.

   ⚠️ Die Formulierung des Abschnitts meidet das Wort „Datenschutzhinweise"
   als allgemeinen Begriff: es ist der Titel einer der beiden Seiten, und ohne
   „Betroffen:" davor läse Stufe 1 sich sonst als die Antwort, die sie nicht
   gibt.

   **`useLegalPublishHint` ist ersetzt, nicht ergänzt.** Zwei Urteile über
   dieselbe Frage nebeneinander wären der falsche Endzustand: die Vorschau ist
   die, die jeden erreicht, der veröffentlicht. Der Hook ist entfallen; was
   von ihm bleibt, ist die zweite Stufe unter neuem Namen.

   **Die Faltung steht seither einmal.** „Schlechtester Zustand über
   `TENANT_LEGAL_PAGES`" stand in drei Fassungen nebeneinander — im Server, in
   der Liste offener Punkte einer Organisation und im Hook. Sie liegt jetzt in
   `packages/shared/src/legal.ts` neben `legalPageStatus`, als zwei
   Funktionen: `tenantLegalStatus` (eine Ampel, für die Vorschau) und
   `openTenantLegalPages` (die Seiten, für die beiden Stellen hinter
   `can_manage_settings`). Zwei und nicht eine, obwohl sie sich über jede
   Eingabe einig sind: der Aufrufer, der nur *dass* erfahren darf, soll an
   seiner Aufrufstelle keine Seitenliste in Reichweite haben.

   Belegt in `apps/web/src/views/BuilderView.test.tsx` („the hint about this
   organisation's legal texts"): ohne `can_manage_settings` steht der Hinweis
   und nennt keine Seite, mit ihm stehen die Namen da, bei `'ready'` steht
   nichts.

   ⚠️ **Wer sie übernimmt, übernehme die richtige Begründung** (Review-Befund
   vom 2026-08-18). Hier stand „eine Ampel und **nie der Text**", was nach
   Geheimhaltung klingt. Die gibt es nicht: der Hinweis eines Formulars steht
   bestimmungsgemäß auf der öffentlichen Ausfüllseite, und wer `can_build`
   hält, kennt über `GET /api/forms/:id` ohnehin den `publicSlug`. Die Ampel
   ist **Sparsamkeit der Antwort**, nicht ein Riegel davor. Für die
   Rechtstexte einer Organisation liegt es anders — sie stehen zwar ebenfalls
   öffentlich, aber der Weg dorthin führt nicht über ein Formular, und dort
   wäre die Frage nach dem Schutz eine echte. Genau deshalb darf die
   Begründung nicht mitwandern.

   **Sie ist nicht mitgewandert.** Der Kommentar an `organisationLegal` benennt
   den Unterschied: was `can_manage_settings` schützt, ist nicht die
   veröffentlichte Seite, sondern das **Dokument** dahinter — `fills` und
   `custom` stehen nebeneinander und bleiben stehen (§3), die Route gibt also
   gerade die Hälfte heraus, die *nicht* veröffentlicht ist. Die Ampel steht
   hinter `can_build`, der niedrigeren Wache, und darf deshalb nicht der Weg
   daran vorbei werden: **nie der Text, nie ein Feldname, nie welche Seite.**
   Daher auch die Zusammenfassung über beide Seiten statt zweier Ampeln — zwei
   sagten bereits, welche der beiden fehlt.
4. ~~**Kein formularspezifischer Datenschutzhinweis.**~~ **Entschieden und
   gebaut am 2026-08-19: Feld plus Hinweis beim Veröffentlichen.**

   `docs/legal/README.md` 5.2 hat es empfohlen, und der Grund trägt: Zweck und
   Rechtsgrundlage sind nach Art. 13 Abs. 1 lit. c **je Verarbeitung**
   anzugeben, und ein Formular *ist* eine Verarbeitung. Eine Sterbefallmeldung
   und eine Tagungsanmeldung derselben Organisation haben verschiedene; ein
   einziger Organisationstext, der beides abdecken soll, wird entweder
   unrichtig oder unlesbar.

   **Ein Feld, keine zweite Bauform.** `form.privacy_notice` trägt dasselbe
   `legalDocumentSchema` wie `tenant.legal_pages` — `mode: 'template' |
   'custom'`, `fills`, `conditions`, `custom` —, benutzt dieselbe Vorlage-
   Sprache (`[[PLATZHALTER]]`, `⟪WENN:…⟫`), denselben Renderer
   (`renderLegalPage`), dieselbe Positivliste (`safeLegalHref`,
   `parseLegalText`) und dieselbe Ampel (`legalPageStatus`). Die Vorlage steht
   als `FORM_PRIVACY_TEMPLATE` neben den fünf anderen in `legal-templates.ts`
   und läuft durch denselben `templateDefects`-Wächter. **Ein zweites
   Textmodell hätte eine zweite Positivliste bedeutet, und die zweite ist
   immer die, die abdriftet.**

   **Das Recht ist `can_manage_form_settings`** und nicht `can_build`
   (ADR-0021 hat die beiden bewusst getrennt): die Auskunft nach Art. 13 ist
   eine Entscheidung *über* das Formular, keine über seinen Aufbau. Belegt in
   `apps/api/test/settings/form-privacy-notice.spec.ts` über den Fall, der
   scheitern muss — die abgewiesene Bearbeiterin hält `can_build` **und jedes
   andere Recht**, nur dieses eine nicht.

   **Öffentlich steht er im ersten Block der Fußzeile**, unmittelbar über der
   Beschriftung „Verantwortlich für dieses Formular" und dem Link auf die
   allgemeinen Datenschutzhinweise der Organisation — vom Besonderen zum
   Allgemeinen. Drei Gründe, und der dritte ist der ausschlaggebende:

   - Die Fußzeile steht schon unter allen sechs öffentlichen Ansichten (§2);
     der Hinweis erreicht damit fünf davon mit **einer** Änderung — Formular,
     Bestätigungsseite, Verfügbarkeitshinweis, Bearbeiten-Ansicht und
     fortgesetzter Entwurf. Die sechste, die gesperrte Vorstufe, bleibt
     bewusst außen vor (siehe unten).
   - `FillIn` rendert Formular und Bestätigungsseite in denselben Rahmen; ein
     Block über den Fragen verschwände beim Absenden. „Er erscheint nicht auf
     der Bestätigungsseite" war einer der Mängel, an denen der `info`-Behelf
     scheitert.
   - **Keine zweite Adresse.** Ein Formular ist nur über seinen Slug
     erreichbar, und ein Rechtsdokument unter einer nicht erratbaren Adresse
     widerspricht „ständig verfügbar" (§1). Die dauerhafte Adresse bleibt
     `/o/<kurzname>/privacy`; der formularspezifische Zusatz reist auf der
     Ausfüll-Nutzlast und steht dort, wo erhoben wird.

   **Auf der gesperrten Vorstufe steht er nicht.** Vor dem Zugangswort wird
   nichts erhoben, und die gesperrte Nutzlast trägt Titel und Organisation und
   sonst nichts (`lockedPublicFormSchema`). Ihn dort auszuliefern hieße, den
   erklärten Zweck eines geschützten Formulars an jeden herauszugeben, der die
   Adresse hat.

   **Der Druck ist ein Hinweis beim Veröffentlichen — und ausdrücklich kein
   dauerhafter offener Punkt.** Das ist die eine Stelle, an der diese
   Entscheidung von §6 Nr. 2 abweicht, und sie ist begründet: eine
   Organisation, deren allgemeine Erklärung Zweck und Rechtsgrundlage ihrer
   Formulare bereits nennt, hat **nichts zu beheben** — ein Dashboard-Eintrag
   zeigte ihr auf Dauer eine Fehlmeldung. ADR-0022 Nr. 5 sagt, was daraus
   folgt: *„eine Zeile, die überall steht, wird überall überlesen."* Der Ort,
   an dem die Frage etwas ändern kann, ist der Moment vor der Veröffentlichung,
   und nur dort steht sie.

   **Und dieser Hinweis erreicht, anders als der aus Nr. 3, jeden, der
   veröffentlicht.** Er hängt nicht am Einstellungsdokument (das verlangt
   `can_manage_form_settings`), sondern an `GET /forms/:id/publish-preview` —
   die Route steht hinter `can_build`, also hinter dem Recht, das
   veröffentlicht. Sie gibt dabei **eine Ampel** heraus (`empty` ·
   `incomplete` · `ready`) und nie den Text: genau die engere Auskunft, die
   Nr. 3 für die Rechtstexte der Organisation als offenen Punkt beschreibt,
   hier für den Hinweis, der zu *diesem* Formular gehört.

   **Bestandsformulare bekommen nichts zurückgefüllt.** Die Migration
   `20260819120000_form_privacy_notice` fügt eine `NULL`-Spalte hinzu, und
   `NULL` heißt „nichts hinterlegt": ein bestehendes Formular verhält sich
   öffentlich exakt wie vorher. Etwas zurückzufüllen hieße, für jedes
   bestehende Formular einen Zweck und eine Rechtsgrundlage zu erfinden, die
   niemand angegeben hat — die Falschangabe, gegen die §5 dieses ADR
   entschieden hat.

   **Leer heißt öffentlich: nichts.** Anders als bei den Seiten einer
   Organisation (§5) wird der Mangel hier *nicht* auf der öffentlichen Seite
   ausgesprochen. Der Unterschied hat einen Grund: dort ist die Seite die
   geschuldete Auskunft und ihr Fehlen ein Verstoß; hier ist der Text ein
   **Zusatz** zu den allgemeinen Hinweisen, die einen Link weiter stehen und
   für dieses Formular genügen können. Ein „hier fehlt etwas" wäre eine
   Behauptung über einen Mangel, den die Anwendung nicht feststellen kann.

   **Beim Duplizieren reist er mit**, anders als das Zugangswort: wer ein
   Formular dupliziert, wiederholt in aller Regel dieselbe Verarbeitung
   („Anmeldung 2026" → „Anmeldung 2027"), und ihn wegzuwerfen wäre stiller
   Verlust einer Pflichtangabe. **In die Vorlagenschublade wandert er
   nicht**: eine Vorlage ist ein Baustein für verschiedene Zwecke, und ein
   mitgereister Zweck wäre dort irgendwann sicher falsch. Der Preis der ersten
   Hälfte ist benannt: eine mitkopierte Angabe kann veralten, und der Hinweis
   vor dem Veröffentlichen hält nur an, wenn **nichts** dasteht — nicht, wenn
   etwas Überholtes dasteht. **Beide Hälften sind seit dem 2026-08-19 belegt**
   (`apps/api/test/settings/form-privacy-notice.spec.ts`, „Duplizieren und
   Vorlagenschublade"): genau weil die eine Entscheidung einen benannten Preis
   hat, darf die nächste Änderung an `duplicate()` sie nicht unbemerkt
   umdrehen.

   **Der `info`-Fragetyp bleibt, was er war**: ein Infotext im Formularfluss,
   den `can_build` setzt. Er ist kein Teil dieser Änderung und schließt diesen
   Punkt weiterhin nicht.

5. ~~**Die Weiterleitung nach dem Absenden ist eine Frage an die
   Organisation**~~ **Geschlossen am 2026-08-20 — eine Ebene tiefer, als der
   Punkt gestellt war.**

   *Der Einwand war:* die Anwendung könne zwar zählen, ob *irgendein* Formular
   weiterleitet, aber nicht sagen, **wohin** — und der Vorlagensatz nennt die
   Zieladresse.

   **Er trägt, aber nur für die Rechtstexte der Organisation.** Dort stehen
   mehrere Formulare mit mehreren Zielen hinter einem Text, und keine Adresse
   ist *die* Adresse. Beim Datenschutzhinweis **eines Formulars** ist genau das
   nicht so: die Zieladresse ist eine Einstellung dieses einen Formulars
   (`redirectEnabled` / `redirectUrl`, `packages/shared/src/form-settings.ts`),
   sie ist eindeutig, und die Anwendung kennt sie ohne zu fragen. Der Satz
   gehört dorthin — und nur dorthin.

   **Gebaut aus den zwei Mechanismen, die es dafür schon gab**, und nicht aus
   einem dritten:

   - **Die abgeleitete Bedingung.** `LegalCondition.auto` kannte `'ai'` und
     `'ai-off'`; sie kennt jetzt `'redirect'`. `activeConditions()` beantwortet
     `⟪WENN:weiterleitung⟫` aus dem Kontext, so wie es den KI-Absatz aus der
     Konfiguration der Installation beantwortet. Der Abschnitt steht damit
     **genau dann**, wenn eine Weiterleitung eingerichtet ist.
   - **Der abgeleitete Wert.** `appFacts()` setzt `APP_NAME_DER_ORGANISATION`
     und die Adressen der Rechtstextseiten; es setzt jetzt auch
     `APP_ZIELADRESSE_DER_WEITERLEITUNG`. Ein `APP_`-Platzhalter ist kein Feld
     (`isAppSlot`), erscheint also in keiner Feldliste und in keiner Lückenliste.

   Beide lesen **eine** Quelle, `LegalRenderContext.redirectTarget`, und beide
   über dieselbe Hilfsfunktion: ein Abschnitt, der eine Weiterleitung ankündigt
   und darunter eine Lücke zeigt, wo die Adresse stehen müsste, ist der eine
   Zustand, den diese Bauform nicht erreichen können darf.

   **Der Satz steht im `fixed`-Teil der Vorlage `FORM_PRIVACY`**, die bis dahin
   keinen hatte. Zwei Gründe, und beide sind dieselben, aus denen Vorlage 04
   ihren hat: er beschreibt Verhalten, das die Organisation nicht schreibt (wer
   ihn ändern könnte, könnte etwas Unrichtiges über eine Weiterleitung
   behaupten) — und er steht damit auch neben einem **eigenen** Text
   (`mode: 'custom'`), nicht nur neben der ausgefüllten Vorlage.

   ⚠️ **Die Ampel bleibt unberührt, und das ist geprüft.**
   `legalPageStatus` löst `template.body` auf und nie `fixed`, und ein
   `APP_`-Platzhalter zählt ohnehin in keiner Richtung als offene Angabe. Ein
   Formular ohne Weiterleitung wird also nicht `incomplete`, weil ihm eine
   Adresse fehlt, nach der es niemand gefragt hat — und eines mit Weiterleitung
   auch nicht. Belegt in `packages/shared/src/legal.test.ts` („der abgeleitete
   Abschnitt zur Weiterleitung"), mit der Gegenprobe je Zusage; dass die
   Einstellungen dieses Formulars am öffentlichen Weg wirklich bis in den Text
   durchreichen, steht als Integrationstest in
   `apps/api/test/settings/form-privacy-notice.spec.ts` — samt der Ampel, die
   sich mit und ohne Weiterleitung nicht rührt.

   ⚠️ **Der benannte Preis: ein Formular ohne eigenen Datenschutzhinweis sagt
   weiterhin nichts.** „Leer heißt öffentlich: nichts" (Nr. 4) gilt weiter, und
   der feste Teil weckt einen leeren Hinweis nicht auf — ein einzelner
   Abschnitt ohne den Hinweis darum herum wäre ein Rechtstext, den niemand
   geschrieben hat, unter einer Überschrift, die eine vollständige Auskunft
   verspricht. Für genau diesen Fall bleibt der allgemeine Abschnitt in den
   Hinweisen der Organisation stehen; er ist dort der einzige Ort, an dem die
   Übermittlung dann noch genannt wird. Auch das ist mit einem Test
   festgehalten, damit die nächste Hand es absichtlich umdreht und nicht
   nebenbei.

   **Die Zieladresse geht durch dieselben Schranken wie jeder andere Wert.**
   Drei stehen hintereinander, und die dritte ist die, die dieser Punkt neu
   hinzufügt: `externalUrlSchema` weist beim Speichern **und** beim Lesen der
   Spalte alles ab, was nicht `http`/`https` ist; `effectiveRedirect()` weist es
   beim Herausgeben erneut ab (und ist die einzige Quelle, aus der die beiden
   Aufrufstellen ihren Wert nehmen — nie `settings.redirectUrl`, das in einem
   ungespeicherten Entwurf alles Mögliche tragen kann); und im Rechtstext
   entscheidet `safeLegalHref` wie bei jedem anderen Ziel: ein `javascript:`
   wird **sichtbarer, toter Text** und nie ein Link.

   **In Vorlage 04 ist der Platzhalter entfallen, der Abschnitt nicht.**
   `[[ZIELADRESSE_DER_WEITERLEITUNG]]` war ein Feld, dessen Antwort die
   Anwendung kennt und das auf dieser Ebene niemand richtig ausfüllen kann.
   Der Abschnitt bleibt — ohne Adresse, mit dem Verweis auf den Hinweis des
   jeweiligen Formulars —, weil er der einzige Ort ist, an dem ein Formular
   **ohne** eigenen Datenschutzhinweis die Übermittlung überhaupt noch nennt.
   Seine Bedingung bleibt deshalb eine Frage an einen Menschen: „leitet
   *irgendeines* meiner Formulare weiter?" ist genau die Frage, für die der
   ursprüngliche Einwand gilt.

   **Keine Migration.** Die Zieladresse steht längst in der Datenbank, und
   `fills` ist eine offene Abbildung: ein gespeicherter Wert unter dem
   entfallenen Schlüssel wird schlicht nicht mehr gelesen. Was sich für eine
   Organisation ändert, ist ein Feld weniger im Editor.

   **Und die Rechnung aus Nr. 7 bleibt stehen:** dazugekommen ist eine
   *abgeleitete* Bedingung, die die Oberfläche nie schreibt
   (`editableConditions` lässt sie aus), und kein Platzhalter — die größte
   Nutzlast von `PUT /api/forms/:id/settings` wächst dadurch nicht.
6. **Kein Cookie-Banner, kein Einwilligungshäkchen** — beide ausdrücklich
   abgelehnt (`docs/legal/README.md` 5.7, 4.1), und beide bleiben es: sie sind
   keine Frage der Sprache, sondern eine der Verarbeitung.

   **Der Sprachumschalter ist am 2026-08-20 aus dieser Liste heraus- und nach
   [#59](https://github.com/ullriti/formsache/issues/59)
   gewandert.** Er stand hier als Ablehnung, war aber nie eine eigene
   Entscheidung: Er folgte daraus, dass die Oberfläche einsprachig deutsch ist.
   Sobald es Sprachdateien gibt, fällt diese Voraussetzung weg, und die Frage
   stellt sich neu — dann aber für die ganze Anwendung und nicht für die
   Rechtstexte allein. Der Einwand, der hier stand, bleibt gültig und ist
   dorthin mitgenommen: **zweisprachige Rechtstexte, die auseinanderlaufen,
   sind ein bekanntes Haftungsmuster** — eine übersetzte Vorlage ist keine
   Übersetzung, sondern eine neue Rechtsprüfung.
7. ~~**Die Summe eines Schreibvorgangs ist nicht gegen den Body-Limiter
   begrenzt.**~~ **Entschieden und gebaut am 2026-08-20: eine eigene Grenze
   für genau diese beiden Routen.**

   *Der Befund war:* ein `PUT` trägt das ganze Dokument; wer jedes Feld bis an
   `LEGAL_FILL_MAX` füllt *und* jeden eigenen Text ausschöpft, kommt
   rechnerisch über die 100 KiB aus `app-setup.ts` und bekommt eine 413 statt
   einer Meldung, die etwas erklärt — der Body-Limiter sitzt vor jedem
   Controller, seine Antwort trägt also keinen Feldpfad. Von den drei
   möglichen Antworten sind zwei ausdrücklich **nicht** gewählt: kleinere
   Felder (sie sind an anderer Stelle begründet, und ein „mehr als acht Seiten
   darf Ihre anwaltlich geprüfte Fassung nicht haben" wäre die falsche
   Belehrung) und seitenweises Speichern (das gäbe die Ganz-oder-gar-nicht-
   Schreibung mit ihrem optimistischen Zähler auf, um eine Zahl zu retten).

   **Die Rechnung, und zwar aus den Vorlagen gezählt** — nicht geschätzt.
   Bestandteile sind je Seite `custom` an `LEGAL_TEXT_MAX` (20 000), je
   Platzhalter der Vorlage `LEGAL_FILL_MAX` (2 000), dazu `mode`,
   `conditions` und der JSON-Rahmen:

   | Route | Seiten | Platzhalter | Bedingungen | Zeichenbudget |
   |---|---|---|---|---|
   | `PUT /api/tenant/legal` | 2 (`imprint` 11 + `privacy` 13) | 24 | 10 | 24 × 2 000 + 2 × 20 000 = **88 000** |
   | `PUT /api/admin/system-settings/legal` | 3 (22 + 31 + 21) | 74 | 21 | 74 × 2 000 + 3 × 20 000 = **208 000** |

   Das Budget zählt **UTF-16-Einheiten** (das ist es, was `z.string().max()`
   zählt), der Limiter zählt **Bytes** — dieselbe Lücke wie bei der
   Nachbarroute unten. Teuerstes Zeichen ist deshalb das **dreibytige, das
   eine Einheit belegt** (CJK, Gedankenstrich, typografische
   Anführungszeichen); das Emoji ist mit vier Bytes auf zwei Einheiten
   billiger. Ungünstigster Fall, gemessen an einer voll gefüllten Nutzlast:

   | Route | Rechnung | größte gültige Nutzlast | neue Grenze |
   |---|---|---|---|
   | `/tenant/legal` | 88 000 × 3 + 869 Rahmen | **264 869 B** (258,7 KiB) | **320 KiB** |
   | `/admin/system-settings/legal` | 208 000 × 3 + 2 554 Rahmen | **626 554 B** (611,9 KiB) | **768 KiB** |

   Der Rahmen sind Klammern, Schlüsselnamen, `mode` — und `lock` in seiner
   breitesten Form: `z.number().int().positive()` reicht bis sechzehn Stellen.
   Wer mit `lock: 1` nachrechnet, kommt auf fünfzehn Bytes weniger; die
   Tabelle nimmt bewusst den ungünstigeren Fall.

   Die Luft ist ebenfalls gerechnet: ein weiterer Platzhalter in einer Vorlage
   kostet 2 000 Einheiten, also rund 6 KiB — die Organisation trägt zehn
   weitere, die Installation sechsundzwanzig. Eine ganze weitere **Seite**
   passt nicht hinein, und das soll sie auch nicht: `legal-body-limit.spec.ts`
   rechnet beide Fälle aus den Vorlagen nach und wird rot, statt die Zahl
   still veralten zu lassen. (Die Zählung ist der Stand vom 2026-08-20; sie
   wandert mit den Vorlagen, der Test wandert mit.)

   **Zwei Zahlen und nicht eine**, obwohl eine einfacher wäre: die
   Organisationsroute steht jeder Person mit `can_manage_settings` offen, die
   Installationsroute nur dem Superadministrator. Der größeren Gruppe die
   dreifache Nutzlast zu geben, weil die kleinere sie braucht, wäre die
   Bequemlichkeit an der falschen Stelle bezahlt.

   **Wo die Zahl steht:** `apps/api/src/app-setup.ts`, neben
   `JSON_BODY_LIMIT_BYTES` und mit der Rechnung als Kommentar daneben —
   `TENANT_LEGAL_BODY_LIMIT_BYTES`, `SYSTEM_LEGAL_BODY_LIMIT_BYTES` und
   `LEGAL_WRITE_BODY_LIMITS`, die beide an ihren Pfad bindet. Umgesetzt als
   **zwei zusätzliche JSON-Parser vor dem allgemeinen**, jeder mit einem
   `type`-Prädikat statt eines montierten Pfades: `app.use('/pfad', …)`
   griffe nach Präfix und gäbe den großen Körper auch an alles, was unter
   diesen Adressen einmal wächst. Das Prädikat verlangt `PUT`, genau diesen
   Pfad **und** `application/json` — die letzte Hälfte ist keine Zierde: ein
   Parser, der `text/plain` läse, machte diese beiden Routen für ein
   HTML-Formular erreichbar und risse das Loch wieder auf, das
   `APP_OPTIONS.bodyParser` schließt. Die 100 KiB bleiben für jede andere
   Route stehen; das ist der Kern und nicht die Zahl.

   **Die dritte Route mit einem Rechtstext bleibt bei 100 KiB.**
   `PUT /api/forms/:id/settings` trägt den formularspezifischen
   Datenschutzhinweis — dasselbe `legalDocumentSchema` — und kommt in denselben
   breiten Zeichen ebenfalls über die allgemeine Grenze (die Tabelle dazu steht
   gleich unten). Dort wurde am 2026-08-19 **die Meldung** gebaut und nicht das
   Limit; das hier nebenbei umzudrehen wäre genau die Sorte Entscheidung, die
   dieser Punkt nicht noch einmal still treffen soll.

   **Belegt in `apps/api/test/legal/legal-body-limit.spec.ts`** in beide
   Richtungen und für beide Routen: die größte gültige Nutzlast wird
   angenommen und steht danach in voller Länge in der Spalte; eine Nutzlast
   über der **neuen** Grenze bleibt 413 (die Grenze ist verschoben, nicht
   weg); ein `text/plain`-Körper wird auch hier nicht gelesen; ein `POST`
   derselben Größe bleibt bei 100 KiB; und eine andere Route bekommt bei
   derselben Größe weiterhin 413. Der Fall, um den es ging, ist der fünfte:
   **ein einzelnes Feld** ein Zeichen über seiner Grenze, in einer Nutzlast
   innerhalb des neuen Fensters — das ist jetzt die 400 mit
   `pages.privacy.fills.STAND` statt einer 413 ohne Feldnamen.

   **Welche Schreibweise der Adresse gemeint ist, ist gemessen und nicht
   angenommen** (Review-Befund vom 2026-08-20): abschließender Schrägstrich,
   Großschreibung und Abfrageteil erreichen den Controller — also erkennt sie
   der Parser auch. **Zwei** Schrägstriche erreichen ihn nicht (404), also
   erkennt er sie nicht: eine Normalisierung mit `/\/+$/` läse eine
   Viertelmegabyte für eine Adresse, die es nicht gibt. Alle vier stehen als
   Fälle im Test.

   ⚠️ **Der Parser läuft vor jeder Wache** — auch vor `SuperadminGuard` und
   dem Throttler. Ein Aufrufer ohne Sitzung kann den Server also dazu bringen,
   768 KiB zu lesen, bevor die 401 fällt; vorher waren es 100 KiB. Benannt
   statt übergangen: die öffentlichen Routen, die jeder aufrufen *soll*,
   behalten alle die 100 KiB, und die eine Adresse, die schon heute ohne
   Sitzung Megabyte liest, ist der öffentliche Upload mit eigener Grenze und
   eigener Positivliste. Zwei bekannte Pfade auf 768 KiB verschieben diese
   Decke nicht.

   ⚠️ **Zwei Dinge deckt die Grenze bewusst nicht ab.** `fills` ist eine
   offene Abbildung (`legal.ts` sagt, warum), ein Aufrufer darf also
   Schlüssel erfinden, die keine Vorlage kennt — die Schranke dagegen *ist*
   diese Grenze und sonst nichts. Und wer jedes Zeichen als `\uXXXX`
   maskiert, zahlt sechs Bytes je Einheit statt drei. Beides sind Nutzlasten,
   die die Oberfläche nicht erzeugen kann; sie danach zu bemessen hieße, für
   zwei Routen einen Parser im Megabyte-Bereich mitzuführen. Sie bekommen
   413, und das ist die richtige Antwort auf sie.

   **Für `PUT /api/forms/:id/settings` war „erreichbar" zu scharf formuliert,
   und hier stehen die Zahlen** (Review-Befund vom 2026-08-19), damit die
   nächste Person nicht wieder rechnet. Größte Nutzlast dieser Route mit allen
   Feldern an ihrer Grenze — die sechs Platzhalter und die drei *schreibbaren*
   Bedingungen von `FORM_PRIVACY_TEMPLATE`, `custom` an `LEGAL_TEXT_MAX`, dazu
   die Einstellungswerte:

   > Die Vorlage führt seit Nr. 5 **vier** Bedingungen; `weiterleitung` trägt
   > `auto: 'redirect'` und wird deshalb von `editableConditions` gar nicht
   > erst angeboten — die Anwendung beantwortet sie, kein Aufrufer schreibt
   > sie. In der Nutzlast stehen weiterhin drei, die Tabelle darunter bleibt
   > also gültig. Wer hier nachzählt, zählt `editableConditions`, nicht
   > `template.conditions`.

   | Textinhalt | Bytes | gegen 102 400 |
   |---|---|---|
   | ASCII | 36 956 | ok |
   | durchgehend `ä` (2 B) | 71 156 | ok |
   | durchgehend dreibytig (CJK, `—`) | 105 356 | **413** |
   | Emoji (4 B / 2 UTF-16-Einheiten) | 71 156 | ok |

   **`LEGAL_TEXT_MAX` zählt UTF-16-Einheiten, der Limiter zählt Bytes — das
   ist die ganze Lücke.** Deshalb steht das Emoji auf der sicheren Seite und
   nicht, wie man erwartet, auf der schlimmsten: vier Bytes verteilen sich auf
   zwei Einheiten, also kostet es zwei Bytes je Einheit wie das `ä`. Teuer ist
   allein das dreibytige Zeichen, das **eine** Einheit belegt — ein Text
   durchgehend in CJK, oder einer, der Gedankenstriche und typografische
   Anführungszeichen dicht setzt. Nachgerechnet mit anders gewählten
   Einstellungswerten (alle vier Textfelder ebenfalls im breiten Zeichen)
   ergaben sich 37 157 / 73 547 / 109 937 / 73 547 — dieselben vier Urteile;
   die Zeile mit dem dreibytigen Zeichen ist die einzige, die kippt, und sie
   kippt in beiden Rechnungen.

   Was daraus **gebaut** wurde, ist nicht das Limit, sondern die Meldung:
   `actionErrorMessage` (`apps/web/src/views/api-messages.ts`) hat seit
   demselben Befund einen 413-Zweig, der zum Kürzen rät statt zum zweiten
   Versuch — der Body-Limiter sitzt vor jedem Controller, seine Antwort trägt
   also keinen Satz der Anwendung. Dazu steht die Feldgrenze jetzt am Feld
   (`maxLength`), sodass der ehrliche Weg in diese 413 gar nicht mehr über
   „Speichern" führt.
8. ~~**Die Rechtstexte einer Organisation stehen nicht im Papierkorb-Weg.**~~
   **Entschieden und gebaut am 2026-08-18: sie bleiben in der Löschfrist
   erreichbar.**

   Bis dahin antwortete die Rechtstextseite einer gelöschten Organisation 404
   — auch für jemanden, der gerade noch ein Formular ausgefüllt hatte. Genau
   der braucht die Auskunft aber **dann**, wenn die Organisation nicht mehr
   arbeitet: wer verantwortlich war (§ 5 TMG) und wie er seine Rechte ausübt
   (Art. 15 ff. DSGVO). `TENANT_LEGAL_PAGES` sind genau diese beiden,
   `imprint` und `privacy`; eine dritte, die versehentlich mit offenstünde,
   gibt es nicht.

   **Der Ausfüllpfad bleibt zu**, und das ist kein Widerspruch: dort geht es
   darum, neue Daten *entgegenzunehmen*, hier darum, über bereits
   entgegengenommene Auskunft zu geben.

   **Die Frist steht nirgends ein zweites Mal.** Der Abruf fragt nur noch nach
   dem Kurznamen; der 30-Tage-Lauf löscht die `tenant`-Zeile physisch, und
   danach findet er nichts mehr. Die Lebensdauer der Zeile *ist* die Frist —
   eine eigene Datumsrechnung wäre die zweite Wahrheit, die irgendwann von der
   ersten abweicht. Belegt in `apps/api/test/legal/legal-pages.spec.ts` in
   **beide** Richtungen: weich gelöscht → 200 mit dem hinterlegten Text,
   Zeile fort → 404.

9. ~~**Die Rechtstexte von Organisation und Installation markieren kein
   Feld.**~~ **Entschieden und gebaut am 2026-08-19: der Aufrufer kürzt sein
   eigenes Präfix, `ISSUE_PREFIXES` bleibt eine feste Liste.**

   Nr. 4 hatte `LegalPageEditor` beigebracht, einen Serverbefund an dem Feld zu
   zeigen, das ihn ausgelöst hat — aber nur der Formularhinweis reichte ihn
   herein. Jetzt reichen ihn `TenantLegalTab` und `SystemLegalTab` ebenso durch,
   und mit ihnen die beiden Einrichtungsschritte, die durch denselben Haken
   speichern.

   **Kein Mangel, eine Unstimmigkeit** war es deshalb, weil die Längengrenze
   (`maxLength`) an allen sechs Seiten wirkte — sie sitzt in derselben
   Komponente; was fehlte, war allein das Hervorheben nach einem abgewiesenen
   Schreibvorgang.

   **Die kleine Entscheidung ist gegen das Muster gefallen**, und der Grund ist
   kein Geschmack: auf diesen beiden Ansichten stehen **mehrere** Dokumente
   gleichzeitig — zwei bei der Organisation, drei bei der Installation, alle in
   einer Nutzlast und einem `PUT`. Ein Muster `pages.*.` in `ISSUE_PREFIXES`
   striche genau den Teil weg, der sagt, welches gemeint war:
   `pages.imprint.custom` und `pages.privacy.custom` kämen beide als `custom`
   an, und ein Befund zum Impressum stünde auch an der Datenschutzerklärung —
   an einer Karte, die niemand angefasst hat. `values.` und `privacyNotice.`
   dürfen pauschal fallen, weil jedes davon **ein** Teildokument benennt, von
   dem genau eines auf dem Schirm steht. Gekürzt wird stattdessen in der Karte
   (`issuesUnder`, `views/api-messages.ts`), und das Wegwerfen des Fremden ist
   dabei so viel wert wie das Kürzen.

   **Eine siebte Seite kostet so nichts:** das Präfix entsteht in derselben
   `.map()`, die die Karte rendert, aus dem Schlüssel der Seite
   (`TENANT_LEGAL_PAGES`, `SYSTEM_LEGAL_PAGES`) — eine neue Seite bringt ihr
   Präfix mit, und keine Liste muss nachgezogen werden. Mit einem Muster wäre
   die neue Seite ebenfalls erfasst worden, und genau so käme die obige Kollision
   still statt bemerkt.

   Belegt in `apps/web/src/views/tenant-admin/TenantLegalTab.test.tsx` und
   `apps/web/src/views/system-settings/SystemLegalTab.test.tsx` — je einmal am
   richtigen Feld und einmal daneben: die Nachbarkarte trägt ein Feld
   **desselben** Namens („Telefonnummer", „Name des Betreibers", „Eigener
   Text") und bleibt unmarkiert. Ersetzt man die Kürzung durch ein Muster,
   werden genau diese Erwartungen rot.

## Fortschreibung 2026-08-21 (Review-Runde 3)

### 1. Die Erklärung zur Barrierefreiheit ist **freiwillig**

Der Befund kam als Frage: *„Gibt es eine Pflicht für ‚Erklärung zur
Barrierefreiheit'? Ansonsten wird das bitte ersatzlos gestrichen."*

**Es gibt eine, aber nicht für jeden** — und daraus folgt weder Streichen noch
das bisherige Behandeln wie eine Pflichtseite:

| Seite | Pflicht | Grundlage |
|---|---|---|
| Impressum | jeden Betreiber | § 5 DDG, § 18 Abs. 1 MStV |
| Datenschutzerklärung | jeden Betreiber | Art. 13 f. DSGVO |
| Erklärung zur Barrierefreiheit | öffentliche Stellen; im Einzelfall Unternehmen | § 12b BGG bzw. Landesgleichstellungsgesetz, BFSG (`docs/legal/README.md` 3.4) |

**Gestrichen wird sie nicht.** Wen die Pflicht trifft, den trifft sie hart:
§ 12b BGG schreibt die Inhalte vor, bis hin zur Benennung der *richtigen*
Durchsetzungsstelle — eine gestrichene Vorlage wäre für jede öffentliche
Stelle ein Rückschritt. Falsch war allein, sie **allen** als Versäumnis
vorzuhalten: als offener Punkt in der Verwaltung und als dauerhafter Verweis
in der Fußzeile jedes Formulars.

Sie ist deshalb an zwei Stellen bedingt geworden, und beide fragen nach dem
**Inhalt** und nicht nach einer Einstellung — es gibt keinen Schalter „wir
sind eine öffentliche Stelle", den jemand falsch stellen könnte:

- **Der Verweis in der Fußzeile** erscheint, sobald etwas hinterlegt ist
  (`publicLegalFooterSchema.accessibilityDeclared`).
- **Die Liste offener Punkte** zählt sie nur, wenn sie **angefangen und liegen
  geblieben** ist (`incomplete`). Eine leere freiwillige Seite ist kein offener
  Punkt; eine halb ausgefüllte ist einer, denn sie ist dann verlinkt und
  öffentlich sichtbar.

Die eine Stelle, an der steht, welche Seiten Pflicht sind:
`SYSTEM_LEGAL_MANDATORY_PAGES` in `packages/shared/src/legal.ts`.

### 2. Gemeinsame Angaben werden **einmal** getippt

*„Einrichtung: Ich muss mehrfach das gleiche eingeben (Betreiber, …)."* —
richtig, und in beträchtlichem Umfang: siebzehn Platzhalter stehen in mehr als
einer Vorlage, darunter Name, Anschrift und Telefonnummer. Wer eine
Installation einrichtete, tippte seine Anschrift dreimal, und ein Vertipper
ergab zwei Rechtstexte mit widersprüchlichen Pflichtangaben.

**Gewählt: mitführen, nicht zusammenlegen.** Ein Wert wandert beim Tippen in
die Nachbarseiten mit, solange deren Feld leer ist oder noch den alten Wert
trägt. Eine bewusste Abweichung — etwa eine eigene Anschrift für
Datenschutzanfragen — bleibt stehen und läuft ab da nicht mehr mit. Am
Speicherformat, an den Wire-Verträgen und am Rendern ändert sich **nichts**:
jede Seite trägt ihre Felder weiterhin selbst.

Die vier erwogenen Möglichkeiten samt Bewertung stehen in
`packages/shared/src/legal-shared-fills.ts`; verworfen sind insbesondere eine
gemeinsame Ablage (Migration über echte Rechtstexte, und die bewusste
Abweichung wäre nicht mehr möglich) und ein umsortierter gemeinsamer Abschnitt
(verlässt die geprüften Vorlagen aus `docs/legal/vorlagen/`).

⚠️ Damit ist die Zeile „eine automatische Übernahme von Betreiberangaben in
Organisationsfelder" unter *Was ausdrücklich nicht gebaut wurde* **unberührt**:
mitgeführt wird nur innerhalb **einer** Ebene. Ein Betreiber, dessen Anschrift
in die Felder einer Organisation liefe, wäre eine Aussage über eine fremde
verantwortliche Stelle.

### 3. Drei Erleichterungen für Laien

*„Können wir das Thema Datenschutzhinweise und Rechtstexte noch etwas
vereinfachen? Das ist für einen Laien doch etwas komplex."* Was fehlte, war
nicht Erklärung an den Feldern — davon gibt es reichlich —, sondern die
Antwort auf die Frage davor:

1. **Eine Orientierung vor den Karten**: welche Seite trifft jeden, welche
   nicht, und dass die Vorlage der übliche Weg ist.
2. **Die Zahl der noch offenen Felder** an der Zustandsmarke.
   „Unvollständig — noch 3 Felder" ist eine Aufgabe, „Unvollständig" ein
   Vorwurf.
3. **Die Wahl zwischen Vorlage und eigenem Text steht nicht mehr an erster
   Stelle.** Sie stand als erstes Bedienelement der Karte da und verlangte
   damit von jedem eine Entscheidung über die Bauform — von genau den Leuten,
   denen die geprüfte Vorlage abgenommen werden soll. Sie steht jetzt
   zugeklappt unter den Feldern („Lieber einen eigenen Text hinterlegen?") —
   an **einer** Stelle, in beiden Modi derselben. Einmal aufgeklappt, bleibt
   sie offen, auch über den Moduswechsel hinweg; wer einen eigenen Text
   gespeichert hat, findet sie beim Aufschlagen bereits offen, denn dort ist
   sie der Weg zurück. Sie oben *und* unten zu zeichnen, war der erste
   Entwurf und der falsche: der Schalter wanderte beim Umschalten quer durch
   die Karte und verschwand unter dem Zeiger dessen, der ihn gerade betätigt
   hatte.

### 4. Die Drittkomponenten stehen auf `/licences`

Der Absatz, der öffentlich einräumte, die Liste werde „derzeit nicht
ausgeliefert; sie ist ein offener Punkt und in ADR-0028 als solcher benannt",
ist weg — **weil der offene Punkt weg ist**. `tools/licences.ts` erzeugt die
Liste aus der Sperrdatei, samt dem **Wortlaut** jeder Lizenz: „MIT" zu nennen
genügt der MIT-Lizenz nicht, sie verlangt die fremde Copyright-Zeile
mitzuliefern. Die Liste ist eingecheckt (das Web-Image sieht die
Laufzeitabhängigkeiten der API nicht) und wird von `node tools/licences.ts
--check` im `quality`-Job gegen die Sperrdatei gehalten.

### 5. Der Name der verantwortlichen Stelle bricht um

„VERANTWORTLICH FÜR DIESES FORMULAR: ARBEITSGEMEINSCHAFT DER …" passte auf
keiner Breite in eine Zeile versal gesetzten Kleindrucks. Der Name steht
jetzt als eigener Block darunter, in Laufschrift.

## Was ausdrücklich **nicht** gebaut wurde

Weil die Analyse es abgelehnt hat, nicht weil es vergessen wurde: ein
Cookie-Banner (es gibt keine Cookies auf dem Ausfüllpfad — geprüft, nicht
vermutet), Nutzungsbedingungen für Teilnehmende, ein
Selbstbedienungs-Auskunftsweg, ein Impressum je Formular, ein
Einwilligungshäkchen „Ich habe die Datenschutzhinweise gelesen" und eine
automatische Übernahme von Betreiberangaben in Organisationsfelder.

## Fortschreibung 2026-08-24 (Review-Runde 4)

### 1. Die Erklärung zur Barrierefreiheit ist gestrichen (Nr. 4)

*„Barrierefreiheit Erklärung streichen wir komplett ersatzlos. Das optionale
können wir uns erstmal sparen."*

Die Fortschreibung von Runde 3 hatte sie **freiwillig** gemacht — Seite und
Vorlage blieben, nur der Verweis in der Fußzeile und der offene Punkt in der
Verwaltung erschienen erst, wenn jemand sie ausfüllte. Diese Anweisung geht
einen Schritt weiter, und das ist eine Entscheidung über den Umfang und keine
über die Rechtslage: § 12b BGG trifft weiterhin, wen er trifft.

Fort sind: die Seite `/barrierefreiheit`, die Vorlage in
`legal-templates.ts`, der Schlüssel `accessibility` in `SYSTEM_LEGAL_PAGES`,
das Feld `accessibilityDeclared` der Fußzeilen-Antwort und der zugehörige
Zweig in der Liste der offenen Punkte.

⚠️ **Eine Migration war nötig, obwohl keine Spalte verschwindet.**
`systemLegalPagesSchema` ist ein `z.strictObject`; ein gespeichertes Dokument
mit dem übriggebliebenen Schlüssel hätte den Parser scheitern lassen, und
`parseStoredSystemLegalPages` antwortet dann mit „nichts hinterlegt" — Impressum
und Datenschutzerklärung derselben Zeile wären still verschwunden.
`20260824090000_drop_accessibility_legal_page` nimmt den Schlüssel weg.

Die anwaltlich entworfene Vorlage bleibt in `docs/legal/vorlagen/05-…` liegen,
mit einem Vermerk obenauf. Wen die Pflicht trifft, hinterlegt die Erklärung als
**eigenen Text** in einer der beiden verbliebenen Seiten oder außerhalb dieser
Anwendung.

### 2. Jedes Feld sagt, was hineingehört (Nr. 5)

*„‚Wesentliches der Vereinbarung nach Art. 26 DSGVO!' und ‚Zentrale
Anlaufstelle nach Art. 26 Abs. 1' und ‚Rechtsgrundlage für die Konten' unklar.
Am besten mal überall Standardtexte oder Platzhalter rein damit man weiß was da
grob rein soll."*

Der Befund trifft einen echten Unterschied: `hint` erklärt die **Rechtsfrage**,
und keines der drei Felder sagte, welche **Antwortform** erwartet wird. „Art. 26
Abs. 2 verlangt, dass das Wesentliche der Vereinbarung zur Verfügung gestellt
wird" beantwortet nicht, ob dort ein Satz, eine Liste oder eine Adresse
hingehört.

`LegalSlot` trägt deshalb zwei neue Angaben:

| | Bedeutung | Anzeige |
|---|---|---|
| `example` | ein Beispielwert | Platzhalter im leeren Feld |
| `suggestion` | ein **übernehmbarer** Standardtext | Platzhalter **und** ein Knopf „Vorschlag übernehmen" |

**Kein Vorbelegen**, und das ist der Kern: ein Rechtstext, den niemand gelesen
hat, weil er schon dastand, ist die stille Art der Falschangabe. Der
Unterschied ist genau eine bewusste Handlung. Ein Test in
`packages/shared/src/legal.test.ts` hält fest, dass **jedes** Feld **jeder**
Vorlage eine der beiden Angaben trägt — sonst trüge das nächste neue Feld
wieder nur eine Rechtsfrage als Beschriftung.

### 3. Die Aufsichtsbehörde ist kein Pflichtfeld (Nr. 6)

*„‚Zuständige Datenschutz-Aufsichtsbehörde (Name und Anschrift)' warum ein
pflichtfeld? Macht keinen Sinn."*

Der Befund stimmt, und zwar rechtlich: **Art. 13 Abs. 2 lit. d DSGVO verlangt
den Hinweis auf das Beschwerderecht, nicht die Nennung einer bestimmten
Behörde.** Der Hinweis stand ohnehin da; das Feld daneben machte die Seite
trotzdem „unvollständig", solange es leer war.

Gelöst mit dem vorhandenen Werk und ohne neuen Begriff: die **Nennung** steht
jetzt in einem bedingten Block (`⟪WENN:aufsichtsbehoerde⟫`), das Beschwerderecht
selbst unbedingt davor. Ein nicht ausgewählter Block nimmt seine Felder mit
(`visibleSlots`), also verschwindet das Feld und die Seite ist vollständig. Wer
die eigene Aufsicht nennen will, hakt es an — wer sie nicht sicher kennt, lässt
es, denn eine falsch benannte Behörde ist schlechter als keine.

Kein `optional`-Merkmal am Feld: ein leeres Pflichtfeld hätte im Text eine
Lücke hinterlassen („zuständig ist: ⟨Angabe fehlt⟩"), und die Bedingung nimmt
den ganzen Halbsatz mit.

### 4. Die Felder stehen in fachlichen Abschnitten (Nr. 7)

*„Mailserver und Backup Felder haben falsche Reihenfolge und werden
vermischt."*

Ebenfalls richtig, und die Ursache war eine Ordnung, die vernünftig aussah: die
Feldliste folgte der Reihenfolge des **Textes**. Der springt zu Recht — der
Mailversand ist Abschnitt 6, die Sicherungen sind 7, der Maildienstleister
taucht in der Empfängertabelle in 9 wieder auf. Wer das Formular ausfüllt,
liest den Text daneben nicht.

`LegalSlot.group` benennt den Abschnitt, `groupedSlots()` sammelt danach ein
(Reihenfolge der Abschnitte = die ihres ersten Feldes; die namenlose Gruppe
steht vorn), und der Editor zeichnet je ein `<fieldset>`. Die Liste in der
Vorlage steht seitdem in **Formular**-Reihenfolge; für das Rendern ändert das
nichts, weil der Text seine Werte über den Schlüssel findet.

### 5. Keine Zusage über die Vorlage (Nr. 9)

*„Mache ich mich durch die Bereitstellung der Vorlage nicht angreifbar falls
darin etwas fehlen sollte?"*

Die ausführliche Antwort steht in `docs/legal/README.md` Abschnitt 10 und
zerlegt die Frage in drei Risiken (Softwareautor, Betreiber, Organisationen).
Was sich **am Code** geändert hat, ist eine Formulierung: die Oberfläche nannte
die Vorlage „geprüft". Sie heißt jetzt „ausformuliert", und an beiden
Rechtstext-Reitern steht ein Absatz „Keine Rechtsberatung".

Der Grund ist die Rechtsprechung des BGH zum Vertragsgenerator (I ZR 113/20):
der Generator selbst war **keine** unerlaubte Rechtsdienstleistung — beanstandet
wurde die Werbeaussage „rechtssicher". Angreifbar macht nicht die Vorlage,
sondern eine Zusage über sie.

### 6. Die Adressen der Rechtstexte sind englisch (Nr. 8)

`/impressum` → `/imprint`, `/datenschutz` → `/privacy`, `/lizenzen` →
`/licences`, und dasselbe unter `/o/<kurzname>/…`. Teil der Umstellung aller
Pfade; die Begründung und der harte Schnitt ohne Weiterleitung stehen in
`apps/web/src/router/routes.ts`. Der **Inhalt** der Seiten bleibt deutsch — die
Adresse ist Code, der Text ist Oberfläche.

## Fortschreibung 2026-09-05 (Review-Runde 5)

### 1. Öffentlich steht nur, was hinterlegt ist (Nr. 1)

*„Rechtstexte: unvollständige Angaben sollten nicht in der öffentlichen Ansicht
angezeigt werden. Das sieht nicht gut aus."*

Die Entscheidung oben sagte das Gegenteil, und sie sagte es ausdrücklich: eine
angefangene Seite wird gezeigt **und** oben als unfertig markiert, im Text steht
„Angabe fehlt: Telefonnummer", weil „ein veröffentlichter `[[PLATZHALTER]]`
schlimmer ist als ein leeres Feld". Der zweite Teil dieses Satzes bleibt wahr —
und er war nie das Argument für das erste.

**Entscheidung: `renderLegalPage` bekommt eine Zielgruppe** (`LegalAudience`,
`'public' | 'editor'`), und sie ist ein **Pflichtargument** ohne Vorgabe. Für
`'public'` entfällt **jede Zeile mit einer offenen Angabe**
(`withoutGapLines`), und mit ihr der Warnhinweis darüber: `status` und `missing`
reisen in der öffentlichen Nutzlast nicht mehr mit
(`publicLegalPageSchema`, `publicFormPrivacyNoticeSchema`). Die Zusicherung ist
damit bauartbedingt und nicht eine Bedingung in einer Ansicht, die jemand
zurückdreht.

**Zeilenweise und nicht absatzweise**, und das ist die eigentliche
Konstruktion: ein Absatz dieser Vorlagen trägt mehrere Zeilen — eine
Postanschrift ist ein Absatz mit Zeilenumbrüchen. Den Absatz zu streichen nähme
die Straße mit, wenn die Hausnummer fehlt.

**Die Regel hat drei Fälle, und der dritte kam aus dem Review dieser Änderung:**

| Auf der Zeile | Öffentlich |
|---|---|
| kein Platzhalter | sie bleibt, unangetastet |
| alle Platzhalter offen | sie fällt weg — „Telefon: " ist kein Satz |
| **mindestens einer ausgefüllt** | sie bleibt, und nur die offene Stelle verschwindet |

Der dritte Fall ist keine Feinheit. Die Anschrift steht in den Vorlagen als
**eine** Zeile `[[PLZ]] [[ORT]]`; die erste Fassung strich jede Zeile mit einer
Lücke und nahm damit den ausgefüllten Ort mit — eine Angabe, die dasteht und
wahr ist, und § 18 Abs. 1 MStV verlangt genau die. ⚠️ Der Preis des dritten
Falls, ausdrücklich: auf einer gemischten Zeile bleibt der umgebende Text
stehen, auch wenn er nach der Lücke ins Leere greift („Modell " ohne Modell).
Das ist die kleinere Ungenauigkeit.

Deshalb greift die Regel **vor** der Ersetzung: nur dort ist noch zu sehen,
welche Stelle welchem Feld gehörte. Der Preis ist eine zweite Ersetzung für die
öffentliche Fassung, der Gewinn, dass in ihr keine Lücke überhaupt entsteht —
auch nicht im Ersatztext der leeren Seite, der durch dieselbe Stufe geht.

**Und eine Überschrift ohne Abschnitt geht mit** (`withoutEmptySections`): steht
unter *Kontakt* nach dem Weglassen nichts mehr, wäre die Überschrift derselbe
Befund an einer neuen Stelle. Von hinten nach vorn, damit Ketten mitgehen; je
Text und nicht über die Fuge zwischen Rumpf und festem Teil hinweg.

Vier Aufrufstellen gibt es, und drei sind `'public'`: die beiden öffentlichen
Rechtstextseiten und der Datenschutzhinweis eines Formulars. Die vierte ist die
**Vorschau im Editor**, und dort sind die Lücken der Sinn der Ansicht — sie
stehen neben dem Feld, das sie schließt. Der Satz unter der Vorschau benennt den
Unterschied, weil er sonst wie ein Fehler aussieht.

⚠️ **Der Zustand einer Seite bleibt, was er war.** `legalPageStatus` liest
weiterhin das ganze Dokument: die Ampel an der Karte, die offenen Punkte der
Verwaltung und der Hinweis beim Veröffentlichen sagen unverändert
„unvollständig". Ein Text, der sich durch das Weglassen selbst fertigmachte,
wäre der eine Zustand, den diese Änderung nicht erreichen darf — ein Test hält
beide Zielgruppen gegen denselben Zustand.

**Was ausdrücklich nicht geändert wurde:** die *leere* Seite. Sie sagt weiter in
voller Länge, dass nichts hinterlegt ist, und nennt daneben, was die Anwendung
wahrheitsgemäß kennt (`docs/legal/README.md` 5.4). Der Fall mit dem größten
Druck bleibt also unangetastet; geändert hat sich der halb ausgefüllte.

**Der Einwand, und wie er getragen wird.** `docs/legal/README.md` 5.4 hält am
Ende fest: *„Ein Hinweis auf die eigene Lücke schreckt Teilnehmende ab. Ja — und
das ist richtig so."* Dieser Satz spricht für den umgekehrten Weg, und er ist
nicht falsch geworden. Was gegen ihn steht: der Druck gehört auf die
verantwortliche Stelle, und dort liegt er unverändert an drei Orten
(Assistentenschritt, Veröffentlichen-Hinweis, offene Punkte — Abschnitt 5.5).
Was die ausfüllende Person durch die Änderung **verliert**, ist die
Inventarliste des Fehlenden; was sie behält, sind alle wahren Angaben und der
Weg zu beiden Verantwortlichen über die Fußzeile. Diese Abwägung ist eine
Entscheidung des Betreibers und wird hier als solche festgehalten, nicht als
Widerlegung der Analyse.

### 2. Der KI-Abschnitt der Datenschutzerklärung war nicht ausfüllbar (Nr. 2)

*„Datenschutzerklärung: KI Teil fehlt im Formular."*

Der Befund traf zu, und er war kein Anzeigefehler. `visibleSlots` lässt die
Felder eines **abgewählten** Blocks weg — das ist der Grund, aus dem das
Formular sieben und nicht zweiunddreißig Felder zeigt. Die Bedingung `ki` wird
aus der Konfiguration abgeleitet (`auto: 'ai'`), und die Karte der
Systemverwaltung **nahm** `aiActive: false` an, mit einer Begründung, die in der
Entscheidung oben nachzulesen ist: eine zweite Abfrage sei den Ladezustand nicht
wert, und die Organisationsfassung derselben Karte könne den Wert ohnehin nie
kennen.

Der erste Teil war lösbar, der zweite bleibt wahr — und der Preis war zu hoch:
nicht eine ungenaue Vorschau, sondern **sieben Felder, die niemand ausfüllen
konnte** (Anbieter, Sitz, Modell, Region, Übermittlungsgrundlage, Kontakt für
Garantien, Aufbewahrung beim Anbieter), während die veröffentlichte Seite den
Abschnitt sehr wohl zeigte: dort liest der Server denselben Wert und bekommt die
Wahrheit. Zusammen mit Nr. 1 ist das dieselbe Beobachtung von zwei Seiten — die
öffentliche Erklärung zeigte Lücken, die das Formular nicht anbot.

**Entscheidung:** `GET /admin/system-settings/legal` trägt `aiActive` mit
(`SystemLegalService.readForAdmin`), und die Karte reicht es in den
Render-Kontext. Es ist ein Superadmin, der hier tippt; die KI-Einstellungen
stehen ihm im Nachbartab offen, also ist der Wahrheitswert keine neue Auskunft.
Nur er reist, kein Stück der Konfiguration. `read()` bleibt schlank, weil der
**öffentliche** Weg dieselbe Methode benutzt und `aiActive` dort längst selbst
liest.

Die Liste der offenen Punkte liest denselben Wert (`openItems`) — sonst meldete
sie eine Datenschutzerklärung als fertig, während die Karte darunter sieben
leere Felder zeigt. Die Fassung einer **Organisation** bleibt bei der Annahme
und sagt es unter ihrer Vorschau: `aiStateKnown` unterscheidet die beiden
Fälle, damit nicht ein Vorbehalt dasteht, wo keiner nötig ist.

## Fortschreibung 2026-09-07 (Review-Runde 5, Nachtrag)

### 3. Ein dritter Weg: der Text steht schon woanders

*„füge noch als Alternative bei den Rechtstexten die Angabe eines Links zur
Weiterleitung zu dem jeweiligen Rechtstext an."*

Die Entscheidung oben kannte zwei Wege — Vorlage ausfüllen oder eigenen Text
schreiben. Beide setzen voraus, dass der Text **hier** entsteht. Wer sein
Impressum längst auf der eigenen Website stehen hat, pflegte es damit zweimal,
und von zwei Fassungen desselben Textes ist eine die, die stimmt, und eine die,
die niemand nachzieht.

**Entscheidung:** `mode: 'link'` als dritte Fassung, mit `link` als dritter
Hälfte des Dokuments. Alle drei stehen weiterhin **nebeneinander** — ein
Moduswechsel verliert nichts, dieselbe Zusage wie zwischen Vorlage und eigenem
Text.

⚠️ **Ein gespeichertes Dokument von vorher bleibt lesbar.**
`legalDocumentSchema` ist ein `z.strictObject`; ein neues **Pflicht**feld hätte
jede bestehende Zeile scheitern lassen, und `parseStoredSystemLegalPages` hätte
daraus „nichts hinterlegt" gemacht — Impressum und Datenschutzerklärung wären
mit einem Schlag weg gewesen. `link` trägt deshalb eine Vorgabe, und eine
Migration braucht es nicht.

### Verweis und nicht Weiterleitung — die Entscheidung des Betreibers

Naheliegend wäre gewesen, `/imprint` auf die fremde Adresse **weiterzuleiten**.
Dagegen steht ein Befund aus dieser Vorlage selbst: **drei der fünf Vorlagen
tragen einen festen Teil**, den nur diese Anwendung über sich sagen kann —
Auftragsverarbeitung, keine Cookies, Speicherorte, Löschfristen, die
Weiterleitung nach dem Absenden. Eine Weiterleitung würde ihn wegwerfen, und
zwar bei genau den beiden Seiten, die Ausfüllende am ehesten lesen.

Zur Wahl standen drei Formen (Weiterleiten, wo nichts verloren geht; immer
weiterleiten; immer verweisen). Der Betreiber hat am 2026-09-07 **eine Regel für
alle fünf Seiten** gewählt: die Seite zeigt oben den Satz „Diese Angaben stehen
auf einer eigenen Seite" mit der Adresse als Link — und darunter den festen
Teil, wo es einen gibt. Ein Klick mehr, und dafür keine Seite, die sich je nach
Text anders verhält, keine Automatik auf eine fremde Domain und nichts, was
verlorengeht. Zwei Klicks gelten als „unmittelbar erreichbar" (§ 5 DDG).

**Zwei Schranken für die Adresse**, weil sie in einem `href` auf einer Seite
landet, die Fremde öffnen: `safeExternalUrl` beantwortet „darf ein Browser da
hin?" — beim **Schreiben** und noch einmal beim **Ausliefern** —, und
`safeLegalHref` beantwortet dieselbe Frage in einer zweiten Umsetzung für alles,
was in diesem Modul ein `href` wird. Eine Adresse, die durchfällt, macht die
Seite `empty`: sie sagt dann wahrheitsgemäß, dass nichts hinterlegt ist, statt
einen toten Verweis zu zeigen.

⚠️ **Geprüft wird beim Schreiben nur, wenn der Verweis auch gilt** (Befund des
Reviews). Die drei Hälften eines Dokuments reisen immer mit; hinge die Prüfung
am Feld, blockierte eine halb getippte Adresse das Speichern einer ausgefüllten
**Vorlage** — mit einem 400 auf ein Feld, das die Karte in diesem Modus gar
nicht zeichnet. Deshalb zwei Schemata: `legalDocumentSchema` liest nachsichtig
(eine von Hand geschriebene Zeile darf nicht das ganze Dokument unlesbar machen
und damit beide Seiten auf „nichts hinterlegt" setzen),
`legalDocumentWriteSchema` prüft, was jemand schreiben will.

⚠️ **Gespeichert wird, was getippt wurde** — normalisiert wird erst beim
Ausliefern. `new URL().href` prozentkodiert, was nicht ASCII ist (aus einem
Gedankenstrich werden neun Zeichen); würde die normalisierte Fassung
gespeichert, stünde in einer Spalte mit Obergrenze 2 000 ein Vielfaches davon.

⚠️ **Eine Adresse ist kein Text** (Befund des Reviews). Der Absatz mit dem
Verweis wird als **Block gebaut** und nicht als Auszeichnung geschrieben und
wieder geparst. Die erste Fassung tat das, und sie zerfiel an Zeichen, die in
Adressen alltäglich sind: bei `https://a.example/a)b` beendete die Klammer den
Link, und die Seite verwies auf `https://a.example/a` — eine **andere** Adresse,
während die Karte „Vollständig" sagte.

### 4. Ein freiwilliges Feld macht keine Seite unvollständig

*„Rechtstexte offen Hinweis sollte nur bei den wichtigen Punkten angezeigt
werden. Die Telefonnummer ist ja optional dachte ich."*

Sie ist es, und die Vorlage sagte es an dem Feld bereits selbst („Nicht
zwingend, wenn ein zweiter schneller Kommunikationsweg besteht"): § 5 Abs. 1
Nr. 2 DDG verlangt „Angaben, die eine schnelle elektronische Kontaktaufnahme
ermöglichen, **einschließlich** der Adresse der elektronischen Post", und der
EuGH hat ausdrücklich entschieden, dass eine Telefonnummer nicht dazugehört,
solange ein zweiter schneller Weg offensteht (C-298/07). Die Ampel zählte sie
trotzdem mit — eine Seite, die wegen eines freiwilligen Feldes „unvollständig"
heißt, macht aus der einen Warnung, die es gibt, eine, die man wegklickt.

**Entscheidung:** `LegalSlot.optional`. Das Feld bleibt sichtbar und trägt
„(optional)" in der Beschriftung; es zählt nicht in „noch 3 Felder", nicht in
`missing` und nicht gegen den Zustand der Seite. In der **Vorschau** des Editors
bleibt seine Lücke benannt stehen — dort ist sie ein Angebot und kein Vorwurf.

⚠️ **Sparsam vergeben, und nie aus Bequemlichkeit.** Was `optional` trägt, ist
eine Aussage über die Rechtslage und keine über den Aufwand. Heute ist es genau
ein Feld, und zwar in jeder Vorlage, die es hat: die Telefonnummer. Ein Test
zählt sie auf und wird rot, sobald ein zweites dazukommt — damit die Entscheidung
aufgeschrieben wird, statt nebenbei zu geschehen. Ob ein ganzer **Abschnitt**
zutrifft, bleibt die andere Frage und wird weiter über `⟪WENN:…⟫` entschieden.
