import type { Permissions } from '@formsache/shared';

import type { WizardStepMeta, WizardStepStatus } from '../../wizard';

/**
 * **The nine steps of the first setup of an organisation** (ADR-0025;
 * *Rechtstexte* since ADR-0028) — in
 * one place, because they are needed in four places: for the
 * step list of the frame, for the sentence above every step, for the question
 * "may this person do that at all?" and for the order.
 *
 * ## The sentence that carries every entry
 *
 * `consequence` is **no** help text, but the answer to the only
 * question that a skippable step raises: *what does not work without it?*
 * It is a mandatory field of the frame type, so that a new step cannot
 * forget it — and the most important answer in the whole assistant stands at
 * step 2: **without its own mail server this organisation sends nothing.**
 *
 * ⚠️ **One sentence, and only what does not work** (Review-Runde 5, Nachtrag:
 * „Für mich sieht das alles doppelt und dreifach aus"). Every one of these
 * steps shows the cards of the organisation administration, and those explain
 * themselves — how a field works, what „leer" means, what a neighbouring term
 * is. Whoever writes that here as well writes it twice on the same screen. The
 * rule is „one statement, one place", and the place of this line is: *what
 * does not work without this step.*
 *
 * ## Why every step here is skippable
 *
 * Unlike at the first commissioning there is no step the following ones live
 * on: the organisation already exists, the session too, every
 * route here is an ordinary signed-in setting. What remains is the
 * decision *guiding, but skippable* — and the second half of it is
 * the list of open items on the dashboard of this organisation
 * (`open-items.ts`), which reads the **actual state** and not what
 * was skipped here.
 *
 * ## `requires` — and why a step does not fail on it, but falls away
 *
 * The nine steps hang on **different** rights (that is no
 * negligence of the routes, but their statement: changing colours is not
 * the same as assigning roles). Whoever has only a part of them shall
 * **not** see the other steps **as broken forms** — the assistant
 * visibly skips them and says which right is missing. A form that
 * loads, looks like a form and says 403 on saving is the
 * worst of the three possibilities.
 *
 * ⚠️ **That is presentation, not a boundary.** The rule is enforced at the
 * route, every time; `requires` only mirrors what the guards decide
 * anyway (`CONTRIBUTING.md`). Whoever changes the list here changes no
 * right — they change only whether somebody walks up to a locked door.
 */

export interface TenantSetupStepDefinition {
  readonly key: string;
  readonly title: string;
  readonly consequence: string;
  readonly skippable: boolean;
  /**
   * The rights that this step needs **all** of — mirrored from the
   * guards of the routes it serves:
   *
   * | Schritt | Route | Recht |
   * |---|---|---|
   * | Erscheinungsbild | `PUT /tenant/branding` | `canManageSettings` |
   * | Mailserver | `PUT /tenant/smtp` | `canManageSettings` + `canViewResponses` |
   * | Adressen | `PUT /tenant/base-url`, `/tenant/reply-to` | `canManageSettings` + `canViewResponses` |
   * | Gruppen | `PUT /tenant/groups/:id` | `canManageUsers` |
   * | Personen | `POST /tenant/users` | `canManageUsers` |
   * | Formular-Standards | `PUT /tenant/form-defaults` | `canManageSettings` |
   * | SSO | `PUT /tenant/oidc` | `canManageSettings` + `canManageUsers` |
   * | KI | `PUT /ai/tenant-settings` | `canManageSettings` |
   */
  readonly requires: readonly (keyof Permissions)[];
}

