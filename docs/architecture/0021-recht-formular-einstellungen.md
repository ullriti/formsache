# 21. Ein eigenes Recht für die Einstellungen eines Formulars

- **Status:** accepted
- **Date:** 2026-08-15

## Context

Eine Gruppe hatte fünf Rechte: *Bearbeiten*, *Antworten ansehen*, *Export*,
*Einstellungen*, *Nutzer verwalten*. Die Standardgruppe `editor`, die jede neue
Organisation mitbekommt, hielt die ersten drei. Im Formular-Menü sah sie deshalb
**Bearbeiten**, **Vorschau** und **Antworten** — und sonst nichts:

| Bereich im Formular-Menü | Recht bis heute |
|---|---|
| Benachrichtigungen | `can_manage_settings` |
| E-Mail-Versandprotokoll | `can_manage_settings` **und** `can_view_responses` |
| Formular-Einstellungen | `can_manage_settings` |
| Nutzerrechte je Formular | `can_manage_users` |

Das ist zu wenig. Wer ein Formular baut, muss es auch einstellen können — eine
Frist setzen, ein Teilnehmerlimit ziehen, die Bestätigungsseite texten, die
Benachrichtigung schreiben und nachsehen, ob sie angekommen ist. Ohne das ist
jede Anmeldefrist ein Anruf bei einer Administratorin.

**Der Haken ist, was `can_manage_settings` sonst noch aufsperrt.** Dasselbe
Recht öffnet die *organisationsweiten* Formular-Standards
(`tenant-settings.controller.ts`) — die Vorgaben, auf die **jedes** Formular der
Organisation zurückfällt — und die Organisations-Verwaltung: Erscheinungsbild, Logo,
Versandidentität, Antwortadresse, öffentliche Adresse und die OIDC-Anbindung.
Ein `editor`, der es bekäme, könnte das Aussehen und die Mailidentität der
Organisation ändern und ihr SSO konfigurieren. Das war ausdrücklich nicht
gewollt.

Zu entscheiden war also nicht *ob* die Standardgruppe die vier Bereiche bekommt,
sondern **über welches Recht** — und was mit den Gruppen geschieht, die es
heute schon gibt.

## Decision

### 1. Ein sechstes Recht, `can_manage_form_settings`

Es schaltet genau die vier Bereiche **eines Formulars** frei:

| Route | Recht ab jetzt |
|---|---|
| `GET`/`PUT /api/forms/:id/settings` | `can_manage_form_settings` |
| `GET`/`POST`/`PUT`/`DELETE /api/forms/:formId/notifications` | `can_manage_form_settings` |
| `GET`/`GET :id`/`POST :id/retry /api/mail-log` | `can_manage_form_settings` **und** `can_view_responses` |
| `GET`/`PUT /api/forms/:formId/members` | `can_manage_form_settings` **oder** `can_manage_users` |

`can_manage_settings` bleibt, was es war, und **nur** das: die
Formular-Standards der Organisation und die Organisations-Verwaltung. Keines der beiden
Rechte impliziert das andere, in keiner Richtung — kein Schema, kein Guard und
keine Anzeige leitet eines aus dem anderen ab.

**Warum nicht `can_manage_settings` ausweiten?** Weil das Recht dann zwei
Reichweiten hätte und nur die weitere davon zuteilbar wäre. Wer einer Gruppe
„sie darf ihre Formulare einstellen" geben wollte, hätte ihr zwangsläufig „sie
darf die Vorgaben aller Formulare ändern und die Organisation verwalten" mit
gegeben. Ein Recht, das man nicht in der gewünschten Reichweite vergeben kann,
ist kein Recht, sondern eine Kopplung.

**Warum kein Recht je Bereich** (eines für Benachrichtigungen, eines für das
Protokoll, …)? Weil die vier zusammen *eine* Tätigkeit sind — „dieses Formular
betreuen" — und vier Schalter für eine Tätigkeit einen Rechteeditor ergeben, in
dem niemand mehr weiß, welche Kombination die gemeinte ist. Die Konjunktion mit
`can_view_responses` am Versandprotokoll bleibt davon unberührt: dort steht die
Adresse, die eine echte Person eingetippt hat, und im gerenderten Rumpf stehen
ihre Antworten. Wer das Protokoll liest, liest Antworten — das war die
Begründung dieser Konjunktion und sie ändert sich nicht.

**Warum öffnet „Nutzerrechte je Formular" bei *einem von zwei* Rechten?**
`can_manage_users` hat diese Seite bisher geöffnet, und eine Bestandsgruppe, die
es hält, darf sie nicht verlieren — das wäre eine Rechteänderung, die niemand
bestellt hat. `can_manage_form_settings` kommt dazu, weil das Formular zu
betreuen auch heißt zu entscheiden, wer daran arbeitet. Die Liste steht als
`FORM_MEMBERS_PERMISSIONS` an **einer** Stelle
(`tenancy/form-permission.service.ts`), weil zwei Stellen sie lesen: der Wächter
vor der Route und die Prüfung, ob eine Deckelung auf sich selbst die Seite
zusperrt.

