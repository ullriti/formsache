import { useState, type ReactElement } from 'react';

import fontLicence from '../../assets/fonts/LICENSE.txt?raw';
import softwareLicence from '../../../../../LICENSE?raw';
import { PublicLegalFooter } from '../../fill/PublicLegalFooter';
import {
  groupByLicenceText,
  useThirdPartyLicences,
  type LicenceGroup,
} from './third-party-licences';

import './legal.css';
import './third-party-licences.css';

/**
 * **Lizenzen und Urheberrecht** — the one legal-text page that stands *fixed in
 * the code* (`docs/legal/vorlagen/08-urheberrecht-und-lizenzhinweise.md`).
 *
 * ## Why nobody may edit it
 *
 * Because foreign copyrights stand here. „Ein Betreiber, der einen fremden
 * Copyright-Vermerk bearbeiten könnte, könnte ihn auch entfernen" — and that
 * would be a violation of the MIT licence and at the same time an infringement
 * of copyright. It is therefore not a document in
 * `system_setting.legal_pages` but this file.
 *
 * ## What it closes
 *
 * A **gap that is open today** (`docs/legal/README.md` 7.10): the ParaType Free
 * Font License explicitly demands that its notice travels with the font files
 * („it must be easily viewed by users"). The two `.woff2` go to every browser
 * of every participating person; the licence file lay in the repository and was
 * not taken over into `dist/` by `vite build`, because no module imported it.
 *
 * **Now one does import it** — over `?raw`, not as a typed-out constant. That
 * is the whole trick and the reason why no test that compares two versions is
 * needed here: there *is* no second version. What stands on this page is byte
 * for byte the file that lies next to the font files, and the same holds for
 * `LICENSE` at the root of the repository. The licence text says itself: „You
 * have no right to modify the text of Licensing Agreement" — a copy in the
 * source would be the permission to do exactly that.
 *
 * ## Die Drittkomponenten (Review-Runde 3 Nr. 14)
 *
 * An dieser Stelle stand bis hierher ein Absatz, der einem beliebigen
 * Besucher der Seite einen internen Rückstand gestand: die vollständige Liste
 * werde „derzeit **nicht** ausgeliefert", sie sei „ein offener Punkt und in
 * ADR-0028 als solcher benannt". Beides war schlecht — die öffentliche
 * Selbstanzeige und der Rückstand.
 *
 * Der Absatz ist weg, weil die Liste da ist: `tools/licences.ts` erzeugt sie
 * aus der Sperrdatei, {@link ThirdPartyLicenceList} zeigt sie. Und sie zeigt
 * die **Wortlaute**, nicht bloß die Kennungen — „MIT" zu nennen genügt der
 * MIT-Lizenz nicht, sie verlangt die fremde Copyright-Zeile mitzuliefern.
 */
export function LicencesView(): ReactElement {
  return (
    <main className="legal">
      <article className="legal__card">
        <p className="legal__owner">Betrieb dieser Plattform</p>
        <h1 className="legal__title">Lizenzen und Urheberrecht</h1>

        <div className="legal-text">
          <h2 className="legal-text__h2">Die Software</h2>
          <p className="legal-text__p">
            Diese Anwendung beruht auf <strong>Formsache</strong>, einer
            quelloffenen Formular- und Umfrageplattform. Formsache steht unter
            der <strong>MIT-Lizenz</strong>:
          </p>
          {/*
            `<pre>` with a text child, not `dangerouslySetInnerHTML`: a licence
            text is text, even when it comes out of a file. React defuses it
            anyway; the construction nevertheless stays the same one
            `LegalText.tsx` keeps for the legal texts.
          */}
          <pre className="legal-text__licence">{softwareLicence.trim()}</pre>

          <h3 className="legal-text__h3">Was das heißt und was nicht</h3>
          <p className="legal-text__p">
            Wer diese Installation betreibt, ist <strong>nicht</strong> der
            Urheber der Software und bietet sie nicht an. Die Bezeichnung
            Formsache benennt die Software, nicht diese Installation. Die
            MIT-Lizenz erteilt keine Markenrechte; aus dem Einsatz der Software
            folgt keine Verbindung zu den Urhebern und keine Billigung durch
            sie.
          </p>

          <h2 className="legal-text__h2">Die verwendete Schrift</h2>
          <p className="legal-text__p">
            Überschriften und Titel dieser Anwendung laufen in{' '}
            <strong>PT Serif</strong>. Die Schriftdateien werden von diesem
            Server ausgeliefert und <strong>nicht</strong> von einem fremden
            Netzwerk geladen; dabei werden keine Daten an ParaType oder Dritte
            übertragen. Die Schnitte Regular (400) und Bold (700) wurden
            unverändert in das WOFF2-Format umgepackt, ohne Teilmengenbildung
            und ohne Änderung der Zeichenzeichnungen.
          </p>
          <pre className="legal-text__licence">{fontLicence.trim()}</pre>

          <h2 className="legal-text__h2">Verwendete Drittkomponenten</h2>
          <ThirdPartyLicenceList />

          <h2 className="legal-text__h2">Das Produktzeichen</h2>
          <p className="legal-text__p">
            Das Zeichen der Software gehört zur Software und nicht zu dieser
            Installation. Es wandert nicht mit den Farben einer Organisation mit
            und steht an Stellen, an denen noch gar keine Organisation
            feststeht.
          </p>

          <h2 className="legal-text__h2">Inhalte der Organisationen</h2>
          <p className="legal-text__p">
            Fragetexte, Erläuterungen, Logos, Marken und Erscheinungsbilder der
            Organisationen, die über diese Anwendung Formulare bereitstellen,
            gehören den jeweiligen Organisationen. Wer eine Organisation ist und
            wie sie erreichbar ist, steht in der Fußzeile ihrer Formulare.
          </p>

          <h2 className="legal-text__h2">Ihre Eingaben</h2>
          <p className="legal-text__p">
            Die Angaben, die Sie in ein Formular eintragen, und die Dateien, die
            Sie hochladen, bleiben Ihre. Weder der Betrieb dieser Plattform noch
            die Urheber der Software leiten daraus Rechte ab. Wie die
            betreffende Organisation damit umgeht, steht in ihren
            Datenschutzhinweisen.
          </p>
        </div>
      </article>

      <PublicLegalFooter />
    </main>
  );
}

