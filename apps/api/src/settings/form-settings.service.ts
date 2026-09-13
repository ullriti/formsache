import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SETTINGS_SECTIONS,
  definedOnly,
  draftDeadline,
  effectiveSettings,
  formSettingsOverrideSchema,
  mergeSettings,
  parseStoredFormPrivacyNotice,
  pruneToOverridden,
  revokesEditLinks,
  setSectionOverride,
  tenantFormDefaultsSchema,
  type FormSettingsOverride,
  type LegalDocument,
  type PartialFormSettings,
  type PartialTenantFormSettings,
  type SettingsOverridden,
  type TenantFormSettings,
} from '@formsache/shared';
import type { Tenant } from '@prisma/client';

import { parseRequest } from '../common/parse-request';
import { requireForm } from '../forms/forms.service';
import type { FormSettingsRow, TenantScope } from '../tenancy/tenant-scope';
import { redactedTenantDefaults } from './settings-document';
import { SettingsSecretsService } from './settings-secrets.service';
import type {
  FormSettingsResponse,
  TenantFormDefaultsResponse,
  UpdateFormSettingsRequest,
  UpdateTenantFormDefaultsRequest,
} from './settings-wire';

/**
 * The answer when the organisation behind an active session has disappeared.
 *
 * Unreachable through the normal chain — `TenantScopeGuard` builds the scope
 * from a membership, and a deleted tenant takes its memberships with it — but
 * stated rather than asserted away: the alternative to handling it is a
 * non-null assertion, and an assertion in a service is a claim the service
 * cannot check.
 */
export const TENANT_NOT_FOUND_MESSAGE =
  'Die Organisation wurde nicht gefunden.';

/**
 * The answer to a save that started from a state somebody else has replaced.
 *
 * **One message for both counters.** A 409 here can mean „another editor saved
 * these settings" or „the organisation moved its standard while you were taking a
 * section over", and the remedy is identical: reload and look at what is now
 * there. Two messages would ask an editor to tell apart two things they cannot
 * act on differently.
 */
export const STALE_SETTINGS_MESSAGE =
  'Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.';

/**
 * What the service has to know about the **caller** — exactly one right, and
 * therefore exactly one field.
 *
 * `can_manage_form_settings` stands at the controller and decides whether the
 * route answers at all; this here decides **how much** it shows in its answer
 * (see {@link FormSettingsService.shownTenantDefaults}). Two questions, two
 * places — and a mandatory parameter instead of a default, because a default
 * of "may see everything" would be the forgetful construction this project has
 * already had as a finding twice.
 *
 * A type of its own instead of `Permissions`: what is needed is one right, and
 * a parameter that takes all six invites building a second rights check here —
 * and that belongs in the guard chain.
 */
export interface SettingsCaller {
  /**
   * Whether the caller may manage the **organisation-wide** form standards.
   *
   * From the membership, not from the form's capping: this right is that of
   * the organisation (`GET /api/tenant/form-defaults` demands it, and there no
   * form is in play on which a capping could take hold). What is answered here
   * is "would this person see the same document one route further on in
   * plaintext anyway?".
   */
  readonly canManageSettings: boolean;
}

/**
 * Reading and writing the two settings documents.
 *
 * **No `PrismaService` in the constructor**, exactly as in `FormsService`: the
 * only way to a row is the `TenantScope` the guard chain hands in, so
 * „forgetting the tenant" would be a visible change to this constructor rather
 * than a missing `where` key (`CONTRIBUTING.md`). The tenant
 * standards are reached through `scope.tenant`, which has no way to name a
 * *different* Organisation at all.
 *
 * **What this service does not do: enforce anything.** A deadline stored here
 * closes nothing yet, a response limit refuses nothing yet, an access word
 * guards nothing yet — that is enforcement, verified elsewhere in its own right.
 * This service stores the decision and computes what applies; nothing more.
 */
@Injectable()
export class FormSettingsService {
  constructor(private readonly secrets: SettingsSecretsService) {}

