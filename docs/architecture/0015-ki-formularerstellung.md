# 15. KI-Formularerstellung — eine Naht, zwei Anbieter, ein Freitext auf Zeit

- **Status:** accepted
- **Date:** 2026-08-06

## Context

Die KI-Formularerstellung ist das erste Vorhaben dieses Projekts, das **eine
Anfrage an einen fremden Dienst schickt**. Drei Grenzen liegen dabei
gleichzeitig offen:

1. **Geheimnisse** — ein Schlüssel, mit dem jeder, der ihn hat, auf Rechnung des
   Betreibers Text erzeugen kann.
2. **Datenabfluss** — was diese Anwendung hinausgibt, verlässt die EU-gehostete
   Installation und kommt nicht zurück.
3. **Fremddaten** — was hereinkommt, ist von einem Sprachmodell erzeugt und
   soll ein **Formular-Dokument** werden, das anschließend öffentlich ausgefüllt
   wird.

Der strittigste Teil ist vorentschieden; dieser ADR schreibt ihn aus:

- **beide Adapter** (Anthropic *und* Mistral) hinter **einem** Interface, mit
  einem Test-Doppel;
- **ohne Schlüssel gibt es die Funktion nicht** — Menüeintrag **abwesend**, Route
  **404**, Start **gelingt trotzdem**;
- **der Freitext wird gespeichert und nach 30 Tagen physisch gelöscht**, samt
  Zeitpunkt, auslösender Person und Organisation;
- **Zielsprache ist das geteilte `formSchema`**, nicht ein zweites Schema für die
  KI.

Entschieden werden hier: die Form der Naht, welche Daten hinausgehen und welche
nie, Modellwahl und ihre Konfigurierbarkeit, Zeitlimit und Abbruch, die Zählweise
des Verbrauchs samt der Frage, was ein Fehlschlag kostet, die Ablage der
Schlüssel und die restliche DSGVO-Seite.

**Dieser ADR ist ein Prüfobjekt, kein Freibrief.** Die Schreibregel aus
[ADR-0014](0014-datei-upload.md) gilt hier unverändert: **wo „X kann nicht
passieren" steht, steht der Mechanismus daneben, der es verhindert**, und was
nur angenommen ist, steht als **Annahme** markiert (am Ende
gesammelt). Zusätzlich lässt sich **jede** Entscheidung dieses
Dokuments daran messen, was sie zusagt — eine Aussage, die sich nicht prüfen
lässt, wäre entweder unnötig oder ungebaut.

Was dieser ADR **nicht** ändert: die Guard-Kette, die Regel „ein zweiter
Schreibpfad erbt den Filter des ersten nicht", und die Hosting-Agnostik aus
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

---

## Decision

### 1. Eine Naht, eine Methode, ein gemeinsamer Vertragstest

`AiFormGenerator` ist ein Interface plus DI-Token in `apps/api/src/ai/`, mit
genau **einer** Methode:

```ts
generate(request: AiFormRequest, signal: AbortSignal): Promise<AiFormOutcome>
```

Drei Implementierungen: `AnthropicFormGenerator`, `MistralFormGenerator` und
`RecordedFormGenerator` (das Test-Doppel, das aufgezeichnete Antworten abspielt).
**Alle drei bestehen dieselbe Testtabelle**, und die ist der eigentliche Ertrag
dieser Nummer: ein Doppel, das nur seinen eigenen Tests genügt, belegt nichts
über die Adapter. Die Tabelle enthält mindestens je eine Zeile für **Erfolg**,
**Zeitüberschreitung**, **Ratenbegrenzung des Anbieters**, **ungültiges JSON**,
**abgeschnittene Antwort**, **Ablehnung durch den Anbieter** und **sonstige
Nichtverfügbarkeit** — und läuft mit **zwei** Spalten (Anthropic, Mistral), weil
die Spezifikation genau dafür beide Adapter verlangt.

**Bewusst *nicht* im Interface:**

- **`listModels()` / `estimateCost()`** — die Modellwahl ist eine Entscheidung
  der Konfiguration (Nr. 6), keine Laufzeitabfrage. Ein Adapter, der Modelle
  aufzählt, ist der erste Schritt zu einer Auswahl in der Oberfläche und damit zu
  einem Kostenhebel, den kein Guard bewacht.
- **Streaming** — die Anwendung braucht *ein* Dokument, keinen Token-Strom. Ein
  Strom brächte Teilzustände, für die es keine Fachlichkeit gibt (ein halbes
  Formular ist kein Formular), und einen zweiten Weg, auf dem eine abgeschnittene
  Antwort unbemerkt durchginge.
- **Wiederholung/Backoff** — siehe Nr. 7: ein Adapter, der still wiederholt,
  macht aus einem gezählten Aufruf drei bezahlte.
- **Ein Tenant- oder Nutzer-Parameter** — die Naht kennt keine Organisationen. Wer darf
  und wie viel übrig ist, entscheiden Guard-Kette (Nr. 12) und Zähler (Nr. 7)
  **vor** dem Aufruf; ein Adapter mit Tenant-Wissen wäre eine zweite Stelle, an
  der Tenant-Logik wahr bleiben muss.
- **Ein Roh-Zugang zur Anbieterantwort** (`raw`, `response`, `headers`) — das ist
  genau das Loch, durch das anbieterspezifische Eigenschaften wieder
  hindurchwandern (Nr. 2).

**Was `packages/shared` hiervon bekommt:** den **Fehlertyp und die Anfrageform**
(Nr. 2, Nr. 5), nicht das Interface. Anders als bei `FileStorage`
([ADR-0014 Nr. 1](0014-datei-upload.md), rein serverseitig) muss der Browser die
Fehlerfälle **benennen** können — der Dialog zeigt je Fall einen anderen Satz und
sagt, ob ein zweiter Versuch hilft. Zwei Aufzählungen dafür wären genau die
Drift, gegen die `pickDefaultColumns` geteilt wurde.

