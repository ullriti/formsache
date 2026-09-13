# Vorlage 08 — Urheberrecht und Lizenzhinweise

> **Wer füllt das aus:** niemand. **Diese Seite gehört fest in den Code.**
> Sie ist für jede Installation identisch und darf von keinem Betreiber
> geändert werden — ein Betreiber, der einen fremden Copyright-Vermerk
> bearbeiten könnte, könnte ihn auch entfernen.
> **Wo erscheint es:** unter `/licences`, verlinkt aus der Fußzeile jeder Seite.
>
> 🔴 **Diese Seite schließt eine heute offene Lücke.** Die ParaType Free Font
> License verlangt ausdrücklich: *„You may distribute the fonts … only together
> with this Licensing Agreement and with above copyright notice … it must be
> easily viewed by users."* Die beiden Schriftdateien werden an **jeden Browser
> jeder teilnehmenden Person** ausgeliefert; die Lizenzdatei liegt bislang nur
> im Repository und wird von `vite build` nicht nach `dist/` übernommen. Diese
> Seite ist der „easily viewed" verlangende Ort.
>
> ⚠️ **Der Abschnitt 3 (Drittkomponenten) ist zu erzeugen, nicht abzuschreiben.**
> Er ändert sich mit jeder Abhängigkeitspflege.

---

# Lizenzen und Urheberrecht

## 1. Die Software

Diese Anwendung beruht auf **Formsache**, einer quelloffenen Formular- und
Umfrageplattform.

Formsache steht unter der **MIT-Lizenz**:

```
MIT License

Copyright (c) 2026 Tilo Ullrich

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Der Quelltext ist abrufbar unter [[ADRESSE_DES_QUELLTEXT_REPOSITORIUMS]].

> ⚠️ Der Copyright-Vermerk darf **nicht** geändert oder entfernt werden. Wird
> die Zeile „Copyright (c) 2026 Tilo Ullrich" gepflegt (weitere Beitragende,
> späteres Jahr), ist der Wortlaut aus der Datei `LICENSE` des Repositoriums zu
> übernehmen — dort, nicht hier, ist die Wahrheit.

### Was das heißt und was nicht

**[[NAME_DES_BETREIBERS]] betreibt diese Installation. Er ist nicht der Urheber
der Software und bietet sie nicht an.**

Die Bezeichnung **Formsache** benennt die Software, nicht diese Installation.
Die MIT-Lizenz erteilt keine Markenrechte; aus dem Einsatz der Software folgt
keine Verbindung zwischen [[NAME_DES_BETREIBERS]] und den Urhebern und keine
Billigung durch sie.

## 2. Die verwendete Schrift

Überschriften und Titel dieser Anwendung laufen in **PT Serif**.

**PT Serif** — Copyright © 2009, ParaType Ltd. All Rights Reserved.

Die Schriftdateien werden von diesem Server ausgeliefert und **nicht** von einem
fremden Netzwerk geladen; dabei werden keine Daten an ParaType oder Dritte
übertragen. Die Schnitte Regular (400) und Bold (700) wurden unverändert aus
dem Debian-/Ubuntu-Paket `fonts-paratype` (PT Serif Version 1.002) in das
WOFF2-Format umgepackt, ohne Teilmengenbildung und ohne Änderung der
Zeichenzeichnungen.

Es gilt die **ParaType Free Font License**:

```
                        ParaType Free Font License

GRANT OF LICENSE

ParaType Ltd grants you the right to use, copy, modify the fonts and distribute
modified and unmodified copies of the fonts by any means, including placing
on Web servers for free downloading, embedding in documents and Web pages,
bundling with commercial and non commercial products, if it does not conflict
with the conditions listed below:

- You may bundle the font with commercial software, but you may not sell the
  fonts by themselves. They are free.

- You may distribute the fonts in modified or unmodified version only together
  with this Licensing Agreement and with above copyright notice. You have no
  right to modify the text of Licensing Agreement. It can be placed in a separate
  text file or inserted into the font file, but it must be easily viewed by users.

- You may not distribute modified version of the font under the Original name
  or a combination of Original name with any other words without explicit written
  permission from ParaType.

TERMINATION & TERRITORY