  /** The settings of one form: stored, inherited and effective. */
  async ofForm(
    scope: TenantScope,
    id: string,
    caller: SettingsCaller,
  ): Promise<FormSettingsResponse> {
    const form = await this.requireSettingsRow(scope, id);
    const tenant = await this.requireTenant(scope);
    const override = this.secrets.openFormOverride(
      form.settingsOverride,
      scope.tenantId,
      form.id,
    );
    return compose(
      tenant,
      this.shownTenantDefaults(tenant, caller),
      override,
      form.settingsRevision,
      // Read tolerantly: an unreadable column means "nothing stored" and
      // not 500. A form whose settings page can no longer be opened because of
      // a broken JSONB would be the most expensive conceivable failure of this
      // feature (`parseStoredFormPrivacyNotice`).
      parseStoredFormPrivacyNotice(form.privacyNotice),
    );
  }

  /**
   * Replaces the settings of one form.
   *
   * The order is what makes the result predictable: the section switches are
   * applied **first** (through the shared `setSectionOverride`, so switching on
   * copies what applied and switching off discards), and only then are the
   * values the editor changed written into the sections that are now taken
   * over. The other order would let a value land in a section that is about to
   * be discarded — saved, gone, and no message about either.
   */
  async replaceOfForm(
    scope: TenantScope,
    id: string,
    request: UpdateFormSettingsRequest,
    caller: SettingsCaller,
  ): Promise<FormSettingsResponse> {
    const form = await this.requireSettingsRow(scope, id);
    const tenant = await this.requireTenant(scope);
    // **The write path reckons with the plaintext, the answer does not show it.**
    // A taken-over section copies what applied just now (`setSectionOverride`)
    // — with a redacted word the column would hold a placeholder with a
    // NUL byte instead of a password. What the caller *sees* is decided
    // instead by {@link shownTenantDefaults} one line further down, and what they
    // *get* on taking over by {@link copyableTenantDefaults} one further.
    const tenantDefaults = this.tenantDefaults(tenant);
    const stored = this.secrets.openFormOverride(
      form.settingsOverride,
      scope.tenantId,
      form.id,
    );

    // Checked **before** anything is computed, and only for a write that takes
    // a section over: that is the one case in which the organisation's current values
    // are copied into this form, and therefore the one case in which a standard
    // that moved since the page was loaded would store something nobody saw.
    // Checking it always would block an editor changing this form's display
    // flags because somebody else edited the organisation's confirmation text — the
    // same over-blocking that keeps this counter apart from `form.revision`.
    if (
      takesOverASection(stored, request) &&
      tenant.formDefaultsRevision !== request.tenantRevision
    ) {
      throw new ConflictException(STALE_SETTINGS_MESSAGE);
    }

    const next = applySectionWrite(
      copyableTenantDefaults(tenantDefaults, caller),
      stored,
      request,
    );

    const written = await scope.forms.updateSettingsOverride(
      id,
      request.revision,
      // Sealed under **this form's** context. The word may have arrived here a
      // moment ago as a copy of the organisation's standard (`setSectionOverride`), and
      // it was plaintext all the way through — so what is stored is a value
      // bound to the row it is stored in, not one carried over from another.
      this.secrets.sealFormOverride(next, scope.tenantId, form.id),
      /*
        The privacy notice, **in the same write** (ADR-0028 no. 4).

        Unsealed and unshortened: it carries no secret but a text that
        by design lands on a page that strangers call up without signing in.
        What protects it is not encryption but the gate against control
        characters in the schema and the allow-list at rendering
        (`legal-text.ts`) — the same two gates as with the legal texts of an
        organisation.

        `request.privacyNotice` has already gone through `legalDocumentSchema`
        (`parseRequest` in the controller), so nothing stands here that
        the column may not take. If it is missing, `undefined` is passed on
        and the column is **not touched** — silence is no deletion
        (`settings-wire.ts`).
      */
      request.privacyNotice,
      {
        // Switching the access word on, or changing it,
        // takes back the public addresses this form has already handed out:
        // the Bearbeiten-Links **and** the saved
        // drafts, which are the sharper half (a draft address is an
        // unauthenticated `GET` on the complete field definition). Compared on
        // the **effective** settings, because a form that inherits the section
        // is protected by the organisation's word and not by its own; the rule itself
        // lives in `@formsache/shared` and is the same one the tenant write below
        // asks.
        revokeParticipantLinks: revokesEditLinks(
          effectiveSettings(tenantDefaults, stored),
          effectiveSettings(tenantDefaults, next),
        ),
        // **a deadline shortened after the fact takes the drafts already
        // stored with it** (a review finding). The
        // deadline of the settings that are about to apply, read through the
        // same function `draftExpiresAt` uses so that „gibt es eine Frist"
        // cannot mean one thing at the save and another here. `null` where
        // there is none, which touches nothing; what happens to a deadline that
        // is *extended* is stated at `updateSettingsOverride`.
        capDraftsAt: draftDeadline(effectiveSettings(tenantDefaults, next)),
      },
    );
    if (!written) {
      // The form was resolved a moment ago, so a count of zero is a revision
      // that no longer matches — not a form that went missing.
      throw new ConflictException(STALE_SETTINGS_MESSAGE);
    }

    return compose(
      tenant,
      this.shownTenantDefaults(tenant, caller),
      next,
      request.revision + 1,
      // What now stands in the column: what was sent, or — if nothing was
      // sent — what already stood there. The answer is the new basis of the
      // page, so it must not claim anything that was not stored.
      request.privacyNotice ?? parseStoredFormPrivacyNotice(form.privacyNotice),
    );
  }

