/**
 * Werte, die beim Bauen eingesetzt werden (`define` in `vite.config.ts`).
 *
 * Eine eigene Datei und kein `declare global` in einem Modul: `define`
 * ersetzt den Bezeichner im Quelltext, es gibt also zur Laufzeit weder Import
 * noch Modul, an dem die Angabe hängen könnte.
 */

/** Das Jahr, in dem diese Ausgabe gebaut wurde — siehe `shared/copyright.ts`. */
declare const __BUILD_YEAR__: number;
