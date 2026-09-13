# 19. Ein Produktzeichen, das der Software gehört — und keiner Organisation

- **Status:** accepted
- **Date:** 2026-08-14

## Context

Die Anwendung trug **kein eigenes Zeichen**: kein Favicon (der Browser-Reiter
zeigte das leere Blatt), keine Marke auf dem Anmeldebild, kein Bild in der Mail.
Was sie trug, waren die Logos ihrer Mitgliedsorganisationen — `TenantMark` in
der Kopfzeile, `beispiel-signet.svg` als Platzhalter für Organisationen ohne
eigenes.

Das ist keine Schönheitsfrage. Diese Anwendung ist zum Selbsthosten gedacht,
und wer sie betreibt, unterscheidet zwei Dinge, die bislang beide „das
Formularsystem" hießen:

1. **Die Software.** Sie heißt Formsache, sie ist auf jeder Installation
   dieselbe, und sie wird an Orten sichtbar, an denen noch gar keine
   Organisation feststeht — im Reiter des Browsers und auf dem Anmeldebild,
   das jeder sieht, bevor irgendeine Sitzung eine Organisation hat.
2. **Die Installation.** Sie heißt, wie der Betreiber sie nennt, und sie führt
   die Logos und die Organisationsfarben ihrer Organisationen.

Die Farbwelt stand bereits fest und wurde nicht neu erfunden: Gold `#cea967`,
Ink `#212226`, Sand `#e9e6df` und PT Serif als Auszeichnungsschrift stammen aus
`apps/web/src/styles/tokens.css`.

Vier Entwürfe standen zur Wahl. Gewählt wurde **Entwurf B**: die Arme
eines F setzen sich rechts als Formularzeilen fort, eine dritte kommt unten
hinzu. Er ist der einzige, der den Namen im Signet mitträgt, er bleibt bei
16 px lesbar, weil er aus vier Balken besteht und aus nichts sonst, und er hält
auch einfarbig, weil ein F ohne seinen Goldakzent ein F bleibt.

## Decision

### 1. Das Zeichen ist tenant-unabhängig — und das ist die eigentliche Entscheidung

Die drei Farben des Zeichens stehen als `--brand-mark-ground`,
`--brand-mark-ink` und `--brand-mark-accent` in der Tokendatei und **lesen
keine Tenant-Achse**. Sie sind damit die einzigen Farbtokens dieser Anwendung,
die das nicht tun.

Der Grund: ein Zeichen, das mit den Farben des angezeigten Mandanten
mitwandert, ist keine Marke mehr, sondern ein zweites Logo. Und es steht
ohnehin dort, wo es keinen Mandanten gibt.

`ProductLockup.test.tsx` misst das — ein `var(` in einem der drei Werte lässt
den Test fallen.

### 2. Zwei Orte, und die Kopfzeile ist keiner davon

- **Der Browser-Reiter**: `apps/web/public/favicon.svg`, verlinkt aus
  `index.html`. Nur SVG, kein `.ico`.
- **Das Anmeldebild**: `ProductLockup` trägt den Namen als Marke, dort wo der
  Kicker „Formularsystem" stand.
- **Die Oberflächentexte**: Seitentitel, Anmelde-Überschrift, der Betreff einer
  Testmail und der eines Betriebsalarms nennen die Software beim Namen —
  „Formsache", nicht den Namen einer Installation. Eine Software, die sich
  selbst nie nennt, lässt sich nicht besprechen; wer sie betreibt, muss sagen
  können, *was* er betreibt.

**Nicht in die App-Kopfzeile.** Die trägt das Logo der Organisation, deren
Daten auf dem Schirm sind. Ein Herstellerzeichen daneben nähme genau den Platz,
an dem die Anwendung sagt, wessen Daten das hier sind.

### 3. Inline-SVG in der Anwendung, ausgeschriebene Werte im Favicon

In der Anwendung ist das Zeichen ein **Inline**-SVG und kein
`<img src="….svg">`: nur ein Baum im Dokument kann die Tokens der Kaskade
lesen, eine referenzierte Datei nicht. Dasselbe gilt für die Wortmarke, die die
mit dem Bündel ausgelieferte PT Serif braucht — ein `<img>` fiele auf
irgendeine Serife des Betrachtergeräts zurück.

Das Favicon kann das nicht: es wird ohne Dokument geladen und schreibt seine
Farben deshalb aus. Die doppelte Fassung ist bewusst und wird gemessen statt
verabredet — `ProductLockup.test.tsx` vergleicht die sieben Rechtecke der
Komponente Form für Form mit denen der Favicon-Datei und deren Füllfarben mit
den Tokens.

## Consequences

- Der Browser-Reiter zeigt ein Zeichen; das Anmeldebild nennt Software und
  Installation getrennt. Beides ist **nutzersichtbar** und beabsichtigt.
- `--brand-mark-*` sind eine neue Kategorie in der Tokendatei: fest, nicht
  mandantenabhängig. Wer eine vierte Farbe braucht, legt sie dort an — und
  begründet, warum auch sie der Software gehört.
- Zwei Dateien tragen dieselbe Zeichnung. Das ist eine Doppelung mit Wächter,
  keine stille: eine Änderung an einer der beiden macht den Test rot.
- Der Name steht an vier Stellen, die ein Betreiber nicht überschreiben kann:
  Seitentitel, Anmelde-Überschrift, Testmail-Betreff, Alarm-Betreff. Wer eine
  Installation umbenennen will, benennt die Organisation um — nicht die
  Software. Drei E2E-Läufe halten die Anmelde-Überschrift fest, ein
  Integrationstest den Testmail-Betreff.
- Die App-Kopfzeile bleibt davon unberührt: sie trägt Logo und Namen der
  Organisation, deren Daten auf dem Schirm sind.
- Das Mailbild ist **nicht** Teil dieser Entscheidung. Verlässt die Wortmarke
  das Dokument (Mail, Export), gehören ihre Buchstaben in Pfade, weil dort
  keine Schrift mitgeliefert wird.

## References

- `apps/web/src/brand/ProductLockup.tsx`, `apps/web/public/favicon.svg`
- `apps/web/src/styles/tokens.css` — `--brand-mark-*`, `--layout-product-mark`
