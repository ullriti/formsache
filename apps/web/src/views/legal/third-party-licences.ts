import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

/**
 * **Die Liste der verwendeten Drittkomponenten, geholt statt gebündelt**
 * (Review-Runde 3 Nr. 14).
 *
 * Erzeugt von `tools/licences.ts` aus der Sperrdatei, eingecheckt unter
 * `apps/web/public/`. Die Begründung für beides — warum erzeugt, warum
 * eingecheckt, warum die Wortlaute und nicht nur die Kennungen — steht dort;
 * hier steht nur, wie sie in die Ansicht kommt.
 *
 * ## Warum `fetch` und kein Import
 *
 * Ein `import … from '…json'` landete im Hauptbündel, und das lädt jede
 * Ansicht dieser Anwendung — auch die Formularausfüllung, die von
 * Drittkomponenten nichts wissen muss. Ein knappes halbes Megabyte für eine
 * Seite, die selten aufgerufen wird, gehört neben das Bündel und nicht hinein.
 *
 * ## Warum trotzdem ein Zod-Schema
 *
 * Weil es Fremddaten sind, sobald sie über das Netz kommen: eine veraltete
 * Datei im Zwischenspeicher eines Browsers, eine halb ausgelieferte Antwort
 * eines Reverse-Proxy. Dieselbe Regel wie überall in diesem Projekt — was
 * hereinkommt, kommt als `unknown` herein und wird geparst.
 */

const thirdPartyPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  spdx: z.string(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  /** Schlüssel in {@link thirdPartyLicencesSchema}`.texts`, oder `null`. */
  text: z.string().nullable(),
});

export const thirdPartyLicencesSchema = z.object({
  source: z.string(),
  texts: z.record(z.string(), z.string()),
  packages: z.array(thirdPartyPackageSchema),
});

export type ThirdPartyLicences = z.infer<typeof thirdPartyLicencesSchema>;
export type ThirdPartyPackage = z.infer<typeof thirdPartyPackageSchema>;

/** Die Adresse der ausgelieferten Datei — absolut, sie liegt an der Wurzel. */
export const THIRD_PARTY_LICENCES_PATH = '/drittanbieter-lizenzen.json';

export function useThirdPartyLicences(): UseQueryResult<ThirdPartyLicences> {
  return useQuery({
    queryKey: ['third-party-licences'],
    /*
      Sie ändert sich nur mit einer neuen Ausgabe der Anwendung. `staleTime`
      unendlich heißt deshalb nicht „veraltet in Kauf nehmen", sondern „ein
      zweiter Abruf innerhalb derselben Sitzung ist verlorene Zeit".
    */
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const response = await fetch(THIRD_PARTY_LICENCES_PATH, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(
          `Die Liste der Drittkomponenten antwortete mit ${String(response.status)}.`,
        );
      }
      return thirdPartyLicencesSchema.parse(await response.json());
    },
  });
}

/**
 * Die Pakete, gebündelt nach dem **Wortlaut** ihrer Lizenz.
 *
 * Der Wortlaut und nicht die Kennung ist das Ordnungsmerkmal, und das ist
 * keine Feinheit: 357 Pakete tragen rund 215 verschiedene Texte, weil sich
 * MIT-Texte in der Copyright-Zeile unterscheiden — und genau diese Zeile ist
 * das, was die MIT-Lizenz mitzuliefern verlangt. Nach Kennung gruppiert
 * stünde dort einmal „MIT" und 250-mal derselbe Text ohne fremde
 * Urheberangabe, also gerade nicht das Geschuldete.
 *
 * Die Pakete **ohne** Wortlaut stehen als eigene Gruppe am Ende, damit die
 * Lücke sichtbar ist statt weggelassen.
 */
export interface LicenceGroup {
  /** Der Schlüssel des Wortlauts, oder `null` für die Gruppe ohne. */
  readonly key: string | null;
  readonly text: string | null;
  readonly packages: readonly ThirdPartyPackage[];
}

export function groupByLicenceText(
  document: ThirdPartyLicences,
): readonly LicenceGroup[] {
  const groups = new Map<string | null, ThirdPartyPackage[]>();
  for (const entry of document.packages) {
    const bucket = groups.get(entry.text);
    if (bucket === undefined) {
      groups.set(entry.text, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  /*
    `flatMap` statt `filter` + `map`: nur so ist `key` danach wirklich ein
    String. Ein `filter` engt den Typ eines destrukturierten Tupels nicht ein,
    und die Alternative wäre eine Behauptung (`key!`) an einer Stelle, an der
    der Code sie gar nicht braucht.
  */
  const withText = [...groups]
    .flatMap(([key, packages]) =>
      key === null
        ? []
        : [{ key, text: document.texts[key] ?? null, packages }],
    )
    // Die größte Gruppe zuerst — das ist die, unter der die meisten Namen
    // stehen, und damit die, die ein Suchender zuerst aufschlägt.
    .sort(
      (a, b) =>
        b.packages.length - a.packages.length ||
        (a.packages[0]?.name ?? '').localeCompare(b.packages[0]?.name ?? ''),
    );

  const without = groups.get(null);
  return without === undefined
    ? withText
    : [...withText, { key: null, text: null, packages: without }];
}
