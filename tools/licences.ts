#!/usr/bin/env node
/**
 * **Die Liste der verwendeten Drittkomponenten — erzeugt, nicht getippt**
 * (Review-Runde 3 Nr. 14).
 *
 * ## Der Befund
 *
 * Auf `/licences` stand öffentlich: *„Eine vollständige, aus der Sperrdatei
 * erzeugte Liste … wird derzeit **nicht** ausgeliefert; sie ist ein offener
 * Punkt und in ADR-0028 als solcher benannt."* — „Das kann man doch so nicht
 * öffentlich reinschreiben."
 *
 * Richtig, und zwar in beide Richtungen: die Seite gestand einem beliebigen
 * Besucher einen internen Rückstand, und der Rückstand selbst blieb bestehen.
 * Diese Datei behebt beides, indem sie den Rückstand beseitigt — der Absatz
 * verschwindet, weil die Liste da ist.
 *
 * ## Was erzeugt wird
 *
 * `apps/web/public/drittanbieter-lizenzen.json`, gelesen von
 * `views/legal/LicencesView.tsx`.
 *
 * In `public/` und nicht in `src/`: die Datei ist mehrere hundert Kilobyte
 * groß, und nichts davon gehört in das Bündel, das jede Ansicht dieser
 * Anwendung lädt. Als statische Datei liegt sie neben dem Bündel, wird nur
 * beim Aufruf der Lizenzseite geholt und vom Browser zwischengespeichert.
 *
 * ## Warum eingecheckt und nicht beim Bauen erzeugt
 *
 * Weil das Web-Image sie sonst nicht hätte. `apps/web/Dockerfile` installiert
 * mit `--filter=@formsache/web...`; ein `pnpm licenses list` in diesem
 * Container sähe die Laufzeitabhängigkeiten der **API** gar nicht, und die
 * stehen zur Hälfte in dieser Anwendung. Eingecheckt ist die Liste außerdem
 * das, was sie sein soll: ein geprüfter Stand, den ein Mensch bei einer
 * Abhängigkeitsänderung mit ansieht.
 *
 * Damit sie nicht veraltet, hat dieses Werkzeug einen zweiten Modus:
 * `--check` erzeugt in den Speicher und vergleicht. Er läuft in der Pipeline
 * (`quality`), und eine Abhängigkeitsänderung ohne neue Liste ist damit rot
 * statt still falsch.
 *
 * ## Was in der Liste steht — und warum genau das
 *
 * Je Paket: Name, Fassung, SPDX-Kennung, Urheber, Projektadresse und ein
 * Verweis auf den **Wortlaut** der Lizenz. Die Wortlaute stehen einmal je
 * eindeutigem Text in einer eigenen Liste; 339 Pakete teilen sich rund 200
 * Texte, weil sich MIT-Texte nur in der Copyright-Zeile unterscheiden.
 *
 * ⚠️ **Der Wortlaut ist die Pflicht, nicht die Kennung.** „MIT" zu nennen
 * genügt der MIT-Lizenz nicht: sie verlangt, dass *„the above copyright
 * notice and this permission notice"* mitgeliefert werden. Deshalb wird die
 * Lizenzdatei jedes Pakets wörtlich gelesen und wörtlich ausgeliefert — nicht
 * eine Vorlage je Kennung, in der die fremde Copyright-Zeile fehlte.
 *
 * Findet sich in einem Paket keine Lizenzdatei, steht das so in der Liste
 * („kein Lizenztext im Paket enthalten") samt Projektadresse. Eine erfundene
 * Angabe wäre an dieser Stelle das Schlimmste von allem.
 *
 * ## Aufruf
 *
 *   node tools/licences.ts            # erzeugen
 *   node tools/licences.ts --check    # nur vergleichen, nichts schreiben
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET = join(
  ROOT,
  'apps',
  'web',
  'public',
  'drittanbieter-lizenzen.json',
);

/** Ein Paket, wie es auf der Lizenzseite steht. */
interface PackageEntry {
  readonly name: string;
  readonly version: string;
  /** Die SPDX-Kennung, wie sie im Manifest des Pakets steht. */
  readonly spdx: string;
  readonly author: string | null;
  readonly homepage: string | null;
  /**
   * Der Schlüssel des Wortlauts in {@link LicenceFile.texts} — oder `null`,
   * wenn das Paket keine Lizenzdatei mitbringt.
   */
  readonly text: string | null;
}

