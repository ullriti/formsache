# 27. Der Link ins System in jeder Mail — die Fußzeile folgt der Identität

- **Status:** accepted
- **Date:** 2026-08-18

## Context

`wrapMailHtml` legt seit Befund 31 die Hülle um jeden Mailrumpf: Doctype,
Karte, Akzentstreifen, Fußzeile. In der Fußzeile stand „«Organisation» · Diese
E-Mail wurde automatisch erzeugt." — **und kein Link**. Wer eine Bestätigung
bekam und wissen wollte, wo diese Anwendung eigentlich steht, hatte im ganzen
Dokument keine Adresse, sofern die Benachrichtigung nicht zufällig einen
`{{bearbeiten}}`-Link trug.

Zwei Dinge machen daraus mehr als eine Bequemlichkeit:

1. **Es gibt zwei Basis-Adressen**, nicht eine —
   `system_setting.public_base_url` (die der Installation) und
   `tenant.public_base_url` (die je Organisation, mit Rückfall auf die erste).
   Welche in eine Mail gehört, ist genau die Frage, die
   [ADR-0020](0020-passwort-ruecksetzung.md) §5 für den Rücksetz-Link schon
   einmal beantworten musste — dort gegen die Kette und für
   `installationBaseUrl()`, weil `tenant.public_base_url` setzt, wer
   `can_manage_settings` hält.
2. **Die Hülle lag nur um die HTML-Fassung.** Die Klartextfassung ging
   ungerahmt hinaus. Ein Link, den nur die eine Hälfte trägt, ist die Sorte
   Halbheit, die [ADR-0026](0026-fremdwerte-in-einer-systemmail.md) für die
   Fremdwerte gerade erst aufgeräumt hat: *„die Textfassung ist die Hälfte, die
   vergessen wird."*

## Decision

### 1. Jede Mail trägt in der Fußzeile einen Link ins System — in beiden Fassungen

Betroffen ist damit **jede** Sorte, die diese Anwendung verschickt:
Formularbestätigung, Meldung ans Büro, Änderungsmeldung (samt dem
`{{bearbeiten}}`-Link, der in ihnen steht), Passwort-Rücksetzung, Einladung,
Mitteilung über ein administrativ gesetztes Passwort, Testmail in beiden
Fassungen, Betriebsmeldung. Die Liste ist vollständig, weil sie an den
**Schreibwegen** abgelesen ist und nicht an den Sorten: sechs Stellen schreiben
`mail_log` (`tenant-scope.ts`, `enqueue-invitation.ts`,
`password-reset.service.ts`, zweimal `public-forms.service.ts`,
`test-mail.service.ts`), und genau eine Mail geht an der Tabelle vorbei (der
Betriebsalarm).

### 2. Die Adresse folgt der Identität, unter der die Mail hinausgeht

Die Regel ist eine einzige Bedingung, und es ist **dieselbe**, an der der
Worker seinen Mailserver wählt: `identitySourceOf(trigger)`
([ADR-0023](0023-getrennte-mailserver-instanz-organisation.md) Nr. 4).

| Identität der Zeile | Basis-Adresse | Aufschrift |
|---|---|---|
| `tenant` — Bestätigung, Büro, Änderung, Testmail einer Organisation | `resolveBaseUrl(tenantId)` (die der Organisation, sonst die der Installation) | „Formulare von „«Organisation»"" |
| `system` — Rücksetzung, Einladung, Passwortmitteilung, Systemtestmail | `installationBaseUrl()` | „Zu Formsache" |
| Betriebsmeldung (gar keine Zeile) | `installationBaseUrl()` | „Zu Formsache" |

**Warum eine Organisationsmail die Adresse der Organisation trägt.** Sie geht
über deren Mailserver unter deren Domäne hinaus, und der `{{bearbeiten}}`-Link
derselben Mail zeigt bereits dorthin (`responseEditUrl` → `resolveBaseUrl`).
Zwei verschiedene Hosts in einer Mail wären zwei Angebote, von denen eine
Teilnehmerin keines prüfen kann.

