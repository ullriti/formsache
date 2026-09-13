import type { LegalDocument, LegalTemplate } from './legal.ts';

/**
 * **Was in zwei Rechtstexten steht, tippt man einmal** (Review-Runde 3
 * Nr. 3 und Nr. 16).
 *
 * ## Der Befund
 *
 * *„Einrichtung: Ich muss mehrfach das gleiche eingeben (Betreiber, …)."*
 *
 * Er stimmte, und zwar in beträchtlichem Umfang. Gemessen an den Vorlagen
 * selbst teilen sich die drei Seiten der Installation und die zwei einer
 * Organisation Platzhalter, darunter die, die jeder zuerst ausfüllt:
 *
 * | Platzhalter | steht in |
 * |---|---|
 * | `NAME_DES_BETREIBERS` | Impressum **und** Datenschutzerklärung |
 * | `STRASSE_UND_HAUSNUMMER`, `PLZ`, `ORT` | ebenso, auf beiden Ebenen |
 * | `TELEFONNUMMER` | ebenso |
 * | `AUFSICHTSBEHOERDE` | ebenso |
 *
 * Wer eine Installation einrichtet, tippte seine Anschrift zweimal. Wer sich
 * dabei einmal vertippt, hat zwei Rechtstexte mit verschiedenen Anschriften —
 * und das ist nicht bloß unbequem, sondern eine widersprüchliche
 * Pflichtangabe.
 *
 * ## Die Entscheidung: mitführen, nicht zusammenlegen
 *
 * Vier Möglichkeiten standen zur Wahl:
 *
 * | | Ansatz | Bewertung |
 * |---|---|---|
 * | **(a)** | **Gemeinsame Werte in einer eigenen Ablage**, die beim Rendern eingesetzt werden | **Verworfen.** Ändert das Speicherformat von `system_setting.legal_pages` und `tenant.legal_pages`, also eine Migration über echte Rechtstexte — und nimmt die Möglichkeit, in einem Text bewusst etwas anderes zu schreiben (eine abweichende Anschrift für Datenschutzanfragen ist ein normaler Fall). |
 * | **(b)** | **Ein gemeinsamer Abschnitt „Angaben zur Stelle" vor den Seiten** | **Verworfen**, aus demselben Grund wie (a) plus einem eigenen: die Vorlagen stammen aus `docs/legal/vorlagen/` und sind dort geprüft; ihre Feldlisten hier umzusortieren hieße, die Prüfung zu verlassen. |
 * | **(c)** | **Beim Tippen mitführen** — ein Wert, der in mehreren Seiten steht, wandert in die anderen mit, solange sie ihn nicht bewusst anders tragen | **Gewählt.** |
 * | **(d)** | **Nur einen Hinweis anzeigen** („steht auch in …") | **Verworfen** als alleinige Antwort: es bleibt beim mehrfachen Tippen, nur weiß man jetzt davon. |
 *
 * **(c) ändert am Gespeicherten nichts**: jede Seite trägt ihre Felder
 * weiterhin selbst, das Schema, die Wire-Verträge und das Rendern bleiben
 * unangetastet. Was sich ändert, ist allein, wie viele Tastenanschläge
 * dasselbe Ergebnis kostet.
 *
 * ## Die Bedingung, die den bewusst abweichenden Wert schützt
 *
 * Mitgeführt wird in eine andere Seite nur, wenn deren Feld **leer** ist oder
 * **noch den alten Wert trägt** — also nachweislich mitgelaufen ist. Wer in
 * der Datenschutzerklärung eine andere Anschrift einträgt als im Impressum,
 * behält sie: ab da läuft dieses eine Feld nicht mehr mit. Das ist der ganze
 * Unterschied zu (a), und er ist der Grund, warum (c) tragbar ist.
 */

/**
 * Welche Platzhalter in mehr als einer der übergebenen Vorlagen stehen.
 *
 * Aus den Vorlagen abgeleitet und nirgends aufgezählt: eine getippte Liste
 * wäre die zweite Wahrheit, und sie ginge beim ersten neuen Feld auseinander.
 */
export function sharedSlotKeys(
  templates: readonly LegalTemplate[],
): ReadonlySet<string> {
  const seen = new Map<string, number>();
  for (const template of templates) {
    // `Set` je Vorlage: stünde ein Schlüssel zweimal in **derselben** Liste,
    // wäre er dadurch noch nicht geteilt.
    for (const key of new Set(template.slots.map((slot) => slot.key))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return new Set(
    [...seen].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

/**
 * Übernimmt eine Änderung an **einer** Seite und führt die geteilten Werte in
 * die übrigen mit.
 *
 * @param pages Alle Seiten dieser Ebene, so wie sie gerade stehen.
 * @param templates Die Vorlagen dazu — sie entscheiden, welche Seite welches
 *   Feld überhaupt hat. Eine Seite bekommt nie ein Feld, das ihre Vorlage
 *   nicht kennt: das wäre ein Wert, den niemand sieht und der beim nächsten
 *   Speichern trotzdem mitginge.
 * @param page Die Seite, an der getippt wurde. **`NoInfer`**, und das ist
 *   nötig: ohne das leitete TypeScript `K` auch aus diesem Argument ab und
 *   engte es damit auf genau die eine getippte Seite ein — der Rückgabewert
 *   kennte die Nachbarseiten dann nicht mehr, obwohl er sie trägt.
 * @param next Ihr neuer Stand.
 */
export function applySharedFills<K extends string>(
  pages: Readonly<Record<K, LegalDocument>>,
  templates: Readonly<Record<K, LegalTemplate>>,
  page: NoInfer<K>,
  next: LegalDocument,
): Record<K, LegalDocument> {
  const previous = pages[page];
  const result: Record<K, LegalDocument> = { ...pages, [page]: next };

  const shared = sharedSlotKeys(Object.values<LegalTemplate>(templates));
  const changed = [
    ...new Set([...Object.keys(previous.fills), ...Object.keys(next.fills)]),
  ].filter(
    (key) =>
      shared.has(key) &&
      (previous.fills[key] ?? '') !== (next.fills[key] ?? ''),
  );
  if (changed.length === 0) {
    return result;
  }

  for (const key of Object.keys(pages) as K[]) {
    if (key === page) {
      continue;
    }
    const template = templates[key];
    const other = pages[key];
    const carried: Record<string, string> = { ...other.fills };
    let touched = false;
    for (const slot of changed) {
      if (!template.slots.some((entry) => entry.key === slot)) {
        continue;
      }
      const current = (other.fills[slot] ?? '').trim();
      const before = (previous.fills[slot] ?? '').trim();
      // Leer, oder noch der alte Wert: dann lief dieses Feld mit und läuft
      // weiter mit. Alles andere ist eine bewusste Abweichung und bleibt.
      if (current !== '' && current !== before) {
        continue;
      }
      carried[slot] = next.fills[slot] ?? '';
      touched = true;
    }
    if (touched) {
      result[key] = { ...other, fills: carried };
    }
  }

  return result;
}
