import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http';

import {
  actionErrorMessage,
  fieldIssues,
  issuesUnder,
  saveErrorMessage,
  FORM_SETTINGS_SUBJECT,
} from './api-messages';

/**
 * **The mapping from server answer to sentence and field marker** — the two
 * places at which the privacy notice of a form has extended it
 * (review finding of 2026-08-19, ADR-0028 no. 4 and no. 7).
 *
 * Both are measured by what an editor **sees** afterwards: which
 * key marks a control, and which advice stands under the saving.
 */

/** A 400 as `parseRequest` (`apps/api`) sends it for a document. */
function badRequest(issues: Record<string, string>): ApiError {
  return new ApiError(400, 'Die Anfrage ist ungültig.', issues);
}

describe('fieldIssues', () => {
  /**
   * **The `privacyNotice.` branch** — the reason this test exists.
   *
   * A `PUT /api/forms/:id/settings` has carried **two** sub-documents since
   * ADR-0028 no. 4: the settings under `values.` and the legal text under
   * `privacyNotice.`. Only the first prefix was stripped, so the
   * card of the legal text never found its message — „Bitte die markierten
   * Felder prüfen." stood there, nothing was marked, and in the same write
   * the deadline, the participant limit and the confirmation page stayed
   * unsaved.
   *
   * *Reproduction:* remove `'privacyNotice.'` from `ISSUE_PREFIXES` — the
   * two expectations on `custom` and `fills.…` turn red, the one on
   * `closeAt` stays green. Exactly this asymmetry was the finding.
   */
  it('zieht beide Präfixe eines Einstellungs-Schreibvorgangs ab', () => {
    const issues = fieldIssues(
      badRequest({
        'values.closeAt': '„Schließt am“ muss nach „Öffnet am“ liegen.',
        'privacyNotice.custom': 'Höchstens 20000 Zeichen.',
        'privacyNotice.fills.ZWECK': 'Höchstens 2000 Zeichen.',
      }),
    );

    expect(issues).toEqual({
      closeAt: '„Schließt am“ muss nach „Öffnet am“ liegen.',
      // The paths of the document — the names under which `LegalPageEditor`
      // carries its fields.
      custom: 'Höchstens 20000 Zeichen.',
      'fills.ZWECK': 'Höchstens 2000 Zeichen.',
    });
  });

  /**
   * A flat path stays what it is: „Person hinzufügen" and the
   * group editor name their fields without a prefix, and a path without a
   * control had better lie around unused than mark somebody else's.
   */
  it('lässt einen Pfad ohne bekanntes Präfix unverändert', () => {
    expect(
      fieldIssues(
        badRequest({
          email: 'Keine gültige Adresse.',
          'unbekannt.pfad': 'Etwas stimmt nicht.',
        }),
      ),
    ).toEqual({
      email: 'Keine gültige Adresse.',
      'unbekannt.pfad': 'Etwas stimmt nicht.',
    });
  });

  it('gibt für alles, was keine Feldmeldungen trägt, nichts zurück', () => {
    expect(fieldIssues(new ApiError(403, 'Nein.'))).toEqual({});
    expect(fieldIssues(new Error('Netzwerk'))).toEqual({});
  });

  /**
   * **The legal pages of organisation and installation keep their prefix here**
   * (ADR-0028 no. 9) — and that is a decision, not an omission.
   *
   * Their write carries several documents at once (`pages.imprint.…`,
   * `pages.privacy.…`), so the page name says which of the cards on the screen
   * was meant. Stripping it in this one place would be exactly the collision
   * {@link issuesUnder} exists to prevent.
   */
  it('lässt den seitenabhängigen Pfad der Rechtstexte stehen', () => {
    expect(
      fieldIssues(
        badRequest({
          'pages.imprint.custom': 'Höchstens 20000 Zeichen.',
          'pages.privacy.fills.STAND': 'Höchstens 2000 Zeichen.',
        }),
      ),
    ).toEqual({
      'pages.imprint.custom': 'Höchstens 20000 Zeichen.',
      'pages.privacy.fills.STAND': 'Höchstens 2000 Zeichen.',
    });
  });
});

describe('issuesUnder', () => {
  const ISSUES = {
    'pages.imprint.custom': 'Höchstens 20000 Zeichen.',
    'pages.imprint.fills.PLZ': 'Höchstens 2000 Zeichen.',
    'pages.privacy.custom': 'Etwas anderes stimmt nicht.',
  };

  it('kürzt die Pfade der genannten Seite auf die Namen der Felder', () => {
    expect(issuesUnder(ISSUES, 'pages.imprint.')).toEqual({
      custom: 'Höchstens 20000 Zeichen.',
      'fills.PLZ': 'Höchstens 2000 Zeichen.',
    });
  });

  /**
   * **The dropping is worth as much as the shortening.** What is left over
   * would otherwise mark a field of the same name on the card next to it —
   * both cards have a „Eigener Text".
   */
  it('lässt weg, was einer anderen Seite gehört', () => {
    expect(issuesUnder(ISSUES, 'pages.privacy.')).toEqual({
      custom: 'Etwas anderes stimmt nicht.',
    });
    expect(issuesUnder(ISSUES, 'pages.accessibility.')).toEqual({});
  });
});

describe('actionErrorMessage', () => {
  /**
   * **413 — and the advice must not be "once more"** (ADR-0028 no. 7).
   *
   * The body limiter (100 KiB, `app-setup.ts`) sits in front of every
   * controller; the answer carries no sentence of the application. Without a
   * branch of its own it fell through to `failed`, and on saving that means
   * „Bitte erneut versuchen." — an advice that fails at the same limit the
   * second time just as well.
   *
   * *Reproduction:* remove the `413` branch from `actionErrorMessage`. Both
   * expectations turn red: the first because the generic sentence
   * comes back then, the second because the words „erneut versuchen" stand in it.
   */
  it('rät bei 413 zum Kürzen und nicht zum zweiten Versuch', () => {
    const message = saveErrorMessage(
      new ApiError(413, 'Payload Too Large'),
      FORM_SETTINGS_SUBJECT,
    );

    expect(message).toContain('kürzen');
    expect(message).not.toContain('erneut versuchen.');
  });

  /**
   * The counter-check to the branch above: what is **not** 413 keeps its
   * sentence. A new branch that swallowed the remaining statuses along with it
   * would be more expensive than the defect it fixes.
   */
  it('lässt die übrigen Status, wie sie waren', () => {
    expect(
      actionErrorMessage(new ApiError(403, 'Nein.'), {
        forbidden: 'Diese Rolle darf das nicht.',
        failed: 'Fehlgeschlagen.',
      }),
    ).toBe('Diese Rolle darf das nicht.');

    expect(
      actionErrorMessage(new ApiError(400, 'Ungültig.'), {
        forbidden: 'Diese Rolle darf das nicht.',
        failed: 'Fehlgeschlagen.',
      }),
    ).toBe('Bitte die markierten Felder prüfen.');

    expect(
      actionErrorMessage(new ApiError(500, 'Kaputt.'), {
        forbidden: 'Diese Rolle darf das nicht.',
        failed: 'Fehlgeschlagen.',
      }),
    ).toBe('Fehlgeschlagen.');
  });
});
