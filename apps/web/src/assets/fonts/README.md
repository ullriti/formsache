# PT Serif (selbst gehostet)

Titel und Überschriften der Anwendung laufen in **PT Serif** .
Der Prototyp lud die Schrift vom Google-Fonts-CDN; das ist für die öffentlich
erreichbaren Ausfüll-Ansichten keine Option, weil dabei die IP-Adresse jeder
teilnehmenden Person an einen Dritten geht. Die Dateien liegen
deshalb im Repo und werden mit dem Bundle ausgeliefert. **Zur Laufzeit geht
keine Schrift-Anfrage ins Netz.**

## Inhalt

| Datei                    | Schnitt        | Größe   |
| ------------------------ | -------------- | ------- |
| `pt-serif-regular.woff2` | Regular (400)  | 90.6 kB |
| `pt-serif-bold.woff2`    | Bold (700)     | 77.6 kB |

Kursiv und Fett-Kursiv fehlen bewusst: keine Ansicht des Design-Handoffs setzt
Serif kursiv. Wer eine kursive Überschrift einführt, bekommt heute einen
synthetisch geneigten Schnitt vom Browser — dann gehört der echte Schnitt hier
ergänzt (siehe unten), statt es dabei zu belassen.

Die `@font-face`-Regeln stehen in `apps/web/src/styles/fonts.css`, dort ist auch
die Wahl von `font-display` begründet.

## Herkunft und Umwandlung

Quelle ist das Debian-/Ubuntu-Paket `fonts-paratype` (ParaType Ltd., PT Serif
Version 1.002):

- `PTF55F.ttf` → `pt-serif-regular.woff2`
- `PTF75F.ttf` → `pt-serif-bold.woff2`

```sh
woff2_compress PTF55F.ttf   # 327.1 kB TTF → 90.6 kB WOFF2
woff2_compress PTF75F.ttf   # 301.5 kB TTF → 77.6 kB WOFF2
```

## Regeln für alle, die diese Dateien anfassen

- **Kein Subsetting, keine Modifikation.** Die *ParaType Free Font License*
  (vollständig in `LICENSE.txt`) erlaubt das Bündeln und Ausliefern über
  Webserver ausdrücklich, verbietet aber, **veränderte** Fassungen unter dem
  Originalnamen zu verbreiten. Ein Subset wäre eine Veränderung und bräuchte
  eine Umbenennung oder eine schriftliche Erlaubnis von ParaType. Beides tun
  wir nicht — die Umwandlung nach WOFF2 tauscht nur den Container, das
  Glyphenmaterial bleibt unangetastet.
- **`LICENSE.txt` bleibt neben den Schriftdateien.** Die Lizenz verlangt, dass
  Lizenztext und Copyright-Vermerk mitverbreitet werden und leicht auffindbar
  sind. Wer die Fonts an eine andere Stelle verschiebt, verschiebt die Lizenz
  mit.
- **Keine CDN-URL, kein `@import` von außen** — weder hier noch in einer
  Ansicht. Das ist der Grund, warum die Dateien überhaupt im Repo liegen.