### 2. Die Standardgruppen — nur für **neue** Organisationen

| Gruppe | `can_manage_form_settings` |
|---|---|
| `admin` (Systemgruppe) | an |
| `editor` | **an** |
| `viewer` | aus |

Das gilt in `admin.repository.ts` (jede neu angelegte Organisation) und im
Entwicklungs-Seed. Es gilt **nicht** rückwirkend.

### 3. Bestandsgruppen bekommen es genau dann, wenn sie `can_manage_settings` halten

Die Migration ist zwei Anweisungen:

```sql
ALTER TABLE "group" ADD COLUMN "can_manage_form_settings" BOOLEAN NOT NULL DEFAULT false;
UPDATE "group" SET "can_manage_form_settings" = true WHERE "can_manage_settings";
```

**Wer das weite Recht hat, behält alles, was er hatte.** Für diese Gruppen —
`admin` jeder Organisation und jede Gruppe, der jemand *Einstellungen* erteilt
hat — ändert die Umstellung nichts: sie erreichen dieselben vier Bereiche wie
vorher, nur über das engere Recht. Ohne diese Zeile wären sie am Tag des
Updates aus den Formular-Einstellungen ausgesperrt.

**Wer heute nur `can_build` hat, bekommt es nicht.** Auch dann nicht, wenn die
Gruppe zufällig `editor` heißt. Eine bestehende Installation hat ihre Gruppen
selbst geschnitten; ihr über eine Migration ein Recht auf die
Formular-Einstellungen samt **Zugangswort im Klartext** und auf das
Versandprotokoll samt Teilnehmeradressen zu geben, wäre eine stille
Rechteerweiterung. Die Entscheidung darüber gehört der Administratorin der
Installation — sie kostet sie einen Klick auf eine Rechte-Kachel und ist
sichtbar, wo eine Migration unsichtbar wäre. Die Richtung ist dieselbe wie
überall sonst in diesem Repository: im Zweifel weniger Rechte, nie mehr.

Das ist der bewusste Preis: **eine bestehende Installation sieht den Nutzen
dieser Änderung nicht von selbst.** Der Weg dahin steht im `CHANGELOG.md`, und
er ist ein Häkchen in *Nutzerrechte → Gruppen & Rechte*.

### 4. „Nutzerrechte je Formular" ist keine Leiter — geprüft, nicht angenommen

Der Punkt war der heikelste, weil er Rechtevergabe in die Hand einer Gruppe
legt, die nicht die Nutzerverwaltung der Organisation hält. Geprüft wurde, ob
ein `editor` sich darüber Rechte verschaffen kann, die seine Gruppe nicht hat.
**Er kann nicht**, und zwar dreifach verriegelt:

1. **Es gibt kein gewährendes Feld.** `formMemberWriteSchema` ist ein
   `strictObject` mit `accessRevoked` und `cappedGroupId`. Ein Versuch, etwas
   anderes zu schicken, ist eine 400 — nicht ein stillschweigend ignoriertes
   Feld.
2. **Eine Deckelung muss ranggleich unterschritten werden.**
   `FormPermissionService.save` weist jede Deckelungsgruppe ab, die nicht
   *strikt unterhalb* der Rolle der betroffenen Person rankt; „auf die eigene
   Rolle" ist schon zu hoch.
3. **Und selbst eine gespeicherte Deckelung kann nur wegnehmen.**
   `capPermissions` bildet eine **Schnittmenge** aus dem, was die Person ohnehin
   hält, und dem, was die Deckelungsgruppe hält. Das gilt auch für eine Zeile,
   die an jeder Route vorbei entstanden ist — von Hand, per Migration, durch
   einen künftigen Dienst.

Administratoren (`is_system`) sind von einer Deckelung ausgenommen, und zwar
**bei der Auswertung**, nicht nur beim Schreiben: eine Zeile auf einer
Systemgruppe wird ignoriert, nicht abgelehnt. Ein `editor` kann einen
Administrator also weder aussperren noch herabstufen.

Was ein `editor` mit dem Recht **kann**, und das steht hier, damit es niemand
für ein Versehen hält: er kann anderen — auch ranghöheren Nicht-Administratoren
— auf einem Formular etwas wegnehmen. Das ist keine neue Eigenschaft dieser
Seite, sondern die, die sie immer hatte; neu ist nur, dass mehr Leute sie
erreichen. Rückgängig ist jeder dieser Schritte durch dieselbe Seite und durch
jeden Administrator.

## Consequences

**Geschlossen:**

- Ein `editor` erreicht die vier Bereiche **seiner** Formulare und **nicht** die
  Formular-Standards der Organisation, das Erscheinungsbild, die
  Versandidentität, die öffentliche Adresse oder SSO — belegt über Kreuz in
  `test/settings/form-settings.spec.ts`, `test/notifications/notifications.spec.ts`,
  `test/mail-log/mail-log.spec.ts` und `test/mail-log/mail-log-detail.spec.ts`:
  jede Gruppe hält genau eines der beiden Rechte und wird an der jeweils anderen
  Route abgewiesen.