**Warum eine Systemmail die der Installation trägt — und ob ADR-0020 §5 dafür
trägt.** Nur zur Hälfte, und die Hälfte reicht. Der dortige Grund ist die
**Vollmacht**: ein Rücksetz-Link auf einem fremden Host übergibt beim Klick das
Token. Ein Fußzeilen-Link übergibt nichts. Was von der Begründung bleibt, ist
die andere Hälfte: die Mail ist unter der Domäne der **Installation** per SPF
und DKIM beglaubigt, und `tenant.public_base_url` setzt, wer
`can_manage_settings` einer **beliebigen** Organisation hält. Ein Link darauf
wäre eine fremde Landeseite unter fremder Beglaubigung — genau die Vermischung,
die ADR-0023 auflöst und die ADR-0026 für die Fremdwerte derselben Mails
ausschließt. Ein Halter von `can_manage_users` löst die Einladung aus und
wählt das Postfach; er soll nicht auch noch den Host im Fuß bestimmen.

**Die Aufschrift folgt der Adresse, nie umgekehrt.** Wären es zwei unabhängige
Angaben, gäbe es einen Zustand, in dem „Formulare von „Ortsgruppe"" auf einen
ganz anderen Hof zeigt. `MailShellLink` trägt deshalb `owner` und `url`
zusammen; die Aufschrift wird daraus abgeleitet und ist kein Parameter.

### 2a. Dieselbe Bedingung entscheidet über **die ganze Hülle**, nicht nur über die Adresse

`QueuedBodyRenderer.shellFor` las bis zu einem Review-Befund dieser Arbeit die
`tenant`-Zeile für **jede** Mail und setzte Farbe und Namen der Organisation in
die Hülle — auch bei einer Einladung, einer Rücksetzung und einer
Systemtestmail. Das war schon vor dieser Entscheidung falsch und fiel erst
jetzt auf, weil dieselbe Angabe seither auch in der **Klartextfassung** steht:

- **ADR-0023 sagt das Gegenteil.** `TestMailService.shellFor` und
  `OpsAlertService` bauen ihre eigenen Systemmails ausdrücklich ohne Farbe und
  Namen einer Organisation und begründen es dort auch so. Diese Stelle war die
  dritte, die es hätte tun müssen.
- **Die beiden Wege widersprachen sich über dieselbe Zeile.** Eine
  Systemtestmail geht **ohne** Organisationsfarbe hinaus; dieselbe Zeile durch
  `QueuedBodyRenderer` gerendert (die Detailansicht des Versandprotokolls)
  ergab sie **mit**. Die Zusage „die Detailansicht zeigt genau das, was
  hinausging" hielt damit nicht.

Seither gilt für alle drei Angaben eine Bedingung: `identitySourceOf(trigger)`.
Eine Systemmail trägt keine Organisationsfarbe, keinen Organisationsnamen in
der Hülle und die Adresse der Installation.

**Die Herkunft geht dabei nicht verloren.** Rücksetzung, Einladung und
Passwortmitteilung nennen die Organisation in ihrem **Rumpf** („Organisation
„X""), also dort, wo ADR-0026 sie als *Angabe* erlaubt und mit
`isSingleLineText` und `collapseWhitespace` verriegelt hat. Was wegfällt, ist
nur die zweite, ungeprüfte Nennung im Rahmen.

**Nutzersichtbare Änderung, absichtlich:** die Einladungsmail trug bisher den
Akzentstreifen der einladenden Organisation und verliert ihn.

### 3. Fehlt die Adresse, fehlt der Link — und die Mail geht trotzdem

Es gibt bereits ein Muster für „Link nicht bildbar": `kind: 'dead'` in
`QueuedBodyRenderer.resetLinkFor` lässt die Zeile liegen und endet nach den
Versuchen auf `failed`. **Das gilt hier ausdrücklich nicht.** Es ist für die
**tragenden** Links gedacht — eine Mail, die eine Adresse ankündigt und keine
nennt, ist sinnlos, und ADR-0024 hält das für die Einladung fest. Eine Fußzeile
kündigt nichts an. Sie darf fehlen, und eine Bestätigung deswegen liegen zu
lassen wäre eine Bestrafung für eine Einstellung, die eine Teilnehmerin nicht
kennt.

Umgesetzt als `MailShell.link?: MailShellLink`: `undefined` heißt „keine
Adresse", die Zeile entfällt, und der Rest der Fußzeile steht wie vorher. Für
den Betriebsalarm wiegt das doppelt — er ist die eine Mail, deren Ausbleiben
niemand bemerkt.

