import type { ReactElement } from 'react';
import {
  applySharedFills,
  OPERATOR_NAME_SLOT,
  sharedSlotKeys,
  SYSTEM_LEGAL_PAGES,
  SYSTEM_LEGAL_TEMPLATES,
  systemLegalPath,
  type LegalRenderContext,
  type SystemLegalPages,
} from '@formsache/shared';

import { issuesUnder } from '../api-messages';
import { LegalPageEditor } from '../legal/LegalPageEditor';
import type { SettingIssues } from '../settings/SettingsControls';
import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { useSystemLegalPages } from './use-system-legal';

import '../settings-view.css';

/**
 * *Rechtstexte* — Impressum and Datenschutzerklärung of the installation, as
 * a tab of the system administration (ADR-0028).
 *
 * ## Why this tab exists and not only the assistant step
 *
 * For the same reason as at the tab *Vorlagen*: a text that one can change
 * exactly once in the life of an installation is no text one can
 * change. An Impressum goes out of date — the address changes, the
 * board changes —, and the obvious case "we have moved" would have
 * no answer without this tab except `psql`.
 *
 * ## What does **not** stand here
 *
 * The licence page. It is fixed in the code (`views/legal/LicencesView.tsx`),
 * because other people's copyrights stand there: whoever could edit somebody
 * else's copyright notice could also remove it.
 *
 * Thin like the three tabs next to it: the fields in the editor, loading and
 * saving in `use-system-legal.ts`, here only the cards and the save bar.
 */
