import type { ReactElement } from 'react';
import {
  LICENCES_PATH,
  copyrightNotice,
  parseMitCopyright,
} from '@formsache/shared';

import softwareLicence from '../../../../LICENSE?raw';

import './product-copyright.css';

/**
 * **Die Zeile „Formsache, MIT-Lizenz, © … " — an einer Stelle, überall
 * dieselbe** (Review-Runde 3 Nr. 9, 10 und 15).
 *
 * ## Drei Befunde, ein Baustein
 *
 * 1. *„… nur im öffentlichen Teil sichtbar. Beabsichtigt?"* — nein. Die Zeile
 *    stand in `PublicLegalFooter`, und die sah nur, wer ein Formular ausfüllt.
 *    Wer in der Anwendung arbeitet, bekam sie nie zu Gesicht; die Nennung der
 *    Software und ihrer Lizenz gehört aber zu **jeder** Ansicht, nicht zu den
 *    öffentlichen. Sie steht deshalb jetzt zusätzlich unter der angemeldeten
 *    Oberfläche (`AppShell`).
 * 2. *„Wo steht copyright Tilo Ullrich?"* — bis hierher nur im eingebetteten
 *    Lizenztext auf `/licences`. Jetzt in der Zeile selbst.
 * 3. *„Wird die Jahreszahl automatisch aktualisiert?"* — jetzt ja, und zwar
 *    aus dem Jahr des Baus statt aus der Uhr der Lesenden.
 *
 * ## Woher Name und Jahr kommen
 *
 * Aus `LICENSE`, über `?raw` — dieselbe Datei, die `LicencesView` im Wortlaut
 * zeigt und die bei jeder Weitergabe mitgeht. Eine getippte Konstante wäre
 * eine zweite Wahrheit über fremdes Urheberrecht, und die auseinanderlaufende
 * wäre die in der Fußzeile. Die Zerlegung steht in
 * `packages/shared/src/copyright.ts` und ist dort geprüft.
 *
 * ## Was hier bewusst **nicht** steht
 *
 * Der Betreiber. „© [Betreiber] — Alle Rechte vorbehalten" wäre eine falsche
 * Aussage über fremde Rechte: die Software steht unter MIT, die Schrift unter
 * der ParaType Free Font License, die Formularinhalte gehören der Organisation
 * und die Antworten den Ausfüllenden (`docs/legal/README.md` 3.7). Wer diese
 * Installation betreibt, steht im Impressum — verlinkt aus der
 * Rechtsfußzeile, nicht hier.
 */

/**
 * Einmal je Prozess zerlegt, im Modul-Rumpf.
 *
 * Die Datei ist zur Bauzeit eingebettet, ändert sich also zur Laufzeit nicht.
 * Und eine fehlende Copyright-Zeile in `LICENSE` soll beim ersten Rendern
 * auffallen, nicht in einer Ausgabe ohne Vermerk (siehe `parseMitCopyright`).
 */
const COPYRIGHT = parseMitCopyright(softwareLicence);

export function ProductCopyright(): ReactElement {
  return (
    <p className="product-copyright">
      Formular- und Umfrageplattform <strong>Formsache</strong>, MIT-Lizenz.{' '}
      {/*
        Der Vermerk in einem eigenen Element, damit er auf schmalen Anzeigen
        als Ganzes umbricht statt mitten im Namen — derselbe Grund wie beim
        Namen der verantwortlichen Stelle eine Ebene höher (Nr. 8).
      */}
      <span className="product-copyright__holder">
        {copyrightNotice(COPYRIGHT, __BUILD_YEAR__)}
      </span>{' '}
      <a href={LICENCES_PATH}>Lizenzen und Urheberrecht</a>
    </p>
  );
}
