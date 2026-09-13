import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AI_PRECONDITIONS, MOVED_AI_ENV_VARS } from './index.ts';

/**
 * **The condition for switching on stands in *one* place, and the operations
 * handbook points at it.**
 *
 * ⚠️ **This checks no behaviour.** It holds three texts together: the list in
 * the code, the section in the data protection document and the note in the
 * operations handbook. In the language of the markers that is 📋, not 🧪.
 *
 * **What it is there for all the same.** An operator who wants to switch the
 * KI on needs two pieces of information: **where** the switch sits and **what**
 * has to be in place beforehand. If the first is missing, they search in the
 * `.env` and set `AI_PROVIDER` in the environment; if the second is missing,
 * they switch on without an AV-Vertrag.
 *
 * The *opposite direction* — none of the five migrated variables stands
 * anywhere as an assignment again — is checked over **both** templates,
 * because `dev-setup.sh` and `prod-setup.sh` respectively would carry such a
 * line into every fresh `.env`. That the names are **enumerated** in the
 * operations handbook, by contrast, this test no longer checks: a list of
 * cleared-away variables is not information for the operator but the story of
 * a rebuilding measure.
 *
 * Construction as in `env-contract.test.ts`: a test in `packages/shared` that
 * reads files outside it and compares sets.
 */

const ROOT = resolve(process.cwd(), '..', '..');
const ENV_EXAMPLE = readFileSync(join(ROOT, '.env.example'), 'utf8');
const ENV_PROD_EXAMPLE = readFileSync(join(ROOT, '.env.prod.example'), 'utf8');
const OPS_DOC = readFileSync(join(ROOT, 'docs', 'kb', '09-betrieb.md'), 'utf8');
const PRIVACY_DOC = readFileSync(
  join(ROOT, 'docs', 'kb', '10-datenschutz.md'),
  'utf8',
);

describe('die Einschaltbedingung der KI ', () => {
  it('liest die Dateien wirklich, statt gegen leere Zeichenketten zu prüfen', () => {
    expect(ENV_EXAMPLE.length).toBeGreaterThan(1_000);
    expect(ENV_PROD_EXAMPLE.length).toBeGreaterThan(1_000);
    expect(OPS_DOC.length).toBeGreaterThan(1_000);
    expect(PRIVACY_DOC.length).toBeGreaterThan(1_000);
  });

  /**
   * *Re-enactment:* remove the reference from `09-betrieb.md` → red. Without
   * it an operator searches where they last saw the switch.
   */
  it('das Betriebshandbuch sagt, wo der Schalter sitzt — und wo die Bedingungen stehen', () => {
    expect(OPS_DOC).toContain('Systemverwaltung → KI');
    expect(OPS_DOC).toContain('10-datenschutz.md');
  });

  /**
   * **And the templates carry the bridge at least as a signpost.** They say not
   * a word about KI — they say where the explanations stand. Without this line
   * an operator's search ends in a file that says nothing.
   */
  it.each([
    ['.env.example', ENV_EXAMPLE],
    ['.env.prod.example', ENV_PROD_EXAMPLE],
  ])(
    '%s verweist auf das Dokument, das die Erklärungen trägt',
    (_file, text) => {
      expect(text).toContain('docs/kb/09-betrieb.md');
    },
  );

  /**
   * **And none of the five still stands there as an assignment.** An
   * `AI_PROVIDER=` in a template would be the invitation to set it again — and
   * the setup script would carry it into every fresh `.env`.
   *
   * *Re-enactment:* enter one of the five as an assignment again → red.
   */
  it.each([
    ['.env.example', ENV_EXAMPLE],
    ['.env.prod.example', ENV_PROD_EXAMPLE],
  ])('%s trägt keine der fünf mehr als Zuweisung', (_file, text) => {
    const assignments = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'))
      .map((line) => line.split('=')[0])
      .filter((name): name is string => name !== undefined && name !== '');
    expect(
      MOVED_AI_ENV_VARS.filter((name) => assignments.includes(name)),
      'Diese Variablen sind inzwischen in die Systemeinstellungen gezogen; eine ' +
        'Zuweisung in einer Vorlage wäre die zweite Quelle, die bereits ' +
        'abgeräumt wurde.',
    ).toEqual([]);
  });

  /**
   * *Re-enactment:* strike a precondition from `AI_PRECONDITIONS` without
   * touching the document → red. The list in the code is the truth from which
   * the view **and** the document quote.
   */
  it('das Datenschutz-Dokument führt genau die fünf Vorbedingungen des Codes', () => {
    expect(AI_PRECONDITIONS).toHaveLength(5);
    // The comparison goes over the load-bearing words, not character by
    // character: the document puts them into a table and shortens the sentence
    // form. What must not drift is *which five conditions* stand there.
    const KEYWORDS = [
      'AV-Vertrag',
      'EU-Frage',
      'Verarbeitungsverzeichnis',
      'Kontingent je Organisation',
      '30-Tage-Löschung',
    ];
    expect(KEYWORDS).toHaveLength(AI_PRECONDITIONS.length);
    for (const keyword of KEYWORDS) {
      expect(PRIVACY_DOC, `Vorbedingung fehlt: ${keyword}`).toContain(keyword);
    }
  });

  /**
   * **The four assumptions that are not yet measured**  — each with the
   * measurement that replaces it. What carries on as „später" is the line that
   * lands on the table again in every session; it therefore stands where an
   * operator stands when they throw the switch.
   */
  it('nennt die vier ungemessenen Annahmen mit ihrer Messung', () => {
    for (const marker of ['echter', 'Parse', 'strict', 'Token', 'Streuung']) {
      expect(PRIVACY_DOC, `Annahme fehlt: ${marker}`).toContain(marker);
    }
  });
});