export const TENANT_SETUP_STEPS: readonly TenantSetupStepDefinition[] = [
  {
    key: 'appearance',
    title: 'Erscheinungsbild',
    consequence:
      'Ohne Logo, Namen und Farben tragen die Seiten, die Teilnehmer zu sehen bekommen, das neutrale Erscheinungsbild der Installation — auf einem Formular steht dann nicht, von wem es kommt.',
    skippable: true,
    requires: ['canManageSettings'],
  },
  {
    key: 'mail',
    title: 'Mailserver der Organisation',
    consequence:
      'Ohne eigenen Mailserver verschickt diese Organisation nichts: keine Bestätigung an Teilnehmer, keine Benachrichtigung an Bearbeiter, keine Erinnerung.',
    skippable: true,
    requires: ['canManageSettings', 'canViewResponses'],
  },
  {
    key: 'addresses',
    title: 'Basis-Adresse und Antwortadresse',
    consequence:
      'Ohne eigene Adressen gilt die Basis-Adresse der Installation, und eine Antwort auf eine Mail geht an die Absenderadresse des Mailservers.',
    skippable: true,
    requires: ['canManageSettings', 'canViewResponses'],
  },
  {
    key: 'groups',
    title: 'Gruppen und Rechte',
    consequence:
      'Ohne Anpassung gilt, was die drei Standardgruppen mitbringen: wer in keiner Gruppe mit dem Recht „Formulare bearbeiten" ist, kann in dieser Organisation kein Formular anlegen.',
    skippable: true,
    requires: ['canManageUsers'],
  },
  {
    key: 'people',
    title: 'Personen einladen',
    consequence:
      'Ohne weitere Personen bleibt diese Organisation bei einem einzigen Konto: geht dessen Zugang verloren, kann nur der Betrieb der Installation helfen.',
    skippable: true,
    requires: ['canManageUsers'],
  },
  {
    key: 'form-defaults',
    title: 'Formular-Standards',
    consequence:
      'Ohne eigene Standards gelten die ausgelieferten Vorgaben für jedes neue Formular — ein brauchbarer Zustand, nur nicht der eigene Wortlaut dieser Organisation.',
    skippable: true,
    requires: ['canManageSettings'],
  },
  {
    key: 'oidc',
    title: 'Anmeldung über SSO',
    consequence:
      'Ohne SSO melden sich Bearbeiter mit E-Mail und Passwort an, und jedes Konto wird hier eingeladen und hier zurückgesetzt.',
    skippable: true,
    requires: ['canManageSettings', 'canManageUsers'],
  },
  {
    key: 'legal',
    title: 'Rechtstexte',
    consequence:
      'Ohne diese Angaben erfüllt kein Formular dieser Organisation die Informationspflicht nach Art. 13 DSGVO: Teilnehmende erfahren nicht, wofür ihre Angaben verwendet werden, auf welcher Grundlage und wie lange sie aufbewahrt werden — die aus jedem Formular verlinkten Seiten sagen dann, dass nichts hinterlegt ist.',
    skippable: true,
    requires: ['canManageSettings'],
  },
  {
    key: 'ai',
    title: 'KI-Formularerstellung',
    consequence:
      'Ohne sie legen Bearbeiter ihre Formulare von Hand an — die Anwendung läuft vollständig ohne KI.',
    skippable: true,
    requires: ['canManageSettings'],
  },
];

/** Whether a role holds all the rights that a step needs. */
export function stepPermitted(
  step: TenantSetupStepDefinition,
  permissions: Permissions,
): boolean {
  return step.requires.every((permission) => permissions[permission]);
}

/**
 * The step list as the frame wants it — metadata plus state.
 *
 * ⚠️ **A step that this role is not allowed stands in the list as
 * „übersprungen" from the start**, not as „offen". It will never become that,
 * and a list that shows three open items, two of which nobody of this
 * session can settle, is a list that invites giving up.
 */
export function tenantWizardSteps(
  statuses: readonly WizardStepStatus[],
  permissions: Permissions,
): readonly WizardStepMeta[] {
  return TENANT_SETUP_STEPS.map((step, index) => ({
    key: step.key,
    title: step.title,
    consequence: step.consequence,
    skippable: step.skippable,
    status: stepPermitted(step, permissions)
      ? (statuses[index] ?? 'open')
      : 'skipped',
    /**
     * **Jeder Schritt ist anspringbar** (Review-Runde 3 Nr. 6) — hier ohne
     * Ausnahme, anders als bei der Erstinbetriebnahme.
     *
     * Der Grund ist derselbe, aus dem hier auch aus Schritt 1 „Zurück"
     * angeboten wird: die Organisation gibt es bereits, die Sitzung auch,
     * und jede Route dieses Assistenten ist eine gewöhnliche, angemeldete
     * Einstellung. Es gibt keinen Schritt, der sich nicht wiederholen ließe.
     *
     * ⚠️ Auch ein Schritt, den diese Rolle **nicht** darf, bleibt
     * anspringbar. Er zeigt dann den Satz, welches Recht fehlt
     * (`SkippedStepNotice`) — und das ist genau die Auskunft, die jemand
     * sucht, der ihn in der Liste sieht. Ihn stumm zu sperren hieße, die
     * Frage „warum komme ich da nicht hin?" unbeantwortet zu lassen.
     */
    reachable: true,
  }));
}