export function SystemLegalTab(): ReactElement {
  const state = useSystemLegalPages();

  if (state.kind === 'loading') {
    return (
      <p className="settings__state" role="status">
        Rechtstexte werden geladen…
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="settings__state" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <>
      <SystemLegalCards
        pages={state.pages}
        aiActive={state.aiActive}
        issues={state.issues}
        onChange={state.setPages}
      />

      <SettingsSaveBar
        isSaving={state.isSaving}
        dirty={state.dirty}
        onSave={() => {
          state.save(() => undefined);
        }}
      />

      {state.errorMessage === null ? null : (
        <p className="settings__alert" role="alert">
          {state.errorMessage}
        </p>
      )}
    </>
  );
}

/**
 * Welche Felder dieser Ebene in mehr als einer Seite stehen — einmal
 * berechnet, im Modul-Rumpf.
 *
 * Die Vorlagen sind Konstanten; das Ergebnis kann sich zur Laufzeit nicht
 * ändern, und es je Tastenanschlag neu auszurechnen wäre Arbeit für nichts.
 */
const SHARED_SYSTEM_SLOTS = sharedSlotKeys(
  Object.values(SYSTEM_LEGAL_TEMPLATES),
);

/**
 * The three cards — used by the setup assistant too, therefore without a
 * save bar and without a loading state of their own.
 */
export function SystemLegalCards({
  pages,
  aiActive,
  issues = {},
  onChange,
}: {
  readonly pages: SystemLegalPages;
  /**
   * **Ob die KI-Funktion dieser Installation eingerichtet ist**
   * (Review-Runde 5 Nr. 2) — vom Server, nicht geraten.
   *
   * Es entscheidet über sieben Felder: `visibleSlots` lässt die Platzhalter
   * eines abgewählten Blocks weg, und die Karte nahm bis dahin „KI aus" an.
   * Damit fehlte der KI-Abschnitt der Datenschutzerklärung **im Formular**,
   * während die veröffentlichte Seite ihn zeigte — die Felder waren also nicht
   * nur unbequem zu finden, sondern nicht vorhanden.
   *
   * Es ist ein Superadmin, der hier tippt; die KI-Einstellungen stehen ihm im
   * Nachbartab offen. Es reist deshalb mit derselben Antwort wie die
   * Dokumente (`api/legal.ts`) und nicht in einer zweiten Anfrage, die diese
   * Karte einen zweiten Ladezustand kosten würde.
   */
  readonly aiActive: boolean;
  /**
   * The field messages of a refused write, **under the paths of the request**
   * (`pages.<seite>.…`) — ADR-0028 no. 9.
   *
   * Each card shortens its own prefix below, and that is the whole reason the
   * shortening does not happen in `fieldIssues`: three documents stand here at
   * the same time, and `pages.imprint.custom` and `pages.privacy.custom` would
   * otherwise both arrive as `custom` and mark all three cards
   * ({@link issuesUnder}).
   */
  readonly issues?: SettingIssues;
  readonly onChange: (next: SystemLegalPages) => void;
}): ReactElement {
  /**
   * The name of the operator comes from the Impressum — in the preview too.
   *
   * It is maintained at no second place (ADR-0019 separates software and
   * installation), and the preview has to go the same way as the server,
   * otherwise it would show a page that does not exist that way.
   */
  const context: LegalRenderContext = {
    organisationName: null,
    organisationShortName: null,
    operatorName:
      (pages.imprint.fills[OPERATOR_NAME_SLOT] ?? '').trim() === ''
        ? null
        : (pages.imprint.fills[OPERATOR_NAME_SLOT] ?? '').trim(),
    /*
      **Der wahre Zustand, seit Review-Runde 5 Nr. 2.** Hier stand `false` mit
      der Begründung, eine zweite Anfrage sei den Ladezustand nicht wert und die
      Organisationsfassung derselben Karte könne es ohnehin nie wissen. Der
      erste Teil war lösbar (der Wert reist mit den Dokumenten mit), der zweite
      bleibt wahr — und der Preis war zu hoch: nicht eine ungenaue Vorschau,
      sondern sieben Felder, die niemand ausfüllen konnte.
    */
    aiActive,
    // No form below an installation page, so no redirect to name
    // (ADR-0028 Nr. 5). None of these three templates asks for one.
    redirectTarget: null,
  };

  return (
    <>
      {/*
        **Eine Orientierung vor den Karten** (Review-Runde 3 Nr. 16:
        „Das ist für einen Laien doch etwas komplex").

        Was fehlte, war nicht Erklärung an den Feldern — davon gibt es
        reichlich —, sondern die Antwort auf die Frage davor: *was sind das
        überhaupt für Seiten, und welche muss ich ausfüllen?* Karten mit je
        zwanzig Feldern und je einem Fachbegriff als Überschrift beantworten
        sie nicht.

        Bewusst wenige Sätze und keine Rechtsberatung: die steht ausführlich in
        `docs/legal/README.md`, und wer sie braucht, braucht mehr, als eine
        Einstellungsseite geben darf.
      */}
      <section className="settings-card" aria-labelledby="system-legal-lead">
        <header className="settings-card__head">
          <div className="settings-card__text">
            <h2 className="settings-card__heading" id="system-legal-lead">
              Was hier auszufüllen ist
            </h2>
            <p className="settings-card__hint">
              Zwei Seiten, und sie sind aus der Fußzeile jedes öffentlichen
              Formulars verlinkt. <strong>Impressum</strong> und{' '}
              <strong>Datenschutzerklärung</strong> braucht jeder, der diese
              Installation betreibt — ohne sie darf sie nicht öffentlich
              erreichbar sein.
            </p>
            <p className="settings-card__hint">
              Der übliche Weg ist die Vorlage: sie ist ausformuliert, und was
              fehlt, sind <strong>Felder</strong> — keine acht Seiten Text, in
              denen man Platzhalter suchen müsste. Angaben, die in beiden Seiten
              stehen (Name, Anschrift, Telefon), tippt man{' '}
              <strong>einmal</strong> und findet sie in der anderen wieder.
            </p>
            {/*
              **Der Haftungshinweis steht dort, wo ausgefüllt wird**
              (Review-Runde 4 Nr. 9: „Mache ich mich durch die Bereitstellung
              der Vorlage nicht angreifbar falls darin etwas fehlen sollte?").

              Die Antwort in voller Länge steht in `docs/legal/README.md`
              Abschnitt 10. Was davon in die Oberfläche gehört, sind zwei
              Sätze — und vor allem das, was **nicht** dasteht: kein
              „rechtssicher", kein „geprüft", kein „DSGVO-konform". Genau
              solche Zusagen sind der Punkt, an dem aus einer Vorlage eine
              Behauptung wird, für die jemand einsteht.
            */}
            <p className="settings-card__hint">
              <strong>Keine Rechtsberatung.</strong> Die Vorlage ist ein
              ausformulierter Entwurf und keine geprüfte Fassung: ob sie für
              diese Stelle vollständig und richtig ist, entscheidet, wer den
              Fall kennt. Verantwortlich für den veröffentlichten Text ist, wer
              ihn hier hinterlegt.
            </p>
          </div>
        </header>
      </section>

      {SYSTEM_LEGAL_PAGES.map((page) => (
        <LegalPageEditor
          key={page}
          template={SYSTEM_LEGAL_TEMPLATES[page]}
          document={pages[page]}
          context={context}
          // Diese Karte kennt den KI-Zustand wirklich (Review-Runde 5 Nr. 2) —
          // der Vorbehalt unter der Vorschau entfällt hier deshalb.
          aiStateKnown
          publicPath={systemLegalPath(page)}
          issues={issuesUnder(issues, `pages.${page}.`)}
          sharedSlots={SHARED_SYSTEM_SLOTS}
          onChange={(next) => {
            /*
              **Ein geteilter Wert wandert in die Nachbarseiten mit**
              (Review-Runde 3 Nr. 3): Name des Betreibers, Anschrift und
              Telefonnummer stehen in beiden Seiten. Die
              Bedingung, unter der ein bewusst abweichender Wert stehen
              bleibt, steht in voller Länge an `applySharedFills`.
            */
            onChange(
              applySharedFills(pages, SYSTEM_LEGAL_TEMPLATES, page, next),
            );
          }}
        />
      ))}
    </>
  );
}
