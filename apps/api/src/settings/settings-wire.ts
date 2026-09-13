import {
  formSettingsWriteSchema,
  legalDocumentWriteSchema,
  tenantSettingsWriteSchema,
  type FormSettings,
  type FormSettingsOverride,
  type LegalDocument,
  type TenantFormSettings,
} from '@formsache/shared';
import { z } from 'zod';

/**
 * Wire contract of the settings routes.
 *
 * **Composed from `@formsache/shared`, not restated.** Every field shape, every
 * bound and every cross-field rule already lives in `form-settings.ts`; what is
 * added here is only the *envelope* — which document a request carries and what
 * a response puts next to it. A second description of a deadline would be a
 * second thing to keep in step, and the weaker of two descriptions is the one
 * an attacker aims at.
 *
 * The response types are interfaces rather than Zod schemas on purpose: the
 * server *produces* them, so there is nothing to validate on the way out that
 * the shared schemas have not already decided. A schema here would only be a
 * place for the two to disagree.
 *
 * **The request bodies take `formSettingsWriteSchema`, not
 * `formSettingsPatchSchema`** . The two differ in exactly
 * one bound: an access word an editor *writes* has to be at least
 * `PASSWORD_MIN` characters. The bound belongs here, on the way in, and
 * nowhere on the way out — a word saved before the rule existed has to keep
 * parsing, and a settings document that stops parsing does not
 * reject the word, it shuts the form.
 */

/**
 * The four switches **as a request states them** — all four, every time.
 *
 * Deliberately *not* the shared `settingsOverriddenSchema`, which carries
 * `.prefault(false)` on each field. That default is right for a **stored**
 * document, where a missing key is an older writer's silence and „follows the
 * tenant" is the safe reading. It is wrong for a **replacing write**, where it
 * makes „key forgotten" and „explicitly `false`" the same request — and the
 * consequence is not a cosmetic one:
 *
 * ```
 * PUT { overridden: { display: true }, values: { showProgress: false } }
 * ```
 *
 * would have answered 200 while silently switching *Zugriff & Sicherheit* and
 * *Versandbudget* back to the tenant standard — **physically removing the
 * sealed access word** from the row. There is no
 * version history on `form.settings_override`, no trash and no audit
 * trail; the only copy left would be the backup. A client that means „three
 * sections follow the tenant" says so in three words.
 */
const writeOverriddenSchema = z.strictObject({
  access: z.boolean(),
  confirm: z.boolean(),
  display: z.boolean(),
  /** *Versandbudget* — the fourth switch. */
  budget: z.boolean(),
});

/** An optimistic-lock counter as it travels — see the `revision` fields below. */
const revisionSchema = z.number().int().positive();

/**
 * A write of a form's settings.
 *
 * **`PUT`, and it means it:** `overridden` replaces all four switches at once,
 * so a section the request does not mention is a section that follows the
 * tenant again. That is the same whole-document semantics the form definition
 * has (`updateFormRequestSchema`), and it is what makes „zurück auf
 * Tenant-Standard" expressible at all — a patch protocol would need a separate
 * verb for „this section no longer has an opinion".
 *
 * `values` is the exception and is a **patch**: the editor sends the fields it
 * changed. Fields belonging to a section that is *not* taken over are ignored
 * rather than rejected — a locked section whose values the client still sends
 * must leave no trace in the document, and rejecting the
 * write instead would make a perfectly ordinary „save everything on screen"
 * fail.
 */
export const updateFormSettingsRequestSchema = z.strictObject({
  overridden: writeOverriddenSchema,
  values: formSettingsWriteSchema.prefault({}),
  /**
   * The settings revision this editor started from.
   *
   * Required, not optional: an optional lock is one the next client forgets,
   * and the loss it guards against is section-shaped — two editors who share
   * nothing delete each other's whole sections.
   */
  revision: revisionSchema,
  /**
   * The revision of the **tenant standards** the same page was built from.
   *
   * It is compared only when this write switches a section **on**, because only
   * then do the standards matter: taking a section over *copies* the values
   * that apply right now. Without it, an organisation changing its access word between
   * loading and saving would hand the editor a word they never saw while the
   * page still showed the old one. Every other write ignores it, so an
   * unrelated change to the organisation's standard does not block anybody — the same
   * argument that keeps this counter apart from `form.revision`.
   */
  tenantRevision: revisionSchema,
  /**
   * **The privacy notice of this form** (ADR-0028 no. 4).
   *
   * `legalDocumentWriteSchema` from `@formsache/shared` — **the same** document
   * that `tenant.legal_pages` carries per page, and expressly no second text
   * model: the same `mode`, the same `fills`, the same `conditions`, the same
   * `custom`, the same `link`, the same bounds, the same gate against control
   * characters. A schema of its own here would be a second allow-list, and the
   * second one is always the one that drifts off.
   *
   * **Die schreibende Fassung, nicht die lesende** (Review-Runde 5, Nachtrag):
   * Diese Karte zeigt denselben `LegalPageEditor` wie die Rechtstexte der
   * Organisation, also auch dessen dritten Weg *Verweis auf eine Seite*. Eine
   * Adresse, die keine http- oder https-Adresse ist, muss hier am Rand
   * scheitern — sonst stünde sie in der Datenbank und der Renderer machte
   * daraus stillschweigend eine leere Seite, an einem Hinweis nach Art. 13
   * DSGVO. Warum Lesen und Schreiben zwei Schemas sind, steht an
   * `legalDocumentWriteSchema`.
   *
   * **When it is there, it is a full replacement** — the whole document, never
   * single fields. It carries three halves side by side (filled-in template,
   * own text *and* address), and a patch would have to be able to say how an
   * *emptied* field is to be told apart from an *unmentioned* one. Exactly the
   * distinction over which `writeOverriddenSchema` above has already lost data
   * once.
   *
   * **And when it is missing, the stored notice stays standing** — `optional`
   * and expressly **no** `.prefault(EMPTY_LEGAL_DOCUMENT)`. The difference is
   * the whole point: a default value would make "field forgotten" and "delete
   * notice" the same request, and the deletion would hit a legal text for
   * which there is no trash. A client that wants to *delete* it says so
   * by sending an empty document — that is expressible and not the same as
   * silence.
   *
   * Incidentally that makes the extension additive: a client that does not
   * know this version goes on writing settings without touching a notice it
   * knows nothing about.
   */
  privacyNotice: legalDocumentWriteSchema.optional(),
});
export type UpdateFormSettingsRequest = z.infer<
  typeof updateFormSettingsRequestSchema