This license has no limits on time and territory, but it becomes null and void
if any of the above conditions are not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK,
OR OTHER RIGHT. IN NO EVENT SHALL PARATYPE BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL,
INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.

ParaType Ltd
http://www.paratype.ru
```

> ⚠️ **Der Lizenztext darf nicht geändert werden** — das sagt er selbst
> („You have no right to modify the text of Licensing Agreement"). Er ist
> deshalb wörtlich aus `apps/web/src/assets/fonts/LICENSE.txt` zu übernehmen.
> Wer eine weitere Schrift oder einen weiteren Schnitt aufnimmt, ergänzt diesen
> Abschnitt in derselben Änderung.

## 3. Verwendete Drittkomponenten

Diese Anwendung verwendet quelloffene Programmbibliotheken. Die vollständige
Liste mit Version, Lizenz und Copyright-Vermerk steht unter
[[ADRESSE_DER_DRITTLIZENZLISTE, z. B. /licences/dritte]].

> ⚠️ **An die Entwicklung — dieser Abschnitt wird erzeugt, nicht gepflegt.**
> Maßgeblich ist, was tatsächlich **ausgeliefert** wird:
>
> - Das Frontend-Bündel (`apps/web/dist/`) geht an jeden Browser. Alles darin
>   Enthaltene wird verbreitet; MIT, BSD und ISC verlangen die Weitergabe des
>   Vermerks, **Apache-2.0 zusätzlich die der `NOTICE`-Datei** (Ziff. 4 lit. d).
> - Das Server-Abbild wird ebenfalls verbreitet, wenn es veröffentlicht wird.
>
> Empfohlen: ein Erzeugungsschritt im Bau, der aus `pnpm-lock.yaml` und den
> Lizenzdateien der Pakete eine `THIRD-PARTY-NOTICES.txt` schreibt, sie in
> `dist/` legt und von dieser Seite verlinkt. Eine von Hand gepflegte Liste
> veraltet mit der ersten Abhängigkeitspflege (ADR-0018).

## 4. Das Produktzeichen

Das Zeichen der Software (Reitersymbol und Wortmarke auf der Anmeldeseite)
gehört zur Software und nicht zu dieser Installation. Es wandert nicht mit den
Farben einer Organisation mit und steht an Stellen, an denen noch gar keine
Organisation feststeht.

## 5. Inhalte der Organisationen

Fragetexte, Erläuterungen, Logos, Marken und Erscheinungsbilder der
Organisationen, die über diese Anwendung Formulare bereitstellen, gehören den
jeweiligen Organisationen. Wer eine Organisation ist und wie sie erreichbar
ist, steht in der Fußzeile ihrer Formulare.

## 6. Ihre Eingaben

Die Angaben, die Sie in ein Formular eintragen, und die Dateien, die Sie
hochladen, bleiben Ihre. Weder [[NAME_DES_BETREIBERS]] noch die Urheber der
Software leiten daraus Rechte ab. Wie die betreffende Organisation damit
umgeht, steht in ihren Datenschutzhinweisen.

---

## Prüfliste für die Umsetzung

- [ ] Seite `/licences` gebaut, aus der Fußzeile **jeder** Seite verlinkt —
      auch der öffentlichen
- [ ] Abschnitt 1 und 2 **fest im Code**, nicht aus einer Einstellung gelesen
- [ ] Abschnitt 2 wörtlich aus `apps/web/src/assets/fonts/LICENSE.txt`
      übernommen; ein Test, der beide Fassungen vergleicht, hält sie zusammen
      (dasselbe Muster, mit dem `ProductLockup.test.tsx` die zwei Fassungen der
      Zeichnung zusammenhält)
- [ ] Abschnitt 1 wörtlich aus `LICENSE`, mit demselben Wächter
- [ ] `THIRD-PARTY-NOTICES` wird im Bau erzeugt und ausgeliefert
- [ ] Die Seite ist **ohne Anmeldung** erreichbar und wird nicht `no-store`
      ausgeliefert
- [ ] Kein Platzhalter `[[…]]` mehr übrig: `[[ADRESSE_DES_QUELLTEXT_REPOSITORIUMS]]`,
      `[[NAME_DES_BETREIBERS]]` und `[[ADRESSE_DER_DRITTLIZENZLISTE]]` kommen
      aus den Systemeinstellungen bzw. sind fest gesetzt