  /** The organisation's form standards. */
  async ofTenant(scope: TenantScope): Promise<TenantFormDefaultsResponse> {
    const tenant = await this.requireTenant(scope);
    return composeTenant(
      this.tenantDefaults(tenant),
      tenant.formDefaultsRevision,
    );
  }

  /**
   * Carries the form standards of the organisation forward.
   *
   * **One step instead of three** (review finding 10): the stored document is
   * complete, the caller sends the fields they have changed, and the result goes
   * through the same schema that reads a stored row. There were once switches
   * here, a copy on switching on and a discard on switching off; a level under
   * which only the shipped values lie has no object for any of the three.
   *
   * What a form inherits of it is still decided by `effectiveSettings` — at
   * that level this here changes nothing.
   */
  async replaceOfTenant(
    scope: TenantScope,
    request: UpdateTenantFormDefaultsRequest,
  ): Promise<TenantFormDefaultsResponse> {
    const tenant = await this.requireTenant(scope);
    const stored = this.tenantDefaults(tenant);
    const next = applyTenantWrite(stored, request.values);

    const written = await scope.tenant.updateFormDefaults(
      request.revision,
      // Sealed under **this organisation's** context, as before. The word was plaintext
      // the whole way through, so a section taken over carries a *word* and not
      // a ciphertext from somewhere else, and a section switched off carries
      // nothing at all.
      this.secrets.sealTenantDefaults(next, scope.tenantId),
      {
        // The same rule as on a form, one level up: this
        // document *is* the access word of every form that has not taken the
        // section over, so switching it on here switches it on for all of them.
        //
        // Compared on the complete standard before and after: the document
        // carries every key, so „das Wort hat sich bewegt" is one comparison
        // and not a question about which half of the row it moved in.
        revokeParticipantLinks: revokesEditLinks(stored, next),
        // **No deadline can come from here any more** (review finding 10): an
        // organisation has no *Verfügbarkeit* to shorten, so a save on this page
        // cannot cut a draft's life short. `null` is „nichts zu kappen", the
        // same answer this argument gave for a standard without a deadline.
        capDraftsAt: null,
      },
    );
    if (!written) {
      throw new ConflictException(STALE_SETTINGS_MESSAGE);
    }

    return composeTenant(next, request.revision + 1);
  }

  /**
   * The form row the settings routes need, or the single 404 .
   *
   * The lean projection, not `requireFullForm`: this surface reads neither the
   * published version nor the answer count, and the 404 comes from the same
   * place either way.
   */
  private requireSettingsRow(
    scope: TenantScope,
    id: string,
  ): Promise<FormSettingsRow> {
    return requireForm(id, (formId) => scope.forms.findSettingsById(formId));
  }

  private async requireTenant(scope: TenantScope): Promise<Tenant> {
    const tenant = await scope.tenant.find();
    if (tenant === null) {
      throw new NotFoundException(TENANT_NOT_FOUND_MESSAGE);
    }
    return tenant;
  }

  /** The organisation's standards, opened — the base every form's merge starts from. */
  private tenantDefaults(tenant: Tenant): TenantFormSettings {
    return this.secrets.openTenantDefaults(tenant.formDefaults, tenant.id);
  }

