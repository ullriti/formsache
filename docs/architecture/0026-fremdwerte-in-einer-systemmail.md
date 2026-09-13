# 26. Fremdwerte in einer Mail der Instanz — einzeilig, an zwei Toren

- **Status:** accepted
- **Date:** 2026-08-18

## Context

[ADR-0020](0020-passwort-ruecksetzung.md), [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md)
und [ADR-0024](0024-einladung-statt-getipptem-passwort.md) haben eine Reihe von
**Systemmails** geschaffen — Rücksetzung, Einladung, Mitteilung über ein
administrativ gesetztes Passwort — und für sie dieselbe Zusage abgegeben: *an
einer Systemmail bestimmt keine Organisation etwas.* Sie geht über den
Mailserver der **Installation** hinaus, ist also unter deren Domäne per SPF und
DKIM autorisiert; ihr Wortlaut ist fester deutscher Text im Quelltext, es gibt
keine bearbeitbare Vorlage, und der Link entsteht erst beim Zustellen.

Die Zusage war **nicht wahr**. Ein Review am 2026-08-18 hat gezeigt, wie weit
sie danebenlag:

- `TenantUsersService.create` reicht `request.name` — aus dem Anfragekörper —
  als `personName` in `localInvitationBody`, und `request.email` bestimmt den
  Empfänger. Der Docblock der Mailbausteine behauptete ausdrücklich das
  Gegenteil („Kein Feld dieser Funktionen stammt aus einem Anfragekörper, den
  jemand frei füllt").
- `userNameSchema` war `z.string().trim().min(1).max(120)` — **Zeilenumbrüche
  und Steuerzeichen eingeschlossen**. Dasselbe galt für den Namen der
  Organisation (zwei Schreibwege: `tenantBrandingWriteSchema.name` hinter
  `can_manage_settings`, `tenantCreateSchema.name` in der Systemverwaltung) und
  für die Aufschrift der SSO-Schaltfläche, die in der Einladung eines
  SSO-Kontos steht.
- Die **HTML**-Fassung war gedeckt (`escapeHtml`, `neutraliseHtml`,
  `renderAnswerTable`); die **Textfassung** nicht. In `text/plain` ist `\n`
  kein Zeichen, sondern eine neue Zeile, und `stripMarkup` entfernt Markup, kein
  Layout.

Daraus wird ein konkreter Weg: ein Halter von `can_manage_users` legt eine
Person an mit

```
name  = "Max\n\nDein Zugang läuft ab. Jetzt bestätigen: https://boese.example\n\n—"
email = <frei gewähltes Postfach>
```

und die Installation stellt eine korrekt signierte Mail unter **ihrer** Domäne
zu, deren Text zur Hälfte der Aufrufer geschrieben hat. Über die Rücksetz-Mail
gab es diesen Kanal abgeschwächt schon (`passwordResetMailBody(user.name,
tenant.name)`), aber dort konnte der Angreifer weder den Empfänger wählen noch
den Versand auslösen; ADR-0024 macht daraus einen Ein-Klick-Weg.

Was hier fehlte, war keine Zeile Code, sondern eine **Regel**: welche
Fremdwerte dürfen überhaupt in eine Mail der Instanz, und was muss von ihnen
wahr sein?

## Decision

### 1. In eine Systemmail dürfen nur Fremdwerte, die eine **Angabe** sind — nie ein Satz

Erlaubt sind Werte, die in der Mail als *Feld* auftreten: ein Personenname
(Anrede), der Name der Organisation (Herkunft), die Aufschrift der
Anmelde-Schaltfläche (Wegweiser). Nicht erlaubt ist jeder Wert, der einen
**eigenen Absatz** stellen könnte — heute gibt es keinen solchen, und diese
Nummer ist der Grund, dass auch keiner hinzukommt.

Der Prüfsatz für jeden künftigen Fremdwert in einer dieser Mails lautet: *Kann
der Wert eine Zeile erzeugen, die für sich gelesen wie ein Satz der Anwendung
aussieht?* Wenn ja, gehört er nicht hinein.

### 2. Einzeilig, und zwar dort, wo der Wert entsteht

`isSingleLineText` (`packages/shared/src/html-text.ts`) verlangt
`^[^\p{Cc}\p{Cf}]+$`. Das schließt aus:

- `\p{Cc}` — C0/C1-Steuerzeichen, also `\n`, `\r`, `\t`, NUL und NEL: die
  Zeichen, mit denen sich eine Zeile erzeugen lässt;
- `\p{Cf}` — unsichtbare Formatzeichen: Bidi-Marken (eine angezeigte Zeile
  lässt sich damit umsortieren — „Trojan Source"), U+FEFF, die
  Nullbreiten-Verbinder.

Das Prädikat steht an **allen** Schreibwegen der betroffenen Spalten:
`userNameSchema` (Anlegen und Ändern eines Mitglieds, erste Administratorin,
Erstinbetriebnahme), `tenantBrandingWriteSchema.name`, `tenantCreateSchema.name`
und `oidcConfigWriteSchema.buttonLabel`. Eine Regel an einem von zwei
Schreibwegen ist keine Regel — `tenant.name` hat zwei, und beide tragen sie.

**Warum am Schema und nicht im Rumpf:** ein Wert, der die Spalte nie erreicht,
kann in keiner *künftigen* Mail stehen. Die Liste der Stellen, die `user.name`
in einen Text setzen, wächst; die Liste der Stellen, die ihn schreiben, ist
kurz und vollständig bekannt.

**Der Preis ist benannt und nicht wegdiskutiert:** ein persischer Name schreibt
sich mit ZWNJ (U+200C) sauberer, und wer ihn eintippt, bekommt eine Absage.
Sichtbarer Text jeder Schrift bleibt erlaubt; unsichtbarer nicht. Auf diese
Seite fällt die Regel bewusst.

### 3. Ein zweites Tor unmittelbar vor dem Einsetzen

`collapseWhitespace` faltet jeden Fremdwert zu einer Zeile, bevor er in einen
Rumpf geht — in `account-invitation-mail.ts`, `password-reset-mail.ts` und
`passwordSetNoticeBody`. Es entfernt `\p{Cf}` ganz und macht aus jeder Folge
von Leerraum und Steuerzeichen **ein Leerzeichen**; „Max\nMustermann" wird
„Max Mustermann" und nicht „MaxMustermann", weil stilles Verfälschen die
schlechtere Hälfte wäre.

Dieselbe Zwei-Tore-Bauform, die `branding.ts` für die Farben beschreibt und aus
demselben Grund: Tor 1 verteidigt die **Spalte**, Tor 2 die **Mail**. Was Tor 2
abfängt, ist die Zeile aus der Zeit vor dieser Regel, aus einer
Wiederherstellung, aus einem Schreibweg, den jemand später hinzufügt — und
`profileUpdateSchema` in `auth.ts`, der zweite Schreibweg auf `user.name`, der
die Bedingung heute noch nicht trägt (siehe *Consequences*).

### 4. Der Beleg ist ein Test, der den Angriff scheitern sieht

Drei Ebenen, weil ein Fehlschlag auf jeder anders aussieht:

- `packages/shared/src/html-text.test.ts` misst das Alphabet und die Faltung —
  einschließlich der Eigenschaft, dass ein gefalteter Wert das Prädikat
  besteht (sonst driften die beiden Alphabete auseinander, ohne dass es
  jemandem auffällt);
- `tenant-admin.test.ts` und `branding.test.ts` sehen die Schemata den Namen
  aus dem Angriff ablehnen;
- `apps/api/test/tenant-admin/account-invitation.spec.ts` schreibt den Namen
  **an der Route vorbei** in die Spalte, löst die Einladung aus und misst
  `mail_log.body_text`: **keine einzige Zeile mehr** als bei einer harmlosen
  Einladung derselben Person. Das ist der Fall, der Tor 2 belegt, und der
  einzige, der den ganzen Weg misst.

`single-source.test.ts` bindet `SINGLE_LINE_TEXT`, `isSingleLineText` und
`collapseWhitespace` an ihre Datei: zwei Kopien eines Sicherheitsprädikats sind
keine Verteidigung in der Tiefe, sondern zwei Stellen zum Verengen und eine
zum Vergessen — die Lehre aus `hexColorSchema`.

### 5. Keine Migration

Die Regel gilt für Schreibvorgänge. Bestehende Zeilen werden nicht geprüft und
nicht umgeschrieben; Tor 3 fängt sie im Rumpf ab. Eine Migration, die Namen in
der Datenbank umschreibt, wäre eine stille Änderung an Daten einer Organisation
für einen Gewinn, den Tor 2 ohnehin liefert.

## Consequences

- **Ein Name mit Zeilenumbruch wird jetzt mit 400 abgelehnt**, dort, wo er
  vorher stillschweigend angenommen wurde. Für Menschen ist das folgenlos; für
  einen Datenimport, der mehrzeilige Namen mitbringt, ist es eine Absage mit
  Feldnamen.
- **`profileUpdateSchema` in `auth.ts` trägt die Bedingung noch nicht** — der
  zweite Schreibweg auf `user.name`, den der Docblock dort als tragbare
  Doppelung benennt. Der Rest-Weg ist eng: wer dort etwas einschleust, schickt
  es an **sein eigenes** Postfach, weil jede Systemmail an die gespeicherte
  Adresse desselben Kontos geht. Tor 2 entschärft ihn zusätzlich. **Adressat:**
  wer als Nächstes an `auth.ts` arbeitet; **Kriterium:** dieselbe Zeile
  `.refine(isSingleLineText, …)` an `profileUpdateSchema`, dann ist diese
  Fußnote erledigt.
- **Der Anzeigename des Absenders profitiert mit.** `fromName` trägt
  `tenant.name` (`mail-worker.service.ts`, `test-mail.service.ts`); Nodemailer
  kodiert Kopfzeilen zwar selbst, aber ein einzeiliger Wert ist die Bedingung,
  auf die man sich dabei nicht verlassen muss.
- **Die Regel gilt nicht für Benachrichtigungsvorlagen.** Deren Text bestimmt
  eine Organisation absichtlich (ADR-0004, `mail-template.ts`), sie gehen über
  **deren** Mailserver hinaus, und ihre Platzhalterwerte laufen durch
  `neutraliseHtml`/`stripMarkup`. Ein anderer Absender, ein anderes
  Bedrohungsmodell, eine andere Regel.

## Alternatives considered

**Nur falten, nichts ablehnen.** Ein Tor statt zwei, und niemand bekommt eine
Absage. Verworfen: die Spalte hielte dann weiterhin Werte, die keine Zeile sein
dürfen, und jede **neue** Stelle, die `user.name` in einen Text setzt, müsste
das Falten erneut mitbringen. Genau diese Sorte Regel wird beim nächsten Mal
vergessen — der Grund, warum die Bedingung an den Entstehungsort gehört.

**Nur ablehnen, nicht falten.** Ein Tor statt zwei, und billiger. Verworfen aus
dem Grund, den `branding.ts` schon aufgeschrieben hat: eine Zeile kann an der
Route vorbei in die Spalte kommen — durch eine Wiederherstellung, eine ältere
Version, einen Schreibweg, den jemand später hinzufügt.

**Den Wert in der Mail zitieren oder maskieren** (etwa `\n` als „⏎" ausgeben).
Verworfen: es macht aus einem Namen etwas, das kein Name ist, und rettet nur
die Textfassung, während die Ursache — ein Wert, der eine Zeile sein darf —
stehen bleibt.

**Nur `\r` und `\n` verbieten.** Die schmale Fassung. Verworfen, weil sie den
halben Angriff stehen lässt: NEL (U+0085) wird von Anzeigen als Umbruch
gelesen, und eine Bidi-Marke ordnet eine angezeigte Zeile um, ohne ein
einziges Steuerzeichen im engeren Sinn zu benutzen.

**Die Fremdwerte ganz aus der Mail nehmen** („Hallo," statt „Hallo Max,"). Der
sicherste Weg und der schlechteste: eine Einladung ohne Namen und ohne die
Organisation, die sie ausgestellt hat, ist genau die Nachricht, die wie eine
Fälschung aussieht — und die Person soll sie erkennen.

## References

- [ADR-0020](0020-passwort-ruecksetzung.md) (die erste Systemmail, und die
  Marke statt des Links) ·
  [ADR-0023](0023-getrennte-mailserver-instanz-organisation.md) (warum eine
  Systemmail über die Installation geht — die Zusage, die dieser ADR
  einlöst) ·
  [ADR-0024](0024-einladung-statt-getipptem-passwort.md) (der Ein-Klick-Weg,
  der den Befund zum Sicherheitsproblem macht) ·
  [ADR-0012](0012-oidc-kontobindung.md) (die Aufschrift der SSO-Schaltfläche)
