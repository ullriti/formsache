import type { ReactElement } from 'react';
import {
  EMPTY_LEGAL_DOCUMENT,
  effectiveRedirect,
  FORM_PRIVACY_TEMPLATE,
  type LegalRenderContext,
} from '@formsache/shared';

import { useForm } from '../api/forms';
import { useSession } from '../api/session';
import { useIsDesktop } from '../hooks/use-is-desktop';
import { useServerDraft } from '../hooks/use-server-draft';
import { ApiError } from '../api/http';
import { useFormSettings, useSaveFormSettings } from '../api/settings';
import {
  builderPath,
  DASHBOARD_PATH,
  TENANT_FORM_DEFAULTS_PATH,
} from '../router/routes';
import { navigate } from '../router/use-route';
import { availabilityStatus } from './settings/availability-status';
import {
  FORM_SETTINGS_SUBJECT,
  saveErrorMessage,
  fieldIssues,
} from './api-messages';
import { LegalPageEditor } from './legal/LegalPageEditor';
import { SettingsSaveBar } from './settings/SettingsSaveBar';
import { SettingsSectionCard } from './settings/SettingsSectionCard';
import {
  AVAILABILITY_DEFINITION,
  AvailabilitySectionFields,
  SECTION_DEFINITIONS,
  SettingsSectionFields,
} from './settings/SettingsSectionFields';
import type { SettingsDraft } from './settings/settings-draft';
import {
  draftOf,
  isDirty,
  isWithheldPassword,
  shownSettings,
  withPrivacyNotice,
  withSection,
  withValue,
  writableValues,
} from './settings/settings-draft';

import './settings-view.css';

/**
 * What taking a section over does — on **every** card, not just one.
 *
 * Switching to „Angepasst" copies the organisation's current values into this form on
 * save (`setSectionOverride`), and the organisation's later changes stop reaching it.
 * That mechanic is the same for all four sections; only its consequence
 * differs, and nothing on the card shows it either way. It carried the notice
 * for *Zugriff & Sicherheit* alone at first, which read as if the other three
 * kept following the organisation — the opposite of what happens.
 */
const TAKEOVER_NOTICE =
  'Beim Speichern werden die aktuellen Werte der Organisation übernommen – spätere Änderungen der Organisation gelten für dieses Formular dann nicht mehr.';

/**
 * The one section where the consequence is more than a stale value: the access word is copied too, so an organisation that changes its own —
 * because it leaked — revokes nothing here. This form keeps letting the old
 * word in, and the card looks identical before and after.
 */
const ACCESS_TAKEOVER_NOTICE =
  `${TAKEOVER_NOTICE} Das gilt auch für das Zugangswort: Wechselt die Organisation es, ` +
  'weil es abgeflossen ist, lässt dieses Formular weiter mit dem alten Wort herein.';

/**
 * The same section when the organisation's access word is **withheld**
 * (ADR-0021) — and a different sentence, because then the opposite happens.
 *
 * {@link ACCESS_TAKEOVER_NOTICE} warns that the word is *copied along*
 * and lives on independently afterwards. For a caller without
 * `can_manage_settings` it is not copied in the first place
 * (`copyableTenantDefaults`), and the same warning would simply be wrong there.
 *
 * The consequence stands here and not only in the field below, because it has to be
 * readable **before** the click: a form that was protected a moment ago stands
 * open after the takeover, until somebody sets a word of its own. A
 * silently emptied password field would be the surprise
 * this sentence stands against.
 *
 * Phrased **about the takeover** and not about this save: the
 * card shows its ⓘ notice on both sides of the switch
 * (`SettingsSectionCard`), and a section that was taken over long ago and carries
 * a word of its own does not become unprotected through the next save.
 */
const ACCESS_WITHHELD_TAKEOVER_NOTICE =
  `${TAKEOVER_NOTICE} Das Zugangswort der Organisation ist davon ausgenommen: ` +
  'Es ist für diese Rolle nicht sichtbar und wird beim Übernehmen nicht ' +
  'mitkopiert – der Abschnitt beginnt dann ohne Passwortschutz, bis hier ein ' +
  'eigenes Zugangswort eingetragen ist.';

function takeoverNotice(
  section: (typeof SECTION_DEFINITIONS)[number]['key'],
  accessWordWithheld: boolean,
): string {
  if (section !== 'access') {
    return TAKEOVER_NOTICE;
  }
  return accessWordWithheld
    ? ACCESS_WITHHELD_TAKEOVER_NOTICE
    : ACCESS_TAKEOVER_NOTICE;
}

/**
 * The form settings.
 *
 * Four section cards with the switch „Tenant-Standard ↔ Angepasst", a live
 * status badge over them and the banner that jumps to the organisation's standards.
 *
 * **The inheritance merge is not computed here.** `GET …/settings` delivers
 * `effective` already merged (`effectiveSettings()` in `@formsache/shared`), and the
 * only thing this view lays on top is what the editor has typed and not yet
 * saved — see `settings-draft.ts` for why that is not a second merge.
 *
 * **Switching a section on copies nothing here either.** The server does that
 * (`setSectionOverride`), so a save may carry `values: {}` and still end up
 * with the values that were on screen.
 */
