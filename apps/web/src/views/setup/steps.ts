import type { WizardStepMeta, WizardStepStatus } from '../../wizard';

/**
 * **The eight steps of the first commissioning** (ADR-0022, continuation
 * 2026-08-18; *Rechtliche Angaben* since ADR-0028) — in one place, because they are needed in three places:
 * for the step list of the frame, for the question „is this one skippable?"
 * and for the sentence that stands above every step.
 *
 * ## The sentence that carries every entry
 *
 * `consequence` is **not** a help text but the answer to the only question a
 * skippable step raises: *what does not work without it?* An assistant that
 * offers „Überspringen" seven times without answering it is seven times the
 * same click — and afterwards the installation stands there without a mail
 * server, without anybody ever having said what that means.
 *
 * ⚠️ **One sentence, and only what does not work** (Review-Runde 5, Nachtrag:
 * „Für mich sieht das alles doppelt und dreifach aus"). Everything explanatory
 * — how a setting works, what one types, what a neighbouring term means —
 * stands at the card of the step, which the settings tab shows as well; who
 * writes it here too writes it twice on the same screen. The rule is „one
 * statement, one place", and for this line the place is: *what does not work
 * without this step.*
 *
 * ## Why only the first one is not skippable
 *
 * Because it creates the account all the others live off: steps 2 to 8 talk to
 * the ordinary, **signed-in** system settings routes. Without step 1 there is
 * no session, and without a session no 200s.
 *
 * Everything after that is skippable, and that is the user's decision:
 * *leading, but skippable.* What stays open then stands as a list of open
 * points in the system administration — derived from the **actual state** and not
 * from a marker this assistant would have set
 * (`views/system-settings/open-items.ts`).
 */

export interface SetupStepDefinition {
  readonly key: string;
  readonly title: string;
  readonly consequence: string;
  readonly skippable: boolean;
}

export const SETUP_STEPS: readonly SetupStepDefinition[] = [
  {
    key: 'access',
    title: 'Dein Zugang',
    consequence:
      'Ohne dieses Konto gibt es keine Anmeldung — und alle folgenden Schritte sind angemeldete Einstellungen.',
    skippable: false,
  },
  {
    key: 'base-url',
    title: 'Basis-Adresse',
    consequence:
      'Ohne sie zeigen die Links in Mails nirgendwohin — der Bearbeiten-Link einer Bestätigung ebenso wie der Rücksetz-Link für ein vergessenes Passwort.',
    skippable: true,
  },
  {
    key: 'mail',
    title: 'Mailserver der Instanz',
    consequence:
      'Ohne ihn verschickt die Installation selbst nichts: keine Betriebsmeldung, keine Testmail, keine Einladung.',
    skippable: true,
  },
  {
    key: 'addresses',
    title: 'Antwortadresse und Betreiberadresse',
    consequence:
      'Ohne Betreiberadresse erreicht ein Betriebsalarm niemanden; ohne Antwortadresse geht eine Antwort an die Absenderadresse.',
    skippable: true,
  },
  {
    key: 'templates',
    title: 'Benachrichtigungs-Vorlagen',
    consequence:
      'Ohne eigene Vorlagen bleibt es bei den ausgelieferten — ein brauchbarer Zustand, nur nicht der eigene Wortlaut dieser Installation.',
    skippable: true,
  },
  {
    key: 'ai',
    title: 'KI-Einstellungen',
    consequence:
      'Ohne Anbieter und Schlüssel ist die KI-Formularerstellung abwesend — die Anwendung läuft vollständig ohne sie.',
    skippable: true,
  },
  {
    key: 'legal',
    title: 'Rechtliche Angaben',
    consequence:
      'Ohne sie sagen Impressum und Datenschutzerklärung dieser Installation jedem Teilnehmenden, der die Fußzeile anklickt, dass nichts hinterlegt ist.',
    skippable: true,
  },
  {
    key: 'tenant',
    title: 'Erste Organisation',
    consequence:
      'Ohne eine Organisation kann niemand ein Formular anlegen: Formulare, Antworten und Rechte gehören immer einer.',
    skippable: true,
  },
];

/**
 * The step list as the frame wants it — metadata plus state.
 *
 * The state comes from the host and not from here: „erledigt" and
 * „übersprungen" are events of this one run, not a property of a step.
 */
export function wizardSteps(
  statuses: readonly WizardStepStatus[],
): readonly WizardStepMeta[] {
  return SETUP_STEPS.map((step, index) => ({
    ...step,
    status: statuses[index] ?? 'open',
    /**
     * **Anspringbar ist alles außer dem ersten Schritt**
     * (Review-Runde 3 Nr. 6).
     *
     * Und zwar aus demselben Grund, aus dem „Zurück" ihn nie erreicht
     * (`SetupView.tsx`): er legt das Konto an, und `POST /api/setup`
     * antwortet danach 404, solange die Installation eine `user`-Zeile hat.
     * Wer dorthin spränge, stünde vor einer Maske mit `ALREADY_MESSAGE` und
     * käme nicht wieder vorwärts — die Einsperrung, die dieser Assistent
     * ausschließt.
     *
     * Alle übrigen sind gewöhnliche, angemeldete Systemeinstellungen. Sie
     * lassen sich in jeder Reihenfolge und beliebig oft aufrufen; genau
     * deshalb ist die freie Navigation hier keine Bequemlichkeit, sondern
     * das, was die Liste ohnehin verspricht.
     */
    reachable: index > 0,
  }));
}