/**
 * **Die Drittkomponenten, gruppiert nach dem Wortlaut ihrer Lizenz.**
 *
 * ## Warum eine Gruppe je Wortlaut und nicht je Kennung
 *
 * Weil die Pflicht am Wortlaut hängt. Die MIT-Lizenz verlangt, dass „the
 * above copyright notice **and** this permission notice" mitgeliefert werden —
 * und die Copyright-Zeile ist bei jedem Paket eine andere. Nach Kennung
 * gruppiert stünde hier einmal „MIT" und darunter ein Text ohne fremde
 * Urheberangabe, also gerade nicht das Geschuldete. Nach Wortlaut gruppiert
 * steht jeder fremde Vermerk genau einmal da, mit allen Paketen, für die er
 * gilt.
 *
 * ## Warum die Wortlaute zugeklappt sind
 *
 * 215 vollständige Lizenztexte sind ausgedruckt rund 200 Seiten. Zugeklappt
 * ist die Seite lesbar, aufgeklappt vollständig — und `<details>` ist der eine
 * Baustein, den auch ein Bildschirmleser und die Suchfunktion des Browsers
 * ohne Zutun bedienen. Was **nicht** zugeklappt ist: die Namen der Pakete und
 * ihre Fassungen. Die stehen offen, denn sie sind die Auskunft, wegen der
 * jemand diese Seite überhaupt aufschlägt.
 *
 * ## Der Ladezustand ist echt
 *
 * Die Liste kommt über das Netz (`third-party-licences.ts`). Schlägt der Abruf
 * fehl, steht hier ein Satz mit dem Weg zur Datei — und nicht die alte
 * Selbstanzeige, die Review-Runde 3 Nr. 14 beanstandet hat.
 */
function ThirdPartyLicenceList(): ReactElement {
  const licences = useThirdPartyLicences();

  if (licences.isPending) {
    return (
      <p className="legal-text__p" role="status">
        Die Liste der Drittkomponenten wird geladen…
      </p>
    );
  }

  if (licences.data === undefined) {
    return (
      <p className="legal-text__p" role="alert">
        Die Liste der Drittkomponenten konnte nicht geladen werden. Sie liegt
        als Datei unter{' '}
        <a href="/drittanbieter-lizenzen.json">/drittanbieter-lizenzen.json</a>{' '}
        bereit.
      </p>
    );
  }

  const groups = groupByLicenceText(licences.data);
  const count = licences.data.packages.length;

  return (
    <>
      <p className="legal-text__p">
        Diese Anwendung verwendet {count} quelloffene Programmbibliotheken.
        Nachstehend jede mit Fassung, Lizenz und dem Wortlaut, unter dem sie
        steht — erzeugt aus der Sperrdatei dieser Ausgabe, nicht von Hand
        gepflegt.
      </p>
      <ul className="third-party">
        {groups.map((group) => (
          <ThirdPartyGroup key={group.key ?? 'ohne-wortlaut'} group={group} />
        ))}
      </ul>
    </>
  );
}

function ThirdPartyGroup({
  group,
}: {
  readonly group: LicenceGroup;
}): ReactElement {
  /*
    Der Zustand liegt hier und nicht am `<details>`: aufgeklappt bleibt es
    beim Weiterlesen, und der Text wird erst dann überhaupt in das Dokument
    gestellt. Bei 215 Gruppen ist das der Unterschied zwischen einer Seite,
    die sofort da ist, und einer, die eine halbe Sekunde blockiert.
  */
  const [open, setOpen] = useState(false);
  const spdx = [...new Set(group.packages.map((entry) => entry.spdx))].join(
    ', ',
  );

  return (
    <li className="third-party__group">
      <p className="third-party__licence">
        {group.text === null ? 'Ohne beigelegten Lizenztext' : spdx}
      </p>
      <ul className="third-party__packages">
        {group.packages.map((entry) => (
          <li key={`${entry.name}@${entry.version}`}>
            <span className="third-party__name">{entry.name}</span>{' '}
            <span className="third-party__version">{entry.version}</span>
            {entry.author === null ? null : (
              <>
                {' — '}
                <span className="third-party__author">{entry.author}</span>
              </>
            )}
            {entry.homepage === null ? null : (
              <>
                {' '}
                <a
                  className="third-party__home"
                  href={entry.homepage}
                  rel="noreferrer nofollow"
                >
                  Projektseite
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      {group.text === null ? (
        <p className="third-party__missing">
          Diese Pakete bringen keine Lizenzdatei mit. Es gilt die oben genannte
          Kennung ({spdx}); der Wortlaut steht beim jeweiligen Projekt.
        </p>
      ) : (
        <details
          className="third-party__text"
          open={open}
          onToggle={(event) => {
            setOpen(event.currentTarget.open);
          }}
        >
          <summary>Wortlaut der Lizenz</summary>
          {open ? (
            <pre className="legal-text__licence">{group.text}</pre>
          ) : null}
        </details>
      )}
    </li>
  );
}