- **Auch nicht in der Nutzlast** — das **Zugangswort der Organisation** steht
  für einen Aufrufer ohne `can_manage_settings` als `REDACTED_PASSWORD` in
  `tenantDefaults` und, solange *Zugriff & Sicherheit* geerbt ist, ebenso in
  `effective` (`FormSettingsService.shownTenantDefaults`). Der Weg
  entschlüsselt es gar nicht erst.

  *Nachgetragen 2026-08-15, ein Sicherheitsbefund.* Der Satz darüber stimmte für
  die **Route** und nicht für ihre **Antwort**: `GET /api/forms/:id/settings`
  trug das entschlüsselte Dokument der Organisation, Wort eingeschlossen, und
  ein `editor` erreichte damit das Wort, das die Formulare *anderer* schützt.
  Die Kreuzprobe konnte das nicht sehen, weil sie Statuscodes vergleicht;
  gemessen wird es jetzt an den Feldern (`form-settings.spec.ts`, „das
  Zugangswort der Organisation in der Antwort").
- **Und das Übernehmen des Abschnitts kopiert es nicht mehr mit.**
  `setSectionOverride` schreibt beim Umschalten auf „Angepasst" die gerade
  geltenden Werte in das Formular — das Zugangswort eingeschlossen. Die
  Redaktion war damit einen Klick weit von wirkungslos: danach stand das Wort
  in `values.password` **dieses** Formulars, und dort darf
  `can_manage_form_settings` es lesen.

  *Entschieden 2026-08-15:* Wer `can_manage_settings` nicht hält, übernimmt
  *Zugriff & Sicherheit* **ohne** das geerbte Wort — leeres Feld,
  `passwordEnabled: false` (`copyableTenantDefaults` in
  `FormSettingsService`). Der Schutz fällt sichtbar mit, weil
  `checkSettingsConsistency` „Passwortschutz an ohne Wort" ohnehin verweigert
  und ein Schalter, der Schutz behauptet, den es nicht gibt, das schlechtere
  von zwei Ergebnissen wäre — dieselbe Begründung, mit der
  `stripOverridePassword` beim Duplizieren verfährt.

  **Nutzersichtbar**, und deshalb angesagt, bevor es geschieht: die Karte
  *Zugriff & Sicherheit* trägt für diesen Fall einen eigenen ⓘ-Hinweis, das
  Feld *Zugangspasswort* zeigt statt des Platzhalters „Von der Organisation
  gesetzt" (als Absatz **und** über `aria-describedby`), und der Entwurf im
  Browser nimmt Schalter und Feld schon beim Klick zurück, damit Bildschirm und
  Spalte dasselbe sagen. Für Aufrufer **mit** `can_manage_settings` ändert sich
  nichts. Gemessen in `form-settings.spec.ts` („das Übernehmen von ‚Zugriff &
  Sicherheit'") und in `settings-draft.test.ts`/`SettingsView.test.tsx`.

  `REDACTED_PASSWORD` ist mit dieser Entscheidung von `apps/api` nach
  `packages/shared` gezogen: der Platzhalter reist auf der Leitung, also muss
  ihn die Oberfläche erkennen — vorher stand er als rohe Zeichenfolge mit
  NUL-Byte im Eingabefeld.
- Ein `viewer` erreicht keinen der vier Bereiche.
- Ein `editor` kann sich über „Nutzerrechte je Formular" keine Rechte geben, die
  seine Gruppe nicht hat (`test/tenancy/form-permission.spec.ts`).
- Niemand sperrt sich über eine Deckelung auf sich selbst aus dieser Seite aus:
  geprüft wird an derselben Schnittmenge, die auch der Wächter bildet — nicht
  mehr an einem einzelnen Recht, das nur solange stimmte, wie die Seite genau
  eines verlangte.
- Kein Recht wird durch die Migration erteilt, das die Administratorin einer
  bestehenden Installation nicht schon erteilt hatte.

**Offen und benannt:**

- **Zwei Rechte heißen fast gleich.** *Formular-Einstellungen* und
  *Einstellungen der Organisation* — der Rechteeditor schreibt beide Namen aus,
  und das ist die ganze Gegenmaßnahme. Wer sie verwechselt, vergibt zu viel oder
  zu wenig; abgefangen wird das nirgends, weil beides gültige Absichten sind.
- **Eine bestehende Installation muss das Recht selbst erteilen** (§3). Bis das
  jemand tut, sieht ihre `editor`-Gruppe weiterhin drei Einträge im
  Formular-Menü.
- **Das Versandprotokoll bleibt organisationsweit.** Der Menüeintrag führt mit
  Formularfilter hinein, aber die Route selbst ist die der Organisation; ein
  `editor` kann den Filter abwählen und die Zeilen aller Formulare sehen, auf
  die er nicht gesperrt ist. Das ist keine neue Grenze — `can_view_responses`
  gilt schon heute organisationsweit —, aber es ist eine, die man beim Erteilen
  des Rechts kennen sollte.
- **Ein `editor` kann ranghöheren Nicht-Administratoren auf einem Formular
  etwas wegnehmen** (§4). Umkehrbar, aber nicht verhindert.