interface LicenceFile {
  /**
   * Wonach die Liste erzeugt wurde. Kein Zeitstempel: der machte jede
   * Neuerzeugung zu einer Änderung und `--check` damit wertlos.
   */
  readonly source: string;
  /** Die Wortlaute, einmal je eindeutigem Text. */
  readonly texts: Record<string, string>;
  readonly packages: readonly PackageEntry[];
}

/** Was `pnpm licenses list --json` je Paket liefert (nur das Gelesene). */
interface PnpmLicenceEntry {
  readonly name?: unknown;
  readonly versions?: unknown;
  readonly paths?: unknown;
  readonly license?: unknown;
  readonly author?: unknown;
  readonly homepage?: unknown;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Die Lizenzdatei eines Pakets, wörtlich — oder `null`.
 *
 * Gesucht wird nach Dateinamen, nicht nach einem festen: die Ökosysteme
 * schreiben `LICENSE`, `LICENCE`, `LICENSE.md`, `LICENSE-MIT`, `COPYING` und
 * mehr, und ein fester Name ließe stillschweigend Wortlaute aus.
 */
function licenceTextOf(directory: string): string | null {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => /^(licen[cs]e|copying|notice)/iu.test(entry))
    .sort();
  for (const entry of candidates) {
    const path = join(directory, entry);
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
      const text = readFileSync(path, 'utf8').trim();
      if (text !== '') {
        return text;
      }
    } catch {
      // Eine unlesbare Datei ist kein Grund, die ganze Liste zu verlieren —
      // das Paket steht dann als „kein Lizenztext" darin.
    }
  }
  return null;
}

function build(): LicenceFile {
  const raw = execFileSync(
    'pnpm',
    ['licenses', 'list', '--prod', '--json'],
    // Die Liste ist groß; die Vorgabe von `maxBuffer` reicht dafür nicht.
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('`pnpm licenses list --json` lieferte kein Objekt.');
  }

  const texts = new Map<string, string>();
  const packages: PackageEntry[] = [];

  for (const group of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group as readonly PnpmLicenceEntry[]) {
      const name = textOrNull(entry.name);
      if (name === null) {
        continue;
      }
      const versions = Array.isArray(entry.versions)
        ? entry.versions.filter((v): v is string => typeof v === 'string')
        : [];
      const paths = Array.isArray(entry.paths)
        ? entry.paths.filter((v): v is string => typeof v === 'string')
        : [];

      // Eine Zeile je Fassung: zwei Fassungen desselben Pakets sind zwei
      // Auslieferungen mit womöglich zwei verschiedenen Copyright-Zeilen.
      versions.forEach((version, index) => {
        const directory = paths[index] ?? paths[0] ?? null;
        const text = directory === null ? null : licenceTextOf(directory);
        let key: string | null = null;
        if (text !== null) {
          key = createHash('sha256').update(text).digest('hex').slice(0, 16);
          texts.set(key, text);
        }
        packages.push({
          name,
          version,
          spdx: textOrNull(entry.license) ?? 'unbekannt',
          author: textOrNull(entry.author),
          homepage: textOrNull(entry.homepage),
          text: key,
        });
      });
    }
  }

  // Sortiert, damit zwei Läufe dieselbe Datei ergeben — sonst wäre `--check`
  // eine Zufallsprüfung.
  packages.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name),
  );

  return {
    source: 'pnpm-lock.yaml',
    texts: Object.fromEntries(
      [...texts].sort(([a], [b]) => a.localeCompare(b)),
    ),
    packages,
  };
}

const serialised = `${JSON.stringify(build(), null, 2)}\n`;

/** Die eingecheckte Fassung, oder ein leerer String, wenn es keine gibt. */
function stored(): string {
  try {
    return readFileSync(TARGET, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv.includes('--check')) {
  if (stored() !== serialised) {
    process.stderr.write(
      'Die Liste der Drittkomponenten ist nicht mehr aktuell.\n' +
        'Bitte `node tools/licences.ts` laufen lassen und das Ergebnis mit\n' +
        'einchecken — die Lizenzseite liefert sie öffentlich aus.\n',
    );
    process.exit(1);
  }
  process.stdout.write('Die Liste der Drittkomponenten ist aktuell.\n');
} else {
  writeFileSync(TARGET, serialised, 'utf8');
  process.stdout.write(`geschrieben: ${TARGET}\n`);
}