  /**
   * …and what the **caller gets to see of it** (ADR-0021, a security finding).
   *
   * The settings page of a form stands behind `can_manage_form_settings`. Its
   * answer carries `tenantDefaults` — the complete standard that every form of
   * the organisation inherits — and `effective`, which for an inheriting form
   * contains the same value. In it sits the **access word of the
   * organisation**, that is, the word that protects the forms of *others*. An
   * `editor` reached it through a route that is only supposed to unlock their own
   * form for them.
   *
   * Redaction therefore happens at exactly one question: does the caller hold
   * `can_manage_settings`, the right under which `GET /api/tenant/form-defaults`
   * hands out the same document in plaintext? If yes, this route shows nothing
   * that they would not see one route further on anyway. If no,
   * `REDACTED_PASSWORD` stands there — and, because `effective` is mixed from
   * *this* document, there too, but **only as long as the section is
   * inherited**: a form that has taken over *Zugriff & Sicherheit* itself
   * carries its own word in `values`, and `can_manage_form_settings` may see
   * that — it is the word of this form.
   *
   * The redacted path **does not decrypt**, it replaces the sealed value
   * unopened (`settings-document.ts`). "Whoever may not see it does not resolve
   * it either" is thereby a property of the procedure and not a promise.
   */
  private shownTenantDefaults(
    tenant: Tenant,
    caller: SettingsCaller,
  ): TenantFormSettings {
    return caller.canManageSettings
      ? this.tenantDefaults(tenant)
      : redactedTenantDefaults(tenant.formDefaults);
  }
}

/**
 * The standard of the organisation, **as far as a take-over may copy it**
 * (ADR-0021, the second half of the same security finding).
 *
 * {@link FormSettingsService.shownTenantDefaults} takes the access word out of
 * the *answer* for an `editor`. With that the redaction was one click away
 * from being ineffective: on switching over to „Angepasst", `setSectionOverride`
 * copies exactly the values that apply at that moment into the form —
 * including the word the display had just held back. Afterwards it stands in
 * `values.password` of **this** form, and there `can_manage_form_settings` may
 * read it; the word of the organisation would be back by way of a take-over.
 *
 * The boundary therefore runs at the same question as the display — does the
 * caller hold `can_manage_settings`? — and not at a second one:
 *
 * - **Yes:** unchanged. Whoever reads the standard one route further on in
 *   plaintext *and* may write it copies nothing on taking over that they do
 *   not already have.
 * - **No:** the section is taken over without a word — empty field, protection
 *   off.
 *
 * **`passwordEnabled` falls with it**, and that is not convenience but the
 * only state the schema permits: `checkSettingsConsistency` refuses
 * „Passwortschutz an" without a word („Passwortschutz ohne Passwort ist
 * kein Schutz."), so a take-over with `passwordEnabled: true` and an empty
 * field would be a 400 on a click that the interface offers as an ordinary
 * change of section. It is the same honest state that `stripOverridePassword`
 * establishes when duplicating and justifies there with the same sentence: no
 * word, no protection — only **visibly** so, because the switch afterwards
 * stands at „aus" instead of claiming „an".
 *
 * That this form stands there without password protection afterwards is the
 * user-visible consequence and is announced in the interface before it is
 * saved (`SettingsView.tsx`). It is no new authority either: whoever holds
 * `can_manage_form_settings` could switch off the protection of *their* form
 * after the take-over anyway. New is only that they no longer get to see the
 * word while doing so.
 *
 * **Only for the copy step.** `revokesEditLinks` and `draftDeadline` still
 * reckon with the real document: the question "does the word that protects
 * this form change" is a question to reality and not to what the caller may
 * see.
 */
function copyableTenantDefaults(
  defaults: TenantFormSettings,
  caller: SettingsCaller,
): TenantFormSettings {
  if (caller.canManageSettings) {
    return defaults;
  }
  return { ...defaults, password: '', passwordEnabled: false };
}

/** Whether a write switches at least one section **on**. */
function takesOverASection(
  stored: FormSettingsOverride,
  request: UpdateFormSettingsRequest,
): boolean {
  return SETTINGS_SECTIONS.some(
    (section) => request.overridden[section] && !stored.overridden[section],
  );
}