*Verworfen:* zwei getrennte Dienste ohne gemeinsames Interface („der zweite
Anbieter kommt später") — das ist wörtlich die Bauform „zweiter Schreibpfad ohne
den Filter des ersten", die zweimal ein Geheimnis weitergegeben hat, und
die Spezifikation Nr. 77 schließt sie ausdrücklich aus. Verworfen ferner eine
Meta-Bibliothek über beide Anbieter: das wäre eine dritte Abstraktion über
unserer eigenen, mit einer großen Abhängigkeit und ohne den Vertragstest, der
hier die eigentliche Zusage ist.

### 2. Der geteilte Fehlertyp ist geschlossen — und was nicht hindurchdarf

```ts
type AiFailureKind =
  | 'timeout'          // unser Zeitlimit ist abgelaufen (Nr. 6)
  | 'rate_limited'     // Ratenbegrenzung des Anbieters
  | 'invalid_output'   // kein JSON, oder JSON, das Schema nicht erfüllt
  | 'truncated'        // die Antwort endete an der Token-Grenze
  | 'refused'          // der Anbieter hat die Anfrage abgelehnt
  | 'unavailable';     // Netz, 5xx, Auth, alles Übrige

type AiFormOutcome =
  | { ok: true;  draft: unknown;          usage: AiUsageSample | null }
  | { ok: false; failure: AiFailureKind;  usage: AiUsageSample | null };
```

Vier Fälle sind der Kern; **zwei kommen dazu, und beide verdienen ihren
Platz**:

- **`refused`**, weil eine Ablehnung sonst in `invalid_output` fiele und dem
  Bearbeiter „das Modell hat Unsinn geliefert" sagte, obwohl die Wahrheit „das
  Modell hat abgelehnt" ist. Der Unterschied entscheidet, ob ein zweiter Versuch
  mit demselben Text etwas bringt. *(Der Fall ist nicht hypothetisch: die
  Anthropic-API antwortet mit HTTP 200 und `stop_reason: "refusal"`, siehe A5.)*
- **`unavailable`** als Sammelfall, weil eine offene Aufzählung („und sonst der
  Text des Anbieters") die Tür ist, durch die eine fremde Fehlermeldung in unser
  Log und in unsere Oberfläche gelangt — samt möglicher Echos der Eingabe.

**Der Rückgabewert ist ein Ergebnis, keine Ausnahme.** Ein `throw` trüge
Anbieter-Stacktrace und Anbieter-Text durch jede Schicht, die ihn nicht fängt;
`AiFormOutcome` zwingt den Aufrufer, die sechs Fälle erschöpfend zu schalten —
dieselbe Bauform, mit der die Fragetypen in `packages/shared` erschöpfend
geschaltet sind.

**Nicht hindurch dürfen** — und das ist die Liste, gegen die der Typ-Test
läuft:

| Anbieterspezifisch | Warum es an der Naht endet |
|---|---|
| `stop_reason`, `stop_details`, `finish_reason` | Die Bedeutung unterscheidet sich je Anbieter; sie wird **im Adapter** auf `truncated`/`refused` abgebildet, sonst schaltet der Dienst auf Zeichenketten eines Fremden |
| Fehlerklassen der SDKs (`RateLimitError`, `APIStatusError`, …) | Eine Typabhängigkeit auf ein SDK in der aufrufenden Schicht macht den zweiten Adapter unmöglich, ohne dass etwas rot wird |
| HTTP-Status, `retry-after`, Header, `request_id` | Transportdetails; ihre Auswertung gehört in den Adapter (Nr. 7) |
| Die rohe Antwortstruktur (`content`-Blöcke, `choices`, `thinking`) | Der Dienst kennt genau ein Feld: `draft: unknown` (Nr. 3) |
| Beta-Flags, `effort`, `output_config`, `task_budget` | Anbieter-Stellschrauben; sie stehen bei ihrem Adapter, nicht im Vertrag |

**Was ausdrücklich hindurchdarf, weil es Daten und kein Typ ist:** die
**Modellkennung** als Zeichenkette in `AiUsageSample` (Nr. 7). Sie ist die
Grundlage jeder Kostenzuordnung, und sie ist ein Wert, kein Verhalten — dieselbe
Unterscheidung wie „der Dateiname ist Daten" in
[ADR-0014 Nr. 10](0014-datei-upload.md).

*Nachstellung:* ein `stop_reason` bis in den Dienst durchreichen → der
Typ-Test wird rot.

### 3. Die Zielsprache ist `formSchema` — die enge Form ist **abgeleitet**, und der volle Parse ist der Richter

Die Spezifikation gibt vor, dass die Ausgabe gegen das geteilte `formSchema` geparst
wird. Das genügt als Anweisung **nicht**, weil strukturierte Ausgabe ein
JSON-Schema verlangt und `formSchema` Dinge enthält, die ein JSON-Schema nicht
ausdrücken kann. Deshalb ausgeschrieben:

**(a) Die an den Anbieter übergebene Form ist eine Ableitung, keine Kopie.**
`aiFormDraftSchema` entsteht in `packages/shared` **aus** `formSchema` per
`pick`/`omit`/`z.infer` — nie als zweite Niederschrift. Sie
lässt aus:

- **`id` überall** — IDs werden **beim Übernehmen** vergeben (der Nachweis).
  Was gar nicht im Schema steht, kann das Modell nicht liefern; das ist billiger
  als ein Filter, der es hinterher entfernt.
- **`superRefine`/`refine`** — Verfeinerungen haben in JSON-Schema keinen
  Ausdruck. `formSchema` trägt sie reichlich (Optionslisten, `minLength ≤
  maxLength`, Spaltenschlüssel, Veranstaltungen).
- **Längen- und Zahlgrenzen** (`.min()`, `.max()`) — strukturierte Ausgabe
  unterstützt weder String- noch Zahlbeschränkungen; die SDKs entfernen sie aus
  dem übermittelten Schema und prüfen sie clientseitig nach.

**(b) Der volle Parse ist der Richter, das übermittelte Schema nur ein Hinweis.**
Die Antwort kommt als `unknown` herein und wird **serverseitig gegen das
vollständige `formSchema` samt aller Verfeinerungen** geparst. Damit ist es
gleichgültig, wie viel von unserer Absicht das JSON-Schema des Anbieters
transportieren konnte: eine Antwort, die enge Form erfüllt und eine
Verfeinerung verletzt (`minLength > maxLength`, doppelter Optionswert, Bedingung
auf eine spätere Frage), wird **abgelehnt, mit einer Meldung, die sagt, woran es
lag** (der Nachweis). Die Ablehnung ist die Zod-Fehlerpfadangabe, nicht ein
pauschales „das Modell hat Mist gebaut".

**(c) Die Ableitung wird bewacht, nicht vorgenommen.** Ein Test vergleicht die
Fragetypen der abgeleiteten Form mit `questionTypeSchema.options` als
**Gleichheit**: ein neuer Fragetyp, der in der Ableitung fehlt, macht ihn
rot. Ohne diesen Wächter ist „abgeleitet, nicht parallel gepflegt" eine
Absichtserklärung — dieselbe Bauform wie `env-contract.test.ts`, die ihre vier
Ufer als Gleichheit und nicht als Obermenge prüft.

**Und was das kostet, benannt statt entdeckt:** weil die Grenzen im übermittelten
Schema fehlen, wird das Modell sie regelmäßig überschreiten, und der volle Parse
lehnt ab. Das ist eine echte Fehlerquote und kein Randfall; die Gegenmaßnahme ist
die **Systemanweisung** (Nr. 4), die Grenzen in Prosa nennt, nicht ein
zweites Schema. Ob die Quote erträglich ist, misst ein Testlauf mit echtem Verkehr
(**Annahme A5**).

*Verworfen:* ein eigenes „KI-Schema" mit eigener Übersetzung ins `formSchema` —
das ist die Doppelung, die dieses Projekt an vier Stellen schon bezahlt hat, und
die Übersetzung wäre ein dritter Ort, an dem Fragetypen wahr bleiben müssten.

**(d) Das Schema geht auch tatsächlich hinaus.** (a)–(c) beschreiben die
abgeleitete Form und den Richter; ohne (d) wäre nur der Richter gebaut und dem
Anbieter kein JSON-Schema mitgegeben. Die Ableitung geht so:

- **Eine Ableitung, eine Datei:** `apps/api/src/ai/ai-form-json-schema.ts` ruft
  `z.toJSONSchema(aiFormDraftSchema, { io: 'input', reused: 'ref' })`. Kein
  zweites Formular-Schema entsteht dabei — die Fragetypen des *gerenderten*
  Schemas werden gegen `questionTypeSchema.options` als **Gleichheit** geprüft,
  also der Wächter aus (c) eine Stufe weiter geführt.
- **`io: 'input'`**, weil das Modell produziert, was das Schema *annimmt*. Die
  Ausgabeseite ist gar nicht ausdrückbar: `aiFormDraftSchema` trägt Transforms,
  und `{ io: 'output' }` scheitert daran („Transforms cannot be represented in
  JSON Schema") — gemessen, nicht vermutet.
- **`reused: 'ref'`, und das ist eine Kostenentscheidung.** Eingebettet sind es
  **37 333 Byte**, mit `$defs` **11 780** (gemessen). Die Differenz
  reitet auf **jedem** Aufruf mit, in Token, die eine Organisation bezahlt.
- **Zwei mechanische Umschriften, beide gemessen:** `$schema` fällt weg (weder
  Feld ist ein eigenständiges JSON-Schema-Dokument), und `oneOf` wird zu `anyOf`
  (beide Anbieter nennen `anyOf` in ihren Stichwortlisten, keiner `oneOf`; bei
  einer *diskriminierten* Union wählen beide denselben Zweig). Ein Test belegt,
  dass weder `oneOf` noch `$schema` überlebt.
- **Je Anbieter der dort übliche Weg:** Anthropic über
  `tools` + `tool_choice` — genau **ein** Werkzeug, `disable_parallel_tool_use`,
  und das Werkzeug ist die *Form* der Antwort, keine Fähigkeit. Mistral über
  `response_format` mit `json_schema`; dort bleibt die Nutzlast ganz ohne
  Werkzeugfeld. Beide Spalten der Vertragstabelle aus Nr. 1 messen, dass das
  Schema wirklich auf der Leitung liegt — byteweise gegen die Ableitung, nicht
  „irgendetwas Schema-Förmiges".
- **`strict` / erzwungene Dekodierung ist bewusst *nicht* eingeschaltet.** Beide
  Anbieter verlangen dafür ein Schema, das dieses nicht ist: jedes Objekt mit
  `additionalProperties: false` geschlossen und **jede** Eigenschaft in
  `required`. Die abgeleitete Form hat echte Kann-Felder (`title`, `visibleIf`,
  `addRows`) und trägt genau die Längen- und Zahlgrenzen, die strikte Modi
  ablehnen. Eingeschaltet hieße also entweder eine abgewiesene Anfrage bei
  **jedem** Aufruf — abgebildet auf `unavailable`, den nichtssagendsten der
  sechs Fälle — oder ein zweites, handgeformtes Schema, also die Doppelung, die
  (a) ausschließt. ⚠️ Das ist aus den dokumentierten Bedingungen der Anbieter
  gelesen, **nicht gemessen** (hier gibt es keinen Schlüssel); die Entscheidung
  gehört deshalb in einen Testlauf mit echtem Verkehr und steht in der Tabelle der offenen
  Punkte.

⚠️ **Und die Auflage dazu: der Parse bleibt, wie er ist.** Das Schema an der Leitung verbessert die **Trefferquote**, es ist **nie**
ein Grund, (b) aufzuweichen. Ein Anbieter, der trotz Schema Unsinn schickt, wird
genauso abgewiesen — und das ist keine Absichtserklärung: ein Test fährt beide
Adapter über eine aufgezeichnete Antwort, die dem `formSchema` nicht genügt,
belegt **an der Nutzlast**, dass das Schema für genau diesen Aufruf gesetzt war,
und erwartet trotzdem die Ablehnung samt Feldnamen.

### 4. Was hinausgeht: **zwei** Werte, gemessen an der Nutzlast

Die Nutzlast entsteht in **einer** reinen Funktion:

```ts
buildAiFormRequest(input: { prompt: string; language: FormLanguage }): AiFormRequest
```

Alles, was der Adapter sendet, ist entweder ihr Rückgabewert oder **statisch**:
die Systemanweisung (eine Konstante), das Modell, die Token-Grenze. **Nichts
wird interpoliert** — kein Organisationsname, kein Kurzname, keine Logo-Referenz, keine
E-Mail, kein Name des Bearbeiters, kein bestehendes Formular, keine Antwort,
keine Teilnehmerdaten.

**Die Sprache ist ein benannter Platz, keine versteckte Konstante.**
`FormLanguage` ist heute eine geschlossene Aufzählung mit genau einem Wert
(`'de'`). Sie steht trotzdem als Parameter da, weil die Alternative — deutsch in
der Systemanweisung festzutackern — die Frage „was geht hinaus?" beim nächsten
Sprachwunsch neu aufmachte.

**Wie man das misst, und warum an der Nutzlast statt an der Absicht des Codes:**
der Test greift die **an den Adapter übergebene** `AiFormRequest` am Test-Doppel
ab, serialisiert sie zu JSON und prüft zweierlei:

1. **Positiv:** der Freitext und die Sprachkennung kommen darin vor.
2. **Negativ, mit Kanarien:** die Testeinrichtung legt Organisation, Nutzer, ein
   bestehendes Formular und eine abgesendete Antwort mit **eindeutigen,
   unverwechselbaren Zeichenketten** an (`ZZKANARIE-TENANT`, `ZZKANARIE-USER`,
   `ZZKANARIE-FORMTITEL`, `ZZKANARIE-ANTWORT`, …). Der Test sucht **jede** davon
   in der serialisierten Nutzlast und erwartet **keinen** Treffer.
3. **Strukturell:** die Nutzlast hat **keinen** Schlüssel `functions`,
   `mcp_servers` oder `container` — geprüft über die Schlüsselmenge, nicht über
   eine Behauptung im Kommentar. So macht „ein Werkzeug ergänzen" den Test rot
   (der Nachweis verlangt genau diese Formulierung, weil die naheliegende
   Fassung immer grün bliebe).

   ⚠️ **`tools` steht bewusst *nicht* auf dieser Liste.** Anthropics Weg zu
   erzwungenem JSON **ist** `tools` + `tool_choice` (Nr. 3(d)); ein pauschales
   „keine Werkzeugfelder" ginge also nicht. Was es schützen soll, bleibt —
   schärfer formuliert, weil es sonst eine Aufweichung wäre: der Freitext kauft
   dem Modell **keine Fähigkeit**, nur eine Form. Gemessen wird jetzt, dass `tools` **genau einen** Eintrag hat,
   dass er das Ausgabewerkzeug ist, dass sein `input_schema` byteweise die
   abgeleitete Form ist — und dass **kein** Eintrag ein Feld `type` trägt.
   Letzteres ist die eigentliche Sperre: genau dieses Feld kennzeichnet jedes
   serverseitige Werkzeug jener API (`web_search_*`, `web_fetch_*`,
   `code_execution_*`, `mcp_toolset`, Bash, Texteditor), und ein eigenes
   Werkzeug braucht es nie. Für die Mistral-Spalte bleibt die strenge alte
   Fassung gültig: dort ist `tools` **abwesend**, weil das Schema im
   `response_format` reist.

Eine Suche nach Kanarien ist stumpf und genau deshalb richtig: sie prüft die
**Bytes**, die hinausgehen, und nicht, ob jemand beim Bauen an Datensparsamkeit
gedacht hat. Wer künftig „das Formular als Kontext" mitschickt, macht sie rot.

**Der Freitext ist begrenzt**, bevor er hinausgeht: `AI_PROMPT_MAX = 2000`
Zeichen, als geteilte Konstante in `packages/shared`, vom Client für die UX und
vom Server als Wahrheit geprüft. Die drei Beispiele des Prototyps sind ein bis
drei Sätze; 2000 Zeichen liegen weit darüber und begrenzen zugleich die Rechnung
und die Größe dessen, was nach Nr. 8 dreißig Tage lang bei uns liegt.

**Der Freitext ist Fremdtext, und die Anwendung leitet daraus keine Fähigkeiten
ab.** Es gibt keine Werkzeuge (Punkt 3 oben), keinen zweiten Systemzweck, keinen
Netzzugriff des Modells. Die Rückgabe wird nie als HTML gerendert, sondern als
Formulardefinition geparst und über die bestehenden Komponenten gezeigt; ein
`<script>` im Fragetitel landet als **Text** im Titel (der Nachweis). Was ein
feindseliger Prompt in ein Formular schmuggeln kann, ist damit durch
`formSchema` begrenzt — Länge, Typen, Anzahl.

### 5. Modellwahl: eine kuratierte Auswahl je Anbieter, mit Vorgabewert

> ⚠️ **Wo die Konfiguration steht.** Anbieter, Modell, Region und Schlüssel
> liegen in den **systemweiten Einstellungen**, nicht in der Umgebung — siehe
> [„Die Konfiguration liegt in den Einstellungen, nicht in der
> Umgebung"](#die-konfiguration-liegt-in-den-einstellungen-nicht-in-der-umgebung)
> weiter unten. Die Tabelle hier nennt, was daneben in der Umgebung bleibt.

| Variable | Pflicht | Vorgabe | Bedeutung |
|---|---|---|---|
| `AI_REQUEST_TIMEOUT_MS` | nein | `60000` | Nr. 6 |
| `AI_USAGE_PURGE_INTERVAL_MS` | nein | `86400000` | nur die Taktung, **nie** die 30 Tage (Nr. 8) |

**Die Modellkennung ist eine kuratierte Auswahl, kein Freitextfeld**
(`AI_MODEL_CHOICES` in `@formsache/shared`, je Anbieter drei Einträge). Der
Grund ist nicht Bequemlichkeit: ein vertipptes `claude-opus-4` ließe sich
speichern und fiele erst beim ersten Formularentwurf als 404 des Anbieters auf —
an einer Stelle, an der niemand mehr an das Einstellungsfeld denkt. Jeder
Anbieter hat einen Vorgabewert: `claude-opus-5` bei Anthropic,
`mistral-large-latest` bei Mistral. `DEFAULT_AI_MODEL` und `AI_MODEL_CHOICES`
sind deshalb **vollständige** Abbildungen über `AiProvider`; ein neuer Adapter
bringt seine Kennung mit oder er übersetzt nicht.

**Das Auswahlkriterium ist das verschachtelte JSON-Schema dieser Anwendung** —
bei Anthropic als Eingabeschema eines erzwungenen Werkzeugaufrufs, bei Mistral
als `json_schema` im `response_format`. Ausdrücklich **nicht** `strict: true`:
der Mistral-Adapter sendet `strict: false`, weil das abgeleitete Schema Längen-
und Bereichsgrenzen trägt, an denen der strenge Modus jeden Aufruf abwiese. Ob
sich `strict` lohnt, ist eine der Messungen, die auf einen echten Schlüssel
warten — sie begründet hier keine Auswahl.

**Gelistet werden Aliasse, nicht die festesten Formen.** Der naheliegende
Einwand gegen einen Alias ist, dass er das Modell unter einer laufenden
Installation austauscht. Dagegen steht: **Reproduzierbarkeit ist ohnehin nicht
zu haben** — der Anbieter ändert den Preis eines Modells während dessen
Lebenszeit, und was eine feste Kennung *sicher* bringt, ist der Tag, an dem sie
abgekündigt wird und die Funktion stehen bleibt, bis jemand ein Release baut.

**Der Preis ist gemessen, nicht behauptet** (`api.eu.mistral.ai`): eine Antwort
auf `mistral-large-latest` meldet im Feld `model` **den Alias zurück**, nicht die
aufgelöste Kennung. `ai_usage.model` trägt damit den Alias. Deshalb steht
daneben eine zweite Spalte `model_resolved` — `model` bleibt *beobachtet* (was
der Anbieter meldete), `model_resolved` *abgeleitet*, welche datierte Fassung
sein Alias im Moment des Aufrufs meinte. Aufgelöst wird **beim Aufruf** über
`AiFormGenerator.resolveModel`, ohne Zwischenspeicher und ohne Hintergrundlauf:
bei 50 Aufrufen je Organisation und Monat ist eine zusätzliche Anfrage je
Entwurf nicht messbar und genauer als jeder Cache. Bei Anthropic bleibt die
Spalte leer — dessen Models-API führt kein Alias-Feld, und `resolveModel` sagt
das, statt einen Netzaufruf für nichts zu fahren.

⚠️ **Die Modellliste verrät nicht, welche der zusammengehörenden Kennungen die
feste ist** — sie nennt Aliasse symmetrisch. Die Entscheidung trifft
`mistral-model-alias.ts` an der *Gestalt*: `name-YYMM` ist fest, alles andere
wandert. Mehrdeutig heißt `null`, nicht „nimm die erste".

**Preise bleiben draußen.** Keine der beiden APIs liefert sie; eine
handgepflegte Preistabelle veraltete still. Die Anwendung liefert Mengen, die
Rechnung kommt vom Anbieter. (**Annahme A9**: Preise ändern sich.)

**Der Preis dieser Bauform ist benannt:** Mistral kündigt Modelle mit Datum ab.
Solange je Anbieter mehrere Einträge stehen, wechselt ein Betreiber ohne
Release; sind **alle** Einträge eines Anbieters abgekündigt, braucht es einen.
Ein **gespeicherter** Wert außerhalb der Liste bleibt wählbar und überlebt jedes
Speichern — sonst zöge das bloße Öffnen dieser Seite eine Installation still auf
ein anderes Modell.

⚠️ **Der Tippfehler ist damit nicht verschwunden, sondern umgezogen** — vom
Betreiber in die Liste, wo er *alle* Installationen träfe statt einer. Alle
sechs Kennungen stehen deshalb zusätzlich als Literal in `ai-config.test.ts`:
eine Prüfung, die nur Eigenschaften der Liste misst, bleibt auch bei verdrehten
Kennungen grün.

**Die Regel gilt serverseitig, nicht nur im Browser:**
`updateSystemAiSettingsRequestSchema` lehnt ein Modell ab, das in der Liste des
*anderen* Anbieters steht — und lässt eine Kennung, die in **keiner** Liste
steht, ausdrücklich durch. Sonst könnte der Abkündigungsplan eines fremden
Dienstes eine Zeile ungültig machen, die längst in der Datenbank liegt.

Das ist nicht nur Ehrlichkeit über eine Wissenslücke, sondern auch die bessere
Bauform: **ein wandernder Alias wäre als Vorgabe ohnehin falsch.** Er tauscht das
Modell unter einer laufenden Installation aus — und damit unter der Testtabelle
aus Nr. 1, deren aufgezeichnete Antworten dann etwas belegen, was so nicht mehr
läuft. Wer eine Installation betreibt, pinnt eine Kennung und weiß, welche.

**Warum `AI_*`-Präfixe statt der Vendor-üblichen Namen** (`ANTHROPIC_API_KEY`,
`MISTRAL_API_KEY`): weil die SDKs ihre eigenen Namen **aus der Umgebung selbst
lesen**, wenn man den Client ohne Argument baut. Ein unpräfixierter Name hieße,
dass eine Installation (oder die Maschine einer Entwicklerin) mit einem für etwas
ganz anderes gesetzten Schlüssel plötzlich eine konfigurierte KI hätte, und
„ohne Schlüssel 404" wäre dort nicht prüfbar. Deshalb **zusätzlich** eine
Bauvorschrift mit Nachweis: der Client wird **immer** mit ausdrücklichem
`apiKey` konstruiert, nie mit dem Nullargument-Konstruktor. *Nachweis:* ein Test
setzt `ANTHROPIC_API_KEY` in der Prozessumgebung, lässt `AI_ANTHROPIC_API_KEY`
weg und erwartet **404** und ein abwesendes Menü.

**Zwei Laufzeit-Abhängigkeiten**, die offiziellen SDKs beider Anbieter, in
`dependencies` und nicht in `devDependencies` — in `devDependencies` blieben
Test, Typecheck, Lint und Build alle grün und der Fehler zeigte sich erst als
Container, der beim ersten Aufruf stirbt (die Falle, die bereits für den
Excel-Schreiber ausdrücklich genannt wurde).

*Verworfen:* rohes `fetch` gegen beide REST-APIs. Es spart zwei Abhängigkeiten,
kostet aber zwei handgepflegte Auth-, Fehler- und Strukturierte-Ausgabe-Wege
gegen zwei sich bewegende Anbieter-APIs — und der öffentliche Pfad ist hier
**nicht** betroffen (anders als beim Upload, ADR-0014 Nr. 14: diese Route
verlangt eine Sitzung). Verworfen ferner ein einziger Schlüssel für „die KI"
ohne Anbieterbezug: dann entschiede der Schlüsselwert, welcher Anbieter läuft,
und „welcher Adapter wurde gewählt" wäre eine Vermutung statt eines
Nachschlagens.

### 6. Zeitlimit: **60 Sekunden**, unser Signal, **keine** Wiederholung

- **Die Frist ist unsere.** Der Aufrufer erzeugt ein `AbortSignal` mit
  `AI_REQUEST_TIMEOUT_MS` (Vorgabe 60 000) und übergibt es der Naht (Nr. 1). Sie
  ist **nicht** das Zeitlimit des SDK-Clients, denn dessen Vorgabe ist zehn
  Minuten und skaliert bei großen Ausgabegrenzen noch nach oben. Derselbe Schnitt
  wie in [ADR-0014 Nr. 14](0014-datei-upload.md): der Zähler und der Abbruch
  bleiben unsere, statt eine Bibliothekseigenschaft zu sein.
- **Der Adapter wiederholt nicht.** `maxRetries: 0` (bzw. das Gegenstück beim
  zweiten SDK). Beide SDKs wiederholen von sich aus — beim Anthropic-Client
  standardmäßig zweimal, bei 408/409/429/5xx und Verbindungsfehlern —, und
  Zeitüberschreitungen werden **mitgewiederholt**: die Wanduhr eines Aufrufs wäre
  dann `Zeitlimit × (Versuche + 1)`, und **ein** nach Nr. 7 gezählter Aufruf
  würde **dreimal** bezahlt. *Nachweis:* ein Transport-Doppel antwortet einmal
  mit 429 und **zählt die Versuche**; erwartet wird **genau einer**
  (**Annahme A4**, für beide SDKs gemessen statt geglaubt).
- **Die Wiederholung gehört dem Menschen.** Wer es erneut versuchen will, drückt
  den Knopf erneut — und das kostet einen weiteren gezählten Aufruf, sichtbar im
  Dialog. Eine unsichtbare Wiederholung ist Geld, das niemand angefordert hat.

**Warum 60 Sekunden.** Ein erzeugtes Formular ist strukturierte Ausgabe in der
Größenordnung weniger Kilobyte; die Ausgabegrenze des Adapters wird entsprechend
knapp gesetzt (Nr. 3(b) fängt eine zu knappe: `truncated`). Nach oben begrenzt
die Zahl die Zumutung: eine Minute Arbeitsphase ist die Grenze dessen, was ein
Bearbeiter vor einem Dialog wartet. **Annahme A3:** 60 s sind aus dieser
Überlegung geschätzt, nicht gemessen; gemessen wird sie in einem Lauf mit echten
Antworten.

**Was der Nutzer sieht.** Während des Laufs die Arbeitsphase; am
Ende entweder die Vorschau (Nr. 11) oder **je Fehlerfall einen eigenen deutschen
Satz**, der sagt, was war und ob ein zweiter Versuch hilft. Die Zuordnung
`AiFailureKind → Text` liegt **einmal** in `packages/shared`, aus demselben
Grund wie die Fehlerkategorien der Mail. Und der Satz, der weh tut, steht
trotzdem dabei: **„Dieser Versuch zählt auf euer Kontingent."** *Nachweis:* ein
Web-Test misst den gerenderten Text für alle sechs Fälle **und** die Anwesenheit
des Verbrauchshinweises im Fehlerfall.

**Was mit einer angefangenen Anfrage geschieht.** Sie läuft beim Anbieter
gegebenenfalls weiter und wird von ihm berechnet — daran ändert ein Abbruch
nichts, und genau deshalb wird **vor** dem Aufruf gezählt (Nr. 7). Bricht der
Browser ab (Navigation, Schließen), wird die ausgehende Anfrage **nicht**
mitabgebrochen: die Kosten hingen sonst an einem Netzhüpfer, und der Zähler wäre
mit der Wirklichkeit uneins. Das Ergebnis wird verworfen. **Es bleibt nichts
Halbes zurück** (der Nachweis), weil vor dem *Übernehmen* ohnehin nichts
gespeichert wird (Nr. 11). *Nachweis:* Anfrage mitten im Flug abbrechen → das
Doppel hat **genau einen** Aufruf gesehen, `ai_usage` hat **eine** Zeile, die
Zahl der Formulare ist **unverändert**.

### 7. Zählweise: **Aufrufe** sind die harte Größe, **Token** die Beobachtung — und ein Fehlschlag zählt **einmal**

**Gezählt wird in Aufrufen.** Eine Zeile in `ai_usage` ist ein Aufruf; das
Kontingent einer Organisation ist eine Zahl von Aufrufen je Kalendermonat
(Europa/Berlin, gelesen über `berlin-time.ts` — der Monat ist die Einheit, in der
die Rechnung kommt und in der ein Kassenwart denkt).

**Warum Aufrufe und nicht Token als Grenze.** Die Spezifikation Nr. 7 erlaubt ausdrücklich
Schätzwerte. Token wären die genauere Währung und sind als Grenze trotzdem
falsch: sie sind **erst nach** dem Aufruf bekannt, also könnte eine
Token-Obergrenze den teuren Aufruf nicht verhindern, der sie reißt — verlangt ist
aber genau das Gegenteil („bevor die Anfrage hinausgeht", Spy belegt: nicht
gerufen). Ein Aufruf ist vor dem Aufruf bekannt und deshalb die einzige Größe,
die eine *Sperre* tragen kann.

**Token werden trotzdem erfasst**, wo der Anbieter sie meldet
(`inputTokens`/`outputTokens` in `AiUsageSample`, sonst `null`) — als
Beobachtung für die Kostenzuordnung, nicht als Grenze. Sie sind Selbstauskunft
des Anbieters (**Annahme A8**).

**Die Bauform ist die harte:** in einer Transaktion `SELECT … FOR UPDATE` auf die
Kontingentzeile der Organisation, zählen, schreiben — dieselbe wie das Antwort- und
Teilnehmerlimit. `count()` + `insert` besteht den sequentiellen Lauf und
überbucht parallel (nachgewiesen: 15 statt 10).

**Hochgezählt wird *vor* dem Aufruf**, nicht danach. Ein Zähler dahinter kostet
Geld und nicht nur Zustand.

**Und die Frage, die damit noch offenbleibt: ein Fehlschlag des Anbieters zählt *einmal*.**
Drei Gründe, der dritte kippt es:

1. **Es ist, was der Anbieter berechnet.** Eine abgeschnittene oder abgelehnte
   Antwort ist erzeugte Ausgabe und kostet Geld; eine Zeitüberschreitung auf
   unserer Seite hält den Anbieter nicht auf. Ein Fehlschlag, der bei uns nichts
   kostet, ist eine Lüge über die Rechnung.
2. **Doppelt wäre willkürlich.** Es gibt keinen Vorgang, der zweimal stattfindet;
   ein Tag mit schlechter Verbindung fräße das Monatsbudget einer Organisation ohne
   ein einziges erzeugtes Formular.
3. **Gar nicht wäre eine unbegrenzte Schleife auf fremde Rechnung.** Ein Adapter,
   der *deterministisch* scheitert — falscher Schlüssel, falsche Modellkennung,
   Anbieter im Ausfall — erzeugte dann beliebig viele bezahlte Aufrufe; das
   Rate-Limit aus Nr. 12 deckelt die *Frequenz*, nicht die *Summe*.

**Und „zählt einmal" ist keine nachträgliche Regel, sondern die Abwesenheit eines
Weges:** es gibt **keinen** Code-Pfad, der das Kontingent zurückgibt. Kein
Refund, kein `catch`, der dekrementiert.

*Der Test, der es festnagelt* (verlangt ist, dass **eines von beidem** festgenagelt
wird): Restbudget 5, das Doppel scheitert **immer**; fünf Aufrufe werden
durchgelassen, der sechste bekommt **429**, das Doppel hat **fünf** Aufrufe
gesehen, und `ai_usage` trägt **fünf** Zeilen mit `outcome != 'ok'`. Die
Nachstellung dazu: einen Rückgabe-Pfad im Fehlerfall einbauen → der sechste
Aufruf wird durchgelassen, der Test rot.

**Das Limit ist tenant-gebunden** (der Nachweis): jede Lese- und Schreibquery
geht über den `TenantScope`-Delegaten; Organisation A kann das Budget von Organisation B weder
verbrauchen noch lesen. Ein Kontingent von **0** ist zugleich der Aus-Schalter
je Organisation (Nr. 9).

### 8. `ai_usage`: **eine** Zeile, zwei Lebensdauern

```
ai_usage
  id                uuid  (pk)
  tenant_id         Pflicht, in jeder Query
  user_id           auslösende Person, ON DELETE SET NULL
  created_at        Zeitpunkt
  provider          'anthropic' | 'mistral'
  model             Modellkennung als Daten (Nr. 2)
  outcome           'ok' | die sechs Fehlerfälle (Nr. 2)
  input_tokens      int NULL
  output_tokens     int NULL
  prompt            text NULL   ← verfällt nach 30 Tagen
  prompt_erased_at  timestamptz NULL
```

**Warum eine Tabelle und nicht zwei.** Zähler und Text entstehen in **einem**
Vorgang und in **einer** Transaktion (Nr. 7). Zwei Tabellen wären ein zweiter
Schreibpfad, den ein künftiger dritter Aufrufer vergessen kann — genau das,
was ausdrücklich vermieden werden soll.

**Warum der Purge den Text auf `NULL` setzt statt die Zeile zu löschen.**
Der Nachweis verlangt, dass der Verbrauchszähler **bleibt**, wenn der Text
verfällt; sonst wäre das Limit nach 30 Tagen zurückgesetzt. Das ist genau die
Nachstellung: „den Text mit dem Zähler in einer Zeile löschen →
der Test wird rot". Das `UPDATE` setzt zugleich `prompt_erased_at`, damit „gelöscht"
von „hatte nie einen" unterscheidbar bleibt — eine gescheiterte Anfrage kann
durchaus ohne gespeicherten Text entstehen, und ohne diese Spalte sähe sie aus
wie eine gelöschte.

**Und „physisch" heißt hier, was es überall in diesem System heißt:** der Wert
ist aus der lebenden Zeile fort, kein Flag verdeckt ihn, und der Nachweis ist ein
**rohes** `SELECT prompt FROM ai_usage WHERE created_at < …` (Ergebnis: nur
`NULL`) plus ein `count(*)` **ohne Filter** (Ergebnis: die Zeilen stehen noch).
Ein Test, der das Repository fragt, belegte nur, dass das Repository filtert.
**Annahme A6** dazu am Ende: MVCC-Tupelversionen, WAL und Sicherungen sind davon
nicht erfasst — das gilt für jede Löschzusage dieser Anwendung gleichermaßen und
wird durch diese Nummer weder besser noch schlechter.

**Der Job hat Startlauf und Intervall**, nach der Bauform von
`MailLogPurgeService`: eine injizierte Uhr, ein Lauf beim Modul-Init, danach das
Intervall. Ohne den Startlauf löscht eine täglich neu ausgerollte Installation
**nie** — der Betriebsfehler (der Nachweis).

**Konfigurierbar ist nur die Taktung, nie die Frist.** `AI_PROMPT_RETENTION_DAYS`
ist eine Konstante in `packages/shared`, gelesen vom Purge **und** von dem
Hinweis, den die Oberfläche über die Aufbewahrung macht — dieselbe Begründung wie
bei `TRASH_RETENTION_DAYS` und `UNCLAIMED_FILE_LIFETIME_MS`: eine
Umgebungsvariable dafür legte eine Löschzusage, die Oberfläche fortwährend
macht, in die Hand eines Betreibers.

**Der Purge arbeitet über Organisationen hinweg** — kein Request, kein Aufrufer, kein
Tenant-Parameter — und braucht deshalb, wie `files/purge/**` und der
Mail-Worker, einen Eintrag auf der Prisma-Positivliste in `eslint.config.js`:
`apps/api/src/ai/purge/**`, **nicht** `apps/api/src/ai/**`. Die Gegenprobe, die
den Eintrag vertretbar macht: der Lese- und Schreibpfad der Anwendung
(`apps/api/src/ai/**` ohne `purge`) steht **nicht** darauf und geht über den
`TenantScope`-Delegaten.

**Beim Löschen einer Organisation** gehen die Zeilen mit (Cascade über `tenant_id`);
beim Entfernen einer Person bleibt die Zeile als Kostenbeleg stehen und
verliert ihren Personenbezug (`SET NULL`). *Wie lange eine Zeile **ohne** Text
lebt, entscheidet dieser ADR nicht* — siehe die Tabelle am Ende, und ausdrücklich
**nicht** „wird mit Nr. 81 entschieden": Nr. 81 entscheidet den Text und nur den.

### 9. Ohne Schlüssel gibt es die Funktion nicht — **eine** Funktion, zwei Verbraucher

**Die Verfügbarkeit ist eine reine Funktion der Konfiguration:**

```ts
aiAvailable(env: ApiEnv): boolean
//  AI_ENABLED !== false  &&  AI_PROVIDER gesetzt  &&  Schlüssel gesetzt  &&  Modell aufgelöst
```

Sie hat **zwei** Verbraucher und nur zwei: das Merkmal in der Sitzungsnutzlast
(`sessionUserSchema` bekommt `aiFormsAvailable: boolean`) und den Guard vor der
Route. Damit **können Menü und Route nicht auseinanderlaufen** — die Nachstellung
„den Schalter nur die Oberfläche ausblenden lassen → der Nachweis rot, weil
er die Route misst" adressiert genau das. *Nachweis:* ein Test fährt alle vier
Konfigurationen (nichts gesetzt / vollständig / `AI_ENABLED=false` / Provider
ohne Modell) und prüft **Merkmal und Route gemeinsam**.

**Die Route antwortet 404, nicht 503.** „Gibt es hier nicht" ist eine andere
Aussage als „ist gerade kaputt": Eine 503 lüde zum Wiederholen ein und
verspräche, dass es zurückkommt.

**Die Anwendung startet trotzdem** — und das ist die bewusste Abweichung von
[ADR-0014 Nr. 2](0014-datei-upload.md), wo `FILE_STORAGE_DIR` den Start
verweigert. Der Unterschied ist nicht Geschmack: der **Datei-Upload ist MUST**
 und ein Teilnehmer merkt sein Fehlen mitten in einer Anmeldung, wo niemand
mit einem Monitor hinschaut; die **KI ist SHOULD**, ihr Fehlen ist sofort und
harmlos sichtbar (der Eintrag ist weg), und eine bestehende Installation, die
nach diesem Update nicht mehr startet, weil sie keine KI will, wäre eine Zumutung ohne
Ertrag. `AI_ANTHROPIC_API_KEY` und `AI_MISTRAL_API_KEY` sind deshalb
`.optional()` — die **ersten** optionalen Variablen des Env-Vertrags.

**Aber der halbe Wunsch scheitert laut.** Ist `AI_PROVIDER` gesetzt und der
zugehörige Schlüssel (oder bei Mistral das Modell) fehlt, **scheitert der
Start** — mit `describeEnvFailure()`, das beide Variablen beim Namen nennt.
Begründung: `AI_PROVIDER` zu setzen *ist* die Erklärung „ich will diese
Funktion"; sie dann still auf 404 laufen zu lassen, wäre die leise Variante des
Fehlers, gegen den ADR-0014 Nr. 2 Grund 2 steht. Technisch ist das ein
`superRefine` über Felder im Env-Schema, **keine** Pflichtvariable — der
Unterschied ist genau das, was der Nachweis misst.

**Zwei Aus-Schalter, zwei Reichweiten:** `AI_ENABLED=false` schaltet die Funktion
**installationsweit** ab (die Spezifikation nennt das „Feature abschaltbar", Nr. 9); ein
Kontingent von **0** schaltet sie **für eine Organisation** ab (Nr. 7), ohne dass jemand
an die Umgebung muss. Der benannte Preis des Env-Schalters: er braucht einen
Neustart. Getragen, weil der schnellste Hebel eines Betreibers um drei Uhr
morgens ein geändertes `.env` plus `docker compose up -d` ist — derselbe Hebel
wie bei jedem `*_INTERVAL_MS=0` dieser Anwendung —, und weil ein Schalter in den
systemweiten Einstellungen (ADR-0011) einen Schreibpfad, ein Recht und eine
Oberfläche kostet. Er steht als offener Punkt in der Tabelle am Ende.

**Der Env-Vertrag hat vier Ufer** (`packages/shared/src/env-contract.test.ts`),
und jede der sieben Variablen aus Nr. 5 fährt über alle vier: `apiEnvSchema`,
`.env.example` (Name + Zweck, **ohne Wert** bei den Schlüsseln — ein
Beispielschlüssel wäre echtes Schlüsselmaterial im Repo, dieselbe Regel wie bei
`SECRET_BOX_KEY`), der `environment:`-Block des `api`-Dienstes in
`docker-compose.yml`, und `apps/api/test/support/create-test-app.ts`. Der Wächter
ist eine **Gleichheit**, kein Obermengenvergleich: eine vergessene Variable macht
genau eine Stelle rot.

### 10. Die Schlüssel liegen in der Umgebung, **je Installation** — nicht je Organisation verschlüsselt

Die Abgrenzung gibt das vor; hier die Begründung, warum es **für jetzt**
reicht, und was ein späterer Wechsel kostete.

**Warum es reicht:**

1. **Es gibt keine fachliche Frage, die es beantwortet.** Ein Schlüssel je Organisation
   trennte *Kosten* — und die trennt bereits `ai_usage` mit `tenant_id` und
   einem Kontingent je Organisation (Nr. 7), ohne einen zweiten Ort für Geheimnisse.
2. **Der Betreiber ist einer.** Anders als bei SMTP (ADR-0013) und OIDC
   (ADR-0005), wo *jede Organisation* eine eigene Identität und einen eigenen IdP hat,
   gibt es keine Organisation, die einen eigenen KI-Vertrag hätte. Ein Feld dafür wäre
   eine Einladung, einen zu schließen, den niemand geprüft hat.
3. **Jedes Geheimnis in der Datenbank ist ein Entschlüsselungspfad mehr.** Die
   `SecretBox`-Kette samt ihrer Redigier-Regeln existiert für OIDC- und
   SMTP-Geheimnisse; ein dritter Nutzer hieße ein dritter Weg, auf dem ein
   Klartext irgendwo herausfallen kann.

**Was ein späterer Wechsel kostete** — damit die Zahl beim nächsten Mal nicht
neu geschätzt wird: eine Spalte auf `tenant` (gesiegelt über `SecretBoxService`,
mit Kontext-Bindung), eine Oberfläche im Reiter der Organisation-Admins samt Rechten, ein
zweiter Schreibpfad mit derselben Redigier-Regel wie SMTP (**genau die Stelle,
an der zuvor zweimal ein Geheimnis weitergegeben wurde**), eine Auflösungsregel
„Organisation-Schlüssel sonst Installationsschlüssel" samt Anzeige der Herkunft (die
Erfahrung: eine wirksame Einstellung, die man nicht sehen kann, ist
ein eigenes Arbeitspaket), ein AV-Vertrag **je Organisation** statt einem, und der
Verlust der Vorhersagbarkeit der Rechnung. Das ist ein eigenständiges Vorhaben, kein
Nebenzug.

**Was jetzt schon gilt, weil es sonst später teuer wird:** ein Schlüssel wird
**nie** an den Client gegeben und **nie** protokolliert. *Nachweis:* ein
Test prüft, dass keine API-Antwort und kein Frontend-Bundle den Schlüsselwert
trägt, und die bestehende Redigier-Regel der Geheimnisse gilt unverändert.

### 11. Die Übernahme ist ein zweiter, ausdrücklicher Schritt — und speichert **nichts** vorher

Die Route liefert das geparste Ergebnis zurück und **speichert kein Formular**.
Erst *Übernehmen* legt über den **bestehenden** Erzeugungspfad ein **neues**
Formular an — denselben, den das Einsetzen einer Vorlage benutzt, samt seiner
ID-Vergabe (Nr. 3(a), der Nachweis).

Begründung: ein zwischengespeicherter KI-Entwurf wäre ein **vierter Ort mit
Modellausgabe** und ein **zweiter Erzeugungspfad** neben dem der Vorlagen —
genau das, was ausdrücklich vermieden werden soll. Und der Prototyp lädt das Ergebnis direkt in den Builder;
davon weichen wir bewusst ab, weil ein überschriebener Entwurf Datenverlust ohne
Papierkorb wäre.

*Nachweis:* nach einem Aufruf und nach *Verwerfen* ist die Zahl der Formulare
**unverändert**; die einzige Spur ist die `ai_usage`-Zeile.

### 12. Rechte, Modulgrenze, Rate-Limit

- **`can_build`.** Ohne Sitzung **401**, ohne `can_build` **403**, über die
  Tenant-Grenze **404** — je ein Test, der den **unerlaubten** Zugriff scheitern
  sieht.
- **Die Reihenfolge ist ausgeschrieben, weil die beiden Prüfungen sonst wie ein Widerspruch
  aussehen und jemand die falsche „repariert":** die Guard-Kette läuft
  **zuerst**, die Verfügbarkeitsprüfung (Nr. 9) **danach**. Also: nicht
  konfiguriert **und** ohne Sitzung → **401**; nicht konfiguriert, mit Sitzung
  und `can_build` → **404**. Das ist kein Orakel gegenüber Fremden — es erzählt
  einem angemeldeten Bearbeiter dasselbe, was sein eigenes Menü ihm ohnehin
  sagt.
- **Modulgrenze.** `AiModule` erscheint **nicht** im Modulgraphen des
  öffentlichen Pfads. Den Nachweis trägt ein **Modul-Shape-Test** nach dem
  Vorbild von `apps/api/test/files/module-shape.spec.ts`, **nicht** der Lint: ein
  Argument über den Modulgraphen ist nicht mechanisch — ESLint sieht direkte
  Import-Zeichenketten, nicht die transitive DI-Kette — **ein** Import „nur für
  die Uhr" hebelt eine solche Liste aus, während ihr Kommentar das Gegenteil
  behauptet. Die `no-restricted-imports`-**Sperrliste** für
  `apps/api/src/public/**` wird **zusätzlich** um das KI-Muster ergänzt.
- **Eigenes Rate-Limit.** `@UseGuards(ThrottlerGuard)` **und**
  `@Throttle({ default: { limit: 6, ttl: 60_000 } })` an der Route — beides, weil
  es keinen globalen `APP_GUARD` für den Throttler gibt und ein Dekorator ohne
  Guard vom gebauten Zustand nicht zu unterscheiden ist. Es bleibt bei **einem**
  `ThrottlerModule.forRoot`. Die Zahl ist ausdrücklich **nicht** der
  Kostenschutz — das ist das Kontingent aus Nr. 7; sie bremst eine hängende
  Oberfläche, die den Knopf schneller drückt als ein Mensch.

  > **Die Zahl ist `limit: 6`**, weil ein Aufruf bis zu
  > `AI_REQUEST_TIMEOUT_MS` belegt: sechs je Minute sind ungefähr „sechs Aufrufe
  > dieser Organisation gleichzeitig offen".
  >
  > ⚠️ **Dekorator *und* Guard, und beides ist gemessen.** Ein Dekorator ohne
  > Guard ist vom gebauten Zustand nicht zu unterscheiden — `test/ai/rate-limit.spec.ts`
  > wird rot, wenn `@UseGuards(ThrottlerGuard)` von der Route verschwindet.

### 13. Die DSGVO-Seite

**Auftragsverarbeitung.** Der gewählte Anbieter ist **Auftragsverarbeiter**
(Art. 28 DSGVO): er verarbeitet in unserem Auftrag Text, in dem ein Bearbeiter
Personenbezogenes untergebracht haben kann. Ein AV-Vertrag mit ihm ist
**Betreiberpflicht** und **muss vor dem Setzen des Schlüssels vorliegen**. Die
Anwendung kann das nicht prüfen — deshalb steht es als Satz im Kommentar neben
der Variablen in `.env.example`, und das Setzen eines Schlüssels **ist** die
Erklärung des Betreibers, dass der Vertrag besteht. Das ist eine
Dokumentationskontrolle und keine technische; sie wird hier als solche benannt
statt als Zusage getarnt.

**Ort der Verarbeitung — für Mistral jetzt der EU-Endpunkt, für Anthropic
weiterhin nicht zugesichert.**

> **Der Beleg liegt im Repo**, nicht in einer Sekundärquelle:
> `esm/lib/config.js` des installierten Mistral-SDK führt **drei** Endpunkte —
> `global`, **`eu` (`https://api.eu.mistral.ai`)** und `us`.
> **Entscheidung: `server: 'eu'`**, weil die Installation EU-gehostet ist; ein
> still gepinntes `global` wäre die stillschweigende Gegenentscheidung. Der
> Klartextschlüssel und der Freitext bleiben damit
> so weit in der EU, wie eine Endpunktwahl das leisten kann. Festgenagelt wird
> sie von `apps/api/test/ai/key-confinement.spec.ts`, das `api.eu.mistral.ai`
> als Host **verlangt** statt bloß „einen Mistral-Host".
>
> ⚠️ **Was das nicht belegt, und was es kostet:** ob der EU-Endpunkt dieselben
> Modelle führt wie der globale, ist von hier aus nicht prüfbar (die
> Anbieterdoku antwortet weiterhin HTTP 403). Ein `AI_MODEL`, das es nur global
> gibt, scheitert beim ersten Aufruf. Der Endpunkt ist bewusst **keine**
> Umgebungsvariable — siehe die offene Zeile „Der Mistral-Endpunkt als
> Umgebungsvariable" in der Tabelle am Ende.

Für **Anthropic** ist die Verarbeitung in der EU unverändert **nicht**
belegt. Die KI bleibt damit die eine Stelle, an der Daten diese EU-gehostete
Installation („Nicht-funktional") verlassen können. Drei Dinge tragen diese
Aussage, statt sie zu bestreiten:

1. Die Funktion ist **aus**, solange niemand sie einschaltet (Nr. 9).
2. Hinaus geht als **Nutzlast** nur der Freitext des Bearbeiters und die
   Sprachkennung (Nr. 4) — keine Antwortdaten, keine Teilnehmerdaten, keine
   Organisationsdaten. *Dazu kommt, was ein HTTP-Client nun einmal mitschickt, und
   auch das wird benannt statt unterschlagen:* die Kennung des SDK, unsere
   Paketversion und die Protokollversion des Anbieters. Was die **Maschine**
   benennt — Betriebssystem, Prozessorarchitektur und die genaue
   Node-Version — sendet das Anthropic-SDK von sich aus als
   `X-Stainless-OS`/`-Arch`/`-Runtime-Version`; der Adapter schließt diese drei
   ausdrücklich.
3. Der Freitext liegt **bei uns** und verfällt nach 30 Tagen (Nr. 8); was der
   Anbieter aufbewahrt, regelt sein AV-Vertrag und nicht dieser ADR.

**Annahme A7** dazu am Ende. Ob ein Anbieter mit zugesicherter EU-Verarbeitung
verpflichtend wird, ist eine Festlegung des Betreibers und steht in der
Tabelle am Ende.

**Verarbeitungsverzeichnis.** Es braucht **einen** Eintrag, und dieser ADR nennt
seine Felder, damit später nicht die Frage steht, was hineingehört: *Zweck*
(Erzeugung eines Formularentwurfs aus einem Freitext), *Betroffene* (Bearbeiter
mit `can_build`; mittelbar jede Person, die ein Bearbeiter im Freitext nennt),
*Datenkategorien* (Freitext, Zeitpunkt, auslösende Person, Organisation, Verbrauch),
*Empfänger* (der konfigurierte Anbieter), *Drittlandtransfer* (offen, siehe
oben), *Löschfrist* (30 Tage, physisch). Der Text selbst ist eine
Betreiberpflicht und gehört in die Betriebsdokumentation — Adressat in der
Tabelle am Ende.

**Wie sich Nr. 81 zu den anderen Fristen verhält.** Ab diesem ADR heißen die
Löschfristen des Systems:

| Was | Frist | Warum diese |
|---|---|---|
| Papierkorb (Formulare, Antworten) | **30 Tage** | Umkehrbarkeit eines Versehens |
| **KI-Anfragen (Freitext)** | **30 Tage** | dieselbe Frist wie der Papierkorb, damit es **eine** Zahl bleibt, die man sich merkt — und lang genug, dass eine Kostenbeschwerde ihren Anlass noch findet  |
| Entwürfe samt ihrer Anlagen | **30 Tage** | die Spezifikation Nr. 63, Nr. 82 |
| Anlage **ohne** Eigentümer | 24 Stunden | ADR-0014 Nr. 15 |
| `mail_log` | **90 Tage** | Versandnachweis über eine Anmeldefrist hinweg |

Die KI-Anfrage ist damit die **kürzeste** der drei 30-Tage-Fristen im Sinne von:
sie beginnt mit dem Vorgang und nicht mit einem Zustandswechsel, und sie hat
**keinen** Weg, verlängert zu werden. Der `mail_log` ist die einzige längere, und
sie ist es aus einem anderen Grund (Nachweis der Zustellung, nicht Nachweis eines
Anlasses).

**Die Aufzählung in `CONTRIBUTING.md` wird beim Bau mitgezogen** — an anderer
Stelle, nicht von diesem Dokument: eine Liste, die eine
Frist nicht kennt, ist die Stelle, an der die nächste vergessen wird.

---

## Was dieser ADR **nicht** entscheidet — und wer es entscheidet

> ⚠️ **Diese Tabelle ist kein Abstellgleis.** Früher hat eine Zeile der Form
> „wird mit jener entschieden" eine Frage verdeckt, die dann nie entschieden
> wurde ([ADR-0014](0014-datei-upload.md), erste Zeile derselben Tabelle: „Das
> ist dieselbe Eigentümer-Frage wie die Zeile darunter" — **war sie nicht**).
> Jede Zeile hier bekommt deshalb einen **Adressaten** und, wo möglich, ein
> **Kriterium**, an dem man erkennt, dass sie fällig ist.

**Was inzwischen entschieden ist**, und deshalb hier nur noch als Ergebnis
steht:

- **Die Mistral-Modellkennung** ist belegt und steht in der kuratierten Auswahl
  aus Nr. 5; Vorgabe ist `mistral-large-latest`.
- **Der Mistral-Endpunkt ist keine Umgebungsvariable und keine freie URL**,
  sondern eine **Auswahl in den systemweiten Einstellungen** mit den drei
  erlaubten Werten `eu`/`global`/`us` und der Vorgabe `eu` — eine geschlossene
  Aufzählung statt einer Adresse.
- **Eine `ai_usage`-Zeile *ohne* Text** verliert ihren Personenbezug nach
  `AI_USAGE_PERSON_RETENTION_DAYS` = **365 Tagen** physisch
  (`ai-prompt-purge.service.ts`); danach lebt sie ohne Person als Verbrauchszahl
  weiter (Nr. 8).
- **Der KI-Aus-Schalter steht in den systemweiten Einstellungen**, nicht in der
  Umgebung — und mit ihm Anbieter, Modell, Region und der versiegelte Schlüssel.
  Ein Schalter *neben* `AI_PROVIDER` wären zwei Quellen für denselben Zustand
  gewesen.
- **Kein dritter Anbieter und kein lokales Modell.** Die Naht trägt zwei Adapter
  und eine Vertragstabelle, die beide durchläuft; ein dritter brauchte eine
  dritte Spalte darin und ein eigenes ADR. Ohne konkreten Anlass ist das Vorrat.

**Was offen bleibt:**

| Offen | Wer entscheidet | Woran man merkt, dass es fällig ist |
|---|---|---|
| **Ob ein Anbieter mit zugesicherter EU-Verarbeitung Pflicht wird** (Nr. 13). Mistral läuft über seinen EU-Endpunkt, Anthropic nicht | **Betreiber** bzw. sein Datenschutzbeauftragter | Sobald ein AV-Vertrag geschlossen werden soll: liegt darin eine Zusage zur Verarbeitung in der EU? Wenn nein, ist zu entscheiden, ob die Funktion trotzdem eingeschaltet wird |
| **Der Text des Eintrags im Verarbeitungsverzeichnis** (Felder stehen in Nr. 13) | **Betreiber**; Ablage in der Betriebsdokumentation ([`docs/kb/`](../kb/README.md)) | Der Eintrag nennt alle sechs Felder aus Nr. 13. Wird die Funktion vorzeitig eingeschaltet, wird er vorgezogen — das Einschalten ist der Auslöser, nicht ein Termin |
| **Ob die strukturierte Ausgabe auf `strict` umgestellt wird** (Nr. 3(d)). Das Schema reist als Hinweis; erzwungene Dekodierung verlangt `additionalProperties: false` überall und **jede** Eigenschaft in `required` — die abgeleitete Form erfüllt beides nicht. Der Preis eines Fehlversuchs ist hoch: eine abgewiesene Anfrage bei *jedem* Aufruf, abgebildet auf `unavailable` | **Ein Testlauf mit echtem Verkehr**, mit konfiguriertem Schlüssel | Die dort gezählte Ablehnungsquote aus A5. Ist sie erträglich, bleibt es beim Hinweis; ist sie es nicht, ist die Frage **nicht** „strict einschalten", sondern welche Grenzen die abgeleitete Form abgeben kann, ohne dass ein zweites Schema entsteht (Nr. 3(a)). Eine handgeschriebene Zweitschrift bleibt ausgeschlossen |
| **Ob die KI *bestehende* Formulare ändern darf** (heute erzeugt sie nur neue, Nr. 11) | **Betreiber** | Sobald jemand „mach mir aus diesem Formular …" wünscht. **Dann wäre der Nachweis neu zu verhandeln**, denn das bestehende Formular ginge hinaus — das ist der eigentliche Preis, nicht die Oberfläche |
| **Kostensenkung durch Prompt-Caching oder ein kleineres Modell** | **Betreiber, nach der ersten Rechnung** — *(schwächster Adressat dieser Tabelle: es gibt heute niemanden, der die Zahl kennt)* | Die in einem Testlauf mit echtem Verkehr gemessenen Token je erzeugtem Formular, gegen die Kontingente aus Nr. 7 gehalten |
| **Ob die drei Beispiel-Prompts je Organisation pflegbar sind** | **eigenes Frontend-Paket** | Sie stehen statisch und bleiben es, bis eine Organisation eigene verlangt |
| **Fortschrittsanzeige statt Arbeitsphase** (Streaming, Nr. 1 verwirft es für die Naht) | **Dasselbe Frontend-Paket**, mit der Messung aus Nr. 6 | Wenn 60 Sekunden Arbeitsphase in einem Testlauf mit echtem Verkehr als unzumutbar auffallen. Eine Fortschrittsanzeige **ohne** Streaming (geschätzter Balken) ist dabei die billigere Antwort und zuerst zu prüfen |

---

## Annahmen — als solche markiert

- **A1 — die SDK-Hilfen für strukturierte Ausgabe werden nicht benutzt.**
  `z.toJSONSchema(aiFormDraftSchema)` liefert ein brauchbares Ergebnis
  (11 780 Byte mit `$defs`), von Hand geschrieben wurde nichts. Offen ist eine
  Stufe weiter und steht in der Tabelle der offenen Punkte: ob die Anbieter
  dieses Schema in ihrem **strikten** Modus annehmen. Nach ihrer eigenen
  Dokumentation nicht, und gemessen ist auch das nicht — ohne Schlüssel gibt es
  hier keine Messung.
- **A3 — 60 Sekunden reichen.** Geschätzt aus der Größe eines Formulars, nicht
  gemessen. Gemessen wird sie in einem Lauf mit aufgezeichneten und echten
  Antworten.
- **A4 — die SDKs wiederholen von sich aus.** Für Anthropic dokumentiert
  (zweimal, bei 408/409/429/5xx und Verbindungsfehlern, Zeitüberschreitungen
  eingeschlossen); für Mistral unbekannt. Deshalb **misst** der Vertragstest die
  Zahl der Transportversuche, statt sie zu glauben (Nr. 6).
- **A5 — strukturierte Ausgabe garantiert gültiges JSON, nicht ein brauchbares
  Formular** — und die Garantie gilt ausdrücklich **nicht**, wenn die Antwort an
  der Token-Grenze endet oder der Anbieter ablehnt. Genau dafür gibt es
  `truncated` und `refused` (Nr. 2). Wie oft der volle Parse aus Nr. 3(b) trotz
  gültigen JSONs ablehnt, ist unbekannt und wird in einem Testlauf mit echtem
  Verkehr gezählt. ⚠️ Das Schema geht zwar mit, aber **ohne** `strict` (Nr. 3(d)),
  ist also ein Hinweis und keine erzwungene Dekodierung — „garantiert gültiges
  JSON" gilt hier folglich in **keiner** Richtung, und die gezählte Quote ist
  genau deshalb die Zahl, die dieser Testlauf liefern muss.
- **A6 — „physisch" heißt: aus der lebenden Zeile.** MVCC-Tupelversionen bis zum
  `VACUUM`, WAL und Sicherungen sind davon nicht erfasst. Das gilt für **jede**
  Löschzusage dieser Anwendung (`mail_log`, Papierkorb, Dateien) und wird hier
  genannt, damit die 30 Tage nicht mehr versprechen, als jede andere Frist auch.
- **A7 — der Ort der Verarbeitung ist *für Anthropic* nicht zugesichert**
  (Nr. 13). Die EU-Zusage gilt für die Installation, nicht für den KI-Anbieter.
  Für **Mistral** ist das keine Annahme, sondern eine Wahl — das installierte
  SDK führt einen EU-Endpunkt (`https://api.eu.mistral.ai`), der Adapter pinnt
  ihn, und ein Test verlangt ihn. Was für Mistral offen bleibt, ist nicht der
  *Ort*, sondern ob der EU-Endpunkt dieselben Modelle führt — Tabelle am Ende.
- **A8 — die Token-Angaben des Anbieters sind Selbstauskunft.** Deshalb ist die
  harte Größe der **Aufruf** und das Token die Beobachtung (Nr. 7).
- **A9 — die Preise aus Nr. 5 (5 $ / 25 $ je Mio. Token) sind der Stand vom
  2026-08-06.** Sie stehen dort als Begründung einer Modellwahl, nicht als
  Zusage; sie ändern sich ohne unser Zutun.

---

## Consequences

- **Diese Anwendung ruft zum ersten Mal einen fremden Dienst.** Jedes Paket
  dieser Arbeit trägt ein `security`-Review, und das ist nach diesem
  ADR nicht weniger nötig, sondern gezielter: dieses Dokument sagt, wo
  hingeschaut wird — Nutzlast (Nr. 4), Zähler (Nr. 7), Schlüssel (Nr. 10),
  Modulgrenze (Nr. 12).
- **Die erste optionale Variable im Env-Vertrag entsteht hier.** Bisher war jede
  Variable entweder Pflicht ohne Vorgabe oder optional mit Vorgabewert; die
  Schlüssel aus Nr. 5 sind **optional ohne Vorgabewert**, und die
  Pflicht-Bedingung ist ein Feldvergleich. Der Wächter aus
  `env-contract.test.ts` muss das aushalten — wenn er es nicht tut, ist das ein
  Befund und keine Ausnahme.
- **Der Verbrauch ist ein Zustand, der Geld bedeutet.** Bis heute war jeder
  Zähler dieser Anwendung eine Frage von Plätzen, Zeilen oder Bytes. Ein
  falscher Zähler kostet hier Geld, und der Fehler heilt nicht durch einen
  Neustart — deshalb liegt die Zählung in der Datenbank und in einer
  Transaktion, nicht im Prozessspeicher wie die Rate-Limits.
- **Eine Ablehnung des vollen Parse (Nr. 3(b)) ist der Regelfall, nicht der
  Ausnahmefall**, solange die Grenzen des Schemas nicht im übermittelten
  JSON-Schema stehen. Die Meldung, die der Bearbeiter dann sieht, ist deshalb
  kein Randfall der Oberfläche, sondern ein Kern-Flow.
- **Die Löschzusagen des Systems haben ab hier vier Fristen statt drei.** Die
  Liste in `CONTRIBUTING.md` und in der KB wird beim Bau mitgezogen; eine Liste,
  die eine Frist nicht kennt, ist die Stelle, an der die nächste vergessen wird.
- **Ein bewusst getragener Preis:** die Funktion ist in einer frischen
  Installation **aus**, und niemand sieht sie, bis ein Betreiber zwei Variablen
  setzt. Das ist die Kehrseite von Nr. 9 und richtig so — eine SHOULD-Funktion,
  die Geld kostet, schaltet sich nicht selbst ein.

---

## Alternatives considered

1. **Nur ein Adapter jetzt, der zweite später.** Billiger in dieser Runde.
   Ausgeschlossen durch die Spezifikation Nr. 77 — und zu Recht: eine Naht ist erst bewiesen,
   wenn ein zweiter Verbraucher hindurchläuft, und ein nachgezogener Adapter ist
   die Bauform „zweiter Schreibpfad ohne den Filter des ersten".
2. **`503` statt `404` bei fehlendem Schlüssel.** Verworfen in Nr. 9: die
   Aussage „gibt es hier nicht" ist eine andere als „ist gerade kaputt", und die
   zweite lädt zum Wiederholen ein.
3. **Start verweigern, wenn kein Schlüssel gesetzt ist** (die Bauform von
   ADR-0014 Nr. 2). Verworfen in Nr. 9: sie gehört einer MUST-Funktion. **Die
   halbe Konfiguration lässt den Start trotzdem scheitern** — dort ist die
   Begründung von ADR-0014 wieder gültig.
4. **Token als Kontingentgröße.** Genauer und trotzdem falsch (Nr. 7): sie sind
   erst nach dem Aufruf bekannt und können den teuren Aufruf nicht verhindern,
   den zu verhindern die Zusage aber ist.
5. **Einen Fehlschlag nicht zählen.** Freundlich gegenüber dem Bearbeiter und
   eine unbegrenzte Schleife auf fremde Rechnung, sobald der Fehlschlag
   deterministisch ist (Nr. 7 Grund 3).
6. **Einen Fehlschlag doppelt zählen** (vor dem Aufruf und noch einmal als
   Strafe). Verworfen: es gibt keinen Vorgang, der zweimal stattfindet.
7. **Ein eigenes „KI-Schema" mit Übersetzung ins `formSchema`.** Verworfen in
   Nr. 3: die Doppelung, die dieses Projekt an vier Stellen bezahlt hat, plus ein
   dritter Ort, an dem Fragetypen wahr bleiben müssen.
8. **Schlüssel je Organisation, verschlüsselt in der Datenbank.** Durch die Abgrenzung ausgeschlossen; Nr. 10 nennt die drei Gründe, warum das für jetzt
   richtig ist, und die sechs Posten, die ein späterer Wechsel kostet.
9. **Streaming der Modellausgabe in die Vorschau.** Sieht schneller aus. Verworfen
   in Nr. 1: ein halbes Formular ist kein Formular, und der Strom wäre ein
   zweiter Weg, auf dem eine abgeschnittene Antwort unbemerkt durchgeht.
10. **Rohes `fetch` statt der Anbieter-SDKs.** Spart zwei Abhängigkeiten,
    kostet zwei handgepflegte Auth-, Fehler- und Schema-Wege — und anders als
    beim Upload (ADR-0014 Nr. 14) liegt diese Route **nicht** im öffentlichen
    Pfad.
11. **Das Ergebnis direkt in den offenen Entwurf laden**, wie der Prototyp.
    Verworfen in Nr. 11: ein überschriebener Entwurf ist Datenverlust ohne
    Papierkorb.

---

## Die Konfiguration liegt in den Einstellungen, nicht in der Umgebung

Dieser Abschnitt **ersetzt** den Umgebungs-Teil von Nr. 5, Nr. 9 und Nr. 10 —
der Rest dieses ADR bleibt unverändert gültig.

### Was sich ändert, und was ausdrücklich nicht

`AI_PROVIDER`, `AI_ANTHROPIC_API_KEY`, `AI_MISTRAL_API_KEY`, `AI_MODEL` und
`AI_ENABLED` verlassen die Umgebung. Anbieter, Modell, Region und der Schalter
stehen offen in `system_setting`, der Schlüssel dort **versiegelt**.

⚠️ **Nr. 10 wird dadurch nicht umgestoßen, sondern nur an einer Stelle
berichtigt.** Seine Frage war *„ein Schlüssel je Organisation?"*, und die Antwort bleibt
**nein**: es gibt weiterhin **einen** Schlüssel je Installation, und die beiden
ersten Gründe von Nr. 10 tragen unverändert — keine Organisation hat einen eigenen
KI-Vertrag, und die Kostentrennung leistet `ai_usage` mit `tenant_id`. Was sich
ändert, ist der **Ort** des einen Schlüssels: Prozessumgebung → Einstellungszeile.

Damit fällt der dritte Grund von Nr. 10 (*„jedes Geheimnis in der Datenbank ist
ein Entschlüsselungspfad mehr"*) — er wird **bezahlt**, nicht widerlegt. Der
Preis ist begrenzt und benennbar: es ist **dieselbe** Bauform wie beim
SMTP-Passwort und beim OIDC-Secret (`SecretBoxService`, eigener Zweck-Subkey,
Kontext-Bindung), also kein dritter *Weg*, sondern ein dritter *Nutzer* eines
Wegs, der seine Redigier-Regeln schon hat. Gekauft wird dafür das, was Nr. 9
nicht leisten konnte: **Einschalten ohne Deployment.**

### Warum überhaupt

Ein *Aus-Schalter neben* `AI_PROVIDER` wäre der Fehler gewesen, der bei SMTP
schon einmal abgeräumt wurde: **zwei Quellen für denselben Zustand**, von denen
im Zweifel eine unsichtbar gewinnt.
Die Antwort ist deshalb, den Schalter aus der Umgebung **wegzunehmen** statt ihn
dort zu verdoppeln — es ist die **dritte** Anwendung desselben Musters nach
`SMTP_*` und `PUBLIC_BASE_URL`, und der Schema-Kommentar von
`SystemSetting.smtp` sagt sie wörtlich: *„a value that is overridable per organisation
does not belong in a file that describes the process"*.

### Die drei Schichten

Drei Fragen, drei Orte — und sie sind **monoton**: jede Schicht kann nur
wegnehmen, keine hinzugeben.

| Frage | Wo sie beantwortet wird | Wer sie beantwortet |
|---|---|---|
| **Kann diese Installation KI?** | `system_setting`: Anbieter, Schlüssel, Modell, Region | Superadmin |
| **Darf dieser Organisation?** | `tenant.ai_monthly_call_limit` (0 = nein) | **nur** Superadmin  |
| **Will dieser Organisation?** | `tenant.ai_enabled`, NULL = erbt die System-Vorgabe | Organisation-Admin |

Daraus folgt die Zusage von der Anforderung — *„eine Organisation kann sich abschalten; er
kann sich nichts geben, was er nicht hat"*: steht die System-Schicht auf „nein",
ändert kein Wert der beiden anderen etwas daran. Durchgesetzt wird das
**serverseitig an der Route**, nicht beim Rendern.

### Die Region ist eine Auswahl, keine Adresse

`eu` · `global` · `us`, Vorgabe **`eu`**, auch wenn keine Zeile existiert.

Ein freies URL-Feld wäre bequem und wäre der Fehler: der gepinnte EU-Endpunkt
**ist** die Datenschutzzusage aus Nr. 13 dieses ADR — ein Textfeld machte daraus
eine Vermutung. Und der Vorgabewert ist `eu` und nicht „die erste gefundene
Region": eine frische Installation verarbeitete sonst außerhalb der EU, ohne dass
jemand etwas eingestellt hätte.

Was Nr. 13 **nicht** verspricht, verspricht auch dieses Feld nicht: wohin ein
Anbieter intern weiterreicht, ist mit der Wahl eines Endpunkts nicht entschieden.
Das Feld ist deshalb im Verarbeitungsverzeichnis als das benannt, was es ist —
die Stelle, die in die Drittlandfrage **hineinwirkt**.

### Drei Fallen, die dieses Projekt an derselben Tabelle schon bezahlt hat

1. **Region und Modell gehören *nicht* in den versiegelten Block.** An `reply_to`
   steht warum: *„der Block ist unteilbar, weil er ein Geheimnis trägt"* — läge
   die Region im selben Umschlag wie der Schlüssel, könnte niemand die Region
   ändern, ohne den Schlüssel zu haben, und auf einer Installation ohne Schlüssel
   gar nichts einstellen. Versiegelt wird **nur** der Schlüssel.
2. **Eigener Zähler `ai_revision`**, nicht `updatedAt` (siehe
   `mailRevision`): zwei Schreibvorgänge in derselben Millisekunde vergleichen
   sich gleich, und der zweite überschreibt den ersten, ohne dass je eine 409
   antwortet.
3. **NULL heißt „nicht eingerichtet", nicht „kaputt"** (wie `smtp`, ADR-0013
   Nr. 5): die Funktion ist dann abwesend, die Anwendung startet, nichts wird
   abgelehnt, was später noch gelingen kann.

### Die Umgebung schweigt nicht, wenn sie noch etwas trägt

Ist eine der fünf Variablen beim Start noch gesetzt, **meldet** die Anwendung das
sichtbar (Startwarnung, wie `MAIL_NOT_CONFIGURED_STARTUP_WARNING`) und benutzt
sie **nie** still weiter. Ohne diese Warnung liefe eine Installation mit zwei
Quellen für denselben Wert, von denen eine unsichtbar gewinnt — derselbe Fehler
wie bei SMTP, nur an einer neuen Stelle.

### Was der Umzug **nicht** tut

⚠️ **Er schaltet die KI nicht ein.** Ohne Anbieter-Schlüssel bleibt die Funktion
abwesend.
Gebaut wird der Weg, über den ein Betreiber sie später einschaltet, und die
Ablehnungskette, die dabei greift.

Und er verschiebt die vier ungemessenen Annahmen dieses ADR nicht — Schema-
Annahme am echten Endpunkt, Ablehnungsquote, `strict`, das geratene Kontingent
50. Sie stehen als Vorbedingungen an der Stelle, an der ein Betreiber steht,
wenn er den Schalter umlegt, und sind fällig, sobald er es tut.

### Ein Unterschied, den die Anwendung selbst ausgleichen muss

Ein Deployment ist langsam, absichtsvoll und wird von jemandem gefahren, der
weiß, was er tut. Ein **Formularfeld** ist es nicht. Deshalb
zeigt die Ansicht beim erstmaligen Setzen eines Anbieters die fünf
Vorbedingungen **an Ort und Stelle** (AV-Vertrag · EU-Frage · Eintrag
im Verarbeitungsverzeichnis · Kontingent je Organisation · 30-Tage-Löschung des
Freitexts), nicht nur in einer Datei, die niemand offen hat, während er das Feld
ausfüllt.