### 4. Was dort steht: eine Aufschrift, im Klartext eine Adresse

**Nicht die nackte URL in HTML.** Was eine Teilnehmerin wiedererkennt, ist der
Name ihrer Organisation; „Formsache" sagt ihr nichts (dieselbe Überlegung, die
[ADR-0019](0019-produktzeichen.md) zum Produktzeichen anstellt). Die
HTML-Fassung trägt deshalb „Formulare von „«Organisation»"" als Ankertext, und
eine nackte Adresse bräche in der 600er-Karte ohnehin um.

**In `text/plain` gibt es keine Aufschrift**, hinter der sich etwas verbergen
ließe: dort ist ein Link die URL. Sie steht am **Zeilenende**, hinter einem
Doppelpunkt, ohne Satzzeichen dahinter — ein abschließender Punkt landete bei
der Hälfte der Clients in der Adresse.

**Kein `--` als Trenner.** Die Signaturmarke aus RFC 3676 wäre naheliegend und
falsch: etliche Clients verbergen alles hinter ihr oder klappen es ein. Der
Link wäre dann genau in den Postfächern weg, in denen er gebraucht wird. Zwei
Leerzeilen trennen ebenso deutlich und verstecken nichts.

### 5. Die Adresse ist ein Fremdwert in einem `href` — zwei Tore, wie überall

Was in ADR-0026 für die Namen gilt, gilt hier für die Adresse, und hier mit
einem eigenen Gewicht, weil dieser Wert als einziger in ein `href` gerät:

- **Tor 1, das Schema** (`baseUrlSchema` → `normaliseBaseUrl` →
  `safeExternalUrl`): nur `http:` und `https:`. `javascript:` und `data:`
  kommen dort nicht durch — der Angriff, den ein `href` sonst trägt, war also
  bereits abgefangen, und die Prüfung wurde nicht neu erfunden.
- **Tor 2, unmittelbar vor dem Einsetzen**: `normaliseBaseUrl` ein zweites Mal,
  in `footerOf`. Für die Zeile aus einer Wiederherstellung, einem
  handgeschriebenen `UPDATE` oder einem Schreibweg, den jemand später
  hinzufügt. Ein Wert, der nicht durchkommt, kostet den Link und nicht die
  Mail — dieselbe Richtung wie `shellAccent` für die Farbe.
- **Die Maskierung, und was `URL` dabei *nicht* tut**: `URL.href` maskiert `"`,
  `<` und `>` im Pfad zu `%22`/`%3C`/`%3E`, **`'` aber nicht**. Ein Attribut in
  einfachen Anführungszeichen wäre damit offen. Das `href` steht deshalb in
  doppelten *und* geht durch `escapeHtml`; eines von beidem allein wäre eine
  Lücke. `mail-template.test.ts` hält beide Hälften fest.

Der Name der Organisation läuft jetzt zusätzlich durch `collapseWhitespace` —
er stand vorher nur in der HTML-Fassung (`escapeHtml` genügte), steht seit
dieser Entscheidung aber auch im Klartext, wo ein `\n` eine Zeile erzeugt. Das
ist Tor 2 aus ADR-0026 Nr. 3, an einer Stelle, die es vorher nicht brauchte.

### 6. Die Hülle wird an einer Stelle gelegt — und `wrapMailBody` nimmt beide Fassungen

`wrapMailHtml` und `wrapMailText` sind modulprivat; exportiert ist nur
`wrapMailBody({ text, html? }, shell)`. Zwei exportierte Funktionen wären zwei
Gelegenheiten, eine davon nicht zu rufen, und herausgekommen wäre genau die
HTML-Mail mit Fußzeile neben einer Textfassung ohne.

Drei Aufrufer, und die beiden zusätzlichen sind benannt statt geduldet:
`QueuedBodyRenderer` (die Warteschlange und, redigiert, die Detailansicht des
Versandprotokolls), `TestMailService` und `OpsAlertService`. Die letzten beiden
gehen **absichtlich** an der Warteschlange vorbei — ein Betriebsalarm über den
Rückstand der Warteschlange, der selbst darin landete, stünde hinter dem
Rückstand, den er meldet — und kommen deshalb an der einen Stelle, die sonst
einhüllt, gar nicht vorbei.

## Consequences