/** The four documents the settings page needs, from the two it is built of. */
function compose(
  tenant: Tenant,
  tenantDefaults: TenantFormSettings,
  override: FormSettingsOverride,
  revision: number,
  privacyNotice: LegalDocument,
): FormSettingsResponse {
  return {
    overridden: override.overridden,
    values: override.values,
    tenantDefaults,
    // The one place standard and override become a value — `@formsache/shared`, not
    // a second merge written here.
    effective: effectiveSettings(tenantDefaults, override),
    revision,
    tenantRevision: tenant.formDefaultsRevision,
    privacyNotice,
  };
}

/** What the *Formular-Standards* page needs: the document and its revision. */
function composeTenant(
  defaults: TenantFormSettings,
  revision: number,
): TenantFormDefaultsResponse {
  return { values: defaults, revision };
}

/** The switches and the values a section-wise write states. */
interface SectionWrite {
  readonly overridden: SettingsOverridden;
  readonly values: PartialFormSettings;
}

/**
 * The next document, from the stored one and what the editor sent — **for a
 * form and for an organisation alike** .
 *
 * Written as a function rather than inline so the *shape* of the rule is
 * visible: switches first, values second, and values only where a switch says
 * they count. Every step is a function from `@formsache/shared` —
 * `setSectionOverride`, `definedOnly`, `pruneToOverridden` — because a second
 * description of „what does a taken-over section mean" is a second answer.
 *
 * **`below` is the only thing that differs between the two callers**: a form
 * that has not taken a section over follows its organisation, an organisation
 * that has not follows the shipped constant. Everything else — what switching
 * on copies, what switching off discards, what a locked section may leave
 * behind — is the same rule, and building it twice is exactly how the two
 * versions would have ended up being two different promises about one column.
 *
 * The **parse** is not part of it, and that is the one thing the two callers do
 * for themselves: the documents are no longer the same shape. An organisation's
 * has no *Verfügbarkeit* and is judged by `tenantFormDefaultsSchema`, a form's
 * has and is judged by `formSettingsOverrideSchema`.
 */
function nextDocument(
  below: TenantFormSettings,
  stored: FormSettingsOverride,
  request: SectionWrite,
): FormSettingsOverride {
  let next = stored;
  for (const section of SETTINGS_SECTIONS) {
    const wanted = request.overridden[section];
    if (wanted !== next.overridden[section]) {
      next = setSectionOverride(below, next, section, wanted);
    }
  }

  // `definedOnly`, because `exactOptionalPropertyTypes` makes an explicitly
  // written `undefined` a key that *exists* and carries nothing — which the
  // merge would then have to interpret.
  const merged: FormSettingsOverride = {
    overridden: next.overridden,
    values: { ...next.values, ...definedOnly(request.values) },
  };

  // Values of a section nobody took over are dropped **before** validation, and
  // both halves matter: they must leave no trace in the row,
  // and a stale value must not fail a rule that no longer applies to it.
  return pruneToOverridden(merged);
}

/**
 * A write of a **form's** settings — see {@link nextDocument}.
 *
 * Parsed, not assembled: the cross-field rules („Weiterleitung ohne Ziel-URL")
 * can only be decided on the finished document, and `parseRequest` turns a
 * breach into a 400 that names the field rather than a 500.
 */
function applySectionWrite(
  below: TenantFormSettings,
  stored: FormSettingsOverride,
  request: SectionWrite,
): FormSettingsOverride {
  return parseRequest(
    formSettingsOverrideSchema,
    nextDocument(below, stored, request),
  );
}

/**
 * A write of an **organisation's** standards — the stored document with the
 * editor's patch laid over it, judged by the schema that reads the row back.
 *
 * `mergeSettings` and not a spread: `null` is a *value* for a redirect target,
 * `undefined` is „nicht geändert", and the two are one thing in JSON. It is
 * also what keeps a patch from putting a key into a document that has none —
 * the guarantee `tenantSettingsWriteSchema` gives on the way in, applied a
 * second time where the two documents meet.
 *
 * `parseRequest`, so a breach of a cross-field rule („Passwortschutz ohne
 * Passwort") is a 400 naming the field rather than a 500.
 */
function applyTenantWrite(
  stored: TenantFormSettings,
  values: PartialTenantFormSettings,
): TenantFormSettings {
  return parseRequest(
    tenantFormDefaultsSchema,
    mergeSettings(stored, definedOnly(values)),
  );
}