>;

/**
 * A write of the organisation's form standards.
 *
 * **No `overridden` any more** (review finding 10). Until 2026-08-17 it
 * carried the four switches „Vorgabe ⇄ Angepasst" — a level under which no
 * second administration lies, but the values this application is shipped with.
 * What a switch decided there was, for the organisation admin, not to be told
 * apart from "the field is locked, and nobody says why".
 *
 * What remains is a **patch**: the fields this person has changed, laid over
 * the stored document. No `PUT` of the whole set of values, and that is the
 * same reason `values` one level down is a patch — two people who edit
 * different sections of the same page must not overwrite each other; whoever
 * edits the same section runs into the 409 of the revision.
 */
export const updateTenantFormDefaultsRequestSchema = z.strictObject({
  /**
   * A patch: only the fields the editor changed — and **never one of
   * *Verfügbarkeit***, which an organisation does not have
   * (`tenantSettingsWriteSchema`, review finding 10). A request naming
   * `closeAt` here is a 400 that says the field is unknown, not a value that
   * disappears in a pruning.
   */
  values: tenantSettingsWriteSchema.prefault({}),
  /** The standards revision this editor started from — see above. */
  revision: revisionSchema,
});
export type UpdateTenantFormDefaultsRequest = z.infer<
  typeof updateTenantFormDefaultsRequestSchema
>;

/**
 * What the settings page of one form receives.
 *
 * All four documents together, because the page shows all four things: which
 * sections are taken over, what the form itself stores, what the organisation's
 * standard says (the „↳ Standardwert vom Tenant" hint) and what actually
 * applies right now. Leaving `effective` out and letting the client compute it
 * would put a second merge in the application — the one duplication the
 * requirement exists to prevent.
 */
export interface FormSettingsResponse {
  readonly overridden: FormSettingsOverride['overridden'];
  /** The form's own values — only for sections it has taken over. */
  readonly values: FormSettingsOverride['values'];
  /**
   * The organisation's standard, for the sections that follow it — no
   * *Verfügbarkeit*, because there is none to inherit.
   */
  readonly tenantDefaults: TenantFormSettings;
  /** The result of `effectiveSettings()` — what counts. */
  readonly effective: FormSettings;
  /** Send this back with the next write. */
  readonly revision: number;
  /** …and this one, so a moved tenant standard cannot slip in unseen. */
  readonly tenantRevision: number;
  /**
   * The privacy notice of this form — **the document, not the rendered text**
   * (ADR-0028 no. 4).
   *
   * The editing page needs the halves separately: it offers the placeholders
   * as fields and renders the preview itself, through the same
   * `renderLegalPage` the public path uses. What a **stranger** gets is
   * conversely never the document but only the result
   * (`publicFormSchema.privacyNotice`) — the same division as with the legal
   * text pages, and the reason why a `[[PLATZHALTER]]` never leaves the
   * application.
   */
  readonly privacyNotice: LegalDocument;
}

/**
 * What the *Formular-Standards* tab receives — **one document, not four**.
 *
 * There were four as long as the page had switches: what is taken over, what
 * stands in the taken-over sections, what one that is not taken over falls
 * back on, and what follows from that. Without switches the first three
 * coincide — the organisation has a complete set of values, and that set
 * stands here (review finding 10).
 *
 * `shippedDefaults` is thereby gone as well: the application's default is no
 * longer the explanation of a locked section but only what a never-saved
 * document is filled with — and the server does that on reading
 * (`parseTenantFormDefaults`), before the answer comes about.
 */
export interface TenantFormDefaultsResponse {
  /** Complete: every form of the organisation inherits exactly that. */
  readonly values: TenantFormSettings;
  /** Send this back with the next write. */
  readonly revision: number;
}
