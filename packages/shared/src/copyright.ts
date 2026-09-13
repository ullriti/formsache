/**
 * **Der Urheberrechtsvermerk der Software — aus der Lizenzdatei gelesen, nicht
 * abgeschrieben** (Review-Runde 3 Nr. 10 und Nr. 15).
 *
 * ## Zwei Befunde, eine Ursache
 *
 * „Wo steht copyright Tilo Ullrich?" — nirgends sichtbar. Der Name stand
 * ausschließlich im eingebetteten MIT-Text auf `/licences`, also acht
 * Bildschirmzeilen tief in einem Kasten mit vorformatierter Schrift. Die
 * Fußzeile nannte die Software und die Lizenz und ließ die Person weg, der
 * beides gehört.
 *
 * „Wird die Jahreszahl beim Copyright automatisch aktualisiert?" — nein, denn
 * es gab keine anzuzeigende Jahreszahl.
 *
 * ## Warum die Datei die Quelle ist und keine Konstante daneben
 *
 * `LICENSE` trägt den Vermerk bereits, und zwar als **die** rechtsverbindliche
 * Fassung: Wer die Software weitergibt, gibt genau diesen Text mit. Eine
 * zweite, getippte Angabe im Quelltext wäre eine zweite Wahrheit über fremdes
 * Urheberrecht — und diejenige, die auseinanderläuft, wäre die in der Fußzeile,
 * weil sie niemand beim Weitergeben liest.
 *
 * `LicencesView` bindet die Datei ohnehin über `?raw` ein. Diese Funktion liest
 * denselben String; damit gibt es keinen Weg, den Namen an der einen Stelle zu
 * ändern und an der anderen stehen zu lassen.
 *
 * ## Warum das Jahr des Baus und nicht die Uhr der Lesenden
 *
 * Ein Urheberrechtsvermerk nennt den Zeitraum der Veröffentlichung. „Bis
 * heute" wäre über die Uhr des Browsers zu haben und gerade deshalb falsch:
 * ein Rechner, dessen Datum um zwei Jahre danebenliegt, ließe die Anwendung
 * eine Veröffentlichung behaupten, die es nicht gab. Das Jahr kommt deshalb
 * vom **Bau** dieser Ausgabe (`__BUILD_YEAR__`, gesetzt in
 * `apps/web/vite.config.ts`) — das ist der Zeitpunkt, zu dem die vorliegende
 * Fassung tatsächlich herausgegeben wurde.
 */

/** Was {@link parseMitCopyright} aus der Lizenzdatei herausliest. */
export interface MitCopyright {
  /** Das Jahr der Erstveröffentlichung, wie es in `LICENSE` steht. */
  readonly year: number;
  /** Der Name, dem das Urheberrecht zusteht. */
  readonly holder: string;
}

/**
 * Liest `Copyright (c) <Jahr> <Name>` aus einem MIT-Lizenztext.
 *
 * Wirft, statt einen Ersatzwert zu liefern: ein leerer oder erfundener
 * Urheberrechtsvermerk in der Fußzeile wäre schlimmer als eine rote Prüfung.
 * Der Aufruf steht in einem Modul-Rumpf, die Ausnahme fällt also beim ersten
 * Rendern und nicht irgendwann später.
 */
export function parseMitCopyright(licence: string): MitCopyright {
  // `(c)`, `(C)` und `©` — die drei Schreibweisen, die in freier Wildbahn in
  // MIT-Texten stehen. Der Name reicht bis zum Zeilenende; ein zweites Jahr
  // („2026-2027") bleibt bewusst außen vor, weil das Enddatum hier aus dem Bau
  // kommt und nicht aus der Datei.
  const match = /^Copyright\s+(?:\((?:c|C)\)|©)\s+(\d{4})\s+(.+?)\s*$/m.exec(
    licence,
  );
  if (match === null) {
    throw new Error(
      'In LICENSE steht keine Zeile „Copyright (c) <Jahr> <Name>". ' +
        'Der Urheberrechtsvermerk der Fußzeile wird daraus gelesen.',
    );
  }
  return { year: Number(match[1]), holder: match[2] ?? '' };
}

/**
 * Der Zeitraum als Text: ein Jahr, oder eine Spanne mit Halbgeviertstrich.
 *
 * `untilYear` kleiner als das Startjahr ergibt das Startjahr allein — eine
 * rückwärts laufende Spanne wäre die eine Ausgabe, die ganz sicher falsch ist,
 * und sie entstünde bei einem Bau auf einer Maschine mit falscher Uhr.
 */
export function copyrightYears(startYear: number, untilYear: number): string {
  return untilYear > startYear
    ? `${String(startYear)}–${String(untilYear)}`
    : String(startYear);
}

/** Die fertige Zeile, so wie sie in der Fußzeile steht. */
export function copyrightNotice(
  copyright: MitCopyright,
  untilYear: number,
): string {
  return `© ${copyrightYears(copyright.year, untilYear)} ${copyright.holder}`;
}