- **`QueuedBodyRenderer.shellFor` läuft jetzt für jede Zeile**, nicht mehr nur
  für den HTML-Zweig — die alte Ersparnis („eine reine Textmail kostet keine
  Abfrage") hieße jetzt „die Systemmails bekommen keinen Link". Unterm Strich
  wird es dabei nicht teurer, sondern anders: eine **Systemmail** kostet nach
  Nr. 2a **keine** `tenant`-Abfrage mehr, eine **Organisationsmail** kostet die
  Auflösung der Basis-Adresse zusätzlich — und bei einer Bestätigung mit
  Bearbeiten-Link löst `responseEditUrl` dieselbe Kette ein zweites Mal auf.
  Bewusst nicht zwischengespeichert: der Dienst ist ein Singleton (ein Speicher
  über Zustellungen hinweg wäre eine Adresse von gestern), und die
  Warteschlange arbeitet im Takt von Menschen.
- **Die Detailansicht des Versandprotokolls zeigt die Fußzeile mit**, weil sie
  durch denselben Renderer geht — das ist ihre Zusage („zeigt, was
  hinausging"). Die Basis-Adresse ist dort keine Preisgabe: sie steht auf jedem
  Formularlink dieser Organisation. Die Sicherheitseigenschaft dieser Route
  bleibt das **Token**, und `mail-log-detail.spec.ts` prüft seither den
  Bearbeiten-**Pfad** statt der nackten Basis-Adresse.
- **Der gespeicherte Rumpf bleibt ohne Hülle.** `mail_log.body_text` und
  `body_html` halten weiter das, was beim Einreihen eingefroren wurde; die
  Fußzeile entsteht beim Zustellen und trägt die Adresse von heute. Ändert eine
  Organisation ihre Adresse, während eine Mail wartet, geht sie mit der neuen
  hinaus — für den Rahmen ist das die richtige Antwort, denn die alte antwortet
  womöglich gar nicht mehr.
- **Keine Migration**, kein Schemaeingriff, kein Wire-Contract berührt.

## Alternatives considered

**Immer die Adresse der Installation.** Ein Wert statt zwei, und keine
Verwechslung möglich. Verworfen: die Bestätigung einer Organisation zeigte dann
auf einen Host, der mit dem Absender der Mail nichts zu tun hat — und stünde
neben einem `{{bearbeiten}}`-Link, der auf den *anderen* zeigt.

**Immer die Kette (`resolveBaseUrl`), auch für Systemmails.** Der bequeme Weg —
eine Funktion für alles. Verworfen aus Nr. 2: er gäbe der Verwaltung einer
beliebigen Organisation einen Link in einer Mail, für die die Installation mit
ihrer Domäne haftet.

**Die Fußzeile beim Einreihen schreiben.** Dann stünde sie in `mail_log` und
wäre eingefroren wie der Rumpf. Verworfen aus denselben drei Gründen, die schon
für die Hülle gelten (`wrapMailBody`, „Warum die Hülle beim Zustellen
entsteht"): jeder Einreihweg müsste sie einzeln mitbringen, und eine Adresse,
die es nicht mehr gibt, ginge weiter hinaus.

**Den fehlenden Link wie einen fehlenden Rücksetz-Link behandeln (`dead`).**
Verworfen in Nr. 3: das Muster gehört den tragenden Links. Eine Bestätigung
wegen einer fehlenden Fußzeile liegen zu lassen, verwechselt Rahmen mit Zusage.

**Die nackte URL als Ankertext.** Ein Wort weniger zu übersetzen. Verworfen:
sie bricht in der Karte um, und sie sagt einer Teilnehmerin weniger als der Name
ihrer Organisation.

## References

- [ADR-0004](0004-mail-db-queue.md) (die Warteschlange und die Hülle) ·
  [ADR-0019](0019-produktzeichen.md) (warum „Formsache" nicht überall steht) ·
  [ADR-0020](0020-passwort-ruecksetzung.md) §5 (die Basis-Adresse des
  Rücksetz-Links — die Begründung, die hier zur Hälfte trägt) ·
  [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md) (wem eine Mail
  gehört) · [ADR-0024](0024-einladung-statt-getipptem-passwort.md) (der
  tragende Link, der fehlen darf — und der nicht) ·
  [ADR-0026](0026-fremdwerte-in-einer-systemmail.md) (Fremdwerte, zwei Tore und
  die vergessene Textfassung)