export function SettingsView({
  formId,
}: {
  readonly formId: string;
}): ReactElement {
  const isDesktop = useIsDesktop();
  const form = useForm(formId);
  const settings = useFormSettings(formId);
  const save = useSaveFormSettings();
  /*
    Only for the **preview** of the privacy notice: it inserts the name of the
    organisation and the address of its privacy notices, and both
    are in the session already. A fetch of its own for that would be a second
    truth about the same name.
  */
  const session = useSession();
  const activeTenant = session.data?.memberships.find(
    (membership) => membership.tenant.id === session.data?.activeTenantId,
  )?.tenant;

  const settingsDoc = settings.data;

  /**
   * The unsaved edits, tagged with the form they belong to
   * (`use-server-draft.ts`).
   *
   * A background refetch never replaces them: that would throw away everything
   * typed since the page opened, which is the loss the requirement exists to
   * prevent. A successful save does — its answer *is* the new baseline — but
   * only if nothing was typed while it was in flight.
   */
  /**
   * The same document, described the way `settings-draft.ts` needs it: what
   * applies, and what a section that is *not* taken over falls back to. For a
   * form that layer is the organisation; for the organisation's own page it is the system row
   * , which is the whole reason the helpers take `inherited`
   * rather than `tenantDefaults`.
   */
  const sectioned =
    settingsDoc === undefined
      ? undefined
      : {
          overridden: settingsDoc.overridden,
          effective: settingsDoc.effective,
          inherited: settingsDoc.tenantDefaults,
        };

  const { draft, setDraft, beginSave } = useServerDraft<SettingsDraft>(
    formId,
    sectioned === undefined
      ? undefined
      : draftOf(sectioned, settingsDoc?.privacyNotice ?? EMPTY_LEGAL_DOCUMENT),
  );

  if (settings.isPending || form.isPending) {
    return (
      <div className="settings">
        <p className="settings__state" role="status">
          Einstellungen werden geladen…
        </p>
      </div>
    );
  }

  if (settingsDoc === undefined || sectioned === undefined || draft === null) {
    const status =
      settings.error instanceof ApiError ? settings.error.status : undefined;
    return (
      <div className="settings">
        <p className="settings__state" role="alert">
          {status === 403
            ? 'Diese Rolle darf die Einstellungen dieses Formulars nicht sehen.'
            : status === 404
              ? 'Dieses Formular gibt es nicht (mehr).'
              : 'Die Einstellungen konnten nicht geladen werden.'}{' '}
          <button
            type="button"
            className="settings__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  const values = shownSettings(sectioned, draft);
  /**
   * Does the server withhold the organisation's access word?
   *
   * The question is put to the delivered default and not to a list of rights: the
   * right itself is not on the wire, but the redacted value is —
   * and it is there exactly when the organisation has set a word *and*
   * this caller may not see it. If the organisation has none, there is
   * nothing to withhold either, and the ordinary notice stays right.
   */
  const accessWordWithheld = isWithheldPassword(sectioned.inherited.password);
  const status = availabilityStatus(values);
  const issues = fieldIssues(save.error);
  const dirty = isDirty(sectioned, draft, settingsDoc.privacyNotice);

  /**
   * What the **preview** of the privacy notice knows about the application.
   *
   * `operatorName: null` and `aiActive: false`, as in `TenantLegalCards`: the
   * template of this notice uses neither the name of the operator nor the
   * AI clause, so there is nothing to obtain here and nothing to guess.
   *
   * `redirectTarget` is the one that *is* obtained, and from the unsaved state
   * this page holds (ADR-0028 Nr. 5): the section about the redirect appears
   * and disappears while the switch above it is being flipped, which is the
   * whole point of a preview. That it comes from `effectiveRedirect(values)`
   * and not from `values.redirectUrl` is the rule the redirect field states
   * next to itself — this box holds a draft that has not passed the schema
   * yet, so a `javascript:` typed by mistake must not walk into a rendered
   * legal text as a target.
   */
  const legalContext: LegalRenderContext = {
    organisationName: activeTenant?.name ?? null,
    organisationShortName: activeTenant?.shortName ?? null,
    operatorName: null,
    aiActive: false,
    redirectTarget: effectiveRedirect(values)?.url ?? null,
  };

  const onSave = (): void => {
    save.mutate(
      {
        formId,
        overridden: draft.overridden,
        // Only the sections that are actually taken over — a locked field never
        // reaches the wire.
        values: writableValues(draft),
        // Both counters come from the load this page was built on, never from
        // a fresher answer: echoing back a revision the editor has not seen is
        // exactly the silent overwrite the check exists to prevent.
        revision: settingsDoc.revision,
        tenantRevision: settingsDoc.tenantRevision,
        // **Always whole**, even when nobody has touched it: the document
        // has two halves (a filled-in template and an own text) that
        // have to stay standing side by side. This page would be allowed to leave it
        // out — the server would then leave the column alone —, but it has the
        // state it displays, and it sends it.
        privacyNotice: draft.privacyNotice,
      },
      {
        // The server's answer is the new baseline: it carries the values
        // `setSectionOverride` copied into a section that was just taken over,
        // which the client deliberately did not compute for itself — unless
        // something was typed while the request was in flight, in which case
        // what is on screen wins.
        onSuccess: beginSave(),
      },
    );
  };

  return (
    <div className="settings">
      <div className="settings__head">
        <div className="settings__title-block">
          <h1 className="settings__title">Formular-Einstellungen</h1>
          <p className="settings__subtitle">{form.data?.title ?? 'Formular'}</p>
        </div>

        {/*
          Below the breakpoint the badge carries the short label. The long one
          („Geschlossen seit 15.08.2026, 23:59 Uhr MESZ") is wider than a 360 px
          viewport, and `.app-shell__main` hides horizontal overflow — so it
          would have been cut off rather than scrolled to. The date is not lost:
          it stands in the „Schließt am" field it comes from.
        */}
        <span
          className={`settings__status settings__status--${status.tone}`}
          role="status"
        >
          {isDesktop ? status.label : status.shortLabel}
        </span>
      </div>

      <div className="settings__banner">
        <span className="settings__banner-mark" aria-hidden="true">
          ↳
        </span>
        <p className="settings__banner-text">
          Standardwerte stammen von dieser Organisation. Pro Abschnitt
          „Angepasst" wählen, um sie nur für dieses Formular zu überschreiben.
        </p>
        <button
          type="button"
          className="settings__banner-action"
          onClick={() => {
            navigate(TENANT_FORM_DEFAULTS_PATH);
          }}
        >
          Tenant-Standards öffnen
        </button>
      </div>

      <SettingsSaveBar isSaving={save.isPending} dirty={dirty} onSave={onSave}>
        <button
          type="button"
          className="settings__secondary"
          onClick={() => {
            navigate(builderPath(formId));
          }}
        >
          Zum Builder
        </button>
      </SettingsSaveBar>

      {save.isError ? (
        <p className="settings__alert" role="alert">
          {saveErrorMessage(save.error, FORM_SETTINGS_SUBJECT)}
        </p>
      ) : null}

      {/*
        *Verfügbarkeit* first, and **without** the inheritance switch: an
        opening period, a deadline and a participant limit belong to this
        form and to no other (ADR-0011, continuation 2026-08-14).
        There is no level below from which they could be inherited, so there is
        nothing to take over either.
      */}
      <SettingsSectionCard definition={AVAILABILITY_DEFINITION}>
        <AvailabilitySectionFields
          values={values}
          issues={issues}
          onChange={(patch) => {
            setDraft(withValue(draft, patch));
          }}
        />
      </SettingsSectionCard>

      {SECTION_DEFINITIONS.map((definition) => (
        <SettingsSectionCard
          key={definition.key}
          definition={definition}
          notices={[takeoverNotice(definition.key, accessWordWithheld)]}
          inheritance={{
            overridden: draft.overridden[definition.key],
            onChange: (overridden) => {
              setDraft(
                withSection(sectioned, draft, definition.key, overridden),
              );
            },
          }}
        >
          <SettingsSectionFields
            section={definition.key}
            values={values}
            issues={issues}
            onChange={(patch) => {
              setDraft(withValue(draft, patch));
            }}
          />
        </SettingsSectionCard>
      ))}

      {/*
        **The privacy notice for this form** (ADR-0028 no. 4).

        It stands **here** and not in the builder, because it hangs off the right
        `can_manage_form_settings` and not off `can_build` — ADR-0021
        separated the two deliberately, and the information under Art. 13 GDPR
        is a decision about the form, not one about its construction. The
        question type `info` stays beside it what it was: an info text in the
        form flow that the person building it sets.

        Right at the bottom and without an inheritance switch: there is no level below
        from which a form could inherit a notice of its own. What stands above
        it are the general privacy notices of the organisation, and
        those live in the organisation administration.
      */}
      <LegalPageEditor
        template={FORM_PRIVACY_TEMPLATE}
        document={draft.privacyNotice}
        context={legalContext}
        /*
          The same mapping the sections above use: `fieldIssues`
          strips `privacyNotice.` just as it strips `values.`, so what stands here are the
          paths of the document (`custom`, `fills.<SCHLÜSSEL>`) — the names under
          which the card keeps its fields. Without that, a 400 on this
          partial document ended at „Bitte die markierten Felder prüfen." with nothing
          marked (review finding of 2026-08-19).
        */
        issues={issues}
        onChange={(next) => {
          setDraft(withPrivacyNotice(draft, next));
        }}
      />

      <p className="settings__footnote">
        Nicht angepasste Abschnitte folgen automatisch den Tenant-Standards.
      </p>
    </div>
  );
}
