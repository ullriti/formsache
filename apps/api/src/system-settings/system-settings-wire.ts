import type {
  SystemAiSettings,
  SystemLegalPages,
  SystemMailSettings,
} from '@formsache/shared';

/**
 * Wire contract of the superadmin settings routes.
 *
 * **Composed from `@formsache/shared`, not restated** — the same rule
 * `settings/settings-wire.ts` follows for the organisation-facing routes. Every
 * field shape and every bound already lives in `system-settings.ts`; what is
 * added here is the envelope.
 *
 * The response types are interfaces rather than schemas: the server produces
 * them, so there is nothing to validate on the way out that the shared schemas
 * have not already decided. The client parses it, and states that schema on its
 * own side (`apps/web/src/api/…`).
 *
 * **The *Formular-Standards* pair used to live here too** and is gone with the
 * layer it edited (ADR-0011, continuation 2026-08-14) — including its
 * `reach`, the count of „gilt für N Organisationen und M Formulare" that
 * announced how far a system write carried. Nothing in this application reaches
 * across organisations to write any more, so there is nothing left to announce.
 */

/**
 * What the *Mailserver & Basis-Adresse* page receives.
 *
 * `values` is `SystemMailSettings` **unmodified**: the shape, bounds and the
 * allow list that keeps the password out all live in `@formsache/shared`, and
 * restating them here would be a second description of the same contract.
 */
export interface SystemMailSettingsResponse {
  readonly values: SystemMailSettings;
  /**
   * The optimistic lock this superadmin started from — `mail_revision`, the
   * counter of these two columns. Never `null`: a fresh installation with no
   * `system_setting` row yet reports the number the column will start at
   * (`INITIAL_MAIL_REVISION`), so the write that follows can name it.
   */
  readonly lock: number;
}

/**
 * What the AI page of the superadmin receives.
 *
 * Three parts, and the middle one is the one that did not exist before:
 * a half configuration used to make the **start** impossible, since the move
 * into the settings it makes a **display**. A form field is filled in during
 * running operation; a superadmin who sets the provider before the key
 * would otherwise take the whole installation down.
 */
export interface SystemAiSettingsResponse {
  readonly values: SystemAiSettings;
  /**
   * Which field a half configuration still needs, or `null`.
   *
   * `'apiKey'` means: provider chosen, key missing. `'model'` means: for
   * this provider there is no default value (Mistral — the reasoning stands
   * at `DEFAULT_AI_MODEL`). In both cases the feature is absent, and the
   * row is saved nonetheless.
   */
  readonly gap: 'apiKey' | 'model' | null;
  /** `ai_revision` — the **own** counter of this block. */
  readonly lock: number;
}

/**
 * What the legal-text page of the system administration receives (ADR-0028).
 *
 * `pages` is `SystemLegalPages` **unmodified**: the shape, the bounds and
 * the handling of foreign values live in `@formsache/shared`, and describing
 * them here once more would be a second version of the same contract.
 *
 * The **templates** deliberately do not travel with it. They stand in
 * `@formsache/shared` and are the same constants on both sides; sending them
 * through the wire would mean transferring 40 KB of text on every load of the
 * page that the client already has.
 */
export interface SystemLegalResponse {
  readonly pages: SystemLegalPages;
  /** `legal_revision` — the **own** counter of this block. */
  readonly lock: number;
  /**
   * **Ob die KI-Funktion dieser Installation eingerichtet ist**
   * (Review-Runde 5 Nr. 2).
   *
   * Der Befund war: *„Datenschutzerklärung: KI Teil fehlt im Formular."* Er
   * traf zu, und die Ursache lag genau hier — die Karte nahm `aiActive: false`
   * an, weil sie es nicht wusste, und `visibleSlots` lässt die Felder eines
   * abgewählten Blocks weg. Sieben Felder zur KI (Anbieter, Sitz, Modell,
   * Region, Übermittlungsgrundlage, Kontakt für Garantien, Aufbewahrung beim
   * Anbieter) waren damit **unerreichbar**, während die veröffentlichte Seite
   * den Abschnitt sehr wohl zeigte: der öffentliche Weg liest denselben Wert
   * aus der Konfiguration und bekommt die Wahrheit.
   *
   * Es reist **mit dieser Antwort** und nicht als eigene Anfrage: die Karte
   * hätte sonst zwei Ladezustände, und wer die Rechtstexte lesen darf, darf
   * diesen einen Wahrheitswert auch lesen — es ist ein Superadmin, dem die
   * KI-Einstellungen ohnehin offenstehen. Was **nicht** mitreist, ist irgendein
   * Teil der KI-Konfiguration; nur ob sie steht.
   */
  readonly aiActive: boolean;
}
